"""Data-volume mount and the C-4 marker guard.

Order (each step refuses before anything is written):
  1. resolve the block device from the lease's volumeId (Nitro NVMe serial under
     /dev/disk/by-id), require a block device, read its filesystem UUID;
  2. provision only: an EMPTY device (no filesystem) with lease.provision=true is
     formatted with the control plane's fsUuid;
  3. device UUID must equal lease.fsUuid; mount it READ-ONLY, nosuid,nodev;
  4. refuse on a failed/in-progress rebase state;
  5. marker checks (C-4): computerId, volumeId, fsUuid equal; generation not above the
     lease's writer generation; leaseEpoch strictly below the lease epoch;
     lowerImageDigest equal to this host's lower (or a valid rebase receipt, rebase.py);
  6. only then remount rw (nosuid,nodev) and write the marker durably
     (tmp, fsync, rename, fsync dir), then the run stamp downstream units require.

The marker is a bug fence, not a security fence (C-4): guest root can rewrite it.
"""
import glob
import json
import os
import re
import stat
import subprocess
import time

from . import config as cfgmod
from .fsops import DIR_FLAGS, Refused, read_regular_at, write_file_durable_at

MARKER = ".ezil-marker.json"
REBASE_STATE = ".ezil-rebase-state.json"
MOUNT_OPTS = "nosuid,nodev"


def _device_number(number):
    return f"{os.major(number)}:{os.minor(number)}"


def _root_devices():
    """Include the root partition and every backing disk (also through dm/LVM)."""
    root = _device_number(os.stat("/").st_dev)
    try:
        r = subprocess.run(["lsblk", "--inverse", "--noheadings", "--raw", "--output",
                            "MAJ:MIN", f"/dev/block/{root}"],
                           capture_output=True, text=True, check=True, timeout=5)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused("root_device_unknown", "cannot inspect root backing devices") from e
    devices = set(r.stdout.split())
    if root not in devices or any(not re.fullmatch(r"[0-9]+:[0-9]+", d) for d in devices):
        raise Refused("root_device_unknown", "incomplete root backing devices")
    return devices


def provision_volume(cfg):
    """Resolve exactly one non-root EBS disk, then verify its EC2 attachment name."""
    name = cfg.dataDeviceName
    if not isinstance(name, str) or not re.fullmatch(r"/dev/[A-Za-z0-9]+", name):
        raise Refused("data_device_name_invalid")
    roots = _root_devices()
    candidates = set()
    for link in glob.glob(os.path.join(cfg.deviceByIdDir, "nvme-Amazon_Elastic_Block_Store_vol*")):
        serial = re.fullmatch(r"nvme-Amazon_Elastic_Block_Store_vol([0-9a-f]{8,17})",
                              os.path.basename(link))
        if serial is None:  # partition aliases (-partN) are never candidates
            continue
        try:
            dev = os.path.realpath(link, strict=True)
            st = os.stat(dev)
        except OSError:
            continue  # stale udev link: not an attached candidate
        if not stat.S_ISBLK(st.st_mode):
            raise Refused("volume_device_not_block", dev)
        if _device_number(st.st_rdev) not in roots:
            candidates.add(("vol-" + serial[1], dev))
    if len(candidates) != 1:
        raise Refused("provision_volume_candidates",
                      f"expected one attached non-root EBS data volume; found {len(candidates)}")
    volume_id, dev = next(iter(candidates))
    try:
        r = subprocess.run(["nvme", "id-ctrl", dev, "--raw-binary"],
                           capture_output=True, check=True, timeout=5)
        if len(r.stdout) != 4096:
            raise ValueError("identify controller must contain 4096 bytes")
        # NVMe Identify Controller: serial at 4; EBS attachment name in vendor data.
        actual_id = r.stdout[4:24].decode("ascii").strip(" \0").replace("-", "")
        actual_name = r.stdout[3072:3104].decode("ascii").strip(" \0").removeprefix("/dev/")
    except (OSError, subprocess.SubprocessError, ValueError) as e:
        raise Refused("volume_identity_unreadable", dev) from e
    if actual_id != volume_id.replace("-", ""):
        raise Refused("volume_id_mismatch", dev)
    if actual_name != name.removeprefix("/dev/"):
        raise Refused("data_device_name_mismatch", f"expected {name} on {dev}")
    return volume_id


def device_for_volume(cfg, volume_id):
    link = os.path.join(cfg.deviceByIdDir, "nvme-Amazon_Elastic_Block_Store_" + volume_id.replace("-", ""))
    try:
        dev = os.path.realpath(link, strict=True)
    except (OSError, TypeError):
        raise Refused("volume_device_missing", volume_id)
    st = os.stat(dev)
    if not stat.S_ISBLK(st.st_mode):
        raise Refused("volume_device_not_block", dev)
    if _device_number(st.st_rdev) in _root_devices():
        raise Refused("volume_is_root_device", dev)
    return dev


def fs_uuid(dev):
    r = subprocess.run(["blkid", "-p", "-s", "UUID", "-o", "value", dev], capture_output=True, text=True)
    return r.stdout.strip() or None


def is_mounted(path):
    return subprocess.run(["mountpoint", "-q", path]).returncode == 0


def mount_opts(path):
    return subprocess.run(["findmnt", "-n", "-o", "OPTIONS", "--target", path], capture_output=True, text=True).stdout.strip()


def mount_data(cfg, lease, mode="ro"):
    dev = device_for_volume(cfg, lease["volumeId"])
    uuid = fs_uuid(dev)
    if uuid is None:
        if not lease.get("provision"):
            raise Refused("volume_has_no_filesystem", dev)
        subprocess.run(["mkfs.ext4", "-q", "-F", "-U", lease["fsUuid"], "-L", "ezil-data", dev], check=True)
        uuid = fs_uuid(dev)
    if uuid != lease["fsUuid"]:
        raise Refused("fs_uuid_mismatch", f"device={uuid} lease={lease['fsUuid']}")
    os.makedirs(cfg.dataMount, mode=0o755, exist_ok=True)
    if is_mounted(cfg.dataMount):
        raise Refused("data_mount_busy", cfg.dataMount)
    subprocess.run(["mount", "-o", f"{mode},{MOUNT_OPTS}", dev, cfg.dataMount], check=True)
    return dev


def remount(cfg, mode):
    subprocess.run(["mount", "-o", f"remount,{mode},{MOUNT_OPTS}", cfg.dataMount], check=True)


def read_marker(root_fd):
    try:
        st = os.stat(MARKER, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    raw = read_regular_at(root_fd, MARKER, st, limit=65536)
    if raw is None:
        raise Refused("marker_malformed", "not a regular file")
    try:
        m = json.loads(raw)
    except ValueError:
        raise Refused("marker_malformed", "not json")
    ok = (isinstance(m, dict)
          and all(isinstance(m.get(k), str) for k in ("computerId", "volumeId", "fsUuid", "lowerImageDigest"))
          and all(isinstance(m.get(k), int) and not isinstance(m.get(k), bool) and m[k] >= 0
                  for k in ("generation", "leaseEpoch")))
    if not ok:
        raise Refused("marker_malformed", "fields")
    return m


def read_rebase_state(root_fd):
    try:
        os.stat(REBASE_STATE, dir_fd=root_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None
    raw = read_regular_at(root_fd, REBASE_STATE, limit=65536)
    try:
        return json.loads(raw) if raw is not None else {"state": "unreadable"}
    except ValueError:
        return {"state": "unreadable"}


def check_marker(m, lease, host_digest):
    """Pure C-4 comparison. Returns 'ok' or 'rebase_needed'; raises Refused otherwise."""
    for k, code in (("computerId", "computer_id_mismatch"), ("volumeId", "volume_id_mismatch"),
                    ("fsUuid", "fs_uuid_mismatch")):
        if m[k] != lease[k]:
            raise Refused(code, f"marker={m[k]}")
    if m["generation"] > lease["generation"]:
        raise Refused("generation_ahead", f"marker={m['generation']} lease={lease['generation']}")
    if m["leaseEpoch"] >= lease["leaseEpoch"]:
        raise Refused("epoch_not_increasing", f"marker={m['leaseEpoch']} lease={lease['leaseEpoch']}")
    if m["lowerImageDigest"] != host_digest:
        return "rebase_needed"
    return "ok"


def new_marker(lease, digest):
    return {"computerId": lease["computerId"], "volumeId": lease["volumeId"], "fsUuid": lease["fsUuid"],
            "generation": lease["generation"], "leaseEpoch": lease["leaseEpoch"], "lowerImageDigest": digest}


def run_guard(cfg, lease, rebase_runner=None):
    """Steps 1-6. Leaves the data volume mounted rw on success; unmounted on refusal."""
    digest = cfgmod.host_digest(cfg)
    stamp = os.path.join(cfg.runDir, "guard-ok")
    try:
        os.unlink(stamp)
    except FileNotFoundError:
        pass
    mount_data(cfg, lease, "ro")
    try:
        if "ro" not in mount_opts(cfg.dataMount).split(","):
            raise Refused("not_readonly")
        root = os.open(cfg.dataMount, DIR_FLAGS)
        try:
            state = read_rebase_state(root)
            if state is not None:
                raise Refused("rebase_failed", f"state={state.get('state')}; restore the pre-rebase snapshot")
            m = read_marker(root)
            if m is None:
                entries = [e for e in os.listdir(root) if e != "lost+found"]
                if not lease.get("provision") or entries:
                    raise Refused("marker_missing", "init only on a provisioning lease and an empty volume")
                verdict = "init"
            else:
                verdict = check_marker(m, lease, digest)
            if verdict == "rebase_needed":
                if rebase_runner is None or not lease.get("rebase"):
                    raise Refused("lower_digest_mismatch", f"marker={m['lowerImageDigest']} host={digest}")
                r = lease["rebase"]
                if r["fromDigest"] != m["lowerImageDigest"] or r["toDigest"] != digest:
                    raise Refused("rebase_receipt_mismatch", "receipt digests do not match marker/host")
                if not os.path.isdir(cfgmod.lower_dir(cfg, r["fromDigest"])):
                    raise Refused("rebase_old_lower_missing", r["fromDigest"])
            os.close(root)
            root = None
            remount(cfg, "rw")
            root = os.open(cfg.dataMount, DIR_FLAGS)
            if verdict == "rebase_needed":
                rebase_runner(cfg, lease, root)        # raises Refused('rebase_failed') on failure
            for d in ("root/upper", "root/work", "workspace", "profiles"):
                _mkdirs_nofollow(root, d)          # not reachable by the guest: refuse if odd
            quarantined = []
            for d in GUEST_LAYOUT:
                q = _ensure_guest_dir(root, d)       # guest-writable: move an odd entry aside
                if q:
                    quarantined.append(q)
            if quarantined:
                verdict += " quarantined=" + ",".join(quarantined)
            # the marker is bumped only after every check, rebase and layout step passed
            write_file_durable_at(root, MARKER, (json.dumps(new_marker(lease, digest)) + "\n").encode(), 0o600)
        finally:
            if root is not None:
                os.close(root)
    except BaseException:
        subprocess.run(["umount", cfg.dataMount])
        raise
    os.makedirs(cfg.runDir, mode=0o700, exist_ok=True)
    with open(stamp, "w") as f:
        json.dump({"generation": lease["generation"], "leaseEpoch": lease["leaseEpoch"]}, f)
    return verdict


# Profile dirs live inside the /var/lib/ezil-profiles bind, so guest root can replace
# them with a symlink, FIFO or file. Refusing would block the computer forever; instead
# the odd entry is renamed aside (rename never follows) and a real directory created.
GUEST_LAYOUT = ("profiles/chrome", "profiles/code-server-data", "profiles/code-server-extensions")


def _ensure_guest_dir(root, rel):
    parent, leaf = rel.rsplit("/", 1)
    pfd = os.open(parent, DIR_FLAGS, dir_fd=root)
    try:
        try:
            st = os.stat(leaf, dir_fd=pfd, follow_symlinks=False)
        except FileNotFoundError:
            st = None
        moved = None
        if st is not None and not stat.S_ISDIR(st.st_mode):
            moved = f"{leaf}.ezil-quarantine-{int(time.time())}-{os.getpid()}"
            os.rename(leaf, moved, src_dir_fd=pfd, dst_dir_fd=pfd)
        if st is None or moved:
            os.mkdir(leaf, 0o755, dir_fd=pfd)
        os.close(os.open(leaf, DIR_FLAGS, dir_fd=pfd))      # must now be a real directory
        os.fsync(pfd)
        return f"{parent}/{moved}" if moved else None
    finally:
        os.close(pfd)


def _mkdirs_nofollow(root, rel):
    fd = os.dup(root)
    try:
        for comp in rel.split("/"):
            try:
                os.mkdir(comp, 0o755, dir_fd=fd)
            except FileExistsError:
                pass
            nfd = os.open(comp, DIR_FLAGS, dir_fd=fd)      # a planted symlink refuses (ELOOP)
            os.close(fd)
            fd = nfd
    except OSError as e:
        raise Refused("layout_not_a_real_directory", f"{rel}: {os.strerror(e.errno)}")
    finally:
        os.close(fd)


def clear_stamp(cfg):
    try:
        os.unlink(os.path.join(cfg.runDir, "guard-ok"))
    except FileNotFoundError:
        pass


def assert_data_mounted(cfg, lease):
    """The upper must be on THIS lease's data volume — never on the host root disk.
    Checks: dataMount is a mount point whose source is the lease's volume device, the
    device's fs UUID is the lease's, and the upper dir resolves to that same mount."""
    dev = device_for_volume(cfg, lease["volumeId"])
    if not is_mounted(cfg.dataMount):
        raise Refused("data_not_mounted", cfg.dataMount)
    src = subprocess.run(["findmnt", "-n", "-o", "SOURCE", "--mountpoint", cfg.dataMount],
                         capture_output=True, text=True).stdout.strip()
    if os.path.realpath(src) != dev:
        raise Refused("data_mount_wrong_device", f"mounted={src} lease={dev}")
    if fs_uuid(dev) != lease["fsUuid"]:
        raise Refused("fs_uuid_mismatch", "mounted device")
    upper = os.path.join(cfg.dataMount, "root", "upper")
    usrc = subprocess.run(["findmnt", "-n", "-o", "SOURCE", "-T", upper], capture_output=True, text=True).stdout.strip()
    if os.path.realpath(usrc) != dev:
        raise Refused("upper_not_on_data_volume", f"{upper} is on {usrc}")


def require_stamp(cfg, lease):
    """Every downstream unit calls this: nothing starts unless THIS lease passed the guard
    AND the guarded data volume is still the one mounted (data-down removes the stamp;
    a manual umount or a different device is caught by the mount check)."""
    try:
        with open(os.path.join(cfg.runDir, "guard-ok")) as f:
            s = json.load(f)
    except (OSError, ValueError):
        raise Refused("guard_not_passed")
    if s != {"generation": lease["generation"], "leaseEpoch": lease["leaseEpoch"]}:
        raise Refused("guard_stamp_stale", json.dumps(s))
    assert_data_mounted(cfg, lease)
