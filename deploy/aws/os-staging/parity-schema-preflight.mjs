// Read-only, standalone stdin payload. Never import application code or read credential files.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const freeze = value => {
  if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
};
export const SOURCE_SHA = freeze({
  production: '86a6e55dd33275098f62a829e4d9493184cbdd9a',
  staging: '308447f793384e100efc87ec35739304327a48dc',
});
// File byte hashes, NOT inferred installed checksums. See SCHEMA-PREFLIGHT.md for provenance.
export const PINNED_SQL = freeze({
  production: [
    ['0034_assignment_migration_clock', '20d13abe691864be55aa7ee7732a3f5da723f3586c1741770c5d5c2a743accd1'],
    ['0035_editor_agent_sessions', '1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d'],
    ['0036_editor_control_operations', '0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59'],
    ['0037_editor_protocol_2', '134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16'],
    ['0038_operator_access_overrides', '04ae74d9fe1b34cd26a72bec5d85ee5213cfcfc7389c3560268acab06901d0d0'],
    ['0039_named_computer_creation', '5203f0603cda73801f16784ecbf745a32772bce700f00c8cf708caaad78299aa'],
  ],
  staging: [
    ['0034_editor_agent_sessions', '1ae73e8865f488b2736608a88dd0767aebd04dfe49c43db69751db78dc8cc80d'],
    ['0035_editor_control_operations', '0ab5ff43439b281ea6ff8eaa56efb7b166e0cdcb6e283029c2a216baf7c8da59'],
    ['0036_editor_protocol_2', '134e14daa769de62f5ac25298569fd7b5e0a26697cf7e98963c650cd28f08c16'],
    ['0037_named_computer_creation', '5203f0603cda73801f16784ecbf745a32772bce700f00c8cf708caaad78299aa'],
    ['0038_operator_access_overrides', '04ae74d9fe1b34cd26a72bec5d85ee5213cfcfc7389c3560268acab06901d0d0'],
  ],
});
export const TABLES = freeze([
  'ezil_assignment_migration_clock', 'ezil_compute_migrations', 'ezil_computer_placements',
  'ezil_editor_bridge_owner', 'ezil_agent_sessions', 'ezil_agent_operations', 'ezil_agent_events',
  'ezil_control_operations', 'ezil_operator_entitlements', 'ezil_named_computer_creations',
]);
export const FUNCTIONS = freeze([
  'ezil_record_assignment_migration_clock', 'ezil_record_assignment_migration_ready',
]);
export const LIMITS = freeze({ catalogRows: 1024, ledgerRows: 256, wallMs: 45000, queries: 80 });
export const STARTUP = freeze({
  default_transaction_read_only: 'on', statement_timeout: '3000', lock_timeout: '1000',
  idle_in_transaction_session_timeout: '5000', search_path: 'pg_catalog',
  application_name: 'parity-schema-preflight',
});

export const sha256 = value => createHash('sha256').update(String(value)).digest('hex');
class Refusal extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
export function validateSource(mode, env) {
  if (!Object.hasOwn(SOURCE_SHA, mode)) throw new Refusal('mode_required');
  if (env.EZIL_GIT_SHA !== SOURCE_SHA[mode]) throw new Refusal('source_mismatch');
  return SOURCE_SHA[mode];
}
export function sanitizedError(error) {
  if (error instanceof Refusal) return { status: 'refused', gate: error.reason };
  const code = ['42501', '57014', '55P03', '42P01', '25006', '25P02', '08000', '08001', '08006', '57P01']
    .includes(error?.code) ? error.code : null;
  return { status: code === '42501' ? 'inaccessible' : 'error',
    gate: code === '42501' ? 'permission_denied' : code === '57014' ? 'statement_timeout' :
      code === '55P03' ? 'lock_timeout' : 'query_failed', sqlstate: code };
}
const identifier = value => /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(value ?? '')
  ? value : `sha256:${sha256(value)}`;
const checksum = value => /^[a-f0-9]{64}$/i.test(value ?? '')
  ? { sha256: value.toLowerCase() } : { invalid_value_sha256: sha256(value) };
const decimal = value => /^(0|[1-9][0-9]{0,18})$/.test(String(value)) ? String(value) : null;
const knownIds = new Set(Object.values(PINNED_SQL).flat().map(([id]) => id));
function migrationIdentifier(value) {
  const id = typeof value === 'string' ? value.replace(/^app\/drizzle\//, '').replace(/\.sql$/, '') : '';
  return knownIds.has(id) ? { migration_id: id } : { unrecognized_identifier_sha256: sha256(value) };
}
function typeName(row) {
  return row.type_schema === 'pg_catalog' && /^(?:uuid|text|boolean|smallint|integer|bigint|jsonb|json|bytea|date|real|double precision|numeric(?:\(\d+(?:,\d+)?\))?|character varying(?:\(\d+\))?|timestamp(?:\(\d+\))? (?:with|without) time zone)(?:\[\])?$/.test(row.data_type)
    ? row.data_type : `sha256:${sha256(row.data_type)}`;
}
const column = row => ({ name: identifier(row.name), ordinal: row.ordinal, type: typeName(row),
  nullable: !row.not_null, default_sha256: row.default_definition == null ? null : sha256(row.default_definition),
  identity: ['', 'a', 'd'].includes(row.identity) ? row.identity : 'unknown',
  generated: ['', 's', 'v'].includes(row.generated) ? row.generated : 'unknown' });

// Every catalog scan is restricted to the fixed relation/function set and bounded in size.
const fromRelations = `FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace`;
const relationFilter = `n.nspname=$1 AND c.relname=ANY($2::text[])`;
export const SQL = freeze({
  begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  rollback: 'ROLLBACK',
  rowSecurity: 'SET LOCAL row_security = off',
  settings: `SELECT current_setting('default_transaction_read_only') AS startup_read_only,
    current_setting('transaction_read_only') AS read_only,
    current_setting('transaction_isolation') AS isolation,
    current_setting('statement_timeout') AS statement_timeout,
    current_setting('lock_timeout') AS lock_timeout,
    current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
    current_setting('search_path') AS search_path`,
  relations: `SELECT c.relname AS name, c.relkind AS kind, c.relpersistence AS persistence,
    c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls,
    pg_catalog.has_schema_privilege(n.oid,'USAGE') AS schema_usage,
    pg_catalog.has_table_privilege(c.oid,'SELECT') AS table_select
    ${fromRelations} WHERE ${relationFilter} ORDER BY c.relname COLLATE "C" LIMIT 1025`,
  columns: `SELECT c.relname AS relation, a.attname AS name, a.attnum AS ordinal,
    pg_catalog.format_type(a.atttypid,a.atttypmod) AS data_type, tn.nspname AS type_schema,
    a.attnotnull AS not_null, a.attidentity AS identity, a.attgenerated AS generated,
    pg_catalog.pg_get_expr(d.adbin,d.adrelid,false) AS default_definition
    ${fromRelations} JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid
    JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
    LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE ${relationFilter} AND a.attnum>0 AND NOT a.attisdropped
    ORDER BY c.relname COLLATE "C", a.attnum LIMIT 1025`,
  constraints: `SELECT c.relname AS relation, k.conname AS name, k.contype AS kind,
    k.convalidated AS validated, k.condeferrable AS deferrable, k.condeferred AS deferred,
    pg_catalog.pg_get_constraintdef(k.oid,false) AS definition
    ${fromRelations} JOIN pg_catalog.pg_constraint k ON k.conrelid=c.oid
    WHERE ${relationFilter} ORDER BY c.relname COLLATE "C", k.conname COLLATE "C" LIMIT 1025`,
  indexes: `SELECT c.relname AS relation, x.relname AS name, i.indisunique AS unique,
    i.indisvalid AS valid, i.indisready AS ready, i.indisprimary AS primary,
    pg_catalog.pg_get_indexdef(i.indexrelid,0,false) AS definition
    ${fromRelations} JOIN pg_catalog.pg_index i ON i.indrelid=c.oid
    JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid
    WHERE ${relationFilter} ORDER BY c.relname COLLATE "C", x.relname COLLATE "C" LIMIT 1025`,
  triggers: `SELECT c.relname AS relation, t.tgname AS name, t.tgenabled AS enabled,
    t.tgisinternal AS internal, pg_catalog.pg_get_triggerdef(t.oid,false) AS definition
    ${fromRelations} JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid
    WHERE ${relationFilter} ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C" LIMIT 1025`,
  policies: `SELECT c.relname AS relation, p.polname AS name, p.polcmd AS command,
    p.polpermissive AS permissive, pg_catalog.pg_get_expr(p.polqual,p.polrelid,false) AS using_definition,
    pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid,false) AS check_definition,
    ARRAY(SELECT CASE WHEN r=0 THEN 'public' ELSE pg_catalog.pg_get_userbyid(r) END
      FROM unnest(p.polroles) r ORDER BY 1) AS roles
    ${fromRelations} JOIN pg_catalog.pg_policy p ON p.polrelid=c.oid
    WHERE ${relationFilter} ORDER BY c.relname COLLATE "C", p.polname COLLATE "C" LIMIT 1025`,
  functions: `SELECT p.proname AS name, p.pronargs AS argument_count,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS signature,
    pg_catalog.pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname=ANY($1::text[]) AND p.prokind='f'
    ORDER BY p.proname COLLATE "C", pg_catalog.pg_get_function_identity_arguments(p.oid) COLLATE "C" LIMIT 1025`,
  savepoint: 'SAVEPOINT ledger_read',
  rollbackSavepoint: 'ROLLBACK TO SAVEPOINT ledger_read',
  releaseSavepoint: 'RELEASE SAVEPOINT ledger_read',
});

// Exact known column/type profiles. Unrecognized profiles never receive a data SELECT.
const profile = (shape, selected) => ({ shape, selected });
const drizzle = profile({ id: 'integer', hash: 'text', created_at: 'bigint' }, ['id', 'hash']);
export const LEDGERS = freeze([
  { schema: 'ezil_ci', name: 'baselines', profiles: [profile({ repository: 'text', project: 'text', schemas: 'jsonb',
    initial_catalog: 'text', snapshots: 'text', registered_at: 'timestamp with time zone' }, ['initial_catalog', 'snapshots'])] },
  { schema: 'ezil_ci', name: 'journal', profiles: [profile({ repository: 'text', id: 'text', checksum: 'text', ordinal: 'integer',
    before_catalog: 'text', after_catalog: 'text', applied_at: 'timestamp with time zone' },
  ['id', 'checksum', 'ordinal', 'before_catalog', 'after_catalog'])] },
  { schema: 'drizzle', name: '__drizzle_migrations', profiles: [drizzle] },
  { schema: 'public', name: '__drizzle_migrations', profiles: [drizzle] },
  { schema: 'public', name: 'schema_migrations', profiles: [
    profile({ version: 'bigint', dirty: 'boolean' }, ['version']),
    profile({ version: 'character varying' }, ['version']), profile({ version: 'text' }, ['version']),
  ] },
  { schema: 'public', name: 'ezil_staging_schema_log', profiles: [profile({ file: 'text', sha256: 'text', mode: 'text',
    applied_at: 'timestamp with time zone' }, ['file', 'sha256'])] },
]);
export function ledgerQueries(ledger, selectedProfile) {
  // Never accept caller-supplied identifiers, including from discovered columns.
  if (!LEDGERS.includes(ledger) || !ledger.profiles.includes(selectedProfile)) throw new Refusal('ledger_not_allowlisted');
  const relation = `"${ledger.schema}"."${ledger.name}"`;
  const columns = selectedProfile.selected.map(name => `"${name}"`).join(', ');
  return { count: `SELECT count(*)::text AS row_count FROM ONLY ${relation}`,
    rows: `SELECT ${columns} FROM ONLY ${relation} ORDER BY ${columns} LIMIT 257` };
}
function selectProfile(ledger, cols) {
  return ledger.profiles.find(p => cols.length === Object.keys(p.shape).length && cols.every(c =>
    Object.hasOwn(p.shape, c.name) && c.type_schema === 'pg_catalog' && p.shape[c.name] === c.data_type && !c.generated));
}
function ledgerRow(row, selectedProfile) {
  const result = {};
  for (const name of selectedProfile.selected) {
    const value = row[name];
    if (['hash', 'checksum', 'sha256', 'before_catalog', 'after_catalog', 'initial_catalog', 'snapshots'].includes(name)) {
      result[name] = checksum(value);
    } else if (name === 'ordinal' || name === 'version' || (name === 'id' && selectedProfile.shape.id === 'integer')) {
      result[name] = decimal(value) ?? { invalid_value_sha256: sha256(value) };
    } else result[name] = migrationIdentifier(value);
  }
  return result;
}
function definitionObject(row, fields) {
  return { name: identifier(row.name), ...Object.fromEntries(fields.map(f => [f, row[f]])),
    definition_sha256: sha256(row.definition) };
}

export async function collectEvidence(query, mode, env) {
  const source = validateSource(mode, env);
  let queryCount = 0;
  const deadline = Date.now() + LIMITS.wallMs;
  const q = async (sql, params = []) => {
    if (++queryCount > LIMITS.queries || Date.now() > deadline) throw new Refusal('probe_bound_exceeded');
    const rows = await query(sql, params);
    if (rows.length > LIMITS.catalogRows) throw new Refusal('catalog_row_bound_exceeded');
    return rows;
  };
  // Raw error messages, rows, and definitions must never cross this module's output boundary.
  const report = { version: 1, mode, source_sha: source, status: 'observed',
    expected_sql_file_sha256: PINNED_SQL, tables: [], functions: [], ledgers: [], gates: [] };
  await q(SQL.begin);
  try {
    await q(SQL.rowSecurity);
    const [settings] = await q(SQL.settings);
    if (!settings || settings.startup_read_only !== 'on' || settings.read_only !== 'on' ||
        settings.isolation !== 'repeatable read' || !['3s', '3000ms'].includes(settings.statement_timeout) ||
        !['1s', '1000ms'].includes(settings.lock_timeout) || !['5s', '5000ms'].includes(settings.idle_timeout) ||
        settings.search_path !== 'pg_catalog') throw new Refusal('session_contract_mismatch');
    const parts = {};
    for (const key of ['relations', 'columns', 'constraints', 'indexes', 'triggers', 'policies']) {
      parts[key] = await q(SQL[key], ['public', TABLES]);
    }
    for (const name of TABLES) {
      const relation = parts.relations.find(r => r.name === name);
      if (!relation) { report.tables.push({ name, status: 'absent' }); continue; }
      const table = { name, status: ['r', 'p'].includes(relation.kind) ? 'present' : 'unexpected_relation_kind',
        kind: identifier(relation.kind), rls: relation.rls, force_rls: relation.force_rls,
        columns: parts.columns.filter(r => r.relation === name).map(column),
        constraints: parts.constraints.filter(r => r.relation === name)
          .map(r => definitionObject(r, ['kind', 'validated', 'deferrable', 'deferred'])),
        indexes: parts.indexes.filter(r => r.relation === name)
          .map(r => definitionObject(r, ['unique', 'valid', 'ready', 'primary'])),
        triggers: parts.triggers.filter(r => r.relation === name)
          .map(r => definitionObject(r, ['enabled', 'internal'])),
        policies: parts.policies.filter(r => r.relation === name).map(r => ({ name: identifier(r.name),
          definition_sha256: sha256(JSON.stringify([r.command, r.permissive, r.using_definition, r.check_definition, r.roles])) })),
      };
      table.counts = Object.fromEntries(['columns', 'constraints', 'indexes', 'triggers', 'policies'].map(k => [k, table[k].length]));
      table.structural_sha256 = sha256(JSON.stringify(table));
      report.tables.push(table);
      if (table.status !== 'present') report.gates.push({ object: name, gate: table.status });
    }
    const functions = await q(SQL.functions, [FUNCTIONS]);
    for (const name of FUNCTIONS) {
      const matches = functions.filter(r => r.name === name).map(r => ({ argument_count: r.argument_count,
        signature_sha256: sha256(r.signature), definition_sha256: sha256(r.definition) }));
      report.functions.push({ name, status: matches.length ? 'present' : 'absent', count: matches.length, definitions: matches });
    }
    report.catalog_sha256 = sha256(JSON.stringify([report.tables, report.functions]));
    for (const ledger of LEDGERS) {
      const label = `${ledger.schema}.${ledger.name}`;
      const [relation] = await q(SQL.relations, [ledger.schema, [ledger.name]]);
      if (!relation) { report.ledgers.push({ name: label, status: 'absent' }); continue; }
      const cols = await q(SQL.columns, [ledger.schema, [ledger.name]]);
      const result = { name: label, columns: cols.map(column), rls: relation.rls, force_rls: relation.force_rls };
      const matched = selectProfile(ledger, cols);
      if (!matched || relation.kind !== 'r' || relation.persistence !== 'p') {
        Object.assign(result, { status: 'unknown_shape', gate: 'ledger_shape_not_allowlisted' });
      } else if (!relation.schema_usage || !relation.table_select) {
        Object.assign(result, { status: 'inaccessible', gate: !relation.schema_usage ? 'schema_usage_denied' : 'table_select_denied', sqlstate: '42501' });
      } else {
        const queries = ledgerQueries(ledger, matched);
        await q(SQL.savepoint);
        try {
          const [count] = await q(queries.count);
          result.row_count = decimal(count?.row_count);
          if (result.row_count === null) throw new Refusal('invalid_ledger_count');
          const rows = await q(queries.rows);
          result.status = rows.length > LIMITS.ledgerRows ? 'bounded' : 'readable';
          if (result.status === 'bounded') result.gate = 'ledger_row_bound_exceeded';
          result.rows = rows.slice(0, LIMITS.ledgerRows).map(r => ledgerRow(r, matched));
          result.returned_count = result.rows.length;
        } catch (error) {
          await q(SQL.rollbackSavepoint);
          Object.assign(result, sanitizedError(error));
        }
        await q(SQL.releaseSavepoint);
      }
      report.ledgers.push(result);
      if (result.gate) report.gates.push({ object: label, gate: result.gate, ...(result.sqlstate ? { sqlstate: result.sqlstate } : {}) });
    }
    if (!report.ledgers.some(l => l.status === 'readable' && l.row_count !== '0')) {
      report.gates.push({ gate: 'ledger_receipts_unavailable' });
    }
    if (report.gates.length) report.status = 'incomplete';
    report.counts = { tables_present: report.tables.filter(t => t.status === 'present').length,
      functions_present: report.functions.reduce((n, f) => n + f.count, 0), ledger_candidates: LEDGERS.length };
    return report;
  } finally {
    // Bypass query/deadline counters for mandatory cleanup; never COMMIT.
    await query(SQL.rollback, []);
  }
}

export async function runPreflight({ mode, env = process.env, cwd = process.cwd(), postgresFactory } = {}) {
  validateSource(mode, env); // Refuse before loading driver or accessing the connection value.
  if (!env.SUPABASE_DATABASE_URL) throw new Refusal('database_url_missing');
  const postgres = postgresFactory ?? createRequire(resolve(cwd, 'parity-schema-preflight-loader.cjs'))('postgres');
  const sql = postgres(env.SUPABASE_DATABASE_URL, { max: 1, prepare: false, connect_timeout: 5,
    idle_timeout: 2, max_lifetime: 60, connection: { ...STARTUP },
    onnotice: () => {}, debug: false });
  let connection;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        connection = await sql.reserve();
        return collectEvidence((statement, params) => connection.unsafe(statement, params), mode, env);
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Refusal('wall_timeout')), LIMITS.wallMs); }),
    ]);
  } finally {
    clearTimeout(timer);
    // end closes the reserved connection too, rolling back any interrupted transaction.
    await sql.end({ timeout: 1 });
  }
}

export async function main(args = process.argv.slice(2)) {
  try {
    if (args.length !== 1) throw new Refusal('mode_required');
    const report = await runPreflight({ mode: args[0] });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (report.status === 'incomplete') process.exitCode = 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(sanitizedError(error))}\n`);
    process.exitCode = 1;
  }
}
const entry = process.argv[1];
if ((entry === '-' && fileURLToPath(import.meta.url) === resolve('[eval1]')) ||
    (entry && entry !== '-' && fileURLToPath(import.meta.url) === resolve(entry))) await main();
