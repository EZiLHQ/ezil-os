#!/usr/bin/env python3
"""Disposable-PostgreSQL proof of the installer transaction and catalog contract.

Owns one throwaway postgres:17 container (1 CPU, 512 MB, no published port,
synthetic data) mirroring production's role shape: `postgres` is NOSUPERUSER
BYPASSRLS and a member of anon/authenticated/service_role (never the reverse).
`--write-catalog PATH` records the golden contract for the SQL bytes. The
production host script runs for real against it through curl/ip/docker shims.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import lower_attestation_schema as la

IMAGE = 'postgres:17'
NAME = 'ezil-la-schema-' + uuid.uuid4().hex[:8]
ADMIN = 'ezil_admin'
SRC_SHA256 = 'c35f6fdedd1a60b26a445974fcf43d473edee20347f9cf86e52121a23e36a4ef'  # owner's pin document, a5c6b7e6
DRIFTS = (('anon grant', 'GRANT SELECT ON public.ezil_computer_lower_attestations TO anon;'),
          ('function public execute', 'GRANT EXECUTE ON FUNCTION public.ezil_computer_lower_attestations_guard() TO PUBLIC;'),
          ('extra trigger', 'CREATE TRIGGER extra BEFORE INSERT ON public.ezil_computer_lower_attestations FOR EACH ROW EXECUTE FUNCTION public.ezil_computer_lower_attestations_guard();'),
          ('extra column', 'ALTER TABLE public.ezil_computer_lower_attestations ADD COLUMN extra text;'),
          ('drop constraint', 'ALTER TABLE public.ezil_computer_lower_attestations DROP CONSTRAINT ezil_computer_lower_attestations_time_check;'),
          ('rls off', 'ALTER TABLE public.ezil_computer_lower_attestations DISABLE ROW LEVEL SECURITY;'),
          ('extra index', 'CREATE INDEX extra_idx ON public.ezil_computer_lower_attestations (owner_user_id);'),
          ('policy', 'CREATE POLICY p ON public.ezil_computer_lower_attestations USING (true);'),
          ('privilege via role membership', 'CREATE ROLE grp NOLOGIN; GRANT grp TO anon; GRANT SELECT ON public.ezil_computer_lower_attestations TO grp;'),
          ('column acl', 'GRANT SELECT (region) ON public.ezil_computer_lower_attestations TO authenticated;'),
          ('disabled trigger', 'ALTER TABLE public.ezil_computer_lower_attestations DISABLE TRIGGER ezil_computer_lower_attestations_guard;'))


def psql(user, sql, check=True):
    result = subprocess.run(['docker', 'exec', '-i', NAME, 'psql', '-X', '-q', '-A', '-t', '-U', user, '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-f', '-'],
                            input=sql, capture_output=True, text=True, timeout=120)
    if check and result.returncode != 0:
        raise AssertionError('psql failed: ' + result.stderr[-400:])
    return result


def receipt_of(result):
    # The real remote program does json.loads(full stdout): exactly one row, no interim output.
    return json.loads(result.stdout)


def main(argv):
    sql_path = Path(argv[argv.index('--sql') + 1]) if '--sql' in argv else la.SQL_PATH
    write_to = Path(argv[argv.index('--write-catalog') + 1]) if '--write-catalog' in argv else None
    data = sql_path.read_bytes(); sql = data.decode(); sql_sha = la.sha(data)
    subprocess.run(['docker', 'run', '-d', '--rm', '--name', NAME, '--cpus', '1', '--memory', '512m', '-e', 'POSTGRES_USER=' + ADMIN, '-e', 'POSTGRES_PASSWORD=synthetic',
                    '-e', 'POSTGRES_DB=postgres', IMAGE], check=True, capture_output=True, timeout=180)
    try:
        for _ in range(90):
            if psql(ADMIN, 'SELECT 1;', check=False).returncode == 0:
                break
            subprocess.run(['sleep', '1'])
        psql(ADMIN, "CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;"
                    "CREATE ROLE postgres LOGIN NOSUPERUSER BYPASSRLS; GRANT anon, authenticated, service_role TO postgres; GRANT ALL ON SCHEMA public TO postgres;"
                    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;"
                    "ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;"
                    "ALTER DEFAULT PRIVILEGES FOR ROLE " + ADMIN + " GRANT SELECT ON TABLES TO anon;")  # unrelated global row to preserve
        system_id = psql(ADMIN, 'SELECT system_identifier::text FROM pg_control_system();').stdout.strip()
        pins = dict(namespace='staging', system_id=system_id, database='postgres', role='postgres', after={}, sql_sha=sql_sha, plan_sha='0' * 64, nonce='a' * 32)
        defacl_before = psql(ADMIN, 'SELECT (' + la.DEFACL + ')::text;').stdout.strip()

        def run_tx(mode, expected, user='postgres', p=None):
            return psql(user, la.build_transaction(sql, p or pins, mode, expected), check=False)

        empty = run_tx('read', 'any')
        assert empty.returncode == 0 and receipt_of(empty)['before'] == la.EMPTY and receipt_of(empty)['applied'] is False, 'real read-only EMPTY plan: ' + empty.stderr[-300:]
        assert run_tx('read', 'any', p=dict(pins, system_id='1')).returncode != 0, 'system id guard'
        assert run_tx('read', 'any', p=dict(pins, role='ezil_admin'), user=ADMIN).returncode != 0, 'superuser/other role refused'
        assert run_tx('read', 'any', user=ADMIN).returncode != 0, 'superuser session refused'
        probe = psql('postgres', 'BEGIN;\nDO $x$ BEGIN EXECUTE $reviewed$' + sql + '$reviewed$; END $x$;\nSELECT (' + la.CATALOG + ')::text;\nROLLBACK;\n')
        after = json.loads(probe.stdout)
        pins['after'] = after
        table, func = after['table'], after['functions'][0]
        assert table['owner'] == 'postgres' and table['rls'] is True and table['forceRls'] is False and table['policies'] == 0 and table['rules'] == 0, table
        assert len(table['columns']) == 31 and len(table['constraints']) == 6 and len(table['indexes']) == 3 and len(table['triggers']) == 2, 'catalog shape'
        assert all(c[3] is None for c in table['columns']) and all(c[7] is None for c in table['columns']), 'no column defaults/ACLs'
        assert table['acl'] == [['postgres', p, False] for p in ('DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRIGGER', 'TRUNCATE', 'UPDATE')], table['acl']
        assert all(v is False for v in table['clientTable'].values()) and all(v is False for v in table['clientOwnerMember'].values()), 'effective client denial'
        assert all(i[2:5] == [True, True, True] for i in table['indexes']), 'index validity'
        assert func['srcSha256'] == SRC_SHA256 and func['acl'] == [['postgres', 'EXECUTE', False]] and all(v is False for v in func['clientExecute'].values()) and func['secdef'] is False, func
        assert run_tx('apply', 'exact').returncode != 0, 'exact gate refuses an empty database'
        done = run_tx('apply', 'empty'); assert done.returncode == 0, done.stderr[-400:]
        receipt = receipt_of(done)
        assert receipt['applied'] is True and receipt['after'] == after and receipt['before'] == la.EMPTY
        la.validate_receipt(receipt, pins, 'apply')
        assert json.loads(psql(ADMIN, 'SELECT (' + la.DEFACL + ')::text;').stdout) == json.loads(defacl_before) == receipt['defaultAcl'] and len(receipt['defaultAcl']) == 3, 'default ACL rows preserved'
        assert run_tx('apply', 'empty').returncode != 0, 'stale empty plan refused after apply'
        exact = run_tx('read', 'exact'); assert exact.returncode == 0 and receipt_of(exact)['applied'] is False
        assert la.validate_receipt(receipt_of(run_tx('read', 'any')), pins, 'read', classify=True) == 'exact'
        read_only = psql('postgres', la.build_transaction(sql, pins, 'read', 'exact').replace('COMMIT;', 'CREATE TABLE t_ro(x int);COMMIT;'), check=False)
        assert read_only.returncode != 0 and 'read-only' in read_only.stderr, 'read transaction is genuinely read-only'
        # sealed immutability is enforced, not just present
        assert psql('postgres', 'TRUNCATE public.ezil_computer_lower_attestations;', check=False).returncode != 0, 'retain trigger blocks TRUNCATE'
        assert psql('postgres', "INSERT INTO public.ezil_computer_lower_attestations (attestation_id,computer_id,owner_user_id,region,zone_id,source_instance_id,source_volume_id,fs_uuid,source_generation,source_lease_epoch,source_fence_token,"
                                "reserved_row_sha256,request_sha256,challenge,phase,created_at,updated_at) SELECT gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),'r','z','i','v',gen_random_uuid(),1,1,gen_random_uuid(),"
                                "repeat('a',64),repeat('b',64),repeat('c',64),'refused',now(),now();", check=False).returncode != 0, 'sealed check rejects refused without failure code'
        for label, drift in DRIFTS:
            psql(ADMIN, drift)
            assert run_tx('read', 'exact').returncode != 0, label + ' must fail the exact check'
            assert run_tx('apply', 'empty').returncode != 0, label + ' must refuse apply'
            assert la.validate_receipt(receipt_of(run_tx('read', 'any')), pins, 'read', classify=True) == 'unknown', label + ' classified unknown'
            psql(ADMIN, 'DROP TABLE public.ezil_computer_lower_attestations CASCADE; DROP FUNCTION IF EXISTS public.ezil_computer_lower_attestations_guard(); DROP ROLE IF EXISTS grp;')
            assert run_tx('apply', 'empty').returncode == 0, label + ' restore'
        production_script(sql, pins, system_id)
        if write_to:
            write_to.write_text(json.dumps({'schemaVersion': 1, 'sqlSha256': sql_sha, 'empty': la.EMPTY, 'after': after}, sort_keys=True, indent=2) + '\n')
        print('PG-PROOF OK sql=' + sql_sha)
    finally:
        subprocess.run(['docker', 'rm', '-f', NAME], capture_output=True)


def production_script(sql, pins, system_id):
    """Run the production host script itself: IMDSv2/IP guards, gzip payload, docker exec shim."""
    psql(ADMIN, 'DROP TABLE public.ezil_computer_lower_attestations CASCADE; DROP FUNCTION public.ezil_computer_lower_attestations_guard();')
    target = dict(la.TARGETS['production'], system_id=system_id)
    p = dict(pins, namespace='production', system_id=system_id, nonce='b' * 32)
    real = subprocess.run(['which', 'docker'], capture_output=True, text=True).stdout.strip()
    with tempfile.TemporaryDirectory(prefix='ezil-la-shim-') as shim:
        shim = Path(shim)
        (shim / 'curl').write_text('#!/bin/sh\ncase "$*" in *api/token*) echo SYNTHETICTOKEN;; *instance-id*) echo "${SHIM_INSTANCE:-' + target['host'] + '}";; esac\n')
        (shim / 'ip').write_text('#!/bin/sh\necho "2: eth0    inet ${SHIM_IP:-' + target['ip'] + '}/24 brd 10.63.20.255 scope global eth0"\n')
        # maps the approved container name onto the disposable one; refuses any other container
        (shim / 'docker').write_text('#!/bin/bash\n[ "$1" = exec ] || exit 99\nshift; pre=()\nwhile [ "$1" != ' + target['container'] + ' ]; do pre+=("$1"); shift; [ $# -gt 0 ] || exit 98; done; shift\nexec ' + real + ' exec "${pre[@]}" ' + NAME + ' "$@"\n')
        for tool in ('curl', 'ip', 'docker'):
            (shim / tool).chmod(0o755)
        env = {'PATH': str(shim) + ':' + os.environ['PATH'], 'HOME': str(shim)}
        run = lambda body, **extra: subprocess.run(['bash', '-c', body], env={**env, **extra}, capture_output=True, text=True, timeout=120)
        for mode, expected in (('read', 'any'), ('apply', 'empty'), ('read', 'exact')):
            body = la.remote_body(la.build_transaction(sql, p, mode, expected), target, p['nonce'], mode)
            assert 'read_only=on' in body if mode == 'read' else 'read_only' not in body
            result = run(body)
            assert result.returncode == 0, (mode, result.stderr[-300:])
            assert json.loads(result.stdout)['mode'] == mode  # full stdout is exactly one JSON receipt
            if mode == 'read' and expected == 'any':
                assert run(body, SHIM_INSTANCE='i-00000000000000000').returncode == 71, 'wrong instance refused before the database'
                assert run(body, SHIM_IP='10.0.0.9').returncode == 72, 'wrong local IP refused before the database'
        assert 'password' not in body.lower() and 'postgresql://' not in body and 's3://' not in body


if __name__ == '__main__':
    main(sys.argv)
