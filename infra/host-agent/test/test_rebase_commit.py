"""Real durable files; mount and subprocess doubles require no privileges."""
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from ezil_host import config, fsops, guard, rebase

OLD, NEW = ('sha256:' + c * 64 for c in 'ab')
IID = 'i-' + '1' * 17
LEASE = dict(v=1, computerId='11111111-1111-4111-8111-111111111111',
             volumeId='vol-' + '1' * 17, fsUuid='22222222-2222-4222-8222-222222222222',
             generation=2, leaseEpoch=2, nonce='n' * 43, provision=False)
RECEIPT = dict(snapshotId='snap-' + '1' * 17, volumeId=LEASE['volumeId'], fromDigest=OLD, toDigest=NEW)


def permit(lease=LEASE):
    now = datetime.now(timezone.utc)
    fmt = lambda d: d.isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return dict(v=1, preparationJobId='33333333-3333-4333-8333-333333333333',
                launchJobId='44444444-4444-4444-8444-444444444444',
                **{k: lease[k] for k in ('computerId', 'fsUuid', 'generation', 'leaseEpoch')},
                fenceToken='55555555-5555-4555-8555-555555555555',
                issuedAt=fmt(now), expiresAt=fmt(now + timedelta(seconds=600)))


class Crash(BaseException):
    pass


class GuardFiles(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg.update(dataMount=str(self.base / 'data'), runDir=str(self.base / 'run'),
                        stateDir=str(self.base / 'state'), lowersDir=str(self.base / 'lowers'))
        Path(self.cfg.dataMount).mkdir()
        Path(self.cfg.runDir).mkdir()
        Path(config.lower_dir(self.cfg, OLD)).mkdir(parents=True)
        self.lease = dict(LEASE, rebase=dict(RECEIPT), rebasePermit=permit())
        self.marker = guard.new_marker(dict(LEASE, generation=1, leaseEpoch=1), OLD, IID)
        self.write(guard.MARKER, self.marker)
        for target, kw in ((guard, dict(mount_data=mock.DEFAULT, remount=mock.DEFAULT)),):
            p = mock.patch.multiple(target, **kw)
            p.start()
            self.addCleanup(p.stop)
        for target, name, value in ((guard, 'mount_opts', 'ro,nosuid,nodev'),
                                     (guard, 'current_instance_id', IID),
                                     (config, 'host_digest', NEW),
                                     (guard.subprocess, 'run', mock.Mock(returncode=0))):
            p = mock.patch.object(target, name, return_value=value)
            p.start()
            self.addCleanup(p.stop)

    def write(self, name, value):
        (Path(self.cfg.dataMount) / name).write_text(json.dumps(value))

    def read(self, name):
        return json.loads((Path(self.cfg.dataMount) / name).read_text())

    def worker(self, cfg, lease, root, deadline=None):
        fsops.write_file_durable_at(root, guard.REBASE_STATE, b'{"state":"in_progress"}')

    def go(self):
        return guard.run_guard(self.cfg, self.lease, rebase_runner=self.worker)

    def assert_blocked(self):
        self.assertFalse((Path(self.cfg.runDir) / 'guard-ok').exists())
        with self.assertRaisesRegex(fsops.Refused, 'rebase_failed'):
            self.go()


class CommitOrdering(GuardFiles):
    def test_crash_before_marker_keeps_old_marker_and_sticky_state(self):
        real = guard.write_file_durable_at
        def write(fd, name, *args):
            if name == guard.MARKER:
                raise Crash()
            return real(fd, name, *args)
        with mock.patch.object(guard, 'write_file_durable_at', side_effect=write):
            with self.assertRaises(Crash):
                self.go()
        self.assertEqual(self.read(guard.MARKER), self.marker)
        self.assert_blocked()

    def test_crash_after_marker_commit_is_sticky_even_with_new_marker(self):
        with mock.patch.object(guard, 'unlink_durable_at', side_effect=Crash()):
            with self.assertRaises(Crash):
                self.go()
        self.assertEqual(self.read(guard.MARKER)['lowerImageDigest'], NEW)
        self.assert_blocked()

    def test_layout_failure_never_commits_or_clears_state(self):
        with mock.patch.object(guard, '_mkdirs_nofollow', side_effect=fsops.Refused('layout')):
            with self.assertRaisesRegex(fsops.Refused, 'layout'):
                self.go()
        self.assertEqual(self.read(guard.MARKER), self.marker)
        self.assert_blocked()

    def test_success_commits_before_cleanup_and_stamp(self):
        real = guard.unlink_durable_at
        def unlink(fd, name):
            self.assertEqual(self.read(guard.MARKER)['lowerImageDigest'], NEW)
            self.assertFalse((Path(self.cfg.runDir) / 'guard-ok').exists())
            real(fd, name)
        with mock.patch.object(guard, 'unlink_durable_at', side_effect=unlink) as cleanup:
            self.go()
        cleanup.assert_called_once()
        self.assertFalse((Path(self.cfg.dataMount) / guard.REBASE_STATE).exists())
        self.assertTrue((Path(self.cfg.runDir) / 'guard-ok').exists())

    def test_subprocess_success_leaves_state_for_guard(self):
        fd = os.open(self.cfg.dataMount, fsops.DIR_FLAGS)
        try:
            with mock.patch('subprocess.run', return_value=mock.Mock(returncode=0, stdout='{}')):
                rebase.run_job(self.cfg, self.lease, fd)
        finally:
            os.close(fd)
        self.assertEqual(self.read(guard.REBASE_STATE)['state'], 'in_progress')

    def test_marker_fsync_failure_does_not_clear_state(self):
        with mock.patch.object(guard, 'write_file_durable_at', side_effect=OSError(28, 'full')):
            with self.assertRaises(OSError):
                self.go()
        self.assert_blocked()


class MetadataEquality(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        for tree in ('upper', 'old', 'new'):
            (self.root / tree / 'etc').mkdir(parents=True)
            (self.root / tree / 'etc/config').write_text('same bytes')
            (self.root / tree / 'var/lib/dpkg').mkdir(parents=True)
            (self.root / tree / 'var/lib/dpkg/status').write_text('Package: test\nVersion: 1\n')
        self.upper = self.root / 'upper/etc/config'
        self.old = self.root / 'old/etc/config'

    def run_rebase(self):
        with mock.patch.object(rebase.os, 'sync'):
            return rebase.rebase(*(str(self.root / x) for x in ('upper', 'old', 'new')))

    def test_identical_xattrs_may_be_removed(self):
        for p in (self.upper, self.old):
            os.setxattr(p, 'user.test', b'same')
        self.run_rebase()
        self.assertFalse(self.upper.exists())

    def test_modified_xattr_is_kept(self):
        os.setxattr(self.upper, 'user.test', b'user change')
        self.run_rebase()
        self.assertEqual(os.getxattr(self.upper, 'user.test'), b'user change')

    def test_removed_xattr_is_kept(self):
        os.setxattr(self.old, 'user.test', b'image metadata')
        self.run_rebase()
        self.assertTrue(self.upper.exists())

    def test_modified_acl_with_equal_mode_is_kept(self):
        # Linux POSIX ACL xattr: owner, named user, group, mask, other.
        def acl(perm):
            entries = [(1, 6, 0xffffffff), (2, perm, os.getuid()), (4, 4, 0xffffffff),
                       (16, 4, 0xffffffff), (32, 4, 0xffffffff)]
            return struct.pack('<I', 2) + b''.join(struct.pack('<HHI', *e) for e in entries)
        os.setxattr(self.old, 'system.posix_acl_access', acl(4))
        os.setxattr(self.upper, 'system.posix_acl_access', acl(0))
        self.assertEqual(self.old.stat().st_mode, self.upper.stat().st_mode)
        self.run_rebase()
        self.assertEqual(os.getxattr(self.upper, 'system.posix_acl_access'), acl(0))

    def test_unreadable_xattrs_never_count_as_identical(self):
        with mock.patch.object(rebase.os, 'listxattr', side_effect=OSError(5, 'io')):
            self.run_rebase()
        self.assertTrue(self.upper.exists())


class DurableWrites(unittest.TestCase):
    def test_short_writes_and_removal_fsync(self):
        with tempfile.TemporaryDirectory() as tmp:
            fd = os.open(tmp, fsops.DIR_FLAGS)
            self.addCleanup(os.close, fd)
            real = os.write
            with mock.patch.object(fsops.os, 'write', side_effect=lambda f, b: real(f, b[:2])):
                fsops.write_file_durable_at(fd, 'marker', b'abcdefgh')
            self.assertEqual((Path(tmp) / 'marker').read_bytes(), b'abcdefgh')
            with mock.patch.object(fsops.os, 'fsync', wraps=os.fsync) as sync:
                fsops.unlink_durable_at(fd, 'marker')
            sync.assert_called_once_with(fd)
