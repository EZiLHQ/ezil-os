"""One trusted, short-lived assignment repo-open notification inside the computer."""
import ctypes
import errno
import hashlib
import hmac
import http.client
import json
import os
import secrets
import stat
import subprocess
import sys
import threading
from contextlib import ExitStack
from http.server import BaseHTTPRequestHandler, HTTPServer

HOST = "127.0.0.1"
PORT = 5679
PATH = "/internal/assignment/preload"
ACK = "ezil-assignment-preload:ack"
MAX_MARKER = 4096
MARKER_KEYS = {"schema", "recorder", "repositoryUrl", "consentVersion", "notice", "preload"}
DECLARATION = {
    "protocol": "ezil.assignment-open/v1", "trigger": "repo-open", "host": HOST, "port": PORT,
}
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK


def read_regular(parent, name, limit):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o111 or info.st_size > limit:
            raise ValueError("invalid file")
        data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("invalid size")
        return data


def terminal_settings(checkout):
    # Only the platform wrapper gets settings. A repository cannot supply a terminal profile, task or executable.
    return (json.dumps({"terminal.integrated.cwd": checkout,
                        "terminal.integrated.splitCwd": "initial"}, sort_keys=True, separators=(",", ":")) + "\n").encode()


def bind_terminal(wrapper_fd, projects_fd, checkout):
    expected = terminal_settings(checkout)

    def verify():
        fd = os.open(".vscode", DIR_FLAGS, dir_fd=wrapper_fd)
        try:
            return (set(os.listdir(fd)) == {"settings.json"} and
                    read_regular(fd, "settings.json", 2048) == expected)
        finally:
            os.close(fd)

    try:
        return verify()
    except FileNotFoundError:
        pass
    # Assemble on the same filesystem. Publish the complete directory with NOREPLACE, preserving any existing files.
    name = ".assignment-settings-" + secrets.token_hex(16)
    os.mkdir(name, 0o700, dir_fd=projects_fd)
    fd = os.open(name, DIR_FLAGS, dir_fd=projects_fd)
    try:
        output = os.open("settings.json", os.O_WRONLY | os.O_EXCL | os.O_CREAT | os.O_NOFOLLOW, 0o444, dir_fd=fd)
        with os.fdopen(output, "wb") as handle:
            handle.write(expected)
        rename = ctypes.CDLL(None, use_errno=True).renameat2
        if rename(projects_fd, os.fsencode(name), wrapper_fd, b".vscode", 1) == 0:
            return True
        if ctypes.get_errno() != errno.EEXIST:
            return False
        return verify()
    finally:
        os.close(fd)
        try:
            temporary = os.open(name, DIR_FLAGS, dir_fd=projects_fd)
        except FileNotFoundError:
            temporary = None
        if temporary is not None:
            try:
                os.unlink("settings.json", dir_fd=temporary)
            finally:
                os.close(temporary)
            os.rmdir(name, dir_fd=projects_fd)


def checked_marker(path, witness):
    parts = path.split("/")
    basename = f'u-{witness["ownerSha256"][:16]}-a-{witness["attemptId"]}'
    if witness["canonicalURL"] != f"https://github.ezil.work/default/{basename}.git":
        return False
    if (not path.startswith("/") or any(part in ("", ".", "..") for part in parts[1:])
            or parts[-3:] != ["projects", witness["repositoryId"], basename]):
        return False

    with ExitStack() as stack:
        def directory(name, parent=None):
            fd = os.open(name, DIR_FLAGS, dir_fd=parent)
            stack.callback(os.close, fd)
            return fd

        root = directory("/")
        for part in parts[1:-3]:
            root = directory(part, root)
        projects = directory(parts[-3], root)
        wrapper = directory(parts[-2], projects)
        root = directory(parts[-1], wrapper)

        git = directory(".git", root)
        head = read_regular(git, "HEAD", 128)
        if head != ("ref: " + witness["ref"] + "\n").encode("ascii"):
            return False

        raw = read_regular(directory(".ezil", root), "assignment.json", MAX_MARKER)
        if not hmac.compare_digest(hashlib.sha256(raw).hexdigest(), witness["manifestSha256"]):
            return False
        # Confirm HEAD actually tracks these bytes as a normal 100644 Git blob.
        # The fixed read-only plumbing command does not run hooks or fetch.
        blob = hashlib.sha1(f"blob {len(raw)}\0".encode("ascii") + raw).hexdigest()
        listed = subprocess.run(
            ["/usr/bin/git", "--no-pager", "--no-optional-locks", f"--git-dir=/proc/self/fd/{git}",
             "ls-tree", "--full-tree", witness["ref"], "--", ".ezil/assignment.json"],
            env={"PATH": "/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                 "GIT_NO_REPLACE_OBJECTS": "1", "GIT_NO_LAZY_FETCH": "1", "GIT_ALLOW_PROTOCOL": "",
                 "GIT_TERMINAL_PROMPT": "0"},
            pass_fds=(git,), stdin=subprocess.DEVNULL, capture_output=True, timeout=0.5,
        )
        if (listed.returncode != 0
                or listed.stdout != f"100644 blob {blob}\t.ezil/assignment.json\n".encode("ascii")):
            return False

        marker = json.loads(raw)
        return (isinstance(marker, dict) and marker.keys() == MARKER_KEYS
                and marker["schema"] == "ezil.assignment/v2"
                and marker["recorder"] == "assignment-recorder-v1"
                and marker["repositoryUrl"] == witness["canonicalURL"]
                and marker["consentVersion"] == 3
                and isinstance(marker["notice"], str) and bool(marker["notice"])
                and marker["preload"] == DECLARATION and bind_terminal(wrapper, projects, path))


class PrivateListener(HTTPServer):
    # Reuse the closed socket across retries without sharing any active listener.
    allow_reuse_address = True
    allow_reuse_port = False

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(0.25)
        return connection, address

    def handle_error(self, _request, _address):
        pass


def notify(witness):
    body = json.dumps(witness, separators=(",", ":")).encode()
    key = secrets.token_bytes(32)
    mac = hmac.digest(key, b"POST " + PATH.encode("ascii") + b"\n" + body, "sha256").hex()
    accepted = threading.Event()

    class PreloadHandler(BaseHTTPRequestHandler):
        def log_message(self, _format, *_args):
            pass

        def do_POST(self):
            lengths = self.headers.get_all("Content-Length", [])
            signatures = self.headers.get_all("X-EZiL-Preload-MAC", [])
            if (self.path != PATH or self.headers.get("Transfer-Encoding") is not None
                    or lengths != [str(len(body))] or len(signatures) != 1
                    or not hmac.compare_digest(signatures[0].encode("iso-8859-1"), mac.encode("ascii"))):
                self.send_response_only(404)
                self.end_headers()
                return
            received = self.rfile.read(len(body))
            if not hmac.compare_digest(received, body) or accepted.is_set():
                self.send_response_only(404)
                self.end_headers()
                return
            accepted.set()
            self.send_response_only(204)
            self.end_headers()

    # Bind first. If another process owns the port, never send a request to it.
    with PrivateListener((HOST, PORT), PreloadHandler) as listener:
        server = threading.Thread(target=listener.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        server.start()
        conn = http.client.HTTPConnection(HOST, PORT, timeout=0.45)
        try:
            conn.request("POST", PATH, body=body, headers={"X-EZiL-Preload-MAC": mac})
            with conn.getresponse() as response:
                return response.status == 204 and response.read() == b"" and accepted.is_set()
        finally:
            conn.close()
            listener.shutdown()
            server.join()


def main():
    try:
        folder, witness = sys.argv[1:]
        witness = json.loads(witness)
        if checked_marker(folder, witness) and notify(witness):
            print(ACK)
            return 0
    except (OSError, ValueError, TypeError, KeyError, http.client.HTTPException, subprocess.SubprocessError):
        # No input, marker bytes, nonce or endpoint details in terminal output.
        pass
    return 1


if __name__ == "__main__":
    sys.exit(main())
