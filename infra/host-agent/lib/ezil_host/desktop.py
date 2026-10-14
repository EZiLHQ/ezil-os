"""Host-clean, overlay, network namespace, OCI spec and the runc desktop.

The spec reuses the image's environment and entrypoint (as local mode's run-spec.ts
does) and applies §3a.3: Docker's default 14 capabilities only, noNewPrivileges,
seccomp (security/seccomp.json), AppArmor profile `ezil-desktop`, pids limit, read-only
hosts/hostname/resolv.conf, tmpfs /tmp and /run, data-volume binds nosuid,nodev
(profiles also noexec, §3a.9). The merged overlay itself is mounted nodev (§3a.7).
"""
import base64
import json
import os
import secrets
import signal
import subprocess
import time

from . import config as cfgmod
from .fsops import DIR_FLAGS, Refused, clear_dir, read_regular_at, remove_singletons

# Docker's default set MINUS CAP_NET_RAW: no raw/packet sockets, so no forged packets
# (the anti-spoof rule is the network-side fence). The desktop boots without it (test-boot).
CAPS = ["CAP_CHOWN", "CAP_DAC_OVERRIDE", "CAP_FSETID", "CAP_FOWNER", "CAP_MKNOD", "CAP_SETGID",
        "CAP_SETUID", "CAP_SETFCAP", "CAP_SETPCAP", "CAP_NET_BIND_SERVICE", "CAP_SYS_CHROOT", "CAP_KILL",
        "CAP_AUDIT_WRITE"]
OVL_OPTS = "index=off,redirect_dir=off,metacopy=off,xino=off"
PROFILE_ENV = {
    "CHROME_PROFILE_DIR": "/var/lib/ezil-profiles/chrome",
    "CODE_SERVER_USER_DATA_DIR": "/var/lib/ezil-profiles/code-server-data",
    "CODE_SERVER_EXTENSIONS_DIR": "/var/lib/ezil-profiles/code-server-extensions",
    "EZIL_PERSISTENT_PROFILES": "1",
}

# Terminal history that survives a stop with terminals still open. Bash writes
# ~/.bash_history only when a shell exits, and a stop that ends in KILL never lets it.
# Injected from the host, never by editing the image: the container env reaches the
# only user terminal (code-server's: start-desktop.sh -> start-neko.sh -> setsid
# code-server -> `bash --init-file shellIntegration-bash.sh`, which keeps an inherited
# PROMPT_COMMAND), and a read-only /etc/profile.d file covers login shells that reset
# the env. The user's own ~/.bashrc still wins: it runs after both.
HISTORY_PROMPT = "history -a; shopt -s histappend"
HISTORY_PROFILE = """# Managed by ezil-host-agent (read-only). Interactive bash appends each command to
# $HISTFILE at every prompt, so history survives a stop with terminals still open.
if [ -n "${BASH_VERSION:-}" ]; then
  case $- in
    *i*)
      case "${PROMPT_COMMAND:-}" in
        *"history -a"*) ;;
        *) PROMPT_COMMAND="history -a; shopt -s histappend${PROMPT_COMMAND:+; $PROMPT_COMMAND}" ;;
      esac ;;
  esac
fi
"""
# Shells that save their history when they get SIGHUP (and then exit). Only those
# attached to a terminal are hung up: that is a user's open terminal, not a script.
HISTORY_SHELLS = ("bash", "zsh")
HANGUP_SETTLE = 3.0
# The last stop's outcome, on the data root (not reachable by the guest), reported at boot.
STOP_RECORD = ".ezil-last-stop.json"


def with_history(env):
    """env (list of K=V) with PROMPT_COMMAND running `history -a` first; an existing
    PROMPT_COMMAND (e.g. from the image) is kept after it."""
    out, existing = [], None
    for e in env:
        if e.startswith("PROMPT_COMMAND="):
            existing = e.split("=", 1)[1]
        else:
            out.append(e)
    if existing and "history -a" in existing:
        pc = existing
    else:
        pc = HISTORY_PROMPT + (f"; {existing}" if existing else "")
    return out + [f"PROMPT_COMMAND={pc}"]


def merged(cfg):
    return os.path.join(cfg.runDir, "rootfs")


# ------------------------------------------------------------------ host-clean
def read_stop_record(cfg):
    """The previous stop's record from the data root, or None. Host-written, but read
    no-follow, size-bounded and reduced to known fields like any volume content."""
    try:
        root = os.open(cfg.dataMount, DIR_FLAGS)
    except OSError:
        return None
    try:
        try:
            st = os.stat(STOP_RECORD, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            return None
        raw = read_regular_at(root, STOP_RECORD, st, limit=4096)
    finally:
        os.close(root)
    try:
        d = json.loads(raw) if raw is not None else None
    except ValueError:
        d = None
    if not isinstance(d, dict):
        return {"outcome": "unreadable"}
    out = {k: d[k] for k in ("outcome", "reason", "at", "generation", "leaseEpoch")
           if isinstance(d.get(k), (str, int)) and not isinstance(d.get(k), bool)}
    if out.get("outcome") not in ("clean", "killed", "absent"):
        out["outcome"] = "unreadable"
    if "reason" in out:
        out["reason"] = str(out["reason"])[:128]
    return out


def host_clean(cfg):
    """R15 + §3a.1: no-follow clearing of legacy upper/tmp and upper/run (tmpfs now, so
    normally empty) and the Chrome Singleton* entries. Runs only after the guard. Also
    reports how the previous stop ended (lastStop), so an unclean stop is in the boot log."""
    out = {"lastStop": read_stop_record(cfg), "singletons": remove_singletons(cfg.dataMount)}
    for d in ("tmp", "run"):
        try:
            out[d] = clear_dir(cfg.dataMount, "root/upper/" + d)
        except Refused as e:
            if "No such file" in str(e):
                out[d] = 0
            else:
                raise
    return out


# --------------------------------------------------------------------- overlay
def overlay_mount(cfg, lower=None):
    lower = lower or cfgmod.lower_dir(cfg, cfgmod.host_digest(cfg))
    if not os.path.isdir(os.path.join(lower, "usr")):
        raise Refused("lower_missing", lower)
    m = merged(cfg)
    os.makedirs(m, mode=0o755, exist_ok=True)
    if subprocess.run(["mountpoint", "-q", m]).returncode == 0:
        subprocess.run(["umount", m], check=True)
    up = os.path.join(cfg.dataMount, "root")
    subprocess.run(["mount", "-t", "overlay", "ezil-rootfs", "-o",
                    f"nodev,lowerdir={lower},upperdir={up}/upper,workdir={up}/work,{OVL_OPTS}", m], check=True)
    return m


def overlay_umount(cfg):
    m = merged(cfg)
    if subprocess.run(["mountpoint", "-q", m]).returncode == 0:
        subprocess.run(["umount", m], check=True)


# ----------------------------------------------------------------------- netns
HOST_IP, CT_IP = "10.200.0.1", "10.200.0.2"
HOST_IF, CT_IF = "ezh0", "ezc0"
# Destinations the container may never reach (R5, §3a): all link-local (instance
# metadata and everything else in 169.254/16), RFC1918 (the VPC and its peers), CGNAT,
# "this network", multicast and reserved. The VPC CIDR is added when configured.
BLOCKED = ["169.254.0.0/16", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10",
           "0.0.0.0/8", "224.0.0.0/4", "240.0.0.0/4"]
CHAINS = {("iptables", "filter", "EZIL-CT-FWD"): ("FORWARD", "-I"),
          ("iptables", "filter", "EZIL-CT-IN"): ("INPUT", "-I"),
          ("iptables", "nat", "EZIL-CT-NAT"): ("POSTROUTING", "-A"),
          # IPv6 is disabled on both veth ends; these drops are the belt-and-braces layer
          ("ip6tables", "filter", "EZIL-CT-FWD6"): ("FORWARD", "-I"),
          ("ip6tables", "filter", "EZIL-CT-IN6"): ("INPUT", "-I")}


def _hostns(cfg):
    """Command prefix for the HOST network namespace. Production: [] (the real host).
    Tests set cfg.hostNetns to a disposable namespace so veth-nat is exercised without
    touching the shared machine's networking; if that namespace is missing the command
    fails instead of falling back to the real host."""
    return ["ip", "netns", "exec", cfg["hostNetns"]] if cfg.get("hostNetns") else []


def _run(cfg, argv, check=True, host=True):
    return subprocess.run((_hostns(cfg) if host else []) + argv, check=check, capture_output=True, text=True)


def desired_rules(cfg):
    # anti-spoof first: the container may only send from its own address
    fwd = [["-i", HOST_IF, "!", "-s", f"{CT_IP}/32", "-j", "DROP"]]
    fwd += [["-i", HOST_IF, "-d", net, "-j", "DROP"] for net in BLOCKED + ([cfg["vpcCidr"]] if cfg.get("vpcCidr") else [])]
    fwd += [["-i", HOST_IF, "-j", "ACCEPT"],
            ["-o", HOST_IF, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
            ["-o", HOST_IF, "-j", "DROP"]]
    inp = [["-i", HOST_IF, "!", "-s", f"{CT_IP}/32", "-j", "DROP"],
           ["-i", HOST_IF, "-d", f"{HOST_IP}/32", "-p", "udp", "--dport", "53", "-j", "ACCEPT"],
           ["-i", HOST_IF, "-d", f"{HOST_IP}/32", "-p", "tcp", "--dport", "53", "-j", "ACCEPT"],
           ["-i", HOST_IF, "-m", "conntrack", "--ctstate", "ESTABLISHED,RELATED", "-j", "ACCEPT"],
           ["-i", HOST_IF, "-j", "DROP"]]
    nat = [["-s", f"{CT_IP}/32", "!", "-o", HOST_IF, "-j", "MASQUERADE"]]
    fwd6 = [["-i", HOST_IF, "-j", "DROP"], ["-o", HOST_IF, "-j", "DROP"]]
    in6 = [["-i", HOST_IF, "-j", "DROP"]]
    return {("iptables", "filter", "EZIL-CT-FWD"): fwd, ("iptables", "filter", "EZIL-CT-IN"): inp,
            ("iptables", "nat", "EZIL-CT-NAT"): nat,
            ("ip6tables", "filter", "EZIL-CT-FWD6"): fwd6, ("ip6tables", "filter", "EZIL-CT-IN6"): in6}


def _rule_lines(listing, src, dst):
    """The `-A <src> ...` lines of an `-S` listing, renamed to chain dst, in order."""
    out = []
    for line in listing.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0] == "-A" and parts[1] == src:
            out.append(" ".join(["-A", dst] + parts[2:]))
    return out


def _canonical(cfg, tool, table, chain, rules):
    """The exact `-S` lines iptables prints for `rules`, in order. iptables reorders
    options and adds implicit matches (`-p udp` gains `-m udp`), so the comparison form
    comes from iptables itself: the rules are built in an UNREFERENCED scratch chain (no
    packet can reach it), listed, and the scratch chain is removed again."""
    scratch = chain + "-C"
    _run(cfg, [tool, "-w", "-t", table, "-F", scratch], check=False)
    _run(cfg, [tool, "-w", "-t", table, "-X", scratch], check=False)
    _run(cfg, [tool, "-w", "-t", table, "-N", scratch])
    try:
        for r in rules:
            _run(cfg, [tool, "-w", "-t", table, "-A", scratch] + r)
        listing = _run(cfg, [tool, "-w", "-t", table, "-S", scratch]).stdout
    finally:
        _run(cfg, [tool, "-w", "-t", table, "-F", scratch], check=False)
        _run(cfg, [tool, "-w", "-t", table, "-X", scratch], check=False)
    return _rule_lines(listing, scratch, chain)


def _chain_ok(cfg, tool, table, chain, rules):
    listing = _run(cfg, [tool, "-w", "-t", table, "-S", chain], check=False)
    if listing.returncode != 0:
        return False
    # ORDER matters: an ACCEPT moved ahead of the drops keeps every rule present but
    # opens the metadata/private/spoof holes. Compare the ordered listing exactly.
    if _rule_lines(listing.stdout, chain, chain) != _canonical(cfg, tool, table, chain, rules):
        return False
    parent, how = CHAINS[(tool, table, chain)]
    lines = _run(cfg, [tool, "-w", "-t", table, "-S", parent], check=False).stdout.splitlines()
    jumps = [i for i, l in enumerate(lines) if l.split()[-2:] == ["-j", chain]]
    if len(jumps) != 1:
        return False
    # filter jumps must come first (line 0 is the -P policy), ahead of anything that accepts
    return how != "-I" or jumps[0] == 1


def host_if_ipv6_off(cfg):
    r = _run(cfg, ["sysctl", "-n", f"net.ipv6.conf.{HOST_IF}.disable_ipv6"], check=False)
    return r.returncode == 0 and r.stdout.strip() == "1"


def rules_ok(cfg):
    """The drift check: every chain exactly as desired AND IPv6 off on the host veth end."""
    return host_if_ipv6_off(cfg) and all(_chain_ok(cfg, tool, t, c, r) for (tool, t, c), r in desired_rules(cfg).items())


def ensure_rules(cfg):
    """Idempotent: a chain already exactly as desired is left alone; otherwise a fresh
    chain is built and swapped in behind the parent jump (no window without rules)."""
    changed = []
    if not host_if_ipv6_off(cfg):
        _run(cfg, ["sysctl", "-q", "-w", f"net.ipv6.conf.{HOST_IF}.disable_ipv6=1"])
        changed.append(f"{HOST_IF}.disable_ipv6")
    for (tool, table, chain), rules in desired_rules(cfg).items():
        if _chain_ok(cfg, tool, table, chain, rules):
            continue
        parent, how = CHAINS[(tool, table, chain)]
        tmp = chain + "-N"
        _run(cfg, [tool, "-w", "-t", table, "-F", tmp], check=False)
        _run(cfg, [tool, "-w", "-t", table, "-X", tmp], check=False)
        _run(cfg, [tool, "-w", "-t", table, "-N", tmp])
        for r in rules:
            _run(cfg, [tool, "-w", "-t", table, "-A", tmp] + r)
        _run(cfg, [tool, "-w", "-t", table, how, parent] + (["1"] if how == "-I" else []) + ["-j", tmp])
        while _run(cfg, [tool, "-w", "-t", table, "-D", parent, "-j", chain], check=False).returncode == 0:
            pass
        _run(cfg, [tool, "-w", "-t", table, "-F", chain], check=False)
        _run(cfg, [tool, "-w", "-t", table, "-X", chain], check=False)
        _run(cfg, [tool, "-w", "-t", table, "-E", tmp, chain])
        changed.append(chain)
    if not rules_ok(cfg):
        raise Refused("network_rules_not_applied")
    return changed


def netns_up(cfg):
    """networkMode none: loopback only (= docker --network none).
    networkMode veth-nat: veth pair to the host, default route via the host, NAT out,
    IPv6 off in the container, DNS only to the host resolver at HOST_IP:53, and the
    BLOCKED destinations dropped (ensure_rules)."""
    names = subprocess.run(["ip", "netns", "list"], capture_output=True, text=True).stdout.split()
    if cfg.netnsName not in names:
        subprocess.run(["ip", "netns", "add", cfg.netnsName], check=True)
    subprocess.run(["ip", "-n", cfg.netnsName, "link", "set", "lo", "up"], check=True)
    if cfg.networkMode == "none":
        return
    if cfg.networkMode != "veth-nat":
        raise Refused("network_mode_unknown", cfg.networkMode)
    ns = cfg.netnsName
    if _run(cfg, ["ip", "link", "show", HOST_IF], check=False).returncode != 0:
        _run(cfg, ["ip", "link", "add", HOST_IF, "type", "veth", "peer", "name", CT_IF, "netns", ns])
    # no IPv6 on the host end, set BEFORE the link comes up (so no link-local address exists)
    _run(cfg, ["sysctl", "-q", "-w", f"net.ipv6.conf.{HOST_IF}.disable_ipv6=1"])
    _run(cfg, ["ip", "addr", "replace", f"{HOST_IP}/30", "dev", HOST_IF])
    _run(cfg, ["ip", "link", "set", HOST_IF, "up"])
    subprocess.run(["ip", "-n", ns, "addr", "replace", f"{CT_IP}/30", "dev", CT_IF], check=True)
    subprocess.run(["ip", "-n", ns, "link", "set", CT_IF, "up"], check=True)
    subprocess.run(["ip", "-n", ns, "route", "replace", "default", "via", HOST_IP], check=True)
    for k in ("all", "default", CT_IF, "lo"):
        subprocess.run(["ip", "netns", "exec", ns, "sysctl", "-q", "-w", f"net.ipv6.conf.{k}.disable_ipv6=1"], check=True)
    _run(cfg, ["sysctl", "-q", "-w", "net.ipv4.ip_forward=1"])
    ensure_rules(cfg)


def netns_down(cfg):
    names = subprocess.run(["ip", "netns", "list"], capture_output=True, text=True).stdout.split()
    if cfg.netnsName in names:
        # removes the veth pair too (once nothing else holds the namespace)
        r = subprocess.run(["ip", "netns", "delete", cfg.netnsName], capture_output=True, text=True)
        if r.returncode != 0:
            raise Refused("netns_delete_failed", f"{cfg.netnsName}: {r.stderr.strip()[:200]}")


# ------------------------------------------------------------------------ spec
def build_spec(cfg, lease, mode="desktop", extra_binds=()):
    with open(cfg.imageConfigFile, encoding="utf-8") as f:
        image = json.load(f)
    host = f"ezil-gen-{lease['generation']}-e{lease['leaseEpoch']}"
    gen_dir = os.path.join(cfg.runDir, "gen")
    os.makedirs(gen_dir, mode=0o755, exist_ok=True)
    files = {"hostname": host + "\n",
             "hosts": f"127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n127.0.1.1\t{host}\n",
             "resolv.conf": "# managed by ezil-host-agent\n" + (f"nameserver {HOST_IP}\n" if cfg.networkMode == "veth-nat" else ""),
             "ezil-history.sh": HISTORY_PROFILE}
    for n, body in files.items():
        with open(os.path.join(gen_dir, n), "w") as f:
            f.write(body)
    pw = lambda: base64.urlsafe_b64encode(secrets.token_bytes(18)).decode().rstrip("=")  # noqa: E731
    env = with_history(list(image["Env"]) + [
        "HOME=/root", f"HOSTNAME={host}", "DESKTOP_MODE=neko", "NEKO_SCREEN=1920x1080x24",
        f"NEKO_MEMBER_MULTIUSER_USER_PASSWORD={pw()}", f"NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD={pw()}",
        "NEKO_SESSION_IMPLICIT_HOSTING=true", "NEKO_WEBRTC_UDPMUX=52100", "NEKO_WEBRTC_TCPMUX=52100",
        "NEKO_WEBRTC_NAT1TO1=127.0.0.1", "NEKO_WEBRTC_ICELITE=true", "EZIL_WORKSPACE_ROOT=/workspace",
    ] + [f"{k}={v}" for k, v in PROFILE_ENV.items()])
    args = (["/bin/bash", "-c", "DESKTOP_MODE=neko bash /usr/local/bin/start-desktop.sh"] if mode == "desktop"
            else ["/bin/sleep", "infinity"])
    dm = cfg.dataMount

    def bind(src, dst, opts):
        return {"destination": dst, "type": "bind", "source": src, "options": ["rbind"] + opts}
    with open(cfg.seccompProfile, encoding="utf-8") as f:
        seccomp = json.load(f)
    seccomp.pop("_comment", None)
    mounts = [
        {"destination": "/proc", "type": "proc", "source": "proc"},
        {"destination": "/dev", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "strictatime", "mode=755", "size=65536k"]},
        {"destination": "/dev/pts", "type": "devpts", "source": "devpts",
         "options": ["nosuid", "noexec", "newinstance", "ptmxmode=0666", "mode=0620", "gid=5"]},
        {"destination": "/dev/shm", "type": "tmpfs", "source": "shm", "options": ["nosuid", "noexec", "nodev", "mode=1777", "size=67108864"]},
        {"destination": "/dev/mqueue", "type": "mqueue", "source": "mqueue", "options": ["nosuid", "noexec", "nodev"]},
        {"destination": "/sys", "type": "sysfs", "source": "sysfs", "options": ["nosuid", "noexec", "nodev", "ro"]},
        {"destination": "/sys/fs/cgroup", "type": "cgroup", "source": "cgroup", "options": ["nosuid", "noexec", "nodev", "relatime", "ro"]},
        {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=1777", "size=1073741824"]},
        {"destination": "/run", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev", "mode=755", "size=268435456"]},
        bind(f"{dm}/workspace", "/workspace", ["rw", "nosuid", "nodev"]),
        bind(f"{dm}/profiles", "/var/lib/ezil-profiles", ["rw", "nosuid", "nodev", "noexec"]),
        bind(f"{gen_dir}/hosts", "/etc/hosts", ["ro"]),
        bind(f"{gen_dir}/hostname", "/etc/hostname", ["ro"]),
        bind(f"{gen_dir}/resolv.conf", "/etc/resolv.conf", ["ro"]),
        bind(f"{gen_dir}/ezil-history.sh", "/etc/profile.d/ezil-history.sh", ["ro"]),
    ] + [bind(s, d, o) for s, d, o in extra_binds]
    spec = {
        "ociVersion": "1.2.0",
        "process": {
            "terminal": False, "user": {"uid": 0, "gid": 0}, "args": args, "env": env,
            "cwd": image.get("WorkingDir") or "/",
            "capabilities": {"bounding": CAPS, "effective": CAPS, "permitted": CAPS},
            "rlimits": [{"type": "RLIMIT_NOFILE", "hard": 1048576, "soft": 1048576}],
            "noNewPrivileges": True,
            "apparmorProfile": cfg.apparmorProfile,
        },
        "root": {"path": merged(cfg), "readonly": False},
        "hostname": host,
        "mounts": mounts,
        "linux": {
            "namespaces": [{"type": "pid"}, {"type": "ipc"}, {"type": "uts"}, {"type": "mount"}, {"type": "cgroup"},
                           {"type": "network", "path": f"/var/run/netns/{cfg.netnsName}"}],
            "cgroupsPath": cfg.cgroupsPath,
            "resources": {"cpu": {"quota": cfg.cpuQuota, "period": 100000}, "memory": {"limit": cfg.memoryLimit},
                          "pids": {"limit": cfg.pidsLimit}, "devices": [{"allow": False, "access": "rwm"}]},
            "seccomp": seccomp,
            "maskedPaths": ["/proc/acpi", "/proc/asound", "/proc/kcore", "/proc/keys", "/proc/latency_stats",
                            "/proc/timer_list", "/proc/timer_stats", "/proc/sched_debug", "/proc/scsi",
                            "/sys/firmware", "/sys/devices/virtual/powercap"],
            "readonlyPaths": ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
        },
    }
    bundle = os.path.join(cfg.runDir, "bundle")
    os.makedirs(bundle, mode=0o700, exist_ok=True)
    with open(os.path.join(bundle, "config.json"), "w") as f:
        json.dump(spec, f, indent=1)
    return bundle


# ------------------------------------------------------------------------ runc
def runc(cfg, *args, **kw):
    return subprocess.run([cfg.runcBin, "--root", os.path.join(cfg.runDir, "runc"), "--systemd-cgroup", *args], **kw)


def state(cfg):
    r = runc(cfg, "state", cfg.containerId, capture_output=True, text=True)
    if r.returncode != 0:
        return "absent"
    return json.loads(r.stdout).get("status", "unknown")


def run(cfg, detach=False, log=None):
    """Foreground under systemd (Type=simple); detached in tests."""
    bundle = os.path.join(cfg.runDir, "bundle")
    if detach:
        with open(log or os.devnull, "ab") as lf:
            return runc(cfg, "run", "--detach", "--bundle", bundle, cfg.containerId,
                        stdin=subprocess.DEVNULL, stdout=lf, stderr=lf).returncode
    os.execv(cfg.runcBin, [cfg.runcBin, "--root", os.path.join(cfg.runDir, "runc"), "--systemd-cgroup",
                           "run", "--bundle", bundle, cfg.containerId])


def _proc_shell_on_tty(pid):
    """(comm, tty_nr) of a host pid, or None."""
    try:
        with open(f"/proc/{pid}/comm") as f:
            comm = f.read().strip()
        with open(f"/proc/{pid}/stat") as f:
            fields = f.read().rsplit(")", 1)[1].split()
        return comm, int(fields[4])          # after "pid (comm)": state ppid pgrp session tty_nr
    except (OSError, IndexError, ValueError):
        return None


def container_pids(cfg):
    r = runc(cfg, "ps", "--format", "json", cfg.containerId, capture_output=True, text=True)
    if r.returncode != 0:
        return []
    try:
        pids = json.loads(r.stdout or "[]")
    except ValueError:
        return []
    return [p for p in pids if isinstance(p, int) and not isinstance(p, bool) and p > 1]


def hangup_shells(cfg, settle=HANGUP_SETTLE, pids=None):
    """Before the stop, SIGHUP every terminal shell (bash/zsh on a tty) in the desktop:
    an interactive shell saves its history on SIGHUP — including a command that is still
    running — then exits, as when a terminal window closes. Signals go through a pidfd,
    so a recycled pid is never signalled. Returns how many shells were hung up."""
    sent = []
    for pid in (container_pids(cfg) if pids is None else pids):
        try:
            pfd = os.pidfd_open(pid)
        except OSError:
            continue
        try:
            info = _proc_shell_on_tty(pid)
            if info and info[0] in HISTORY_SHELLS and info[1] != 0:
                signal.pidfd_send_signal(pfd, signal.SIGHUP)
                sent.append(pfd)
                continue
        except OSError:
            pass
        os.close(pfd)
    deadline = time.time() + settle
    for pfd in sent:
        try:
            while time.time() < deadline:
                signal.pidfd_send_signal(pfd, 0)      # raises once the shell has exited
                time.sleep(0.1)
        except OSError:
            pass
        finally:
            os.close(pfd)
    return len(sent)


def stop(cfg, grace=10.0, kill=False):
    """Stop the desktop. Returns how it ended: 'absent' (nothing was running), 'clean'
    (exited after TERM within grace) or 'killed' (KILL was needed, or asked for). Only
    'clean' and 'absent' mean the guest had its chance to finish writing."""
    if state(cfg) == "absent":
        return "absent"
    if not kill:
        hangup_shells(cfg)
    runc(cfg, "kill", "--all", cfg.containerId, "KILL" if kill else "TERM", capture_output=True)
    deadline = time.time() + (0 if kill else grace)
    while time.time() < deadline and state(cfg) == "running":
        time.sleep(0.5)
    outcome = "killed" if kill or state(cfg) == "running" else "clean"
    runc(cfg, "kill", "--all", cfg.containerId, "KILL", capture_output=True)
    for _ in range(40):
        if state(cfg) != "running":
            break
        time.sleep(0.25)
    runc(cfg, "delete", "--force", cfg.containerId, capture_output=True)
    return outcome


def exec_(cfg, argv, **kw):
    return runc(cfg, "exec", cfg.containerId, *argv, **kw)
