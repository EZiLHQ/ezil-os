#!/usr/bin/env python3
"""Seam server, lane W <-> lane H (REVERSE-MOVE-CONTRACT §2.2-§2.5, r7 integration).

The host's REAL export edge on a real loopback socket, in front of a REAL agent on its real unix
socket (the edge's Sequencer, the agent's MAC/epoch/replay rules and its `export` op). Only the
capture container is replaced: when the agent starts the job, this driver writes what the codec
would leave in tmp/ (chunk files and its JSON result) and runs the agent's REAL staging
(export.stage: re-hash, head.json) and the job's REAL finish (state `ready`). Nothing else is faked.

Driven by worker/src/export-edge-seam.test.ts, which points the Worker's REAL export client
(aws-origin.ts startAwsExport/readAwsExport) and its REAL pull at it.

Usage: python3 -B export_edge_seam_server.py '<json>'  with
  {"key": <base64 32 bytes>, "computerId", "generation", "leaseEpoch", "sizes": [chunk sizes],
   "captureOnPost": true}
Prints one line {"port": N} once listening; serves until stdin closes. The temp dir is removed
on exit.
"""
import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, edge, export  # noqa: E402


def main():
    spec = json.loads(sys.argv[1])
    key = base64.b64decode(spec["key"])
    lease = {"computerId": spec["computerId"], "generation": spec["generation"], "leaseEpoch": spec["leaseEpoch"]}
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="ezil-export-seam-"))
    try:
        state, run, data = (os.path.join(tmp, d) for d in ("state", "run", "data"))
        for d in (state, run, data):
            os.makedirs(d, mode=0o700)
        with open(os.path.join(state, "control.key"), "wb") as f:
            f.write(key)
        cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        cfg.update(stateDir=state, runDir=run, dataMount=data, edgePort=0, edgeBind="127.0.0.1")

        def capture(agent_self):
            """What `export-capture` leaves in tmp/, then the agent's real staging and finish."""
            record = export.read_state(cfg)
            if record is None or record["state"] != "capturing":
                return
            g = record["importGeneration"]
            export_dir = os.path.join(export.ensure_root(cfg), g)
            work = os.path.join(export_dir, "tmp", "ezil-snapshot-" + g)
            os.makedirs(work, mode=0o700)
            whole, chunks = hashlib.sha256(), []
            for i, size in enumerate(spec["sizes"]):
                data_i = bytes([(i * 7 + 3) % 256]) * size
                with open(os.path.join(work, str(i)), "wb") as f:
                    f.write(data_i)
                whole.update(data_i)
                chunks.append({"size": size, "sha256": hashlib.sha256(data_i).hexdigest()})
            raw = json.dumps({"sha256": whole.hexdigest(), "chunks": chunks, "entries": 4, "skipped": 1}).encode()
            head = export.stage(cfg, export_dir, record["moveId"], g, raw)
            export.Job(cfg, lease, lambda: True, log=lambda m: None)._finish(record["moveId"], g, "ready", head=head)

        if spec.get("captureOnPost", True):
            agentmod.Agent._start_export = capture
        else:
            agentmod.Agent._start_export = lambda agent_self: None
        agent = agentmod.Agent(cfg, lease, log=lambda m: None)
        stop = threading.Event()
        threading.Thread(target=agent.serve, args=(stop,), daemon=True).start()
        for _ in range(100):
            if os.path.exists(os.path.join(run, "control.sock")):
                break
            time.sleep(0.02)
        ed = edge.Edge(cfg, lease, key, log=lambda m: None)
        addr = {}
        threading.Thread(target=ed.serve, args=(stop, lambda a: addr.setdefault("a", a)), daemon=True).start()
        for _ in range(100):
            if "a" in addr:
                break
            time.sleep(0.02)
        print(json.dumps({"port": addr["a"][1]}), flush=True)
        sys.stdin.read()                      # until the test closes stdin (or exits)
        stop.set()
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
