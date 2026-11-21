"""Exercise the baked standalone Git runtime on an Image Builder test VM."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace


LOWER_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
AGENT_URI = re.compile(r"s3://[a-z0-9][a-z0-9-]{1,61}[a-z0-9]/ami/host-agent-([a-f0-9]{40})\.tgz\Z")
HOST_ROOT = Path("/opt/ezil-host")
LOWER_ROOT = Path("/var/lib/ezil/lowers")

# Both the transferred marker and the process tag belong only to this test.
# The production FD adapter and supervisor launch this disposable child.
PAYLOAD_PROBE = r"""
import hashlib, json, os, signal, stat, subprocess, sys, time

with os.fdopen(3, 'rb', closefd=False) as grant:
    mode = os.fstat(3).st_mode
    inheritable = os.get_inheritable(3)
    payload = grant.read(97)
    eof = not grant.read(1)
    seekable = grant.seekable()
os.close(3)
if '--deadline-probe' in sys.argv:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    if os.fork() == 0:
        os.setsid()
        if os.fork() == 0:
            time.sleep(12)
            os._exit(0)
    time.sleep(12)
    sys.exit(0)

def read(path):
    with open(path, 'rb') as file:
        return file.read()

proof = {
    'fifo': stat.S_ISFIFO(mode), 'inheritable': inheritable, 'seekable': seekable,
    'eof': eof, 'bytes': len(payload), 'sha256': hashlib.sha256(payload).hexdigest(),
    'stdinDevNull': os.fstat(0).st_rdev == os.stat('/dev/null').st_rdev and not os.read(0, 1),
    'isolatedNetwork': os.listdir('/sys/class/net') == ['lo'],
    'leak': any(payload in read(path) for path in (
        '/proc/self/cmdline', '/proc/self/environ', '/run/ezil/bin/cli-pin.json',
        '/run/ezil/bin/installed-pin.json', '/run/ezil/bin/supervise.py', '/run/ezil/bin/ezil')),
}
for name, argv in (
    ('node', ['/usr/bin/env', 'node', '--version']),
    ('git', ['/usr/bin/env', 'git', '--version']),
    ('python', ['/usr/bin/python3', '--version']),
):
    proof[name] = subprocess.check_output(argv, stdin=subprocess.DEVNULL, timeout=2, text=True).strip()
print(json.dumps(proof))
"""

OBSERVE = r"""
import json, os, sys
tag = sys.argv[1].encode()
prior = {tuple(p) for p in json.loads(sys.argv[2])}
tagged, remaining = [], []
for pid in os.listdir('/proc'):
    if not pid.isdecimal() or int(pid) == os.getpid():
        continue
    try:
        with open('/proc/' + pid + '/stat') as file:
            fields = file.read().rsplit(')', 1)[1].split()
        identity = (int(pid), int(fields[19]))
        if identity in prior:
            remaining.append(identity)
        with open('/proc/' + pid + '/cmdline', 'rb') as file:
            if tag in file.read(65536).split(b'\0'):
                tagged.append([*identity, int(fields[2])])
    except (OSError, ValueError, IndexError):
        continue
print(json.dumps({'tagged': tagged, 'remaining': remaining}))
"""

# Use the actual stager implementation and verify_files checks. Only its public
# archive transport changes: the test guest receives a read-only local file and
# stays in an isolated network namespace with no host credentials.
OFFLINE_STAGE = r"""
import json, pathlib, sys
assets = '/run/ezil-qualification-assets'
scope = {'__name__': 'ezil_qualification_stage'}
source = pathlib.Path(assets, 'stage.py').read_bytes()
exec(compile(source, 'stage.py', 'exec'), scope)
pin = json.loads(sys.argv[1])
supervisor = pathlib.Path(assets, 'supervise.py').read_bytes()
scope['stage'](pin, supervisor, fetch=lambda _: pathlib.Path(assets, 'archive.tgz').read_bytes())
print('ezil-cli-bootstrap:ok')
"""


class QualificationRefused(RuntimeError):
    pass


def require(condition, reason):
    if not condition:
        raise QualificationRefused(reason)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def command(argv, timeout=8, **kwargs):
    return subprocess.run(argv, timeout=timeout, check=True,
                          stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, **kwargs)


def pinned_version(binary):
    version = command([binary, "--version"]).stdout.decode().splitlines()[0]
    require(re.fullmatch(r"runc version 1\.3\.4(?:-0ubuntu1~24\.04\.1)?", version),
            "runc-version-mismatch")
    return version


def make_bundle(cfg, scratch, lower, public_assets):
    bundle, merged, upper, work = [scratch / name for name in ("bundle", "merged", "upper", "work")]
    for path in (bundle, merged, upper, work):
        path.mkdir()
    command(["mount", "-t", "overlay", "-o",
             f"nodev,lowerdir={lower},upperdir={upper},workdir={work}", "ezil-test-rootfs", str(merged)])
    try:
        command([cfg.runcBin, "spec"], cwd=bundle)
        path = bundle / "config.json"
        spec = json.loads(path.read_bytes())
        spec["root"] = {"path": str(merged), "readonly": True}
        spec["process"].update({
            "terminal": False,
            "args": ["/usr/bin/sleep", "180"],
            "cwd": "/",
            "env": ["PATH=/usr/local/bin:/usr/bin:/bin"],
            "noNewPrivileges": True,
        })
        for name in spec["process"]["capabilities"]:
            spec["process"]["capabilities"][name] = []
        require(any(ns == {"type": "network"} for ns in spec["linux"]["namespaces"]),
                "network-isolation-missing")
        spec["mounts"] += [
            {"destination": "/run", "type": "tmpfs", "source": "tmpfs",
             "options": ["nodev", "nosuid", "mode=755", "size=16m"]},
            {"destination": "/run/ezil-qualification-assets", "type": "bind", "source": str(public_assets),
             "options": ["bind", "ro", "nodev", "nosuid", "noexec"]},
        ]
        path.write_text(json.dumps(spec), encoding="utf-8")
        return merged
    except BaseException:
        command(["umount", str(merged)])
        raise


def exercise_container(cfg, desktop, runtime, pin):
    launch = desktop.runc(cfg, "run", "--detach", "--bundle",
                          os.path.join(cfg.runDir, "bundle"), cfg.containerId,
                          stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                          stderr=subprocess.DEVNULL, timeout=8)
    require(launch.returncode == 0 and desktop.state(cfg) == "running", "runc-start-failed")

    def inside(argv, *, payload=None, timeout=10):
        options = {"stdin": subprocess.DEVNULL} if payload is None else {"input": payload}
        return desktop.exec_(cfg, argv, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             timeout=timeout, **options)

    start = inside(["/usr/bin/python3", "-I", "-c", OFFLINE_STAGE, json.dumps(pin)], timeout=12)
    require(start.returncode == 0 and start.stdout == b"ezil-cli-bootstrap:ok\n", "offline-bootstrap-failed")
    payload = os.urandom(96)
    tag = cfg.containerId + "-fd3"

    def probe(deadline=False):
        argv = ["/usr/bin/python3", "-I", "-c", runtime.FD_ADAPTER, "4000", "500",
                "/usr/bin/python3", "-I", "-c", PAYLOAD_PROBE, "--grant-fd=3", tag]
        if deadline:
            argv.append("--deadline-probe")
        return inside(argv, payload=payload)

    result = probe()
    require(result.returncode == 0 and len(result.stdout) < 4096, "fd3-probe-failed")
    proof = json.loads(result.stdout)
    require(proof["fifo"] and proof["inheritable"] and proof["eof"] and proof["stdinDevNull"]
            and not proof["seekable"] and not proof["leak"] and proof["isolatedNetwork"]
            and proof["bytes"] == len(payload)
            and proof["sha256"] == digest(payload), "fd3-proof-mismatch")
    require(int(proof["node"].removeprefix("v").split(".")[0]) >= 22
            and proof["git"].startswith("git version ") and proof["python"].startswith("Python 3."),
            "desktop-prerequisite-mismatch")

    def observe(prior):
        response = inside(["/usr/bin/python3", "-I", "-c", OBSERVE, tag, json.dumps(prior)], timeout=3)
        require(response.returncode == 0 and len(response.stdout) < 8192, "process-observation-failed")
        return json.loads(response.stdout)

    with ThreadPoolExecutor(max_workers=1) as executor:
        active = executor.submit(probe, True)
        seen = {}
        scan_until = time.monotonic() + 3.5
        while time.monotonic() < scan_until and not active.done():
            for pid, birth, group in observe([])["tagged"]:
                seen[pid, birth] = group
            if len(seen) >= 5 and len(set(seen.values())) >= 3:
                break
            time.sleep(0.1)
        timed = active.result(timeout=11)
    require(len(seen) >= 5 and len(set(seen.values())) >= 3, "escaped-session-not-observed")
    require(timed.returncode == 126 and not timed.stdout, "deadline-did-not-fail-closed")
    after = observe(list(seen))
    require(not after["tagged"] and not after["remaining"], "descendants-not-reaped")
    return {"node": proof["node"], "git": proof["git"], "python": proof["python"],
            "fd3": "anonymous-fifo-equal-bytes-eof", "deadlineReturnCode": timed.returncode,
            "observedProcesses": len(seen), "observedGroups": len(set(seen.values())),
            "offlineGuest": proof["isolatedNetwork"], "allProcessesGone": True}


def qualify(host_root, lower, image_id, agent_sha):
    sys.path.insert(0, str(host_root / "lib"))
    from ezil_host import desktop
    from ezil_host import standalone_git_runtime as runtime

    pin, _ = runtime.runtime_command()
    assets = runtime.ASSETS
    stager_path = assets / "stage.py"
    spec = importlib.util.spec_from_file_location("ezil_qualification_stager", stager_path)
    stager = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stager)
    stager.validate_pin(pin)
    archive = stager.download(pin["url"])
    require(digest(archive) == pin["archiveSha256"], "published-archive-digest-mismatch")

    with tempfile.TemporaryDirectory(prefix="ezil-imagebuilder-git-", dir="/run") as run_dir:
        scratch = Path(run_dir)
        cfg = SimpleNamespace(runDir=run_dir, runcBin="/usr/sbin/runc",
                              containerId="ezil-git-qualification-" + scratch.name.rsplit("-", 1)[1])
        version = pinned_version(cfg.runcBin)
        public_assets = scratch / "public"
        public_assets.mkdir()
        for name in ("stage.py", "supervise.py"):
            (public_assets / name).write_bytes((assets / name).read_bytes())
        (public_assets / "archive.tgz").write_bytes(archive)
        merged = make_bundle(cfg, scratch, lower, public_assets)
        try:
            result = exercise_container(cfg, desktop, runtime, pin)
        finally:
            try:
                desktop.runc(cfg, "delete", "--force", cfg.containerId,
                             stdin=subprocess.DEVNULL, capture_output=True, timeout=8)
                require(desktop.state(cfg) == "absent", "scratch-container-cleanup-failed")
            finally:
                command(["umount", str(merged)])
    return {"qualified": True, "agentSource": agent_sha, "lower": image_id, "runc": version,
            "runcSha256": digest(Path(cfg.runcBin).read_bytes()),
            "runtimeSourceSha256": digest(Path(runtime.__file__).read_bytes()),
            "desktopSourceSha256": digest(Path(desktop.__file__).read_bytes()),
            "stagerSourceSha256": digest(stager_path.read_bytes()),
            "cliVersion": pin["version"], "cliSource": pin["sourceCommit"],
            "cliSha256": pin["cliSha256"], "archiveSha256": pin["archiveSha256"],
            "supervisorSha256": pin["supervisorSha256"], **result}


def interrupt(_signum, _frame):
    raise QualificationRefused("qualification-interrupted")


def main():
    require(os.geteuid() == 0 and len(sys.argv) == 3, "qualification-context")
    image_id, archive_uri = sys.argv[1:]
    agent = AGENT_URI.fullmatch(archive_uri)
    require(LOWER_ID.fullmatch(image_id) and agent, "qualification-parameters")
    require(Path("/etc/ezil-host/lower-image-digest").read_text().strip() == image_id,
            "baked-lower-digest-mismatch")
    lower = LOWER_ROOT / image_id.removeprefix("sha256:")
    require(lower.is_dir() and not lower.is_symlink() and (lower / "usr").is_dir(), "baked-lower-missing")
    print("EZIL-STANDALONE-GIT-QUALIFICATION " + json.dumps(qualify(HOST_ROOT, lower, image_id, agent[1])))


if __name__ == "__main__":
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupt)
    try:
        main()
    except QualificationRefused as error:
        print("EZIL-STANDALONE-GIT-QUALIFICATION FAILED " + str(error))
        raise SystemExit(1) from None
    except (OSError, RuntimeError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
        print("EZIL-STANDALONE-GIT-QUALIFICATION FAILED")
        raise SystemExit(1) from None
