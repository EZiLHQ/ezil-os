"""Data-volume mount and the C-4 marker guard.

Order (each step refuses before anything is written):
  1. resolve the block device from the lease's volumeId (Nitro NVMe serial under
     /dev/disk/by-id), require a block device, read its filesystem UUID;
  2. provision only: an unformatted device verified entirely zero with lease.provision=true is
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
import math
import os
import re
import stat
import subprocess
import sys
import time

from . import canary, config as cfgmod
from .fsops import DIR_FLAGS, Refused, read_regular_at, write_file_durable_at

MARKER = ".ezil-marker.json"
INSTANCE_ID_RE = re.compile(r"i-[0-9a-f]{3,17}")
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


def _ebs_candidates(cfg, roots):
    """Attached non-root EBS disks as {(volume-id, device)}."""
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
    return candidates


def provision_volume(cfg):
    """Resolve exactly one non-root EBS disk, then verify its EC2 attachment name."""
    name = cfg.dataDeviceName
    if not isinstance(name, str) or not re.fullmatch(r"/dev/[A-Za-z0-9]+", name):
        raise Refused("data_device_name_invalid")
    candidates = _ebs_candidates(cfg, _root_devices())
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


def _volume_link(cfg, volume_id):
    return os.path.join(cfg.deviceByIdDir, "nvme-Amazon_Elastic_Block_Store_" + volume_id.replace("-", ""))


def _await_volume(cfg, attached):
    """Bounded wait for the data volume. The lifecycle attaches it only once EC2 reports the
    instance running (infra/app-computers/lib/lifecycle/helper.ts), so this host chain can
    start first. Returns when `attached()` holds or the wait ends; the caller then resolves
    (or refuses) exactly as without the wait."""
    deadline = time.monotonic() + float(cfg.get("volumeWaitSeconds", 300))
    interval = float(cfg.get("volumeWaitIntervalSeconds", 2))
    while not attached() and time.monotonic() < deadline:
        time.sleep(interval)


def wait_provision_volume(cfg):
    """`provision_volume`, after a bounded wait for any non-root EBS disk to attach."""
    roots = _root_devices()
    _await_volume(cfg, lambda: bool(_ebs_candidates(cfg, roots)))
    return provision_volume(cfg)


def wait_device_for_volume(cfg, volume_id):
    """`device_for_volume`, after a bounded wait for the volume's by-id link."""
    link = _volume_link(cfg, volume_id)

    def attached():
        try:
            os.path.realpath(link, strict=True)
            return True
        except (OSError, TypeError):
            return False
    _await_volume(cfg, attached)
    return device_for_volume(cfg, volume_id)


def device_for_volume(cfg, volume_id):
    link = _volume_link(cfg, volume_id)
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
    """An ext4 UUID, or None after successful independent no-signature probing.

    A failed probe is not an empty disk. Read all tags so a partition table or a
    filesystem lacking a UUID cannot become permission to format a used volume.
    """
    try:
        r = subprocess.run(["blkid", "-p", "-o", "export", dev],
                           capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused("volume_signature_unreadable", dev) from e
    if r.returncode == 2 and not r.stdout.strip() and not r.stderr.strip():
        # blkid also returns this for a missing/unreadable device. Its result alone
        # must never authorize mkfs. wipefs --no-act fails if initialization/read
        # fails and also sees signatures without filesystem UUIDs.
        try:
            probe = subprocess.run(["wipefs", "--no-act", "--json", dev],
                                   capture_output=True, text=True, timeout=10)
            if probe.returncode != 0 or probe.stderr.strip():
                raise Refused("volume_signature_unreadable", dev)
            signatures = json.loads(probe.stdout)
            if not isinstance(signatures, dict) or not isinstance(signatures.get("signatures"), list):
                raise Refused("volume_signature_unreadable", dev)
            if signatures["signatures"]:
                raise Refused("volume_signature_unsupported", dev)
        except (OSError, subprocess.SubprocessError, ValueError) as e:
            raise Refused("volume_signature_unreadable", dev) from e
        return None  # unformatted, not proof that every byte on the disk is zero
    if r.returncode != 0 or r.stderr.strip():
        raise Refused("volume_signature_unreadable", dev)
    tags = {}
    for line in r.stdout.splitlines():
        key, sep, value = line.partition("=")
        if not sep or key in tags:
            raise Refused("volume_signature_unreadable", dev)
        tags[key] = value
    if tags.get("TYPE") != "ext4" or "PTTYPE" in tags or not tags.get("UUID"):
        raise Refused("volume_signature_unsupported", dev)
    return tags["UUID"]


def is_mounted(path):
    return subprocess.run(["mountpoint", "-q", path]).returncode == 0


def mount_opts(path):
    return subprocess.run(["findmnt", "-n", "-o", "OPTIONS", "--target", path], capture_output=True, text=True).stdout.strip()


def verify_blank_device(cfg, dev):
    """Never infer blankness from a missing signature on a damaged/unknown disk."""
    seconds = cfg.get("blankVerifySeconds", 500)
    if (isinstance(seconds, bool) or not isinstance(seconds, (int, float))
            or not math.isfinite(seconds) or not 0 < seconds <= 500):
        raise Refused("volume_blank_timeout_invalid")
    try:
        mounted = subprocess.run(["findmnt", "-rn", "--source", dev],
                                 capture_output=True, text=True, timeout=5)
        if mounted.returncode == 0:
            raise Refused("volume_device_busy", dev)
        if mounted.returncode != 1 or mounted.stdout.strip() or mounted.stderr.strip():
            raise Refused("volume_mount_unknown", dev)
        result = subprocess.run([sys.executable, os.path.join(os.path.dirname(__file__), "zero_check.py"), dev, str(seconds)],
                                capture_output=True, text=True, timeout=seconds)
    except subprocess.TimeoutExpired as e:
        raise Refused("volume_blank_timeout", dev) from e
    except (OSError, subprocess.SubprocessError) as e:
        raise Refused("volume_blank_unreadable", dev) from e
    if result.returncode != 0 or result.stdout.strip() or result.stderr.strip():
        code = result.stdout.strip()
        if code not in ("volume_not_blank", "volume_blank_timeout", "volume_blank_unreadable"):
            code = "volume_blank_unreadable"
        raise Refused(code, dev)


def mount_data(cfg, lease, mode="ro"):
    dev = wait_device_for_volume(cfg, lease["volumeId"])
    if is_mounted(cfg.dataMount):
        raise Refused("data_mount_busy", cfg.dataMount)
    uuid = fs_uuid(dev)
    if uuid is None:
        if not lease.get("provision"):
            raise Refused("volume_has_no_filesystem", dev)
        verify_blank_device(cfg, dev)
        subprocess.run(["mkfs.ext4", "-q", "-F", "-U", lease["fsUuid"], "-L", "ezil-data", dev], check=True)
        uuid = fs_uuid(dev)
    if uuid != lease["fsUuid"]:
        raise Refused("fs_uuid_mismatch", f"device={uuid} lease={lease['fsUuid']}")
    os.makedirs(cfg.dataMount, mode=0o755, exist_ok=True)
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
          and (m.get("instanceId") is None or (isinstance(m["instanceId"], str) and INSTANCE_ID_RE.fullmatch(m["instanceId"])))
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


def current_instance_id(cfg):
    """This instance's id from the identity document the lease step stored (runDir), or None.
    IMDS answers only the instance itself, so it names the boot's machine."""
    try:
        with open(os.path.join(cfg.runDir, "identity.json"), encoding="utf-8") as f:
            iid = json.loads(json.load(f)["document"]).get("instanceId")
    except (OSError, ValueError, KeyError, TypeError, AttributeError):
        return None
    return iid if isinstance(iid, str) and INSTANCE_ID_RE.fullmatch(iid) else None


def check_marker(m, lease, host_digest, instance_id=None):
    """Pure C-4 comparison. Returns 'ok', 'reboot' or 'rebase_needed'; raises Refused
    otherwise. The epoch must increase, except for the SAME instance rebooting in place in the
    same (generation, epoch): the marker records which instance took the epoch, so a different
    instance replaying old user data is still refused."""
    for k, code in (("computerId", "computer_id_mismatch"), ("volumeId", "volume_id_mismatch"),
                    ("fsUuid", "fs_uuid_mismatch")):
        if m[k] != lease[k]:
            raise Refused(code, f"marker={m[k]}")
    if m["generation"] > lease["generation"]:
        raise Refused("generation_ahead", f"marker={m['generation']} lease={lease['generation']}")
    reboot = (instance_id is not None and m.get("instanceId") == instance_id
              and m["leaseEpoch"] == lease["leaseEpoch"] and m["generation"] == lease["generation"])
    if m["leaseEpoch"] >= lease["leaseEpoch"] and not reboot:
        raise Refused("epoch_not_increasing", f"marker={m['leaseEpoch']} lease={lease['leaseEpoch']}")
    if m["lowerImageDigest"] != host_digest:
        return "rebase_needed"
    return "reboot" if reboot else "ok"


def new_marker(lease, digest, instance_id=None):
    m = {"computerId": lease["computerId"], "volumeId": lease["volumeId"], "fsUuid": lease["fsUuid"],
         "generation": lease["generation"], "leaseEpoch": lease["leaseEpoch"], "lowerImageDigest": digest}
    if instance_id is not None:
        m["instanceId"] = instance_id      # which instance took this epoch (same-instance reboot)
    return m


def run_guard(cfg, lease, rebase_runner=None):
    """Steps 1-6, with optional public console diagnostics."""
    try:
        verdict = _run_guard(cfg, lease, rebase_runner)
    except Refused:
        canary.guard_result(cfg, "refused")
        raise
    except (Exception, SystemExit):
        canary.guard_result(cfg, "error")
        raise
    canary.guard_result(cfg, verdict)
    return verdict


def _run_guard(cfg, lease, rebase_runner=None):
    """Leaves the data volume mounted rw on success; unmounted on refusal."""
    digest = cfgmod.host_digest(cfg)
    instance_id = current_instance_id(cfg)
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
                verdict = check_marker(m, lease, digest, instance_id)
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
            write_file_durable_at(root, MARKER, (json.dumps(new_marker(lease, digest, instance_id)) + "\n").encode(), 0o600)
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
