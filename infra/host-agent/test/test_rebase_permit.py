"""Pinned contract v1 lease/clock doubles; no app/infra fixtures are modified."""
import copy
import json
import os
import runpy
import tempfile
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from ezil_host import fsops, guard, lease, rebase
from test_rebase_commit import GuardFiles, IID, LEASE, NEW, OLD, RECEIPT, permit


class StrictLease(unittest.TestCase):
    def setUp(self):
        self.value = dict(LEASE, rebase=dict(RECEIPT), rebasePermit=permit())

    def parse(self, value=None):
        return lease.parse(json.dumps(self.value if value is None else value))

    def test_valid_permit_and_order_independence(self):
        self.assertEqual(self.parse(), self.value)
        self.assertEqual(lease.parse(json.dumps(dict(reversed(list(self.value.items()))))), self.value)

    def test_closed_objects(self):
        for key in (None, 'rebase', 'rebasePermit'):
            v = copy.deepcopy(self.value)
            (v if key is None else v[key])['extra'] = True
            with self.subTest(key=key), self.assertRaises(lease.LeaseError):
                self.parse(v)
        for key in lease.PERMIT_KEYS:
            v = copy.deepcopy(self.value)
            del v['rebasePermit'][key]
            with self.subTest(missing=key), self.assertRaises(lease.LeaseError):
                self.parse(v)

    def test_duplicate_keys_and_nonfinite_json(self):
        raw = json.dumps(self.value)
        for bad in (raw.replace('"v": 1', '"v": 1, "v": 1'),
                    raw.replace('"generation": 2', '"generation": NaN'),
                    raw.replace('"generation": 2', '"generation": Infinity')):
            with self.assertRaises(lease.LeaseError):
                lease.parse(bad)

    def test_decoded_size_limit_before_json(self):
        raw = json.dumps(self.value).encode()
        self.assertEqual(lease.parse(raw + b' ' * (3072-len(raw))), self.value)
        with mock.patch.object(lease, 'strict_json', side_effect=AssertionError('parsed oversized')):
            with self.assertRaisesRegex(lease.LeaseError, 'too_large'):
                lease.parse(raw + b' ' * (3073-len(raw)))
        with self.assertRaises(lease.LeaseError):
            lease.parse(b'\xff')

    def test_counter_types_and_bounds(self):
        for key in ('generation', 'leaseEpoch'):
            for val in (True, False, 0, -1, 1.0, '2', 2147483648):
                v = copy.deepcopy(self.value)
                v[key] = v['rebasePermit'][key] = val
                with self.subTest(key=key, val=val), self.assertRaises(lease.LeaseError):
                    self.parse(v)
            v = copy.deepcopy(self.value)
            v[key] = v['rebasePermit'][key] = 2147483647
            self.parse(v)

    def test_versions_and_pair_presence(self):
        for key in ('rebase', 'rebasePermit'):
            for action in ('remove', 'null'):
                v = copy.deepcopy(self.value)
                if action == 'remove': del v[key]
                else: v[key] = None
                with self.assertRaises(lease.LeaseError): self.parse(v)
        for obj in (None, 'rebasePermit'):
            for val in (True, 1.0, '1', 2):
                v = copy.deepcopy(self.value)
                (v if obj is None else v[obj])['v'] = val
                with self.assertRaises(lease.LeaseError): self.parse(v)

    def test_cross_checks_and_mode_exclusion(self):
        for key in ('computerId', 'fsUuid', 'generation', 'leaseEpoch'):
            v = copy.deepcopy(self.value)
            v['rebasePermit'][key] = 3 if key in ('generation', 'leaseEpoch') else '99999999-9999-4999-8999-999999999999'
            with self.assertRaises(lease.LeaseError): self.parse(v)
        for extra in ({'provision': True}, {'restore': {}}, {'ebsRestore': {}}, {'nonce': None}):
            with self.assertRaises(lease.LeaseError): self.parse(dict(self.value, **extra))
        for key, value in (('volumeId', 'vol-'+'2'*17), ('fromDigest', NEW), ('snapshotId', 123)):
            v = copy.deepcopy(self.value); v['rebase'][key] = value
            with self.assertRaises(lease.LeaseError): self.parse(v)

    def test_uuid_and_time_types(self):
        for key in ('preparationJobId', 'launchJobId', 'fenceToken'):
            for val in (None, 42, 'ABC', '00000000-0000-0000-0000-000000000000'):
                v = copy.deepcopy(self.value); v['rebasePermit'][key] = val
                with self.assertRaises(lease.LeaseError): self.parse(v)
        for val in ('2026-02-30T12:00:00.000Z', '2026-10-22T12:00:00Z', '2026-10-22T12:00:00.000+00:00', 0):
            v = copy.deepcopy(self.value); v['rebasePermit']['issuedAt'] = val
            with self.assertRaises(lease.LeaseError): self.parse(v)
        v = copy.deepcopy(self.value); v['rebasePermit']['expiresAt'] = v['rebasePermit']['issuedAt']
        with self.assertRaises(lease.LeaseError): self.parse(v)
        v = copy.deepcopy(self.value); v['rebasePermit']['launchJobId'] = v['rebasePermit']['preparationJobId']
        with self.assertRaises(lease.LeaseError): self.parse(v)

    def test_canonical_enroll_url(self):
        self.parse(dict(self.value, enrollUrl='https://os.example.com/api/compute/aws/enroll'))
        for url in ('http://os.example.com/api/compute/aws/enroll', 'https://OS.example.com/api/compute/aws/enroll',
                    'https://user:pass@os.example.com/api/compute/aws/enroll',
                    'https://os.example.com/api/compute/aws/enroll?x',
                    'https://os.example.com/api/compute/aws/enroll#x', 'https://os.example.com/elsewhere',
                    'https://' + 'a'*500 + '.com/api/compute/aws/enroll'):
            with self.assertRaises(lease.LeaseError): self.parse(dict(self.value, enrollUrl=url))

    def test_privileged_wire_fixture_matches_strict_parser(self):
        generate = runpy.run_path(str(Path(__file__).with_name('rebase-fixture.py')))['main']
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp) / 'user-data'
            p.write_text(json.dumps(dict(LEASE, rebase=RECEIPT)))
            generate(['permit', str(p)])
            value = lease.parse(p.read_bytes())
            self.assertEqual(list(value['rebasePermit']), ['v', 'preparationJobId', 'launchJobId', 'computerId',
                             'fsUuid', 'generation', 'leaseEpoch', 'fenceToken', 'issuedAt', 'expiresAt'])
            p.write_text(json.dumps(dict(LEASE, volumeId='vol-'+'2'*17)))
            generate(['rebind', str(p), LEASE['volumeId'], OLD, '1', '1'])
            value = lease.parse(p.read_bytes())
            self.assertEqual(value['ebsRestore']['volumeId'], 'vol-'+'2'*17)

    def test_pool_cannot_carry_any_restore_or_rebase_mode(self):
        for key in ('restore', 'rebase', 'rebasePermit', 'ebsRestore'):
            with self.assertRaises(lease.LeaseError):
                self.parse(dict(kind='pool', poolHostId=LEASE['computerId'], poolGeneration=1, **{key: None}))


class Deadlines(GuardFiles):
    def setUp(self):
        super().setUp()
        self.p = self.lease['rebasePermit']
        self.p.update(issuedAt='2026-10-22T12:00:00.000Z', expiresAt='2026-10-22T12:10:00.000Z')
        self.issued = lease.timestamp_ms(self.p['issuedAt']) / 1000

    def test_expired_parse_is_allowed_but_mutation_is_not(self):
        lease.parse(json.dumps(self.lease))
        with mock.patch.object(lease.time, 'time', return_value=self.issued + 600):
            with self.assertRaisesRegex(fsops.Refused, 'permit_expired'): self.go()
        self.assertEqual(self.read(guard.MARKER), self.marker)
        self.assertFalse((Path(self.cfg.dataMount) / guard.REBASE_STATE).exists())

    def test_reserve_equality_and_future_skew(self):
        for now, code in ((480, 'enrollment_time_insufficient'), (481, 'enrollment_time_insufficient'), (-31, 'permit_invalid')):
            with mock.patch.object(lease.time, 'time', return_value=self.issued + now):
                with self.subTest(now=now), self.assertRaisesRegex(fsops.Refused, code): self.go()
        for now in (-30, 479.999):
            with mock.patch.object(lease.time, 'time', return_value=self.issued + now):
                self.assertGreater(lease.mutation_deadline(self.p), lease.time.monotonic())

    def test_slow_preflight_rechecks_before_remount(self):
        with mock.patch.object(lease.time, 'time', side_effect=[self.issued, self.issued + 490]), \
                mock.patch.object(guard, 'remount') as rw:
            with self.assertRaisesRegex(fsops.Refused, 'enrollment_time_insufficient'): self.go()
        rw.assert_not_called()

    def test_monotonic_budget_survives_backward_wall_clock(self):
        with mock.patch.object(lease.time, 'time', return_value=self.issued + 479), \
                mock.patch.object(lease.time, 'monotonic', return_value=100):
            deadline = lease.mutation_deadline(self.p)
        with mock.patch.object(lease.time, 'time', return_value=self.issued), \
                mock.patch.object(lease.time, 'monotonic', return_value=102):
            with self.assertRaisesRegex(fsops.Refused, 'enrollment_time_insufficient'):
                lease.require_budget(self.p, deadline)

    def test_subprocess_timeout_is_bounded_and_sticky(self):
        with mock.patch.object(lease.time, 'time', return_value=self.issued + 100), \
                mock.patch.object(subprocess, 'run', side_effect=subprocess.TimeoutExpired('rebase', 380)) as run:
            fd = os.open(self.cfg.dataMount, fsops.DIR_FLAGS)
            try:
                with self.assertRaisesRegex(fsops.Refused, 'rebase_timeout'):
                    rebase.run_job(self.cfg, self.lease, fd)
            finally: os.close(fd)
        self.assertLessEqual(run.call_args.kwargs['timeout'], 380)
        self.assertEqual(self.read(guard.REBASE_STATE)['reason'], 'rebase_timeout')
        self.assert_blocked()

    def test_completed_same_instance_reboot_ignores_expiry(self):
        self.write(guard.MARKER, guard.new_marker(self.lease, NEW, IID))
        with mock.patch.object(lease.time, 'time', return_value=self.issued + 9999):
            self.assertEqual(self.go(), 'reboot')
        with mock.patch.object(guard, 'current_instance_id', return_value='i-'+'2'*17):
            with self.assertRaisesRegex(fsops.Refused, 'epoch_not_increasing'): self.go()

    def test_full_blocks_or_inodes_refuse_before_mutation(self):
        for blocks, inodes in ((0, 100), (100, 0)):
            with mock.patch.object(guard.os, 'fstatvfs', return_value=mock.Mock(f_bavail=blocks, f_favail=inodes)), \
                    mock.patch.object(lease.time, 'time', return_value=self.issued), \
                    mock.patch.object(guard, 'remount') as rw:
                with self.assertRaisesRegex(fsops.Refused, 'rebase_failed'): self.go()
            rw.assert_not_called()
