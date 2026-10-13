"""R4 in-place image rebase of the overlay upper (§3a.1, §3a.5, §3a.8).

Runs on the host with the desktop stopped and the overlay unmounted, inside the guard,
only when the lease carries a pre-rebase SNAPSHOT RECEIPT (lease.rebase) from the
control plane. Contract:

  * no receipt -> the guard refuses (lower_digest_mismatch); nothing is touched;
  * a durable state file `.ezil-rebase-state.json` = in_progress is written on the data
    root (not visible to the guest) BEFORE the first change;
  * the rebase runs as a subprocess; ANY non-zero exit (or a crash/kill, which leaves
    in_progress behind) -> state rebase_failed, the guard refuses, the desktop never
    starts on a half-rebased upper. Recovery = the control plane restores the snapshot
    named in the receipt (a fresh volume has no state file);
  * success -> marker gets the new lowerImageDigest, the state file is removed.

Rules (from the S1 spike; each has a test that fails without it, test/test-rebase.sh):
  1  dpkg status: new image stanzas + the user's stanzas for packages the image lacks
     (user's original kept in the preserve dir). A non-regular status is moved aside.
  2  dpkg info/<pkg>.* of packages the new image ships: moved aside.
  3  upper files/symlinks at paths the new image owns (dpkg-owned, or any non-dir the
     new lower ships under usr/ opt/ container-server/), /etc excluded: MOVED ASIDE to
     /.ezil-rebase-preserved/<ts>/<path>, never deleted (§3a.5).
  3w whiteouts at owned paths: removed (no data).
  4  regular files identical (sha256, mode, uid, gid) to the OLD lower: removed, /etc
     included (the only rule that lets an /etc image update through).
  5  opaque dirs outside /etc that would hide owned new-image paths: flag cleared.

Hostile-input handling: every access is dir-fd relative with O_NOFOLLOW; files are read
only after fstat proves S_ISREG on the lstat'ed inode; device nodes are never opened.
The walk is ITERATIVE and holds one directory fd at a time (it climbs back with ".."
and verifies the parent's inode), so a guest-made tree deeper than the recursion limit
or the fd limit is walked completely instead of aborting part way. Paths longer than
PATH_MAX (4096) cannot be image paths and are kept without further checks.
A planted `/.ezil-rebase-preserved` that is not a real directory is renamed aside.

EZIL_REBASE_DISABLE=<rule,...> and EZIL_REBASE_FAULT_AFTER=<n> are TEST-ONLY hooks (the
production unit never sets them): they prove each rule matters and that a failure part
way through is caught.
"""
import hashlib
import json
import os
import stat
import sys
import time

from .fsops import DIR_FLAGS, read_regular_at

SYSTEM_TREES = ("usr/", "opt/", "container-server/")
DPKG_STATUS = "var/lib/dpkg/status"
INFO = "var/lib/dpkg/info"
PRESERVE = ".ezil-rebase-preserved"
PATH_MAX = 4096


class Lookup:
    def __init__(self, path):
        self.root = os.open(path, DIR_FLAGS)

    def _parent(self, rel):
        parts = rel.split("/")
        fds, fd = [], self.root
        for comp in parts[:-1]:
            try:
                fd = os.open(comp, DIR_FLAGS, dir_fd=fd)
            except OSError:
                for f in fds:
                    os.close(f)
                return None, None, []
            fds.append(fd)
        return fd, parts[-1], fds

    def lstat(self, rel):
        fd, name, fds = self._parent(rel)
        try:
            return None if fd is None else os.stat(name, dir_fd=fd, follow_symlinks=False)
        except OSError:
            return None
        finally:
            for f in fds:
                os.close(f)

    def read(self, rel):
        fd, name, fds = self._parent(rel)
        try:
            return None if fd is None else read_regular_at(fd, name)
        finally:
            for f in fds:
                os.close(f)

    def listdir(self, rel):
        fd, _, fds = self._parent(rel + "/.")
        try:
            return [] if fd is None else os.listdir(fd)
        finally:
            for f in fds:
                os.close(f)


def stanzas(text):
    out = []
    for block in text.strip("\n").split("\n\n"):
        lines = block.split("\n")
        name = next((l[9:].strip() for l in lines if l.startswith("Package: ")), "")
        arch = next((l[14:].strip() for l in lines if l.startswith("Architecture: ")), "")
        if name:
            out.append(((name, arch), block))
    return out


def dec(b):
    return b.decode("utf-8", "surrogateescape")


def rebase(upper_path, old_path, new_path, disabled=frozenset(), fault_after=None):
    on = lambda r: r not in disabled  # noqa: E731
    upper = os.open(upper_path, DIR_FLAGS)
    old, new = Lookup(old_path), Lookup(new_path)
    new_status_b = new.read(DPKG_STATUS)
    if new_status_b is None:
        raise SystemExit("new image has no regular dpkg status")
    new_status = stanzas(dec(new_status_b))
    new_names = {k[0] for k, _ in new_status}
    old_keys = {k for k, _ in stanzas(dec(old.read(DPKG_STATUS) or b""))}
    owned = set()
    for name in new.listdir(INFO):
        if name.endswith(".list"):
            body = new.read(INFO + "/" + name)
            if body:
                owned.update(l.lstrip("/") for l in dec(body).split("\n") if l.strip() and l != "/.")
    owned_dirs = set()
    for o in owned:
        p = o
        while "/" in p:
            p = p.rsplit("/", 1)[0]
            owned_dirs.add(p)

    def is_etc(rel):
        return rel == "etc" or rel.startswith("etc/")

    def is_owned(rel):
        if is_etc(rel):
            return False
        if rel in owned:
            return True
        if rel.startswith(SYSTEM_TREES):
            st = new.lstat(rel)
            return st is not None and not stat.S_ISDIR(st.st_mode)
        return False

    rep = {"moved_aside": [], "removed_whiteout": [], "removed_identical": [], "opaque_cleared": [],
           "status_merged": False, "status_user_stanzas_kept": [], "non_regular_status_moved_aside": False,
           "planted_preserve_renamed": None, "kept": 0, "entries": 0, "max_depth": 0, "long_paths_kept": 0,
           "preserved_dir": None, "disabled_rules": sorted(disabled)}
    ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime()) + f"-{os.getpid()}"
    pstate = {"fd": None}

    # A planted non-directory at /.ezil-rebase-preserved is renamed aside (never followed).
    try:
        pst = os.stat(PRESERVE, dir_fd=upper, follow_symlinks=False)
        if not stat.S_ISDIR(pst.st_mode):
            planted = f"{PRESERVE}.planted-{ts}"
            os.rename(PRESERVE, planted, src_dir_fd=upper, dst_dir_fd=upper)
            rep["planted_preserve_renamed"] = "/" + planted
    except FileNotFoundError:
        pass

    def preserved_parent(rel):
        if pstate["fd"] is None:
            try:
                os.mkdir(PRESERVE, 0o700, dir_fd=upper)
            except FileExistsError:
                pass
            base = os.open(PRESERVE, DIR_FLAGS, dir_fd=upper)
            os.mkdir(ts, 0o700, dir_fd=base)
            pstate["fd"] = os.open(ts, DIR_FLAGS, dir_fd=base)
            os.close(base)
            rep["preserved_dir"] = f"/{PRESERVE}/{ts}"
        fd = os.dup(pstate["fd"])
        for comp in rel.split("/")[:-1]:
            try:
                os.mkdir(comp, 0o755, dir_fd=fd)
            except FileExistsError:
                pass
            nfd = os.open(comp, DIR_FLAGS, dir_fd=fd)
            os.close(fd)
            fd = nfd
        return fd

    def move_aside(dfd, name, rel):
        if not on("P"):
            os.unlink(name, dir_fd=dfd)
            rep["moved_aside"].append({"path": "/" + rel, "deleted_because_P_disabled": True})
            return
        pfd = preserved_parent(rel)
        try:
            os.rename(name, rel.rsplit("/", 1)[-1], src_dir_fd=dfd, dst_dir_fd=pfd)
        finally:
            os.close(pfd)
        rep["moved_aside"].append("/" + rel)

    def identical_to_old(dfd, name, rel, st):
        ost = old.lstat(rel)
        if ost is None or not stat.S_ISREG(ost.st_mode) or ost.st_size != st.st_size \
                or stat.S_IMODE(ost.st_mode) != stat.S_IMODE(st.st_mode) or (ost.st_uid, ost.st_gid) != (st.st_uid, st.st_gid):
            return False
        a, b = read_regular_at(dfd, name, st), old.read(rel)
        return a is not None and b is not None and hashlib.sha256(a).digest() == hashlib.sha256(b).digest()

    def handle_status(dfd, name, rel, st):
        body = read_regular_at(dfd, name, st) if stat.S_ISREG(st.st_mode) else None
        if body is None:
            move_aside(dfd, name, rel)
            rep["non_regular_status_moved_aside"] = True
            return
        user = stanzas(dec(body))
        keep = [b for k, b in user if k[0] not in new_names]
        rep["status_user_stanzas_kept"] = [k[0] for k, b in user if k[0] not in new_names and k not in old_keys]
        merged = ("\n\n".join([b for _, b in new_status] + keep) + "\n").encode("utf-8", "surrogateescape")
        tmp = ".ezil-rebase-status.tmp"
        try:
            os.unlink(tmp, dir_fd=dfd)
        except FileNotFoundError:
            pass
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o644, dir_fd=dfd)
        try:
            os.write(fd, merged)
            os.fchown(fd, st.st_uid, st.st_gid)
            os.fchmod(fd, stat.S_IMODE(st.st_mode))
            os.fsync(fd)
        finally:
            os.close(fd)
        pfd = preserved_parent(rel)
        try:
            os.rename(name, "status", src_dir_fd=dfd, dst_dir_fd=pfd)
        finally:
            os.close(pfd)
        os.rename(tmp, name, src_dir_fd=dfd, dst_dir_fd=dfd)
        rep["status_merged"] = True

    def handle_entry(dfd, name, rel, st):
        rep["entries"] += 1
        if fault_after is not None and rep["entries"] > fault_after:
            raise RuntimeError("injected rebase fault (EZIL_REBASE_FAULT_AFTER)")
        if rel is None:                                  # deeper than PATH_MAX: cannot be an image path
            rep["long_paths_kept"] += 1
            return
        if rel == DPKG_STATUS:
            if on("1"):
                handle_status(dfd, name, rel, st)
            else:
                rep["kept"] += 1
            return
        if rel.startswith(INFO + "/") and on("2") and name.rsplit(".", 1)[0].split(":")[0] in new_names:
            move_aside(dfd, name, rel)
            return
        if stat.S_ISCHR(st.st_mode) and st.st_rdev == 0:
            if on("3w") and is_owned(rel):
                os.unlink(name, dir_fd=dfd)
                rep["removed_whiteout"].append("/" + rel)
            else:
                rep["kept"] += 1
            return
        if (stat.S_ISREG(st.st_mode) or stat.S_ISLNK(st.st_mode)) and on("3") and is_owned(rel):
            if stat.S_ISREG(st.st_mode) and identical_to_old(dfd, name, rel, st):
                os.unlink(name, dir_fd=dfd)
                rep["removed_identical"].append("/" + rel)
            else:
                move_aside(dfd, name, rel)
            return
        if stat.S_ISREG(st.st_mode) and on("4") and identical_to_old(dfd, name, rel, st):
            os.unlink(name, dir_fd=dfd)
            rep["removed_identical"].append("/" + rel)
            return
        rep["kept"] += 1

    def handle_dir_opaque(cfd, rel):
        if rel is None or not on("5") or is_etc(rel):
            return
        try:
            opaque = os.getxattr(cfd, "trusted.overlay.opaque") == b"y"
        except OSError:
            return
        if not opaque:
            return
        nst = new.lstat(rel)
        if rel in owned_dirs or (rel.startswith(SYSTEM_TREES) and nst is not None and stat.S_ISDIR(nst.st_mode)):
            os.removexattr(cfd, "trusted.overlay.opaque")
            rep["opaque_cleared"].append("/" + rel)

    # ---- iterative walk: one fd held; climb back via ".." with inode verification ----
    # frame: [ident(dev,ino), remaining names (reversed list), rel or None, rel_len]
    cur = os.dup(upper)
    rst = os.fstat(cur)
    stack = [[(rst.st_dev, rst.st_ino), sorted(os.listdir(cur), reverse=True), "", 0]]
    while stack:
        frame = stack[-1]
        if not frame[1]:
            stack.pop()
            if stack:
                parent_ident = stack[-1][0]
                pfd = os.open("..", DIR_FLAGS, dir_fd=cur)
                pst = os.fstat(pfd)
                os.close(cur)
                if (pst.st_dev, pst.st_ino) != parent_ident:
                    os.close(pfd)
                    raise SystemExit("tree changed during rebase (parent identity)")
                cur = pfd
            continue
        name = frame[1].pop()
        if frame[2] == "" and name in (PRESERVE,):
            continue
        rel_len = frame[3] + len(name) + (1 if frame[3] else 0)
        rel = None if frame[2] is None or rel_len > PATH_MAX else (name if frame[2] == "" else frame[2] + "/" + name)
        try:
            st = os.stat(name, dir_fd=cur, follow_symlinks=False)
        except FileNotFoundError:
            continue
        if stat.S_ISDIR(st.st_mode):
            cfd = os.open(name, DIR_FLAGS, dir_fd=cur)
            cst = os.fstat(cfd)
            if (cst.st_dev, cst.st_ino) != (st.st_dev, st.st_ino):
                os.close(cfd)
                raise SystemExit("tree changed during rebase (child identity)")
            handle_dir_opaque(cfd, rel)
            os.close(cur)
            cur = cfd
            stack.append([(cst.st_dev, cst.st_ino), sorted(os.listdir(cur), reverse=True), rel, rel_len])
            rep["max_depth"] = max(rep["max_depth"], len(stack) - 1)
            continue
        handle_entry(cur, name, rel, st)
    os.close(cur)
    if pstate["fd"] is not None:
        os.fsync(pstate["fd"])
        os.close(pstate["fd"])
    os.fsync(upper)
    os.close(upper)
    os.sync()
    return rep


def main(argv):
    disabled = frozenset(r for r in os.environ.get("EZIL_REBASE_DISABLE", "").split(",") if r)
    fa = os.environ.get("EZIL_REBASE_FAULT_AFTER")
    rep = rebase(argv[1], argv[2], argv[3], disabled, int(fa) if fa else None)
    print(json.dumps(rep))


if __name__ == "__main__":
    main(sys.argv)


def run_job(cfg, lease, root_fd):
    """Called by the guard with the data root open rw. Snapshot-first: the receipt was
    already validated by the guard (volume, digests, old lower present)."""
    import subprocess
    from . import config as cfgmod
    from .fsops import Refused, write_file_durable_at
    from .guard import REBASE_STATE
    r = lease["rebase"]
    state = {"state": "in_progress", "receipt": r, "generation": lease["generation"],
             "leaseEpoch": lease["leaseEpoch"], "startedAt": int(time.time())}
    write_file_durable_at(root_fd, REBASE_STATE, (json.dumps(state) + "\n").encode(), 0o600)
    lib = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "EZIL_REBASE_DISABLE", "EZIL_REBASE_FAULT_AFTER")}
    env["PYTHONPATH"] = lib
    p = subprocess.run([sys.executable, "-m", "ezil_host.rebase", os.path.join(cfg.dataMount, "root/upper"),
                        # lowers live on the trusted root volume; resolve an operator symlink there
                        os.path.realpath(cfgmod.lower_dir(cfg, r["fromDigest"])),
                        os.path.realpath(cfgmod.lower_dir(cfg, r["toDigest"]))],
                       env=env, capture_output=True, text=True)
    if p.returncode != 0:
        state.update(state="rebase_failed", exitCode=p.returncode, stderr=p.stderr[-2000:])
        os.makedirs(cfg.runDir, mode=0o700, exist_ok=True)
        with open(os.path.join(cfg.runDir, "rebase-error.txt"), "w") as f:
            f.write(p.stderr[-8000:])
        write_file_durable_at(root_fd, REBASE_STATE, (json.dumps(state) + "\n").encode(), 0o600)
        raise Refused("rebase_failed", f"exit {p.returncode}; restore snapshot {r['snapshotId']}")
    os.makedirs(cfg.runDir, mode=0o700, exist_ok=True)
    with open(os.path.join(cfg.runDir, "rebase-report.json"), "w") as f:
        f.write(p.stdout)
    os.unlink(REBASE_STATE, dir_fd=root_fd)
    os.fsync(root_fd)
