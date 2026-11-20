#!/usr/bin/env python3
"""Seam server: the Worker's delegated Browser observation client <-> the host edge.

The host's REAL edge on a loopback socket, in front of a REAL agent on its unix socket (desktop_status
before and after, the agent's MAC/epoch/replay rules). Only the desktop is replaced: its state reads
`running`, and a stub sidecar on an ephemeral port stands in for 9223. The stub answers the closed
observation envelope whose browserSessionId is base64url(sha256(the bytes it received)), so the test
proves the Worker's exact bytes reached the sidecar through the edge.

Driven by worker/src/browser-observe-edge-seam.test.ts (aws-origin.ts observeAwsBrowser).

Usage: python3 -B browser_observe_edge_seam_server.py '<json>'  with
  {"key": <base64 32 bytes>, "computerId", "generation", "leaseEpoch", "enabled": true}
Prints one line {"port": N} once listening; serves until stdin closes. The temp dir is removed on exit.
"""
import base64
import hashlib
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, edge  # noqa: E402


def sidecar(stop):
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.listen(8)
    s.settimeout(0.2)

    def one(c):
        c.settimeout(2)
        buf = b""
        try:
            while b"\r\n\r\n" not in buf:
                buf += c.recv(4096)
            head, body = buf.split(b"\r\n\r\n", 1)
            n = int(head.lower().split(b"content-length:", 1)[1].split(b"\r\n", 1)[0])
            while len(body) < n:
                body += c.recv(4096)
            ok = head.split(b"\r\n", 1)[0] == b"POST /internal/mcp-browser-observe HTTP/1.1"
            sid = base64.urlsafe_b64encode(hashlib.sha256(body).digest()).rstrip(b"=").decode()
            value = ({"ok": True, "browserSessionId": sid, "expiresAt": "2026-11-20T00:02:00.000Z",
                      "observed": "profile_builder", "profileHeadingVisible": True, "universeIdentity": "unverified"}
                     if ok else {"ok": False, "error": "browser_unavailable"})
            data = json.dumps(value).encode()
            c.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: %d\r\n"
                      b"Connection: close\r\n\r\n" % len(data) + data)
        except (OSError, ValueError, IndexError):
            pass
        finally:
            c.close()

    def loop():
        while not stop.is_set():
            try:
                c, _ = s.accept()
            except socket.timeout:
                continue
            threading.Thread(target=one, args=(c,), daemon=True).start()
        s.close()

    threading.Thread(target=loop, daemon=True).start()
    return s.getsockname()[1]


def main():
    spec = json.loads(sys.argv[1])
    key = base64.b64decode(spec["key"])
    lease = {"computerId": spec["computerId"], "generation": spec["generation"], "leaseEpoch": spec["leaseEpoch"]}
    tmp = os.path.realpath(tempfile.mkdtemp(prefix="ezil-browser-seam-"))
    stop = threading.Event()
    try:
        state, run = os.path.join(tmp, "state"), os.path.join(tmp, "run")
        for d in (state, run):
            os.makedirs(d, mode=0o700)
        with open(os.path.join(state, "control.key"), "wb") as f:
            f.write(key)
        cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]          # edgePort 0 means the default 18080: take a free one
        probe.close()
        cfg.update(stateDir=state, runDir=run, edgePort=port, edgeBind="127.0.0.1", edgeUpstreamHost="127.0.0.1",
                   edgeBrowserObserve=spec.get("enabled", True))
        edge.BROWSER_SIDECAR_PORT = sidecar(stop)
        agentmod.Agent._desktop_state = lambda agent_self: "running"
        agent = agentmod.Agent(cfg, lease, log=lambda m: None)
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
    finally:
        stop.set()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    main()
