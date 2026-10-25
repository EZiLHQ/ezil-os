"""EBS clone and app enrollment doubles with real no-follow/durable local files."""
import copy
import json
import os
from pathlib import Path
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from ezil_host import cli, config, enroll, fsops, guard, lease, maintenance
from test_rebase_commit import Crash, GuardFiles, IID, LEASE, NEW, OLD, permit

REAL_MOUNT = guard.mount_data


def restore_lease():
    d = dict(LEASE, volumeId='vol-' + '2' * 17, generation=3, leaseEpoch=4)
    p = permit(d)
    d['ebsRestore'] = dict(v=1, preparationJobId=p['preparationJobId'],
        recoveryJobId='66666666-6666-4666-8666-666666666666', launchJobId=p['launchJobId'],
        snapshotId='snap-' + '1' * 17, originalVolumeId=LEASE['volumeId'], volumeId=d['volumeId'],
        computerId=d['computerId'], fsUuid=d['fsUuid'], fromDigest=OLD, sourceGeneration=1,
        sourceLeaseEpoch=1, generation=d['generation'], leaseEpoch=d['leaseEpoch'],
        fenceToken=p['fenceToken'], issuedAt=p['issuedAt'], expiresAt=p['expiresAt'], maintenance=True)
    return d


class Rebind(GuardFiles):
    def setUp(self):
        super().setUp()
        self.lease = restore_lease()
        self.cfg.update(userDataCopies=[], enrollUrl='https://os.example.com/api/compute/aws/enroll',
                        enrollRetrySeconds=30, enrollRetryInitialSeconds=1)
        for obj, name, kwargs in ((config, 'host_digest', {'return_value': OLD}),
                                  (guard, 'mount_opts', {'return_value': 'ro,noload,nosuid,nodev'}),
                                  (guard, 'assert_data_mounted', {})):
            p = mock.patch.object(obj, name, **kwargs); p.start(); self.addCleanup(p.stop)
        enroll._write_private(str(Path(self.cfg.runDir) / 'lease.json'), json.dumps(self.lease).encode())
        enroll._write_private(str(Path(self.cfg.runDir) / 'identity.json'),
                              json.dumps({'document': json.dumps({'instanceId': IID}), 'signature': 'proof'}).encode())
        (Path(self.cfg.dataMount) / 'workspace').mkdir()
        (Path(self.cfg.dataMount) / 'workspace/user-file').write_bytes(b'preserve me')
        (Path(self.cfg.dataMount) / 'profiles').symlink_to('/never-follow-this')

    def test_new_volume_rebind_preserves_digest_and_user_bytes(self):
        lease.parse(json.dumps(self.lease))
        before = (Path(self.cfg.dataMount) / 'workspace/user-file').stat()
        with mock.patch.object(guard, 'mount_data') as mount, \
                mock.patch.object(guard, '_mkdirs_nofollow', side_effect=AssertionError('no guest layout')):
            self.assertEqual(self.go(), 'maintenance_rebound')
        self.assertEqual([c.args[2] for c in mount.call_args_list], ['ro,noload', 'rw'])
        self.assertEqual(self.read(guard.MARKER), guard.new_marker(self.lease, OLD, IID))
        user = Path(self.cfg.dataMount) / 'workspace/user-file'
        self.assertEqual(user.read_bytes(), b'preserve me')
        self.assertEqual(user.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertTrue((Path(self.cfg.dataMount) / 'profiles').is_symlink())
        self.assertFalse((Path(self.cfg.runDir) / 'guard-ok').exists())
        self.assertTrue((Path(self.cfg.runDir) / maintenance.STAMP).exists())

    def test_ordinary_lease_still_rejects_different_volume(self):
        ordinary = dict(self.lease); ordinary.pop('ebsRestore')
        with self.assertRaisesRegex(fsops.Refused, 'volume_id_mismatch'):
            guard.run_guard(self.cfg, ordinary)

    def test_wrong_marker_identity_or_new_tuple_never_remounts_rw(self):
        for key, value in (('computerId', 'foreign'), ('fsUuid', 'foreign'), ('volumeId', 'vol-'+'3'*17),
                           ('lowerImageDigest', NEW), ('generation', 2), ('leaseEpoch', 2)):
            self.write(guard.MARKER, dict(self.marker, **{key: value}))
            with mock.patch.object(guard, 'mount_data') as mount:
                with self.subTest(key=key), self.assertRaisesRegex(fsops.Refused, 'restore_lineage_mismatch'): self.go()
            self.assertEqual(len(mount.call_args_list), 1)
        self.write(guard.MARKER, guard.new_marker(self.lease, OLD, 'i-'+'2'*17))
        with self.assertRaisesRegex(fsops.Refused, 'restore_lineage_mismatch'): self.go()

    def test_checkpoint_sticky_state_and_symlink_marker_refuse(self):
        for value in ({'state': 'in_progress'}, {'state': 'rebase_failed'}, None, []):
            self.write(guard.REBASE_STATE, value)
            with self.assertRaisesRegex(fsops.Refused, 'rebase_failed'): self.go()
            self.assertEqual(self.read(guard.REBASE_STATE), value)
        (Path(self.cfg.dataMount) / guard.REBASE_STATE).unlink()
        path = Path(self.cfg.dataMount) / guard.MARKER
        path.unlink(); path.symlink_to('/never-open')
        with self.assertRaisesRegex(fsops.Refused, 'marker_malformed'): self.go()

    def test_no_noload_or_wrong_baked_lower_refuses(self):
        with mock.patch.object(guard, 'mount_opts', return_value='ro,nosuid,nodev'):
            with self.assertRaisesRegex(fsops.Refused, 'not_readonly'): self.go()
        with mock.patch.object(config, 'host_digest', return_value=NEW):
            with self.assertRaisesRegex(fsops.Refused, 'restore_lineage_mismatch'): self.go()

    def test_crash_before_and_after_commit_remains_maintenance_only(self):
        with mock.patch.object(maintenance, 'write_file_durable_at', side_effect=Crash()):
            with self.assertRaises(Crash): self.go()
        self.assertEqual(self.read(guard.MARKER), self.marker)
        with mock.patch.object(enroll, '_write_private', side_effect=Crash()):
            with self.assertRaises(Crash): self.go()
        self.assertEqual(self.read(guard.MARKER), guard.new_marker(self.lease, OLD, IID))
        self.assertFalse((Path(self.cfg.runDir) / maintenance.STAMP).exists())
        self.assertEqual(self.go(), 'maintenance_rebound')
        with self.assertRaisesRegex(fsops.Refused, 'maintenance_only'):
            guard.require_stamp(self.cfg, self.lease)

    def test_expired_uncommitted_rebind_and_dirty_journal_marker_change_refuse(self):
        end = lease.timestamp_ms(self.lease['ebsRestore']['expiresAt']) / 1000
        with mock.patch.object(lease.time, 'time', return_value=end):
            with self.assertRaisesRegex(fsops.Refused, 'permit_expired'): self.go()
        def mount(cfg, l, mode):
            if mode == 'rw': self.write(guard.MARKER, dict(self.marker, volumeId='vol-'+'3'*17))
        with mock.patch.object(guard, 'mount_data', side_effect=mount):
            with self.assertRaisesRegex(fsops.Refused, 'restore_lineage_mismatch'): self.go()

    def test_every_downstream_step_refuses_even_with_planted_guard_stamp(self):
        (Path(self.cfg.runDir) / 'guard-ok').write_text(json.dumps(guard.new_marker(self.lease, OLD, IID)))
        for step in ('clean', 'overlay', 'desktop', 'edge', 'cloudflared', 'agent'):
            with self.subTest(step=step), self.assertRaisesRegex(fsops.Refused, 'maintenance_only'):
                cli.step(self.cfg, step)

    def test_maintenance_http_body_and_durable_receipt_without_credentials(self):
        self.go()
        def request(method, url, **kw):
            body = json.loads(kw['body'])
            self.assertEqual(list(body)[-2:], ['lowerImageDigest', 'ebsRestore'])
            self.assertEqual(body['lowerImageDigest'], OLD)
            self.assertEqual(body['ebsRestore'], maintenance.report_spec(self.lease))
            self.assertEqual(list(body['ebsRestore']), ['v', 'recoveryJobId', 'snapshotId', 'originalVolumeId', 'volumeId', 'fsUuid'])
            return 200, b'{"maintenance":true,"accepted":true}'
        with mock.patch.object(enroll.http, 'request', side_effect=request):
            cli.step(self.cfg, 'maintenance-enroll')
        self.assertEqual(json.loads((Path(self.cfg.stateDir) / maintenance.RECEIPT).read_text()), maintenance.completion(self.cfg, self.lease))
        self.assertEqual(list(Path(self.cfg.stateDir).iterdir()), [Path(self.cfg.stateDir) / maintenance.RECEIPT])
        self.assertTrue(enroll.load_lease(self.cfg)['nonceConsumed'])

    def test_receipt_crash_keeps_nonce_and_exact_reboot_reuses(self):
        self.go()
        real = enroll._write_private
        def write(path, data):
            if Path(path).name == 'lease.json': raise Crash()
            return real(path, data)
        with mock.patch.object(enroll, '_write_private', side_effect=write), \
                mock.patch.object(enroll.http, 'request', return_value=(200, b'{"maintenance":true,"accepted":true}')):
            with self.assertRaises(Crash): maintenance.enroll_or_reuse(self.cfg, self.lease)
        self.assertIn('nonce', enroll.load_lease(self.cfg))
        end = lease.timestamp_ms(self.lease['ebsRestore']['expiresAt']) / 1000
        with mock.patch.object(enroll.http, 'request', side_effect=AssertionError('no repost')), \
                mock.patch.object(lease.time, 'time', return_value=end+9999):
            self.go()
            self.assertIn('reused', maintenance.enroll_or_reuse(self.cfg, self.lease))

    def test_malformed_maintenance_success_stores_nothing(self):
        for response in (b'{"maintenance":true,"accepted":1}', b'{"maintenance":true,"accepted":true,"tunnelToken":"bad"}',
                         b'{"maintenance":true,"maintenance":true,"accepted":true}', b'{}'):
            with self.assertRaises(enroll.Malformed): maintenance.persist(self.cfg, self.lease, response)
        self.assertFalse(Path(self.cfg.stateDir).exists())

    def test_boot_chain_routes_maintenance_without_desktop_steps(self):
        for mode in ('local', 'relay'):
            self.cfg['iceMode'] = mode
            calls = []
            with mock.patch.object(config, 'load', return_value=self.cfg), \
                    mock.patch.object(cli, 'step', side_effect=lambda cfg, name, **kw: calls.append(name) or 'ok'):
                self.assertEqual(cli.main(['boot-chain']), 0)
            self.assertEqual(calls, ['lease', 'guard', 'maintenance-enroll'])

    def test_maintenance_unit_has_no_desktop_dependency(self):
        units = Path(__file__).resolve().parents[1] / 'systemd'
        unit = (units / 'ezil-maintenance-enroll.service').read_text()
        self.assertIn('Requires=ezil-guard.service\n', unit)
        self.assertIn('After=ezil-guard.service\n', unit)
        self.assertNotIn('overlay', unit)
        self.assertIn('ezil-maintenance-enroll.service', (units / 'ezil-host.target').read_text())

    def test_mounting_an_empty_clone_never_formats_it(self):
        # Exercise the real mount entry point rather than the run() mount double.
        from unittest.mock import patch
        with patch.object(guard, 'wait_device_for_volume', return_value='/dev/test-clone'), \
                patch.object(guard, 'fs_uuid', return_value=None), \
                patch.object(guard.subprocess, 'run') as run:
            # The base fixture replaces mount_data: recover its original function.
            with self.assertRaisesRegex(fsops.Refused, 'volume_has_no_filesystem'):
                REAL_MOUNT(self.cfg, self.lease, 'ro,noload')
        run.assert_not_called()

    def test_restore_authorization_closed_types_modes_and_fresh_counters(self):
        mutations = [('maintenance', False), ('v', True), ('generation', 1), ('sourceGeneration', True),
                     ('leaseEpoch', 1), ('volumeId', LEASE['volumeId']), ('recoveryJobId', 'bad'),
                     ('originalVolumeId', 1), ('snapshotId', 1), ('extra', True)]
        for key, value in mutations:
            d = copy.deepcopy(self.lease); d['ebsRestore'][key] = value
            with self.subTest(key=key), self.assertRaises(lease.LeaseError): lease.parse(json.dumps(d))
        for extra in ({'restore': {}}, {'rebasePermit': {}}, {'rebase': {}}, {'provision': True}):
            with self.assertRaises(lease.LeaseError): lease.parse(json.dumps(dict(self.lease, **extra)))


class DigestEvidence(GuardFiles):
    def setUp(self):
        super().setUp()
        self.cfg.update(userDataCopies=[], enrollUrl='https://os.example.com/api/compute/aws/enroll')
        p = mock.patch.object(guard, 'assert_data_mounted'); p.start(); self.addCleanup(p.stop)
        enroll._write_private(str(Path(self.cfg.runDir) / 'lease.json'), json.dumps(self.lease).encode())
        enroll._write_private(str(Path(self.cfg.runDir) / 'identity.json'),
                              json.dumps({'document': json.dumps({'instanceId': IID}), 'signature': 'proof'}).encode())
        self.go()

    def test_evidence_is_committed_marker_not_requested_target(self):
        self.lease['rebase']['toDigest'] = OLD  # request isn't evidence
        self.assertEqual(guard.committed_digest(self.cfg, self.lease), NEW)
        with mock.patch.object(enroll.http, 'request', return_value=(403, b'{}')) as request:
            with self.assertRaisesRegex(fsops.Refused, 'enroll_refused'): enroll.enroll(self.cfg, self.lease)
        payload = json.loads(request.call_args.kwargs['body'])
        self.assertEqual(list(payload)[-2:], ['signature', 'lowerImageDigest'])
        self.assertEqual(payload['lowerImageDigest'], NEW)

    def test_stamp_marker_baked_and_sticky_state_must_all_agree(self):
        for key, value in (('lowerImageDigest', OLD), ('volumeId', 'vol-'+'3'*17), ('generation', 3), ('instanceId', 'i-'+'2'*17)):
            self.write(guard.MARKER, dict(guard.new_marker(self.lease, NEW, IID), **{key: value}))
            with self.assertRaisesRegex(fsops.Refused, 'host_digest_mismatch'):
                guard.committed_digest(self.cfg, self.lease)
        self.write(guard.MARKER, guard.new_marker(self.lease, NEW, IID))
        with mock.patch.object(config, 'host_digest', return_value=OLD):
            with self.assertRaisesRegex(fsops.Refused, 'host_digest_mismatch'): guard.committed_digest(self.cfg, self.lease)
        self.write(guard.REBASE_STATE, {'state':'in_progress'})
        with self.assertRaisesRegex(fsops.Refused, 'rebase_failed'): guard.require_stamp(self.cfg, self.lease)

    def test_marker_and_stamp_symlinks_never_followed(self):
        for directory, name in ((self.cfg.dataMount, guard.MARKER), (self.cfg.runDir, 'guard-ok')):
            p = Path(directory) / name; body = p.read_bytes()
            p.unlink(); p.symlink_to('/never-open')
            with self.assertRaises(fsops.Refused): guard.committed_digest(self.cfg, self.lease)
            p.unlink(); p.write_bytes(body)

    def test_enrollment_request_timeout_and_retries_stop_at_original_expiry(self):
        end = lease.timestamp_ms(self.lease['rebasePermit']['expiresAt']) / 1000
        now = [end - 2]
        def request(*args, **kwargs):
            self.assertLessEqual(kwargs['timeout'], 2)
            now[0] = end
            return 503, b'{"error":"retry","retryable":true}'
        with mock.patch.object(enroll.time, 'time', side_effect=lambda: now[0]), \
                mock.patch.object(enroll.time, 'sleep'), \
                mock.patch.object(enroll.http, 'request', side_effect=request) as req:
            with self.assertRaises(fsops.Refused): enroll.enroll(self.cfg, self.lease)
        self.assertEqual(req.call_count, 1)
        with mock.patch.object(enroll.time, 'time', return_value=end), mock.patch.object(enroll.http, 'request') as req:
            with self.assertRaisesRegex(fsops.Refused, 'permit_expired'): enroll.enroll(self.cfg, self.lease)
        req.assert_not_called()
