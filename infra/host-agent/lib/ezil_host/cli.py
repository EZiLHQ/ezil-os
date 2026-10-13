"""ezil-host-agent <step>. One step per systemd unit (systemd/); `boot-chain` runs the
same steps in unit order for operators and tests. Exit codes: 0 ok, 2 refused, 1 error."""
import json
import os
import sys

from . import agent as agentmod, config, desktop, enroll as enrollmod, guard, rebase, tunnel
from .fsops import Refused


def _lease(cfg):
    return enrollmod.load_lease(cfg)


def step(cfg, name, detach=False):
    if name == "lease":
        l = enrollmod.fetch_lease(cfg)
        return f"lease generation={l['generation']} leaseEpoch={l['leaseEpoch']}"
    lease = _lease(cfg)
    if name == "guard":
        return "guard " + guard.run_guard(cfg, lease, rebase_runner=rebase.run_job)
    guard.require_stamp(cfg, lease)
    if name == "clean":
        return "clean " + json.dumps(desktop.host_clean(cfg))
    if name == "overlay":
        desktop.overlay_mount(cfg)
        desktop.netns_up(cfg)
        desktop.build_spec(cfg, lease, os.environ.get("EZIL_DESKTOP_MODE", "desktop"))
        return "overlay mounted, netns up, spec written"
    if name == "desktop":
        if detach:
            rc = desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log"))
            if rc != 0:
                raise Refused("desktop_start_failed", f"runc exit {rc}")
            return "desktop started"
        desktop.run(cfg)                      # execs runc (systemd Type=simple)
    if name == "enroll":
        enrollmod.enroll(cfg, lease)
        return "enrolled; tunnel token stored host-only; nonce wiped"
    if name == "cloudflared":
        reason, restarts = tunnel.supervise(cfg, lease)
        return f"cloudflared supervisor exit: {reason} restarts={restarts}"
    if name == "agent":
        agentmod.Agent(cfg, lease).run()
        return "agent stopped"
    raise SystemExit(f"unknown step {name}")


BOOT_ORDER = ["lease", "guard", "clean", "overlay", "desktop", "enroll"]


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if not argv:
        print(__doc__, file=sys.stderr)
        return 64
    cfg = config.load()
    cmd = argv[0]
    try:
        if cmd == "boot-chain":
            until = argv[1] if len(argv) > 1 else BOOT_ORDER[-1]
            for s in BOOT_ORDER[: BOOT_ORDER.index(until) + 1]:
                print(f"[{s}] " + step(cfg, s, detach=True), flush=True)
            return 0
        if cmd == "desktop-stop":
            desktop.stop(cfg)
            os.sync()
            return 0
        if cmd == "overlay-down":
            desktop.overlay_umount(cfg)
            desktop.netns_down(cfg)
            return 0
        if cmd == "data-down":
            os.sync()
            os.system(f"mountpoint -q {cfg.dataMount} && umount {cfg.dataMount}")
            return 0
        if cmd == "teardown":
            desktop.stop(cfg, kill="--kill" in argv)
            desktop.overlay_umount(cfg)
            os.system(f"umount {cfg.dataMount} 2>/dev/null")
            desktop.netns_down(cfg)
            return 0
        print(step(cfg, cmd, detach="--detach" in argv), flush=True)
        return 0
    except Refused as e:
        print(f"REFUSE {e}", flush=True)
        return 2


if __name__ == "__main__":
    sys.exit(main())
