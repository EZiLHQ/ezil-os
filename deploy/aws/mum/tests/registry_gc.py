#!/usr/bin/env python3
"""Offline GC regression tests. No CLI --apply and no cloud/DB transport."""
import contextlib
import copy
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
import fcntl

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
spec = importlib.util.spec_from_file_location('gc_under_test', HERE.parent / 'registry_gc.py')
gc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gc)
sys.path.insert(0, str(HERE))
from rebase import release_record


SYSTEM_ID = '7698279149046886433'

def synthetic_e1(evidence, original_plan, files=None):
    """TEST ONLY: issue receipts for deliberately constructed synthetic fixtures.

    Called during fixture construction, never automatically during validation.
    Tamper tests mutate the resulting receipts/evidence after this function.
    """
    evidence['proof']['originalPlanJson'] = original_plan
    contents = None
    if files is None:
        from e1_test_files import contents as test_files
        contents = test_files(evidence['proof'])
        files = {name:gc.hashlib.sha256(raw.encode()).hexdigest() for name,raw in contents.items()}
    receipt = {k:evidence[k] for k in ('accountId','region','namespace','planSha256')}
    receipt.update(schemaVersion=1, databaseSystemIdentifier=SYSTEM_ID,
        fenceActivatedAt=evidence['proof']['fenceActivatedAt'],
        files={name:{'sha256':digest,'capturedAt':evidence['capturedAt'],
                     'complete':True,'query':'TEST ONLY synthetic complete export'} for name,digest in files.items()},
        sources={name:{'files':list(files), 'rowsSha256':gc.sha(source['rows']),
                       'query':source['query']} for name,source in evidence['sources'].items()})
    evidence['proof']['collectionReceipts'] = receipt
    evidence['collection'] = {'filesSha256':files, 'receiptManifestSha256':gc.sha(receipt)}
    if contents is not None: gc.provenance.bind_proof_files(evidence,contents)


class RegistryGcTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='ezil-registry-gc.')
        self.root = Path(self.tmp.name)
        self.directory = self.root / 'registry-gc-g2'
        self.directory.mkdir()
        self.path = self.root / 'rebase-plan.json'
        self.plan = {'ledgerGeneration': 1, 'databaseSystemIdentifier': SYSTEM_ID, 'rollout': {'app': {'tag': '478c66b3559c', 'gitSha': 'e' * 40, 'checksumSha256': 'f' * 64}}}
        self.path.write_text(json.dumps(self.plan))
        self.ledger = self.root / 'promotion-ledger.json'
        self.lock = self.root / 'app-secret.lock'
        self.now = datetime(2026, 10, 24, 19, 0, tzinfo=timezone.utc)
        self.records = []
        for n in (2, 5, 6, 7, 8, 9, 10, 11):
            r = release_record()
            r.update(amiId='ami-' + format(n, '017x'), recipeVersion='1.0.' + str(n),
                     launchTemplateVersion=str(n), createdAt=f'2026-10-24T{n:02d}:00:00.000Z')
            for key in gc.release.VERSION_KEYS:
                r[key] = r[key].rsplit(':', 1)[0] + ':' + str(n)
            if n == 2:
                r.update(lowerImageDigest='sha256:' + 'a' * 64, previousLowerImageDigest=None, previousLowerImageRef=None)
            self.records.append(r)
        self.target = copy.deepcopy(self.records[-1])
        self.target.update(amiId='ami-' + format(12, '017x'), recipeVersion='1.0.12')
        self.snapshot = {'VersionId': 'synthetic-version-1',
                         'deployment': dict(self.records[-1], releases=self.records, unrelated={'keep': [1, 2]})}
        self.roles = [self.records[-1], self.records[0]]
        self.drops = [gc.identity(self.records[1])]
        self.plan_sha = gc.release.digest(self.path)
        self.evidence = {'schemaVersion': 1, 'accountId': gc.tool.ACCOUNT, 'region': gc.tool.REGION,
                         'namespace': 'mum', 'planSha256': self.plan_sha,
                         'secretVersionId': self.snapshot['VersionId'], 'registrySha256': gc.sha(self.records),
                         'capturedAt': '2026-10-24T18:59:00Z', 'expiresAt': '2026-10-24T19:09:00Z',
                         'quiescence': dict.fromkeys(('appWritersStopped', 'poolWritersStopped',
                             'workflowWritersStopped', 'operatorWritersStopped'), True),
                         'sources': {name: {'complete': True, 'uncertain': [], 'query': 'reviewed full inventory',
                                          'rows': [], 'rowsSha256': gc.sha([])} for name in gc.SOURCES},
                         'proof': {'databaseMeta': {'system_identifier': SYSTEM_ID, 'captured_at': '2026-10-24T18:59:00Z'},
                                   'inventoryCapturedAt': '2026-10-24T18:59:00Z', 'fenceActivatedAt': '2026-10-24T18:50:00Z'}}
        synthetic_e1(self.evidence, self.path.read_text())
        self.calls = []
        self.live = self.envelope()
        self.race = None
        self.running = gc.release.rebase_app.public_deployment(self.snapshot['deployment'])
        self.running_sha = 'e' * 40
        initial = gc.release.ledger_entry(self.path, 'apply-app', self.live, self.snapshot['deployment'], self.running_sha, 1)
        gc.tool.write(self.ledger, {'schemaVersion': 1, 'entries': [initial]})

    def tearDown(self):
        self.tmp.cleanup()

    def envelope(self, encoded=True):
        deployments = {gc.tool.REGION: self.snapshot['deployment'], 'us-east-1': {'keep': [3, 4]}}
        outer = {gc.tool.KEY: json.dumps(deployments) if encoded else deployments,
                 'EZIL_AWS_KILL_SWITCH': '1', 'unrelated': 'synthetic-private-do-not-print'}
        return {'VersionId': self.snapshot['VersionId'], 'SecretString': json.dumps(outer)}

    def prepare(self):
        return gc.prepare(self.snapshot, self.target, self.roles, self.evidence,
                          self.drops, self.plan_sha, self.now, SYSTEM_ID)

    def refuse(self, text):
        with self.assertRaisesRegex(ValueError, text):
            self.prepare()

    def rows(self, source, rows):
        self.evidence['sources'][source].update(rows=rows, rowsSha256=gc.sha(rows))
        synthetic_e1(self.evidence, self.path.read_text())

    def transport(self, op, value=None):
        with self.lock.open('r+') as lock:
            with self.assertRaises(BlockingIOError):
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.calls.append(op)
        if self.race == 'before-put' and (self.directory / 'ledger-pending.json').exists() and 'put' not in self.calls:
            self.live['VersionId'] = 'raced'
        if op == 'put' and self.race == 'unknown-before-write':
            raise TimeoutError('unknown write')
        if op == 'put':
            self.live = {'VersionId': 'synthetic-version-2', 'SecretString': json.dumps(value)}
            if self.race == 'unknown-after-write':
                raise TimeoutError('unknown write')
            return {'VersionId': self.live['VersionId']}
        result = copy.deepcopy(self.live)
        if self.race == 'readback' and 'put' in self.calls:
            result['VersionId'] = 'raced'
        return result

    def app_operation(self, path, plan, operation, apply, expected=None, install=True, generation=None):
        if install:
            self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'pending')
            if self.race != 'app-readback':
                self.running = copy.deepcopy(expected)
            if self.race == 'app-secret':
                self.live['VersionId'] = 'raced-after-refresh'
        return {'gitSha': self.running_sha, 'killSwitch': '1', 'deployment': self.running}

    @contextlib.contextmanager
    def context(self):
        with patch.object(gc.release, 'load_plan', return_value=self.plan), \
             patch.object(gc.release, 'static_deployment'), patch.object(gc.release, 'live_roles'), \
             patch.object(gc.release, 'app_operation', side_effect=self.app_operation), \
             patch.object(gc.tool, 'secret_aws', side_effect=lambda *a, **k: self.transport('get')), \
             patch.object(gc.tool, 'APP_SECRET_LOCK', str(self.lock)):
            yield

    def commit(self, recheck=lambda: None):
        with self.context(), gc.tool.app_secret_lock() as fd:
            return gc.commit(self.directory, self.snapshot, self.prepare(), self.plan_sha,
                             gc.sha(self.evidence), self.transport, self.ledger, recheck,
                             path=self.path, plan=self.plan, fd=fd)

    def test_full_checker_cannot_omit_conflicting_launch(self):
        instance='i-'+'1'*17
        candidate, keep = self.records[1], self.records[-1]
        row={'provider':'aws-ec2','region':gc.tool.REGION,'instance_id':instance,
             'lower_image_digest':keep['lowerImageDigest']}
        self.rows('placements',[row])
        def event(ami):
            return {'eventName':'RunInstances','eventSource':'ec2.amazonaws.com',
                    'recipientAccountId':gc.tool.ACCOUNT,'awsRegion':gc.tool.REGION,
                    'responseElements':{'instancesSet':{'items':[{'instanceId':instance,'imageId':ami}]}}}
        self.evidence['proof']['cloudTrail']=[event(keep['amiId']),event(candidate['amiId'])]
        synthetic_e1(self.evidence,self.path.read_text())
        self.evidence['referenceBindings']=[{'kind':'placement_image','source':'placements',
            'rowSha256':gc.sha(row),'proofSha256':gc.sha(self.evidence['proof'])}]
        self.refuse('missing/conflicting instance image')
        original=copy.deepcopy(self.evidence['collection'])
        receipt=copy.deepcopy(self.evidence['proof']['collectionReceipts'])
        self.evidence['proof']['cloudTrail'].pop()
        self.evidence['collection']['proofFileBindings'].pop(json.dumps(['cloudTrail',1]))
        self.evidence['referenceBindings'][0]['proofSha256']=gc.sha(self.evidence['proof'])
        self.refuse('complete supplemental proof mismatch')
        self.assertEqual(receipt,self.evidence['proof']['collectionReceipts'])
        self.assertEqual(original['fileContents'],self.evidence['collection']['fileContents'])
        self.assertEqual(original['filesSha256'],self.evidence['collection']['filesSha256'])
        self.assertEqual(original['receiptManifestSha256'],self.evidence['collection']['receiptManifestSha256'])

    def test_synthetic_receipts_are_not_refreshed_by_validation(self):
        self.evidence['proof']['collectionReceipts']['files']['db-evidence.json']['sha256'] = '0' * 64
        self.evidence['collection']['receiptManifestSha256'] = gc.sha(self.evidence['proof']['collectionReceipts'])
        self.refuse('E1 file hash mismatch')

    def test_accepts_exactly_one_and_preserves_registry_order_and_secret(self):
        for encoded in (True, False):
            before = self.envelope(encoded)
            after = self.prepare()
            self.assertEqual(after['releases'], self.records[:1] + self.records[2:])
            result = gc.edit(before, self.snapshot, after)
            outer = json.loads(before['SecretString'])
            self.assertEqual({k: v for k, v in result.items() if k != gc.tool.KEY},
                             {k: v for k, v in outer.items() if k != gc.tool.KEY})
            ds = json.loads(result[gc.tool.KEY]) if encoded else result[gc.tool.KEY]
            self.assertEqual(ds['us-east-1'], {'keep': [3, 4]})
            self.assertEqual(ds[gc.tool.REGION], after)
            self.assertEqual(len(self.snapshot['deployment']['releases']), 8)

    def test_keep_current_base_and_lane_target_recipes(self):
        for n in (0, -1):
            self.drops = [gc.identity(self.records[n])]
            self.refuse('keep-set')
        self.records[1]['recipeVersion'] = '1.0.12'
        self.drops = [gc.identity(self.records[1])]
        self.refuse('keep-set')

    def test_keep_target_and_plan_predecessor_even_other_recipe(self):
        self.target = self.records[1]
        self.refuse('keep-set')
        self.target = self.records[-1]
        self.roles = [self.records[1]]
        self.refuse('keep-set')

    def test_one_exact_identity_required(self):
        for drops in ([], self.drops * 2, [dict(self.drops[0], extra=1)], 'ami-only'):
            self.drops = drops
            self.refuse('exactly one')

    def test_absent_identity(self):
        self.drops[0]['amiId'] = 'ami-' + 'f' * 17
        self.refuse('identity absent')

    def test_invalid_registry(self):
        self.snapshot['deployment']['releases'] = self.records + [self.target, dict(self.target,amiId='ami-'+'d'*17)]
        self.refuse('invalid registry')

    def test_nine_record_gc_removes_exactly_one_preserving_eight(self):
        self.records.append(copy.deepcopy(self.target))
        self.evidence['registrySha256']=gc.sha(self.records)
        before=copy.deepcopy(self.snapshot)
        after=self.prepare()
        self.assertEqual(len(after['releases']),8)
        self.assertEqual(after['releases'],self.records[:1]+self.records[2:])
        self.assertEqual(self.snapshot,before)
        self.drops.append(gc.identity(self.records[2]))
        self.refuse('exactly one')

    def test_duplicate_identity(self):
        self.records[2] = copy.deepcopy(self.records[1])
        self.refuse('duplicate identity')

    def test_foreign_registry(self):
        self.records[1]['launchTemplateId'] = 'lt-' + 'f' * 17
        self.refuse('foreign registry')

    def test_current_tuple_required(self):
        self.snapshot['deployment']['amiId'] = 'ami-' + 'f' * 17
        self.refuse('current tuple')

    def test_snapshot_scope(self):
        self.snapshot['deployment']['region'] = 'us-east-1'
        self.refuse('snapshot scope')

    def test_evidence_scope(self):
        self.evidence['namespace'] = 'other'
        self.refuse('evidence scope')

    def test_evidence_bound_to_plan_version_and_registry(self):
        for key in ('planSha256', 'secretVersionId', 'registrySha256'):
            old = self.evidence[key]
            self.evidence[key] = 'stale'
            self.refuse('stale evidence')
            self.evidence[key] = old

    def test_freshness_and_timezone(self):
        self.evidence['expiresAt'] = '2026-10-24T18:59:01Z'
        self.refuse('expired')
        self.evidence['expiresAt'] = '2026-10-24T20:00:00Z'
        self.refuse('expired')
        with self.assertRaisesRegex(ValueError, 'timezone'):
            gc.time_value('2026-10-24T19:00:00')

    def test_quiescence_all_writers(self):
        for bad in (False, 1, None):
            self.evidence['quiescence']['workflowWritersStopped'] = bad
            self.refuse('writers not quiesced')

    def test_coverage(self):
        del self.evidence['sources']['writerLeases']
        self.refuse('coverage incomplete')

    def test_uncertain_incomplete_missing_query_and_tampered_rows(self):
        source = self.evidence['sources']['placements']
        for key, value in (('uncertain', ['unresolved lifecycle hash']), ('complete', False), ('query', ''), ('rowsSha256', 'bad')):
            old = source[key]
            source[key] = value
            self.refuse('incomplete or uncertain')
            source[key] = old

    def test_every_source_and_reference_field_refuses(self):
        for name in gc.SOURCES:
            for key in gc.IDENTITY_KEYS:
                self.rows(name, [{key: self.records[1][key]}])
                self.refuse('referenced record')
            self.rows(name, [])

    def test_terminal_jobs_are_conservatively_retained(self):
        for phase in ('failed', 'unconfirmed', 'succeeded', 'recovered', 'cancelled'):
            self.rows('imageJobs', [{'phase': phase, 'source_release': self.records[1]}])
            self.refuse('referenced record')

    def test_saved_intents_json_and_unknown_documents(self):
        for value in ('recovery:' + json.dumps({'deployment': self.records[1]}), 'recovery:{broken'):
            self.rows('placements', [{'last_error': value}])
            self.refuse('referenced record')

    def test_shared_lower_only_is_uncertain_but_other_ami_is_disambiguated(self):
        self.rows('runtimeConfigs', [self.records[-1]])
        self.prepare()
        self.rows('placements', [{'lower_image_digest': self.records[1]['lowerImageDigest']}])
        self.refuse('referenced record')

    def test_stale_cas_version_or_deployment(self):
        after = self.prepare()
        for version, change in (('different', False), (self.snapshot['VersionId'], True)):
            env = self.envelope()
            env['VersionId'] = version
            if change:
                outer = json.loads(env['SecretString'])
                ds = json.loads(outer[gc.tool.KEY]); ds[gc.tool.REGION]['unrelated'] = 'changed'
                outer[gc.tool.KEY] = json.dumps(ds); env['SecretString'] = json.dumps(outer)
            with self.assertRaisesRegex(ValueError, 'stale CAS'):
                gc.edit(env, self.snapshot, after)

    def test_commit_cannot_modify_other_fields_or_drop_two(self):
        for change in ('field', 'two', 'rewrite', 'reorder'):
            after = self.prepare()
            if change == 'field': after['amiId'] = 'ami-' + 'f' * 17
            if change == 'two': after['releases'].pop()
            if change == 'rewrite': after['releases'][0]['agentCommit'] = 'f' * 40
            if change == 'reorder': after['releases'].reverse()
            with self.assertRaisesRegex(ValueError, 'exceeds one record'):
                gc.edit(self.envelope(), self.snapshot, after)

    def test_missing_backup_prevents_transport(self):
        with self.assertRaisesRegex(ValueError, 'backup missing'):
            self.commit()
        self.assertEqual(self.calls, [])

    def test_backup_tamper(self):
        gc.backup_registry(self.directory, self.snapshot)
        path = self.directory / 'registry-before.sha256.json'
        path.chmod(0o600); path.write_text('{"sha256":"wrong"}')
        with self.assertRaisesRegex(ValueError, 'backup mismatch'):
            self.commit()
        self.assertEqual(self.calls, [])

    def test_immutable_backup_and_pending_completed_receipt(self):
        gc.backup_registry(self.directory, self.snapshot)
        with self.assertRaises(FileExistsError):
            gc.backup_registry(self.directory, self.snapshot)
        done = self.commit()
        self.assertEqual(self.calls, ['get', 'get', 'get', 'put', 'get', 'get'])
        self.assertEqual(done['state'], 'completed')
        self.assertEqual(json.loads((self.directory / 'ledger-pending.json').read_text())['mainPending']['state'], 'pending')
        self.assertEqual(json.loads((self.directory / 'receipt.json').read_text()), done)
        self.assertEqual(done['registrySha256'], gc.release.release_state(self.prepare(), self.running_sha)['registrySha256'])
        self.assertEqual(done['planSha256'], self.plan_sha)
        self.assertEqual([e['state'] for e in gc.release.load_ledger(self.ledger)['entries']], ['completed', 'pending', 'completed'])
        self.assertEqual((self.directory / 'registry-before.json').stat().st_mode & 0o777, 0o400)

    def test_cas_race_prevents_put_leaves_pending(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'before-put'
        with self.assertRaisesRegex(ValueError, 'CAS changed before put'):
            self.commit()
        self.assertNotIn('put', self.calls)
        self.assertFalse((self.directory / 'receipt.json').exists())

    def test_readback_mismatch_never_completes(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'readback'
        with self.assertRaisesRegex(ValueError, 'readback mismatch'):
            self.commit()
        self.assertFalse((self.directory / 'ledger-completed.json').exists())

    def test_global_pending_prevents_another_operation(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'before-put'
        with self.assertRaisesRegex(ValueError, 'CAS changed'):
            self.commit()
        with self.assertRaisesRegex(ValueError, 'operation pending'):
            self.commit()

    def test_main_ledger_historical_bytes_and_following_promote(self):
        initial = gc.release.load_ledger(self.ledger)
        self.ledger.write_bytes(json.dumps(initial, indent=2).replace('\n', '\r\n').encode())
        old_entry = self.ledger.read_bytes().split(b'"entries": [', 1)[1].rsplit(b']', 1)[0]
        plan_bytes = self.path.read_bytes()
        gc.backup_registry(self.directory, self.snapshot)
        self.commit()
        self.assertIn(old_entry, self.ledger.read_bytes())
        self.assertEqual(self.path.read_bytes(), plan_bytes)
        after = self.prepare()
        with self.context(), gc.tool.app_secret_lock() as fd:
            ledger = gc.release.ledger_admit(self.ledger, self.path, self.plan, self.live, after, 'promote-canary')
            gc.release.begin_operation(self.ledger, ledger, self.path, self.plan, 'promote-canary', self.live, after, after, False, fd)
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][:1], initial['entries'])

    def test_pending_blocks_promote_and_gc_until_verified_reconciliation(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'app-readback'
        with self.assertRaisesRegex(ValueError, 'app refresh readback mismatch'):
            self.commit()
        _, after = gc.release.secret_deployment(self.live)
        with self.assertRaisesRegex(ValueError, 'pending operation differs'):
            gc.release.ledger_admit(self.ledger, self.path, self.plan, self.live, after, 'promote-canary')
        with self.assertRaisesRegex(ValueError, 'operation pending'):
            self.commit()
        with self.context(), patch.object(gc.release.rebase_ssm, 'generation_terminal', return_value=True):
            with self.assertRaisesRegex(ValueError, 'app registry not adopted'):
                gc.release.ledger_reconcile(self.path, True, self.ledger)
            self.running = gc.release.rebase_app.public_deployment(after)
            gc.release.ledger_reconcile(self.path, True, self.ledger)
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'completed')
        gc.release.ledger_admit(self.ledger, self.path, self.plan, self.live, after, 'promote-canary')

    def test_unknown_put_cannot_abort_or_retry_blindly(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'unknown-before-write'
        with self.assertRaisesRegex(TimeoutError, 'unknown write'):
            self.commit()
        with self.context(), patch.object(gc.release.rebase_ssm, 'generation_terminal', return_value=True):
            with self.assertRaisesRegex(ValueError, 'secret write outcome unknown'):
                gc.release.ledger_reconcile(self.path, True, self.ledger)
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'pending')
        with self.assertRaisesRegex(ValueError, 'operation pending'):
            self.commit()
        self.assertEqual(self.calls.count('put'), 1)

    def test_lost_put_acknowledgement_requires_app_adoption(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'unknown-after-write'
        with self.assertRaises(TimeoutError):
            self.commit()
        with self.context(), patch.object(gc.release.rebase_ssm, 'generation_terminal', return_value=True):
            with self.assertRaisesRegex(ValueError, 'app registry not adopted'):
                gc.release.ledger_reconcile(self.path, True, self.ledger)
            self.running = gc.release.rebase_app.public_deployment(self.prepare())
            gc.release.ledger_reconcile(self.path, True, self.ledger)
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'completed')
        self.assertEqual(self.calls.count('put'), 1)

    def test_reconcile_before_unattempted_put_aborts_without_mutation(self):
        gc.backup_registry(self.directory, self.snapshot)
        checks = []
        def recheck():
            checks.append(1)
            if len(checks) == 2: raise ValueError('expired before put')
        with self.assertRaisesRegex(ValueError, 'expired before put'):
            self.commit(recheck)
        before = copy.deepcopy(self.live)
        with self.context(), patch.object(gc.release.rebase_ssm, 'generation_terminal', return_value=True):
            gc.release.ledger_reconcile(self.path, True, self.ledger)
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'aborted')
        self.assertEqual(self.live, before)
        self.assertNotIn('put', self.calls)

    def test_root_105_instance_and_volumes_are_retained(self):
        for name, row in [('instances', {'InstanceId': 'i-0a1b2c3d4e5f60718', 'ImageId': self.records[1]['amiId'], 'State': {'Name': 'stopped'}}),
                          ('volumes', {'VolumeId': 'vol-0a1b2c3d4e5f60718', 'source_release': self.records[1]}),
                          ('volumes', {'VolumeId': 'vol-0c3d4e5f607182930', 'source_release': self.records[1]})]:
            self.rows(name, [row]); self.refuse('referenced record'); self.rows(name, [])

    def test_refresh_secret_race_never_completes(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'app-secret'
        with self.assertRaisesRegex(ValueError, 'secret changed during app refresh'):
            self.commit()
        self.assertEqual(gc.release.load_ledger(self.ledger)['entries'][-1]['state'], 'pending')

    def test_operation_directory_and_plan_pin(self):
        gc.backup_registry(self.directory, self.snapshot)
        validated_after = self.prepare()
        self.plan_sha = 'f' * 64
        self.evidence['planSha256'] = self.plan_sha
        # New E1 pin rejects stale receipts before entering commit.
        with self.assertRaisesRegex(ValueError, 'E1 foreign scope/plan/database'):
            self.commit()
        # Still exercise commit's independent plan guard using an already prepared
        # deployment, then a deliberately corrupted operation plan hash.
        with self.context(), gc.tool.app_secret_lock() as fd:
            with self.assertRaisesRegex(ValueError, 'operation identity mismatch'):
                gc.commit(self.directory, self.snapshot, validated_after, self.plan_sha,
                          gc.sha(self.evidence), self.transport, self.ledger, lambda: None,
                          path=self.path, plan=self.plan, fd=fd)
        self.assertNotIn('put', self.calls)

    def test_frozen_app_tag_and_running_sha(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.plan['rollout']['app']['tag'] = 'different'
        with self.assertRaisesRegex(ValueError, 'same frozen app'):
            self.commit()
        self.assertNotIn('put', self.calls)

    def test_reconciliation_audit_backup_and_pins(self):
        gc.backup_registry(self.directory, self.snapshot)
        self.race = 'app-readback'
        with self.assertRaises(ValueError):
            self.commit()
        pending = gc.release.load_ledger(self.ledger)['entries'][-1]
        audit_path = self.directory / 'ledger-pending.json'
        audit = json.loads(audit_path.read_text())
        result = {'deployment': gc.release.rebase_app.public_deployment(self.prepare())}
        for field, message in [('mainPending', 'audit mismatch'), ('afterDeployment', 'registry pins mismatch')]:
            bad = copy.deepcopy(audit)
            if field == 'mainPending': bad[field]['planSha256'] = 'f' * 64
            else: bad[field]['releases'].pop()
            audit_path.chmod(0o600); audit_path.write_text(json.dumps(bad))
            with self.assertRaisesRegex(ValueError, message):
                gc.verify_reconciliation(self.path, pending, self.prepare(), result)
        audit_path.write_text(json.dumps(audit))
        with self.assertRaisesRegex(ValueError, 'deployment drift'):
            gc.verify_reconciliation(self.path, pending, dict(self.prepare(), unrelated='drift'), result)
        (self.directory / 'registry-before.json').unlink()
        with self.assertRaisesRegex(ValueError, 'backup missing'):
            gc.verify_reconciliation(self.path, pending, self.prepare(), result)

    def test_freshness_rechecked_after_cas_before_put(self):
        gc.backup_registry(self.directory, self.snapshot)
        def recheck():
            raise ValueError('expired while reading')
        with self.assertRaisesRegex(ValueError, 'expired while reading'):
            self.commit(recheck)
        self.assertNotIn('put', self.calls)

    def test_apply_admission_preserves_existing_ledger_contract(self):
        ledger = {'entries': [{'state': 'completed'}]}
        gc.admit_apply(self.directory, ledger)
        with self.assertRaisesRegex(ValueError, 'absolute operation'):
            gc.admit_apply(Path('relative'), ledger)
        ledger['entries'].append({'state': 'pending'})
        with self.assertRaisesRegex(ValueError, 'operation pending'):
            gc.admit_apply(self.directory, ledger)
        ledger['entries'] = [{'state': 'completed', 'registrySha256': 'a' * 64}]
        gc.admit_apply(self.directory, ledger)

    def test_reviewed_inputs_rechecked(self):
        evidence = self.directory / 'evidence.json'; evidence.write_text('{}')
        with patch.object(gc.release, 'load_plan', return_value={'changed': True}):
            with self.assertRaisesRegex(ValueError, 'reviewed inputs changed'):
                gc.verify_inputs('path', {}, evidence, {})
        with patch.object(gc.release, 'load_plan', return_value={}):
            with self.assertRaisesRegex(ValueError, 'reviewed inputs changed'):
                gc.verify_inputs('path', {}, evidence, {'different': True})

    def test_target_is_plan_bound(self):
        plan = {'amiId': self.target['amiId'], 'databaseSystemIdentifier': SYSTEM_ID,
                'bake': {k: self.target[k] for k in gc.release.BAKE_KEYS if k in self.target}}
        gc.check_target(self.target, plan)
        plan['amiId'] = 'ami-' + 'f' * 17
        with self.assertRaisesRegex(ValueError, 'target does not match plan'):
            gc.check_target(self.target, plan)

    def test_dry_run_has_no_lock_transport_or_writes(self):
        paths = {}
        for name, value in (('snapshot', self.snapshot), ('evidence', self.evidence)):
            paths[name] = self.directory / (name + '.json')
            paths[name].write_text(json.dumps(value))
        plan = {'amiId': self.target['amiId'], 'databaseSystemIdentifier': SYSTEM_ID, 'bake': {k: self.target[k] for k in gc.release.BAKE_KEYS if k in self.target}}
        with patch.object(gc.release, 'load_plan', return_value=plan), patch.object(gc.release, 'plan_roles', return_value=self.roles), \
             patch.object(gc.release, 'digest', return_value=self.plan_sha), patch.object(gc.manifest, 'load', return_value=self.target), \
             patch.object(gc.tool, 'app_secret_lock', side_effect=AssertionError('lock forbidden')), \
             patch.object(gc.tool, 'secret_aws', side_effect=AssertionError('network forbidden')), \
             patch.object(gc, 'datetime') as clock, contextlib.redirect_stdout(io.StringIO()) as out:
            clock.now.return_value = self.now
            clock.fromisoformat.side_effect = datetime.fromisoformat
            gc.main(['--plan', '/tmp/plan.json', '--manifest', '/tmp/manifest.json', '--snapshot', str(paths['snapshot']),
                     '--evidence', str(paths['evidence']), '--lower-image-digest', self.drops[0]['lowerImageDigest'], '--ami-id', self.drops[0]['amiId']])
        result = json.loads(out.getvalue())
        self.assertEqual(set(result), {'before', 'after', 'evidenceCheck'})
        self.assertEqual(len(result['before']) - len(result['after']), 1)
        self.assertEqual(len(list(self.directory.iterdir())), 2)

    def test_original_plan_binding_dry_run_then_apply_preflight(self):
        plan = {'amiId': self.target['amiId'], 'databaseSystemIdentifier': SYSTEM_ID, 'bake': {k:self.target[k] for k in gc.release.BAKE_KEYS if k in self.target}}
        raw = json.dumps(plan)
        self.path.write_text(raw)
        self.plan_sha = gc.release.digest(self.path)
        self.evidence['planSha256'] = self.plan_sha
        self.evidence['proof'] = dict(self.evidence['proof'], originalPlanJson=raw)
        self.rows('releasePlans', [plan])
        self.evidence['referenceBindings'] = [{'kind':'original_plan_target', 'source':'releasePlans',
            'rowSha256':gc.sha(plan), 'proofSha256':gc.sha(self.evidence['proof'])}]
        paths = {}
        for name,value in (('snapshot',self.snapshot), ('evidence',self.evidence)):
            paths[name] = self.root / (name + '.json')
            paths[name].write_text(json.dumps(value))
        args = ['--plan',str(self.path), '--manifest','/unused', '--snapshot',str(paths['snapshot']),
                '--evidence',str(paths['evidence']), '--lower-image-digest',self.drops[0]['lowerImageDigest'],
                '--ami-id',self.drops[0]['amiId']]
        def mock_commit(*args, **kwargs):
            args[7]()  # exercise the same callback used inside real commit
        with patch.object(gc.release,'load_plan',return_value=plan), \
             patch.object(gc.release,'plan_roles',return_value=self.roles), \
             patch.object(gc.manifest,'load',return_value=self.target), \
             patch.object(gc.tool,'app_secret_lock',return_value=contextlib.nullcontext(123)), \
             patch.object(gc.tool,'secret_aws',return_value=self.envelope()) as transport, \
             patch.object(gc.release,'load_ledger',return_value={'entries':[{'generation':1}]}), \
             patch.object(gc.release,'ledger_drift'), \
             patch.object(gc,'commit',side_effect=mock_commit) as commit, \
             patch.object(gc,'check_evidence',wraps=gc.check_evidence) as check, \
             patch.object(gc,'datetime') as clock, contextlib.redirect_stdout(io.StringIO()):
            clock.now.return_value = self.now
            clock.fromisoformat.side_effect = datetime.fromisoformat
            gc.main(args)
            transport.assert_not_called()
            gc.main([*args,'--apply','--operation-dir',str(self.root / 'apply-preflight')])
            commit.assert_called_once()
            self.assertEqual(check.call_count,4)
            self.assertTrue(all(call.args[-2] is self.target and call.args[-1] == SYSTEM_ID for call in check.call_args_list))

    def test_duplicate_cli_identity_flags_refuse_before_artifact_read(self):
        args = ['--plan', '/tmp/missing-plan.json', '--manifest', '/tmp/missing-manifest.json',
                '--snapshot', '/tmp/missing-snapshot.json', '--evidence', '/tmp/missing-evidence.json',
                '--lower-image-digest', self.drops[0]['lowerImageDigest'], '--ami-id', self.drops[0]['amiId']]
        for flag in ('--ami-id', '--lower-image-digest'):
            with self.assertRaisesRegex(ValueError, 'multiple CLI identities'):
                gc.main([*args, flag, 'second'])


class HistoricalAttestationTests(unittest.TestCase):
    setUp = RegistryGcTests.setUp
    tearDown = RegistryGcTests.tearDown
    envelope = RegistryGcTests.envelope
    prepare = RegistryGcTests.prepare
    rows = RegistryGcTests.rows
    refuse = RegistryGcTests.refuse

    def fixture(self, pool=True):
        self.evidence['attestations'] = []
        self.rows('poolHosts', [])
        self.rows('executions', [])
        self.instance = 'i-0123456789abcdef0'
        record = self.records[1]
        document = {'schemaVersion': 1, 'jobId': '22222222-2222-4222-8222-222222222222', 'operation': 'pool-retire', 'poolHostId': '11111111-1111-4111-8111-111111111111',
                    'poolGeneration': 1, 'providerInstanceId': self.instance,
                    'computerId': '11111111-1111-4111-8111-111111111111', 'targetGeneration': 1, 'leaseEpoch': 1, 'fenceToken': '33333333-3333-4333-8333-333333333333',
                    'deployment': record}
        full = json.loads((HERE / 'runtime-retirement-intent.json').read_text())
        deployment = full['deployment']
        deployment.update({k:record[k] for k in deployment if k in record})
        deployment['dataKeyArn'] = f"arn:aws:kms:{record['region']}:{record['accountId']}:key/11111111-1111-4111-8111-111111111111"
        full.update(document, deployment=deployment)
        document = full
        raw = gc.canonical(document).decode()
        saved = {'document': raw, 'digest': gc.hashlib.sha256(raw.encode()).hexdigest()}
        output = {'jobId': '22222222-2222-4222-8222-222222222222', 'digest': saved['digest'], 'poolHostId': '11111111-1111-4111-8111-111111111111',
                  'poolGeneration': 1, 'instanceId': self.instance, 'state': 'retired',
                  'schemaVersion': 1, 'computerId': '11111111-1111-4111-8111-111111111111', 'generation': 1, 'leaseEpoch': 1,
                  'fenceToken': '33333333-3333-4333-8333-333333333333', 'volumeId': None}
        self.arn = f'arn:aws:states:{gc.tool.REGION}:{gc.tool.ACCOUNT}:execution:test:retire-job'
        self.d = {'executionArn': self.arn, 'status': 'SUCCEEDED',
                  'stateMachineArn': record['stateMachineVersionArn'].rsplit(':',1)[0], 'name':'22222222-2222-4222-8222-222222222222',
                  'stateMachineVersionArn': record['stateMachineVersionArn'],
                  'input': gc.canonical(saved).decode(), 'inputDetails': {'included': True},
                  'output': gc.canonical(output).decode(), 'outputDetails': {'included': True},
                  'startDate': '2026-10-24T18:00:00Z', 'stopDate': '2026-10-24T18:01:00Z'}
        self.h = {'events': [
            {'id': 1, 'type': 'ExecutionStarted', 'timestamp': self.d['startDate'],
             'executionStartedEventDetails': {'input': self.d['input'],
                                              'stateMachineVersionArn': self.d['stateMachineVersionArn']}},
            {'id': 2, 'type': 'ExecutionSucceeded', 'timestamp': self.d['stopDate'],
             'executionSucceededEventDetails': {'output': self.d['output']}}]}
        event = {'eventID': 'event-id', 'eventTime': '2026-10-24T18:00:01Z',
                 'eventName': 'TerminateInstances', 'eventSource': 'ec2.amazonaws.com',
                 'awsRegion': gc.tool.REGION, 'recipientAccountId': gc.tool.ACCOUNT,
                 'responseElements': {'instancesSet': {'items': [{'instanceId': self.instance,
                         'currentState': {'name': 'shutting-down'}}]}}}
        self.evidence['proof'] = {'usage': [], 'inventoryCapturedAt': '2026-10-24T18:59:00Z',
                                 'databaseMeta': {'system_identifier': SYSTEM_ID, 'captured_at': '2026-10-24T18:59:00Z'},
                                 'fenceActivatedAt': '2026-10-24T18:50:00Z',
                                 'cloudTrail': [event], 'executions': {self.arn: {'describe': self.d, 'history': self.h}}}
        self.absence = {'inventorySha256': gc.sha(gc.inventory(self.evidence)),
                        'inventoryCapturedAt': '2026-10-24T18:59:00Z', 'terminationEventId': 'event-id',
                        'terminationEventTime': event['eventTime'], 'terminationEventSha256': gc.sha(event)}
        self.a = {'kind': 'execution_terminal', 'source': 'executions', 'rowSha256': gc.sha(self.d),
                  'executionArn': self.arn, 'status': 'SUCCEEDED', 'versionArn': self.d['stateMachineVersionArn'],
                  'describeSha256': gc.sha(self.d), 'historySha256': gc.sha(self.h),
                  'resources': {self.instance: {'disposition': 'attested', **self.absence}}}
        self.rows('executions', [self.d])
        self.evidence['attestations'] = [self.a]
        self.p = dict(id='11111111-1111-4111-8111-111111111111', generation=1, instance_id=self.instance, state='retired',
                      dispatch_status='settled', lifecycle_input=self.d['input'],
                      lifecycle_digest=saved['digest'], lifecycle_job_id='22222222-2222-4222-8222-222222222222',
                      **dict.fromkeys(gc.CLAIMS))
        self.pa = {'kind': 'pool_host_retired_settled', 'source': 'poolHosts', 'rowSha256': gc.sha(self.p),
                   'poolId': '11111111-1111-4111-8111-111111111111', 'generation': 1, 'instanceId': self.instance, 'state': 'retired',
                   'dispatchStatus': 'settled', 'lifecycleDigest': saved['digest'], 'retireJobId': '22222222-2222-4222-8222-222222222222',
                   'executionArn': self.arn, 'executionStatus': 'SUCCEEDED', 'receiptSha256': gc.sha(output),
                   'versionArn': self.a['versionArn'], 'describeSha256': self.a['describeSha256'],
                   'historySha256': self.a['historySha256'], **self.absence}
        if pool:
            self.rows('poolHosts', [self.p])
            self.evidence['attestations'].append(self.pa)
        self.prepare()

    def sync(self):
        self.rows('executions', [self.d])
        self.a.update(rowSha256=gc.sha(self.d), describeSha256=gc.sha(self.d), historySha256=gc.sha(self.h))
        if self.evidence['sources']['poolHosts']['rows']:
            self.rows('poolHosts', [self.p])
            self.pa.update(rowSha256=gc.sha(self.p), describeSha256=gc.sha(self.d), historySha256=gc.sha(self.h))

    def receipt(self, change):
        output = json.loads(self.d['output']); change(output)
        self.d['output'] = gc.canonical(output).decode()
        self.h['events'][-1]['executionSucceededEventDetails']['output'] = self.d['output']
        self.evidence['proof']['executions'][self.arn] = {'describe': self.d, 'history': self.h}
        self.pa['receiptSha256'] = gc.sha(output)
        self.sync()

    def test_retire_receipt_full_dispatch_contract(self):
        cases = {'schemaVersion missing': lambda o: o.pop('schemaVersion'), 'schemaVersion 2': lambda o: o.update(schemaVersion=2),
                 'schemaVersion bool': lambda o: o.update(schemaVersion=True),
                 'computerId': lambda o: o.update(computerId='other'), 'generation': lambda o: o.update(generation=2),
                 'leaseEpoch': lambda o: o.update(leaseEpoch=2), 'fenceToken': lambda o: o.update(fenceToken='other'),
                 'volumeId missing': lambda o: o.pop('volumeId'), 'volumeId set': lambda o: o.update(volumeId='')}
        for name, change in cases.items():
            with self.subTest(case=name):
                self.fixture(); self.receipt(change); self.refuse('retirement not confirmed')
        self.fixture(); self.receipt(lambda o: None); self.assertEqual(len(self.prepare()['releases']), 7)

    def test_freshness_bound_to_database_identity_snapshot_and_fence(self):
        meta = self.evidence['proof']['databaseMeta']
        for name, change, text in (
                ('foreign database', lambda: meta.update(system_identifier='1'), 'foreign or unbound database'),
                ('missing database meta', lambda: self.evidence['proof'].pop('databaseMeta'), 'foreign or unbound database'),
                ('stale snapshot with fresh stamp', lambda: meta.update(captured_at='2026-10-24T17:00:00Z'), 'not bound to the database snapshot'),
                ('inventory far from snapshot', lambda: self.evidence['proof'].update(inventoryCapturedAt='2026-10-24T18:40:00Z'), 'inventory capture not bound'),
                ('future inventory', lambda: self.evidence['proof'].update(inventoryCapturedAt='2026-10-24T19:03:00Z'), 'inventory capture not bound'),
                ('captured before fence', lambda: self.evidence['proof'].update(fenceActivatedAt='2026-10-24T18:59:30Z'), 'held writer fence'),
                ('missing fence', lambda: self.evidence['proof'].pop('fenceActivatedAt'), 'held writer fence')):
            with self.subTest(case=name):
                self.setUp(); meta = self.evidence['proof']['databaseMeta']; change(); self.refuse(text)
        self.setUp()
        with self.assertRaisesRegex(ValueError, 'foreign or unbound database'):
            gc.prepare(self.snapshot, self.target, self.roles, self.evidence, self.drops, self.plan_sha, self.now)

    def test_accepts_one_pool_and_one_execution(self):
        self.fixture()
        self.assertEqual(len(self.prepare()['releases']), 7)

    def test_row_hash_spare_duplicate_missing_and_type(self):
        for case in ('hash', 'spare', 'duplicate', 'missing', 'kind', 'source', 'type'):
            with self.subTest(case=case):
                self.fixture()
                if case == 'hash': self.pa['rowSha256'] = '0' * 64
                if case == 'spare': self.evidence['attestations'].append(dict(self.pa, rowSha256='1' * 64))
                if case == 'duplicate': self.evidence['attestations'].append(self.pa.copy())
                if case == 'missing': self.evidence['attestations'].pop()
                if case == 'kind': self.pa['kind'] = 'retired'
                if case == 'source': self.pa['source'] = 'placements'
                if case == 'type': self.evidence['attestations'] = {}
                self.refuse('GC|E1')

    def test_pool_guards(self):
        for key, value in [('id', 'forged'), ('generation', 2), ('state', 'ready'),
                           ('dispatch_status', 'pending'), ('dispatch_status', 'unknown'),
                           ('dispatch_status', 'started'), ('lifecycle_job_id', 'wrong'),
                           ('lifecycle_digest', '0' * 64), *[(k, 'active') for k in gc.CLAIMS]]:
            with self.subTest(key=key, value=value):
                self.fixture(); self.p[key] = value; self.sync(); self.refuse('GC')
        self.fixture(); self.pa['receiptSha256'] = '0' * 64; self.refuse('retirement not confirmed')

    def test_execution_guards(self):
        for case in ('hash', 'running', 'version', 'history', 'identity', 'receipt', 'row', 'resources', 'disposition'):
            with self.subTest(case=case):
                self.fixture(pool=False)
                if case == 'running': self.d['status'] = 'RUNNING'
                if case == 'version': self.d['stateMachineVersionArn'] = 'alias'
                if case == 'history': self.h['nextToken'] = 'more'
                if case == 'identity': self.h['events'][0]['executionStartedEventDetails']['input'] = '{}'
                if case == 'receipt': self.h['events'][-1]['executionSucceededEventDetails']['output'] = '{}'
                if case == 'row': self.a['status'] = 'FAILED'
                if case == 'resources': self.a['resources'] = {}
                if case == 'disposition': self.a['resources'][self.instance]['disposition'] = 'gone'
                self.sync()
                if case == 'hash': self.a['historySha256'] = '0' * 64
                self.refuse('GC|E1')

    def test_absence_guards_and_every_join(self):
        for case in ('hash', 'time', 'eventMissing', 'eventWrong', 'instances', 'volumes', 'snapshots', 'placements', 'usage'):
            with self.subTest(case=case):
                self.fixture(pool=False)
                disposition = self.a['resources'][self.instance]
                if case == 'hash': disposition['inventorySha256'] = '0' * 64
                if case == 'time': disposition['inventoryCapturedAt'] = '2026-10-24T17:00:00Z'
                if case == 'eventMissing': self.evidence['proof']['cloudTrail'] = []
                if case == 'eventWrong': disposition['terminationEventSha256'] = '0' * 64
                if case in ('instances', 'volumes', 'snapshots', 'placements'):
                    self.rows(case, [{'instanceId': self.instance}])
                if case == 'usage': self.evidence['proof']['usage'] = [{'instance_id': self.instance}]
                if case in ('instances', 'volumes', 'snapshots', 'placements', 'usage'):
                    disposition['inventorySha256'] = gc.sha(gc.inventory(self.evidence))
                self.refuse('GC|E1')
                for name in ('instances', 'volumes', 'snapshots', 'placements'): self.rows(name, [])

    def test_kept_resources_exact_join(self):
        self.fixture(pool=False)
        disposition = {'disposition': 'kept-record', 'record': gc.identity(self.records[-1])}
        self.a['resources'][self.instance] = disposition
        self.rows('instances', [{'InstanceId': self.instance, 'ImageId': self.records[-1]['amiId']}])
        self.prepare()
        disposition['record'] = gc.identity(self.records[1]); self.refuse('not a kept record')
        disposition['record'] = gc.identity(self.records[-1])
        self.rows('instances', []); self.refuse('exact kept AMI join')
        resource = 'vol-0123456789abcdef0'
        with self.assertRaisesRegex(ValueError, 'lacks attachment'):
            gc.kept_resource(self.evidence, self.snapshot, self.records[1], resource, disposition)
        self.rows('volumes', [{'VolumeId': resource, 'Attachments': [{'InstanceId': self.instance}]}])
        self.rows('instances', [{'InstanceId': self.instance, 'ImageId': self.records[-1]['amiId']}])
        gc.kept_resource(self.evidence, self.snapshot, self.records[1], resource, disposition)

    def test_no_absent_volume_exemption(self):
        self.fixture(pool=False)
        volume = 'vol-0123456789abcdef0'
        self.d['extraVolume'] = volume
        self.a['resources'][volume] = {'disposition': 'attested', **self.absence}
        self.sync(); self.refuse('absent volume')

    def test_no_blanket_exemptions_for_operative_rows(self):
        for source, row in [('placements', {'state': 'STOPPED'}),
                            ('imageJobs', {'phase': 'failed'}), ('imageJobs', {'phase': 'unconfirmed'}),
                            ('instances', {'State': {'Name': 'running'}}), ('volumes', {'State': 'in-use'})]:
            with self.subTest(source=source, row=row):
                self.fixture(pool=False)
                self.rows(source, [dict(row, amiId=self.records[1]['amiId'])])
                self.a['resources'][self.instance]['inventorySha256'] = gc.sha(gc.inventory(self.evidence))
                self.refuse('referenced record')
                self.rows(source, [])

    def test_ambiguous_digest_cannot_hide_in_attested_row(self):
        self.fixture(pool=False)
        self.d['unresolvedSource'] = {'lowerImageDigest': self.records[1]['lowerImageDigest']}
        self.sync(); self.refuse('undisambiguated digest-only')

    def test_resource_ids_exclude_eni(self):
        self.assertEqual(gc.resource_ids({'ids': 'eni-0123456789abcdef0 i-0123456789abcdef0 vol-0123456789abcdef0'}),
                         {'i-0123456789abcdef0', 'vol-0123456789abcdef0'})


    def test_attestation_container_type_even_without_references(self):
        self.evidence['attestations'] = {}
        self.refuse('attestations must be a list')

    def test_all_terminal_statuses_require_resource_closure(self):
        for status, event_type in gc.TERMINAL.items():
            self.fixture(pool=False)
            self.d['status'] = self.a['status'] = status
            self.h['events'][-1]['type'] = event_type
            self.sync(); self.prepare()
            self.a['resources'] = {}; self.refuse('unresolved execution resources')

    def test_collector_builds_proofs_and_reports_missing_cloudtrail(self):
        self.fixture()
        directory = self.root / 'export'
        directory.mkdir()
        def write(name, value):
            (directory / name).write_text(json.dumps(value))
        write('db-evidence.json', {'meta': {'captured_at': self.evidence['capturedAt'], 'system_identifier': SYSTEM_ID},
              'placements': [], 'image_jobs': [], 'pool_hosts': [self.p],
              'writer_leases': [], 'migrations': [], 'usage': []})
        write('registry-snapshot.json', self.records)
        write('ec2-instances.json', {'Reservations': []})
        write('ec2-volumes.json', {'Volumes': []})
        write('ec2-snapshots.json', {'Snapshots': []})
        write('sfn-lifecycle.json', {'executions': [{k:v for k,v in self.d.items() if k not in ('redriveStatus','redriveStatusReason')}]})
        (directory / 'exec107').mkdir()
        self.d['redriveStatus'] = 'NOT_REDRIVABLE'
        self.d['redriveStatusReason'] = 'Execution is SUCCEEDED'
        write('exec107/test.describe.json', self.d)
        write('exec107/test.history.json', self.h)
        write('cloudtrail.json', {'Records': self.evidence['proof']['cloudTrail']})
        self.sync()
        context = {k: self.evidence[k] for k in ('planSha256', 'secretVersionId', 'quiescence')}
        context['inventoryCapturedAt'] = self.evidence['proof']['inventoryCapturedAt']
        context['fenceActivatedAt'] = self.evidence['proof']['fenceActivatedAt']
        context['originalPlanJson'] = self.path.read_text()
        context['sources'] = {k: self.evidence['sources'][k] for k in ('runtimeConfigs', 'releasePlans')}
        with patch.dict(sys.modules, {'registry_gc': gc}):
            spec = importlib.util.spec_from_file_location('collector_under_test', HERE.parent / 'registry_gc_evidence.py')
            collector = importlib.util.module_from_spec(spec); spec.loader.exec_module(collector)
        def collect_fixture(execution_rows=None):
            # TEST ONLY independent expected collector source mapping, not a mocked validator.
            expected = copy.deepcopy(self.evidence)
            queries = {'placements':'db-evidence.json:placements', 'imageJobs':'db-evidence.json:image_jobs',
                       'poolHosts':'db-evidence.json:pool_hosts', 'writerLeases':'db-evidence.json:writer_leases',
                       'providerMigrations':'db-evidence.json:migrations',
                       'executions':'sfn-*.json + exec*/*.describe.json'}
            for name in ('instances','volumes','snapshots'):
                queries[name] = 'ec2-' + name + '.json (all account resources)'
            for name,query in queries.items(): expected['sources'][name]['query'] = query
            if execution_rows is not None: expected['sources']['executions']['rows'] = execution_rows
            write('test-context-sources.json', context['sources'])
            files = {str(path.relative_to(directory)):gc.hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in directory.rglob('*.json') if 'E1' not in path.relative_to(directory).parts}
            synthetic_e1(expected, self.path.read_text(), files)
            (directory / 'E1').mkdir(exist_ok=True)
            write('E1/collection-receipts.json', expected['proof']['collectionReceipts'])
            with patch.object(collector, 'datetime') as clock:
                clock.now.return_value = self.now
                return collector.collect(directory, self.records[1]['recipeVersion'], context)

        result = collect_fixture()
        self.assertEqual(len(result['attestations']), 2)
        self.assertEqual(result['collection']['unresolved'], [])
        gc.check_evidence(result, self.snapshot, self.plan_sha, self.records[1], self.now, None, SYSTEM_ID)
        self.assertEqual(result['sources']['poolHosts']['rows'], [self.p])
        self.assertEqual(result['collection']['filesSha256']['cloudtrail.json'],
                         gc.hashlib.sha256((directory / 'cloudtrail.json').read_bytes()).hexdigest())
        (directory / 'cloudtrail.json').unlink()
        result = collect_fixture()
        self.assertEqual(result['attestations'], [])
        self.assertEqual(len(result['collection']['unresolved']), 2)
        with self.assertRaisesRegex(ValueError, 'incomplete or uncertain'):
            gc.check_evidence(result, self.snapshot, self.plan_sha, self.records[1], self.now, None, SYSTEM_ID)
        # Snapshot child coverage appears only with complete image + every-template version inventories.
        self.assertNotIn('snapshotChildCoverage', result['proof'])
        write('ec2-images.json', {'Images': []})
        write('ec2-lt.json', {'LaunchTemplates': [{'LaunchTemplateId': 'lt-1', 'LatestVersionNumber': 2}]})
        write('ec2-lt-versions.json', {'LaunchTemplateVersions': [{'LaunchTemplateId': 'lt-1', 'VersionNumber': 1},
                                                                  {'LaunchTemplateId': 'lt-1', 'VersionNumber': 2}]})
        result = collect_fixture()
        cov = result['proof']['snapshotChildCoverage']
        self.assertEqual((cov['complete'], cov['definitionsSha256']), (True, gc.sha(result['proof']['ec2Definitions'])))
        write('ec2-lt-versions.json', {'LaunchTemplateVersions': [{'LaunchTemplateId': 'lt-1', 'VersionNumber': 2}]})
        result = collect_fixture()
        self.assertNotIn('snapshotChildCoverage', result['proof'])
        self.assertTrue(any('version history incomplete' in u['reason'] for u in result['collection']['unresolved']))
        for name in ('ec2-images.json', 'ec2-lt.json', 'ec2-lt-versions.json'):
            (directory / name).unlink()
        # A preserved provider receipt wraps exactly one raw record under 'event' (root receipt shape).
        event = self.evidence['proof']['cloudTrail'][0]
        write('cloudtrail-receipt.json', {'schemaVersion': 1, 'capturedAt': '2026-10-24T18:59:00Z', 'complete': True,
              'resourceId': self.instance, 'query': 'lookup-events EventId=' + event['eventID'], 'omittedFields': [], 'event': event})
        result = collect_fixture()
        self.assertEqual((len(result['attestations']), result['collection']['unresolved']), (2, []))
        (directory / 'cloudtrail-receipt.json').unlink()
        # Stale DB export with a fresh context stamp is refused, never restamped.
        for stamp in ({'capturedAt': '2026-10-24T19:00:30Z'}, {'expiresAt': '2026-10-24T19:30:00Z'}):
            with self.subTest(restamp=stamp), self.assertRaisesRegex(ValueError, 'restamps capture time'):
                collector.collect(directory, self.records[1]['recipeVersion'], dict(context, **stamp))
        write('cloudtrail.json', {'Records': self.evidence['proof']['cloudTrail']})
        # The list says RUNNING while a cached describe says FAILED: unresolved, not replaced.
        write('sfn-lifecycle.json', {'executions': [dict(self.d, status='RUNNING', stopDate=None)]})
        write('exec107/test.describe.json', dict(self.d, status='FAILED'))
        result = collect_fixture([dict(self.d, status='RUNNING', stopDate=None)])
        gaps = result['sources']['executions']['uncertain']
        self.assertTrue(any('nonterminal' in g for g in gaps) and any('contradicts list' in g for g in gaps), gaps)
        with self.assertRaisesRegex(ValueError, 'incomplete or uncertain'):
            gc.check_evidence(result, self.snapshot, self.plan_sha, self.records[1], self.now, None, SYSTEM_ID)
        # Duplicate conflicting list observations are also unresolved.
        write('sfn-lifecycle.json', {'executions': [self.d]})
        write('sfn-recovery.json', {'executions': [dict(self.d, stopDate='2026-10-24T18:02:00Z')]})
        write('exec107/test.describe.json', self.d)
        result = collect_fixture()
        self.assertTrue(any('duplicate/ambiguous list observations' in g for g in result['sources']['executions']['uncertain']))

    def test_full_checker_cannot_omit_execution_history(self):
        self.fixture(pool=False)
        before=copy.deepcopy(self.evidence['collection'])
        self.evidence['proof']['executions'][self.arn].pop('history')
        self.evidence['collection']['proofFileBindings'].pop(json.dumps(['executions',self.arn,'history']))
        self.refuse('complete supplemental proof mismatch')
        self.assertEqual(before['fileContents'],self.evidence['collection']['fileContents'])
        self.assertEqual(before['receiptManifestSha256'],self.evidence['collection']['receiptManifestSha256'])

    def test_full_runtime_intent_counterexamples(self):
        for mutation in ('identity','generation','missing','boolean'):
            self.fixture()
            work = json.loads(self.d['input']); doc = json.loads(work['document'])
            output = json.loads(self.d['output'])
            if mutation == 'identity': doc['computerId'] = output['computerId'] = '44444444-4444-4444-8444-444444444444'
            if mutation == 'generation': doc['targetGeneration'] = output['generation'] = 7
            if mutation == 'missing': doc.pop('revision')
            if mutation == 'boolean': doc['leaseEpoch'] = output['leaseEpoch'] = True
            work['document'] = gc.canonical(doc).decode()
            work['digest'] = gc.hashlib.sha256(work['document'].encode()).hexdigest()
            output['digest'] = work['digest']
            self.d['input'] = self.p['lifecycle_input'] = gc.canonical(work).decode()
            self.p['lifecycle_digest'] = self.pa['lifecycleDigest'] = work['digest']
            self.d['output'] = gc.canonical(output).decode()
            self.h['events'][0]['executionStartedEventDetails']['input'] = self.d['input']
            self.h['events'][-1]['executionSucceededEventDetails']['output'] = self.d['output']
            self.pa['receiptSha256'] = gc.sha(output)
            self.sync()
            with self.subTest(mutation=mutation), self.assertRaisesRegex(ValueError,'retirement not confirmed'):
                gc.validate_attestation(self.pa,self.p,self.evidence,self.snapshot,self.records[1])

    def test_pool_attestation_identity_and_intent_are_bound(self):
        self.fixture(); self.pa['poolId'] = 'forged'; self.refuse('pool identity mismatch')
        self.fixture(); self.pa['lifecycleDigest'] = '0' * 64; self.refuse('retire intent mismatch')
        self.fixture(pool=False); self.a['kind'] = 'untyped'; self.refuse('invalid attestation kind')

    def test_pool_tag_resource_join_refuses(self):
        self.fixture()
        self.rows('volumes', [{'VolumeId': 'vol-0123456789abcdef0',
                               'Tags': [{'Key': 'pool-host', 'Value': self.p['id']}]}])
        digest = gc.sha(gc.inventory(self.evidence))
        self.pa['inventorySha256'] = digest
        self.a['resources'][self.instance]['inventorySha256'] = digest
        self.refuse('volume/snapshot/usage/placement join')

    def test_disposition_type_cannot_fall_through_to_kept_record(self):
        self.fixture(pool=False)
        self.a['resources'][self.instance] = {'disposition': 'untyped', 'record': gc.identity(self.records[-1])}
        self.rows('instances', [{'InstanceId': self.instance, 'ImageId': self.records[-1]['amiId']}])
        self.refuse('invalid resource disposition')


if __name__ == '__main__':
    unittest.main(verbosity=2)
