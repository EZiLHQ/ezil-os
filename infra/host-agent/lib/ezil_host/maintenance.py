"""Snapshot clone rebind. No guest layout, overlay, cleanup or desktop operations."""
import json
import os
import re
import subprocess

from . import config, guard, lease as leasemod
from .fsops import DIR_FLAGS, Refused, read_regular_at, write_file_durable_at

STAMP = 'maintenance-ok'
RECEIPT = 'maintenance-enrolled.json'


def report_spec(lease):
    r = lease['ebsRestore']
    return {key: r[key] for key in ('v', 'recoveryJobId', 'snapshotId', 'originalVolumeId', 'volumeId', 'fsUuid')}


def completion(cfg, lease):
    return {'marker': guard.new_marker(lease, config.host_digest(cfg), guard.current_instance_id(cfg)),
            'authorization': lease['ebsRestore'], 'maintenance': True, 'accepted': True}


def check_source(marker, lease, digest, iid):
    r = lease['ebsRestore']
    expected = guard.new_marker(lease, digest, iid)
    if marker == expected:
        return 'rebound'
    if not isinstance(marker, dict):
        raise Refused('marker_missing')
    for key, value in (('computerId', lease['computerId']), ('fsUuid', lease['fsUuid']),
                       ('volumeId', r['originalVolumeId']), ('lowerImageDigest', r['fromDigest'])):
        if marker.get(key) != value:
            raise Refused('restore_lineage_mismatch')
    if (marker['generation'] > r['sourceGeneration'] or marker['leaseEpoch'] > r['sourceLeaseEpoch']):
        raise Refused('restore_lineage_mismatch')
    return 'source'


def inspect(root, lease, digest, iid):
    if guard.read_rebase_state(root) is not None:
        raise Refused('rebase_failed')
    # An incomplete Cloudflare restore is never a checkpoint suitable for rebind.
    state = guard.restore.read_state(root)
    if state is not None and state['state'] != 'done':
        raise Refused('restore_incomplete')
    return check_source(guard.read_marker(root), lease, digest, iid)


def run(cfg, lease):
    from .enroll import _write_private
    guard.clear_stamp(cfg)
    try:
        # Validate even if called directly with a synthesized dictionary.
        leasemod.parse(json.dumps(lease))
    except leasemod.LeaseError as e:
        raise Refused('permit_invalid') from e
    r = lease['ebsRestore']
    digest = config.host_digest(cfg)
    iid = guard.current_instance_id(cfg)
    if digest != r['fromDigest'] or not isinstance(iid, str) or not re.fullmatch(r'i-[0-9a-f]{17}', iid):
        raise Refused('restore_lineage_mismatch')
    guard.mount_data(cfg, lease, 'ro,noload')
    try:
        opts = set(guard.mount_opts(cfg.dataMount).split(','))
        # findmnt normally renders ext4's noload as norecovery.
        if not {'ro', 'nosuid', 'nodev'} <= opts or not opts.intersection({'noload', 'norecovery'}):
            raise Refused('not_readonly')
        root = os.open(cfg.dataMount, DIR_FLAGS)
        try:
            verdict = inspect(root, lease, digest, iid)
        finally:
            os.close(root)
        if verdict == 'source':
            deadline = leasemod.mutation_deadline(r)
            leasemod.require_budget(r, deadline)
            # Drop noload before enabling writes: ext4 cannot safely replay a dirty
            # journal on a remount retaining noload. Replay is confined to the clone,
            # after the read-only authority check; recheck the marker afterward.
            subprocess.run(['umount', cfg.dataMount], check=True)
            guard.mount_data(cfg, lease, 'rw')
            root = os.open(cfg.dataMount, DIR_FLAGS)
            try:
                if inspect(root, lease, digest, iid) != 'source':
                    raise Refused('restore_lineage_mismatch')
                leasemod.require_budget(r, deadline)
                write_file_durable_at(root, guard.MARKER,
                                      (json.dumps(guard.new_marker(lease, digest, iid)) + '\n').encode())
            finally:
                os.close(root)
        # Exact tuple retry after marker commit can recreate this boot's stamp.
        # This stamp never permits desktop units, even after enrollment succeeds.
        _write_private(os.path.join(cfg.runDir, STAMP),
                       json.dumps(guard.new_marker(lease, digest, iid)).encode())
        return 'maintenance_rebound'
    except BaseException:
        subprocess.run(['umount', cfg.dataMount])
        raise


def persist(cfg, lease, response):
    from . import enroll
    try:
        answer = leasemod.strict_json(response)
    except (ValueError, UnicodeError):
        raise enroll.Malformed()
    if (not isinstance(answer, dict) or set(answer) != {'maintenance', 'accepted'}
            or answer['maintenance'] is not True or answer['accepted'] is not True):
        raise enroll.Malformed()
    enroll._write_private(os.path.join(cfg.stateDir, RECEIPT), json.dumps(completion(cfg, lease)).encode())
    enroll.mark_nonce_consumed(cfg, lease)


def enroll_or_reuse(cfg, lease):
    from . import enroll
    guard.committed_digest(cfg, lease, maintenance=True)
    rec = None
    try:
        root = os.open(cfg.stateDir, DIR_FLAGS)
        try:
            raw = read_regular_at(root, RECEIPT, limit=65536)
            rec = leasemod.strict_json(raw) if raw is not None else None
        finally:
            os.close(root)
    except (OSError, ValueError):
        pass
    if rec == completion(cfg, lease):
        enroll.wipe_nonce(cfg, lease)
        return 'maintenance receipt reused'
    enroll.enroll(cfg, lease, instance_id=guard.current_instance_id(cfg))
    return 'maintenance receipt accepted'
