// Local synthetic databases only; never read a connection URL or credential file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, open, rm } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import {
  SOURCE_SHA, PINNED_SQL, SQL, TABLES, FUNCTIONS, LEDGERS, STARTUP, LIMITS,
  sha256, validateSource, sanitizedError, ledgerQueries, collectEvidence, runPreflight,
} from '../deploy/aws/os-staging/parity-schema-preflight.mjs';

const moduleURL = new URL('../deploy/aws/os-staging/parity-schema-preflight.mjs', import.meta.url);
const source = await readFile(moduleURL, 'utf8');
const require = createRequire(import.meta.url);
let PGlite;
try { ({ PGlite } = require('@electric-sql/pglite')); }
catch { ({ PGlite } = await import('/data/openclaw/projects/ezil/EZiL-Works/node_modules/@electric-sql/pglite/dist/index.js')); }
const env = mode => ({ EZIL_GIT_SHA: SOURCE_SHA[mode] });
const git = async (ref, path) => (await promisify(execFile)('git', ['show', `${ref}:${path}`], { cwd: new URL('..', import.meta.url) })).stdout;
// This managed sandbox drops nested Node pipe output; ordinary file descriptors preserve it.
const node = async (args, options = {}) => {
  const directory = await mkdtemp(join(tmpdir(), 'parity-preflight-test-'));
  await writeFile(join(directory, 'stdin'), options.input ?? '');
  const input = await open(join(directory, 'stdin'), 'r');
  const out = await open(join(directory, 'stdout'), 'w+');
  const err = await open(join(directory, 'stderr'), 'w+');
  try {
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, args, { env: options.env, stdio: [input.fd, out.fd, err.fd] });
      child.once('error', reject);
      child.once('close', code => resolve(code));
    });
    return { status, stdout: await readFile(join(directory, 'stdout'), 'utf8'), stderr: await readFile(join(directory, 'stderr'), 'utf8') };
  } finally { await input.close(); await out.close(); await err.close(); await rm(directory, { recursive: true, force: true }); }
};
const sqlFile = id => readFile(new URL(`../app/drizzle/${id}.sql`, import.meta.url), 'utf8');

async function database(t, setup = '') {
  const db = new PGlite();
  t.after(() => db.close());
  if (setup) await db.exec(setup);
  for (const [key, value] of Object.entries(STARTUP)) await db.exec(`SET ${key} = '${value}'`);
  const statements = [];
  const query = async (sql, params = []) => {
    statements.push({ sql, params });
    return (await db.query(sql, params)).rows;
  };
  return { db, query, statements };
}

const baselineDDL = `CREATE SCHEMA ezil_ci;
  CREATE TABLE ezil_ci.baselines (repository text PRIMARY KEY, project text NOT NULL, schemas jsonb NOT NULL,
    initial_catalog text NOT NULL, snapshots text NOT NULL, registered_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ezil_ci.journal (repository text NOT NULL, id text NOT NULL, checksum text NOT NULL, ordinal integer NOT NULL,
    before_catalog text NOT NULL, after_catalog text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`;
const stageDDL = `CREATE TABLE public.ezil_staging_schema_log(file text PRIMARY KEY, sha256 text NOT NULL,
  mode text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());`;

const allowedStatement = statement => /^(?:SELECT\b|BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$|ROLLBACK$|SET LOCAL row_security = off$|SAVEPOINT ledger_read$|ROLLBACK TO SAVEPOINT ledger_read$|RELEASE SAVEPOINT ledger_read$)/.test(statement);

test('all generated SQL follows the read-only static contract; identifiers cannot be injected', () => {
  const all = [...Object.values(SQL), ...LEDGERS.flatMap(l => l.profiles.flatMap(p => Object.values(ledgerQueries(l, p))))];
  for (const statement of all) {
    assert.ok(allowedStatement(statement), statement);
    assert.doesNotMatch(statement, /\b(?:INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|TEMP|DO|COPY|CALL|COMMIT)\b/i);
    assert.doesNotMatch(statement, /SELECT\s+\*/i);
    assert.doesNotMatch(statement, /\b(?:dblink|pg_read_file|pg_sleep|set_config|lo_import)\b/i);
  }
  assert.throws(() => ledgerQueries({ schema: 'public', name: 'ezil_agent_sessions' }, {}));
  for (const ledger of LEDGERS) for (const p of ledger.profiles) {
    const statements = Object.values(ledgerQueries(ledger, p)).join('\n');
    assert.doesNotMatch(statements, /"(?:repository|project|schemas|registered_at|applied_at|created_at|mode|dirty)"/);
    assert.match(statements, /FROM ONLY/);
    assert.match(statements, /LIMIT 257/);
  }
  assert.match(source, /createRequire\(resolve\(cwd,/);
  assert.doesNotMatch(source, /(?:readFile|readFileSync|dotenv|console\.)/);
  assert.ok(TABLES.includes('ezil_operator_entitlements'));
  assert.equal(FUNCTIONS.length, 2);
});

test('SQL pins match exact local production files and independent staging Git objects', async () => {
  for (const [id, hash] of PINNED_SQL.production) {
    const sql = id.startsWith('0038_') ? await git('b543803e5948621ce864debccbef6b0c8423f9f9', `app/drizzle/${id}.sql`) : await sqlFile(id);
    assert.equal(sha256(sql), hash, id);
  }
  assert.equal(sha256(await git(SOURCE_SHA.production, 'app/drizzle/0034_assignment_migration_clock.sql')), PINNED_SQL.production[0][1]);
  for (const [id, hash] of PINNED_SQL.staging) assert.equal(sha256(await git(SOURCE_SHA.staging, `app/drizzle/${id}.sql`)), hash, id);
  assert.notEqual(PINNED_SQL.production[0][0], PINNED_SQL.staging[0][0]);
});

test('source/mode mismatch refuses before driver creation or connection-value access', async () => {
  let touched = false;
  const hostileEnv = { EZIL_GIT_SHA: 'wrong', get SUPABASE_DATABASE_URL() { touched = true; throw Error('SECRET'); } };
  for (const mode of ['production', 'staging', 'bad', '__proto__', undefined]) {
    await assert.rejects(runPreflight({ mode, env: hostileEnv, postgresFactory() { touched = true; } }));
  }
  assert.equal(touched, false);
  for (const mode of ['production', 'staging']) assert.equal(validateSource(mode, env(mode)), SOURCE_SHA[mode]);
});

test('safe import; direct file and stdin invocation refuse with sanitized JSON', async () => {
  const cleanEnv = { PATH: process.env.PATH, EZIL_GIT_SHA: 'https://secret.invalid/person@example.test' };
  const imported = await node(['--input-type=module', '-e', `await import(${JSON.stringify(moduleURL.href)})`], { env: cleanEnv, encoding: 'utf8' });
  assert.equal(imported.status, 0);
  assert.equal(imported.stdout + imported.stderr, '');
  for (const args of [[moduleURL.pathname, 'production'], ['--input-type=module', '-', 'production']]) {
    const result = await node(args, { input: source, env: cleanEnv, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), { status: 'refused', gate: 'source_mismatch' });
  }
});

test('absence is actual catalog evidence; all SELECTs bounded and transaction rollback only', async t => {
  const { db, query, statements } = await database(t);
  const result = await collectEvidence(query, 'production', env('production'));
  assert.equal(result.tables.length, TABLES.length);
  assert.ok(result.tables.every(x => x.status === 'absent'));
  assert.ok(result.functions.every(x => x.status === 'absent'));
  assert.ok(result.ledgers.every(x => x.status === 'absent'));
  assert.deepEqual(result.gates, [{ gate: 'ledger_receipts_unavailable' }]);
  assert.equal(statements[0].sql, SQL.begin);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
  assert.ok(statements.every(x => allowedStatement(x.sql)));
  assert.ok(statements.length < LIMITS.queries);
  assert.equal((await db.query("SELECT current_setting('transaction_isolation') AS value")).rows[0].value, 'read committed');
});

test('real migration catalog presence, columns/RLS/definition hashes; no customer row reads', async t => {
  const setup = `CREATE ROLE anon; CREATE ROLE authenticated;
    CREATE SCHEMA auth; CREATE TABLE auth.users(id uuid PRIMARY KEY);
    CREATE TABLE public.ezil_compute_migrations (id uuid PRIMARY KEY, user_id uuid, computer_id uuid, state text, workspace_head jsonb);
    CREATE TABLE public.ezil_computer_placements (computer_id uuid, owner_user_id uuid, instance_type text, instance_id text,
      volume_id text, generation bigint, lease_epoch bigint, state text, provider text);
    ${await sqlFile('0019_operator_entitlements')}
    ${await sqlFile('0034_assignment_migration_clock')}
    ${await sqlFile('0035_editor_agent_sessions')};
    ${await sqlFile('0036_editor_control_operations')};
    ${await sqlFile('0037_editor_protocol_2')};
    ${await git('b543803e', 'app/drizzle/0038_operator_access_overrides.sql')}
    ${await sqlFile('0039_named_computer_creation')}
    ${stageDDL}
    INSERT INTO public.ezil_staging_schema_log(file,sha256,mode) VALUES
      ('app/drizzle/0034_editor_agent_sessions.sql','${PINNED_SQL.staging[0][1]}','apply');`;
  const { db, query, statements } = await database(t, setup);
  const first = await collectEvidence(query, 'production', env('production'));
  assert.equal(first.counts.tables_present, TABLES.length);
  assert.equal(first.counts.functions_present, 2);
  assert.equal(first.status, 'observed');
  const owner = first.tables.find(x => x.name === 'ezil_editor_bridge_owner');
  assert.equal(owner.rls, true);
  assert.deepEqual(owner.columns.find(c => c.name === 'protocol'), {
    name: 'protocol', ordinal: 8, type: 'integer', nullable: true, default_sha256: null, identity: '', generated: '',
  });
  assert.equal(first.tables.find(x => x.name === 'ezil_operator_entitlements').columns.find(c => c.name === 'access_override').nullable, false);
  const migration = first.tables.find(x => x.name === 'ezil_compute_migrations');
  assert.ok(migration.triggers.some(x => x.name === 'ezil_assignment_migration_clock_state' && /^[a-f0-9]{64}$/.test(x.definition_sha256)));
  assert.match(first.functions[0].definitions[0].definition_sha256, /^[a-f0-9]{64}$/);
  const second = await collectEvidence(query, 'staging', env('staging'));
  assert.equal(first.catalog_sha256, second.catalog_sha256);
  for (const { sql } of statements) for (const table of TABLES) {
    assert.doesNotMatch(sql, new RegExp(`FROM (?:ONLY )?(?:public\\.|"public"\\.")${table}\\b`));
  }
  assert.doesNotMatch(JSON.stringify(first), /CREATE FUNCTION|RETURN NEW|clock_timestamp|postgres:\/\//);
  // A structural change must affect the catalog digest, independently of any SQL-file pin.
  await db.exec('SET default_transaction_read_only=off');
  await db.exec('ALTER TABLE public.ezil_agent_sessions ALTER COLUMN title SET NOT NULL');
  await db.exec('SET default_transaction_read_only=on');
  const changed = await collectEvidence(query, 'production', env('production'));
  assert.notEqual(changed.catalog_sha256, first.catalog_sha256);
});

test('known ledger shapes read only safe columns; injected strings and SQL text never escape', async t => {
  const secret = 'https://credential:secret@example.invalid/customer-identity';
  const { query } = await database(t, `${baselineDDL} ${stageDDL}
    INSERT INTO ezil_ci.baselines VALUES ('${secret}','${secret}','{}',repeat('a',64),repeat('b',64),now());
    INSERT INTO ezil_ci.journal VALUES ('${secret}','0034_assignment_migration_clock','${PINNED_SQL.production[0][1]}',1,repeat('c',64),repeat('d',64),now());
    INSERT INTO public.ezil_staging_schema_log VALUES ('${secret}','${secret}','${secret}',now());
    CREATE SCHEMA drizzle;
    CREATE TABLE drizzle.__drizzle_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint);
    INSERT INTO drizzle.__drizzle_migrations(hash,created_at) VALUES (repeat('e',64),123456);
    CREATE TABLE public.schema_migrations(version bigint, dirty boolean);
    INSERT INTO public.schema_migrations VALUES (34,false);`);
  const result = await collectEvidence(query, 'production', env('production'));
  const journal = result.ledgers.find(l => l.name === 'ezil_ci.journal');
  assert.equal(journal.row_count, '1');
  assert.equal(journal.rows[0].id.migration_id, '0034_assignment_migration_clock');
  assert.equal(journal.rows[0].ordinal, '1');
  assert.equal(result.ledgers.find(l => l.name === 'drizzle.__drizzle_migrations').rows[0].id, '1');
  assert.equal(result.ledgers.find(l => l.name === 'public.schema_migrations').rows[0].version, '34');
  const output = JSON.stringify(result);
  assert.ok(!output.includes(secret));
  assert.doesNotMatch(output, /customer-identity|credential:secret/);
  assert.match(output, /invalid_value_sha256/);
  assert.match(output, /unrecognized_identifier_sha256/);
});

test('unknown ledger shapes and views are not read or mislabeled absent', async t => {
  const { query, statements } = await database(t, `CREATE TABLE public.schema_migrations(customer_id uuid, sql text);
    CREATE VIEW public.__drizzle_migrations AS SELECT 1 AS id, 'SECRET'::text AS hash, 1::bigint AS created_at;`);
  const result = await collectEvidence(query, 'production', env('production'));
  for (const name of ['public.schema_migrations', 'public.__drizzle_migrations']) {
    const ledger = result.ledgers.find(l => l.name === name);
    assert.equal(ledger.status, 'unknown_shape');
    assert.equal(ledger.row_count, undefined);
  }
  assert.ok(!statements.some(s => s.sql.includes('FROM ONLY')));
});

test('private ezil_ci schema denial is an exact gate, and other ledger probes continue', async t => {
  const { db, query } = await database(t, `${baselineDDL} ${stageDDL}
    CREATE ROLE app_probe; GRANT USAGE ON SCHEMA public TO app_probe;
    GRANT SELECT ON public.ezil_staging_schema_log TO app_probe;`);
  await db.exec('SET ROLE app_probe');
  const result = await collectEvidence(query, 'production', env('production'));
  for (const name of ['ezil_ci.baselines', 'ezil_ci.journal']) {
    const ledger = result.ledgers.find(l => l.name === name);
    assert.equal(ledger.status, 'inaccessible');
    assert.equal(ledger.gate, 'schema_usage_denied');
    assert.equal(ledger.sqlstate, '42501');
  }
  assert.equal(result.ledgers.find(l => l.name === 'public.ezil_staging_schema_log').status, 'readable');
  assert.equal(result.status, 'incomplete');
});

test('RLS cannot silently hide ledger receipts; permission error rolls back to savepoint', async t => {
  const { db, query, statements } = await database(t, `${stageDDL}
    INSERT INTO public.ezil_staging_schema_log(file,sha256,mode) VALUES ('0034_editor_agent_sessions',repeat('f',64),'apply');
    ALTER TABLE public.ezil_staging_schema_log ENABLE ROW LEVEL SECURITY;
    CREATE ROLE app_probe; GRANT USAGE ON SCHEMA public TO app_probe;
    GRANT SELECT ON public.ezil_staging_schema_log TO app_probe;`);
  await db.exec('SET ROLE app_probe');
  const result = await collectEvidence(query, 'staging', env('staging'));
  const ledger = result.ledgers.find(l => l.name === 'public.ezil_staging_schema_log');
  assert.equal(ledger.status, 'inaccessible');
  assert.equal(ledger.sqlstate, '42501');
  assert.equal(ledger.row_count, undefined);
  assert.ok(statements.some(s => s.sql === SQL.rollbackSavepoint));
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
});

test('large ledgers return bounded receipts and an explicit incomplete gate', async t => {
  const { query } = await database(t, `CREATE TABLE public.schema_migrations(version bigint, dirty boolean);
    INSERT INTO public.schema_migrations SELECT g,false FROM generate_series(1,300) g;`);
  const result = await collectEvidence(query, 'production', env('production'));
  const ledger = result.ledgers.find(l => l.name === 'public.schema_migrations');
  assert.equal(ledger.row_count, '300');
  assert.equal(ledger.rows.length, LIMITS.ledgerRows);
  assert.equal(ledger.status, 'bounded');
  assert.equal(result.status, 'incomplete');
});

test('driver startup options, reserved session, cleanup and database errors are sanitized', async () => {
  let ended = false;
  const secret = 'postgres://secret:user@private.invalid/private';
  const factory = (url, options) => {
    assert.equal(url, secret);
    assert.deepEqual(options.connection, STARTUP);
    assert.equal(options.max, 1);
    assert.equal(options.prepare, false);
    assert.equal(options.connect_timeout, 5);
    return { reserve: async () => { throw Object.assign(new Error(secret), { code: '42501', detail: secret }); },
      end: async options => { ended = true; assert.deepEqual(options, { timeout: 1 }); } };
  };
  await assert.rejects(runPreflight({ mode: 'production', env: { ...env('production'), SUPABASE_DATABASE_URL: secret }, postgresFactory: factory }), error => {
    assert.deepEqual(sanitizedError(error), { status: 'inaccessible', gate: 'permission_denied', sqlstate: '42501' });
    return true;
  });
  assert.equal(ended, true);
  assert.deepEqual(sanitizedError(new Error(secret)), { status: 'error', gate: 'query_failed', sqlstate: null });
});

test('session contract and catalog failures always roll back and never emit raw error detail', async t => {
  const { query, statements } = await database(t);
  const fault = Object.assign(new Error('SECRET https://private.invalid/user'), { code: '57014' });
  await assert.rejects(collectEvidence((sql, params) => sql === SQL.columns ? Promise.reject(fault) : query(sql, params), 'production', env('production')), error => {
    assert.deepEqual(sanitizedError(error), { status: 'error', gate: 'statement_timeout', sqlstate: '57014' });
    return true;
  });
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
  await assert.rejects(collectEvidence((sql, params) => sql === SQL.settings ? Promise.resolve([{ read_only: 'off' }]) : query(sql, params), 'production', env('production')), /session_contract_mismatch/);
  assert.equal(statements.at(-1).sql, 'ROLLBACK');
});
