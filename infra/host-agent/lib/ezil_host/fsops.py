"""No-follow, fd-relative filesystem operations on HOSTILE volume content (§3a.1).

Guest root controls every byte of the data volume. Every path below a host-supplied
root is resolved one component at a time with O_DIRECTORY|O_NOFOLLOW relative to the
parent fd; files are read only after fstat proves S_ISREG on the same inode; entries
are unlinked/renamed as entries (never followed); device nodes are never opened.
"""
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


def read_regular_at(dfd, name, st=None, limit=None):
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
        os.write(fd, data)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
    os.fsync(dfd)


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
