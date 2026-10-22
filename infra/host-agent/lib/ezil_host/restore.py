"""Bounded Cloudflare PAX-tar restore; all volume writes are fd-relative.

System heads use archiveSha256 for bytes (sha256 is a logical fingerprint),
with one extra .ezil-deleted.json member not counted in entries. Deletions and
image-relative system state are deliberately not replayed across images.
"""
from contextlib import contextmanager
import hashlib
import json
import os
import posixpath
import re
import stat
import tarfile
import time
import urllib.parse

from . import http
from .fsops import DIR_FLAGS, Refused, empty_dir_fd, read_regular_at, write_file_durable_at

STATE = ".ezil-restore-state.json"
STAGE = ".ezil-restore-stage"
CHUNK = 1024 * 1024
MAX_CHUNKS = 512
MAX_ENTRIES = 100000
HASH = re.compile(r"[a-f0-9]{64}")
GENERATION = re.compile(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")


def refuse(code):
    raise Refused("restore_" + code)


def _head(h):
    if not isinstance(h, dict) or type(h.get("version")) is not int or h["version"] != 1:
        refuse("head_invalid")
    for key, pattern in (("generation", GENERATION), ("sha256", HASH),
                         ("chunkGeneration", GENERATION), ("archiveSha256", HASH)):
        if key not in h and key in ("chunkGeneration", "archiveSha256"):
            continue
        if not isinstance(h.get(key), str) or not pattern.fullmatch(h[key]):
            refuse("head_invalid")
    if type(h.get("entries")) is not int or not 0 <= h["entries"] <= MAX_ENTRIES:
        refuse("head_invalid")
    chunks = h.get("chunks")
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS:
        refuse("head_invalid")
    for c in chunks:
        if (not isinstance(c, dict) or type(c.get("size")) is not int
                or not 0 < c["size"] <= CHUNK or not isinstance(c.get("sha256"), str)
                or not HASH.fullmatch(c["sha256"])):
            refuse("head_invalid")


def identity(spec):
    if not isinstance(spec, dict) or spec.get("kind") != "cf-snapshot":
        refuse("kind_invalid")
    _head(spec.get("workspace"))
    system = spec.get("system")
    if system is not None:
        _head(system)
    return {"generation": spec["workspace"]["generation"],
            "systemGeneration": system["generation"] if system else None,
            "workspaceSha256": spec["workspace"]["sha256"],
            "systemSha256": system["sha256"] if system else None,
            "systemArchiveSha256": system.get("archiveSha256", system["sha256"]) if system else None}


def read_state(root):
    try:
        st = os.stat(STATE, dir_fd=root, follow_symlinks=False)
    except FileNotFoundError:
        return None
    raw = read_regular_at(root, STATE, st, limit=65536)
    try:
        state = json.loads(raw) if raw is not None else None
    except ValueError:
        state = None
    if not isinstance(state, dict) or state.get("state") not in ("started", "done", "failed"):
        refuse("state_invalid")
    return state


def matches(state, spec):
    expected = identity(spec)
    return state is not None and all(state.get(k) == v for k, v in expected.items())


@contextmanager
def directory(root, parts, create=False):
    fd = os.dup(root)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part, 0o755, dir_fd=fd)
                    os.fsync(fd)
                except FileExistsError:
                    pass
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)


def _parts(name):
    if (not isinstance(name, str) or not name or name.startswith("/")
            or "\\" in name or "\0" in name
            or any(p in ("", ".", "..") for p in name.split("/"))):
        refuse("path_invalid")
    return name.split("/")


def _cache(parts):
    return (".cache" in parts or any(parts[i:i + 2] in
            ([".npm", "_cacache"], ["node_modules", ".cache"])
            for i in range(len(parts))) or any(parts[i:i + 3] == [".local", "share", "Trash"]
                                               for i in range(len(parts))))


def _link(name, target):
    if not target or target.startswith("/") or "\\" in target or "\0" in target:
        refuse("symlink_escape")
    resolved = posixpath.normpath(posixpath.join(posixpath.dirname(name), target))
    if resolved == ".." or resolved.startswith("../"):
        refuse("symlink_escape")


def _check_link(root, name, target, links):
    """Resolve archive AND pre-existing links, including '..' after a link."""
    pending = name.split("/")[:-1] + target.split("/")
    resolved, hops = [], 0
    while pending:
        comp, pending = pending[0], pending[1:]
        if comp in ("", "."):
            continue
        if comp == "..":
            if not resolved:
                refuse("symlink_escape")
            resolved.pop()
            continue
        path = "/".join(resolved + [comp])
        link = links.get(path)
        if link is None:
            try:
                with directory(root, resolved) as fd:
                    st = os.stat(comp, dir_fd=fd, follow_symlinks=False)
                    if stat.S_ISLNK(st.st_mode):
                        link = os.readlink(comp, dir_fd=fd)
            except FileNotFoundError:
                pass
        if link is not None:
            _link(path, link)
            hops += 1
            if hops > 40:
                refuse("symlink_cycle")
            pending = link.split("/") + pending
        else:
            resolved.append(comp)


def _download(stage, kind, head, fetch):
    fd = os.open(kind + ".tar", os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=stage)
    out = os.fdopen(fd, "w+b")
    try:
        digest = hashlib.sha256()
        for i, chunk in enumerate(head["chunks"]):
            data = fetch(kind, i)
            if not isinstance(data, bytes) or len(data) != chunk["size"]:
                refuse("chunk_size")
            if hashlib.sha256(data).hexdigest() != chunk["sha256"]:
                refuse("chunk_sha256")
            out.write(data)
            digest.update(data)
        expected = head.get("archiveSha256", head["sha256"]) if kind == "system" else head["sha256"]
        if digest.hexdigest() != expected:
            refuse("archive_sha256")
        out.flush()
        os.fsync(out.fileno())
        out.seek(0)
        return out
    except BaseException:
        out.close()
        raise


def _extract(archive, head, kind, root, stage):
    files, size = 0, 0
    with tarfile.open(fileobj=archive, mode="r:", encoding="utf-8", errors="surrogateescape") as tar:
        seen, selected, count, total = {}, [], 0, 0
        for m in tar:
            parts = _parts(m.name)
            if m.name in seen:
                refuse("duplicate_path")
            seen[m.name] = m
            if not (m.type in (tarfile.REGTYPE, tarfile.AREGTYPE, tarfile.DIRTYPE, tarfile.SYMTYPE)) or m.sparse is not None:
                refuse("entry_type")
            if m.mode < 0 or m.mode & ~0o1777 or m.size < 0 or (not m.isfile() and m.size):
                refuse("entry_metadata")
            total += m.size
            if total > MAX_CHUNKS * CHUNK:
                refuse("byte_limit")
            deletion = kind == "system" and m.name == ".ezil-deleted.json" and m.isfile()
            if not deletion:
                count += 1
            if count > head["entries"] or len(seen) > MAX_ENTRIES + 1:
                refuse("entry_count")
            if kind == "system" and (parts[0] not in ("root", "home") or _cache(parts)):
                continue
            if m.issym():
                _link(m.name, m.linkname)
            selected.append(m)
        if count != head["entries"]:
            refuse("entry_count")
        for m in selected:
            parts = m.name.split("/")
            for i in range(1, len(parts)):
                parent = seen.get("/".join(parts[:i]))
                if parent is not None and not parent.isdir():
                    refuse("non_directory_parent")
                if kind == "workspace" and parent is None:
                    refuse("missing_parent")
        base = ["workspace"] if kind == "workspace" else ["root", "upper"]
        with directory(root, base, create=True) as dest:
            links = {m.name: m.linkname for m in selected if m.issym()}
            for name, target in links.items():
                _check_link(dest, name, target, links)
            for m in sorted(selected, key=lambda m: (not m.isdir(), m.name.count("/"))):
                parts = m.name.split("/")
                with directory(dest, parts[:-1], create=True) as parent:
                    if m.isdir():
                        with directory(parent, parts[-1:], create=True):
                            pass
                    elif m.issym():
                        try:
                            os.symlink(m.linkname, parts[-1], dir_fd=parent)
                        except FileExistsError:
                            if os.readlink(parts[-1], dir_fd=parent) != m.linkname:
                                refuse("destination_conflict")
                        files += 1
                    else:
                        try:
                            st = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
                        except FileNotFoundError:
                            st = None
                        if st is not None and not stat.S_ISREG(st.st_mode):
                            refuse("destination_conflict")
                        # Atomic replacement avoids truncating a planted hardlink or
                        # a previously restored file if this attempt is interrupted.
                        fd = os.open("file", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                     0o600, dir_fd=stage)
                        with os.fdopen(fd, "wb") as out, tar.extractfile(m) as src:
                            remaining = m.size
                            while remaining:
                                data = src.read(min(CHUNK, remaining))
                                if not data:
                                    refuse("truncated_file")
                                out.write(data)
                                remaining -= len(data)
                            out.flush()
                            os.fchmod(out.fileno(), m.mode & 0o777)
                            os.fsync(out.fileno())
                        os.rename("file", parts[-1], src_dir_fd=stage, dst_dir_fd=parent)
                        files += 1
                        size += m.size
                    os.fsync(parent)
            for m in sorted((m for m in selected if m.isdir()), key=lambda m: -m.name.count("/")):
                with directory(dest, m.name.split("/")) as fd:
                    os.fchmod(fd, m.mode & 0o777)
                    os.fsync(fd)
    return files, size


def run_restore(lease_restore, data_mount, fetch):
    expected = identity(lease_restore)
    try:
        root = os.open(data_mount, DIR_FLAGS)
        try:
            return _run_restore(lease_restore, expected, root, fetch)
        finally:
            os.close(root)
    except Refused:
        raise
    except Exception:
        raise Refused("restore_io_failed") from None


def _run_restore(spec, expected, root, fetch):
    state = read_state(root)
    if state is not None:
        if not matches(state, spec):
            refuse("state_mismatch")
        if state["state"] == "done":
            return {"files": 0, "bytes": 0}
    write_file_durable_at(root, STATE, json.dumps(dict(expected, state="started")).encode())
    with directory(root, [STAGE], create=True) as stage:
        empty_dir_fd(stage)  # only our staging; never wipe workspace or HOME
        files, size = 0, 0
        for kind in ("workspace", "system"):
            head = spec.get(kind)
            if head is None:
                continue
            with _download(stage, kind, head, fetch) as archive:
                n, b = _extract(archive, head, kind, root, stage)
                files += n
                size += b
        empty_dir_fd(stage)
        os.fsync(stage)
    os.rmdir(STAGE, dir_fd=root)
    write_file_durable_at(root, STATE, json.dumps(dict(expected, state="done")).encode())
    return {"files": files, "bytes": size}


class SnapshotClient:
    """Adapter for a control-plane supplied per-epoch bearer identity token.

    IMDS session tokens and Cloudflare tunnel tokens are NOT export credentials.
    The current enrollment protocol does not issue this token; missing provisioning
    fails closed until the control plane supplies restore.identityToken.
    """
    def __init__(self, cfg, lease):
        self.cfg, self.lease = cfg, lease
        self.token = lease["restore"].get("identityToken")

    def get(self, path, token, response_limit=CHUNK + 1):
        return http.request("GET", path, headers={"Authorization": "Bearer " + token},
                            timeout=20, ca_file=self.cfg.get("caFile"),
                            server_name=self.cfg.get("tlsServerName"), response_limit=response_limit)


def http_fetch(cfg, lease_client):
    """Return fetch(kind, index); four attempts, only 5xx/timeouts retried."""
    spec = lease_client.lease["restore"]
    if not isinstance(spec, dict) or spec.get("kind") != "cf-snapshot":
        refuse("kind_invalid")
    base = spec.get("fetchBase", "")
    try:
        url = urllib.parse.urlsplit(base)
        valid = (url.scheme == "https" and url.hostname and not url.username and not url.password
                 and not url.query and not url.fragment and not any(ord(c) <= 32 for c in base))
        url.port
    except ValueError:
        valid = False
    if not valid:
        refuse("fetch_url")

    def request(path, limit=CHUNK + 1):
        token = lease_client.token
        if not isinstance(token, str) or not token or any(ord(c) < 32 or ord(c) == 127 for c in token):
            refuse("identity_token_missing")
        for attempt in range(4):
            try:
                status, data = lease_client.get(path, token, response_limit=limit)
            except TimeoutError:
                pass
            except Exception:
                refuse("fetch_transport")
            else:
                if status == 200:
                    if not isinstance(data, bytes) or len(data) > limit:
                        refuse("fetch_size")
                    return data
                if not 500 <= status <= 599:
                    refuse("fetch_status")
            if attempt < 3:
                time.sleep(2 ** attempt)
        refuse("fetch_exhausted")

    if spec.get("workspace") is None:
        generation = spec.get("generation")
        if not isinstance(generation, str) or not GENERATION.fullmatch(generation):
            refuse("generation_invalid")
        if type(spec.get("system")) is not bool:
            refuse("head_invalid")
        heads = {"system": None}
        for kind in ("workspace", "system") if spec["system"] else ("workspace",):
            path = base.rstrip("/") + f"/{kind}/head?generation=" + generation
            raw = request(path, CHUNK)
            try:
                h = json.loads(raw)
            except (ValueError, UnicodeError):
                refuse("head_invalid")
            _head(h)
            if h["generation"] != generation:
                refuse("generation_mismatch")
            heads[kind] = h
        # Publish only after every head validates. guard.run_guard passes this same
        # object to run_restore, retaining all existing archive and state checks.
        spec.update(heads)
    identity(spec)

    def fetch(kind, index):
        if kind not in ("workspace", "system") or spec.get(kind) is None:
            refuse("fetch_kind")
        head = spec[kind]
        if type(index) is not int or not 0 <= index < len(head["chunks"]):
            refuse("fetch_index")
        # The export endpoint fences the HEAD generation; it resolves chunkGeneration.
        path = base.rstrip("/") + f"/{kind}/chunk/{index}?generation=" + head["generation"]
        return request(path)
    return fetch
