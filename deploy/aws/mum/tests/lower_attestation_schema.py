#!/usr/bin/env python3
"""Offline lower-attestation installer cases: fake AWS/SSM and a modelled DB.

No live AWS, SSM, database or credentials. The DB model implements only the
transaction's gate/apply/verify control flow; PostgreSQL catalog semantics are
proved by lower_attestation_schema_pg.py on an owned disposable container.
Both transports run: staging (S3 + URL program) and production (inline exec script).
"""
import base64
import copy
import gzip
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lower_attestation_schema as la
import rebase_manifest as manifest

SQL = b"-- synthetic lower attestation SQL\nCREATE TABLE public.ezil_computer_lower_attestations (attestation_id uuid NOT NULL);\n"
SQL_SHA = la.sha(SQL)
AFTER = {'table': {'owner': 'postgres', 'rls': True, 'acl': [['postgres', 'SELECT', False]]}, 'functions': [{'owner': 'postgres', 'acl': []}]}
CONTRACT = {'schemaVersion': 1, 'sqlSha256': SQL_SHA, 'empty': la.EMPTY, 'after': AFTER}
CMD = '11111111-1111-4111-8111-111111111111'
STAGING_URL = 'postgresql://postgres:synthetic-secret@10.61.20.35:5432/postgres'


class Fixture(unittest.TestCase):
    target_name = 'staging'

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.dir = Path(self.temp.name)
        self.sql_path = self.dir / 'sql.txt'; self.sql_path.write_bytes(SQL)
        self.catalog = self.dir / 'catalog.json'; self.catalog.write_text(json.dumps(CONTRACT))
        self.kw = dict(sql_path=self.sql_path, catalog_path=self.catalog, pin=SQL_SHA)
        self.target = la.TARGETS[self.target_name]
        self.state = copy.deepcopy(la.EMPTY); self.persist_empty = False
        self.account = la.ACCOUNT; self.tags = dict(self.target['tags'] or {}); self.url = STAGING_URL
        self.lost_send = self.fail_command = self.pending = False
        self.psql_calls = []; self.transactions = []; self.sent = []
        quiet = patch('sys.stdout', new_callable=io.StringIO); quiet.start(); self.addCleanup(quiet.stop)

    # fake psql: models the gate / apply / verify structure of the generated transaction
    def psql(self, tx):
        read = 'READ ONLY;' in tx.split('\n', 1)[0]
        expected = json.loads(re.search(r"set_config\('ezil.la_expected', '(.*?)', true\)", tx, re.S)[1].replace("''", "'"))
        before = copy.deepcopy(self.state)
        if '$gate$' in tx:
            want = la.EMPTY if """DISTINCT FROM '{"functions":[],"table":null}'::jsonb""" in tx else expected
            if before != want: return 1, ''
        if '$apply$' in tx:
            assert not read
            if not self.persist_empty: self.state = copy.deepcopy(AFTER)
        if '$verify$' in tx and self.state != expected: return 1, ''
        field = lambda name: re.search(r"'" + name + r"','([0-9a-f]+)'", tx)[1]
        receipt = {'schemaVersion': 1, 'target': self.target_name, 'systemIdentifier': self.target['system_id'], 'database': 'postgres', 'role': 'postgres',
                   'sqlSha256': field('sqlSha256'), 'planSha256': field('planSha256'), 'nonce': field('nonce'), 'mode': 'read' if read else 'apply',
                   'applied': '$apply$' in tx, 'before': before, 'defaultAcl': [], 'after': copy.deepcopy(self.state)}
        return 0, json.dumps(receipt)

    def run_remote(self, body):
        if "EZIL_LA_PY" in body:
            return self.run_url_program(body)
        self.assertIn('[ "$id" = "i-09012068d96166828" ]', body); self.assertIn("grep -qx '10.63.20.252'", body)
        self.assertIn('docker exec -i', body); self.assertIn(' supabase-db env -u PGSERVICE -u PGHOSTADDR', body); self.assertIn('-U postgres -d postgres', body)
        self.assertIn('-h /var/run/postgresql -p 5432 -U postgres -d postgres', body)
        for pinned in ('-e PGHOST=/var/run/postgresql', '-e PGPORT=5432', ' env -u PGSERVICE -u PGHOSTADDR', '-e PGSERVICEFILE=/dev/null', '-e PGSYSCONFDIR=/nonexistent', 'test -S /var/run/postgresql/.s.PGSQL.5432 || exit 73'):
            self.assertIn(pinned, body)
        for forbidden in ('postgresql://', 's3://', 'PGPASSWORD', 'password', 'ssh ', 'tunnel'):
            self.assertNotIn(forbidden, body)
        payload = re.search(r"printf '%s' '([A-Za-z0-9+/=]+)' \| base64 -d \| gzip -dc", body)[1]
        tx = gzip.decompress(base64.b64decode(payload)).decode()
        self.assertEqual(la.sha(tx.encode()), re.search(r"printf '%s  %s\\n' ([0-9a-f]{64}) ", body)[1])
        self.assertEqual('-e PGOPTIONS=-c default_transaction_read_only=on' in body.replace("'", ''), 'READ ONLY;' in tx.split('\n', 1)[0])
        if 'READ ONLY;' not in tx.split('\n', 1)[0]: self.assertIn('env -u PGSERVICE -u PGHOSTADDR -u PGOPTIONS psql', body)  # inherited container options never apply
        self.transactions.append(tx)
        code, out = self.psql(tx)
        return {'Status': 'Success' if code == 0 else 'Failed', 'ResponseCode': code, 'StandardOutputContent': out}

    def run_url_program(self, body):
        script = body.split("<<'EZIL_LA_PY'\n", 1)[1].rsplit('\nEZIL_LA_PY', 1)[0]
        def run(command, **kwargs):
            self.psql_calls.append((command, kwargs['env'])); self.transactions.append(kwargs['input'])
            code, out = self.psql(kwargs['input'])
            return subprocess.CompletedProcess(command, code, stdout=out, stderr='')
        output, error = io.StringIO(), io.StringIO()
        with patch('pathlib.Path.read_text', return_value='OTHER=1\nSUPABASE_DATABASE_URL=' + self.url), patch('subprocess.run', run), patch('sys.stdout', output), patch('sys.stderr', error):
            try:
                exec(compile(script, 'remote', 'exec'), {})
            except SystemExit:
                self.assertNotIn('synthetic', error.getvalue() + output.getvalue())
                return {'Status': 'Failed', 'ResponseCode': 1, 'StandardOutputContent': ''}
        self.assertNotIn('synthetic-secret', output.getvalue())
        return {'Status': 'Success', 'ResponseCode': 0, 'StandardOutputContent': output.getvalue()}

    def aws(self, *args):
        op = args[:2]; target = self.target
        if op == ('sts', 'get-caller-identity'): return {'Account': self.account}
        if op == ('ec2', 'describe-instances'):
            return {'Reservations': [{'Instances': [{'InstanceId': target['host'], 'State': {'Name': 'running'}, 'Tags': [{'Key': k, 'Value': v} for k, v in self.tags.items()]}]}]}
        if op == ('s3api', 'put-object'):
            self.assertEqual(target['transport'], 'url'); self.body = Path(args[args.index('--body') + 1]).read_text(); return {}
        if op == ('ssm', 'send-command'):
            self.comment = args[args.index('--comment') + 1]; self.sent.append(args)
            command = json.loads(args[args.index('--parameters') + 1])['commands'][0]
            self.result = self.run_remote(self.body if target['transport'] == 'url' else command)
            if self.fail_command: self.result = {'Status': 'Failed', 'ResponseCode': 1, 'StandardOutputContent': ''}
            if self.lost_send: raise TimeoutError('lost result')
            return {'Command': {'CommandId': CMD}}
        if op == ('ssm', 'list-commands'): return {'Commands': [{'Comment': self.comment, 'InstanceIds': [target['host']], 'CommandId': getattr(self, 'listed', CMD)}]}
        if op == ('ssm', 'get-command-invocation'):
            return dict(self.result, Status='InProgress') if self.pending else self.result
        if op == ('s3api', 'delete-object'): return {}
        raise AssertionError(args)

    def make_plan(self, name='r1'):
        d = self.dir / name; d.mkdir()
        la.plan(self.target_name, d, self.aws, **self.kw)
        p = d / ('lower-attestation-schema-' + self.target_name + '-plan.json')
        return d, p, la.sha(p.read_bytes())

    def do_apply(self, d, p, psha, apply=True, sql_sha=SQL_SHA):
        la.apply(self.target_name, d, p, psha, sql_sha, self.aws, apply, **self.kw)

    def lost_apply(self, name):
        d, p, psha = self.make_plan(name)
        self.lost_send = True
        with self.assertRaises(TimeoutError): self.do_apply(d, p, psha)
        self.lost_send = False
        return d, p, psha

    def file(self, d, kind):
        return d / ('lower-attestation-schema-' + self.target_name + '-' + kind + '.json')


class Boundaries(Fixture):
    def test_real_pinned_files_agree(self):
        self.assertEqual(la.PINNED_SQL_SHA256, 'ab5fcfa6341fe89595b36591cded8ede1dea506ed84801cfafdc8701e179e313')
        for name in ('staging', 'production'):
            _, data, contract = la.load_pinned(name)  # repo SQL bytes + committed golden catalog
            self.assertEqual(la.sha(data), la.PINNED_SQL_SHA256); self.assertEqual(contract['sqlSha256'], la.PINNED_SQL_SHA256)
            self.assertEqual(len(contract['after']['table']['columns']), 31)

    def test_pending_pin_unknown_target_and_missing_transport_refuse(self):
        with patch.object(la, 'PINNED_SQL_SHA256', None), self.assertRaisesRegex(ValueError, 'SQL pin pending'): la.load_pinned('staging', self.sql_path, self.catalog)
        with self.assertRaisesRegex(ValueError, 'unknown target'): la.load_pinned('prod', **self.kw)
        for name, key in (('production', 'ip'), ('production', 'container'), ('staging', 'bucket')):
            with patch.dict(la.TARGETS, {name: dict(la.TARGETS[name], **{key: None})}), self.assertRaisesRegex(ValueError, 'transport pins pending'): la.load_pinned(name, **self.kw)

    def test_hash_and_catalog_binding(self):
        self.sql_path.write_bytes(SQL + b'-- drift\n')
        with self.assertRaisesRegex(ValueError, 'does not match the pinned hash'): la.load_pinned('staging', **self.kw)
        self.sql_path.write_bytes(SQL)
        self.catalog.write_text(json.dumps(dict(CONTRACT, sqlSha256='0' * 64)))
        with self.assertRaisesRegex(ValueError, 'catalog contract'): la.load_pinned('staging', **self.kw)

    def test_fixed_targets_and_no_cli_overrides(self):
        self.assertEqual((la.ACCOUNT, la.REGION, la.DATABASE, la.ROLE), ('452630323510', 'ap-south-1', 'postgres', 'postgres'))
        self.assertEqual(la.TARGETS['staging']['system_id'], '7698279149046886433')
        self.assertEqual(la.TARGETS['production']['system_id'], '7698288507300208674')
        self.assertTrue(all(isinstance(t['system_id'], str) for t in la.TARGETS.values()))
        prod = la.TARGETS['production']
        self.assertEqual((prod['host'], prod['ip'], prod['container'], prod['transport']), ('i-09012068d96166828', '10.63.20.252', 'supabase-db', 'exec'))
        self.assertNotIn('bucket', prod); self.assertNotIn('env_file', prod)
        with patch('sys.stderr', io.StringIO()):
            for flag in ('--system-id', '--account', '--host', '--sql', '--db-url', '--role', '--env-file', '--ip', '--container'):
                with self.assertRaises(SystemExit): la.main(['check', '--target', 'staging', '--release-dir', str(self.dir), flag, 'x'], self.aws)

    def test_wrong_account_and_host_tags_refuse_before_any_command(self):
        self.account = '111111111111'
        with self.assertRaisesRegex(ValueError, 'wrong AWS account'): la.check('staging', self.dir, self.aws, **self.kw)
        self.account = la.ACCOUNT; self.tags['ezil:env'] = 'production'
        with self.assertRaisesRegex(ValueError, 'host identity'): la.check('staging', self.dir, self.aws, **self.kw)
        self.assertEqual(self.sent, [])

    def test_transaction_pins_namespace_sid_role_and_read_only(self):
        for name, sid in (('staging', '7698279149046886433'), ('production', '7698288507300208674')):
            pins = la.pins_for(name, '0' * 64, 'a' * 32, CONTRACT, SQL_SHA)
            t = la.build_transaction(SQL.decode(), pins, 'read', 'any')
            self.assertIn("IS DISTINCT FROM '" + sid + "'", t)
            self.assertIn("current_user::text IS DISTINCT FROM 'postgres'", t)
            self.assertIn('NOT rolsuper AND rolbypassrls', t)
            self.assertTrue(t.startswith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;')); self.assertNotIn('$apply$', t); self.assertIn('pg_advisory_xact_lock', t)
            self.assertNotIn('SELECT set_config', t)  # interim rows would break the single-receipt stdout contract
            self.assertEqual(t.count("SELECT jsonb_build_object('schemaVersion'"), 1)
        with self.assertRaises(ValueError): la.build_transaction(SQL.decode(), pins, 'apply', 'any')
        for tag in la.TAGS:
            with self.assertRaises(ValueError): la.build_transaction(SQL.decode() + tag, pins, 'apply', 'empty')

    def test_catalog_expression_covers_required_facts(self):
        for needle in ('indisvalid', 'indisready', 'indislive', 'has_table_privilege', 'has_function_privilege', 'pg_has_role', 'sha256(convert_to(p.prosrc', 'pg_default_acl', 'attacl', 'pg_policy', 'pg_rewrite'):
            self.assertIn(needle, la.CATALOG + la.DEFACL)
        self.assertNotIn('md5', la.CATALOG)

    def test_remote_program_refuses_routing_and_identity_drift(self):
        pins = la.pins_for('staging', '0' * 64, 'a' * 32, CONTRACT, SQL_SHA)
        body = la.remote_body(la.build_transaction(SQL.decode(), pins, 'read', 'any'), la.TARGETS['staging'], 'a' * 32)
        for url in ('postgresql://postgres:s@btgq.supabase.co:5432/postgres', 'postgresql://postgres:s@10.61.20.35:5433/postgres', 'postgresql://postgres:s@10.61.20.35/postgres',
                    'postgresql://service_role:s@10.61.20.35:5432/postgres', 'postgresql://postgres:s@10.61.20.35:5432/other', 'postgresql://postgres:s@10.61.20.35:5432/postgres?host=x',
                    'postgresql://postgres:s@10.61.20.35:5432/postgres?options=-c%20role%3Dx', 'postgresql://postgres@10.61.20.35:5432/postgres'):
            with self.subTest(url=url):
                self.url = url; self.psql_calls.clear()
                self.assertEqual(self.run_remote(body)['Status'], 'Failed'); self.assertEqual(self.psql_calls, [])
        self.url = STAGING_URL
        self.assertEqual(self.run_remote(body)['Status'], 'Success')
        command, env = self.psql_calls[-1]
        self.assertNotIn('synthetic', str(command)); self.assertEqual(env['PGUSER'], 'postgres'); self.assertNotIn('PGOPTIONS', env)

    def test_production_script_budget_and_unsafe_constants(self):
        after = json.loads(la.CATALOG_PATH.read_text())['after']
        pins = la.pins_for('production', '0' * 64, 'a' * 32, dict(CONTRACT, after=after), la.PINNED_SQL_SHA256)
        body = la.remote_body(la.build_transaction(la.SQL_PATH.read_text(), pins, 'apply', 'empty'), la.TARGETS['production'], 'a' * 32, 'apply')
        self.assertLess(len(body), 30000)
        with self.assertRaisesRegex(ValueError, 'unsafe transport constant'): la.remote_body('x', dict(la.TARGETS['production'], container="x'; rm -rf /"), 'a' * 32)


class Flow(Fixture):
    def test_plan_is_read_only_and_classifies(self):
        d, p, psha = self.make_plan()
        self.assertTrue(all('READ ONLY;' in t.split('\n', 1)[0] and '$apply$' not in t for t in self.transactions))
        self.assertEqual(self.state, la.EMPTY)
        value = manifest.read(p)
        self.assertEqual(value['preState'], 'empty')
        for key in ('installerSha256', 'transportSha256', 'selectorSha256', 'catalogSha256', 'sqlSha256'): self.assertRegex(value[key], r'^[0-9a-f]{64}$')
        self.state = copy.deepcopy(AFTER)
        self.assertEqual(manifest.read(self.make_plan('r2')[1])['preState'], 'exact')

    def test_unknown_existing_schema_never_blessed_by_plan_apply_or_check(self):
        for drift in ({'table': {'owner': 'postgres', 'rls': False}, 'functions': []}, {'table': None, 'functions': [{'owner': 'attacker'}]},
                      dict(AFTER, table=dict(AFTER['table'], acl=[['anon', 'SELECT', False]])), dict(AFTER, functions=[{'owner': 'postgres', 'acl': [['PUBLIC', 'EXECUTE', False]]}])):
            with self.subTest(drift=drift):
                self.state = drift
                with self.assertRaisesRegex(ValueError, 'unknown or partial'): la.plan(self.target_name, Path(tempfile.mkdtemp(dir=self.dir)), self.aws, **self.kw)
                with self.assertRaises(ValueError): la.check(self.target_name, self.dir, self.aws, **self.kw)
                self.assertEqual(self.state, drift)
        self.assertFalse(any('$apply$' in t for t in self.transactions))

    def test_apply_dry_run_then_apply_writes_bound_receipt(self):
        d, p, psha = self.make_plan()
        self.do_apply(d, p, psha, apply=False); self.assertEqual(self.state, la.EMPTY); self.assertFalse(self.file(d, 'intent').exists())
        self.do_apply(d, p, psha)
        self.assertEqual(self.state, AFTER)
        receipt = manifest.read(self.file(d, 'receipt'))
        self.assertEqual((receipt['planSha256'], receipt['kind']), (psha, 'apply')); self.assertTrue(receipt['evidence']['applied'])
        self.assertEqual(manifest.read(self.file(d, 'intent'))['state'], 'complete')
        la.check(self.target_name, d, self.aws, **self.kw)

    def test_hash_mismatch_and_tampered_or_stale_plan_refuse(self):
        d, p, psha = self.make_plan()
        with self.assertRaisesRegex(ValueError, 'SQL hash argument'): self.do_apply(d, p, psha, sql_sha='0' * 64)
        with self.assertRaisesRegex(ValueError, 'plan hash'): self.do_apply(d, p, '0' * 64)
        other = d.parent / 'elsewhere.json'; other.write_bytes(p.read_bytes())
        with self.assertRaisesRegex(ValueError, 'release directory plan'): self.do_apply(d, other, psha)
        value = manifest.read(p); value['systemIdentifier'] = '1'
        p.write_bytes(la.canonical(value) + b'\n')
        with self.assertRaisesRegex(ValueError, 'plan hash'): self.do_apply(d, p, psha)
        with self.assertRaisesRegex(ValueError, 'plan target drift'): self.do_apply(d, p, la.sha(p.read_bytes()))
        self.assertEqual(self.state, la.EMPTY); self.assertFalse(self.file(d, 'intent').exists())

    def test_changed_installer_or_transport_invalidates_plan(self):
        d, p, psha = self.make_plan()
        for name in ('URL_PROGRAM', 'EXEC_SCRIPT', 'CATALOG', 'DEFACL'):
            with self.subTest(name=name), patch.object(la, name, getattr(la, name) + ' '), self.assertRaisesRegex(ValueError, 'plan target drift'): self.do_apply(d, p, psha)
        real = la.fingerprints
        with patch.object(la, 'fingerprints', lambda n: dict(real(n), installerSha256='0' * 64)), self.assertRaisesRegex(ValueError, 'plan target drift'): self.do_apply(d, p, psha)
        with patch.dict(la.TARGETS, {self.target_name: dict(self.target, host='i-0123456789abcdef0')}), self.assertRaisesRegex(ValueError, 'plan target drift'): self.do_apply(d, p, psha)
        self.assertEqual(self.state, la.EMPTY)

    def test_stale_plan_refused_in_database_and_state_untouched(self):
        d, p, psha = self.make_plan()
        self.state = copy.deepcopy(AFTER)  # someone else applied after the plan
        with self.assertRaisesRegex(ValueError, 'outcome unknown'): self.do_apply(d, p, psha)
        self.assertEqual(self.state, AFTER)
        with self.assertRaisesRegex(ValueError, 'run reconcile'): self.do_apply(d, p, psha)  # no blind retry, intent retained

    def test_replay_needs_trustworthy_bound_receipt(self):
        d, p, psha = self.make_plan(); self.do_apply(d, p, psha)
        before = len(self.sent); self.do_apply(d, p, psha)
        self.assertEqual(len(self.sent), before + 1)  # replay is one read-only proof
        self.assertIn('READ ONLY;', self.transactions[-1].split('\n', 1)[0])
        receipt_path = self.file(d, 'receipt'); original = receipt_path.read_bytes()
        for mutate in (lambda s: s['evidence'].update(after=la.EMPTY), lambda s: s.update(nonce='b' * 32), lambda s: s.update(kind='reconciled'),
                       lambda s: s['evidence'].update(planSha256='1' * 64), lambda s: s.update(extra=1)):
            saved = json.loads(original); mutate(saved)
            receipt_path.write_bytes(la.canonical(saved))
            with self.assertRaises(ValueError): self.do_apply(d, p, psha)
        receipt_path.write_bytes(original)
        intent = json.loads(self.file(d, 'intent').read_bytes()); intent['planSha256'] = '2' * 64
        self.file(d, 'intent').write_bytes(la.canonical(intent))
        with self.assertRaises(ValueError): self.do_apply(d, p, psha)

    def test_lost_send_or_failed_command_is_unknown_not_retried(self):
        for lost in (True, False):
            with self.subTest(lost=lost):
                self.state = copy.deepcopy(la.EMPTY); self.lost_send = self.fail_command = False
                d, p, psha = self.make_plan('l%d' % lost)
                self.lost_send = lost; self.fail_command = not lost
                with self.assertRaises((TimeoutError, ValueError)): self.do_apply(d, p, psha)
                sends = len(self.sent)
                with self.assertRaisesRegex(ValueError, 'run reconcile'): self.do_apply(d, p, psha)
                self.assertEqual(len(self.sent), sends)
                self.lost_send = self.fail_command = False
                la.reconcile(self.target_name, d, self.aws, **self.kw)

    def test_reconcile_exact_then_normal_apply_replays(self):
        d, p, psha = self.lost_apply('e'); self.state = copy.deepcopy(AFTER)  # the commit happened
        la.reconcile(self.target_name, d, self.aws, **self.kw)
        saved, intent = manifest.read(self.file(d, 'receipt')), manifest.read(self.file(d, 'intent'))
        self.assertEqual(saved['kind'], 'reconciled'); self.assertEqual(saved['evidence']['mode'], 'read')
        self.assertEqual((intent['state'], intent['reconciled']), ('complete', True))
        sends = len(self.sent)
        self.do_apply(d, p, psha)  # replay: one read-only proof, no resend of the apply
        self.assertEqual(len(self.sent), sends + 1); self.assertNotIn('$apply$', self.transactions[-1])
        la.check(self.target_name, d, self.aws, **self.kw)
        for mutate in (lambda s: s['evidence'].update(planSha256='1' * 64), lambda s: s['evidence'].update(before=la.EMPTY, after=la.EMPTY), lambda s: s['evidence'].update(mode='apply'), lambda s: s.update(kind='apply')):
            original = self.file(d, 'receipt').read_bytes(); bad = json.loads(original); mutate(bad)
            self.file(d, 'receipt').write_bytes(la.canonical(bad))
            with self.assertRaises(ValueError): self.do_apply(d, p, psha)
            self.file(d, 'receipt').write_bytes(original)

    def test_reconcile_empty_closes_and_fresh_apply_works(self):
        d, p, psha = self.make_plan('f'); self.lost_send = True; self.persist_empty = True
        with self.assertRaises(TimeoutError): self.do_apply(d, p, psha)
        self.lost_send = self.persist_empty = False
        la.reconcile(self.target_name, d, self.aws, **self.kw)
        self.assertTrue(list(d.glob('*.closed-*'))); self.assertFalse(self.file(d, 'intent').exists())
        self.do_apply(d, p, psha); self.assertEqual(self.state, AFTER)

    def test_reconcile_unknown_refuses_and_keeps_intent(self):
        d, p, psha = self.lost_apply('g'); self.state = {'table': {'owner': 'x'}, 'functions': []}
        with self.assertRaisesRegex(ValueError, 'unknown or partial'): la.reconcile(self.target_name, d, self.aws, **self.kw)
        self.assertTrue(self.file(d, 'intent').exists()); self.assertFalse(self.file(d, 'receipt').exists())

    def test_reconcile_binds_intent_plan_and_journal(self):
        d, p, psha = self.lost_apply('h'); self.state = copy.deepcopy(AFTER)
        intent_path, journal = self.file(d, 'intent'), d / ('lower-attestation-schema-' + self.target_name + '-apply-ssm.json')
        intent, ssm = intent_path.read_bytes(), journal.read_bytes()
        def corrupt(path, original, mutate, message):
            data = json.loads(original); mutate(data); path.write_bytes(la.canonical(data))
            with self.assertRaisesRegex(ValueError, message): la.reconcile(self.target_name, d, self.aws, **self.kw)
            path.write_bytes(original)
        corrupt(intent_path, intent, lambda i: i.update(planSha256='3' * 64), 'plan hash mismatch')
        corrupt(intent_path, intent, lambda i: i.update(sqlSha256='3' * 64), 'intent state not reconcilable')
        corrupt(intent_path, intent, lambda i: i.update(target='production' if self.target_name == 'staging' else 'staging'), 'intent state not reconcilable')
        corrupt(intent_path, intent, lambda i: i.update(nonce='z'), 'intent state not reconcilable')
        corrupt(intent_path, intent, lambda i: i.update(extra=1), 'intent state not reconcilable')
        corrupt(intent_path, intent, lambda i: i.update(state='complete'), 'intent state not reconcilable')
        corrupt(intent_path, intent, lambda i: i.update(nonce='f' * 32), 'journal binding')  # other nonce means another command body
        corrupt(journal, ssm, lambda j: j.update(sha256='4' * 64), 'journal binding')
        corrupt(journal, ssm, lambda j: j.update(comment='arbitrary'), 'journal binding')
        corrupt(journal, ssm, lambda j: j.update(host='i-0123456789abcdef0'), 'journal binding')
        corrupt(journal, ssm, lambda j: j.update(key='other/key'), 'journal binding')
        corrupt(journal, ssm, lambda j: j.update(extra=1), 'journal binding')
        corrupt(journal, ssm, lambda j: j.update(commandId='22222222-2222-4222-8222-222222222222'), 'uncertain SSM submission')  # arbitrary terminal command id
        self.listed = '22222222-2222-4222-8222-222222222222'  # listing names a different command than the journalled one
        corrupt(journal, ssm, lambda j: j.update(commandId=CMD), 'uncertain SSM submission')
        del self.listed
        plan_bytes = p.read_bytes(); p.write_bytes(plan_bytes + b' ')
        with self.assertRaisesRegex(ValueError, 'plan hash mismatch'): la.reconcile(self.target_name, d, self.aws, **self.kw)
        p.write_bytes(plan_bytes)
        self.assertFalse(self.file(d, 'receipt').exists())
        la.reconcile(self.target_name, d, self.aws, **self.kw)  # untampered inputs now reconcile

    def test_reconcile_requires_terminal_command(self):
        d, p, psha = self.lost_apply('i'); self.state = copy.deepcopy(AFTER); self.pending = True
        with self.assertRaisesRegex(ValueError, 'not terminal'): la.reconcile(self.target_name, d, self.aws, **self.kw)
        self.pending = False
        la.reconcile(self.target_name, d, self.aws, **self.kw)

    def test_missing_journal_is_unknown_and_never_permits_a_fresh_send(self):
        for db in (la.EMPTY, AFTER):
            with self.subTest(db=db):
                self.state = copy.deepcopy(la.EMPTY)
                d, p, psha = self.make_plan('m%d' % (db is AFTER)); self.lost_send = True; self.pending = True
                with self.assertRaises(TimeoutError): self.do_apply(d, p, psha)
                self.lost_send = False; self.state = copy.deepcopy(db)
                (d / ('lower-attestation-schema-' + self.target_name + '-apply-ssm.json')).unlink()  # journal lost; original may still be pending
                sends = len(self.sent)
                with self.assertRaisesRegex(ValueError, 'journal binding'): la.reconcile(self.target_name, d, self.aws, **self.kw)
                with self.assertRaisesRegex(ValueError, 'run reconcile'): self.do_apply(d, p, psha)
                self.assertEqual(len(self.sent), sends); self.assertTrue(self.file(d, 'intent').exists()); self.assertFalse(list(d.glob('*.closed-*')))
                self.pending = False

    def test_state_files_are_private_and_durable(self):
        old = __import__('os').umask(0)
        self.addCleanup(__import__('os').umask, old)
        os_ = __import__('os'); synced = []
        real = os_.fsync
        def record(fd):
            synced.append('dir' if __import__('stat').S_ISDIR(os_.fstat(fd).st_mode) else 'file'); real(fd)
        with patch('os.fsync', record):
            la.write_json(self.dir / 'a.json', {'x': 1}); la.create_exclusive(self.dir / 'b.json', {'y': 2})
        self.assertEqual(synced, ['file', 'dir', 'dir', 'file', 'dir'])  # tmp file, its dir, replace dir; exclusive file, its dir
        for name in ('a.json', 'b.json'): self.assertEqual(os_.stat(self.dir / name).st_mode & 0o777, 0o600)
        self.assertFalse((self.dir / 'a.json.tmp').exists())

    def test_persistence_failure_blocks_send_and_submitted_state_precedes_send(self):
        d, p, psha = self.make_plan(); planned = len(self.sent)
        real = la.write_json
        def failing(path, value):
            if isinstance(value, dict) and value.get('status') == 'submitting': raise OSError('disk full')
            real(path, value)
        with patch.object(la, 'write_json', failing), self.assertRaises(OSError): self.do_apply(d, p, psha)
        self.assertEqual(len(self.sent), planned); self.assertEqual(self.state, la.EMPTY)
        d2, p2, h2 = self.make_plan('o2'); planned = len(self.sent)
        with patch.object(la, 'create_exclusive', side_effect=OSError('disk full')), self.assertRaises(OSError): self.do_apply(d2, p2, h2)
        self.assertEqual(len(self.sent), planned)
        d3, p3, h3 = self.make_plan('o3'); seen = []
        original = self.aws
        def spy(*args):
            if args[:2] == ('ssm', 'send-command'):
                seen.append(json.loads(self.file(d3, 'intent').read_bytes())['state'])
                seen.append(json.loads((d3 / ('lower-attestation-schema-' + self.target_name + '-apply-ssm.json')).read_bytes())['status'])
            return original(*args)
        with patch.object(self, 'aws', spy):
            la.apply(self.target_name, d3, p3, h3, SQL_SHA, spy, True, **self.kw)
        self.assertEqual(seen, ['submitting', 'submitting'])

    def test_raw_invocation_retained_before_completion_and_parse(self):
        d, p, psha = self.make_plan(); order = []
        real = la.write_json
        def spy(path, value):
            order.append(Path(path).name.replace('lower-attestation-schema-' + self.target_name + '-', '') + ':' + str(value.get('status', '') if 'invocation' not in value else 'raw'))
            real(path, value)
        with patch.object(la, 'write_json', spy): self.do_apply(d, p, psha)
        raw = d / ('lower-attestation-schema-' + self.target_name + '-apply-invocation.json')
        self.assertLess(order.index('apply-invocation.json:raw'), order.index('apply-ssm.json:complete'))
        self.assertEqual(raw.stat().st_mode & 0o777, 0o600)
        self.assertEqual(json.loads(raw.read_bytes())['invocation']['Status'], 'Success')
        self.assertEqual(json.loads(json.loads(raw.read_bytes())['invocation']['StandardOutputContent'])['mode'], 'apply')

    def test_malformed_or_failed_output_is_retained_privately_and_never_printed(self):
        for label, output in (('bad', 'not json {"secret":"postgresql://u:pw@h"}'), ('trunc', '{"schemaVersion":1,'), ('arr', '[1]')):
            with self.subTest(label=label):
                self.state = copy.deepcopy(la.EMPTY)
                d, p, psha = self.make_plan('x' + label)
                real = self.aws
                def aws(*args, _real=real, _out=output):
                    result = _real(*args)
                    return dict(result, StandardOutputContent=_out) if args[:2] == ('ssm', 'get-command-invocation') else result
                with patch('sys.stderr', io.StringIO()) as err:
                    with self.assertRaisesRegex(ValueError, 'outcome unknown') as caught: la.apply(self.target_name, d, p, psha, SQL_SHA, aws, True, **self.kw)
                self.assertNotIn('pw@', str(caught.exception))
                raw = d / ('lower-attestation-schema-' + self.target_name + '-apply-invocation.json')
                self.assertEqual(json.loads(raw.read_bytes())['invocation']['StandardOutputContent'], output); self.assertEqual(raw.stat().st_mode & 0o777, 0o600)
                self.assertEqual(manifest.read(d / ('lower-attestation-schema-' + self.target_name + '-apply-ssm.json'))['status'], 'failed')
                sends = len(self.sent)
                with self.assertRaisesRegex(ValueError, 'run reconcile'): self.do_apply(d, p, psha)
                self.assertEqual(len(self.sent), sends)
                la.reconcile(self.target_name, d, self.aws, **self.kw)  # read-only reconcile still works (DB did commit)
                self.assertEqual(manifest.read(self.file(d, 'receipt'))['kind'], 'reconciled')

    def test_exclusive_intent_refuses_second_writer(self):
        d, p, psha = self.make_plan()
        la.create_exclusive(self.file(d, 'intent'), {'state': 'submitting'})
        with self.assertRaisesRegex(ValueError, 'run reconcile'): self.do_apply(d, p, psha)
        with self.assertRaises(FileExistsError): la.create_exclusive(self.file(d, 'intent'), {})
        self.assertEqual(self.state, la.EMPTY)

    def test_error_reasons_are_public_allowlist(self):
        out = io.StringIO()
        with patch('sys.stderr', out), patch.object(sys, 'argv', ['x', 'check', '--target', 'staging', '--release-dir', str(self.dir)]), patch('lower_attestation_schema.aws_cli', side_effect=ValueError('postgresql://u:secret@h')):
            with self.assertRaises(SystemExit):
                exec(compile(Path(la.__file__).read_text().split("if __name__ == '__main__':")[1].replace('\n    ', '\n').strip(), 'main', 'exec'), vars(la))
        self.assertNotIn('secret', out.getvalue())


class ProductionFlow(Flow):
    """Same flow over the approved production transport (inline SSM script, docker exec, no URL/S3)."""
    target_name = 'production'

    def test_no_s3_and_no_url_transport(self):
        d, p, psha = self.make_plan(); self.do_apply(d, p, psha)
        self.assertTrue(all(a[:2] != ('s3api', 'put-object') for a in self.sent)); self.assertEqual(self.psql_calls, [])
        self.assertIsNone(manifest.read(d / 'lower-attestation-schema-production-apply-ssm.json')['key'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
