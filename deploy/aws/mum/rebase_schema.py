"""Exact staging SQL application; no migration runner registration."""
import base64
import hashlib
import json
import re

import rebase_manifest as manifest

need = manifest.need
PLACEMENTS = {'lower_image_digest': ['text', False], 'lower_digest_observed_at': ['timestamp with time zone', False], 'image_upgrade_job_id': ['uuid', False]}


def expected_schema(sql):
    """Derive the exact table shape from the deliberately small contract DDL.

    Reject new grammar instead of accidentally executing an expanded SQL file.
    The original SQL bytes are still sent unchanged within the transaction.
    """
    kind = {'timestamptz': 'timestamp with time zone'}
    pattern = r'CREATE TABLE public.ezil_computer_image_jobs \(\n(.*?)\n\);'
    found = re.search(pattern, sql, re.S)
    need(found is not None, 'reviewed image-job table DDL missing')
    columns = {}
    for line in found[1].splitlines():
        match = re.fullmatch(r'  ([a-z_]+) (uuid|text|bigint|jsonb|boolean|timestamptz) (NOT NULL|NULL),?', line)
        need(match is not None and match[1] not in columns, 'unreviewed column DDL')
        columns[match[1]] = [kind.get(match[2], match[2]), match[3] == 'NOT NULL']
    indexes = dict(re.findall(r'CREATE INDEX (ezil_computer_image_jobs_[a-z_]+) ON public.ezil_computer_image_jobs \(([a-z_, ]+)\);', sql))
    expected = ''.join(f'ALTER TABLE public.ezil_computer_placements ADD COLUMN {name} {"timestamptz" if dtype == "timestamp with time zone" else dtype} NULL;\n' for name, (dtype, _) in PLACEMENTS.items())
    expected += found[0] + '\n'
    expected += ''.join(f'CREATE INDEX {name} ON public.ezil_computer_image_jobs ({cols});\n' for name, cols in indexes.items())
    expected += 'REVOKE ALL ON TABLE public.ezil_computer_image_jobs FROM public, anon, authenticated;\nALTER TABLE public.ezil_computer_image_jobs ENABLE ROW LEVEL SECURITY;\n'
    need(sql == expected and len(indexes) == 4, 'SQL is outside the exact contract DDL grammar')
    return {'placements': PLACEMENTS, 'columns': columns, 'indexes': indexes}


# Catalog evidence includes all job columns, indexes, RLS, grants, and policies;
# preexisting placements are preserved but the three appended fields are exact.
CATALOG = r"""
SELECT json_build_object(
 'placements', COALESCE((SELECT json_object_agg(attname, json_build_array(format_type(atttypid,atttypmod),attnotnull)) FROM pg_attribute WHERE attrelid='public.ezil_computer_placements'::regclass AND attname IN ('lower_image_digest','lower_digest_observed_at','image_upgrade_job_id') AND NOT attisdropped), '{}'::json),
 'columns', COALESCE((SELECT json_object_agg(attname,json_build_array(format_type(atttypid,atttypmod),attnotnull)) FROM pg_attribute WHERE attrelid=to_regclass('public.ezil_computer_image_jobs') AND attnum>0 AND NOT attisdropped), '{}'::json),
 'indexes', COALESCE((SELECT json_object_agg(indexname,indexdef) FROM pg_indexes WHERE schemaname='public' AND tablename='ezil_computer_image_jobs'), '{}'::json),
 'rls', COALESCE((SELECT relrowsecurity FROM pg_class WHERE oid=to_regclass('public.ezil_computer_image_jobs')),false),
 'constraints', (SELECT count(*) FROM pg_constraint WHERE conrelid=to_regclass('public.ezil_computer_image_jobs')),
 'defaults', (SELECT count(*) FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum WHERE d.adrelid=to_regclass('public.ezil_computer_image_jobs') OR (d.adrelid='public.ezil_computer_placements'::regclass AND a.attname IN ('lower_image_digest','lower_digest_observed_at','image_upgrade_job_id'))),
 'triggers', (SELECT count(*) FROM pg_trigger WHERE tgrelid=to_regclass('public.ezil_computer_image_jobs') AND NOT tgisinternal),
 'policies', (SELECT count(*) FROM pg_policy WHERE polrelid=to_regclass('public.ezil_computer_image_jobs')),
 'grants', (SELECT count(*) FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) a WHERE c.oid=to_regclass('public.ezil_computer_image_jobs') AND (a.grantee=0 OR a.grantee IN (SELECT oid FROM pg_roles WHERE rolname IN ('anon','authenticated'))))
)::text;
"""


def body(sql_bytes, system_id):
    need(manifest.matches(r'[0-9]{1,20}', system_id), 'independently verified DB system identifier required')
    sql = sql_bytes.decode('utf-8'); expected = expected_schema(sql)
    sha = hashlib.sha256(sql_bytes).hexdigest()
    after = dict(expected, rls=True, constraints=0, defaults=0, triggers=0, policies=0, grants=0)
    after['indexes'] = {k: 'CREATE INDEX '+k+' ON public.ezil_computer_image_jobs USING btree ('+v+')' for k,v in expected['indexes'].items()}
    empty = dict(placements={},columns={},indexes={},rls=False,constraints=0,defaults=0,triggers=0,policies=0,grants=0)
    literal = lambda value: "'" + json.dumps(value,separators=(',',':')).replace("'", "''") + "'::jsonb"
    expression = CATALOG.strip().removeprefix('SELECT ').removesuffix('::text;')
    transaction = "BEGIN; SET LOCAL lock_timeout='15s'; SET LOCAL statement_timeout='120s';\n"
    transaction += "DO $pin$ BEGIN IF (SELECT system_identifier::text FROM pg_control_system()) IS DISTINCT FROM '"+system_id+"' THEN RAISE EXCEPTION 'system identity mismatch'; END IF; END $pin$;\n"
    transaction += "DO $lock$ BEGIN PERFORM pg_advisory_xact_lock(744152206222); END $lock$;\nLOCK TABLE public.ezil_computer_placements IN SHARE ROW EXCLUSIVE MODE;\n"
    transaction += "DO $table$ BEGIN IF to_regclass('public.ezil_computer_image_jobs') IS NOT NULL THEN EXECUTE 'LOCK TABLE public.ezil_computer_image_jobs IN ACCESS EXCLUSIVE MODE'; END IF; END $table$;\n"
    transaction += 'CREATE TEMP TABLE ezil_rebase_schema_before ON COMMIT DROP AS SELECT ('+expression+')::jsonb AS evidence;\n'
    transaction += 'DO $apply$ BEGIN IF (SELECT evidence FROM ezil_rebase_schema_before) = '+literal(empty)+' THEN EXECUTE $reviewed$'+sql+'$reviewed$; ELSIF (SELECT evidence FROM ezil_rebase_schema_before) <> '+literal(after)+" THEN RAISE EXCEPTION 'partial schema refused'; END IF; END $apply$;\n"
    transaction += 'DO $verify$ BEGIN IF ('+expression+')::jsonb <> '+literal(after)+" THEN RAISE EXCEPTION 'schema verification failed'; END IF; END $verify$;\n"
    transaction += "SELECT json_build_object('schemaVersion',1,'systemIdentifier','"+system_id+"','schemaSha256','"+sha+"','applied',(SELECT evidence FROM ezil_rebase_schema_before) = "+literal(empty)+",'before',(SELECT evidence FROM ezil_rebase_schema_before),'after',"+expression+")::text;\nCOMMIT;\n"
    # The remote program mirrors rw-sql.sh's transport and PostgreSQL image. URL
    # routing is checked before any connection; credentials stay in remote memory.
    program = r'''
import base64, hashlib, json, os, re, subprocess, sys
from pathlib import Path
from urllib.parse import urlsplit, unquote, parse_qsl

def require(ok):
    if not ok: raise RuntimeError('staging schema refused')

try:
    sql = base64.b64decode(SQL64).decode('utf-8')
    require(hashlib.sha256(sql.encode()).hexdigest() == SHA)
    values = dict(line.split('=',1) for line in Path('/etc/ezil-os-staging/app.env').read_text().splitlines() if '=' in line)
    raw = values['SUPABASE_DATABASE_URL']
    require(not any(s in unquote(raw).lower() for s in ('btgq','curomaa')))
    url = urlsplit(raw)
    require(url.scheme in ('postgres','postgresql') and url.hostname == '10.61.20.35' and url.port == 5432 and not url.fragment)
    query = dict(parse_qsl(url.query, strict_parsing=True))
    require(set(query) <= {'sslmode'} and query.get('sslmode','disable') in ('disable','require','verify-ca','verify-full'))
    require(url.username and url.password and url.path.startswith('/') and re.fullmatch(r'[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}',unquote(url.path[1:])))
    env = {'PATH':os.defpath + ':/usr/local/bin', 'PGHOST':'10.61.20.35','PGPORT':'5432',
           'PGUSER':unquote(url.username),'PGPASSWORD':unquote(url.password),'PGDATABASE':unquote(url.path[1:]),
           'PGSSLMODE':query.get('sslmode','disable'),'PGCONNECT_TIMEOUT':'10'}
    command = ['docker','run','--rm','-i','--network','host']
    for key in env:
        if key.startswith('PG'): command += ['-e',key]
    command += ['postgres:17-alpine','psql','-X','-q','-A','-t','--no-password','-v','ON_ERROR_STOP=1','-P','pager=off','-f','-']
    # A single bounded process consumes a complete transaction. Do not rely on
    # psql stdout being line-buffered while waiting for more stdin.
    result=subprocess.run(command,input=TRANSACTION,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=env,timeout=180)
    require(result.returncode==0)
    receipt=json.loads(result.stdout)
    require(receipt['systemIdentifier']==SYSTEM and receipt['schemaSha256']==SHA)
    print(json.dumps(receipt,separators=(',',':')))

except Exception:
    print('staging schema operation refused',file=sys.stderr)
    sys.exit(1)
'''
    constants = dict(SQL64=base64.b64encode(sql_bytes).decode(), SHA=sha, SYSTEM=system_id, TRANSACTION=transaction)
    prefix = '\n'.join(k + ' = ' + repr(v) for k, v in constants.items())
    return "set -euo pipefail\nset +x\numask 077\npython3 - <<'EZIL_SCHEMA_PY'\n" + prefix + program + "\nEZIL_SCHEMA_PY\n"


def validate_receipt(receipt, sql_bytes, system_id):
    need(set(receipt) == {'schemaVersion','systemIdentifier','schemaSha256','applied','before','after'}, 'invalid schema receipt')
    need(type(receipt['schemaVersion']) is int and receipt['schemaVersion'] == 1 and type(receipt['applied']) is bool, 'invalid schema receipt types')
    need(receipt['systemIdentifier'] == system_id and receipt['schemaSha256'] == hashlib.sha256(sql_bytes).hexdigest(), 'schema receipt identity mismatch')
    expected = expected_schema(sql_bytes.decode())
    after = receipt['after']
    need(set(after) == {'placements','columns','indexes','rls','constraints','defaults','triggers','policies','grants'}, 'invalid schema evidence')
    need(after['placements'] == expected['placements'] and after['columns'] == expected['columns'], 'schema columns mismatch')
    need(after['indexes'] == {k: 'CREATE INDEX '+k+' ON public.ezil_computer_image_jobs USING btree ('+v+')' for k,v in expected['indexes'].items()}, 'schema indexes mismatch')
    need(after['rls'] is True and all(type(after[k]) is int and after[k] == 0 for k in ('constraints','defaults','triggers','policies','grants')), 'schema access mismatch')
    empty = {'placements':{},'columns':{},'indexes':{},'rls':False,'constraints':0,'defaults':0,'triggers':0,'policies':0,'grants':0}
    need(receipt['before'] == (empty if receipt['applied'] else after), 'partial schema refused')
