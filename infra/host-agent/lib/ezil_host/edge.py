"""Host edge: the only thing cloudflared forwards to (GATEWAY-CONTRACT-v1 GW-2, GW-3, GW-5).

Listens on 127.0.0.1:edgePort (the tunnel's ingress target). Every request must carry
`x-ezil-gw: gw1.<ts>.<hex>` = HMAC-SHA256(control.key, "gw1|ts|computerId|generation|
leaseEpoch|METHOD|path"), bound to THIS host's lease and fresh within -120 s/+5 s. A
missing or bad header is answered 401 and NOTHING is forwarded; the header is stripped
before forwarding.

Routing is by the signed path only:
  /__p/<port><path>                 -> the desktop at edgeUpstreamHost:<port><path>, for the
                                       ports the Cloudflare route exposes (8181 neko, 8080
                                       guacamole, 3002 app preview, 8443 code-server);
  POST /__ezil/control/stop[/<warn>] -> the agent's `stop` (warn 0..900 s);
  POST /__ezil/control/fence         -> the agent's `fence`.
Anything else is 404.

One request per connection (the upstream gets `Connection: close`), so a second request on
a kept-alive client connection can never ride through unverified. A WebSocket upgrade that
the desktop accepts (101) becomes a raw two-way pipe, which is a WebSocket by then.

Presence (GW-3): every verified request, and one shared tick every 30 s while any verified
WebSocket stays open, is reported to the agent as a `presence` command on its root-only control socket. The
edge is that socket's only client, so it owns the per-epoch `seq` (the agent refuses any seq
at or below its persisted high-water mark). Presence is throttled to one command per 15 s:
the idle window is 600 s, and every command costs the agent an fsync.

The edge never renews a lease and makes no outbound call except to the desktop and the
agent socket. Stdlib only.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import socket
import threading
import time

from . import agent as agentmod
from . import desktop
from .fsops import Refused

GW_HEADER = "x-ezil-gw"
SKEW_PAST, SKEW_FUTURE = 120, 5
PRESENCE_MIN_INTERVAL = 15
WS_PRESENCE_INTERVAL = 30
MAX_HEAD = 32768
MAX_CHUNK_LINE = 1024
PORTS = (8181, 8080, 3002, 8443)
GW_RE = re.compile(r"^gw1\.(\d{1,12})\.([0-9a-f]{64})$")
UUID_RE = re.compile(r"^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$")
METHOD_RE = re.compile(r"^[A-Z]{1,16}$")
PATH_RE = re.compile(r"^/[\x21-\x7e]{0,2047}$")
PROXY_RE = re.compile(r"^/__p/(\d{4,5})(/[\x21-\x7e]*)?$")
CONTROL_RE = re.compile(r"^/__ezil/control/(stop|fence)(?:/(\d{1,3}))?$")
# GW-5 `ice` (worker/src/aws-ice.ts): the body is not covered by the path-only gw1 signature,
# so its sha256 is IN the signed path and the body must hash to it. `desktop`: status, no body.
ICE_RE = re.compile(r"^/__ezil/control/ice/([0-9a-f]{64})$")
DESKTOP_STATUS_PATH = "/__ezil/control/desktop"
MAX_ICE_BODY = 16384
FORWARDING_HEADERS = {"forwarded", "via", "x-real-ip", "true-client-ip", "cf-connecting-ip",
                      "cf-connecting-ipv6", "cf-pseudo-ipv4", "cf-visitor"}
HOP_BY_HOP = {"connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization",
              "te", "trailer", "upgrade"}


def gateway_payload(binding, ts, method, path):
    """The canonical gw1 string; ValueError on anything that could break the framing."""
    if not isinstance(binding.get("computerId"), str) or not UUID_RE.match(binding["computerId"]):
        raise ValueError("gw_invalid_binding")
    for k in ("generation", "leaseEpoch"):
        v = binding.get(k)
        if not isinstance(v, int) or isinstance(v, bool) or v < 1:
            raise ValueError("gw_invalid_binding")
    if not isinstance(ts, int) or isinstance(ts, bool) or ts <= 0:
        raise ValueError("gw_invalid_ts")
    if not METHOD_RE.match(method or "") or not PATH_RE.match(path or "") or "|" in path:
        raise ValueError("gw_invalid_request")
    return f"gw1|{ts}|{binding['computerId']}|{binding['generation']}|{binding['leaseEpoch']}|{method}|{path}"


def verify_gw(header, key, binding, method, path, now):
    """(True, None) or (False, error). `binding` is this host's lease."""
    if header is None:
        return False, "gw_missing"
    m = GW_RE.match(header)
    if not m:
        return False, "gw_malformed"
    ts = int(m.group(1))
    if ts < now - SKEW_PAST or ts > now + SKEW_FUTURE:
        return False, "gw_stale"
    try:
        payload = gateway_payload(binding, ts, method, path)
    except ValueError:
        return False, "gw_invalid_request"
    want = hmac.new(key, payload.encode(), hashlib.sha256).hexdigest()
    return (True, None) if hmac.compare_digest(want, m.group(2)) else (False, "gw_bad_mac")


def load_key(cfg):
    with open(os.path.join(cfg.stateDir, "control.key"), "rb") as f:
        key = f.read()
    if len(key) < 32:
        raise Refused("edge_control_key_invalid")
    return key


class Sequencer:
    """The agent control socket's single client: monotonic seq, signed commands, throttled presence."""

    def __init__(self, cfg, lease, key, clock=time.time, log=lambda m: print(m, flush=True),
                 monotonic=time.monotonic):
        self.cfg, self.lease, self.key, self.clock, self.log = cfg, lease, key, clock, log
        self.monotonic = monotonic
        self.lock = threading.Lock()
        self.seq = self._persisted_seq()
        self.last_presence = None

    def _persisted_seq(self):
        try:
            with open(os.path.join(self.cfg.stateDir, "control-seq.json")) as f:
                d = json.load(f)
            if d.get("leaseEpoch") == self.lease["leaseEpoch"] and isinstance(d.get("seq"), int):
                return d["seq"]
        except (OSError, ValueError, AttributeError):
            pass
        return 0

    def _send_once(self, msg):
        msg["mac"] = agentmod.sign(self.key, msg)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(10)
        try:
            s.connect(os.path.join(self.cfg.runDir, "control.sock"))
            s.sendall((json.dumps(msg) + "\n").encode())
            data = b""
            while not data.endswith(b"\n") and len(data) < 65536:
                chunk = s.recv(4096)
                if not chunk:
                    break
                data += chunk
        finally:
            s.close()
        return json.loads(data or b"{}")

    def send(self, op, **fields):
        with self.lock:
            if op == "presence":
                now = self.monotonic()
                if self.last_presence is not None and now - self.last_presence < PRESENCE_MIN_INTERVAL:
                    return None
            for attempt in (1, 2):
                self.seq = max(self.seq + 1, int(self.clock() * 1000))
                msg = {"op": op, "leaseEpoch": self.lease["leaseEpoch"], "ts": self.clock(), "seq": self.seq, **fields}
                try:
                    resp = self._send_once(msg)
                finally:
                    if op == "presence":
                        # Include delivery time and failures in the shared throttle.
                        self.last_presence = self.monotonic()
                if resp.get("error") == "replayed" and attempt == 1:
                    self.seq = max(self.seq, self._persisted_seq())
                    if op != "presence":
                        continue   # presence retries must wait for the shared throttle
                return resp
        return {"ok": False, "error": "replayed"}

    def presence(self):
        try:
            resp = self.send("presence")
        except (OSError, ValueError) as e:
            self.log(f"edge: presence not delivered: {type(e).__name__}")
            return None
        if resp is not None and not resp.get("ok"):
            self.log(f"edge: presence refused: {resp.get('error')}")
        return resp


class _Head:
    def __init__(self, method, target, version, headers, rest):
        self.method, self.target, self.version, self.headers, self.rest = method, target, version, headers, rest

    def get(self, name):
        vals = [v for k, v in self.headers if k.lower() == name]
        return vals

    def one(self, name):
        vals = self.get(name)
        return vals[0] if len(vals) == 1 else None


def read_head(sock):
    buf = b""
    while b"\r\n\r\n" not in buf:
        if len(buf) > MAX_HEAD:
            raise ValueError("head_too_large")
        chunk = sock.recv(8192)
        if not chunk:
            raise ValueError("eof")
        buf += chunk
    raw, rest = buf.split(b"\r\n\r\n", 1)
    if len(raw) > MAX_HEAD:
        raise ValueError("head_too_large")
    lines = raw.decode("latin-1").split("\r\n")
    parts = lines[0].split(" ")
    if len(parts) != 3 or not parts[2].startswith("HTTP/1."):
        raise ValueError("bad_request_line")
    headers, seen = [], set()
    for line in lines[1:]:
        if "\r" in line or "\n" in line or ":" not in line or line[0] in " \t":
            raise ValueError("bad_header")
        k, v = line.split(":", 1)
        if not k or k.strip() != k:
            raise ValueError("bad_header")
        lk = k.lower()
        if lk in {"host", "content-length", "transfer-encoding"} and lk in seen:
            raise ValueError("duplicate_header")
        seen.add(lk)
        headers.append((k, v.strip()))
    return _Head(parts[0], parts[1], parts[2], headers, rest)


def _reply(sock, status, body, extra=()):
    reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 409: "Conflict",
              502: "Bad Gateway", 503: "Service Unavailable"}.get(status, "Error")
    data = json.dumps(body).encode()
    head = [f"HTTP/1.1 {status} {reason}", "Content-Type: application/json", f"Content-Length: {len(data)}",
            "Connection: close", *extra]
    try:
        sock.sendall(("\r\n".join(head) + "\r\n\r\n").encode() + data)
    except OSError:
        pass


def _recv_exact(sock, n, pending):
    out, buf = [], pending
    while n > 0:
        if not buf:
            buf = sock.recv(min(65536, n))
            if not buf:
                raise ValueError("eof")
        take, buf = buf[:n], buf[n:]
        out.append(take)
        n -= len(take)
    return b"".join(out), buf


def _forward_body(client, upstream, head):
    """Forward exactly the request body: Content-Length bytes, or a chunked stream up to its
    terminator. Both, or a malformed length, is refused (request smuggling)."""
    te, cl = head.get("transfer-encoding"), head.get("content-length")
    pending = head.rest
    if te and cl:
        raise ValueError("ambiguous_length")
    if cl:
        if len(cl) != 1 or not cl[0].isdigit():
            raise ValueError("bad_length")
        data, pending = _recv_exact(client, int(cl[0]), pending)
        upstream.sendall(data)
        return pending
    if te:
        if len(te) != 1 or te[0].lower() != "chunked":
            raise ValueError("bad_transfer_encoding")
        while True:
            while b"\r\n" not in pending:
                if len(pending) > MAX_CHUNK_LINE:
                    raise ValueError("bad_chunk")
                more = client.recv(8192)
                if not more:
                    raise ValueError("eof")
                pending += more
            line, pending = pending.split(b"\r\n", 1)
            size_txt = line.split(b";", 1)[0].strip()
            if not re.fullmatch(rb"[0-9a-fA-F]{1,8}", size_txt):
                raise ValueError("bad_chunk")
            size = int(size_txt, 16)
            if size == 0:
                # Withhold the final chunk until the empty trailer section is verified.
                terminator, pending = _recv_exact(client, 2, pending)
                if terminator != b"\r\n":
                    raise ValueError("trailers_not_allowed")
                upstream.sendall(line + b"\r\n\r\n")
                return pending
            upstream.sendall(line + b"\r\n")
            data, pending = _recv_exact(client, size + 2, pending)
            if not data.endswith(b"\r\n"):
                raise ValueError("bad_chunk")
            upstream.sendall(data)
    return pending


def _pipe(a, b, stop):
    try:
        while not stop.is_set():
            data = a.recv(65536)
            if not data:
                break
            b.sendall(data)
    except OSError:
        pass
    finally:
        stop.set()
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass


class Edge:
    def __init__(self, cfg, lease, key, sequencer=None, clock=time.time, log=lambda m: print(m, flush=True)):
        self.cfg, self.lease, self.key, self.clock, self.log = cfg, lease, key, clock, log
        self.seq = sequencer or Sequencer(cfg, lease, key, clock, log)
        self.upstream_host = cfg.get("edgeUpstreamHost") or desktop.CT_IP
        self.ports = tuple(int(p) for p in (cfg.get("edgePorts") or PORTS))
        self.binding = {"computerId": lease["computerId"], "generation": lease["generation"],
                        "leaseEpoch": lease["leaseEpoch"]}
        sandbox_id = cfg.get("sandboxId") or lease.get("sandboxId")
        zone = cfg.get("zone") or lease.get("zone")
        # These fields are trusted configuration (enrollment writes them into the lease),
        # never inferred from a request. Browser hosts are the Worker's
        # `aws-<port>-<sandboxId>-aws.<zone>` (worker/src/aws-origin.ts): the fixed `-aws`
        # suffix is what the Worker's narrow route claims.
        self.browser_host_re = None
        if isinstance(sandbox_id, str) and sandbox_id and isinstance(zone, str) and zone:
            self.browser_host_re = re.compile(
                r"aws-(8181|8080|3002|8443)-" + re.escape(sandbox_id) + r"-aws\." + re.escape(zone))
        self._ws_lock = threading.Lock()
        self._websockets = 0

    # ------------------------------------------------------------------ one request
    def handle(self, client):
        client.settimeout(30)
        try:
            head = read_head(client)
        except (ValueError, OSError):
            _reply(client, 400, {"ok": False, "error": "bad_request"})
            return
        path = head.target.split("?", 1)[0]
        query = head.target[len(path):]
        gw = head.get(GW_HEADER)
        ok, err = verify_gw(gw[0] if len(gw) == 1 else (None if not gw else "multiple"), self.key, self.binding,
                            head.method, path, int(self.clock()))
        if not ok:
            _reply(client, 401, {"ok": False, "error": err})
            return
        self.seq.presence()
        m = CONTROL_RE.match(path)
        if m:
            self._control(client, head, m)
            return
        m = ICE_RE.match(path)
        if m:
            self._ice(client, head, m.group(1), query)
            return
        if path == DESKTOP_STATUS_PATH:
            self._desktop_status(client, head, query)
            return
        m = PROXY_RE.match(path)
        if not m or int(m.group(1)) not in self.ports:
            _reply(client, 404, {"ok": False, "error": "not_found"})
            return
        self._proxy(client, head, int(m.group(1)), (m.group(2) or "/") + query)

    def _control(self, client, head, m):
        if head.method != "POST":
            _reply(client, 404, {"ok": False, "error": "not_found"})
            return
        op, warn = m.group(1), m.group(2)
        fields = {}
        if warn is not None:
            if op != "stop" or int(warn) > agentmod.MAX_WARN:
                _reply(client, 400, {"ok": False, "error": "bad_warn"})
                return
            fields["warnSeconds"] = int(warn)
        if op == "fence":
            fields["newEpoch"] = "control_plane"
        try:
            resp = self.seq.send(op, reason="control_plane", **fields) if op == "stop" else self.seq.send(op, **fields)
        except (OSError, ValueError):
            _reply(client, 503, {"ok": False, "error": "agent_unavailable"})
            return
        _reply(client, 200 if resp.get("ok") else 409, resp)

    def _agent(self, client, op, **fields):
        try:
            resp = self.seq.send(op, **fields)
        except (OSError, ValueError):
            _reply(client, 503, {"ok": False, "error": "agent_unavailable"})
            return
        # The agent never answers with the config; pass only its own keys through.
        _reply(client, 200 if resp.get("ok") else 409,
               {k: resp[k] for k in ("ok", "state", "error", "configured", "expiresAt", "desktop", "ice") if k in resp})

    def _ice(self, client, head, digest, query):
        """POST /__ezil/control/ice/<sha256>: a Content-Length body (no chunking, at most
        MAX_ICE_BODY) whose sha256 equals the signed digest, relayed to the agent as `ice`.
        The body holds TURN credentials and the neko values: never logged, never echoed."""
        cl, te = head.get("content-length"), head.get("transfer-encoding")
        if head.method != "POST" or query:
            _reply(client, 404, {"ok": False, "error": "not_found"})
            return
        if te or len(cl) != 1 or not cl[0].isdigit() or not 0 < int(cl[0]) <= MAX_ICE_BODY:
            _reply(client, 400, {"ok": False, "error": "ice_body_invalid"})
            return
        try:
            body, _ = _recv_exact(client, int(cl[0]), head.rest)
        except (ValueError, OSError):
            _reply(client, 400, {"ok": False, "error": "ice_body_invalid"})
            return
        if not hmac.compare_digest(hashlib.sha256(body).hexdigest(), digest):
            _reply(client, 400, {"ok": False, "error": "ice_digest_mismatch"})
            return
        try:
            config = json.loads(body)
        except ValueError:
            config = None
        if not isinstance(config, dict):
            _reply(client, 400, {"ok": False, "error": "ice_config_invalid"})
            return
        self._agent(client, "ice", config=config)

    def _desktop_status(self, client, head, query):
        if head.method != "GET" or query or head.get("content-length") or head.get("transfer-encoding"):
            _reply(client, 404, {"ok": False, "error": "not_found"})
            return
        self._agent(client, "desktop_status")

    def _proxy(self, client, head, port, upath):
        te, cl = head.get("transfer-encoding"), head.get("content-length")
        if (te and cl) or len(te) > 1 or len(cl) > 1 or (cl and not cl[0].isdigit()) \
                or (te and te[0].lower() != "chunked"):
            _reply(client, 400, {"ok": False, "error": "bad_body_framing"})   # before any upstream byte
            return
        upgrade = any(v.lower() == "websocket" for v in head.get("upgrade"))
        fwd = [f"{head.method} {upath} HTTP/1.1"]
        xfh = head.one("x-forwarded-host")
        browser_host = (xfh if xfh and self.browser_host_re
                        and self.browser_host_re.fullmatch(xfh) else None)
        for k, v in head.headers:
            lk = k.lower()
            if lk in HOP_BY_HOP or lk in FORWARDING_HEADERS or lk.startswith(("x-forwarded-", "x-ezil-")):
                continue
            if lk == "host" and browser_host:
                v = browser_host   # otherwise retain the gateway's tunnel Host
            fwd.append(f"{k}: {v}")
        fwd += ["Upgrade: websocket", "Connection: Upgrade"] if upgrade else ["Connection: close"]
        try:
            upstream = socket.create_connection((self.upstream_host, port), timeout=10)
        except OSError:
            _reply(client, 502, {"ok": False, "error": "desktop_unreachable"})
            return
        try:
            upstream.sendall(("\r\n".join(fwd) + "\r\n\r\n").encode("latin-1"))
            try:
                _forward_body(client, upstream, head)
            except ValueError as e:
                _reply(client, 400, {"ok": False, "error": str(e)})
                return
            if upgrade:
                self._after_upgrade(client, upstream)
            else:
                upstream.settimeout(300)
                client.settimeout(300)
                while True:
                    data = upstream.recv(65536)
                    if not data:
                        break
                    client.sendall(data)
        except OSError:
            pass
        finally:
            try:
                upstream.close()
            except OSError:
                pass

    def _after_upgrade(self, client, upstream):
        upstream.settimeout(30)
        buf = b""
        while b"\r\n\r\n" not in buf:
            data = upstream.recv(8192)
            if not data:
                return
            buf += data
            if len(buf) > MAX_HEAD:
                return
        client.sendall(buf)
        status = buf.split(b"\r\n", 1)[0].split(b" ")
        if len(status) < 2 or status[1] != b"101":
            while True:   # not upgraded: relay the rest of this one response, then close
                data = upstream.recv(65536)
                if not data:
                    return
                client.sendall(data)
        stop = threading.Event()
        upstream.settimeout(None)
        client.settimeout(None)
        with self._ws_lock:
            self._websockets += 1
        try:
            t = threading.Thread(target=_pipe, args=(upstream, client, stop), daemon=True)
            t.start()
            _pipe(client, upstream, stop)
            t.join(5)
        finally:
            with self._ws_lock:
                self._websockets -= 1

    def _ws_presence(self, stop):
        while not stop.wait(WS_PRESENCE_INTERVAL):
            with self._ws_lock:
                active = self._websockets > 0
            if active:
                self.seq.presence()

    # ------------------------------------------------------------------ server
    def serve(self, stop_event, ready=None):
        bind = self.cfg.get("edgeBind") or "127.0.0.1"
        port = int(self.cfg.get("edgePort") or 18080)
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind((bind, port))
        s.listen(64)
        s.settimeout(0.5)
        ticker_stop = threading.Event()
        ticker = threading.Thread(target=self._ws_presence, args=(ticker_stop,), daemon=True)
        ticker.start()
        try:
            if ready is not None:
                ready(s.getsockname())
            while not stop_event.is_set():
                try:
                    c, _ = s.accept()
                except socket.timeout:
                    continue
                threading.Thread(target=self._serve_one, args=(c,), daemon=True).start()
        finally:
            ticker_stop.set()
            s.close()
            ticker.join(1)

    def _serve_one(self, c):
        try:
            self.handle(c)
        except Exception as e:  # noqa: BLE001 — one bad connection must never kill the edge
            self.log(f"edge: connection error {type(e).__name__}")
        finally:
            try:
                c.close()
            except OSError:
                pass


def main():
    import signal as _signal
    from . import config, enroll
    cfg = config.load()
    lease = enroll.load_lease(cfg)
    edge = Edge(cfg, lease, load_key(cfg))
    stop = threading.Event()
    _signal.signal(_signal.SIGTERM, lambda *_: stop.set())
    _signal.signal(_signal.SIGINT, lambda *_: stop.set())
    edge.serve(stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
