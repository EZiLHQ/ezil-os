"""Fixed reviewed public runtime inside runc. Only stdin/anonymous FD carries a grant."""
import base64
import hashlib
import json
from pathlib import Path
import subprocess
import time

from . import desktop
from .standalone_git import MIN_MS, failure, host_ready, valid_request, validate_output
from . import lease as leasemod

ASSETS = Path(__file__).with_name("standalone_git_assets")

# No secret in this code/argv. Grant arrives once on anonymous stdin, is
# re-piped into FD 3, and is never passed to a shell or a named file.
FD_ADAPTER = r"""
import os,signal,stat,subprocess,sys,threading
mode=os.fstat(0).st_mode
if not (stat.S_ISFIFO(mode) or stat.S_ISSOCK(mode)): raise SystemExit(125)
signal.alarm(5)
packet=sys.stdin.buffer.read(16385)
if len(packet)>16384: raise SystemExit(125)
signal.alarm(0)
reader,writer=os.pipe()
if reader!=3:
    os.dup2(reader,3)
    os.close(reader)
os.set_inheritable(3,True)
child=subprocess.Popen(['/usr/bin/python3','-I','/run/ezil/bin/supervise.py',*sys.argv[1:]],
    stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,pass_fds=(3,))
os.close(3)
def send():
    try:
        with os.fdopen(writer,'wb') as f: f.write(packet)
    except (BrokenPipeError,OSError): pass
thread=threading.Thread(target=send,daemon=True);thread.start()
try:
    out,_=child.communicate(timeout=int(sys.argv[1])/1000+5)
except subprocess.TimeoutExpired:
    child.kill();child.wait();raise SystemExit(126)
if len(out)>65536: raise SystemExit(126)
sys.stdout.buffer.write(out)
raise SystemExit(child.returncode if child.returncode>=0 else 126)
"""


def runtime_command():
    pin = json.loads((ASSETS / "pin.json").read_bytes())
    stage = base64.b64encode((ASSETS / "stage.py").read_bytes()).decode()
    supervisor = base64.b64encode((ASSETS / "supervise.py").read_bytes()).decode()
    if hashlib.sha256(base64.b64decode(supervisor)).hexdigest() != pin["supervisorSha256"]:
        raise ValueError("runtime source mismatch")
    loader = "import base64;exec(compile(base64.b64decode(" + repr(stage) + "),'stage.py','exec'))"
    return pin, ["/usr/bin/python3", "-I", "-c", loader, json.dumps(pin), supervisor]


def execute(cfg, lease, req, ready=host_ready, clock=time.monotonic, wall=time.time):
    """One monotonic budget covers public bootstrap, private open and kill grace."""
    end = clock() + req["timeoutMs"] / 1000
    if not ready(cfg, lease):
        return failure("runtime_not_running", "runtime_not_running"), False
    try:
        pin, command = runtime_command()
        stage = desktop.exec_(cfg, command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL, timeout=min(20, end - clock()))
        if stage.returncode or stage.stdout.strip() != b"ezil-cli-bootstrap:ok":
            return failure("repo_open_git_missing", "bootstrap_unavailable"), False
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        # This command has no grant or checkout and cannot leave a Git writer.
        return failure("repo_open_git_missing", "bootstrap_unavailable"), False
    remaining = int((end - clock()) * 1000) - 5000
    if remaining < MIN_MS:
        return failure("repo_open_timeout", "budget_exhausted"), False
    if not valid_request({**req, "timeoutMs": remaining}, wall() * 1000):
        return failure("repo_open_token_expired", "token_expired"), False
    if not ready(cfg, lease):
        return failure("runtime_not_running", "runtime_not_running"), False
    args = ["/usr/bin/python3", "-I", "-c", FD_ADAPTER, str(remaining - 3500), "3000", "--repo-refresh" if req.get("refreshOnly") else "--repo-open",
            "/workspace", req["repositoryId"], req["privatePacket"]["repository"]["canonicalURL"], "0",
            pin["cliSha256"], pin["version"]]
    try:
        packet = {**req["privatePacket"], "gitAccess": True, **({"gitAuthor": req["gitAuthor"]} if "gitAuthor" in req else {}),
                  **({"refreshOnly": True} if req.get("refreshOnly") else {})}
        result = desktop.exec_(cfg, args, input=json.dumps(packet, separators=(",", ":")).encode(),
                               stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=max(1, end - clock()))
    except (OSError, subprocess.SubprocessError):
        # Killing runc's launcher alone does not prove in-container cleanup.
        return failure("repo_open_timeout", "cleanup_unconfirmed"), True
    if result.returncode == 0:
        answer = validate_output(result.stdout, req)
        if answer is not None:
            return answer, False
        # Reviewed supervisor preflight/migration refusals start no outstanding Git writer.
        reasons = {
            "repo_open_invalid_request": "invalid_request", "repo_open_workspace_unavailable": "workspace_unavailable",
            "repo_open_workspace_not_ready": "workspace_not_ready", "repo_open_folder_conflict": "folder_conflict",
            "repo_open_git_missing": "bootstrap_unavailable", "repo_open_busy": "checkout_busy",
        }
        closed = {(b"ezil-repo-open:error:" + code.encode() + b"\n"): reason for code, reason in reasons.items()}
        if result.stdout in closed:
            return failure("repo_open_git_missing" if b"repo_open_git_missing" in result.stdout else "repo_open_failed",
                           closed[result.stdout]), False
    # The reviewed supervisor emits 126 for unconfirmed child cleanup. A normal
    # CLI refusal with a closed error object is completed, without deleting any
    # existing checkout or foreign lock. Only fixed codes leave this process.
    if result.returncode in (1, 2) and len(result.stdout) <= 65536 and req["privatePacket"]["git"]["token"].encode() not in result.stdout:
        try:
            value = leasemod.strict_json(result.stdout.decode("utf8", "strict"))
            err = value.get("error")
            if (set(value) == {"error"} and isinstance(err, dict) and set(err) == {"code", "message"}
                    and isinstance(err["message"], str) and err["code"] in {
                        "invalid-repository", "invalid-arguments", "invalid-directory", "repository-not-authorized",
                        "destination-conflict", "destination-busy", "repository-ref-mismatch", "clone-failed"}):
                reason = {"invalid-repository": "invalid_request", "invalid-arguments": "invalid_request",
                          "invalid-directory": "workspace_unavailable", "repository-not-authorized": "repository_not_authorized",
                          "destination-conflict": "folder_conflict", "destination-busy": "checkout_busy",
                          "repository-ref-mismatch": "ref_mismatch", "clone-failed": "clone_failed"}[err["code"]]
                return failure("repo_open_failed", reason), False
        except (UnicodeError, ValueError, TypeError, AttributeError):
            pass
    return failure("repo_open_failed", "invalid_result" if result.returncode == 0 else "cleanup_unconfirmed"), True
