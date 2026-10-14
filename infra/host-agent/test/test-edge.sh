#!/usr/bin/env bash
# Host edge (gateway contract GW-2/GW-3/GW-5) on the PRODUCTION desktop ports (8181/8443),
# inside a disposable network namespace so nothing binds on the shared machine's network.
# The real edge and the real agent control socket run there; the stub desktop listens on
# 8181/8443 of the namespace loopback. Also proves the edge's listener is loopback-only.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; . "$HERE/lib.sh"
NS="${TAG}-edge"
cleanup() { ip netns delete "$NS" 2>/dev/null; }
trap cleanup EXIT
ip netns delete "$NS" 2>/dev/null; ip netns add "$NS"; ip -n "$NS" link set lo up
pyns() { ip netns exec "$NS" env PYTHONPATH="$HA/lib" EZIL_EDGE_FIXED_PORTS=1 python3 "$@"; }
check "edge E2E (real agent socket, fixed ports 8181/8443) inside a disposable netns" \
    bash -c "cd '$HA/test' && $(declare -f pyns); NS='$NS' HA='$HA' pyns -m unittest -q test_edge.EdgeE2E"
# The default config binds the edge to 127.0.0.1 only: a non-loopback address in the
# namespace must not reach it.
ip -n "$NS" link add ed0 type dummy; ip -n "$NS" addr add 192.0.2.10/24 dev ed0; ip -n "$NS" link set ed0 up
ip netns exec "$NS" env PYTHONPATH="$HA/lib" python3 - <<'PY' > "$T/edge-bind.out" 2>&1
import json, os, socket, tempfile, threading, time
from ezil_host import config, edge
cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
d = tempfile.mkdtemp()
cfg.update(stateDir=d, runDir=d)
lease = {"computerId": "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b", "generation": 1, "leaseEpoch": 2}
e = edge.Edge(cfg, lease, b"k" * 32)
stop = threading.Event(); got = {}
threading.Thread(target=e.serve, args=(stop, lambda a: got.setdefault("a", a)), daemon=True).start()
for _ in range(50):
    if "a" in got: break
    time.sleep(0.05)
print("bound", got["a"])
for host in ("127.0.0.1", "192.0.2.10"):
    try:
        socket.create_connection((host, cfg.edgePort), timeout=1).close(); print(host, "reachable")
    except OSError:
        print(host, "refused")
stop.set(); time.sleep(0.6)
PY
check "edge default bind is 127.0.0.1:18080" grep -q "bound ('127.0.0.1', 18080)" "$T/edge-bind.out"
check "edge reachable on loopback" grep -q "127.0.0.1 reachable" "$T/edge-bind.out"
check "edge NOT reachable on a non-loopback address" grep -q "192.0.2.10 refused" "$T/edge-bind.out"
summary "host edge"
