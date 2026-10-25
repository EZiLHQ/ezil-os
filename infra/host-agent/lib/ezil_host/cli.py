"""ezil-host-agent <step>. One step per systemd unit (systemd/); `boot-chain` runs the
same steps in unit order for operators and tests. Exit codes: 0 ok, 2 refused, 1 error."""
import json
import os
import sys
import threading
import signal

from . import agent as agentmod, canary, config, desktop, enroll as enrollmod, guard, pool, rebase, tunnel
from .fsops import Refused


def _lease(cfg):
    return enrollmod.load_lease(cfg)


def desktop_relay(cfg, lease, wait=None):
    """Relay mode (the AWS AMI): wait, bounded, for the Worker's per-epoch relay config, then
    rebuild the spec with it, or without it (ice_missing; the Worker's next push makes the
    agent restart the desktop). Records which, for the agent's status. Local mode: None, the
    overlay step's spec stands. Prints no credential."""
    mode = cfg.get("iceMode", "local")
    if mode == "local":
        return None
    if mode != "relay":
        raise Refused("ice_mode_unknown", str(mode)[:32])
    c = (wait or desktop.wait_desktop_config)(cfg, float(cfg.get("iceWaitSeconds", 90)))
    desktop.build_spec(cfg, lease, os.environ.get("EZIL_DESKTOP_MODE", "desktop"), desktop_config=c)
    desktop.write_ice_state(cfg, "applied" if c else "missing", c["expiresAt"] if c else None)
    return "applied" if c else "missing (ice_missing): started without a relay; the next push restarts it"


ENROLLED_FILE = enrollmod.ENROLLED_FILE   # written by enroll.persist, before the nonce is retired


def _current_instance_id(cfg):
    return guard.current_instance_id(cfg)


def enroll_or_reuse(cfg, lease):
    """The enroll step. An in-place reboot of the SAME instance in the same epoch (EC2 host
    maintenance) re-reads the same user data, whose nonce the app already consumed: posting it
    again is refused. So when this instance already enrolled this exact (generation, epoch),
    and its tunnel token and control key are still on the host root volume (a fence wipes
    them), reuse them: wipe the local nonce copies and restore the edge's routing. Any other
    case enrolls normally."""
    if "ebsRestore" in lease:
        from . import maintenance
        return maintenance.enroll_or_reuse(cfg, lease)
    iid = _current_instance_id(cfg)
    rec = None
    try:
        with open(os.path.join(cfg.stateDir, ENROLLED_FILE), encoding="utf-8") as f:
            rec = json.load(f)
        with open(os.path.join(cfg.stateDir, enrollmod.TOKEN_FILE), encoding="utf-8") as f:
            tok = json.load(f)
        have_key = os.path.getsize(os.path.join(cfg.stateDir, enrollmod.KEY_FILE)) >= 32
    except (OSError, ValueError):
        rec, tok, have_key = None, None, False
    same = (isinstance(rec, dict) and isinstance(tok, dict) and have_key and iid is not None
            and rec.get("instanceId") == iid
            and rec.get("generation") == lease["generation"] == tok.get("generation")
            and rec.get("leaseEpoch") == lease["leaseEpoch"] == tok.get("leaseEpoch")
            and isinstance(rec.get("sandboxId"), str) and enrollmod.SANDBOX_ID_RE.fullmatch(rec["sandboxId"])
            and enrollmod.valid_zone(rec.get("zone")))
    if same:
        # One lease rewrite: the routing comes back in the same write that drops the nonce.
        enrollmod.wipe_nonce(cfg, dict(lease, sandboxId=rec["sandboxId"], zone=rec["zone"]))
        return "re-enrolled from this instance's own credentials (same-instance reboot, same epoch); nonce wiped"
    # enroll.persist records this instance's enrollment BEFORE it retires the nonce.
    enrollmod.enroll(cfg, lease, instance_id=iid)
    return "enrolled; tunnel token stored host-only; nonce wiped"


# The long-lived steps whose units restart them (systemd Restart=): each refuses while the agent
# is stopping this host, and its unit carries RestartPreventExitStatus=2, so a restart never
# brings a desktop, the edge or the tunnel back while the stop flushes and powers off.
RESTARTED_STEPS = ("desktop", "edge", "cloudflared")


def refuse_while_stopping(cfg, name):
    """runDir/stopping: the agent committed to stopping (exit 2 = RestartPreventExitStatus)."""
    if os.path.exists(os.path.join(cfg.runDir, desktop.STOPPING)):
        raise Refused(f"{name}_stopping", "the agent is stopping this host")


def step(cfg, name, detach=False):
    if name == "lease":
        l = enrollmod.fetch_lease(cfg)
        if l.get("kind") == "pool":
            return f"pool lease generation={l['poolGeneration']}"
        return f"lease generation={l['generation']} leaseEpoch={l['leaseEpoch']}"
    lease = _lease(cfg)
    if name == "guard":
        record = pool.read_record(cfg)
        if record is not None and lease.get("kind") != "pool":
            lease = {"kind": "pool", "poolHostId": record["poolHostId"],
                     "poolGeneration": record["poolGeneration"], "appOrigin": record.get("appOrigin")}
        if lease.get("kind") == "pool":
            return pool.run(cfg, lease)
        return "guard " + guard.run_guard(cfg, lease, rebase_runner=rebase.run_job)
    if name == "maintenance-enroll":
        return enroll_or_reuse(cfg, lease) if "ebsRestore" in lease else "ordinary boot"
    if name == "enroll" and "ebsRestore" in lease:
        return enroll_or_reuse(cfg, lease)
    guard.require_stamp(cfg, lease)
    if name == "clean":
        return "clean " + json.dumps(desktop.host_clean(cfg))
    if name == "overlay":
        desktop.overlay_mount(cfg)
        desktop.netns_up(cfg)
        # Pool specs are built once, with the enrolled relay, in run_desktop.
        if pool.session_record(cfg, lease) is None:
            desktop.build_spec(cfg, lease, os.environ.get("EZIL_DESKTOP_MODE", "desktop"))
        return "overlay mounted, netns up, spec written"
    if name == "desktop":
        refuse_while_stopping(cfg, name)
        if pool.session_record(cfg, lease) is not None:
            return pool.run_desktop(cfg, lease, detach=detach)
        relay = desktop_relay(cfg, lease)
        if relay is not None:
            print(f"[desktop] relay {relay}", flush=True)
        if detach:
            rc = desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log"))
            if rc != 0:
                raise Refused("desktop_start_failed", f"runc exit {rc}")
            return "desktop started"
        desktop.run(cfg)                      # execs runc (systemd Type=simple)
    if name == "enroll":
        return enroll_or_reuse(cfg, lease)
    if name == "cloudflared":
        refuse_while_stopping(cfg, name)
        reason, restarts = tunnel.supervise(cfg, lease)
        return f"cloudflared supervisor exit: {reason} restarts={restarts}"
    if name == "agent":
        agentmod.Agent(cfg, lease).run()
        return "agent stopped"
    if name == "edge":
        refuse_while_stopping(cfg, name)
        from . import edge as edgemod      # gateway contract GW-2/GW-3: cloudflared's only target
        stop = threading.Event()
        signal.signal(signal.SIGTERM, lambda *_: stop.set())
        edgemod.Edge(cfg, lease, edgemod.load_key(cfg)).serve(stop)
        return "edge stopped"
    raise SystemExit(f"unknown step {name}")


BOOT_ORDER = ["lease", "guard", "clean", "overlay", "desktop", "enroll"]
# Relay mode: the relay config arrives over the tunnel, so the desktop comes LAST (the
# systemd units order it after the agent, edge and cloudflared; nothing Requires it, so a
# desktop restart never cascades into enrollment or the tunnel).
BOOT_ORDER_RELAY = ["lease", "guard", "clean", "overlay", "enroll", "desktop"]


def boot_order(cfg):
    return BOOT_ORDER_RELAY if cfg.get("iceMode", "local") == "relay" else BOOT_ORDER


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(__doc__, file=sys.stderr)
        return 64
    cfg = config.load()
    cmd = argv[0]
    try:
        if cmd == "canary-desktop-started":
            canary.desktop_started(cfg)       # ExecStartPost; no lease or enrollment read
            return 0
        if cmd == "boot-chain":
            order = boot_order(cfg)
            until = argv[1] if len(argv) > 1 else order[-1]
            for s in order[: order.index(until) + 1]:
                print(f"[{s}] " + step(cfg, s, detach=True), flush=True)
                if s == "guard" and "ebsRestore" in _lease(cfg):
                    print("[maintenance-enroll] " + step(cfg, "maintenance-enroll"), flush=True)
                    return 0
            return 0
        if cmd == "desktop-stop":
            desktop.stop(cfg)
            os.sync()
            return 0
        if cmd == "net-ensure":
            print("net-ensure changed: " + (",".join(desktop.ensure_rules(cfg)) or "nothing"))
            return 0
        if cmd == "net-check":
            ok = desktop.rules_ok(cfg)
            print("net-check " + ("ok" if ok else "DRIFT"))
            return 0 if ok else 2
        if cmd == "overlay-down":
            desktop.overlay_umount(cfg)
            desktop.netns_down(cfg)
            return 0
        if cmd == "data-down":
            guard.clear_stamp(cfg)            # nothing may start on this host until the guard runs again
            os.sync()
            os.system(f"mountpoint -q {cfg.dataMount} && umount {cfg.dataMount}")
            return 0
        if cmd == "teardown":
            guard.clear_stamp(cfg)
            rc = 0
            for fn in (lambda: desktop.stop(cfg, kill="--kill" in argv), lambda: desktop.overlay_umount(cfg),
                       lambda: os.system(f"mountpoint -q {cfg.dataMount} && umount {cfg.dataMount}"),
                       lambda: desktop.netns_down(cfg)):
                try:
                    fn()
                except Exception as e:  # noqa: BLE001
                    print(f"teardown step failed: {e}", file=sys.stderr)
                    rc = 1
            return rc
        print(step(cfg, cmd, detach="--detach" in argv), flush=True)
        return 0
    except Refused as e:
        print(f"REFUSE {e}", flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
