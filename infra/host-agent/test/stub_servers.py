#!/usr/bin/env python3
"""Test stubs on UNIX SOCKETS only (never a TCP port):
  imds <sock> <dir>      IMDSv2: PUT token; GET user-data (<dir>/user-data), identity
                         document and pkcs7. Rejects GETs without a valid token.
  app  <sock> <dir> <cert> <key>
                         HTTPS enrollment endpoint. Accepts a nonce once (<dir>/nonce),
                         checks fields against <dir>/expect.json, records the request
                         body to <dir>/enroll-requests.jsonl, returns a tunnel token and
                         a control key from <dir>/issue.json.
"""
import base64
import http.server
import json
import os
import secrets
import socket
import socketserver
import ssl
import sys


class UnixServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True

    def get_request(self):
        req, _ = super().get_request()
        return req, ("unix", 0)


def imds(sock, d):
    tokens = set()

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, body=b""):
            self.send_response(code)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_PUT(self):
            if self.path != "/latest/api/token" or not self.headers.get("X-aws-ec2-metadata-token-ttl-seconds"):
                return self._send(400)
            t = secrets.token_hex(16)
            tokens.add(t)
            self._send(200, t.encode())

        def do_GET(self):
            if self.headers.get("X-aws-ec2-metadata-token") not in tokens:
                return self._send(401)
            files = {"/latest/user-data": "user-data",
                     "/latest/dynamic/instance-identity/document": "identity.json",
                     "/latest/dynamic/instance-identity/pkcs7": "pkcs7"}
            if self.path not in files:
                return self._send(404)
            with open(os.path.join(d, files[self.path]), "rb") as f:
                self._send(200, f.read())
    serve(sock, H)


def app(sock, d, cert, key):
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _send(self, code, obj):
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_POST(self):
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            with open(os.path.join(d, "enroll-requests.jsonl"), "ab") as f:
                f.write(raw + b"\n")
            # Answers that consumed nothing (the host keeps its nonce and retries, bounded):
            # the app's `retryable: true`, and a platform 5xx page the app did not author.
            if os.path.exists(os.path.join(d, "retry-always")):
                return self._send(503, {"error": "enroll_describe_unavailable", "retryable": True})
            for once, code, obj in (("retry-once", 503, {"error": "enroll_describe_unavailable", "retryable": True}),
                                    ("platform-502-once", 502, None)):
                if os.path.exists(os.path.join(d, once)):
                    os.unlink(os.path.join(d, once))
                    if obj is not None:
                        return self._send(code, obj)
                    page = b"<html><body>502 Bad Gateway</body></html>"
                    self.send_response(code)
                    self.send_header("Content-Type", "text/html")
                    self.send_header("Content-Length", str(len(page)))
                    self.end_headers()
                    return self.wfile.write(page)
            try:
                b = json.loads(raw)
                with open(os.path.join(d, "expect.json")) as f:
                    exp = json.load(f)
            except ValueError:
                return self._send(400, {"error": "bad_json"})
            if set(b) != {"computerId", "generation", "leaseEpoch", "nonce", "identityDocument", "signature"}:
                return self._send(400, {"error": "fields"})
            for k in ("computerId", "generation", "leaseEpoch"):
                if b[k] != exp[k]:
                    return self._send(403, {"error": f"{k}_mismatch"})
            npath = os.path.join(d, "nonce")
            try:
                with open(npath) as f:
                    nonce = f.read().strip()
            except FileNotFoundError:
                return self._send(409, {"error": "nonce_consumed"})
            if b["nonce"] != nonce:
                return self._send(403, {"error": "nonce_mismatch"})
            os.unlink(npath)                                  # single use (C-6 step 4)
            with open(os.path.join(d, "issue.json")) as f:
                self._send(200, json.load(f))
    serve(sock, H, ctx)


def serve(sock, handler, ctx=None):
    try:
        os.unlink(sock)
    except FileNotFoundError:
        pass
    srv = UnixServer(sock, handler)
    if ctx:
        srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    os.chmod(sock, 0o600)
    srv.serve_forever()


if __name__ == "__main__":
    if sys.argv[1] == "imds":
        imds(sys.argv[2], sys.argv[3])
    else:
        app(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5])
