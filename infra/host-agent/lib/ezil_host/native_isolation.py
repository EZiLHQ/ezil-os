"""Isolation primitives for one native runtime (native_session.py drives them).

Every name derives from the runtime's private resource key (64 lowercase hex chosen by the root
manager, never caller input). A runtime is:

  * a per-runtime cgroup <nativeCgroupRoot>/rt-<key16> with finite cpu/memory/pids and two leaves,
    `driver` (the public Node driver + Core relay, service UID) and `cli` (the CLI container), so
    "what runs for this runtime" is exactly the cgroup's recursive member set;
  * a private network namespace whose only interface is a per-runtime veth, with its own nft table
    (loopback = Core's relay, the configured resolver, public 80/443; IMDS, private, link-local,
    CGNAT and host addresses dropped) applied and read back INSIDE that netns only;
  * a raw-token credential file <nativeGrantRoot>/<key16>/credential, 0600, owned by the service
    UID, in a 0700 directory under a root-owned 0711 chain on the run tmpfs (Core's
    readPrivateCredential format), never mounted into the desktop or the CLI;
  * the CLI's OCI bundle: user namespace (container 0..65535 -> host nativeUidBase..), uid 1000,
    no capabilities, noNewPrivileges, read-only root, /dev limited to null/zero/random/urandom,
    the workspace idmapped so the on-disk root owner appears as the CLI's own kuid (no chown),
    and Core's private state leaves idmapped from the service UID to the CLI's kuid.

Kernel evidence (fixture work/fx, tag 5945cf92): idmapped root-owned workspace write/edit/git
commit by mapped uid 1000, persistent mapped HOME, only own pids, credential canary unreadable,
relay reachable, IMDS and private LAN dropped after ruleset readback, recursive cgroup members
observed and fenced by cgroup.kill. The service UID can read /proc/<cli>/stat but NOT its cwd.

Nothing here runs a shell or a caller-chosen command: every argv is a fixed list.
"""
import fcntl
import errno
import hashlib
import json
import os
import re
import signal
import socket
import stat
import subprocess
import threading
import queue
import time
from contextlib import ExitStack

from .fsops import DIR_FLAGS, FILE_FLAGS, Refused, write_file_durable_at, empty_dir_fd

KEY = re.compile(r"[0-9a-f]{64}")
CREDENTIAL = "credential"
CGROUP_PREFIX = "rt-"
GRANT_TOKEN = re.compile(r"ezg_[A-Za-z0-9_-]{43}")
LIMITS = {"cpuQuotaMicros": 200000, "cpuPeriodMicros": 100000, "memoryBytes": 4 << 30, "pids": 512}
NETNS_PREFIX = "ezn-"
DENIED_V4 = ("0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
             "192.0.0.0/24", "192.168.0.0/16", "198.18.0.0/15", "224.0.0.0/3")
DEVICES = (("/dev/null", 3), ("/dev/zero", 5), ("/dev/random", 8), ("/dev/urandom", 9))
FRAME_LIMIT = 131072        # Root freeze: total native request AND reply wrapper, every hop
DRIVER_FD = 3


def short(key):
    if not isinstance(key, str) or not KEY.fullmatch(key):
        raise Refused("native_resource_key_invalid")
    return key[:16]


def boot_id(path="/proc/sys/kernel/random/boot_id"):
    try:
        with open(path, encoding="ascii") as f:
            value = f.read(80).strip()
        return value if re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", value) else None
    except (OSError, UnicodeError):
        return None


def derive_host_epoch(kernel_boot_id, computer_id, placement):
    from .native_authority import UUID, valid_placement, canonical
    if not isinstance(kernel_boot_id, str) or not UUID.fullmatch(kernel_boot_id) or not isinstance(computer_id, str) or not UUID.fullmatch(computer_id) or not valid_placement(placement):
        raise ValueError("kernel identity unavailable")
    return hashlib.sha256(canonical(["ezil.native-host-epoch.v1", kernel_boot_id, computer_id,
        placement["generation"], placement["leaseEpoch"], placement["instanceId"], placement["fenceToken"]])).hexdigest()[:32]


# ---------------------------------------------------------------------------- process identity
def proc_start(pid, proc="/proc"):
    """Start time in clock ticks (stat field 22), or None. (pid, start) names one process for life."""
    try:
        with open(f"{proc}/{int(pid)}/stat", "rb") as f:
            raw = f.read(4096)
        return int(raw.rsplit(b")", 1)[1].split()[19])
    except (OSError, ValueError, IndexError):
        return None


def identity(pid, proc="/proc"):
    start = proc_start(pid, proc)
    return None if start is None else {"pid": int(pid), "procStart": start}


def same_process(ident, proc="/proc"):
    return isinstance(ident, dict) and proc_start(ident.get("pid", -1), proc) == ident.get("procStart")


def signal_identity(ident, sig=signal.SIGTERM):
    """Signal exactly the identified process through a pidfd (never a recycled pid)."""
    try:
        pfd = os.pidfd_open(ident["pid"])
    except (OSError, KeyError, TypeError):
        return False
    try:
        if not same_process(ident):
            return False
        signal.pidfd_send_signal(pfd, sig)
        return True
    except OSError:
        return False
    finally:
        os.close(pfd)


# ---------------------------------------------------------------------------- cgroup
class Cgroup:
    """cgroup v2 directory under a delegated root whose subtree_control enables cpu, memory, pids."""

    def __init__(self, root, name):
        if not re.fullmatch(r"[a-z0-9-]{1,40}", name):
            raise Refused("native_cgroup_name_invalid")
        self.root, self.name, self.path = root, name, os.path.join(root, name)

    @classmethod
    def for_runtime(cls, root, key):
        return cls(root, CGROUP_PREFIX + short(key))

    def child(self, name):
        return Cgroup(self.path, name)

    def _write(self, rel, value):
        fd = os.open(os.path.join(self.path, rel), os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
        try:
            os.write(fd, value.encode())
        finally:
            os.close(fd)

    def create(self, limits=None, leaves=()):
        rfd = os.open(self.root, DIR_FLAGS)
        try:
            os.mkdir(self.name, 0o755, dir_fd=rfd)
        except FileExistsError:
            raise Refused("native_cgroup_exists", self.name)
        finally:
            os.close(rfd)
        if limits:
            self._write("cpu.max", f"{limits['cpuQuotaMicros']} {limits['cpuPeriodMicros']}")
            self._write("memory.max", str(limits["memoryBytes"]))
            if os.path.exists(os.path.join(self.path, "memory.swap.max")):
                self._write("memory.swap.max", "0")
            self._write("pids.max", str(limits["pids"]))
        if leaves:
            self._write("cgroup.subtree_control", "+cpu +memory +pids")
            for leaf in leaves:
                self.child(leaf).create()
        return self.path

    def exists(self):
        try:
            return stat.S_ISDIR(os.lstat(self.path).st_mode)
        except FileNotFoundError:
            return False

    def members(self):
        pids = set()
        for dirpath, _, _ in os.walk(self.path, followlinks=False):
            try:
                with open(os.path.join(dirpath, "cgroup.procs")) as f:
                    pids.update(int(x) for x in f.read().split())
            except FileNotFoundError:
                continue
        return pids

    def populated(self):
        try:
            with open(os.path.join(self.path, "cgroup.events")) as f:
                return dict(line.split() for line in f if line.strip()).get("populated") == "1"
        except FileNotFoundError:
            return False

    def kill(self, timeout=10.0, sleep=time.sleep, monotonic=time.monotonic):
        """cgroup.kill (race free against forks), then wait for the kernel's empty report."""
        if not self.exists():
            return True
        self._write("cgroup.kill", "1")
        deadline = monotonic() + timeout
        while monotonic() < deadline:
            if not self.populated():
                return True
            sleep(0.05)
        return not self.populated()

    def remove(self):
        """rmdir bottom-up; never a populated tree. True when gone."""
        if not self.exists():
            return True
        if self.populated():
            return False
        for dirpath, _, _ in sorted(os.walk(self.path, topdown=False, followlinks=False), key=lambda w: -len(w[0])):
            try:
                os.rmdir(dirpath)
            except FileNotFoundError:
                pass
            except OSError as e:
                if e.errno in (errno.EBUSY, errno.ENOTEMPTY):
                    return False
                raise
        return not self.exists()


# ---------------------------------------------------------------------------- credential
def grant_root(cfg):
    return cfg.get("nativeGrantRoot") or "/run/ezil-native/grant"


def grant_dir(cfg, key):
    return os.path.join(grant_root(cfg), short(key))


def ensure_grant_root(cfg):
    """Root-owned searchable0711 chain; normalize only directories this call just created."""
    from .native_artifact import trusted_directory
    root=grant_root(cfg)
    for path in (os.path.dirname(root),root):
        parent,name=os.path.split(path);pfd=trusted_directory(parent,searchable=True);created=False;fd=None
        try:
            try:os.mkdir(name,0o700,dir_fd=pfd);created=True
            except FileExistsError:pass
            fd=os.open(name,DIR_FLAGS,dir_fd=pfd);st=os.fstat(fd)
            if st.st_uid!=0 or st.st_gid!=0 or not stat.S_ISDIR(st.st_mode):raise Refused("native_grant_root_invalid",path)
            if created:os.fchmod(fd,0o711);os.fsync(fd)
            elif stat.S_IMODE(st.st_mode)!=0o711:raise Refused("native_grant_root_invalid",path)
        finally:
            if fd is not None:os.close(fd)
            os.close(pfd)


def _private_dir(path, uid, gid):
    parent, name = os.path.split(path)
    pfd = os.open(parent, DIR_FLAGS)
    try:
        try:
            os.mkdir(name, 0o700, dir_fd=pfd)
        except FileExistsError:
            pass
        fd = os.open(name, DIR_FLAGS, dir_fd=pfd)
    finally:
        os.close(pfd)
    try:
        os.fchown(fd, uid, gid)
        os.fchmod(fd, 0o700)
        st = os.fstat(fd)
        if not stat.S_ISDIR(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o700:
            raise Refused("native_private_dir_invalid")
    except BaseException:
        os.close(fd)
        raise
    return fd


def write_credential(cfg, key, token, uid, gid):
    """Atomically place the RAW token as <dir>/credential (0600, uid). Returns the path. The token
    is never logged, put in argv/env, or mounted anywhere."""
    if not isinstance(token, str) or not GRANT_TOKEN.fullmatch(token):
        raise Refused("native_grant_invalid")
    ensure_grant_root(cfg)
    dfd = _private_dir(grant_dir(cfg, key), uid, gid)
    try:
        tmp = f".{CREDENTIAL}.{os.getpid()}.{time.monotonic_ns()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=dfd)
        try:
            os.fchown(fd, uid, gid)
            os.fchmod(fd, 0o600)
            os.write(fd, token.encode("ascii"))
        finally:
            os.close(fd)
        os.rename(tmp, CREDENTIAL, src_dir_fd=dfd, dst_dir_fd=dfd)
        check = os.open(CREDENTIAL, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=dfd)
        try:
            st = os.fstat(check)
            if (not stat.S_ISREG(st.st_mode) or st.st_uid != uid or stat.S_IMODE(st.st_mode) != 0o600
                    or st.st_nlink != 1 or st.st_size != len(token)):
                raise Refused("native_grant_file_invalid")
        finally:
            os.close(check)
    finally:
        os.close(dfd)
    return os.path.join(grant_dir(cfg, key), CREDENTIAL)


def remove_credential(cfg, key):
    path = grant_dir(cfg, key)
    try:
        dfd = os.open(path, DIR_FLAGS)
    except FileNotFoundError:
        return True
    try:
        for name in os.listdir(dfd):
            os.unlink(name, dir_fd=dfd)
    finally:
        os.close(dfd)
    os.rmdir(path)
    return not os.path.lexists(path)


# ---------------------------------------------------------------------------- network
def network_plan(key, slot):
    if type(slot) is not int or not 0 <= slot < 16384:
        raise Refused("native_network_slot_invalid")
    sid = short(key)[:12]
    base = 4 * slot
    return {"netns": NETNS_PREFIX + sid, "vethHost": f"ezh{sid}", "vethNs": f"ezn{sid}",
            "hostIp": f"10.231.{base // 256}.{base % 256 + 1}", "nsIp": f"10.231.{base // 256}.{base % 256 + 2}"}


def nft_ruleset(plan, resolver=None):
    """Applied INSIDE the runtime netns only. Core's relay is on that netns's loopback."""
    lines = ["table inet ezil_native {", " chain output {", "  type filter hook output priority 0; policy drop;",
             "  oifname \"lo\" accept", "  ct state established,related accept"]
    if resolver:
        lines += [f"  ip daddr {resolver} udp dport 53 accept", f"  ip daddr {resolver} tcp dport 53 accept"]
    lines += [f"  ip daddr {{ {', '.join(DENIED_V4)} }} drop", "  meta nfproto ipv6 drop",
              "  tcp dport { 80, 443 } accept", " }", " chain input {",
              "  type filter hook input priority 0; policy drop;", "  iifname \"lo\" accept",
              "  ct state established,related accept", " }", "}"]
    return "\n".join(lines) + "\n"


def network_up_cmds(plan):
    ns, h, n = plan["netns"], plan["vethHost"], plan["vethNs"]
    return [["ip", "netns", "add", ns], ["ip", "link", "add", h, "type", "veth", "peer", "name", n],
            ["ip", "link", "set", n, "netns", ns], ["ip", "addr", "add", plan["hostIp"] + "/30", "dev", h],
            ["ip", "link", "set", h, "up"], ["ip", "-n", ns, "addr", "add", plan["nsIp"] + "/30", "dev", n],
            ["ip", "-n", ns, "link", "set", n, "up"], ["ip", "-n", ns, "link", "set", "lo", "up"],
            ["ip", "-n", ns, "route", "add", "default", "via", plan["hostIp"]]]


def apply_network(plan, resolver=None, run=subprocess.run):
    """Fail closed: any step error raises before anything can run in the netns, and the ruleset is
    read back and must contain the drop policy and the IMDS/private drop set."""
    for argv in network_up_cmds(plan):
        run(argv, check=True, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    run(["ip", "netns", "exec", plan["netns"], "nft", "-f", "-"], input=nft_ruleset(plan, resolver).encode(),
        check=True, timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    listed = run(["ip", "netns", "exec", plan["netns"], "nft", "list", "ruleset"], capture_output=True, text=True,
                 timeout=10, check=True).stdout
    if "policy drop" not in listed or "169.254.0.0/16" not in listed or "10.0.0.0/8" not in listed:
        raise Refused("native_network_rules_unverified")


def remove_network(plan, run=subprocess.run):
    for argv in (["ip", "link", "del", plan["vethHost"]], ["ip", "netns", "del", plan["netns"]]):
        run(argv, check=False, timeout=10, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    return not os.path.lexists(os.path.join("/var/run/netns", plan["netns"]))


# ---------------------------------------------------------------------------- OCI spec
def build_cli_spec(*, rootfs, artifact_dir, workspace, state_leaves, uid_base, service_uid, cgroups_path, netns_path,
                   seccomp, args, env, cwd, limits=LIMITS):
    """The CLI container. `state_leaves` maps Core's absolute service-UID paths (HOME, config, tmp)
    to themselves inside the container, idmapped service UID -> the CLI's kuid; the workspace is
    idmapped on-disk root -> the CLI's kuid. idmap line "A B n": on-disk A appears as kuid B."""
    if type(uid_base) is not int or not 100000 <= uid_base <= 2 ** 31 - 65536 or type(service_uid) is not int:
        raise Refused("native_uid_base_invalid")
    cli_kuid = uid_base + 1000
    none = []

    def bind(src, dst, opts, owner=None):
        m = {"destination": dst, "type": "bind", "source": src, "options": ["rbind"] + opts}
        if owner is not None:
            m["options"].append("idmap")
            m["uidMappings"] = [{"containerID": owner, "hostID": cli_kuid, "size": 1}]
            m["gidMappings"] = [{"containerID": owner, "hostID": cli_kuid, "size": 1}]
        return m
    return {
        "ociVersion": "1.2.0",
        "process": {"terminal": False, "user": {"uid": 1000, "gid": 1000}, "args": list(args),
                    "env": [f"{k}={v}" for k, v in sorted(env.items())], "cwd": cwd,
                    "capabilities": {"bounding": none, "effective": none, "permitted": none, "ambient": none},
                    "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 65536, "soft": 65536}], "noNewPrivileges": True},
        "root": {"path": rootfs, "readonly": True},
        "hostname": "ezil-native",
        "mounts": [
            {"destination": "/proc", "type": "proc", "source": "proc", "options": ["nosuid", "noexec", "nodev"]},
            {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
            {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=536870912"]},
            {"destination": "/sys", "type": "tmpfs", "source": "tmpfs",
             "options": ["nosuid", "noexec", "nodev", "ro", "mode=0555", "size=65536"]},
            bind(artifact_dir, artifact_dir, ["ro", "nosuid", "nodev"]),
            bind(workspace, workspace, ["rw", "nosuid", "nodev"], owner=0),
        ] + [bind(p, p, ["rw", "nosuid", "nodev"], owner=service_uid) for p in state_leaves],
        "linux": {
            "namespaces": [{"type": t} for t in ("pid", "ipc", "uts", "mount", "cgroup", "user")]
            + [{"type": "network", "path": netns_path}],
            "uidMappings": [{"containerID": 0, "hostID": uid_base, "size": 65536}],
            "gidMappings": [{"containerID": 0, "hostID": uid_base, "size": 65536}],
            "devices": [{"path": p, "type": "c", "major": 1, "minor": m, "fileMode": 0o666, "uid": 0, "gid": 0} for p, m in DEVICES],
            "cgroupsPath": cgroups_path,
            "resources": {"cpu": {"quota": limits["cpuQuotaMicros"], "period": limits["cpuPeriodMicros"]},
                          "memory": {"limit": limits["memoryBytes"]}, "pids": {"limit": limits["pids"]},
                          "devices": [{"allow": False, "access": "rwm"}]
                          + [{"allow": True, "type": "c", "major": 1, "minor": m, "access": "rwm"} for _, m in DEVICES]},
            **({"seccomp": seccomp} if seccomp else {}),
            # runc creates additional default /dev nodes even with explicit OCI devices.
            # Mask its tty and full entries to the standard null device.
            "maskedPaths": ["/dev/full", "/dev/tty", "/proc/acpi", "/proc/kcore", "/proc/keys", "/proc/latency_stats", "/proc/timer_list",
                            "/proc/sched_debug", "/proc/scsi", "/sys/firmware"],
            "readonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
        },
    }


def cgroup_oci_path(path, mountinfo="/proc/self/mountinfo"):
    """Map one existing no-follow cgroup2 filesystem directory into its verified hierarchy."""
    if not isinstance(path,str) or not os.path.isabs(path) or os.path.normpath(path)!=path:
        raise Refused("native_cgroup_path_invalid")
    def unescape(value):
        for code,char in [("\\040"," "),("\\011","\t"),("\\012","\n"),("\\134","\\")]:value=value.replace(code,char)
        return value
    candidates=[]
    with open(mountinfo,encoding="utf-8") as f:
        for line in f:
            fields=line.split()
            try:sep=fields.index("-")
            except ValueError:continue
            if len(fields)>sep+1 and fields[sep+1]=="cgroup2":
                root,mount=unescape(fields[3]),unescape(fields[4])
                if root=="/" and os.path.commonpath([path,mount])==mount:candidates.append(mount)
    if len(candidates)!=1:raise Refused("native_cgroup_mount_unverified")
    mount=candidates[0]
    fd=os.open("/",DIR_FLAGS)
    try:
        for part in path.split("/")[1:]:
            child=os.open(part,DIR_FLAGS,dir_fd=fd);st=os.fstat(child)
            if st.st_uid!=0 or stat.S_IMODE(st.st_mode)&0o022:os.close(child);raise Refused("native_cgroup_path_untrusted")
            os.close(fd);fd=child
        check=os.open("cgroup.events",os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC,dir_fd=fd);os.close(check)
    finally:os.close(fd)
    relative=os.path.relpath(path,mount)
    if relative=="." or relative.startswith("../"):raise Refused("native_cgroup_path_invalid")
    return "/"+relative


def runc_cmd(runc_bin, runc_root, *args):
    """cgroupfs driver: the CLI's cgroup is the runtime's own `cli` leaf."""
    return [runc_bin, "--root", runc_root, *args]


# ---------------------------------------------------------------------------- driver
class DriverChannel:
    """The root end of FD 3: newline-delimited JSON frames, each <= FRAME_LIMIT; oversize or
    malformed input ends the channel (reported as {"eof": true})."""

    def __init__(self, sock):
        self.sock, self.frames = sock, queue.Queue()
        self.send_lock = threading.Lock()
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        from .lease import strict_json
        buf = b""
        try:
            while True:
                chunk = self.sock.recv(65536)
                if not chunk:
                    break
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if len(line) + 1 > FRAME_LIMIT:
                        return
                    frame = strict_json(line.decode("utf-8", "strict"))
                    if not isinstance(frame, dict):
                        return
                    self.frames.put(frame)
                if len(buf) >= FRAME_LIMIT:
                    return
        except (OSError, ValueError, UnicodeError, RecursionError):
            pass
        finally:
            self.frames.put({"eof": True})

    def next_frame(self, timeout):
        try:
            return self.frames.get(timeout=timeout)
        except queue.Empty:
            return None

    def send(self, frame):
        data = (json.dumps(frame, separators=(",", ":")) + "\n").encode()
        if len(data) > FRAME_LIMIT:
            raise Refused("native_frame_too_large")
        try:
            with self.send_lock:
                self.sock.sendall(data)
            return True
        except OSError:
            return False

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


def verify_direct_exe(proc, expected):
    """The running process's kernel executable must be EXACTLY the pinned file (same path and inode),
    so a dynamic loader, shell wrapper or any other binary is refused. Popen returns only after a
    successful exec, so /proc/<pid>/exe is final. On mismatch the process is killed via its pidfd."""
    try:
        exe = os.readlink(f"/proc/{proc.pid}/exe")
        want, got = os.stat(expected, follow_symlinks=False), os.stat(f"/proc/{proc.pid}/exe")
        ok = exe == expected and (want.st_dev, want.st_ino) == (got.st_dev, got.st_ino)
    except OSError:
        ok = False
    if not ok:
        ident = identity(proc.pid)
        if ident:
            signal_identity(ident, signal.SIGKILL)
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass
        raise Refused("native_driver_exe_mismatch")
    return True


def spawn_driver(argv, child_sock, env, cgroup_path=None, netns_path=None, uid=None, gid=None, io_fds=None):
    """Start the driver with child_sock as FD 3 and /dev/null on 0-2; in production also as uid/gid
    (no supplementary groups) inside cgroup_path and the runtime netns, joined before exec.

    FD 3 is placed by dup2 in the child after fork. close_fds is False on purpose: subprocess
    closes non-pass_fds descriptors AFTER preexec_fn, which would close FD 3 again. Instead the
    child closes every INHERITABLE descriptor above 3 itself; close-on-exec ones (subprocess's own
    error pipe included) end at exec. So exactly 0-3 cross exec."""
    sock_fd = child_sock.fileno()
    procs = os.path.join(cgroup_path, "cgroup.procs") if cgroup_path else None

    def child():
        if procs:
            fd = os.open(procs, os.O_WRONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
            try:
                os.write(fd, b"0")
            finally:
                os.close(fd)
        if netns_path:
            nfd = os.open(netns_path, os.O_RDONLY | os.O_CLOEXEC)
            try:
                os.setns(nfd, os.CLONE_NEWNET)
            finally:
                os.close(nfd)
        sources = {DRIVER_FD: sock_fd, **(io_fds or {})}
        copies = {target: fcntl.fcntl(source, fcntl.F_DUPFD_CLOEXEC, 64) for target, source in sources.items()}
        for target, source in copies.items():
            os.dup2(source, target)
            os.set_inheritable(target, True)
            os.close(source)
        for name in os.listdir("/proc/self/fd"):
            fd = int(name)
            try:
                if fd > (6 if io_fds else DRIVER_FD) and os.get_inheritable(fd):
                    os.close(fd)
            except OSError:
                pass
        if uid is not None:
            os.setgroups([])
            os.setresgid(gid, gid, gid)
            os.setresuid(uid, uid, uid)
        os.umask(0o077)
    return subprocess.Popen(list(argv), preexec_fn=child, close_fds=False, env=dict(env),
                            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, cwd="/",
                            start_new_session=True)


class Launcher:
    """Starts, prepares and stops runtimes for native_session.Manager. agent.json (all required
    when native sessions are enabled): nativeCgroupRoot, nativeRootfs, nativeUidBase, nativeServiceUid,
    nativeServiceGid, nativeStateRoot, nativeGatewayOrigin; optional nativeResolver,
    nativeGrantRoot."""

    def __init__(self, cfg, lease, run=subprocess.run, host_epoch=None):
        self.cfg, self.lease, self.run = cfg, lease, run
        self.host_epoch = host_epoch
        self.runc_root = os.path.join(cfg.runDir, "native", "runc")
        self.driver_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "native_driver.mjs")
        self.procs = {}

    def _names(self, rec):
        key = rec["resourceKey"]
        cg = Cgroup.for_runtime(self.cfg.nativeCgroupRoot, key)
        return {"cgroup": cg, "container": "ezil-native-" + short(key), "plan": network_plan(key, rec["slot"]),
                "bundle": os.path.join(self.cfg.runDir, "native", "bundle", short(key)),
                "rootfsWorkRoot": self.cfg.get("nativeRootfsWorkRoot") or self.cfg.runDir + "-native-rootfs",
                "rootfsContainer": os.path.join(self.cfg.get("nativeRootfsWorkRoot") or self.cfg.runDir + "-native-rootfs", short(key))}

    def _state_root(self, rec):
        return os.path.join(self.cfg.nativeStateRoot, rec["sessionId"])

    def start_driver(self, rec, artifact, token, instruction, profile):
        if not artifact.get("node"):
            raise Refused("native_node_unpinned")
        node = os.path.join(artifact["dir"], artifact["node"])
        n = self._names(rec)
        uid, gid = int(self.cfg.nativeServiceUid), int(self.cfg.nativeServiceGid)
        n["cgroup"].create(LIMITS, leaves=("driver", "cli"))
        apply_network(n["plan"], self.cfg.get("nativeResolver"), run=self.run)
        credential = write_credential(self.cfg, rec["resourceKey"], token, uid, gid)
        state_root = self._state_root(rec)
        os.close(_private_dir(state_root, uid, gid))
        with ExitStack() as retained, ExitStack() as inherited:
            parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
            retained.callback(parent.close)
            inherited.callback(child.close)
            cli_in, driver_in = os.pipe2(os.O_CLOEXEC)
            retained.callback(os.close, cli_in)
            inherited.callback(os.close, driver_in)
            driver_out, cli_out = os.pipe2(os.O_CLOEXEC)
            retained.callback(os.close, cli_out)
            inherited.callback(os.close, driver_out)
            driver_err, cli_err = os.pipe2(os.O_CLOEXEC)
            retained.callback(os.close, cli_err)
            inherited.callback(os.close, driver_err)
            proc = spawn_driver([node, "--disallow-code-generation-from-strings", self.driver_script],
                                child, {"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8"},
                                cgroup_path=os.path.join(n["cgroup"].path, "driver"),
                                netns_path=f"/var/run/netns/{n['plan']['netns']}", uid=uid, gid=gid,
                                io_fds={4: driver_in, 5: driver_out, 6: driver_err})
            verify_direct_exe(proc, node)
            retained.pop_all()   # the channel and runtime record now own these handles
        self.procs[rec["operationId"]] = {"driver": identity(proc.pid), "popen": proc,
            "cliIo": (cli_in, cli_out, cli_err), "artifactDir": artifact["dir"], "artifact": artifact}
        ch = DriverChannel(parent)
        ws = os.path.join(self.cfg.dataMount, "workspace")
        ch.send({"type": "bootstrap", "coreDir": os.path.dirname(os.path.join(artifact["dir"], artifact["core"])),
                 "stateRoot": state_root, "hostEpoch": rec["hostEpoch"],
                 "principal": rec["ownerUserId"], "sessionRef": rec["sessionId"],
                 "binding": {"ownerId": rec["ownerUserId"], "computerId": rec["computerId"], "sessionId": rec["sessionId"],
                             "originalOAuthClientId": rec["sourceAuthorization"]["clientId"], "profile": "ezil-native-claude-v1",
                             "aiAuthorization": {"authorizationId": rec["sourceAuthorization"]["authorizationId"], "state": "active",
                                 "expiresAt": rec["sourceAuthorization"]["authorizationDeadline"], "policyDigest": None},
                             "hostEpoch": rec["hostEpoch"], "placement": dict(rec["placement"]),
                             "leaseUntil": rec["leaseUntil"], "workspaceRoot": ws, "cwd": ws, "model": profile["model"],
                             "tools": list(profile["tools"]), "limits": dict(profile["limits"]),
                             # Operator-pinned Gateway trust (Core's grant keys); no defaults.
                             "grant": {"gatewayOrigin": self.cfg.nativeGatewayOrigin, "caPem": self.cfg.nativeGatewayCaPem,
                                       "spkiSha256": self.cfg.nativeGatewaySpkiSha256, "credentialFile": credential}},
                 "cli": {"executable": os.path.join(artifact["dir"], artifact["cli"]),
                         "realpath": os.path.join(artifact["dir"], artifact["cli"]), "version": artifact["cliVersion"]},
                 "requestId": rec["operationId"], "instruction": instruction})
        return ch

    def prepare(self, rec):
        """Everything the CLI container needs except its argv/env (known only at Core's spawn): the
        receipt names the exact resources; Core's verifyIsolation compares it with the ledger's."""
        n = self._names(rec)
        netns_ino = os.stat(f"/var/run/netns/{n['plan']['netns']}").st_ino
        return {"v": 1, "runtimeId": rec["runtimeId"], "cgroup": n["cgroup"].path, "netnsInode": netns_ino,
                "uidBase": int(self.cfg.nativeUidBase), "container": n["container"],
                "driver": self.procs.get(rec["operationId"], {}).get("driver")}

    def spawn_cli(self, rec, options):
        """Only Core's durable spawn gate calls this; OCI contains the exact prepared workspace."""
        from .native_authority import canonical
        proc = self.procs[rec["operationId"]]
        if proc.get("cliPopen") is not None:
            raise Refused("native_spawn_already_attempted")
        n = self._names(rec)
        ws = os.path.join(self.cfg.dataMount, "workspace")
        if (set(options) != {"executable", "args", "env", "cwd"} or options["cwd"] != ws
                or not isinstance(options["args"], list) or not isinstance(options["env"], dict)
                or not os.path.realpath(options["executable"]).startswith(os.path.realpath(proc["artifactDir"]) + "/")):
            raise Refused("native_spawn_invalid")
        state = os.path.join(self._state_root(rec), "sessions", rec["sessionId"])
        leaves = [os.path.join(state, leaf) for leaf in ("home", "config", "tmp")]
        from .native_artifact import prepare_rootfs, private_rootfs_container
        os.makedirs(n["bundle"], mode=0o700, exist_ok=False)
        rootfs_container = private_rootfs_container(n["rootfsWorkRoot"], short(rec["resourceKey"]))
        prepared = prepare_rootfs(self.cfg.nativeRootfs, proc["artifact"], rootfs_container, [proc["artifactDir"], ws, *leaves])
        proc["rootfsPreparation"] = prepared
        spec = build_cli_spec(rootfs=prepared["path"], artifact_dir=proc["artifactDir"], workspace=ws,
            state_leaves=leaves, uid_base=int(self.cfg.nativeUidBase), service_uid=int(self.cfg.nativeServiceUid),
            cgroups_path=cgroup_oci_path(n["cgroup"].child("cli").path), netns_path=f"/var/run/netns/{n['plan']['netns']}",
            seccomp=None, args=[options["executable"], *options["args"]], env=options["env"], cwd=ws)
        with open(os.path.join(n["bundle"], "config.json"), "xb") as f: f.write(canonical(spec))
        cli_in, cli_out, cli_err = proc["cliIo"]
        # Keep the runc monitor attached to the inherited fixed pipes. No shell, no credential env.
        child = subprocess.Popen(runc_cmd(self.cfg.runcBin, self.runc_root, "run", "--bundle", n["bundle"], n["container"]),
            stdin=cli_in, stdout=cli_out, stderr=cli_err, close_fds=True, start_new_session=True)
        proc["cliPopen"] = child
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            result = self.run(runc_cmd(self.cfg.runcBin, self.runc_root, "state", n["container"]), capture_output=True, text=True, timeout=2)
            if result.returncode == 0:
                data = json.loads(result.stdout)
                if data.get("status") == "running" and type(data.get("pid")) is int:
                    proc["cliIdentity"] = self.capture_identity(rec, data["pid"])
                    return {"ok": True, "pid": data["pid"]}
            if child.poll() is not None: break
            time.sleep(0.025)
        raise Refused("native_spawn_unconfirmed")

    def capture_identity(self, rec, pid=None):
        n = self._names(rec); proc = self.procs[rec["operationId"]]
        pid = pid if pid is not None else proc["cliIdentity"]["pid"]
        start = proc_start(pid)
        cwd = os.readlink(f"/proc/{pid}/cwd")
        if start is None or cwd != os.path.join(self.cfg.dataMount, "workspace") or pid not in n["cgroup"].child("cli").members() or boot_id() != rec["bootId"]:
            raise Refused("native_identity_unverified")
        return {"pid": pid, "procStart": str(start), "cwd": cwd, "bootId": rec["bootId"],
            "cgroup": n["cgroup"].child("cli").path, "provenance": "root-private-fd-v1"}

    def kill_cli(self, rec):
        return self._names(rec)["cgroup"].child("cli").kill(timeout=5)

    def reap_cli(self, rec):
        cli = self._names(rec)["cgroup"].child("cli")
        return cli.kill(timeout=10) and not cli.populated()

    def stop(self, rec, driver):
        """Ordered, verified teardown: driver (relay) first, then the whole runtime cgroup."""
        n = self._names(rec)
        cg = n["cgroup"]
        receipt = {}
        if driver is not None:
            driver.close()
        proc = self.procs.pop(rec["operationId"], {})
        for fd in proc.get("cliIo", ()):
            try: os.close(fd)
            except OSError: pass
        ident = proc.get("driver")
        if ident:
            signal_identity(ident, signal.SIGKILL)
        receipt["relayRevoked"] = cg.child("driver").kill(timeout=5) if cg.exists() else True
        receipt["cgroupEmpty"] = cg.kill(timeout=15)
        self.run(runc_cmd(self.cfg.runcBin, self.runc_root, "delete", "--force", n["container"]),
                 stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
        gone = self.run(runc_cmd(self.cfg.runcBin, self.runc_root, "state", n["container"]),
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        receipt["containerDeleted"] = gone.returncode != 0
        receipt["cgroupRemoved"] = cg.remove()
        receipt["netnsRemoved"] = remove_network(n["plan"], run=self.run)
        receipt["credentialRemoved"] = remove_credential(self.cfg, rec["resourceKey"])
        for label,path,mode in [("bundleRemoved",n["bundle"],0o700),("rootfsRemoved",n["rootfsContainer"],0o711)]:
            if receipt["relayRevoked"] and receipt["cgroupEmpty"] and receipt["containerDeleted"]:
                try:
                    fd=os.open(path,DIR_FLAGS)
                    try:
                        st=os.fstat(fd)
                        if st.st_uid!=0 or stat.S_IMODE(st.st_mode)!=mode:raise Refused("native_bundle_untrusted")
                        empty_dir_fd(fd)
                    finally:os.close(fd)
                    os.rmdir(path);receipt[label]=True
                except FileNotFoundError:receipt[label]=True
                except (OSError,Refused):receipt[label]=False
            else:receipt[label]=False
        if receipt["rootfsRemoved"]:
            try:os.rmdir(n["rootfsWorkRoot"])
            except OSError:pass # shared work root may hold another live resource
        return receipt


def _open_private_directory(parent_fd, name):
    fd = os.open(name, DIR_FLAGS, dir_fd=parent_fd)
    st = os.fstat(fd)
    if st.st_uid == 0 and stat.S_IMODE(st.st_mode) == 0o700:
        return fd
    os.close(fd)
    raise Refused("native_qualification_storage_untrusted")


def _open_witness_directory(cfg, *, create=False):
    from .native_artifact import trusted_directory

    state_fd = trusted_directory(cfg.stateDir)
    try:
        if create:
            try:
                os.mkdir("native", 0o700, dir_fd=state_fd)
            except FileExistsError:
                pass
            else:
                os.fsync(state_fd)
        return _open_private_directory(state_fd, "native")
    finally:
        os.close(state_fd)


def _read_private_record(directory_fd, name):
    fd = os.open(name, FILE_FLAGS, dir_fd=directory_fd)
    with os.fdopen(fd, "rb") as file:
        st = os.fstat(file.fileno())
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != 0
                or stat.S_IMODE(st.st_mode) != 0o600 or st.st_nlink > 1):
            return None
        raw = file.read(65537)
        return raw if len(raw) <= 65536 else None


def write_witness(cfg, witness):
    """Persist a complete witness from a trusted root qualifier."""
    from .native_artifact import load

    if os.geteuid() != 0:
        raise Refused("native_qualification_storage_untrusted")
    artifact = load(cfg.nativeRuntimeRoot, cfg.get("nativeRuntimePin"))
    fd = _open_witness_directory(cfg, create=True)
    try:
        # Serialize writers that share the durable writer's per-process temporary name.
        fcntl.flock(fd, fcntl.LOCK_EX)
        raw = json.dumps(witness, sort_keys=True).encode()
        if len(raw) > 65536 or _validate_witness(cfg, artifact, fd, raw) is None:
            raise Refused("native_qualification_evidence_invalid")
        write_file_durable_at(fd, "witness.json", raw, 0o600)
    finally:
        os.close(fd)


def read_witness(cfg, artifact):
    """Find the root-owned witness for this boot, kernel, runc and artifact pin."""
    try:
        fd = _open_witness_directory(cfg)
    except (OSError, Refused):
        return None
    try:
        return _validate_witness(cfg, artifact, fd, _read_private_record(fd, "witness.json"))
    except OSError:
        return None
    finally:
        os.close(fd)


def _validate_witness(cfg, artifact, directory_fd, raw):
    from .lease import strict_json
    from .native_artifact import trusted_directory

    if raw is None:
        return None
    try:
        w = strict_json(raw.decode("utf-8"))
        runc = subprocess.run([cfg.runcBin, "--version"], capture_output=True, text=True, timeout=5,
                              check=True).stdout.splitlines()
        if not runc:
            return None
    except (AttributeError, ValueError, OSError, subprocess.SubprocessError):
        return None
    required = {"artifact", "tls", "credentialPeer", "uidNamespaces", "cgroup", "devices", "egress",
                "workspace", "build", "rootfsTemplate", "childIdentity", "cliInitialize", "firstMessageAck", "fencingCleanup"}
    if not isinstance(w, dict) or set(w) != {"v", "bootId", "kernel", "runc", "manifestSha256", "placement", "computerId", "hostEpoch", "observations"}:
        return None
    try:
        if (w["v"] != 2 or w["bootId"] != boot_id() or w["kernel"] != os.uname().release or w["runc"] != runc[0]
                or w["manifestSha256"] != artifact.get("manifestSha256")
                or w["hostEpoch"] != derive_host_epoch(w["bootId"], w["computerId"], w["placement"])):
            return None
        observations = w["observations"]
        if not isinstance(observations, dict) or set(observations) != required:
            return None
        for item in observations.values():
            if (not isinstance(item, dict) or set(item) != {"status", "evidenceSha256", "observed"}
                    or item["status"] != "observed" or not isinstance(item["evidenceSha256"], str)
                    or not re.fullmatch(r"[0-9a-f]{64}", item["evidenceSha256"])
                    or not isinstance(item["observed"], dict) or not item["observed"]
                    or any(type(v) is bool for v in item["observed"].values())):
                return None
        if observations["rootfsTemplate"]["observed"].get("descriptorSha256") != artifact.get("rootfsTemplateSha256"):
            return None
        template_fd = trusted_directory(cfg.nativeRootfs)
        os.close(template_fd)
        # Each claimed observation is backed by the exact root-installed local evidence bytes.
        evidence_fd = _open_private_directory(directory_fd, "evidence")
        try:
            for item in observations.values():
                evidence = _read_private_record(evidence_fd, item["evidenceSha256"] + ".json")
                if evidence is None or hashlib.sha256(evidence).hexdigest() != item["evidenceSha256"]:
                    return None
                if strict_json(evidence.decode("utf-8")) != item["observed"]:
                    return None
        finally:
            os.close(evidence_fd)
        # All qualification records must identify the actually installed TLS trust and profile.
        trust = observations["tls"]["observed"]
        if (trust.get("caSha256") != hashlib.sha256(cfg.nativeGatewayCaPem.encode()).hexdigest()
                or trust.get("spkiSha256") != cfg.nativeGatewaySpkiSha256
                or trust.get("gatewayOrigin") != cfg.nativeGatewayOrigin):
            return None
        if observations["build"]["observed"].get("exitCode") != 0 or not re.fullmatch(r"[0-9a-f]{64}", observations["build"]["observed"].get("outputSha256", "")):
            return None
    except (ValueError, TypeError, KeyError, AttributeError, OSError, UnicodeError, Refused):
        return None
    return w
