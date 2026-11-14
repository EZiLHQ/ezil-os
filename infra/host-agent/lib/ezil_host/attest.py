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
import subprocess
import tempfile
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
    a = p.parse_args(argv)
    if a.clone_volume_id == a.original_volume_id:
        raise Refused('original_volume_named')
    return a


def check_marker(m, a):
    """The clone's marker names the ORIGINAL volume, this computer and fs, the source
    instance that took its epoch, and is not ahead of the reserved placement."""
    if not isinstance(m, dict):
        raise Refused('marker_missing')
    for key, value, code in (('computerId', a.computer_id, 'computer_id_mismatch'),
                             ('volumeId', a.original_volume_id, 'volume_id_mismatch'),
                             ('fsUuid', a.fs_uuid, 'fs_uuid_mismatch')):
        if m[key] != value:
            raise Refused(code)
    if m.get('instanceId') is None:
        raise Refused('marker_instance_unknown')
    if m['instanceId'] != a.instance_id:
        raise Refused('instance_id_mismatch')
    if m['generation'] > a.generation:
        raise Refused('generation_ahead')
    if m['leaseEpoch'] > a.lease_epoch:
        raise Refused('epoch_ahead')
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
    if _run(['blockdev', '--setro', dev]).returncode != 0 or _run(['blockdev', '--getro', dev]).stdout.strip() != '1':
        raise Refused('not_readonly', 'blockdev')


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
    mnt = tempfile.mkdtemp(prefix='ezil-attest-', dir=cfg.runDir)
    mounted = False
    try:
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
        try:
            os.rmdir(mnt)
        except OSError:
            pass
    observed = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return {'v': 1, 'kind': RECEIPT_KIND, 'attestationId': a.attestation_id, 'computerId': a.computer_id,
            'originalVolumeId': a.original_volume_id, 'cloneVolumeId': a.clone_volume_id, 'snapshotId': a.snapshot_id,
            'fsUuid': a.fs_uuid, 'sourceInstanceId': a.instance_id, 'generation': a.generation, 'leaseEpoch': a.lease_epoch,
            'maintenanceInstanceId': maintenance_iid, 'identityDocument': document, 'identitySignature': signature,
            'mountOptions': opts, 'blockDeviceReadOnly': True,
            'markerBase64': base64.b64encode(raw).decode('ascii'), 'markerSha256': hashlib.sha256(raw).hexdigest(),
            'lowerImageDigest': marker['lowerImageDigest'],
            'observedAt': observed.isoformat(timespec='milliseconds').replace('+00:00', 'Z')}


def main(cfg, argv):
    """Prints exactly one canonical receipt line on success; REFUSE <code> otherwise."""
    try:
        a = parse_args(argv)
    except SystemExit:
        raise Refused('arguments_invalid')
    receipt = attest(cfg, a)
    print(json.dumps(receipt, sort_keys=True, separators=(',', ':')), flush=True)
    return 0
