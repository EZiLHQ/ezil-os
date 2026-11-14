"""Separate plan/apply/check/reconcile installer for lower-attestation SQL 0004.

Source only. Targets are fixed constants (no CLI account/SID/host overrides).
The backend owner role is not protected by RLS (BYPASSRLS is expected); the exact
catalog contract below, effective client-role denial and the immutability
trigger/function are the protection. Unknown schema is never blessed because the
SQL uses no IF NOT EXISTS: reviewed bytes run only from a provably empty state,
otherwise the exact post-DDL catalog is required.
"""
import argparse
import base64
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time
import uuid

import rebase_manifest as manifest

need = manifest.need
REPO = Path(__file__).resolve().parents[3]
SQL_PATH = REPO / 'docs/aws-computers/sql/0004_lower_attestations.sql.txt'
CATALOG_PATH = Path(__file__).with_name('lower_attestation_catalog.json')
# Owner's final stable recovery SQL (commit a5c6b7e6ca68); catalog contract is bound to it.
PINNED_SQL_SHA256 = 'ab5fcfa6341fe89595b36591cded8ede1dea506ed84801cfafdc8701e179e313'
SELECTOR_SHA256 = 'fc84c0690728007d8199396effe500d6b1bf74352b4d2c9d8fbfe625164518a2'  # approved production selector document
ACCOUNT, REGION, DATABASE, ROLE = '452630323510', 'ap-south-1', 'postgres', 'postgres'
LOCK_KEY = 744152206223
TABLE, FUNCTION = 'ezil_computer_lower_attestations', 'ezil_computer_lower_attestations_guard'
CLIENTS = ('anon', 'authenticated', 'service_role')
# staging: normal SSM/S3 + env-file URL path (as the 0002 installer). production: approved selector,
# SSM inline script, IMDSv2 + local IP checks, docker exec on the local socket; no URL/password/S3.
TARGETS = {
    'staging': dict(transport='url', namespace='staging', system_id='7698279149046886433', host='i-014810524754b9ed0',
                    env_file='/etc/ezil-os-staging/app.env', db_host='10.61.20.35', db_port=5432,
                    tags={'ezil:purpose': 'os-staging', 'ezil:env': 'billing-staging'},
                    bucket='ezil-main-preview-artifacts-452630323510-aps1', prefix='os-staging/images/lower-attestation-schema/'),
    'production': dict(transport='exec', namespace='production', system_id='7698288507300208674', host='i-09012068d96166828',
                       ip='10.63.20.252', container='supabase-db', tags=None),
}
TAGS = ('$pin$', '$lock$', '$table$', '$stage$', '$gate$', '$apply$', '$verify$', '$reviewed$')


def sha(data):
    return hashlib.sha256(data).hexdigest()


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':')).encode()


EMPTY = {'table': None, 'functions': []}


def transport_pinned(target):
    keys = ('host', 'env_file', 'db_host', 'db_port', 'tags', 'bucket', 'prefix') if target['transport'] == 'url' else ('host', 'ip', 'container')
    return all(target.get(k) is not None for k in keys)


def load_contract(pin, path=CATALOG_PATH):
    """The golden catalog must name exactly the pinned SQL bytes."""
    contract = manifest.read(path)
    need(set(contract) == {'schemaVersion', 'sqlSha256', 'empty', 'after'} and contract['schemaVersion'] == 1, 'invalid catalog contract')
    need(pin is not None and contract['sqlSha256'] == pin and contract['empty'] == EMPTY, 'catalog contract does not match pinned SQL')
    return contract


# One jsonb expression; every PostgreSQL-normalised fact comes from the catalog.
ACL = ("(SELECT COALESCE(jsonb_agg(jsonb_build_array(g,p,o) ORDER BY g,p,o),'[]') FROM (SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END g,"
       "x.privilege_type p,x.is_grantable o FROM aclexplode(COALESCE({acl},acldefault('{kind}',{owner}))) x) s)")
CLIENT_ARRAY = "ARRAY['anon','authenticated','service_role']"
CATALOG = (
    "jsonb_build_object('table',(SELECT jsonb_build_object('owner',pg_get_userbyid(c.relowner),'kind',c.relkind,'rls',c.relrowsecurity,'forceRls',c.relforcerowsecurity,"
    "'partition',c.relispartition,'children',c.relhassubclass,'persistence',c.relpersistence,'options',c.reloptions::text,"
    "'columns',(SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,pg_get_expr(d.adbin,d.adrelid),a.attidentity,a.attgenerated,a.attnum,a.attacl::text) ORDER BY a.attnum) "
    "FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),"
    "'constraints',(SELECT COALESCE(jsonb_agg(jsonb_build_array(conname,contype,pg_get_constraintdef(oid),convalidated,condeferrable) ORDER BY conname),'[]') FROM pg_constraint WHERE conrelid=c.oid),"
    "'indexes',(SELECT COALESCE(jsonb_agg(jsonb_build_array(ic.relname,pg_get_indexdef(i.indexrelid),i.indisvalid,i.indisready,i.indislive,i.indisunique,i.indisprimary,i.indimmediate,pg_get_userbyid(ic.relowner)) ORDER BY ic.relname),'[]') "
    "FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid WHERE i.indrelid=c.oid),"
    "'triggers',(SELECT COALESCE(jsonb_agg(jsonb_build_array(tgname,pg_get_triggerdef(oid),tgenabled) ORDER BY tgname),'[]') FROM pg_trigger WHERE tgrelid=c.oid AND NOT tgisinternal),"
    "'policies',(SELECT count(*) FROM pg_policy WHERE polrelid=c.oid),'rules',(SELECT count(*) FROM pg_rewrite WHERE ev_class=c.oid),"
    "'acl'," + ACL.format(acl='c.relacl', kind='r', owner='c.relowner') + ","
    "'clientTable',(SELECT jsonb_object_agg(r,has_table_privilege(r,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')) FROM unnest(" + CLIENT_ARRAY + ") r),"
    "'clientOwnerMember',(SELECT jsonb_object_agg(r,pg_has_role(r,c.relowner,'MEMBER')) FROM unnest(" + CLIENT_ARRAY + ") r)"
    ") FROM pg_class c WHERE c.oid=to_regclass('public." + TABLE + "')),"
    "'functions',(SELECT COALESCE(jsonb_agg(jsonb_build_object('owner',pg_get_userbyid(p.proowner),'args',pg_get_function_identity_arguments(p.oid),'returns',format_type(p.prorettype,NULL),"
    "'lang',l.lanname,'secdef',p.prosecdef,'volatility',p.provolatile,'config',p.proconfig::text,'srcSha256',encode(sha256(convert_to(p.prosrc,'UTF8')),'hex'),"
    "'acl'," + ACL.format(acl='p.proacl', kind='f', owner='p.proowner') + ","
    "'clientExecute',(SELECT jsonb_object_agg(r,has_function_privilege(r,p.oid,'EXECUTE')) FROM unnest(" + CLIENT_ARRAY + ") r)) ORDER BY p.oid),'[]') "
    "FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.pronamespace='public'::regnamespace AND p.proname='" + FUNCTION + "'))"
)
# Default-ACL rows that would seed ACLs of new public objects. Unrelated/global rows are preserved;
# this is recorded as an input and proven unchanged, never mutated.
DEFACL = ("(SELECT COALESCE(jsonb_agg(jsonb_build_array(pg_get_userbyid(d.defaclrole),COALESCE(n.nspname,''),d.defaclobjtype::text,d.defaclacl::text) "
          "ORDER BY pg_get_userbyid(d.defaclrole),COALESCE(n.nspname,''),d.defaclobjtype::text),'[]') FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid=d.defaclnamespace "
          "WHERE d.defaclobjtype IN ('r','f') AND (d.defaclnamespace=0 OR n.nspname='public'))")


def build_transaction(sql, pins, mode, expected_before):
    """pins: target facts; mode: 'read' or 'apply'; expected_before: 'empty'|'exact'|'any' (read only)."""
    need(mode in ('read', 'apply') and expected_before in ('empty', 'exact', 'any') and (expected_before != 'any' or mode == 'read'), 'invalid transaction request')
    need(not any(tag in sql for tag in TAGS), 'SQL collides with installer quoting')
    literal = lambda v: "'" + json.dumps(v, sort_keys=True, separators=(',', ':')).replace("'", "''") + "'"
    t = ('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;' if mode == 'read' else 'BEGIN;') + " SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='120s';\n"
    t += ("DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '" + pins['system_id'] + "' THEN RAISE EXCEPTION 'system identity mismatch'; END IF;\n"
          " IF current_database() IS DISTINCT FROM '" + pins['database'] + "' THEN RAISE EXCEPTION 'database mismatch'; END IF;\n"
          " IF current_user::text IS DISTINCT FROM '" + pins['role'] + "' OR session_user::text IS DISTINCT FROM '" + pins['role'] + "' THEN RAISE EXCEPTION 'role mismatch'; END IF;\n"
          " IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND rolbypassrls) THEN RAISE EXCEPTION 'role attributes mismatch'; END IF;\n"
          " IF (SELECT count(*) FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role')) <> 3 THEN RAISE EXCEPTION 'client roles missing'; END IF; END $pin$;\n")
    t += "DO $lock$ BEGIN PERFORM pg_advisory_xact_lock(" + str(LOCK_KEY) + "); END $lock$;\n"
    t += ("DO $table$ BEGIN IF to_regclass('public." + TABLE + "') IS NOT NULL THEN EXECUTE 'LOCK TABLE public." + TABLE + " IN " +
          ('ACCESS EXCLUSIVE' if mode == 'apply' else 'ACCESS SHARE') + " MODE'; END IF; END $table$;\n")
    # PERFORM keeps stdout to exactly one receipt row; set_config is legal in READ ONLY transactions.
    t += ("DO $stage$ BEGIN PERFORM set_config('ezil.la_before', (" + CATALOG + ")::text, true); PERFORM set_config('ezil.la_defacl', (" + DEFACL + ")::text, true);\n"
          " PERFORM set_config('ezil.la_expected', " + literal(pins['after']) + ", true); END $stage$;\n")
    if expected_before != 'any':
        t += ("DO $gate$ BEGIN IF current_setting('ezil.la_before')::jsonb IS DISTINCT FROM " + ("'" + json.dumps(EMPTY, sort_keys=True, separators=(',', ':')) + "'::jsonb" if expected_before == 'empty' else "current_setting('ezil.la_expected')::jsonb") +
              " THEN RAISE EXCEPTION 'stale plan or unknown schema refused'; END IF; END $gate$;\n")
    if mode == 'apply' and expected_before == 'empty':
        t += 'DO $apply$ BEGIN EXECUTE $reviewed$' + sql + '$reviewed$; END $apply$;\n'
    if expected_before != 'any':
        t += ("DO $verify$ BEGIN IF (" + CATALOG + ") IS DISTINCT FROM current_setting('ezil.la_expected')::jsonb THEN RAISE EXCEPTION 'schema verification failed'; END IF;\n"
              " IF (" + DEFACL + ")::text IS DISTINCT FROM current_setting('ezil.la_defacl') THEN RAISE EXCEPTION 'default ACL input changed'; END IF; END $verify$;\n")
    t += ("SELECT jsonb_build_object('schemaVersion',1,'target','" + pins['namespace'] + "','systemIdentifier','" + pins['system_id'] + "','database',current_database(),'role',current_user::text,"
          "'sqlSha256','" + pins['sql_sha'] + "','planSha256','" + pins['plan_sha'] + "','nonce','" + pins['nonce'] + "','mode','" + mode + "',"
          "'applied'," + ('true' if mode == 'apply' and expected_before == 'empty' else 'false') + ",'before',current_setting('ezil.la_before')::jsonb,'defaultAcl',current_setting('ezil.la_defacl')::jsonb,'after'," + CATALOG + ")::text;\nCOMMIT;\n")
    return t


# staging remote program: parses only SUPABASE_DATABASE_URL from the pinned env file, pins host/port/user/db,
# never prints credentials, URLs or the environment.
URL_PROGRAM = r'''
import base64, hashlib, json, os, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qsl

def require(ok):
    if not ok: raise RuntimeError('refused')

try:
    require(hashlib.sha256(TRANSACTION.encode()).hexdigest() == TRANSACTION_SHA)
    values = {}
    for line in Path(ENV_FILE).read_text().splitlines():
        if line.startswith('SUPABASE_DATABASE_URL='): values['u'] = line.split('=', 1)[1]
    raw = values['u']
    url = urlsplit(raw)
    require(url.scheme in ('postgres', 'postgresql') and url.hostname == DB_HOST and url.port == DB_PORT and not url.fragment)
    query = dict(parse_qsl(url.query, strict_parsing=True)) if url.query else {}
    require(set(query) <= {'sslmode'} and query.get('sslmode', 'disable') in ('disable', 'require', 'verify-ca', 'verify-full'))
    require(url.username and url.password and unquote(url.username) == ROLE and url.path.startswith('/') and unquote(url.path[1:]) == DATABASE)
    env = {'PATH': os.defpath + ':/usr/local/bin', 'PGHOST': DB_HOST, 'PGPORT': str(DB_PORT), 'PGUSER': ROLE,
           'PGPASSWORD': unquote(url.password), 'PGDATABASE': DATABASE, 'PGSSLMODE': query.get('sslmode', 'disable'), 'PGCONNECT_TIMEOUT': '10'}
    command = ['docker', 'run', '--rm', '-i', '--network', 'host']
    for key in env:
        if key.startswith('PG'): command += ['-e', key]
    command += ['postgres:17-alpine', 'psql', '-X', '-q', '-A', '-t', '--no-password', '-v', 'ON_ERROR_STOP=1', '-P', 'pager=off', '-f', '-']
    result = subprocess.run(command, input=TRANSACTION, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env, timeout=180)
    require(result.returncode == 0)
    receipt = json.loads(result.stdout)
    require(receipt['systemIdentifier'] == SYSTEM and receipt['nonce'] == NONCE)
    print(json.dumps(receipt, separators=(',', ':')))
except Exception:
    print('lower attestation schema operation refused', file=sys.stderr)
    sys.exit(1)
'''

# production host script (approved selector): IMDSv2 instance id, local IP on an interface, then
# docker exec into the local container over its socket as postgres; no password, URL or tunnel.
EXEC_SCRIPT = r'''set -euo pipefail
set +x
umask 077
tok=$(curl -sS --max-time 3 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token)
id=$(curl -sS --max-time 3 -H "X-aws-ec2-metadata-token: $tok" http://169.254.169.254/latest/meta-data/instance-id)
[ "$id" = "@HOST@" ] || exit 71
ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -qx '@IP@' || exit 72
f=$(mktemp); trap 'rm -f "$f"' EXIT
printf '%s' '@PAYLOAD@' | base64 -d | gzip -dc > "$f"
printf '%s  %s\n' @SHA@ "$f" | sha256sum --check --status
docker exec -i @OPTS@ @CONTAINER@ psql -X -q -A -t -v ON_ERROR_STOP=1 -U @ROLE@ -d @DATABASE@ -f - < "$f"
'''


def remote_body(transaction, target, nonce, mode='apply'):
    if target['transport'] == 'url':
        constants = dict(TRANSACTION=transaction, TRANSACTION_SHA=sha(transaction.encode()), ENV_FILE=target['env_file'], DB_HOST=target['db_host'],
                         DB_PORT=target['db_port'], ROLE=ROLE, DATABASE=DATABASE, SYSTEM=target['system_id'], NONCE=nonce)
        prefix = '\n'.join(k + ' = ' + repr(v) for k, v in constants.items())
        return "set -euo pipefail\nset +x\numask 077\npython3 - <<'EZIL_LA_PY'\n" + prefix + URL_PROGRAM + "\nEZIL_LA_PY\n"
    payload = base64.b64encode(gzip.compress(transaction.encode(), 9, mtime=0)).decode()
    opts = "-e 'PGOPTIONS=-c default_transaction_read_only=on'" if mode == 'read' else ''
    script = EXEC_SCRIPT
    for key, value in (('HOST', target['host']), ('IP', target['ip']), ('PAYLOAD', payload), ('SHA', sha(transaction.encode())), ('OPTS', opts),
                       ('CONTAINER', target['container']), ('ROLE', ROLE), ('DATABASE', DATABASE)):
        need(re.fullmatch(r'[A-Za-z0-9+/=_.:@ \'-]*', value) is not None, 'unsafe transport constant')
        script = script.replace('@' + key + '@', value)
    need(len(script) <= 30000, 'payload exceeds SSM parameter budget')
    return script


def validate_receipt(receipt, pins, mode, classify=False):
    keys = {'schemaVersion', 'target', 'systemIdentifier', 'database', 'role', 'sqlSha256', 'planSha256', 'nonce', 'mode', 'applied', 'before', 'defaultAcl', 'after'}
    need(isinstance(receipt, dict) and set(receipt) == keys and type(receipt['schemaVersion']) is int and receipt['schemaVersion'] == 1 and type(receipt['applied']) is bool, 'invalid receipt')
    need(receipt['target'] == pins['namespace'] and receipt['systemIdentifier'] == pins['system_id'] and receipt['database'] == pins['database'] and receipt['role'] == pins['role'], 'receipt identity mismatch')
    need(receipt['sqlSha256'] == pins['sql_sha'] and receipt['planSha256'] == pins['plan_sha'] and receipt['nonce'] == pins['nonce'] and receipt['mode'] == mode, 'receipt binding mismatch')
    need(isinstance(receipt['defaultAcl'], list), 'invalid default ACL evidence')
    if classify:
        need(mode == 'read' and receipt['applied'] is False and receipt['before'] == receipt['after'], 'receipt state mismatch')
        return 'empty' if receipt['before'] == EMPTY else 'exact' if receipt['before'] == pins['after'] else 'unknown'
    need(receipt['after'] == pins['after'], 'catalog contract mismatch')
    need(receipt['before'] in (EMPTY, pins['after']) and receipt['applied'] == (mode == 'apply' and receipt['before'] == EMPTY), 'receipt state mismatch')


def pins_for(name, plan_sha, nonce, contract, sql_sha):
    t = TARGETS[name]
    return dict(namespace=t['namespace'], system_id=t['system_id'], database=DATABASE, role=ROLE, after=contract['after'], sql_sha=sql_sha, plan_sha=plan_sha, nonce=nonce)


def fingerprints(name):
    """Installer source and transport/selector bytes; a changed installer invalidates the plan."""
    return dict(installerSha256=sha(Path(__file__).read_bytes()), selectorSha256=SELECTOR_SHA256,
                transportSha256=sha(canonical(dict(target=TARGETS[name], urlProgram=URL_PROGRAM, execScript=EXEC_SCRIPT, catalog=CATALOG, defaultAcl=DEFACL))))


# ---- SSM transport (journaled; no blind resend) ----
def host_identity(target, aws):
    need(aws('sts', 'get-caller-identity')['Account'] == ACCOUNT, 'wrong AWS account')
    response = aws('ec2', 'describe-instances', '--instance-ids', target['host'])
    instances = [i for r in response['Reservations'] for i in r['Instances']]
    need(not response.get('NextToken') and len(instances) == 1, 'incomplete host readback')
    host = instances[0]
    tags = {t['Key']: t['Value'] for t in host.get('Tags', [])}
    need(host['InstanceId'] == target['host'] and host['State']['Name'] == 'running' and all(tags.get(k) == v for k, v in (target['tags'] or {}).items()), 'host identity mismatch')


def journal_path(directory, label):
    return Path(directory) / ('lower-attestation-schema-' + label + '-ssm.json')


def expected_journal(label, body, target):
    digest = sha(body.encode())
    state = dict(schemaVersion=1, host=target['host'], sha256=digest, comment='ezil-la-schema-' + label + '-' + digest[:32])
    state['key'] = target['prefix'] + digest + '.sh' if target['transport'] == 'url' else None
    return state


def submit(directory, label, body, target, aws, write, sleep=time.sleep):
    """Journal before send; an ambiguous send is reconciled by comment, never resent."""
    path = journal_path(directory, label)
    need(not path.exists(), 'SSM command already journaled; reconcile it')
    state = dict(expected_journal(label, body, target), status='uploading', commandId=None)
    write(path, state)
    if target['transport'] == 'url':
        with tempfile.TemporaryDirectory(prefix='ezil-la-payload-') as temp:
            payload = Path(temp) / 'payload.sh'; payload.write_bytes(body.encode())
            aws('s3api', 'put-object', '--bucket', target['bucket'], '--key', state['key'], '--body', str(payload), '--server-side-encryption', 'AES256')
        command = ('set -eu; umask 077; unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN; export AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null; '
                   'f=$(mktemp); trap \'rm -f "$f"\' EXIT; aws --region ' + REGION + ' s3 cp --only-show-errors ' + shlex.quote('s3://' + target['bucket'] + '/' + state['key']) + ' "$f"; '
                   'printf "%s  %s\\n" ' + state['sha256'] + ' "$f" | sha256sum --check --status; bash "$f"')
    else:
        command = body
    state['status'] = 'submitting'; write(path, state)
    response = aws('ssm', 'send-command', '--instance-ids', target['host'], '--document-name', 'AWS-RunShellScript', '--comment', state['comment'],
                   '--timeout-seconds', '900', '--parameters', json.dumps({'commands': [command], 'executionTimeout': ['900']}))
    state['commandId'] = response['Command']['CommandId']; write(path, state)
    return poll(path, state, target, aws, write, sleep)


def poll(path, state, target, aws, write, sleep=time.sleep):
    need(re.fullmatch(r'[0-9a-f-]{36}', state['commandId'] or '') is not None, 'invalid SSM command ID')
    for _ in range(180):
        result = aws('ssm', 'get-command-invocation', '--command-id', state['commandId'], '--instance-id', target['host'])
        if result['Status'] in ('Pending', 'InProgress', 'Delayed'):
            sleep(5); continue
        state['status'] = 'complete' if result['Status'] == 'Success' and result['ResponseCode'] == 0 else 'failed'; write(path, state)
        need(state['status'] == 'complete', 'SSM operation failed; outcome unknown, reconcile read-only')
        receipt = manifest.loads(result['StandardOutputContent'].strip())
        if target['transport'] == 'url':
            aws('s3api', 'delete-object', '--bucket', target['bucket'], '--key', state['key'])
        return receipt
    raise ValueError('SSM still pending; reconcile read-only')


def command_terminal(directory, label, expected_body, target, aws):
    """Reconcile requires the journal to bind exactly the expected command and that command to be terminal."""
    path = journal_path(directory, label)
    if not path.exists():
        return True  # intent without a journal: no send was ever attempted
    state = manifest.read(path)
    expected = expected_journal(label, expected_body, target)
    need(set(state) == set(expected) | {'status', 'commandId'} and all(state[k] == v for k, v in expected.items()) and state['status'] in ('uploading', 'submitting', 'complete', 'failed'), 'SSM journal binding mismatch')
    if state['status'] == 'uploading':
        return True
    found = aws('ssm', 'list-commands', '--instance-id', target['host'], '--filters', json.dumps([{'key': 'DocumentName', 'value': 'AWS-RunShellScript'}]))
    need(not found.get('NextToken'), 'incomplete SSM reconciliation')
    matches = [c for c in found['Commands'] if c.get('Comment') == state['comment'] and c.get('InstanceIds') == [target['host']]]
    need(len(matches) == 1 and (state['commandId'] is None or matches[0]['CommandId'] == state['commandId']), 'uncertain SSM submission')
    result = aws('ssm', 'get-command-invocation', '--command-id', matches[0]['CommandId'], '--instance-id', target['host'])
    return result['Status'] in ('Success', 'Failed', 'Cancelled', 'TimedOut')


def aws_cli(*args):
    # Reviewed nonsecret readbacks/commands only; provider detail is suppressed.
    result = subprocess.run(['aws', '--profile', 'ezil-admin', '--region', REGION, '--no-cli-pager', *args, '--output', 'json'],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90, check=False)
    need(result.returncode == 0, 'AWS call failed (provider details suppressed)')
    need(len(result.stdout) <= 4 * 1024 * 1024, 'AWS response too large')
    return manifest.loads(result.stdout.decode('utf-8')) if result.stdout.strip() else {}


# ---- operations ----
def write_json(path, value):
    tmp = Path(str(path) + '.tmp')
    tmp.write_bytes(canonical(value) + b'\n')
    os.replace(tmp, path)


def create_exclusive(path, value):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as out:
        out.write(canonical(value) + b'\n')


def load_pinned(target_name, sql_path=SQL_PATH, catalog_path=CATALOG_PATH, pin=None):
    need(target_name in TARGETS, 'unknown target')
    target = TARGETS[target_name]
    need(transport_pinned(target), 'target transport pins pending')
    pin = PINNED_SQL_SHA256 if pin is None else pin
    need(pin is not None, 'SQL pin pending')
    data = Path(sql_path).read_bytes()
    need(sha(data) == pin, 'SQL hash does not match the pinned hash')
    return target, data, load_contract(pin, catalog_path)


def paths(directory, target_name):
    d = Path(directory)
    return d / ('lower-attestation-schema-' + target_name + '-plan.json'), d / ('lower-attestation-schema-' + target_name + '-intent.json'), d / ('lower-attestation-schema-' + target_name + '-receipt.json')


def plan_value(target_name, data, contract, pre_state):
    target = TARGETS[target_name]
    return dict(schemaVersion=1, kind='lower-attestation-schema-plan', target=target_name, account=ACCOUNT, region=REGION, database=DATABASE, role=ROLE,
                systemIdentifier=target['system_id'], namespace=target['namespace'], transport=target['transport'], sqlSha256=sha(data),
                catalogSha256=sha(canonical(contract)), preState=pre_state, **fingerprints(target_name))


def read_state(target_name, target, data, contract, plan_sha, aws, directory, label, nonce, expected, mode, write=None):
    pins = pins_for(target_name, plan_sha, nonce, contract, sha(data))
    host_identity(target, aws)
    body = remote_body(build_transaction(data.decode(), pins, mode, expected), target, nonce, mode)
    receipt = submit(directory, target_name + '-' + label, body, target, aws, write or write_json)
    state = validate_receipt(receipt, pins, mode, classify=expected == 'any')
    return (state, receipt) if expected == 'any' else receipt


def plan(target_name, directory, aws, **kw):
    target, data, contract = load_pinned(target_name, **kw)
    plan_path, _, _ = paths(directory, target_name)
    need(not plan_path.exists(), 'plan exists; use a new release directory')
    state, _ = read_state(target_name, target, data, contract, '0' * 64, aws, directory, 'plan', uuid.uuid4().hex, 'any', 'read')
    need(state in ('empty', 'exact'), 'unknown or partial schema refused')
    write_json(plan_path, plan_value(target_name, data, contract, state))
    print('Reviewed plan: ' + str(plan_path) + ' sha256=' + sha(plan_path.read_bytes()) + ' preState=' + state)


def load_plan(target_name, path, plan_sha, data, contract):
    raw = Path(path).read_bytes()
    need(sha(raw) == plan_sha, 'plan hash mismatch')
    value = manifest.loads(raw.decode())
    need(isinstance(value, dict) and value.get('preState') in ('empty', 'exact') and value == plan_value(target_name, data, contract, value['preState']), 'plan target drift')
    return value


def intent_value(target_name, plan_sha, sql_sha, nonce, state, **extra):
    return dict(schemaVersion=1, target=target_name, planSha256=plan_sha, sqlSha256=sql_sha, nonce=nonce, state=state, **extra)


def apply(target_name, directory, plan_path, plan_sha, sql_sha, aws, do_apply, **kw):
    target, data, contract = load_pinned(target_name, **kw)
    need(sql_sha == sha(data), 'SQL hash argument mismatch')
    plan_file, intent_path, receipt_path = paths(directory, target_name)
    need(Path(plan_path).resolve() == plan_file.resolve(), 'plan must be the release directory plan')
    value = load_plan(target_name, plan_file, plan_sha, data, contract)
    if receipt_path.exists():
        return replay(target_name, directory, plan_sha, data, contract, aws, target)
    need(not intent_path.exists(), 'intent exists without receipt; outcome unknown, run reconcile')
    host_identity(target, aws)
    if not do_apply:
        print('DRY RUN: verified target ' + target_name + '; no submission')
        return
    nonce = uuid.uuid4().hex
    create_exclusive(intent_path, intent_value(target_name, plan_sha, sql_sha, nonce, 'submitting'))
    pins = pins_for(target_name, plan_sha, nonce, contract, sql_sha)
    receipt = read_state(target_name, target, data, contract, plan_sha, aws, directory, 'apply', nonce, value['preState'], 'apply')
    validate_receipt(receipt, pins, 'apply')
    write_json(receipt_path, dict(planSha256=plan_sha, nonce=nonce, kind='apply', evidence=receipt))
    write_json(intent_path, intent_value(target_name, plan_sha, sql_sha, nonce, 'complete'))
    print('Lower attestation schema verified; receipt retained')


def validate_saved(saved, intent, plan_sha, pins_base):
    """A saved receipt is trustworthy only when bound to the plan, the intent and a validated live read/apply."""
    need(isinstance(saved, dict) and set(saved) == {'planSha256', 'nonce', 'kind', 'evidence'} and saved['planSha256'] == plan_sha and saved['nonce'] == intent['nonce'], 'untrusted receipt')
    if saved['kind'] == 'apply':
        validate_receipt(saved['evidence'], dict(pins_base, nonce=saved['nonce']), 'apply')
    else:
        need(saved['kind'] == 'reconciled' and isinstance(saved['evidence'], dict), 'untrusted receipt')
        need(validate_receipt(saved['evidence'], dict(pins_base, nonce=saved['evidence'].get('nonce')), 'read', classify=True) == 'exact', 'untrusted receipt')


def replay(target_name, directory, plan_sha, data, contract, aws, target):
    """Replay only a trustworthy bound receipt, then re-prove live state read-only."""
    _, intent_path, receipt_path = paths(directory, target_name)
    saved, intent = manifest.read(receipt_path), manifest.read(intent_path)
    need(isinstance(saved, dict) and isinstance(intent, dict) and intent == intent_value(target_name, plan_sha, sha(data), intent.get('nonce'), 'complete',
         **({'reconciled': True} if saved.get('kind') == 'reconciled' else {})), 'untrusted receipt')
    validate_saved(saved, intent, plan_sha, pins_for(target_name, plan_sha, intent['nonce'], contract, sha(data)))
    read_state(target_name, target, data, contract, plan_sha, aws, directory, 'replay-' + uuid.uuid4().hex[:8], uuid.uuid4().hex, 'exact', 'read')
    print('Replay: bound receipt verified and live catalog exact')


def check(target_name, directory, aws, **kw):
    target, data, contract = load_pinned(target_name, **kw)
    read_state(target_name, target, data, contract, '0' * 64, aws, directory, 'check-' + uuid.uuid4().hex[:8], uuid.uuid4().hex, 'exact', 'read')
    print('Check: exact catalog contract, immutability guard, RLS, ACLs and effective client denial verified (target=' + target_name + ')')


def reconcile(target_name, directory, aws, **kw):
    """Read-only. Exact -> bound reconciled receipt; empty -> close the unknown intent; else refuse."""
    target, data, contract = load_pinned(target_name, **kw)
    plan_file, intent_path, receipt_path = paths(directory, target_name)
    need(intent_path.exists() and not receipt_path.exists(), 'nothing to reconcile')
    intent = manifest.read(intent_path)
    need(isinstance(intent, dict) and intent.get('state') in ('submitting', 'failed') and intent == intent_value(target_name, intent.get('planSha256'), sha(data), intent.get('nonce'), intent['state'])
         and re.fullmatch(r'[0-9a-f]{32}', str(intent['nonce'])) is not None, 'intent state not reconcilable')
    plan_sha = intent['planSha256']
    value = load_plan(target_name, plan_file, plan_sha, data, contract)  # original plan bytes, source, catalog and code pins
    host_identity(target, aws)
    apply_body = remote_body(build_transaction(data.decode(), pins_for(target_name, plan_sha, intent['nonce'], contract, sha(data)), 'apply', value['preState']), target, intent['nonce'], 'apply')
    need(command_terminal(directory, target_name + '-apply', apply_body, target, aws), 'apply command not terminal')
    nonce = uuid.uuid4().hex
    outcome, evidence = read_state(target_name, target, data, contract, plan_sha, aws, directory, 'reconcile-' + nonce[:8], nonce, 'any', 'read')
    need(outcome in ('empty', 'exact'), 'unknown or partial schema refused')
    if outcome == 'exact':
        write_json(receipt_path, dict(planSha256=plan_sha, nonce=intent['nonce'], kind='reconciled', evidence=evidence))
        write_json(intent_path, intent_value(target_name, plan_sha, sha(data), intent['nonce'], 'complete', reconciled=True))
        print('Reconciled: live catalog exact; apply outcome adopted without blind retry')
    else:
        tag = '.closed-' + intent['nonce'][:8]
        for source in (journal_path(directory, target_name + '-apply'), intent_path):
            if source.exists():
                os.replace(source, source.with_name(source.name + tag))
        print('Reconciled: live schema empty; intent closed, a fresh apply is permitted')


PUBLIC_REASONS = {
    'SQL pin pending', 'target transport pins pending', 'SQL hash does not match the pinned hash', 'plan hash mismatch', 'plan target drift',
    'SQL hash argument mismatch', 'unknown target', 'plan exists; use a new release directory', 'unknown or partial schema refused',
    'intent exists without receipt; outcome unknown, run reconcile', 'untrusted receipt', 'wrong AWS account', 'host identity mismatch', 'nothing to reconcile',
    'SSM operation failed; outcome unknown, reconcile read-only', 'catalog contract does not match pinned SQL', 'plan must be the release directory plan',
    'intent state not reconcilable', 'SSM journal binding mismatch', 'apply command not terminal', 'uncertain SSM submission',
}


def main(argv=None, aws=None):
    parser = argparse.ArgumentParser(allow_abbrev=False)
    parser.add_argument('operation', choices=('plan', 'apply', 'check', 'reconcile'))
    parser.add_argument('--target', required=True, choices=sorted(TARGETS))
    parser.add_argument('--release-dir', type=Path, required=True)
    parser.add_argument('--plan', type=Path)
    parser.add_argument('--plan-sha256')
    parser.add_argument('--sql-sha256')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    aws = aws or aws_cli
    if args.operation == 'plan':
        plan(args.target, args.release_dir, aws)
    elif args.operation == 'apply':
        need(args.plan is not None and args.plan_sha256 and args.sql_sha256, 'apply requires --plan, --plan-sha256 and --sql-sha256')
        apply(args.target, args.release_dir, args.plan, args.plan_sha256, args.sql_sha256, aws, args.apply)
    elif args.operation == 'check':
        check(args.target, args.release_dir, aws)
    else:
        reconcile(args.target, args.release_dir, aws)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, TypeError, OSError, ImportError, subprocess.TimeoutExpired) as error:
        reason = str(error) if isinstance(error, ValueError) and str(error) in PUBLIC_REASONS else 'lower attestation schema refused'
        print('ERROR: ' + reason + '; check pinned inputs and retained journals before retrying.', file=sys.stderr)
        sys.exit(1)
