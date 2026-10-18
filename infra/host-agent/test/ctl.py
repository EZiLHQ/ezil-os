#!/usr/bin/env python3
"""Test client for the agent control socket: ctl.py <host-dir> '<json>'.
Signs with the host's stored control key. Fills `ts` (now) and `seq` (a per-host test
counter) unless given. Test-only knobs: "ts_offset": seconds added to now;
"ts_raw": "nan"|"inf" to send a non-finite ts; "raw": send this string unsigned."""
import json, os, socket, sys, time
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "lib"))
from ezil_host import agent, config  # noqa: E402

H, spec = sys.argv[1], json.loads(sys.argv[2])
cfg = config.load(os.path.join(H, "etc/agent.json"))
if "raw" in spec:
    s = socket.socket(socket.AF_UNIX); s.settimeout(5); s.connect(os.path.join(cfg.runDir, "control.sock"))
    s.sendall(spec["raw"].encode() + b"\n"); print(s.recv(4096).decode().strip()); sys.exit(0)
key = open(os.path.join(cfg.stateDir, "control.key"), "rb").read()
msg = {k: v for k, v in spec.items() if k not in ("ts_offset", "ts_raw")}
msg.setdefault("ts", time.time() + spec.get("ts_offset", 0))
if "ts_raw" in spec:
    msg["ts"] = float(spec["ts_raw"])
if "seq" not in msg:
    p = os.path.join(H, "run", "test-seq")
    n = int(open(p).read()) + 1 if os.path.exists(p) else 1
    open(p, "w").write(str(n)); msg["seq"] = n
print(json.dumps(agent.client(cfg, key, msg)))
