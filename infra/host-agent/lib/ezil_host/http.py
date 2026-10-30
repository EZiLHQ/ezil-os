"""Minimal HTTP(S) client (stdlib only). Production: http:// (IMDS) and https:// (app).
`unix:///path/to.sock` and `https+unix:///path/to.sock/<path>` exist so tests can bind
stub servers to unix sockets — never to a public port. TLS is always verified
(system trust store, or cfg.caFile)."""
import http.client
import socket
import ssl
import urllib.parse


class _UnixHTTP(http.client.HTTPConnection):
    def __init__(self, sock_path, timeout):
        super().__init__("localhost", timeout=timeout)
        self.sock_path = sock_path

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.sock_path)
        self.sock = s


class _UnixHTTPS(http.client.HTTPSConnection):
    def __init__(self, sock_path, server_name, context, timeout):
        super().__init__(server_name, timeout=timeout, context=context)
        self.sock_path, self.server_name, self.ctx = sock_path, server_name, context

    def connect(self):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(self.timeout)
        s.connect(self.sock_path)
        self.sock = self.ctx.wrap_socket(s, server_hostname=self.server_name)


def _split_unix(path):
    # /a/b/x.sock/latest/api/token -> ('/a/b/x.sock', '/latest/api/token')
    i = path.find(".sock")
    if i < 0:
        raise ValueError("unix url must name a *.sock path")
    return path[: i + 5], path[i + 5:] or "/"


def tls_context(ca_file=None):
    ctx = ssl.create_default_context(cafile=ca_file) if ca_file else ssl.create_default_context()
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    return ctx


def request(method, url, body=None, headers=None, timeout=10, ca_file=None, server_name=None,
            response_limit=1 << 20):
    u = urllib.parse.urlsplit(url)
    headers = dict(headers or {})
    if u.scheme == "http":
        conn, path = http.client.HTTPConnection(u.hostname, u.port or 80, timeout=timeout), u.path
    elif u.scheme == "https":
        conn = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout, context=tls_context(ca_file))
        path = u.path
    elif u.scheme == "unix":
        sock, path = _split_unix(u.path)
        conn = _UnixHTTP(sock, timeout)
    elif u.scheme == "https+unix":
        sock, path = _split_unix(u.path)
        if not server_name:
            raise ValueError("https+unix needs a TLS server name")
        conn = _UnixHTTPS(sock, server_name, tls_context(ca_file), timeout)
    else:
        raise ValueError(f"unsupported url scheme: {u.scheme}")
    if u.query:
        path += "?" + u.query
    try:
        conn.request(method, path, body=body, headers=headers)
        r = conn.getresponse()
        return r.status, r.read(response_limit)
    finally:
        conn.close()
