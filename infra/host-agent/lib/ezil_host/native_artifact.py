"""The pinned native runtime artifact: an operator-provided local directory, never a download.

The operator pins it in agent.json:

  "nativeRuntimePin": {"manifestSha256": "<64 hex>", "cliVersion": "2.1.310", "nodeAbi": "<digits>"}

and provides a directory whose manifest.json (canonical JSON, hashed byte for byte) is:

  {"v":1, "kind":"ezil-native-runtime", "cliVersion":"2.1.310", "nodeAbi":"<digits>",
   "supervisorProtocol":"ezil-native-supervisor-v1",
   "entrypoints":{"core":"<rel>/gatewayNativeSupervisor.mjs", "cli":"<rel>"},   (Journal beside it)
   "files":[{"path":"<rel>","sha256":"<64 hex>","size":<int>,"mode":"0644"|"0755"}, ...]}

install() copies EXACTLY the listed files (closed allowlist: nothing else from the source is read),
hashing each while copying from an O_NOFOLLOW fd whose fstat is a regular file, into a private
staging directory, then renames it to <nativeRuntimeRoot>/<manifestSha256> in one step. load()
re-verifies an installed tree. Both fail with a typed Refused: artifact_missing, artifact_invalid,
pin_mismatch. Nothing here executes the artifact; this repository vendors none of it.
"""
import hashlib
import ctypes
import errno
import json
import os
import re
import secrets
import stat
import posixpath

from .fsops import DIR_FLAGS, Refused
from .lease import strict_json

CLI_VERSION = "2.1.310"
PROTOCOL = "ezil-native-supervisor-v1"
MANIFEST = "manifest.json"
MANIFEST_KEYS = {"v", "kind", "cliVersion", "nodeAbi", "supervisorProtocol", "entrypoints", "files"}
FILE_KEYS = {"path", "sha256", "size", "mode"}
PIN_KEYS = {"manifestSha256", "cliVersion", "nodeAbi"}
SEGMENT = r"[A-Za-z0-9_][A-Za-z0-9._+-]{0,99}"
REL = re.compile(rf"{SEGMENT}(?:/{SEGMENT}){{0,15}}")
HEX64 = re.compile(r"[0-9a-f]{64}")
ABI = re.compile(r"[1-9][0-9]{0,4}")
MAX_FILES, MAX_TOTAL, MAX_MANIFEST = 20000, 2 << 30, 4 << 20
MODES = {"0644": 0o644, "0755": 0o755}


def validate_pin(pin):
    if (not isinstance(pin, dict) or set(pin) != PIN_KEYS or not isinstance(pin["manifestSha256"], str)
            or not HEX64.fullmatch(pin["manifestSha256"]) or pin["cliVersion"] != CLI_VERSION
            or not isinstance(pin["nodeAbi"], str) or not ABI.fullmatch(pin["nodeAbi"])):
        raise Refused("pin_mismatch", "pin")
    return pin


def parse_manifest(raw, pin):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_MANIFEST:
        raise Refused("artifact_invalid", "manifest size")
    if hashlib.sha256(raw).hexdigest() != pin["manifestSha256"]:
        raise Refused("pin_mismatch", "manifest digest")
    try:
        m = strict_json(raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeError, RecursionError):
        raise Refused("artifact_invalid", "manifest json")
    if (not isinstance(m, dict) or set(m) != MANIFEST_KEYS or type(m["v"]) is not int or m["v"] != 1
            or m["kind"] != "ezil-native-runtime" or m["supervisorProtocol"] != PROTOCOL):
        raise Refused("artifact_invalid", "manifest shape")
    if m["cliVersion"] != pin["cliVersion"] or m["nodeAbi"] != pin["nodeAbi"]:
        raise Refused("pin_mismatch", "runtime")
    files = m["files"]
    if not isinstance(files, list) or not 0 < len(files) <= MAX_FILES:
        raise Refused("artifact_invalid", "files")
    seen, total = {}, 0
    for f in files:
        if (not isinstance(f, dict) or set(f) != FILE_KEYS or not isinstance(f["path"], str) or not REL.fullmatch(f["path"])
                or f["path"] == MANIFEST or not isinstance(f["sha256"], str) or not HEX64.fullmatch(f["sha256"])
                or type(f["size"]) is not int or not 0 <= f["size"] <= MAX_TOTAL or f["mode"] not in MODES):
            raise Refused("artifact_invalid", "file entry")
        lowered = f["path"].lower()
        # Neither a duplicate nor a path that is also another entry's directory.
        if lowered in seen or any(lowered.startswith(p + "/") or p.startswith(lowered + "/") for p in seen):
            raise Refused("artifact_invalid", "file collision")
        seen[lowered] = f
        total += f["size"]
    if total > MAX_TOTAL:
        raise Refused("artifact_invalid", "total size")
    ep = m["entrypoints"]
    if not isinstance(ep, dict) or set(ep) != {"core", "cli"}:
        raise Refused("artifact_invalid", "entrypoints")
    cli = seen.get(ep["cli"].lower()) if isinstance(ep["cli"], str) else None
    if cli is None or cli["path"] != ep["cli"] or cli["mode"] != "0755":
        raise Refused("artifact_invalid", "cli entrypoint")
    core = ep["core"] if isinstance(ep["core"], str) else ""
    head, _, name = core.rpartition("/")
    journal = (head + "/" if head else "") + "gatewayNativeJournal.mjs"
    if name != "gatewayNativeSupervisor.mjs" or core.lower() not in seen or journal.lower() not in seen:
        raise Refused("artifact_invalid", "core entrypoint")
    descriptor = seen.get("rootfs-template.json")
    if descriptor is None or descriptor["mode"] != "0644" or descriptor["size"] > MAX_MANIFEST:
        raise Refused("native_rootfs_descriptor_missing")
    return m


def _open_below(root_fd, rel, create=False):
    """(dir fd, leaf) for rel below root_fd, every directory opened O_NOFOLLOW (created 0755 if asked)."""
    parts = rel.split("/")
    fd = os.dup(root_fd)
    try:
        for comp in parts[:-1]:
            if create:
                try:nfd=_new_directory_at(fd,comp,0o755)
                except FileExistsError:nfd=os.open(comp,DIR_FLAGS,dir_fd=fd)
            else:nfd=os.open(comp,DIR_FLAGS,dir_fd=fd)
            os.close(fd)
            fd = nfd
    except OSError:
        os.close(fd)
        raise Refused("artifact_invalid", "directory")
    return fd, parts[-1]


def _read_regular(dir_fd, leaf, limit):
    try:
        fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dir_fd)
    except FileNotFoundError:
        return None
    except OSError:
        raise Refused("artifact_invalid", "not a regular file")
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise Refused("artifact_invalid", "not a regular file")
        data = b""
        while len(data) <= limit:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                return data
            data += chunk
        raise Refused("artifact_invalid", "too large")
    finally:
        os.close(fd)


def _copy_verified(src_root, dst_root, entry):
    sdir, leaf = _open_below(src_root, entry["path"])
    try:
        try:
            sfd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=sdir)
        except OSError:
            raise Refused("artifact_invalid", "missing file")
    finally:
        os.close(sdir)
    try:
        st = os.fstat(sfd)
        if not stat.S_ISREG(st.st_mode) or st.st_size != entry["size"]:
            raise Refused("artifact_invalid", "file type or size")
        ddir, dleaf = _open_below(dst_root, entry["path"], create=True)
        try:
            dfd = os.open(dleaf, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=ddir)
        finally:
            os.close(ddir)
        h, n = hashlib.sha256(), 0
        try:
            while True:
                chunk = os.read(sfd, 1 << 20)
                if not chunk:
                    break
                n += len(chunk)
                if n > entry["size"]:
                    raise Refused("artifact_invalid", "file grew")
                h.update(chunk)
                view = memoryview(chunk)
                while view:
                    view = view[os.write(dfd, view):]
            if n != entry["size"] or h.hexdigest() != entry["sha256"]:
                raise Refused("artifact_invalid", "file digest")
            os.fchmod(dfd, MODES[entry["mode"]])
            os.fsync(dfd)
        finally:
            os.close(dfd)
    finally:
        os.close(sfd)


def install(source_dir, install_root, pin):
    """Install a verified copy. Idempotent: an existing install is re-verified, never rewritten."""
    validate_pin(pin)
    try:
        src = os.open(source_dir, DIR_FLAGS)
    except OSError:
        raise Refused("artifact_missing", "source")
    try:
        raw = _read_regular(src, MANIFEST, MAX_MANIFEST)
        if raw is None:
            raise Refused("artifact_missing", "manifest")
        manifest = parse_manifest(raw, pin)
        root = os.open(install_root, DIR_FLAGS)
        try:
            if os.path.lexists(os.path.join(install_root, pin["manifestSha256"])):
                return load(install_root, pin)
            staging = f".staging-{secrets.token_hex(8)}"
            os.mkdir(staging, 0o700, dir_fd=root)
            sfd = os.open(staging, DIR_FLAGS, dir_fd=root)
            try:
                for entry in manifest["files"]:
                    _copy_verified(src, sfd, entry)
                mfd = os.open(MANIFEST, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=sfd)
                try:
                    os.write(mfd, raw)
                    os.fsync(mfd)
                finally:
                    os.close(mfd)
                os.fchmod(sfd, 0o755)
                os.fsync(sfd)
            finally:
                os.close(sfd)
            os.rename(staging, pin["manifestSha256"], src_dir_fd=root, dst_dir_fd=root)
            os.fsync(root)
        finally:
            os.close(root)
    finally:
        os.close(src)
    return load(install_root, pin)


def load(install_root, pin):
    """Re-verify the installed tree for this pin. Returns a descriptor the manager uses verbatim."""
    validate_pin(pin)
    path = os.path.join(install_root, pin["manifestSha256"])
    try:
        root = os.open(path, DIR_FLAGS)
    except OSError:
        raise Refused("artifact_missing", "install")
    try:
        if os.fstat(root).st_uid != 0 or stat.S_IMODE(os.fstat(root).st_mode) & 0o022:
            raise Refused("artifact_invalid", "install ownership")
        raw = _read_regular(root, MANIFEST, MAX_MANIFEST)
        if raw is None:
            raise Refused("artifact_missing", "manifest")
        manifest = parse_manifest(raw, pin)
        for entry in manifest["files"]:
            d, leaf = _open_below(root, entry["path"])
            try:
                fd = os.open(leaf, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=d)
            except OSError:
                raise Refused("artifact_invalid", "missing file")
            finally:
                os.close(d)
            try:
                st = os.fstat(fd)
                if (not stat.S_ISREG(st.st_mode) or st.st_size != entry["size"] or st.st_uid != 0
                        or stat.S_IMODE(st.st_mode) != MODES[entry["mode"]]):
                    raise Refused("artifact_invalid", "installed file")
                h = hashlib.sha256()
                while True:
                    chunk = os.read(fd, 1 << 20)
                    if not chunk:
                        break
                    h.update(chunk)
                if h.hexdigest() != entry["sha256"]:
                    raise Refused("artifact_invalid", "installed digest")
            finally:
                os.close(fd)
    finally:
        os.close(root)
    descriptor = _read_descriptor(path)
    expected_descriptor = next(x["sha256"] for x in manifest["files"] if x["path"] == ROOTFS_DESCRIPTOR)
    if descriptor[1] != expected_descriptor: raise Refused("native_rootfs_descriptor_changed")
    return {"rootfsTemplate": descriptor[0], "rootfsTemplateSha256": descriptor[1],
            "dir": path, "manifestSha256": pin["manifestSha256"], "cliVersion": manifest["cliVersion"],
            "nodeAbi": manifest["nodeAbi"], "core": manifest["entrypoints"]["core"],
            "cli": manifest["entrypoints"]["cli"]}


def manifest_bytes(files, entrypoints, node_abi, cli_version=CLI_VERSION):
    """Canonical manifest bytes (for the operator's packaging step and tests)."""
    return json.dumps({"v": 1, "kind": "ezil-native-runtime", "cliVersion": cli_version, "nodeAbi": node_abi,
                       "supervisorProtocol": PROTOCOL, "entrypoints": entrypoints, "files": files},
                      separators=(",", ":"), sort_keys=True).encode()


ROOTFS_DESCRIPTOR = "rootfs-template.json"
ROOTFS_MAX_FILES = 8192
ROOTFS_MAX_BYTES = 512 << 20
ROOTFS_MAX_DEPTH = 32


def _new_directory_at(parent, name, mode):
    os.mkdir(name,0o700,dir_fd=parent)
    fd=os.open(name,DIR_FLAGS,dir_fd=parent)
    try:
        st=os.fstat(fd)
        if st.st_uid!=0 or st.st_gid!=0 or not stat.S_ISDIR(st.st_mode):raise Refused("native_rootfs_new_directory_untrusted")
        os.fchmod(fd,mode);os.fsync(fd)
        return fd
    except BaseException:
        os.close(fd);raise


def trusted_directory(path, searchable=False):
    """Root-owned canonical ancestry, no writable ancestors or symlink components."""
    if not isinstance(path, str) or not os.path.isabs(path) or os.path.normpath(path) != path:
        raise Refused("native_rootfs_path_invalid")
    fd = os.open("/", DIR_FLAGS)
    try:
        for part in path.split("/")[1:]:
            if not part: continue
            child = os.open(part, DIR_FLAGS, dir_fd=fd)
            st = os.fstat(child)
            if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o022 or (searchable and not st.st_mode & 0o001):
                os.close(child)
                raise Refused("native_rootfs_path_untrusted")
            os.close(fd); fd = child
        return fd
    except BaseException:
        os.close(fd); raise


def parse_rootfs_descriptor(raw):
    from .fsops import plain_rel
    try: value = strict_json(raw.decode("utf-8"))
    except (ValueError, UnicodeError): raise Refused("native_rootfs_descriptor_invalid")
    if (not isinstance(value, dict) or set(value) != {"v", "kind", "entries"} or value["v"] != 1
            or value["kind"] != "ezil-native-rootfs-template" or not isinstance(value["entries"], list)
            or not 0 < len(value["entries"]) <= ROOTFS_MAX_FILES):
        raise Refused("native_rootfs_descriptor_invalid")
    seen = {}; total = 0
    for entry in value["entries"]:
        if not isinstance(entry, dict): raise Refused("native_rootfs_descriptor_invalid")
        path, kind = entry.get("path"), entry.get("type")
        if not isinstance(path, str) or not path or not plain_rel(path) or len(path.split("/")) > ROOTFS_MAX_DEPTH or path in seen:
            raise Refused("native_rootfs_descriptor_invalid")
        keys = {"path", "type", "target"} if kind == "symlink" else {"path", "type", "mode"} | ({"size", "sha256"} if kind == "file" else set())
        if set(entry) != keys or kind not in ("dir", "file", "symlink"): raise Refused("native_rootfs_descriptor_invalid")
        if kind == "symlink":
            target = entry["target"]
            if not isinstance(target, str) or not target or target.startswith("/") or len(target) > 2048 or any(ord(c)<32 for c in target):
                raise Refused("native_rootfs_symlink_invalid")
            resolved = posixpath.normpath(posixpath.join(posixpath.dirname(path), target))
            if resolved == ".." or resolved.startswith("../"): raise Refused("native_rootfs_symlink_escape")
        elif type(entry["mode"]) is not int or entry["mode"] not in (0o444, 0o555, 0o644, 0o755):
            raise Refused("native_rootfs_mode_invalid")
        if kind == "dir" and entry["mode"] not in (0o555, 0o755): raise Refused("native_rootfs_mode_invalid")
        if kind == "file":
            if type(entry["size"]) is not int or entry["size"] < 0 or not isinstance(entry["sha256"], str) or not HEX64.fullmatch(entry["sha256"]):
                raise Refused("native_rootfs_descriptor_invalid")
            total += entry["size"]
        if total > ROOTFS_MAX_BYTES: raise Refused("native_rootfs_size_limit")
        seen[path] = entry
    if list(seen) != sorted(seen): raise Refused("native_rootfs_inventory_order")
    for path, entry in seen.items():
        parent = posixpath.dirname(path)
        if parent and (parent not in seen or seen[parent]["type"] != "dir"): raise Refused("native_rootfs_inventory_parent")
        if entry["type"] == "symlink":
            target = posixpath.normpath(posixpath.join(posixpath.dirname(path), entry["target"])); visited = {path}
            while target in seen and seen[target]["type"] == "symlink":
                if target in visited: raise Refused("native_rootfs_symlink_cycle")
                visited.add(target); target = posixpath.normpath(posixpath.join(posixpath.dirname(target), seen[target]["target"]))
            if target not in seen: raise Refused("native_rootfs_symlink_missing")
    return value


def rootfs_descriptor_bytes(template):
    """Trusted operator packaging helper. The resulting FILE is pinned by native artifact manifest."""
    root = trusted_directory(template); entries = []; total_bytes = 0
    def visit(fd, prefix=""):
        nonlocal total_bytes
        for name in sorted(os.listdir(fd)):
            path = prefix + name
            if len(path.split("/")) > ROOTFS_MAX_DEPTH: raise Refused("native_rootfs_depth_limit")
            st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            if st.st_uid != 0 or st.st_gid != 0: raise Refused("native_rootfs_owner_invalid")
            if stat.S_ISDIR(st.st_mode):
                item = {"path":path,"type":"dir","mode":stat.S_IMODE(st.st_mode)};entries.append(item)
                child = os.open(name, DIR_FLAGS, dir_fd=fd)
                try: visit(child,path+"/")
                finally: os.close(child)
            elif stat.S_ISREG(st.st_mode):
                total_bytes += st.st_size
                if total_bytes > ROOTFS_MAX_BYTES: raise Refused("native_rootfs_size_limit")
                if st.st_nlink != 1: raise Refused("native_rootfs_hardlink_refused")
                f = os.open(name, os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC, dir_fd=fd);digest=hashlib.sha256()
                try:
                    while True:
                        chunk=os.read(f,1<<20)
                        if not chunk: break
                        digest.update(chunk)
                    after=os.fstat(f)
                    if (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(st.st_dev,st.st_ino,st.st_size,st.st_mtime_ns): raise Refused("native_rootfs_changed")
                finally: os.close(f)
                entries.append({"path":path,"type":"file","mode":stat.S_IMODE(st.st_mode),"size":st.st_size,"sha256":digest.hexdigest()})
            elif stat.S_ISLNK(st.st_mode): entries.append({"path":path,"type":"symlink","target":os.readlink(name,dir_fd=fd)})
            else: raise Refused("native_rootfs_special_file")
            if len(entries)>ROOTFS_MAX_FILES or len(path.split('/'))>ROOTFS_MAX_DEPTH: raise Refused("native_rootfs_inventory_limit")
    try: visit(root)
    finally: os.close(root)
    value={"v":1,"kind":"ezil-native-rootfs-template","entries":sorted(entries,key=lambda x:x["path"])}
    raw=json.dumps(value,sort_keys=True,separators=(",",":"),ensure_ascii=False).encode();parse_rootfs_descriptor(raw)
    if len(raw)>MAX_MANIFEST:raise Refused("native_rootfs_descriptor_size")
    return raw


def _read_descriptor(installed):
    fd=os.open(installed,DIR_FLAGS)
    try: raw=_read_regular(fd,ROOTFS_DESCRIPTOR,MAX_MANIFEST)
    finally: os.close(fd)
    if raw is None: raise Refused("native_rootfs_descriptor_missing")
    return parse_rootfs_descriptor(raw),hashlib.sha256(raw).hexdigest()


def prepare_rootfs(template, artifact, bundle, mountpoints):
    """Root-only bounded private COPY; never mutates or aliases the trusted template."""
    from .fsops import open_dir_below, empty_dir_fd, plain_rel
    descriptor=artifact.get("rootfsTemplate");expected=artifact.get("rootfsTemplateSha256")
    if descriptor is None or not isinstance(expected,str): raise Refused("native_rootfs_descriptor_missing")
    actual=rootfs_descriptor_bytes(template)
    if hashlib.sha256(actual).hexdigest()!=expected: raise Refused("native_rootfs_template_mismatch")
    if parse_rootfs_descriptor(actual)!=descriptor: raise Refused("native_rootfs_template_mismatch")
    parent=trusted_directory(bundle);source=trusted_directory(template);destination=None
    try:
        destination=_new_directory_at(parent,"rootfs",0o755)
        for entry in descriptor["entries"]:
            path=entry["path"];parts=path.rsplit("/",1);rel=parts[0] if len(parts)==2 else "";leaf=parts[-1]
            sfd=open_dir_below(template,rel);dfd=open_dir_below(os.path.join(bundle,"rootfs"),rel)
            try:
                before=os.stat(leaf,dir_fd=sfd,follow_symlinks=False)
                if before.st_uid!=0 or before.st_gid!=0: raise Refused("native_rootfs_owner_invalid")
                if entry["type"]=="dir":
                    if not stat.S_ISDIR(before.st_mode) or stat.S_IMODE(before.st_mode)!=entry["mode"]: raise Refused("native_rootfs_changed")
                    fresh=_new_directory_at(dfd,leaf,0o755);os.close(fresh)
                elif entry["type"]=="symlink":
                    if not stat.S_ISLNK(before.st_mode) or os.readlink(leaf,dir_fd=sfd)!=entry["target"]: raise Refused("native_rootfs_changed")
                    os.symlink(entry["target"],leaf,dir_fd=dfd)
                else:
                    if not stat.S_ISREG(before.st_mode) or before.st_nlink!=1 or before.st_size!=entry["size"] or stat.S_IMODE(before.st_mode)!=entry["mode"]: raise Refused("native_rootfs_changed")
                    sf=os.open(leaf,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=sfd);df=os.open(leaf,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW|os.O_CLOEXEC,entry["mode"],dir_fd=dfd)
                    try:
                        digest=hashlib.sha256();count=0
                        while True:
                            chunk=os.read(sf,1<<20)
                            if not chunk: break
                            count+=len(chunk)
                            if count>entry["size"]: raise Refused("native_rootfs_changed")
                            digest.update(chunk);pending=memoryview(chunk)
                            while pending: pending=pending[os.write(df,pending):]
                        after=os.fstat(sf)
                        if count!=entry["size"] or digest.hexdigest()!=entry["sha256"] or (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns)!=(before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns): raise Refused("native_rootfs_changed")
                        os.fchmod(df,entry["mode"]);os.fsync(df)
                    finally:os.close(sf);os.close(df)
                after=os.stat(leaf,dir_fd=sfd,follow_symlinks=False)
                if (after.st_dev,after.st_ino,after.st_mtime_ns)!=(before.st_dev,before.st_ino,before.st_mtime_ns): raise Refused("native_rootfs_changed")
            finally:os.close(sfd);os.close(dfd)
        closed=["/proc","/dev","/tmp","/sys",*mountpoints]
        if len(closed)!=len(set(closed)) or len(closed)>9: raise Refused("native_rootfs_mountpoints_invalid")
        for target in closed:
            if not isinstance(target,str) or not target.startswith("/") or os.path.normpath(target)!=target or not plain_rel(target[1:]) or not target[1:]: raise Refused("native_rootfs_mountpoints_invalid")
            fd=os.dup(destination)
            try:
                for part in target[1:].split("/"):
                    try:child=_new_directory_at(fd,part,0o755)
                    except FileExistsError:child=os.open(part,DIR_FLAGS,dir_fd=fd)
                    st=os.fstat(child)
                    if st.st_uid!=0 or stat.S_IMODE(st.st_mode)&0o022:os.close(child);raise Refused("native_rootfs_mountpoint_untrusted")
                    os.close(fd);fd=child
            finally:os.close(fd)
        for entry in reversed(descriptor["entries"]):
            if entry["type"]=="dir":
                fd=open_dir_below(os.path.join(bundle,"rootfs"),entry["path"])
                try:os.fchmod(fd,entry["mode"])
                finally:os.close(fd)
        os.fsync(destination)
        return {"path":os.path.join(bundle,"rootfs"),"templateSha256":expected,"files":len(descriptor["entries"]),"bytes":sum(x.get("size",0) for x in descriptor["entries"]),"mountpoints":closed}
    except BaseException:
        if destination is not None: empty_dir_fd(destination)
        raise
    finally:
        if destination is not None:os.close(destination)
        os.close(source);os.close(parent)


def private_rootfs_container(work_root, key):
    if not isinstance(key,str) or not re.fullmatch(r"[0-9a-f]{16}",key):raise Refused("native_rootfs_key_invalid")
    if not os.path.isabs(work_root) or os.path.normpath(work_root)!=work_root:raise Refused("native_rootfs_path_invalid")
    parent,name=os.path.split(work_root);fd=trusted_directory(parent,searchable=True)
    staging="."+name+".new-"+secrets.token_hex(8)
    try:
        # Publish only an already0711 directory. Concurrent creators cannot observe a final0700
        # work root, and RENAME_NOREPLACE never replaces/normalizes an existing unsafe directory.
        fresh=_new_directory_at(fd,staging,0o711);os.close(fresh)
        libc=ctypes.CDLL(None,use_errno=True)
        try:rename=libc.renameat2
        except AttributeError:raise Refused("native_rootfs_atomic_publish_unavailable")
        rename.argtypes=[ctypes.c_int,ctypes.c_char_p,ctypes.c_int,ctypes.c_char_p,ctypes.c_uint];rename.restype=ctypes.c_int
        if rename(fd,os.fsencode(staging),fd,os.fsencode(name),1)!=0:
            error=ctypes.get_errno()
            if error!=errno.EEXIST:raise OSError(error,os.strerror(error))
        root=os.open(name,DIR_FLAGS,dir_fd=fd)
        try:
            st=os.fstat(root)
            if st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=0o711:raise Refused("native_rootfs_work_root_untrusted")
            fresh=_new_directory_at(root,key,0o711);os.close(fresh)
        finally:os.close(root)
    finally:
        try:os.rmdir(staging,dir_fd=fd)
        except FileNotFoundError:pass
        os.close(fd)
    return os.path.join(work_root,key)
