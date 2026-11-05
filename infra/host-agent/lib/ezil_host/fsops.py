"""No-follow, fd-relative filesystem operations on HOSTILE volume content (§3a.1).

Guest root controls every byte of the data volume. Every path below a host-supplied
root is resolved one component at a time with O_DIRECTORY|O_NOFOLLOW relative to the
parent fd; files are read only after fstat proves S_ISREG on the same inode; entries
are unlinked/renamed as entries (never followed); device nodes are never opened.
"""
import errno
import os
import stat

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC


class Refused(Exception):
    def __init__(self, code, detail=""):
        super().__init__(f"{code}{': ' + detail if detail else ''}")
        self.code = code


def open_dir_below(root, rel):
    """Open root/rel as a directory without following any symlink on the way."""
    fd = os.open(root, DIR_FLAGS)
    for comp in [c for c in rel.split("/") if c]:
        if comp in (".", ".."):
            os.close(fd)
            raise Refused("bad_path", rel)
        try:
            nfd = os.open(comp, DIR_FLAGS, dir_fd=fd)
        except OSError as e:
            os.close(fd)
            raise Refused("not_a_real_directory", f"{rel} ({comp}: {os.strerror(e.errno)})") from e
        os.close(fd)
        fd = nfd
    return fd


# Per-tab Code folder continuity (edge `folder` op; docs/contracts/code-folder-v1.vectors.json).
FOLDER_MAX_BYTES = 2048
FOLDER_MAX_SEGMENT_BYTES = 255
FOLDER_MAX_SEGMENTS = 64


def plain_rel(rel):
    """The Worker's lexical rule for a remainder below the workspace root: '' (the root itself) or
    '/'-joined segments, none empty, '.' or '..', no control character or backslash, well-formed
    UTF-8, at most 64 segments of at most 255 bytes and 2048 bytes in all. True/False only."""
    if not isinstance(rel, str):
        return False
    try:
        raw = rel.encode("utf-8", "strict")
    except UnicodeEncodeError:            # a lone surrogate
        return False
    if len(raw) > FOLDER_MAX_BYTES:
        return False
    if rel == "":
        return True
    if any(ord(c) < 0x20 or ord(c) == 0x7F or c == "\\" for c in rel):
        return False
    segs = rel.split("/")
    return len(segs) <= FOLDER_MAX_SEGMENTS and all(
        s not in ("", ".", "..") and len(s.encode("utf-8")) <= FOLDER_MAX_SEGMENT_BYTES for s in segs)


def classify_dir_below(root, rel):
    """'ok' | 'missing' | 'not_directory' | 'symlink' | 'bad_path' for root/rel. Every component
    (rel's, never root's own ancestors, which are host paths) is lstat-ed relative to its parent
    fd and opened O_DIRECTORY|O_NOFOLLOW, so no symlink is ever followed and a race that swaps a
    component for a link or a file between the lstat and the open is still refused (ELOOP/ENOTDIR).
    Nothing is created; nothing but directory metadata is read."""
    if not plain_rel(rel):
        return "bad_path"
    try:
        fd = os.open(root, DIR_FLAGS)
    except OSError as e:
        # O_DIRECTORY|O_NOFOLLOW on a link answers ENOTDIR on Linux: lstat says which it was.
        try:
            st = os.lstat(root)
        except OSError:
            return "missing"
        return "symlink" if stat.S_ISLNK(st.st_mode) else "not_directory" if e.errno in (errno.ENOTDIR, errno.ELOOP) else "missing"
    try:
        for comp in (rel.split("/") if rel else []):
            try:
                st = os.stat(comp, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                return "missing"
            except OSError as e:
                return "not_directory" if e.errno == errno.ENOTDIR else "missing"
            if stat.S_ISLNK(st.st_mode):
                return "symlink"
            if not stat.S_ISDIR(st.st_mode):
                return "not_directory"
            try:
                nfd = os.open(comp, DIR_FLAGS, dir_fd=fd)
            except OSError as e:
                # Raced between the lstat and the open: never followed either way; name what it is now.
                if e.errno == errno.ELOOP:
                    return "symlink"
                try:
                    now = os.stat(comp, dir_fd=fd, follow_symlinks=False)
                except OSError:
                    return "missing"
                return "symlink" if stat.S_ISLNK(now.st_mode) else "not_directory"
            os.close(fd)
            fd = nfd
        return "ok"
    finally:
        os.close(fd)


def read_regular_at(dfd, name, st=None, limit=None):
    try:
        st = st or os.stat(name, dir_fd=dfd, follow_symlinks=False)
    except OSError:
        return None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=dfd)
    except OSError:
        return None
    try:
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode):
            return None
        if st is not None and (fst.st_ino, fst.st_dev) != (st.st_ino, st.st_dev):
            return None
        chunks, total = [], 0
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            total += len(b)
            if limit is not None and total > limit:
                return None
            chunks.append(b)
        return b"".join(chunks)
    finally:
        os.close(fd)


def write_file_durable_at(dfd, name, data, mode=0o600):
    """temp (O_EXCL|O_NOFOLLOW) -> fsync -> rename over name -> fsync(dir)."""
    tmp = f".{name}.tmp.{os.getpid()}"
    try:
        os.unlink(tmp, dir_fd=dfd)
    except FileNotFoundError:
        pass
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, mode, dir_fd=dfd)
    try:
        pending = memoryview(data)
        while pending:
            written = os.write(fd, pending)
            if written <= 0:
                raise OSError("short durable write")
            pending = pending[written:]
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    os.fsync(dfd)


def unlink_durable_at(dfd, name):
    os.unlink(name, dir_fd=dfd)
    os.fsync(dfd)


def regular_xattrs_at(dfd, name, st):
    """Include ACLs and security/user metadata; unreadable metadata is not equality."""
    fd = None
    if not stat.S_ISREG(st.st_mode):
        return None
    try:
        fd = os.open(name, FILE_FLAGS, dir_fd=dfd)
        fst = os.fstat(fd)
        if not stat.S_ISREG(fst.st_mode) or (fst.st_dev, fst.st_ino) != (st.st_dev, st.st_ino):
            return None
        return {key: os.getxattr(fd, key) for key in os.listxattr(fd)}
    except OSError:
        return None
    finally:
        if fd is not None:
            os.close(fd)


def empty_dir_fd(fd):
    """Remove everything inside an already no-follow-opened dir. Iterative, one fd held
    per level only while descending; never follows links."""
    removed = 0
    stack = [(fd, None)]
    while stack:
        cur, _ = stack[-1]
        progressed = False
        for name in os.listdir(cur):
            st = os.stat(name, dir_fd=cur, follow_symlinks=False)
            if stat.S_ISDIR(st.st_mode):
                cfd = os.open(name, DIR_FLAGS, dir_fd=cur)
                cst = os.fstat(cfd)
                if (cst.st_ino, cst.st_dev) != (st.st_ino, st.st_dev):
                    os.close(cfd)
                    raise Refused("changed_during_clear", name)
                stack.append((cfd, name))
                progressed = True
                break
            os.unlink(name, dir_fd=cur)
            removed += 1
        if progressed:
            continue
        stack.pop()
        if stack:
            parent = stack[-1][0]
            os.close(cur)
            os.rmdir(_, dir_fd=parent)
            removed += 1
    return removed


def clear_dir(root, rel):
    fd = open_dir_below(root, rel)
    try:
        n = empty_dir_fd(fd)
        os.fsync(fd)
        return n
    finally:
        os.close(fd)


SINGLETONS = ("SingletonLock", "SingletonSocket", "SingletonCookie")


def remove_singletons(data_mount, rel="profiles/chrome"):
    """R15: clear stale Chrome Singleton* entries. Caller guarantees the lease is confirmed."""
    try:
        fd = open_dir_below(data_mount, rel)
    except Refused as e:
        if e.code == "not_a_real_directory" and "No such file" in str(e):
            return []
        raise
    gone = []
    try:
        for name in SINGLETONS:
            try:
                st = os.stat(name, dir_fd=fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            if stat.S_ISDIR(st.st_mode):
                raise Refused("singleton_is_a_directory", name)
            os.unlink(name, dir_fd=fd)
            gone.append(name)
        os.fsync(fd)
    finally:
        os.close(fd)
    return gone
