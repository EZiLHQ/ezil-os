"""Read-only lower attestation of a snapshot clone: no write, no rw mount, no rebind, fail closed."""
import base64
import hashlib
import json
import os
from pathlib import Path
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
        '--fs-uuid', FS, '--instance-id', SRC, '--generation', '3', '--lease-epoch', '7']
MARKER = {'computerId': COMPUTER, 'volumeId': ORIGINAL, 'fsUuid': FS, 'generation': 3, 'leaseEpoch': 7,
          'lowerImageDigest': OLD, 'instanceId': SRC}


class Attest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.cfg = config.Config(dict(config.DEFAULTS))
        self.cfg.update(runDir=str(self.base / 'run'), dataMount=str(self.base / 'data-never-used'))
        Path(self.cfg.runDir).mkdir()
        self.mnt = self.base / 'clone'
        self.mnt.mkdir()
        (self.mnt / 'workspace').mkdir()
        (self.mnt / 'workspace/user-file').write_bytes(b'customer bytes')
        self.write_marker(MARKER)
        self.calls = []
        self.opts = 'ro,nosuid,nodev,noexec,norecovery'
        self.getro = '1'
        self.mounted_already = 1

        def run(argv, **kw):
            self.calls.append(list(argv))
            if argv[:2] == ['findmnt', '-n'] and '--source' in argv:
                return mock.Mock(returncode=0 if self.mounted_already == 0 else 1, stdout='')
            if argv[:2] == ['blockdev', '--getro']:
                return mock.Mock(returncode=0, stdout=self.getro + '\n')
            return mock.Mock(returncode=0, stdout='')
        for target, name, kwargs in (
                (attest.subprocess, 'run', {'side_effect': run}),
                (attest.tempfile, 'mkdtemp', {'return_value': str(self.mnt)}),
                (guard, 'device_for_volume', {'return_value': '/dev/nvme9n1'}),
                (guard, 'fs_uuid', {'return_value': FS}),
                (guard, 'mount_opts', {'side_effect': lambda path: self.opts}),
                (attest, 'instance_identity', {'return_value': (MAINT, json.dumps({'instanceId': MAINT, 'imageId': 'ami-' + '5' * 17}), 'PKCS7')})):
            p = mock.patch.object(target, name, **kwargs)
            p.start()
            self.addCleanup(p.stop)

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
        mount = [c for c in self.calls if c[0] == 'mount']
        self.assertEqual(mount, [['mount', '-t', 'ext4', '-o', 'ro,noload,nosuid,nodev,noexec', '/dev/nvme9n1', str(self.mnt)]])
        order = [c[:2] for c in self.calls]
        self.assertLess(order.index(['blockdev', '--setro']), order.index(['mount', '-t']))
        self.assertIn(['umount', str(self.mnt)], self.calls)
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
        before = self.snapshot()
        with self.assertRaises(fsops.Refused) as e:
            self.go(argv)
        self.assertEqual(e.exception.code, code)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(['umount', str(self.mnt)] in self.calls, mounted)
        self.assert_no_write_surface()

    def test_marker_refusals(self):
        cases = [
            ('marker_missing', None),
            ('marker_malformed', b'{not json'),
            ('marker_malformed', dict(MARKER, generation='3')),
            ('computer_id_mismatch', dict(MARKER, computerId='44444444-4444-4444-8444-444444444444')),
            ('volume_id_mismatch', dict(MARKER, volumeId=CLONE)),
            ('fs_uuid_mismatch', dict(MARKER, fsUuid='55555555-5555-4555-8555-555555555555')),
            ('generation_ahead', dict(MARKER, generation=4)),
            ('epoch_ahead', dict(MARKER, leaseEpoch=8)),
            ('marker_instance_unknown', {k: v for k, v in MARKER.items() if k != 'instanceId'}),
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


if __name__ == '__main__':
    unittest.main()
