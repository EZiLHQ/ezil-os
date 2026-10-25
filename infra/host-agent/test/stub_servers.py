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


class PoolApp:
    """In-process variant for pool unit tests: same strict field and nonce checks
    as the socket stub, without opening a network socket or logging identities.
    """

    def __init__(self, pool_lease, identity, claim, answer, empty_polls=2):
        self.pool, self.identity, self.claim, self.answer = pool_lease, identity, claim, answer
        self.empty_polls = empty_polls
        self.calls = []
        self.enrolled = False

    def request(self, method, url, *, body=None, headers=None, **kwargs):
        path = url.split("/api/compute/aws/", 1)[1]
        self.calls.append((method, path))
        payload = json.loads(body) if body is not None else None
        if path.startswith("pool/"):
            assert base64.b64decode(headers["X-Ezil-Identity-Document"]).decode() == self.identity["document"]
            assert headers["X-Ezil-Identity-Signature"] == "".join(self.identity["signature"].split())
            assert headers["X-Ezil-Pool-Host-Id"] == self.pool["poolHostId"]
            assert headers["X-Ezil-Pool-Generation"] == str(self.pool["poolGeneration"])
        if path == "pool/enroll":
            assert method == "POST"
            assert payload == {"poolHostId": self.pool["poolHostId"], "poolGeneration": self.pool["poolGeneration"],
                               "identityDocument": self.identity["document"], "signature": self.identity["signature"]}
            return 200, b"{}"
        if path == "pool/ready":
            assert method == "POST"
            assert payload == {"poolHostId": self.pool["poolHostId"], "health": {"editorOk": True}}
            return 200, b"{}"
        if path == "pool/claim":
            assert method == "GET" and body is None
            if self.empty_polls:
                self.empty_polls -= 1
                return 204, b""
            return 200, json.dumps(self.claim).encode()
        assert path == "enroll" and method == "POST"
        assert set(payload) == {"computerId", "generation", "leaseEpoch", "nonce", "identityDocument",
                                "signature", "lowerImageDigest"}
        for k in ("computerId", "generation", "leaseEpoch"):
            assert payload[k] == self.claim[k]
        assert payload["nonce"] == self.claim["enrollNonce"]
        assert payload["identityDocument"] == self.identity["document"]
        assert payload["signature"] == self.identity["signature"]
        self.enrolled = True
        return 200, self.answer  # exact replay returns the same durable credentials


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
            with open(os.path.join(d, "user-data")) as f:
                delivered = json.load(f)
            maintenance = delivered.get("ebsRestore")
            keys = {"computerId", "generation", "leaseEpoch", "nonce", "identityDocument", "signature", "lowerImageDigest"}
            if maintenance is not None:
                keys.add("ebsRestore")
                receipt = {k: maintenance[k] for k in ("v", "recoveryJobId", "snapshotId", "originalVolumeId", "volumeId", "fsUuid")}
                if b.get("ebsRestore") != receipt or b.get("lowerImageDigest") != maintenance["fromDigest"]:
                    return self._send(403, {"error": "maintenance_mismatch"})
            if set(b) != keys:
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
