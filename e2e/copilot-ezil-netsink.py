#!/usr/bin/env python3
"""Network sink for the Copilot-Chat-on-EZiL image e2e (and the rev-3 audit).

Two modes, both stdlib only (the image has python3, no pip):

  dns  <log>            Tiny authoritative DNS server on UDP :53. Logs every
                        query (name + type) to <log>, one JSON line each, and
                        answers 127.0.0.1 for A, an empty NOERROR for AAAA and
                        everything else. Run it in a sidecar container and give
                        the image container `--dns <sidecar-ip>`: every host the
                        chat stack tries to resolve is recorded and the
                        connection lands on the container's own loopback, where
                        the `http` mode below (or nothing) answers.

  http <log> <certdir>  HTTP :80 + HTTPS :443 listener on 0.0.0.0 that logs
                        method, Host, path and TLS SNI for every request as a
                        JSON line and answers 503. <certdir> must hold
                        `sink.crt` / `sink.key` (made with openssl by the
                        runner). Extension-host fetches only complete the TLS
                        handshake when NODE_TLS_REJECT_UNAUTHORIZED=0 is in the
                        container env (the AUDIT run does that so paths can be
                        recorded); in the ASSERTING e2e run the handshake fails
                        and the SNI alone is logged, which is enough to fail
                        the "zero GitHub attempts" check.

Log line shape: {"t": <unix>, "kind": "dns"|"http"|"tls", "name"|"host": ..., ...}
"""
import json
import os
import socket
import ssl
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def log_line(path, obj):
    obj["t"] = round(time.time(), 3)
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(obj, sort_keys=True) + "\n")


# ── DNS ─────────────────────────────────────────────────────────────────────
QTYPES = {1: "A", 28: "AAAA", 5: "CNAME", 16: "TXT", 33: "SRV", 65: "HTTPS", 12: "PTR"}


def parse_qname(data, off):
    labels = []
    while True:
        ln = data[off]
        if ln == 0:
            return ".".join(labels), off + 1
        if ln & 0xC0:  # compression pointer — not expected in a question
            ptr = struct.unpack("!H", data[off:off + 2])[0] & 0x3FFF
            name, _ = parse_qname(data, ptr)
            labels.append(name)
            return ".".join(labels), off + 2
        labels.append(data[off + 1:off + 1 + ln].decode("ascii", "replace"))
        off += 1 + ln


def dns_answer(data, logpath):
    txid = data[:2]
    qdcount = struct.unpack("!H", data[4:6])[0]
    if qdcount < 1:
        return None
    qname, off = parse_qname(data, 12)
    qtype, qclass = struct.unpack("!HH", data[off:off + 4])
    question = data[12:off + 4]
    log_line(logpath, {"kind": "dns", "name": qname.lower(), "qtype": QTYPES.get(qtype, str(qtype))})
    flags = 0x8180  # standard response, recursion available, NOERROR
    if qtype == 1:
        rr = b"\xc0\x0c" + struct.pack("!HHIH", 1, 1, 30, 4) + socket.inet_aton("127.0.0.1")
        return txid + struct.pack("!HHHHH", flags, 1, 1, 0, 0) + question + rr
    return txid + struct.pack("!HHHHH", flags, 1, 0, 0, 0) + question


def serve_dns(logpath):
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.bind(("0.0.0.0", 53))
    print("netsink dns listening on udp/53, log", logpath, flush=True)
    while True:
        try:
            data, addr = sock.recvfrom(4096)
            resp = dns_answer(data, logpath)
            if resp:
                sock.sendto(resp, addr)
        except Exception as exc:  # noqa: BLE001 — keep serving whatever comes in
            log_line(logpath, {"kind": "dns-error", "error": str(exc)})


# ── HTTP / HTTPS ─────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    logpath = None
    scheme = "http"

    def _record(self):
        sni = getattr(self.connection, "_ezil_sni", None)
        log_line(self.logpath, {
            "kind": "http", "scheme": self.scheme, "method": self.command,
            "host": (self.headers.get("Host") or "").lower(), "path": self.path,
            "sni": sni, "ua": (self.headers.get("User-Agent") or "")[:120],
        })
        body = b'{"error":"ezil-netsink: outbound call blocked in the e2e"}'
        self.send_response(503)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)

    do_GET = do_POST = do_PUT = do_HEAD = do_DELETE = do_PATCH = do_OPTIONS = _record

    def log_message(self, *_):  # quiet
        pass


class TLSServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, addr, handler, ctx, logpath):
        super().__init__(addr, handler)
        self.ctx = ctx
        self.logpath = logpath

    def get_request(self):
        sock, addr = self.socket.accept()
        holder = {}

        def sni_cb(sslsock, name, _ctx):
            holder["sni"] = name
            return None

        self.ctx.sni_callback = sni_cb
        try:
            tls = self.ctx.wrap_socket(sock, server_side=True)
        except ssl.SSLError as exc:
            # Handshake refused by the client (untrusted cert): still a recorded attempt.
            log_line(self.logpath, {"kind": "tls", "sni": holder.get("sni"), "error": str(exc)[:160]})
            raise OSError("handshake failed") from exc
        tls._ezil_sni = holder.get("sni")
        return tls, addr

    def handle_error(self, request, client_address):
        pass


def serve_http(logpath, certdir):
    plain_handler = type("PlainHandler", (Handler,), {"logpath": logpath, "scheme": "http"})
    tls_handler = type("TLSHandler", (Handler,), {"logpath": logpath, "scheme": "https"})
    plain = ThreadingHTTPServer(("0.0.0.0", 80), plain_handler)
    plain.daemon_threads = True
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(os.path.join(certdir, "sink.crt"), os.path.join(certdir, "sink.key"))
    tls = TLSServer(("0.0.0.0", 443), tls_handler, ctx, logpath)
    threading.Thread(target=plain.serve_forever, daemon=True).start()
    print("netsink http listening on :80 and :443, log", logpath, flush=True)
    tls.serve_forever()


if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "dns":
        serve_dns(sys.argv[2])
    elif len(sys.argv) >= 4 and sys.argv[1] == "http":
        serve_http(sys.argv[2], sys.argv[3])
    else:
        sys.exit(__doc__)
