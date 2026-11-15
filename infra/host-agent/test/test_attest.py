"""Read-only lower attestation of a snapshot clone: no write, no rw mount, no rebind, fail closed."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from ezil_host import attest, cli, config, fsops, guard, restore

OLD = 'sha256:' + 'a' * 64
SRC = 'i-' + '1' * 17
MAINT = 'i-' + '9' * 17
COMPUTER = '11111111-1111-4111-8111-111111111111'
FS = '22222222-2222-4222-8222-222222222222'
ORIGINAL = 'vol-' + '1' * 17
CLONE = 'vol-' + '2' * 17
ARGS = ['--attestation-id', '33333333-3333-4333-8333-333333333333', '--computer-id', COMPUTER,
        '--original-volume-id', ORIGINAL, '--clone-volume-id', CLONE, '--snapshot-id', 'snap-' + '4' * 17,
        '--fs-uuid', FS, '--instance-id', SRC, '--generation', '3', '--lease-epoch', '7', '--challenge', 'c' * 64]
MARKER = {'computerId': COMPUTER, 'volumeId': ORIGINAL, 'fsUuid': FS, 'generation': 3, 'leaseEpoch': 7,
          'lowerImageDigest': OLD, 'instanceId': SRC}


class Attest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.cfg = config.Config(dict(config.DEFAULTS))
        # A fresh maintenance host: no user data, so the agent's runDir does not exist and must not be needed.
        self.cfg.update(runDir=str(self.base / 'run-dir-absent'), dataMount=str(self.base / 'data-never-used'))
        # Stands in for /run, with the private parent the canonical SSM command creates (install -d -m 700).
        self.run_root = self.base / 'run'
        self.parent = self.run_root / 'ezil-attest'
        self.make_run_tree()
        self.mnt = self.base / 'clone'
        self.mnt.mkdir()
        (self.mnt / 'workspace').mkdir()
        (self.mnt / 'workspace/user-file').write_bytes(b'customer bytes')
        self.write_marker(MARKER)
        self.calls = []
        self.opts = 'ro,nosuid,nodev,noexec,norecovery'
        self.getro = '1'
        self.mounted_already = 1
        self.features = 'Filesystem features:      has_journal ext_attr resize_inode dir_index filetype extent 64bit flex_bg sparse_super'
        self.dumpe2fs_rc = 0
        self.targets = []

        def run(argv, **kw):
            self.calls.append(list(argv))
            if argv[0] == 'mount':
                # The target is a real path a separate process could stat: record it, then show the clone's
                # entries there as a mount would; umount puts them back.
                target = argv[-1]
                self.targets.append((target, os.lstat(target)))
                self.move_entries(self.mnt, Path(target))
                return mock.Mock(returncode=0, stdout='')
            if argv[0] == 'umount':
                self.move_entries(Path(argv[1]), self.mnt)
                return mock.Mock(returncode=0, stdout='')
            if argv[:2] == ['findmnt', '-n'] and '--source' in argv:
                return mock.Mock(returncode=0 if self.mounted_already == 0 else 1, stdout='')
            if argv[:2] == ['dumpe2fs', '-h']:
                return mock.Mock(returncode=self.dumpe2fs_rc, stdout='Filesystem volume name:   ezil-data\n' + self.features + '\n')
            if argv[:2] == ['blockdev', '--getro']:
                return mock.Mock(returncode=0, stdout=self.getro + '\n')
            return mock.Mock(returncode=0, stdout='')
        for target, name, kwargs in (
                (attest.subprocess, 'run', {'side_effect': run}),
                # The production parent and root's uid, re-pointed inside this test only (create=True keeps the
                # fresh-host regression meaningful against a module that predates them).
                (attest, 'ATTEST_RUN', {'new': str(self.run_root), 'create': True}),
                (attest, 'ROOT_UID', {'new': os.getuid(), 'create': True}),
                (guard, 'device_for_volume', {'return_value': '/dev/nvme9n1'}),
                (guard, 'fs_uuid', {'return_value': FS}),
                (guard, 'mount_opts', {'side_effect': lambda path: self.opts}),
                (attest, 'instance_identity', {'return_value': (MAINT, json.dumps({'instanceId': MAINT, 'imageId': 'ami-' + '5' * 17}), 'PKCS7')})):
            p = mock.patch.object(target, name, **kwargs)
            p.start()
            self.addCleanup(p.stop)

    def make_run_tree(self):
        if self.run_root.is_symlink():
            self.run_root.unlink()
        shutil.rmtree(self.run_root, ignore_errors=True)
        self.run_root.mkdir()
        self.run_root.chmod(0o755)
        self.parent.mkdir()
        self.parent.chmod(0o700)

    @staticmethod
    def move_entries(src, dst):
        for name in sorted(os.listdir(src)):
            os.rename(src / name, dst / name)

    def mounted_at(self):
        (target, st), = self.targets
        return target, st

    def write_marker(self, value):
        self.raw = (value if isinstance(value, bytes) else json.dumps(value).encode()) + b'\n'
        (self.mnt / guard.MARKER).write_bytes(self.raw)

    def snapshot(self):
        return {str(p.relative_to(self.mnt)): (p.is_symlink(), p.is_file() and p.read_bytes(), p.lstat().st_mtime_ns)
                for p in sorted(self.mnt.rglob('*'))}

    def go(self, argv=ARGS):
        return attest.attest(self.cfg, attest.parse_args(argv))

    def assert_no_write_surface(self):
        flat = [' '.join(c) for c in self.calls]
        for c in flat:
            self.assertNotRegex(c, r'(^|[ ,])rw([ ,]|$)|remount|mkfs|--setrw|tune2fs|e2fsck')
        self.assertFalse(any(ORIGINAL in c for c in flat), 'the original volume is never touched')

    def test_receipt_binds_raw_marker_hash_and_never_writes(self):
        before = self.snapshot()
        r = self.go()
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(r['markerSha256'], hashlib.sha256(self.raw).hexdigest())
        self.assertEqual(base64.b64decode(r['markerBase64']), self.raw)
        self.assertEqual((r['lowerImageDigest'], r['maintenanceInstanceId'], r['cloneVolumeId'], r['originalVolumeId']),
                         (OLD, MAINT, CLONE, ORIGINAL))
        self.assertTrue(r['blockDeviceReadOnly'])
        self.assertNotIn('rw', r['mountOptions'])
        target, _ = self.mounted_at()
        mount = [c for c in self.calls if c[0] == 'mount']
        self.assertEqual(mount, [['mount', '-t', 'ext4', '-o', 'ro,noload,nosuid,nodev,noexec', '/dev/nvme9n1', target]])
        order = [c[:2] for c in self.calls]
        self.assertLess(order.index(['blockdev', '--setro']), order.index(['mount', '-t']))
        self.assertIn(['umount', target], self.calls)
        self.assert_no_write_surface()

    def test_marker_without_instance_is_reported_unchanged(self):
        legacy = {k: v for k, v in MARKER.items() if k != 'instanceId'}
        self.write_marker(legacy)
        r = self.go()
        self.assertEqual(json.loads(base64.b64decode(r['markerBase64'])), legacy)
        self.assertEqual(r['markerSha256'], hashlib.sha256(self.raw).hexdigest())
        self.assert_no_write_surface()

    def test_cli_prints_one_canonical_line(self):
        out = []
        with mock.patch.object(cli.config, 'load', return_value=self.cfg), \
                mock.patch('builtins.print', side_effect=lambda *a, **k: out.append(a[0])):
            self.assertEqual(cli.main(['attest-lower', *ARGS]), 0)
        self.assertEqual(len(out), 1)
        r = json.loads(out[0])
        self.assertEqual(out[0], json.dumps(r, sort_keys=True, separators=(',', ':')))

    def test_cli_refusal_exit_code(self):
        out = []
        self.write_marker(dict(MARKER, computerId='44444444-4444-4444-8444-444444444444'))
        with mock.patch.object(cli.config, 'load', return_value=self.cfg), \
                mock.patch('builtins.print', side_effect=lambda *a, **k: out.append(a[0])):
            self.assertEqual(cli.main(['attest-lower', *ARGS]), 2)
        self.assertEqual(out, ['REFUSE computer_id_mismatch'])

    def refuses(self, code, argv=ARGS, mounted=True):
        before, parent_before = self.snapshot(), sorted(os.listdir(self.parent)) if self.parent.is_dir() else None
        self.targets.clear()
        with self.assertRaises(fsops.Refused) as e:
            self.go(argv)
        self.assertEqual(e.exception.code, code)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(any(c[0] == 'umount' for c in self.calls), mounted)
        if mounted:
            self.assertIn(['umount', self.mounted_at()[0]], self.calls)
        # Only this run's own empty mount directory is ever removed, and it always is.
        if parent_before is not None and self.parent.is_dir() and not self.parent.is_symlink():
            self.assertEqual(sorted(os.listdir(self.parent)), parent_before)
        self.assertFalse(os.path.lexists(self.cfg.runDir))
        self.assert_no_write_surface()

    def test_marker_refusals(self):
        cases = [
            ('marker_missing', None),
            ('marker_malformed', b'{not json'),
            ('marker_malformed', dict(MARKER, generation='3')),
            ('computer_id_mismatch', dict(MARKER, computerId='44444444-4444-4444-8444-444444444444')),
            ('volume_id_mismatch', dict(MARKER, volumeId=CLONE)),
            ('fs_uuid_mismatch', dict(MARKER, fsUuid='55555555-5555-4555-8555-555555555555')),
            ('generation_mismatch', dict(MARKER, generation=4)),
            ('generation_mismatch', dict(MARKER, generation=2)),
            ('epoch_mismatch', dict(MARKER, leaseEpoch=8)),
            ('epoch_mismatch', dict(MARKER, leaseEpoch=6)),
            ('instance_id_mismatch', dict(MARKER, instanceId='i-' + '8' * 17)),
            ('marker_malformed', dict(MARKER, lowerImageDigest='sha256:short')),
        ]
        for code, marker in cases:
            with self.subTest(code=code, marker=marker):
                self.calls.clear()
                if marker is None:
                    (self.mnt / guard.MARKER).unlink(missing_ok=True)
                else:
                    self.write_marker(marker)
                self.refuses(code)

    def test_symlinked_marker_is_not_followed(self):
        (self.mnt / guard.MARKER).unlink()
        target = self.base / 'elsewhere.json'
        target.write_text(json.dumps(MARKER))
        (self.mnt / guard.MARKER).symlink_to(target)
        self.refuses('marker_malformed')

    def test_failed_rebase_or_incomplete_restore_is_refused(self):
        (self.mnt / guard.REBASE_STATE).write_text('{"state":"in_progress"}')
        self.refuses('rebase_failed')
        (self.mnt / guard.REBASE_STATE).unlink()
        self.calls.clear()
        (self.mnt / restore.STATE).write_text('{"state":"started"}')
        self.refuses('restore_incomplete')

    def test_device_and_mount_refusals(self):
        self.mounted_already = 0
        self.refuses('clone_already_mounted', mounted=False)
        self.mounted_already, self.getro = 1, '0'
        self.calls.clear()
        self.refuses('not_readonly', mounted=False)
        self.getro, self.opts = '1', 'rw,nosuid,nodev,noexec'
        self.calls.clear()
        self.refuses('not_readonly')
        self.opts = 'ro,nosuid,nodev,noexec'  # journal replay not disabled
        self.calls.clear()
        self.refuses('not_readonly')

    def test_journal_needing_replay_is_refused_before_mount(self):
        self.features += ' needs_recovery'
        self.refuses('needs_recovery', mounted=False)
        self.assertFalse(any(c[0] == 'mount' for c in self.calls))
        self.features, self.dumpe2fs_rc = self.features.replace(' needs_recovery', ''), 1
        self.calls.clear()
        self.refuses('fs_state_unknown', mounted=False)

    def test_receipt_echoes_the_server_challenge(self):
        self.assertEqual(self.go()['challenge'], 'c' * 64)

    def test_identity_and_argument_refusals(self):
        with mock.patch.object(guard, 'fs_uuid', return_value='55555555-5555-4555-8555-555555555555'):
            self.refuses('fs_uuid_mismatch', mounted=False)
        with self.assertRaises(fsops.Refused) as e:
            attest.parse_args([CLONE if a == ORIGINAL else a for a in ARGS])
        self.assertEqual(e.exception.code, 'original_volume_named')
        with mock.patch.object(attest, 'instance_identity', return_value=(SRC, '{}', 'x')):
            self.refuses('maintenance_is_source', mounted=False)
        out = []
        with mock.patch.object(cli.config, 'load', return_value=self.cfg), \
                mock.patch('builtins.print', side_effect=lambda *a, **k: out.append(a[0])), \
                mock.patch('sys.stderr'):
            self.assertEqual(cli.main(['attest-lower', *ARGS[:-2]]), 2)
        self.assertEqual(out, ['REFUSE arguments_invalid'])

    def test_fresh_host_without_run_dir_measures_in_the_private_parent(self):
        # Regression: tempfile.mkdtemp(dir=cfg.runDir) raised FileNotFoundError on a host without user data.
        self.assertFalse(os.path.lexists(self.cfg.runDir))
        self.assertEqual(self.go()['lowerImageDigest'], OLD)
        self.assertFalse(os.path.lexists(self.cfg.runDir))
        target, st = self.mounted_at()
        # A canonical path below the verified parent, resolvable by another process (never /proc/self/fd/N).
        self.assertRegex(target, '^' + re.escape(str(self.parent)) + r'/mnt-[0-9a-f]{16}$')
        self.assertTrue(stat.S_ISDIR(st.st_mode))
        self.assertEqual((stat.S_IMODE(st.st_mode), st.st_uid), (0o700, os.getuid()))
        self.assertEqual(os.listdir(self.parent), [])
        self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), 0o700)

    def test_untrusted_workspace_is_refused_before_mount(self):
        real = self.base / 'elsewhere-dir'
        cases = [
            ('parent missing', lambda: self.parent.rmdir()),
            ('parent symlink', lambda: (real.mkdir(), real.chmod(0o700), self.parent.rmdir(), self.parent.symlink_to(real))),
            ('parent file', lambda: (self.parent.rmdir(), self.parent.write_bytes(b''))),
            ('parent 0750', lambda: self.parent.chmod(0o750)),
            ('parent 0777', lambda: self.parent.chmod(0o777)),
            ('run group-writable', lambda: self.run_root.chmod(0o775)),
            ('run world-writable', lambda: self.run_root.chmod(0o757)),
            ('run symlink', lambda: (self.run_root.rename(real), self.run_root.symlink_to(real))),
        ]
        for name, breaks in cases:
            with self.subTest(name):
                shutil.rmtree(real, ignore_errors=True)
                self.make_run_tree()
                breaks()
                self.calls.clear()
                self.refuses('attest_workspace_invalid', mounted=False)
                self.assertFalse(any(c[0] == 'mount' for c in self.calls))
                if name == 'parent symlink':
                    self.assertEqual(os.listdir(real), [])
                # Refused, never repaired.
                if name.startswith('parent 0'):
                    self.assertEqual(stat.S_IMODE(self.parent.stat().st_mode), int(name[-4:], 8))

    def fstat_as(self, which, uid=None, mode=None):
        """os.fstat reporting another owner or mode for the parent or this run's mount directory only."""
        real_fstat = os.fstat

        def fake(fd):
            st = real_fstat(fd)
            paths = [self.parent] if which == 'parent' else [self.parent / n for n in os.listdir(self.parent) if n.startswith('mnt-')]
            if any((p.lstat().st_dev, p.lstat().st_ino) == (st.st_dev, st.st_ino) for p in paths):
                fields = list(st[:10])
                if uid is not None:
                    fields[4] = uid
                if mode is not None:
                    fields[0] = stat.S_IFDIR | mode
                return os.stat_result(fields)
            return st
        return fake

    def test_unowned_or_open_parent_and_child_are_refused_and_own_child_removed(self):
        with mock.patch.object(attest, 'ROOT_UID', os.getuid() + 1):
            self.refuses('attest_workspace_invalid', mounted=False)
        for which, kw in (('parent', {'uid': os.getuid() + 1}), ('child', {'uid': os.getuid() + 1}),
                          ('child', {'mode': 0o750}), ('child', {'mode': 0o777})):
            with self.subTest(which=which, **kw):
                self.calls.clear()
                with mock.patch.object(attest.os, 'fstat', self.fstat_as(which, **kw)):
                    self.refuses('attest_workspace_invalid', mounted=False)
                self.assertEqual(os.listdir(self.parent), [])

    def test_existing_child_name_is_refused_and_left_alone(self):
        name = 'mnt-' + 'f' * 16
        for kind, make in (('symlink', lambda p: p.symlink_to(self.mnt)), ('file', lambda p: p.write_bytes(b'not ours')),
                           ('directory', lambda p: p.mkdir())):
            with self.subTest(kind):
                self.make_run_tree()
                make(self.parent / name)
                self.calls.clear()
                with mock.patch.object(attest.secrets, 'token_hex', return_value='f' * 16):
                    self.refuses('attest_workspace_invalid', mounted=False)
                self.assertTrue(os.path.lexists(self.parent / name))

    def test_mount_path_must_still_name_the_verified_directories(self):
        real_reprove = attest.MountDir.reprove
        moved_parent = self.base / 'moved-parent'

        def swap_child(ws):
            os.rename(ws.name, ws.name + '-moved', src_dir_fd=ws.parent_fd, dst_dir_fd=ws.parent_fd)
            os.mkdir(ws.name, 0o700, dir_fd=ws.parent_fd)
            return real_reprove(ws)

        def swap_parent(ws):
            self.parent.rename(moved_parent)
            self.parent.symlink_to(moved_parent)
            return real_reprove(ws)

        for swap in (swap_child, swap_parent):
            with self.subTest(swap.__name__):
                self.make_run_tree()
                shutil.rmtree(moved_parent, ignore_errors=True)
                self.calls.clear()
                with mock.patch.object(attest.MountDir, 'reprove', swap), self.assertRaises(fsops.Refused) as e:
                    self.go()
                self.assertEqual(e.exception.code, 'attest_workspace_invalid')
                self.assertFalse(any(c[0] in ('mount', 'umount') for c in self.calls))
                if swap is swap_child:
                    # The impostor and the moved original are not this run's to remove by name.
                    self.assertEqual(len(os.listdir(self.parent)), 2)
                else:
                    # Our own empty directory, reached through the retained parent descriptor, is removed.
                    self.assertEqual(os.listdir(moved_parent), [])
                    self.parent.unlink()


if __name__ == '__main__':
    unittest.main()
