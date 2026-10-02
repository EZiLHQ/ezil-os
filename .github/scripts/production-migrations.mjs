#!/usr/bin/env node
// Portable protocol v1. Node >= 20; no packages. Copy this file unchanged.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export const hash = value => createHash('sha256').update(value).digest('hex');
const hex = /^[a-f0-9]{64}$/;
const command = promisify(execFile);
const name = /^[a-z][a-z0-9_]*$/;
const literal = value => `E'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const fail = message => { throw new Error(message); };
const check = (condition, message) => { if (!condition) fail(message); };
const fields = (value, keys, label) => {
  check(value && typeof value === 'object' && !Array.isArray(value), `Invalid ${label}`);
  check(Object.keys(value).sort().join() === [...keys].sort().join(), `Unexpected/missing fields in ${label}`);
};

// Tokenize comments and quotes before parsing. No regex-based statement splitting.
// The deliberately small grammar below never accepts executable expressions/bodies.
export function tokenize(sql) {
  const tokens = [];
  let i = 0;
  while (i < sql.length) {
    if (/\s/.test(sql[i])) { i++; continue; }
    if (sql.startsWith('--', i)) { const end = sql.indexOf('\n', i); i = end < 0 ? sql.length : end + 1; continue; }
    if (sql.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < sql.length && depth) {
        if (sql.startsWith('/*', i)) { depth++; i += 2; }
        else if (sql.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      check(!depth, 'Unterminated SQL comment'); continue;
    }
    const c = sql[i];
    if (c === '"' || c === "'") {
      i++; let value = ''; let closed = false;
      while (i < sql.length) {
        if (sql[i] === c) {
          if (sql[i + 1] === c) { value += c; i += 2; }
          else { i++; closed = true; break; }
        } else { check(sql[i] !== '\\' && sql[i] !== '\0', 'SQL escape syntax is unsupported'); value += sql[i++]; }
      }
      check(closed, 'Unterminated SQL quote');
      tokens.push({ kind: c === '"' ? 'identifier' : 'string', value }); continue;
    }
    const word = sql.slice(i).match(/^[A-Za-z_][A-Za-z_0-9]*/);
    if (word) { tokens.push({ kind: 'word', value: word[0].toLowerCase() }); i += word[0].length; continue; }
    const number = sql.slice(i).match(/^\d+/);
    if (number) { tokens.push({ kind: 'number', value: number[0] }); i += number[0].length; continue; }
    check('(),.;'.includes(c), 'Unsupported SQL token (bodies, escapes and operators are refused)');
    tokens.push({ kind: 'punctuation', value: c }); i++;
  }
  return tokens;
}

export function additiveSQL(sql, schemas) {
  const ts = tokenize(sql); let i = 0; let statements = 0;
  const is = value => ts[i]?.value === value && ts[i]?.kind !== 'identifier' && ts[i]?.kind !== 'string';
  const take = value => { check(is(value), `Unsupported additive SQL: expected ${value}`); i++; };
  const ident = () => { const t = ts[i++]; check(t && ['word', 'identifier'].includes(t.kind) && t.value.length > 0, 'Expected SQL identifier'); return t.value; };
  const qualified = () => { const schema = ident(); check(schemas.includes(schema), 'SQL target is outside owned schemas'); take('.'); ident(); };
  const type = () => {
    let t = ident();
    if (t === 'pg_catalog' && is('.')) { take('.'); t = ident(); }
    check(['text', 'boolean', 'bool', 'smallint', 'integer', 'int', 'bigint', 'int2', 'int4', 'int8', 'uuid', 'json', 'jsonb', 'bytea', 'date', 'timestamp', 'timestamptz', 'numeric', 'decimal', 'varchar', 'real', 'float8'].includes(t), 'Only approved built-in column types are supported');
    if (is('(')) {
      check(['numeric', 'decimal', 'varchar', 'timestamp', 'timestamptz'].includes(t), 'Unsupported type modifier');
      take('('); check(ts[i++]?.kind === 'number', 'Expected numeric type modifier');
      if (is(',')) { check(['numeric', 'decimal'].includes(t), 'Unsupported type modifier'); take(','); check(ts[i++]?.kind === 'number', 'Expected numeric type modifier'); }
      take(')');
    }
  };
  const column = () => { ident(); type(); if (is('not')) { take('not'); take('null'); } else if (is('null')) take('null'); };
  while (i < ts.length) {
    if (is('create')) {
      take('create');
      if (is('table')) {
        take('table'); qualified(); take('('); column();
        while (is(',')) { take(','); column(); } take(')');
      } else {
        take('index'); ident(); take('on'); qualified(); take('('); ident();
        while (is(',')) { take(','); ident(); } take(')');
      }
    } else {
      take('alter'); take('table'); qualified(); take('add'); take('column'); column();
    }
    statements++;
    if (i < ts.length) take(';');
  }
  check(statements > 0, 'Empty migration');
  return sql;
}

export async function validate(root, manifestPath = '.github/production-migrations.json') {
  const manifest = JSON.parse(await readFile(resolve(root, manifestPath), 'utf8'));
  fields(manifest, ['version', 'repository', 'project', 'schemas', 'sources', 'initialCatalog', 'migrations', 'trustedWorkflowRuns', 'reviewedEventTriggers'], 'manifest');
  check(manifest.version === 1, 'Unsupported manifest version');
  check(typeof manifest.repository === 'string' && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(manifest.repository), 'Invalid repository');
  check(typeof manifest.project === 'string' && /^[a-z]{20}$/.test(manifest.project), 'Invalid project');
  check(Array.isArray(manifest.schemas) && manifest.schemas.length && manifest.schemas.every(s => typeof s === 'string' && name.test(s) && !['ezil_ci', 'pg_catalog', 'information_schema'].includes(s) && !s.startsWith('pg_')) && new Set(manifest.schemas).size === manifest.schemas.length, 'Invalid owned schemas');
  check(Array.isArray(manifest.trustedWorkflowRuns) && manifest.trustedWorkflowRuns.every(n => Number.isSafeInteger(n) && n > 0) && new Set(manifest.trustedWorkflowRuns).size === manifest.trustedWorkflowRuns.length, 'Invalid trusted workflow IDs');
  check(Array.isArray(manifest.reviewedEventTriggers), 'Invalid reviewed event triggers');
  const eventNames = new Set();
  for (const trigger of manifest.reviewedEventTriggers) {
    fields(trigger, ['name', 'sha256'], 'reviewed event trigger');
    check(typeof trigger.name === 'string' && name.test(trigger.name) && hex.test(trigger.sha256) && !eventNames.has(trigger.name), 'Invalid/duplicate reviewed event trigger');
    eventNames.add(trigger.name);
  }
  if (manifest.initialCatalog !== null) {
    fields(manifest.initialCatalog, ['digest', 'capturedAt', 'objects', 'sourceDigest'], 'initialCatalog');
    check(hex.test(manifest.initialCatalog.sourceDigest) && hex.test(manifest.initialCatalog.digest) && Number.isSafeInteger(manifest.initialCatalog.objects) && manifest.initialCatalog.objects >= manifest.schemas.length && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(manifest.initialCatalog.capturedAt) && Number.isFinite(Date.parse(manifest.initialCatalog.capturedAt)), 'Invalid initial catalog');
  }
  check(Array.isArray(manifest.sources) && Array.isArray(manifest.migrations), 'Invalid source/migration arrays');
  const inventory = (await command('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', '*.sql'], { cwd: root, encoding: 'utf8' })).stdout.split('\0').filter(Boolean).sort();
  const files = new Map();
  for (const source of manifest.sources) {
    fields(source, ['path', 'sha256', 'kind'], 'source');
    check(typeof source.path === 'string' && /^[A-Za-z0-9_./-]+\.sql$/.test(source.path) && !source.path.startsWith('/') && !source.path.split('/').some(p => p === '..' || p === '.' || !p) && hex.test(source.sha256) && ['snapshot', 'migration'].includes(source.kind), 'Invalid source');
    check(!files.has(source.path), 'Duplicate source');
    const path = resolve(root, source.path);
    check(await realpath(path) === path && !relative(root, path).startsWith('..'), 'Symlink/path escape refused');
    const content = await readFile(path);
    check(hash(content) === source.sha256, `Source checksum mismatch: ${source.path}`);
    files.set(source.path, { ...source, sql: content.toString('utf8') });
  }
  check(JSON.stringify([...files.keys()].sort()) === JSON.stringify(inventory), 'SQL inventory differs from manifest (including unregistered SQL)');
  const ids = new Set(); const paths = new Set();
  let previous = manifest.initialCatalog?.digest;
  for (const migration of manifest.migrations) {
    fields(migration, ['id', 'path', 'sha256', 'before', 'after'], 'migration');
    check(typeof migration.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(migration.id) && !ids.has(migration.id) && !paths.has(migration.path), 'Invalid/duplicate migration');
    check(hex.test(migration.sha256) && hex.test(migration.before) && hex.test(migration.after) && migration.before === previous && migration.before !== migration.after, 'Invalid catalog chain');
    const file = files.get(migration.path);
    check(file?.kind === 'migration' && file.sha256 === migration.sha256, 'Migration source mismatch');
    additiveSQL(file.sql, manifest.schemas);
    ids.add(migration.id); paths.add(migration.path); previous = migration.after;
  }
  check([...files.values()].filter(f => f.kind === 'migration').every(f => paths.has(f.path)), 'Unordered migration source');
  return { manifest, files };
}

// Definitions only: never query application rows, sequence values, or function results.
// OIDs are resolved to stable identities; physical/statistical state is excluded.
export function catalogSQL(schemas, includeBody = false) {
  const selected = schemas.map(literal).join(',');
  const identity = (catalog, oid) => `(CASE WHEN ${oid}<>0 THEN (pg_identify_object('pg_${catalog}'::regclass,${oid},0)).identity END)`;
  return `WITH ns AS (SELECT * FROM pg_namespace WHERE nspname IN (${selected})), families AS (SELECT f.* FROM pg_opfamily f JOIN ns n ON n.oid=f.opfnamespace), addresses AS (
    SELECT d.classid,d.objid,d.objsubid FROM pg_depend d JOIN ns n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid
    UNION SELECT 'pg_type'::regclass,t.oid,0 FROM pg_type t JOIN ns n ON n.oid=t.typnamespace
    UNION SELECT 'pg_amop'::regclass,a.oid,0 FROM pg_amop a JOIN families f ON f.oid=a.amopfamily
    UNION SELECT 'pg_amproc'::regclass,a.oid,0 FROM pg_amproc a JOIN families f ON f.oid=a.amprocfamily
  ), objects AS (
    SELECT 'schema' kind, nspname identity, jsonb_build_array(pg_get_userbyid(nspowner), nspacl::text) definition FROM ns
    UNION ALL SELECT 'relation', n.nspname||'.'||c.relname, jsonb_build_array(c.relkind,c.relpersistence,pg_get_userbyid(c.relowner),c.relacl::text,c.relrowsecurity,c.relforcerowsecurity,c.relreplident,c.reloptions,c.relispartition,pg_get_expr(c.relpartbound,c.oid),CASE WHEN c.relkind='p' THEN pg_get_partkeydef(c.oid) END,CASE WHEN c.relkind IN ('v','m') THEN pg_get_viewdef(c.oid,false) END) FROM pg_class c JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'column', n.nspname||'.'||c.relname||'.'||a.attnum, jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,a.attidentity,a.attgenerated,a.attisdropped,a.attacl::text,a.attoptions,cn.nspname,co.collname,pg_get_expr(d.adbin,d.adrelid)) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN ns n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_namespace cn ON cn.oid=co.collnamespace WHERE a.attnum>0
    UNION ALL SELECT 'constraint', n.nspname||'.'||COALESCE(c.relname,t.typname)||'.'||x.conname, jsonb_build_array(pg_get_constraintdef(x.oid,false),x.convalidated,x.condeferrable,x.condeferred) FROM pg_constraint x JOIN ns n ON n.oid=x.connamespace LEFT JOIN pg_class c ON c.oid=x.conrelid LEFT JOIN pg_type t ON t.oid=x.contypid
    UNION ALL SELECT 'index', n.nspname||'.'||c.relname, jsonb_build_array(pg_get_indexdef(x.indexrelid),x.indisvalid,x.indisready,x.indisreplident) FROM pg_index x JOIN pg_class c ON c.oid=x.indexrelid JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'routine', n.nspname||'.'||p.proname||'('||pg_get_function_identity_arguments(p.oid)||')', jsonb_build_array(CASE WHEN p.prokind<>'a' THEN pg_get_functiondef(p.oid) ELSE p.prosrc END,pg_get_userbyid(p.proowner),p.proacl::text,p.proconfig,p.prokind,p.provolatile,p.prosecdef) FROM pg_proc p JOIN ns n ON n.oid=p.pronamespace
    UNION ALL SELECT 'type', n.nspname||'.'||t.typname, jsonb_build_array(t.typtype,pg_get_userbyid(t.typowner),t.typacl::text,format_type(t.typbasetype,t.typtypmod),t.typnotnull,t.typdefault,t.typisdefined,t.typlen,t.typbyval,t.typalign,t.typstorage,t.typcategory,t.typispreferred,t.typdelim,t.typndims,pg_get_expr(t.typdefaultbin,0),${identity('type','t.typelem')},${identity('type','t.typarray')},${identity('class','t.typrelid')},${identity('collation','t.typcollation')},${['typinput','typoutput','typreceive','typsend','typmodin','typmodout','typanalyze','typsubscript'].map(field => identity('proc',`t.${field}`)).join(',')}, (SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid=t.oid)) FROM pg_type t JOIN ns n ON n.oid=t.typnamespace
    UNION ALL SELECT 'operator', ${identity('operator','o.oid')}, jsonb_build_array(pg_get_userbyid(o.oprowner),o.oprkind,o.oprcanmerge,o.oprcanhash,${['oprleft','oprright','oprresult'].map(field => identity('type',`o.${field}`)).join(',')},${['oprcom','oprnegate'].map(field => identity('operator',`o.${field}`)).join(',')},${['oprcode','oprrest','oprjoin'].map(field => identity('proc',`o.${field}`)).join(',')}) FROM pg_operator o JOIN ns n ON n.oid=o.oprnamespace
    UNION ALL SELECT 'opclass', ${identity('opclass','o.oid')}, jsonb_build_array(pg_get_userbyid(o.opcowner),${identity('am','o.opcmethod')},${identity('opfamily','o.opcfamily')},${identity('type','o.opcintype')},o.opcdefault,${identity('type','o.opckeytype')}) FROM pg_opclass o JOIN ns n ON n.oid=o.opcnamespace
    UNION ALL SELECT 'opfamily', ${identity('opfamily','f.oid')}, jsonb_build_array(pg_get_userbyid(f.opfowner),${identity('am','f.opfmethod')}) FROM families f
    UNION ALL SELECT 'amop', ${identity('amop','a.oid')}, jsonb_build_array(${identity('opfamily','a.amopfamily')},${identity('type','a.amoplefttype')},${identity('type','a.amoprighttype')},a.amopstrategy,a.amoppurpose,${identity('operator','a.amopopr')},${identity('am','a.amopmethod')},${identity('opfamily','a.amopsortfamily')}) FROM pg_amop a JOIN families f ON f.oid=a.amopfamily
    UNION ALL SELECT 'amproc', ${identity('amproc','a.oid')}, jsonb_build_array(${identity('opfamily','a.amprocfamily')},${identity('type','a.amproclefttype')},${identity('type','a.amprocrighttype')},a.amprocnum,${identity('proc','a.amproc')}) FROM pg_amproc a JOIN families f ON f.oid=a.amprocfamily
    UNION ALL SELECT 'dependency', i.type||':'||i.identity, jsonb_build_array(d.deptype,r.type,r.identity) FROM addresses a JOIN pg_depend d USING(classid,objid,objsubid) CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) r
    UNION ALL SELECT 'policy', n.nspname||'.'||c.relname||'.'||p.polname, jsonb_build_array(p.polcmd,p.polpermissive,(SELECT jsonb_agg(CASE WHEN r=0 THEN 'public' ELSE pg_get_userbyid(r) END ORDER BY r) FROM unnest(p.polroles) r),pg_get_expr(p.polqual,p.polrelid),pg_get_expr(p.polwithcheck,p.polrelid)) FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'trigger', n.nspname||'.'||c.relname||'.'||t.tgname, jsonb_build_array(pg_get_triggerdef(t.oid,false),t.tgenabled) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'rule', n.nspname||'.'||c.relname||'.'||r.rulename, jsonb_build_array(pg_get_ruledef(r.oid,false),r.ev_enabled) FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'sequence', n.nspname||'.'||c.relname, jsonb_build_array(format_type(s.seqtypid,NULL),s.seqstart,s.seqincrement,s.seqmax,s.seqmin,s.seqcache,s.seqcycle) FROM pg_sequence s JOIN pg_class c ON c.oid=s.seqrelid JOIN ns n ON n.oid=c.relnamespace
    UNION ALL SELECT 'default_acl', n.nspname||'.'||pg_get_userbyid(d.defaclrole)||'.'||d.defaclobjtype::text, to_jsonb(d.defaclacl::text) FROM pg_default_acl d JOIN ns n ON n.oid=d.defaclnamespace
    UNION ALL SELECT 'inheritance', n.nspname||'.'||c.relname||'.'||x.inhseqno, jsonb_build_array(pn.nspname,p.relname,x.inhdetachpending) FROM pg_inherits x JOIN pg_class c ON c.oid=x.inhrelid JOIN ns n ON n.oid=c.relnamespace JOIN pg_class p ON p.oid=x.inhparent JOIN pg_namespace pn ON pn.oid=p.relnamespace
    UNION ALL SELECT 'extension', e.extname, jsonb_build_array(e.extversion,e.extrelocatable) FROM pg_extension e JOIN ns n ON n.oid=e.extnamespace
    UNION ALL SELECT 'schema_member', i.type||':'||i.identity, to_jsonb(i.identity) FROM pg_depend d JOIN ns n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) i
  ), snapshot AS (SELECT COALESCE(jsonb_agg(jsonb_build_array(kind,identity,definition) ORDER BY kind COLLATE "C",identity COLLATE "C",definition::text COLLATE "C"),'[]'::jsonb) body, count(*)::integer objects FROM objects)
  SELECT encode(sha256(convert_to(body::text,'UTF8')),'hex') digest, objects, (SELECT count(*)::integer FROM ns) schemas${includeBody ? ', body' : ''} FROM snapshot`;
}

// An explicit reviewed inventory covers active platform DDL hooks. Names alone
// are never sufficient: pin their effective trigger/function/schema definitions.
export function eventTriggersSQL() {
  return `SELECT COALESCE(jsonb_agg(jsonb_build_object('name',name,'sha256',sha256) ORDER BY name COLLATE "C"),'[]'::jsonb) triggers FROM (
    SELECT t.evtname name, encode(sha256(convert_to(jsonb_build_array(
      t.evtevent,t.evtenabled,(SELECT jsonb_agg(tag ORDER BY tag COLLATE "C") FROM unnest(t.evttags) tag),pg_get_userbyid(t.evtowner),
      n.nspname,pg_get_userbyid(n.nspowner),n.nspacl::text,
      pg_get_function_identity_arguments(p.oid),pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.proacl::text,p.proconfig,p.prosecdef,p.provolatile,p.proleakproof,
      (SELECT jsonb_agg(jsonb_build_array(e.extname,e.extversion) ORDER BY e.extname COLLATE "C") FROM pg_depend d JOIN pg_extension e ON d.refclassid='pg_extension'::regclass AND d.refobjid=e.oid WHERE d.classid='pg_proc'::regclass AND d.objid=p.oid AND d.deptype='e')
    )::text,'UTF8')),'hex') sha256 FROM pg_event_trigger t JOIN pg_proc p ON p.oid=t.evtfoid JOIN pg_namespace n ON n.oid=p.pronamespace WHERE t.evtenabled<>'D'
  ) reviewed`;
}

const verifyEventTriggers = manifest => assertSQL(`(SELECT triggers FROM (${eventTriggersSQL()}) events)=${json([...(manifest.reviewedEventTriggers ?? [])].sort((a,b) => a.name < b.name ? -1 : 1))}`, 'Active event triggers differ from reviewed inventory');

const digestExpression = schemas => `(SELECT digest FROM (${catalogSQL(schemas)}) catalog)`;
export const snapshotHash = manifest => hash(JSON.stringify(manifest.sources.filter(s => s.kind === 'snapshot').map(s => ({ path: s.path, sha256: s.sha256, kind: s.kind })).sort((a,b) => a.path < b.path ? -1 : 1)));
const repository = manifest => manifest.repository.toLowerCase();
const assertSQL = (condition, message) => `IF (${condition}) IS DISTINCT FROM TRUE THEN RAISE EXCEPTION ${literal(message)}; END IF;`;

// Fail closed for schema object classes whose definitions v1 cannot fingerprint.
function supportedCatalog(schemas) {
  const selected = schemas.map(literal).join(',');
  return assertSQL(`NOT EXISTS (SELECT 1 FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid WHERE n.nspname IN (${selected}) AND d.classid NOT IN ('pg_class'::regclass,'pg_proc'::regclass,'pg_type'::regclass,'pg_constraint'::regclass,'pg_extension'::regclass,'pg_default_acl'::regclass,'pg_operator'::regclass,'pg_opclass'::regclass,'pg_opfamily'::regclass)) AND NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN (${selected}) AND c.relkind NOT IN ('r','p','v','m','S','i','I','c')) AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN (${selected}) AND p.prokind='a') AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname IN (${selected}) AND (t.typtype NOT IN ('b','c','d','e') OR NOT t.typisdefined))`, 'Unsupported owned catalog object; extend and review protocol first');
}

// The legacy snapshots column is the historical capture digest, never current sources.
function verifyJournal(manifest) {
  const repo = literal(repository(manifest));
  const entries = json(manifest.migrations);
  return `${assertSQL(`NOT EXISTS (SELECT 1 FROM ezil_ci.baselines WHERE repository=${repo} AND (project<>${literal(manifest.project)} OR schemas<>${json([...manifest.schemas].sort())} OR initial_catalog<>${literal(manifest.initialCatalog.digest)} OR snapshots<>${literal(manifest.initialCatalog.sourceDigest)}))`, 'Baseline registration drift')}
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM ezil_ci.journal j LEFT JOIN jsonb_array_elements(${entries}) WITH ORDINALITY m(entry,position) ON m.entry->>'id'=j.id WHERE j.repository=${repo} AND (m.entry IS NULL OR j.checksum<>m.entry->>'sha256' OR j.before_catalog<>m.entry->>'before' OR j.after_catalog<>m.entry->>'after' OR j.ordinal<>m.position))`, 'Applied migration checksum/order drift')}
  ${assertSQL(`(SELECT count(*) FROM ezil_ci.journal WHERE repository=${repo}) = COALESCE((SELECT max(ordinal) FROM ezil_ci.journal WHERE repository=${repo}),0)`, 'Journal is not a contiguous prefix')}`;
}

export function journalShape() {
  return `
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='ezil_ci') AND NOT EXISTS (SELECT 1 FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci') AND NOT EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci')`, 'Unexpected journal routine/rule/policy')}
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE n.nspname='ezil_ci' AND a.grantee<>c.relowner)`, 'Journal tables must be private')}
  ${['baselines','journal'].map(table => {
    const columns = table === 'baselines' ? ['repository:text','project:text','schemas:jsonb','initial_catalog:text','snapshots:text','registered_at:timestamp with time zone'] : ['repository:text','id:text','checksum:text','ordinal:integer','before_catalog:text','after_catalog:text','applied_at:timestamp with time zone'];
    return assertSQL(`(SELECT jsonb_agg(a.attname||':'||format_type(a.atttypid,a.atttypmod) ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid='ezil_ci.${table}'::regclass AND a.attnum>0)=${json(columns)} AND NOT EXISTS (SELECT 1 FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='ezil_ci.${table}'::regclass AND a.attnum>0 AND (NOT a.attnotnull OR a.attisdropped OR a.attidentity<>'' OR a.attgenerated<>'' OR COALESCE(pg_get_expr(d.adbin,d.adrelid),'')<>CASE WHEN a.attname IN ('registered_at','applied_at') THEN 'now()' ELSE '' END)) AND (SELECT relkind='r' AND NOT relispartition AND relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid='ezil_ci.${table}'::regclass)`, 'Journal table shape drift');
  }).join('\n')}
  ${assertSQL(`(SELECT jsonb_agg(pg_get_constraintdef(oid,false) ORDER BY pg_get_constraintdef(oid,false) COLLATE "C") FROM pg_constraint WHERE contype<>'n' AND conrelid='ezil_ci.baselines'::regclass)=${json(['PRIMARY KEY (repository)'])} AND (SELECT jsonb_agg(pg_get_constraintdef(oid,false) ORDER BY pg_get_constraintdef(oid,false) COLLATE "C") FROM pg_constraint WHERE contype<>'n' AND conrelid='ezil_ci.journal'::regclass)=${json(['CHECK ((ordinal > 0))','FOREIGN KEY (repository) REFERENCES ezil_ci.baselines(repository)','PRIMARY KEY (repository, id)','UNIQUE (repository, ordinal)'])}`, 'Journal constraint drift')}`;
}

export function applySQL({ manifest, files }) {
  check(manifest.initialCatalog, 'Live catalog baseline required before apply');
  check(hex.test(manifest.initialCatalog.sourceDigest), 'Historical source digest required');
  const repo = literal(repository(manifest));
  let body = `DECLARE actual text; expected text; role_name text; BEGIN
  PERFORM pg_advisory_xact_lock(1702521196, 1835624306);
  ${verifyEventTriggers(manifest)}
  CREATE SCHEMA IF NOT EXISTS ezil_ci;
  ${assertSQL(`(to_regclass('ezil_ci.baselines') IS NULL) = (to_regclass('ezil_ci.journal') IS NULL)`, 'Incomplete journal')}
  ${assertSQL(`(SELECT nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) FROM pg_namespace WHERE nspname='ezil_ci')`, 'Journal schema owner mismatch')}
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci' AND (c.relowner<>(SELECT oid FROM pg_roles WHERE rolname=current_user) OR c.relname NOT IN ('baselines','baselines_pkey','journal','journal_pkey','journal_repository_ordinal_key')))`, 'Unknown journal object/owner')}
  REVOKE ALL ON SCHEMA ezil_ci FROM PUBLIC;
  CREATE TABLE IF NOT EXISTS ezil_ci.baselines (repository text PRIMARY KEY, project text NOT NULL, schemas jsonb NOT NULL, initial_catalog text NOT NULL, snapshots text NOT NULL, registered_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE IF NOT EXISTS ezil_ci.journal (repository text NOT NULL REFERENCES ezil_ci.baselines(repository), id text NOT NULL, checksum text NOT NULL, ordinal integer NOT NULL CHECK(ordinal>0), before_catalog text NOT NULL, after_catalog text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(repository,id), UNIQUE(repository,ordinal));
  ALTER TABLE ezil_ci.baselines ENABLE ROW LEVEL SECURITY;
  ALTER TABLE ezil_ci.journal ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON ALL TABLES IN SCHEMA ezil_ci FROM PUBLIC;
  FOR role_name IN SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') LOOP
    EXECUTE format('REVOKE ALL ON SCHEMA ezil_ci FROM %I',role_name);
    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA ezil_ci FROM %I',role_name);
  END LOOP;
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='ezil_ci' AND a.grantee<>n.nspowner)`, 'Journal schema must be private')}
  ${assertSQL(`NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='ezil_ci' AND NOT t.tgisinternal)`, 'Unexpected journal trigger')}
  ${journalShape()}
  ${assertSQL(`(SELECT count(*) FROM pg_namespace WHERE nspname IN (${manifest.schemas.map(literal).join(',')}))=${manifest.schemas.length}`, 'Missing owned baseline schema')}
  ${supportedCatalog(manifest.schemas)}
  ${verifyJournal(manifest)}
  actual := ${digestExpression(manifest.schemas)};
  IF NOT EXISTS (SELECT 1 FROM ezil_ci.baselines WHERE repository=${repo}) THEN
    ${assertSQL(`NOT EXISTS (SELECT 1 FROM ezil_ci.baselines b WHERE b.schemas ?| ARRAY[${manifest.schemas.map(literal).join(',')}])`, 'Owned schemas overlap another repository')}
    ${assertSQL(`actual=${literal(manifest.initialCatalog.digest)}`, 'Initial catalog mismatch; historical SQL is never replayed')}
    INSERT INTO ezil_ci.baselines(repository,project,schemas,initial_catalog,snapshots) VALUES (${repo},${literal(manifest.project)},${json([...manifest.schemas].sort())},${literal(manifest.initialCatalog.digest)},${literal(manifest.initialCatalog.sourceDigest)});
  END IF;
  expected := COALESCE((SELECT after_catalog FROM ezil_ci.journal WHERE repository=${repo} ORDER BY ordinal DESC LIMIT 1),${literal(manifest.initialCatalog.digest)});
  ${assertSQL('actual=expected', 'Current catalog drift')}
  `;
  manifest.migrations.forEach((m, index) => {
    // Execute as a string in the enclosing DO block: transaction commands cannot
    // escape the block, even if the reviewed grammar is extended in the future.
    body += `IF NOT EXISTS (SELECT 1 FROM ezil_ci.journal WHERE repository=${repo} AND id=${literal(m.id)}) THEN
      ${assertSQL(`${digestExpression(manifest.schemas)}=${literal(m.before)}`, 'Migration before catalog mismatch')}
      EXECUTE ${literal(additiveSQL(files.get(m.path).sql, manifest.schemas))};
      ${assertSQL(`${digestExpression(manifest.schemas)}=${literal(m.after)}`, 'Migration after catalog mismatch')}
      INSERT INTO ezil_ci.journal(repository,id,checksum,ordinal,before_catalog,after_catalog) VALUES (${repo},${literal(m.id)},${literal(m.sha256)},${index + 1},${literal(m.before)},${literal(m.after)});
    END IF;\n`;
  });
  body += `${verifyEventTriggers(manifest)} END`;
  // SQL string literal, not a fixed dollar delimiter that source SQL could close.
  return `BEGIN; SET LOCAL search_path=pg_catalog; SET LOCAL standard_conforming_strings=on; SET LOCAL lock_timeout='30s'; SET LOCAL statement_timeout='120s'; DO ${literal(body)}; COMMIT;`;
}

export function planSQL(manifest) {
  if (manifest.initialCatalog) check(hex.test(manifest.initialCatalog.sourceDigest), 'Historical source digest required');
  const repo = literal(repository(manifest));
  const body = `DECLARE actual text; expected text; applied integer := 0; BEGIN
    ${verifyEventTriggers(manifest)}
    ${supportedCatalog(manifest.schemas)}
    ${assertSQL(`(SELECT count(*) FROM pg_namespace WHERE nspname IN (${manifest.schemas.map(literal).join(',')}))=${manifest.schemas.length}`, 'Missing owned baseline schema')}
    actual := ${digestExpression(manifest.schemas)};
    ${manifest.initialCatalog ? `
      expected := ${literal(manifest.initialCatalog.digest)};
      ${assertSQL(`(to_regclass('ezil_ci.baselines') IS NULL) = (to_regclass('ezil_ci.journal') IS NULL)`, 'Incomplete journal')}
      IF to_regclass('ezil_ci.journal') IS NOT NULL THEN
        ${journalShape()}
        ${verifyJournal(manifest)}
        SELECT count(*)::integer INTO applied FROM ezil_ci.journal WHERE repository=${repo};
        SELECT COALESCE((SELECT after_catalog FROM ezil_ci.journal WHERE repository=${repo} ORDER BY ordinal DESC LIMIT 1),expected) INTO expected;
      END IF;
      ${assertSQL('actual=expected', 'Current catalog drift')}
    ` : ''}
    PERFORM set_config('ezil_ci.plan_applied',applied::text,true);
  END`;
  return `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='30s'; DO ${literal(body)}; SELECT c.*,current_setting('ezil_ci.plan_applied')::integer applied FROM (${catalogSQL(manifest.schemas)}) c; COMMIT;`;
}

export async function authorize(manifest, { env = process.env, request = fetch, root = process.cwd() } = {}) {
  const versionTag = env.GITHUB_EVENT_NAME === 'push' && /^refs\/tags\/v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(env.GITHUB_REF ?? '');
  check(env.GITHUB_ACTIONS === 'true' && (env.GITHUB_REF === 'refs/heads/main' || versionTag), 'Apply requires GitHub Actions on main or a verified version tag');
  check(env.GITHUB_REPOSITORY?.toLowerCase() === repository(manifest), 'GitHub repository mismatch');
  check(['push', 'workflow_dispatch', 'workflow_run'].includes(env.GITHUB_EVENT_NAME), 'Untrusted GitHub event');
  check(env.GITHUB_TOKEN && env.GITHUB_EVENT_PATH, 'GitHub token/event required');
  const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8'));
  check(event.repository?.full_name?.toLowerCase() === repository(manifest), 'Event repository mismatch');
  let sha = env.GITHUB_SHA;
  if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    const run = event.workflow_run;
    check(event.action === 'completed' && run?.conclusion === 'success' && run.head_branch === 'main' && ['push','workflow_dispatch'].includes(run.event) && run.head_repository?.full_name?.toLowerCase() === repository(manifest) && manifest.trustedWorkflowRuns.includes(run.workflow_id), 'Untrusted workflow_run');
    sha = run.head_sha;
  } else if (env.GITHUB_EVENT_NAME === 'push') {
    check(event.ref === env.GITHUB_REF && event.deleted !== true && event.after === sha, 'Invalid main/tag push');
  }
  check(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Invalid commit SHA');
  const github = path => request(`https://api.github.com/repos/${manifest.repository}/${path}`, { headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, redirect: 'error', signal: AbortSignal.timeout(15000) });
  if (versionTag) {
    check(manifest.trustedWorkflowRuns.length > 0, 'Version tag requires an approved CI workflow');
    const tag = (await command('git', ['rev-parse', '--verify', `${env.GITHUB_REF}^{commit}`], { cwd: root, encoding: 'utf8' })).stdout.trim();
    check(tag === sha, 'Version tag SHA differs from event');
    let approved = false;
    for (const workflow of manifest.trustedWorkflowRuns) {
      const response = await github(`actions/workflows/${workflow}/runs?branch=main&event=push&per_page=1`);
      check(response.ok, `CI lookup failed: HTTP ${response.status}`);
      const data = await response.json();
      const latest = data.workflow_runs?.[0];
      if (latest?.workflow_id === workflow && latest.status === 'completed' && latest.conclusion === 'success' && latest.event === 'push' && latest.head_branch === 'main' && latest.head_sha === sha && latest.head_repository?.full_name?.toLowerCase() === repository(manifest)) approved = true;
    }
    check(approved, 'Version tag requires latest successful completed current-main push CI');
  }
  const response = await github('commits/main');
  check(response.ok, `Current-main lookup failed: HTTP ${response.status}`);
  const head = await response.json();
  const checkout = (await command('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();
  check(head.sha === sha && checkout === sha, 'Stale run or checkout: fetched current-main SHA required');
  check(!(await command('git', ['diff', '--name-only', 'HEAD', '--'], { cwd: root, encoding: 'utf8' })).stdout.trim() && !(await command('git', ['status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none'], { cwd: root, encoding: 'utf8' })).stdout.trim(), 'Apply requires a clean tracked checkout');
  // Runtime receipts may be untracked; SQL remains governed by validate's full inventory.
  check(!(await command('git', ['ls-files', '--others', '--exclude-standard', '--', '*.sql'], { cwd: root, encoding: 'utf8' })).stdout.trim(), 'Apply refuses untracked SQL');
  return sha;
}

export async function query(project, sql, { env = process.env, request = fetch, readOnly = false } = {}) {
  check(env.SUPABASE_ACCESS_TOKEN, 'SUPABASE_ACCESS_TOKEN required');
  let response;
  try {
    response = await request(`https://api.supabase.com/v1/projects/${project}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql, read_only: readOnly }), redirect: 'error', signal: AbortSignal.timeout(150000) });
  } catch { fail('Database request failed; outcome unknown. Rerun the same reviewed manifest to reconcile.'); }
  check(response.ok, `Database request failed: HTTP ${response.status}; transaction outcome must be reconciled by rerun`);
  let data;
  try { data = await response.json(); } catch { fail('Invalid database response; reconcile by rerun'); }
  check(Array.isArray(data), 'Unexpected database response; reconcile by rerun');
  return data;
}

export async function run(argv, options = {}) {
  const root = options.root ?? fileURLToPath(new URL('../../', import.meta.url));
  const log = options.log ?? console.log;
  check(argv.length === 1 && ['validate','plan','apply'].includes(argv[0]), 'Usage: production-migrations.mjs validate|plan|apply');
  const loaded = await validate(root);
  const { manifest } = loaded;
  if (argv[0] === 'validate') {
    log(JSON.stringify({ valid: true, sources: manifest.sources.length, migrations: manifest.migrations.length, baseline: manifest.initialCatalog ? 'captured' : 'required; apply disabled' }));
    return;
  }
  if (argv[0] === 'plan') {
    const rows = await query(manifest.project, planSQL(manifest), { ...options, readOnly: true });
    const state = rows.find(r => hex.test(r.digest) && Number.isInteger(r.objects) && Number.isInteger(r.schemas));
    check(state, 'Missing catalog response');
    check(state.schemas === manifest.schemas.length, 'Missing owned schema; cannot baseline');
    log(JSON.stringify({ repository: manifest.repository, project: manifest.project, observedCatalog: { digest: state.digest, objects: state.objects, capturedAt: new Date().toISOString(), sourceDigest: manifest.initialCatalog?.sourceDigest ?? snapshotHash(manifest) }, currentSourceDigest: snapshotHash(manifest), baseline: manifest.initialCatalog ? 'catalog verified' : 'review this observation before setting initialCatalog', pendingMigrations: manifest.migrations.slice(state.applied).map(m => m.id) }));
    return;
  }
  check(manifest.initialCatalog, 'Live catalog baseline required before apply');
  await authorize(manifest, { ...options, root });
  await query(manifest.project, applySQL(loaded), options);
  log(JSON.stringify({ repository: manifest.repository, reconciled: true, migrations: manifest.migrations.length }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
