#!/usr/bin/env python3
"""Host edge (GATEWAY-CONTRACT-v1 GW-2/GW-3/GW-5) tests.

GwVectors: the Python gw1 verifier against the SHARED vectors that the Worker's signer is
held to (worker/src/aws-gateway.vectors.json), plus skew and framing. No sockets.

EdgeE2E: the real Edge on loopback sockets in front of stub desktop servers, with the REAL
agent.Agent serving its root-only control socket from a scratch dir. It proves: nothing is
forwarded without a valid gw1; the header is stripped; one request per connection (no
keep-alive smuggling); body framing; WebSocket upgrade piping; presence reaching the agent,
throttled and only for verified requests; the control relay; seq recovery.
By default the stub desktop binds ephemeral ports (unprivileged). test-edge.sh re-runs this
class inside `unshare -n` with EZIL_EDGE_FIXED_PORTS=1, so the production ports
(8181/8443) are used on a disposable loopback.
Run: python3 -m unittest -v test_edge   (from infra/host-agent/test)."""
import hashlib
import hmac
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "lib"))
from ezil_host import agent as agentmod, config, edge  # noqa: E402

VECTORS = os.path.join(HERE, "..", "..", "..", "worker", "src", "aws-gateway.vectors.json")
with open(VECTORS) as f:
    V = json.load(f)
KEY = __import__("base64").b64decode(V["controlKeyBase64"])


class GwVectors(unittest.TestCase):
    def test_valid_vectors_verify(self):
        for v in V["valid"]:
            self.assertEqual(edge.gateway_payload(v, v["ts"], v["method"], v["path"]), v["payload"])
            self.assertEqual(edge.verify_gw(v["header"], KEY, v, v["method"], v["path"], v["ts"]), (True, None))

    def test_invalid_vectors_refused_with_stated_error(self):
        for v in V["invalid"]:
            p = v["present"]
            self.assertEqual(edge.verify_gw(v["header"], KEY, p, p["method"], p["path"], p["ts"]), (False, v["error"]), v["name"])

    def test_skew_window(self):
        v = V["valid"][0]
        self.assertTrue(edge.verify_gw(v["header"], KEY, v, v["method"], v["path"], v["ts"] + 120)[0])
        self.assertEqual(edge.verify_gw(v["header"], KEY, v, v["method"], v["path"], v["ts"] + 121), (False, "gw_stale"))
        self.assertTrue(edge.verify_gw(v["header"], KEY, v, v["method"], v["path"], v["ts"] - 5)[0])
        self.assertEqual(edge.verify_gw(v["header"], KEY, v, v["method"], v["path"], v["ts"] - 6), (False, "gw_stale"))

    def test_missing_and_framing(self):
        v = V["valid"][0]
        self.assertEqual(edge.verify_gw(None, KEY, v, "GET", "/", v["ts"]), (False, "gw_missing"))
        with self.assertRaises(ValueError):
            edge.gateway_payload(v, v["ts"], "GET", "/a|b")
        with self.assertRaises(ValueError):
            edge.gateway_payload({**v, "leaseEpoch": 0}, v["ts"], "GET", "/")


# ---------------------------------------------------------------------------- E2E rig
CID = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b"
LEASE = {"computerId": CID, "generation": 1, "leaseEpoch": 2}


ICE_SECRETS = ("turn-user-SECRET-1", "turn-pass-SECRET-2", "a" * 32, "b" * 32)


def ice_config(**over):
    """A Worker-shaped relay config (worker/src/aws-ice.ts desktopConfigBody)."""
    c = {"v": 1, "expiresAt": int(time.time() * 1000) + 1_200_000,
         "frontend": [{"urls": ["turns:turn.cloudflare.com:443?transport=tcp"],
                       "username": ICE_SECRETS[0], "credential": ICE_SECRETS[1]}],
         "backend": [{"urls": ["turns:turn.cloudflare.com:443?transport=tcp"],
                      "username": ICE_SECRETS[0], "credential": ICE_SECRETS[1]}],
         "neko": {"user": ICE_SECRETS[2], "admin": ICE_SECRETS[3]}}
    c.update(over)
    return c


def gw_header(method, path, ts=None, binding=LEASE, key=KEY):
    ts = int(time.time()) if ts is None else ts
    payload = edge.gateway_payload(binding, ts, method, path)
    return f"gw1.{ts}.{hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()}"


class Upstream:
    """A stub desktop port: records each raw request; answers 200 or (ws) 101 + echo."""

    def __init__(self, port, ws=False):
        self.ws, self.requests, self.conns = ws, [], 0
        self.s = socket.socket()
        self.s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.s.bind(("127.0.0.1", port))
        self.s.listen(16)
        self.port = self.s.getsockname()[1]
        self.stop = threading.Event()
        threading.Thread(target=self._loop, daemon=True).start()

    def _loop(self):
        self.s.settimeout(0.2)
        while not self.stop.is_set():
            try:
                c, _ = self.s.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            threading.Thread(target=self._one, args=(c,), daemon=True).start()

    def _one(self, c):
        self.conns += 1
        c.settimeout(2)
        buf = b""
        try:
            while b"\r\n\r\n" not in buf:
                d = c.recv(8192)
                if not d:
                    return
                buf += d
            head, rest = buf.split(b"\r\n\r\n", 1)
            low = head.lower()
            if b"content-length:" in low:
                n = int(low.split(b"content-length:", 1)[1].split(b"\r\n", 1)[0])
                while len(rest) < n:
                    rest += c.recv(8192)
            elif b"transfer-encoding: chunked" in low:
                while not rest.endswith(b"0\r\n\r\n"):
                    d = c.recv(8192)
                    if not d:
                        break
                    rest += d
            self.requests.append(head + b"\r\n\r\n" + rest)
            if self.ws:
                c.sendall(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                c.settimeout(5)
                while True:
                    d = c.recv(8192)
                    if not d:
                        return
                    c.sendall(b"echo:" + d)
            else:
                c.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nupstrm!")
        except OSError:
            pass
        finally:
            c.close()

    def close(self):
        self.stop.set()
        self.s.close()


def raw(port, data, timeout=3, keep_open=False):
    s = socket.create_connection(("127.0.0.1", port), timeout=timeout)
    s.sendall(data)
    if keep_open:
        return s
    out = b""
    try:
        while True:
            d = s.recv(65536)
            if not d:
                break
            out += d
    except socket.timeout:
        pass
    s.close()
    return out


class EdgeE2E(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ezil-edge-")
        state, run = os.path.join(self.tmp, "state"), os.path.join(self.tmp, "run")
        os.makedirs(state, mode=0o700)
        os.makedirs(run, mode=0o700)
        with open(os.path.join(state, "control.key"), "wb") as f:
            f.write(KEY)
        fixed = os.environ.get("EZIL_EDGE_FIXED_PORTS") == "1"
        self.desk = Upstream(8181 if fixed else 0)
        self.code = Upstream(8443 if fixed else 0, ws=True)
        self.cfg = config.Config(json.loads(json.dumps(config.DEFAULTS)))
        self.cfg.update(stateDir=state, runDir=run, edgePort=0, edgeBind="127.0.0.1", edgeUpstreamHost="127.0.0.1",
                        edgePorts=[self.desk.port, self.code.port])
        self.agent = agentmod.Agent(self.cfg, LEASE, log=lambda m: None)
        self.boot_presence = self.agent.last_presence
        self.agent_stop = threading.Event()
        threading.Thread(target=self.agent.serve, args=(self.agent_stop,), daemon=True).start()
        for _ in range(50):
            if os.path.exists(os.path.join(run, "control.sock")):
                break
            time.sleep(0.05)
        self.logs = []
        self.edge = edge.Edge(self.cfg, LEASE, KEY, log=self.logs.append)
        self.edge_stop = threading.Event()
        addr = {}
        threading.Thread(target=self.edge.serve, args=(self.edge_stop, lambda a: addr.setdefault("a", a)), daemon=True).start()
        for _ in range(50):
            if "a" in addr:
                break
            time.sleep(0.05)
        self.port = addr["a"][1]

    def tearDown(self):
        self.edge_stop.set()
        self.agent_stop.set()
        self.desk.close()
        self.code.close()
        time.sleep(0.6)
        import shutil
        shutil.rmtree(self.tmp, ignore_errors=True)

    def req(self, method, path, headers=(), body=b"", gw=True, ts=None):
        h = [f"{method} {path} HTTP/1.1", "Host: c-x.origin.example.net"]
        if gw:
            h.append(f"x-ezil-gw: {gw_header(method, path.split('?')[0], ts=ts) if gw is True else gw}")
        h += list(headers)
        return ("\r\n".join(h) + "\r\n\r\n").encode() + body

    # -------------------------------------------------------------- refusals
    def test_no_bad_or_stale_header_is_401_and_nothing_forwarded(self):
        p = f"/__p/{self.desk.port}/x"
        for r in (self.req("GET", p, gw=False), self.req("GET", p, gw="gw1.1.abc"),
                  self.req("GET", p, gw=gw_header("GET", f"/__p/{self.desk.port}/other")),
                  self.req("GET", p, ts=int(time.time()) - 200),
                  self.req("GET", p, gw=gw_header("GET", p, binding={**LEASE, "leaseEpoch": 1}))):
            out = raw(self.port, r)
            self.assertTrue(out.startswith(b"HTTP/1.1 401"), out[:60])
        self.assertEqual(self.desk.conns, 0)
        self.assertEqual(self.agent.last_presence, self.boot_presence, "unverified requests must not count as presence")

    def test_two_headers_are_refused(self):
        p = f"/__p/{self.desk.port}/x"
        out = raw(self.port, self.req("GET", p, headers=[f"x-ezil-gw: {gw_header('GET', p)}"]))
        self.assertTrue(out.startswith(b"HTTP/1.1 401"))
        self.assertEqual(self.desk.conns, 0)

    def test_unknown_port_or_path_is_404(self):
        for p in ("/__p/9223/x", "/other", f"/__p/{self.desk.port}x"):
            self.assertTrue(raw(self.port, self.req("GET", p)).startswith(b"HTTP/1.1 404"), p)
        self.assertEqual(self.desk.conns, 0)

    # -------------------------------------------------------------- forwarding
    def test_verified_get_is_forwarded_stripped_with_browser_host(self):
        p = f"/__p/{self.desk.port}/hello"
        out = raw(self.port, self.req("GET", p + "?x=1", headers=["X-Forwarded-Host: aws-8181-guac-a-b.preview.example.org",
                                                                   "Connection: keep-alive"]))
        self.assertTrue(out.startswith(b"HTTP/1.1 200") and out.endswith(b"upstrm!"), out)
        sent = self.desk.requests[0].decode()
        self.assertTrue(sent.startswith("GET /hello?x=1 HTTP/1.1\r\n"), sent)
        self.assertNotIn("x-ezil-gw", sent.lower())
        self.assertIn("Host: aws-8181-guac-a-b.preview.example.org", sent)
        self.assertIn("Connection: close", sent)
        self.assertNotIn("keep-alive", sent.lower())

    def test_one_request_per_connection_no_smuggling(self):
        p = f"/__p/{self.desk.port}/first"
        two = self.req("GET", p) + b"GET /second HTTP/1.1\r\nHost: x\r\n\r\n"
        raw(self.port, two)
        time.sleep(0.2)
        self.assertEqual(len(self.desk.requests), 1)
        self.assertNotIn(b"/second", self.desk.requests[0].split(b"\r\n\r\n", 1)[0])

    def test_content_length_and_chunked_bodies(self):
        p = f"/__p/{self.desk.port}/up"
        raw(self.port, self.req("POST", p, headers=["Content-Length: 5"], body=b"hello"))
        self.assertTrue(self.desk.requests[-1].endswith(b"\r\n\r\nhello"))
        chunked = b"5\r\nhello\r\n0\r\n\r\n"
        raw(self.port, self.req("POST", p, headers=["Transfer-Encoding: chunked"], body=chunked))
        self.assertTrue(self.desk.requests[-1].endswith(chunked))

    def test_ambiguous_framing_is_refused_before_any_upstream_byte(self):
        p = f"/__p/{self.desk.port}/up"
        before = self.desk.conns
        out = raw(self.port, self.req("POST", p, headers=["Content-Length: 5", "Transfer-Encoding: chunked"], body=b"hello"))
        self.assertTrue(out.startswith(b"HTTP/1.1 400"))
        out = raw(self.port, self.req("POST", p, headers=["Transfer-Encoding: gzip"], body=b"x"))
        self.assertTrue(out.startswith(b"HTTP/1.1 400"))
        time.sleep(0.1)
        self.assertEqual(self.desk.conns, before)

    def test_websocket_upgrade_pipes_and_keeps_presence_alive(self):
        old = edge.WS_PRESENCE_INTERVAL
        edge.WS_PRESENCE_INTERVAL = 0.3
        try:
            p = f"/__p/{self.code.port}/ws"
            s = raw(self.port, self.req("GET", p, headers=["Upgrade: websocket", "Connection: Upgrade",
                                                         "Sec-WebSocket-Key: x"]), keep_open=True)
            head = s.recv(4096)
            self.assertTrue(head.startswith(b"HTTP/1.1 101"), head)
            first = self.agent.last_presence
            time.sleep(1.0)
            self.assertGreater(self.agent.last_presence, first, "an open verified WebSocket keeps sending presence")
            s.sendall(b"frame")
            self.assertEqual(s.recv(4096), b"echo:frame")
            s.close()
            sent = self.code.requests[0].decode()
            self.assertIn("Upgrade: websocket", sent)
            self.assertNotIn("x-ezil-gw", sent.lower())
        finally:
            edge.WS_PRESENCE_INTERVAL = old

    # -------------------------------------------------------------- presence + control
    def test_verified_request_is_presence_throttled(self):
        p = f"/__p/{self.desk.port}/a"
        raw(self.port, self.req("GET", p))
        self.assertGreater(self.agent.last_presence, self.boot_presence)
        seq1 = self.agent.last_seq
        raw(self.port, self.req("GET", p))
        self.assertEqual(self.agent.last_seq, seq1, "a second request within 15 s sends no second presence")

    def test_control_stop_and_fence_reach_the_agent(self):
        out = raw(self.port, self.req("POST", "/__ezil/control/stop/30"))
        self.assertTrue(out.startswith(b"HTTP/1.1 200"), out)
        self.assertEqual(self.agent.stop_request["kind"], "stop")
        self.assertEqual(self.agent.stop_request["warn"], 30)
        self.assertTrue(raw(self.port, self.req("POST", "/__ezil/control/fence")).startswith(b"HTTP/1.1 200"))
        self.assertEqual(self.agent.stop_request["kind"], "fence")
        self.assertTrue(raw(self.port, self.req("POST", "/__ezil/control/stop/901")).startswith(b"HTTP/1.1 400"))
        self.assertTrue(raw(self.port, self.req("POST", "/__ezil/control/fence/5")).startswith(b"HTTP/1.1 400"))
        self.assertTrue(raw(self.port, self.req("GET", "/__ezil/control/stop")).startswith(b"HTTP/1.1 404"))

    def test_unsigned_control_never_reaches_the_agent(self):
        out = raw(self.port, self.req("POST", "/__ezil/control/stop", gw=False))
        self.assertTrue(out.startswith(b"HTTP/1.1 401"))
        self.assertIsNone(self.agent.stop_request)

    # ------------------------------------------------- GW-5 ice + desktop status (aws-ice.ts)
    def ice_req(self, body, digest=None, extra=(), gw=True, method="POST"):
        digest = hashlib.sha256(body).hexdigest() if digest is None else digest
        return self.req(method, f"/__ezil/control/ice/{digest}", headers=[f"Content-Length: {len(body)}", *extra], body=body, gw=gw)

    def stored(self):
        return os.path.exists(os.path.join(self.cfg.runDir, "desktop-config.json"))

    def test_ice_push_with_the_signed_digest_reaches_the_agent_and_echoes_nothing(self):
        body = json.dumps(ice_config()).encode()
        out = raw(self.port, self.ice_req(body))
        self.assertTrue(out.startswith(b"HTTP/1.1 200"), out)
        self.assertIn(b'"state": "accepted"', out)
        self.assertTrue(self.stored())
        st = raw(self.port, self.req("GET", "/__ezil/control/desktop"))
        self.assertTrue(st.startswith(b"HTTP/1.1 200"), st)
        self.assertIn(b'"configured": true', st)
        for s in ICE_SECRETS:
            self.assertNotIn(s.encode(), out + st)
            self.assertNotIn(s, "\n".join(self.logs))

    def test_ice_body_must_hash_to_the_signed_digest(self):
        body = json.dumps(ice_config()).encode()
        other = hashlib.sha256(body + b" ").hexdigest()
        out = raw(self.port, self.ice_req(body, digest=other))
        self.assertTrue(out.startswith(b"HTTP/1.1 400") and b"ice_digest_mismatch" in out, out)
        self.assertFalse(self.stored())

    def test_ice_unsigned_chunked_oversize_wrong_method_or_query_never_reaches_the_agent(self):
        body = json.dumps(ice_config()).encode()
        d = hashlib.sha256(body).hexdigest()
        cases = [
            (self.ice_req(body, gw=False), b"401"),
            (self.req("POST", f"/__ezil/control/ice/{d}", headers=["Transfer-Encoding: chunked"],
                      body=b"%x\r\n" % len(body) + body + b"\r\n0\r\n\r\n"), b"400"),
            (self.req("POST", f"/__ezil/control/ice/{d}", headers=["Content-Length: 99999"], body=body), b"400"),
            (self.req("POST", f"/__ezil/control/ice/{d}", headers=[f"Content-Length: {len(body)}"] * 2, body=body), b"400"),
            (self.ice_req(body, method="GET"), b"404"),
            (self.req("POST", f"/__ezil/control/ice/{d}?x=1", headers=[f"Content-Length: {len(body)}"], body=body), b"404"),
            (self.req("POST", "/__ezil/control/desktop"), b"404"),
        ]
        for data, code in cases:
            out = raw(self.port, data)
            self.assertTrue(out.startswith(b"HTTP/1.1 " + code), (code, out[:80]))
        self.assertFalse(self.stored())

    def test_ice_config_the_agent_refuses_answers_409_with_its_code_only(self):
        body = json.dumps(ice_config(backend=[{"urls": ["stun:stun.cloudflare.com:3478"]}])).encode()
        out = raw(self.port, self.ice_req(body))
        self.assertTrue(out.startswith(b"HTTP/1.1 409") and b"ice_config_invalid" in out, out)
        self.assertFalse(self.stored())
        for s in ICE_SECRETS:
            self.assertNotIn(s.encode(), out)

    def test_seq_recovers_from_a_higher_persisted_mark(self):
        # Another writer (an older edge process) left a far higher seq: the first send is
        # refused as replayed, the sequencer re-reads the mark and the retry lands.
        far = int(time.time() * 1000) + 10_000_000
        self.agent._persist_seq(far)
        resp = self.edge.seq.send("presence")
        self.assertTrue(resp.get("ok"), resp)
        self.assertGreater(self.agent.last_seq, far)


if __name__ == "__main__":
    unittest.main()
