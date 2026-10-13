"""cloudflared supervision (C-6 step 5/6).

Runs cloudflared with the per-epoch token passed in the ENVIRONMENT (TUNNEL_TOKEN), not
argv, restarts it on failure with capped backoff, and on a fence — the fence file
(written by the control channel on an epoch change or a stop), a token whose epoch is
not this lease's, or SIGTERM — stops cloudflared and wipes the local token.
"""
import json
import os
import signal
import subprocess
import time

from .enroll import TOKEN_FILE, wipe
from .fsops import Refused


def fence_path(cfg):
    return os.path.join(cfg.runDir, "fence")


def fence(cfg, reason):
    os.makedirs(cfg.runDir, mode=0o700, exist_ok=True)
    with open(fence_path(cfg), "w") as f:
        json.dump({"reason": reason, "at": int(time.time())}, f)


def _stop(child, grace=10):
    if child is None or child.poll() is not None:
        return
    child.terminate()
    try:
        child.wait(grace)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait()


def supervise(cfg, lease, max_backoff=30, poll=0.5, log=lambda m: print(m, flush=True)):
    tok_path = os.path.join(cfg.stateDir, TOKEN_FILE)
    stop = {"sig": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("sig", True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__("sig", True))
    try:
        with open(tok_path, encoding="utf-8") as f:
            tok = json.load(f)
    except (OSError, ValueError):
        raise Refused("tunnel_token_missing")
    child, backoff, restarts, reason = None, 1, 0, None
    try:
        while True:
            if stop["sig"]:
                reason = "sigterm"
            elif os.path.exists(fence_path(cfg)):
                reason = "fence"
            elif (tok.get("generation"), tok.get("leaseEpoch")) != (lease["generation"], lease["leaseEpoch"]):
                reason = "token_epoch_mismatch"
            if reason:
                break
            if child is None or child.poll() is not None:
                if child is not None:
                    restarts += 1
                    log(f"cloudflared exited ({child.returncode}); restart #{restarts} in {backoff}s")
                    t_end = time.time() + backoff
                    while time.time() < t_end and not stop["sig"] and not os.path.exists(fence_path(cfg)):
                        time.sleep(poll)
                    backoff = min(backoff * 2, max_backoff)
                    if stop["sig"] or os.path.exists(fence_path(cfg)):
                        continue
                env = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "TUNNEL_TOKEN": tok["token"]}
                child = subprocess.Popen([cfg.cloudflaredBin, "tunnel", "--no-autoupdate", "run"], env=env,
                                         stdin=subprocess.DEVNULL, start_new_session=True)
                started = time.time()
            elif time.time() - started > 60:
                backoff = 1
            time.sleep(poll)
    finally:
        _stop(child)
        wiped = wipe(tok_path)
        log(f"cloudflared stopped ({reason}); token wiped={wiped}")
    return reason, restarts
