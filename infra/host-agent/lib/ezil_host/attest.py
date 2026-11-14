"""Read-only lower attestation of a snapshot CLONE (NULL recorded lower recovery).

Never a lease, enrollment, rebind or guest operation. The clone's block device is set
read-only in the kernel, mounted ro,noload at a private directory, the marker bytes are
read once and the device is unmounted. Nothing on the clone is created, written or
replayed; the original volume is never named here except as the marker's expected
volumeId. The receipt is evidence only: the server re-proves every field it can.
"""
import argparse
import base64
import hashlib
import json
import os
import re
import secrets
import stat
import subprocess
from datetime import datetime, timezone

from . import guard, lease as leasemod, restore
from .fsops import DIR_FLAGS, Refused, read_regular_at

RECEIPT_KIND = 'ezil-lower-attestation-receipt'
MOUNT_FLAGS = 'ro,noload,nosuid,nodev,noexec'
UUID_RE = re.compile(r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')
VOL_RE = re.compile(r'vol-[0-9a-f]{17}')
SNAP_RE = re.compile(r'snap-[0-9a-f]{17}')
IID_RE = re.compile(r'i-[0-9a-f]{17}')
DIGEST_RE = re.compile(r'sha256:[0-9a-f]{64}')
CHALLENGE_RE = re.compile(r'[0-9a-f]{64}')
# The SSM delivery's private directory: the one canonical command creates it 0700 (`install -d -m 700
# /run/ezil-attest`) before running this module. A fresh maintenance host has no cfg.runDir, and none is used.
ATTEST_RUN = '/run'
ATTEST_PARENT = 'ezil-attest'
ROOT_UID = 0
WORKSPACE_INVALID = 'attest_workspace_invalid'


def _arg(pattern):
    def check(value):
        if not pattern.fullmatch(value):
            raise argparse.ArgumentTypeError('invalid')
        return value
    return check


def _counter(value):
    if not re.fullmatch(r'0|[1-9][0-9]{0,15}', value):
        raise argparse.ArgumentTypeError('invalid')
    return int(value)


def parse_args(argv):
    p = argparse.ArgumentParser(prog='ezil-host-agent attest-lower', add_help=False)
    p.add_argument('--attestation-id', required=True, type=_arg(UUID_RE))
    p.add_argument('--computer-id', required=True, type=_arg(UUID_RE))
    p.add_argument('--original-volume-id', required=True, type=_arg(VOL_RE))
    p.add_argument('--clone-volume-id', required=True, type=_arg(VOL_RE))
    p.add_argument('--snapshot-id', required=True, type=_arg(SNAP_RE))
    p.add_argument('--fs-uuid', required=True, type=_arg(UUID_RE))
    p.add_argument('--instance-id', required=True, type=_arg(IID_RE))
    p.add_argument('--generation', required=True, type=_counter)
    p.add_argument('--lease-epoch', required=True, type=_counter)
    p.add_argument('--challenge', required=True, type=_arg(CHALLENGE_RE))
    a = p.parse_args(argv)
    if a.clone_volume_id == a.original_volume_id:
        raise Refused('original_volume_named')
    return a


def check_marker(m, a):
    """The clone's marker names the ORIGINAL volume, this computer and fs, no other source
    instance, and exactly the reserved generation and lease epoch. An older marker without
    instanceId is reported as it is; the server then requires usage-ledger provenance."""
    if not isinstance(m, dict):
        raise Refused('marker_missing')
    for key, value, code in (('computerId', a.computer_id, 'computer_id_mismatch'),
                             ('volumeId', a.original_volume_id, 'volume_id_mismatch'),
                             ('fsUuid', a.fs_uuid, 'fs_uuid_mismatch')):
        if m[key] != value:
            raise Refused(code)
    if m.get('instanceId') is not None and m['instanceId'] != a.instance_id:
        raise Refused('instance_id_mismatch')
    # The marker's writer is exactly the reserved allocation: no older or newer generation or epoch.
    if m['generation'] != a.generation:
        raise Refused('generation_mismatch')
    if m['leaseEpoch'] != a.lease_epoch:
        raise Refused('epoch_mismatch')
    if not DIGEST_RE.fullmatch(m['lowerImageDigest']):
        raise Refused('marker_malformed', 'lowerImageDigest')
    return m


def read_clone(root, a):
    """Marker raw bytes and their validated object, from one read-only directory fd."""
    if guard.read_rebase_state(root) is not None:
        raise Refused('rebase_failed')
    state = restore.read_state(root)
    if state is not None and state['state'] != 'done':
        raise Refused('restore_incomplete')
    marker = check_marker(guard.read_marker(root), a)
    raw = read_regular_at(root, guard.MARKER, limit=65536)
    # Read-only mount: the second read sees the same bytes, or the clone is refused.
    if raw is None or leasemod.strict_json(raw) != marker:
        raise Refused('marker_malformed', 'unstable')
    return raw, marker


def _run(argv):
    return subprocess.run(argv, capture_output=True, text=True)


def _require_readonly_device(dev):
    if _run(['findmnt', '-n', '--source', dev]).returncode == 0:
        raise Refused('clone_already_mounted')
    # A journal that needs replay would be read past with noload: an inconsistent view is no measurement.
    header = _run(['dumpe2fs', '-h', dev])
    features = [line for line in header.stdout.splitlines() if line.startswith('Filesystem features:')]
    if header.returncode != 0 or len(features) != 1:
        raise Refused('fs_state_unknown')
    if 'needs_recovery' in features[0].split(':', 1)[1].split():
        raise Refused('needs_recovery')
    if _run(['blockdev', '--setro', dev]).returncode != 0 or _run(['blockdev', '--getro', dev]).stdout.strip() != '1':
        raise Refused('not_readonly', 'blockdev')


def _open_owned_dir(name, dir_fd, mode_ok, what):
    """No-follow open of a root-owned directory whose permission bits pass mode_ok; refused, never repaired."""
    try:
        fd = os.open(name, DIR_FLAGS, dir_fd=dir_fd)
    except OSError as e:
        raise Refused(WORKSPACE_INVALID, what) from e
    st = os.fstat(fd)
    if not stat.S_ISDIR(st.st_mode) or st.st_uid != ROOT_UID or not mode_ok(stat.S_IMODE(st.st_mode)):
        os.close(fd)
        raise Refused(WORKSPACE_INVALID, what)
    return fd, st


def _is(path, st):
    try:
        now = os.stat(path, follow_symlinks=False)
    except OSError:
        return False
    return stat.S_ISDIR(now.st_mode) and (now.st_dev, now.st_ino) == (st.st_dev, st.st_ino)


class MountDir:
    """A fresh empty 0700 directory created by this run inside ATTEST_RUN/ATTEST_PARENT. /run must be root's and
    not group- or world-writable; the parent root's and exactly 0700; the child root's and exactly 0700. mount(8)
    is given the canonical path, which reprove() binds to the retained descriptors just before use; close()
    removes only the directory this run created, by name in the verified parent, and only while it is still that
    directory and empty."""

    def __init__(self):
        self.parent_fd = self.child_fd = None
        run_fd, self.run_st = _open_owned_dir(ATTEST_RUN, None, lambda m: not m & 0o022, 'run')
        try:
            self.parent_fd, self.parent_st = _open_owned_dir(ATTEST_PARENT, run_fd, lambda m: m == 0o700, 'parent')
        finally:
            os.close(run_fd)
        self.name = 'mnt-' + secrets.token_hex(8)
        try:
            os.mkdir(self.name, 0o700, dir_fd=self.parent_fd)
        except OSError as e:
            os.close(self.parent_fd)
            raise Refused(WORKSPACE_INVALID, 'child') from e
        self.path = f'{ATTEST_RUN}/{ATTEST_PARENT}/{self.name}'
        try:
            self.child_fd, self.child_st = _open_owned_dir(self.name, self.parent_fd, lambda m: m == 0o700, 'child')
        except Refused:
            self.child_st = None
            self.close()
            raise

    def reprove(self):
        if not (_is(ATTEST_RUN, self.run_st) and _is(f'{ATTEST_RUN}/{ATTEST_PARENT}', self.parent_st)
                and _is(self.path, self.child_st)):
            raise Refused(WORKSPACE_INVALID, 'moved')

    def close(self):
        if self.child_fd is not None:
            os.close(self.child_fd)
            self.child_fd = None
        if self.parent_fd is None:
            return
        try:
            now = os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
            # Unset child_st (verification refused) still names our own mkdir: rmdir refuses a non-empty one.
            if self.child_st is None or (now.st_dev, now.st_ino) == (self.child_st.st_dev, self.child_st.st_ino):
                os.rmdir(self.name, dir_fd=self.parent_fd)
        except OSError:
            pass
        finally:
            os.close(self.parent_fd)
            self.parent_fd = None


def instance_identity(cfg):
    """The maintenance host's signed identity (document, pkcs7). The server verifies the
    signature; the AMI it names is the trusted-AMI proof."""
    imds = leasemod.Imds(cfg)
    token = imds._token()
    document = imds.get('/latest/dynamic/instance-identity/document', token).decode('utf-8')
    signature = imds.get('/latest/dynamic/instance-identity/pkcs7', token).decode('ascii').strip()
    iid = json.loads(document).get('instanceId')
    if not isinstance(iid, str) or not IID_RE.fullmatch(iid):
        raise Refused('identity_invalid')
    return iid, document, signature


def attest(cfg, a, now=None):
    maintenance_iid, document, signature = instance_identity(cfg)
    if maintenance_iid == a.instance_id:
        raise Refused('maintenance_is_source')
    dev = guard.device_for_volume(cfg, a.clone_volume_id)
    if guard.fs_uuid(dev) != a.fs_uuid:
        raise Refused('fs_uuid_mismatch')
    _require_readonly_device(dev)
    ws = MountDir()
    mnt = ws.path
    mounted = False
    try:
        ws.reprove()
        subprocess.run(['mount', '-t', 'ext4', '-o', MOUNT_FLAGS, dev, mnt], check=True)
        mounted = True
        opts = sorted(set(guard.mount_opts(mnt).split(',')))
        # findmnt normally renders ext4's noload as norecovery.
        if 'rw' in opts or not {'ro', 'nosuid', 'nodev', 'noexec'} <= set(opts) or not {'noload', 'norecovery'} & set(opts):
            raise Refused('not_readonly')
        root = os.open(mnt, DIR_FLAGS)
        try:
            raw, marker = read_clone(root, a)
        finally:
            os.close(root)
    finally:
        if mounted:
            subprocess.run(['umount', mnt])
        ws.close()
    observed = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {'v': 1, 'kind': RECEIPT_KIND, 'attestationId': a.attestation_id, 'computerId': a.computer_id,
            'originalVolumeId': a.original_volume_id, 'cloneVolumeId': a.clone_volume_id, 'snapshotId': a.snapshot_id,
            'fsUuid': a.fs_uuid, 'sourceInstanceId': a.instance_id, 'generation': a.generation, 'leaseEpoch': a.lease_epoch,
            'challenge': a.challenge,
            'maintenanceInstanceId': maintenance_iid, 'identityDocument': document, 'identitySignature': signature,
            'mountOptions': opts, 'blockDeviceReadOnly': True,
            'markerBase64': base64.b64encode(raw).decode('ascii'), 'markerSha256': hashlib.sha256(raw).hexdigest(),
            'lowerImageDigest': marker['lowerImageDigest'],
            'observedAt': observed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}


def main(cfg, argv):
    """Prints exactly one canonical receipt line on success (0); REFUSE <code> otherwise (2).
    Self-contained: the pinned SSM delivery runs this module without the AMI's cli."""
    try:
        try:
            a = parse_args(argv)
        except SystemExit:
            raise Refused('arguments_invalid')
        receipt = attest(cfg, a)
    except Refused as e:
        print(f'REFUSE {e.code}', flush=True)
        return 2
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')), flush=True)
    return 0
