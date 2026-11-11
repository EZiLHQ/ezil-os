#!/usr/bin/env node
// PROPOSAL, NOT EXECUTED, NOT WIRED to any startup, deploy or migrate step. Needs its own independent review before anyone runs it.
// Applies ONLY migrations/sponsor/0001_sponsor_attribution.sql, and only after preflight.sql passes AND (for an existing schema) verify.sql proves the exact
// owned objects are structurally identical to the pinned fingerprint. Never reads drizzle/, its journal or any other migration; never advances any journal;
// never runs on startup; never touches 0022-0025.
//
//   preflight (default, read-only):  SPONSOR_DB_URL=... node run-sponsor-schema.mjs --target-id <cluster system identifier> --database <name> --user <role>
//   apply:                           SPONSOR_DB_URL=... node run-sponsor-schema.mjs --target-id <id> --database <name> --user <role> --apply --yes --sql-sha256 <hex> --preflight-sha256 <hex>
// The target is pinned by cluster system identifier AND exact current_database() AND exact current_user and session_user: there are no defaults, and a different
// database or role in the same cluster is refused before anything is read or written.
//
// The URL is read from the environment variable named by --url-env (default SPONSOR_DB_URL) and is never printed. Output is a JSON receipt of digests,
// booleans and counts only. Exit 0 = preflight ok / applied and verified / already present and identical; 2 = refused or drifted; 1 = unexpected failure.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Frozen with this review: the runner refuses any other bytes, whatever the flags say. `fingerprints` is per server MAJOR version (definitions are rendered by
// the server, so a major not listed here is refused until a review adds it).
export const PINNED = Object.freeze({
  sql: 'fbe54baee38f8032e727785b012e6e59f4fd65fa19b8c7c38d21c3eb85af7167', preflight: '8c8ab1fe27528052c4a6bd5d102321c38ae46db25417062d287e01000905196b', verify: 'f849ad0bbe24d33ac06180d521d1f0e2cd71d5b676049f2d5b2fff0cd356df85',
  sqlFile: '0001_sponsor_attribution.sql', preflightFile: 'preflight.sql', verifyFile: 'verify.sql',
  fingerprints: Object.freeze({ 17: 'f9d41184e183ed1f082859c9deaae75997d3d29b5827fcacc7b01ef0d601a4ef' }), fingerprintLines: 55,
});
const LOCK_KEY = 'ezil:sponsor:schema:0001';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
class Refusal extends Error { constructor(code) { super(code); this.code = code; } }
const refuse = code => { throw new Refusal(code); };

// The EXACT preflight rows: nine unique known names, one of them the state row. Anything else (empty, missing, duplicate, unknown, extra) is refused.
export const FIXED_CHECKS = Object.freeze([
  '0021 trials table exists', 'trials.id is a uuid primary key', 'trials has its 0021 identity uniques', 'trials has row level security on',
  'auth.role() exists', 'roles anon and authenticated exist', 'no sponsor object exists (absent) or the full set does (present)', 'no pending ordered objects are required or touched',
]);
const STATE_ROWS = Object.freeze({ 'sponsor schema state is absent': 'absent', 'sponsor schema state is present': 'present' });

export function parseArgs(argv) {
  const out = { apply: false, yes: false, urlEnv: 'SPONSOR_DB_URL' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => (i + 1 < argv.length ? argv[++i] : refuse('missing_value_for_' + a));
    if (a === '--apply') out.apply = true;
    else if (a === '--yes') out.yes = true;
    else if (a === '--target-id') out.targetId = next();
    else if (a === '--database') out.database = next();
    else if (a === '--user') out.user = next();
    else if (a === '--sql-sha256') out.sqlSha = next();
    else if (a === '--preflight-sha256') out.preflightSha = next();
    else if (a === '--url-env') out.urlEnv = next();
    else refuse('unknown_argument');
  }
  if (!/^[0-9]{10,25}$/.test(out.targetId ?? '')) refuse('target_system_identifier_required');
  if (!/^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/.test(out.database ?? '')) refuse('target_database_required');
  if (!/^[A-Za-z_][A-Za-z0-9_$.-]{0,62}$/.test(out.user ?? '')) refuse('target_user_required');
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(out.urlEnv)) refuse('invalid_url_env_name');
  if (out.apply && (!out.yes || out.sqlSha !== PINNED.sql || out.preflightSha !== PINNED.preflight)) refuse('apply_requires_yes_and_both_exact_file_hashes');
  return out;
}

/** Reads the three files, refusing any byte that is not the pinned one. */
export async function loadPinned(read = readFile, dir = HERE) {
  const [sql, preflight, verify] = await Promise.all([PINNED.sqlFile, PINNED.preflightFile, PINNED.verifyFile].map(name => read(join(dir, name))));
  if (sha(sql) !== PINNED.sql) refuse('sql_file_differs_from_pin');
  if (sha(preflight) !== PINNED.preflight) refuse('preflight_file_differs_from_pin');
  if (sha(verify) !== PINNED.verify) refuse('verify_file_differs_from_pin');
  return { sql: sql.toString('utf8'), preflight: preflight.toString('utf8'), verify: verify.toString('utf8') };
}

/**
 * Pure decision over the preflight rows and (when the schema is present) the structural check. STRICT: the rows must be exactly the nine known names, each once,
 * exactly one state row, every `ok` literally true. `structure` is `{ matches: boolean }` for a present schema and ignored for an absent one.
 */
export function decide(rows, structure = null) {
  if (!Array.isArray(rows) || rows.length !== FIXED_CHECKS.length + 1) return { action: 'refuse', state: 'unknown', failed: ['preflight_rows_not_exactly_the_known_set'] };
  const names = rows.map(r => r?.check_name);
  if (new Set(names).size !== names.length) return { action: 'refuse', state: 'unknown', failed: ['duplicate_preflight_rows'] };
  const stateRows = rows.filter(r => typeof r?.check_name === 'string' && Object.hasOwn(STATE_ROWS, r.check_name));
  if (stateRows.length !== 1) return { action: 'refuse', state: 'unknown', failed: ['not_exactly_one_state_row'] };
  const unknown = rows.filter(r => !FIXED_CHECKS.includes(r?.check_name) && r !== stateRows[0]);
  if (unknown.length) return { action: 'refuse', state: 'unknown', failed: ['unknown_preflight_row'] };
  const state = STATE_ROWS[stateRows[0].check_name];
  const failed = rows.filter(r => r.ok !== true).map(r => r.check_name);
  if (failed.length) return { action: 'refuse', state, failed };
  if (state === 'absent') return { action: 'apply', state, failed: [] };
  // Present: only an exact structural match is a no-op; any drift (RLS, ACL, constraints, indexes, triggers, policies, functions, columns) refuses.
  return structure && structure.matches === true ? { action: 'noop', state, failed: [] } : { action: 'refuse', state, failed: ['schema_drift_from_pinned_fingerprint'] };
}

/** Runs preflight.sql (and verify.sql) in ONE read-only repeatable-read transaction with a fixed search_path; returns the rows and the structure result. */
export async function inspect(sql, files) {
  let preRows, verRows, major;
  await sql.begin('isolation level repeatable read read only', async tx => {
    await tx`set local search_path = pg_catalog`;
    major = Math.floor(Number((await tx`show server_version_num`)[0].server_version_num) / 10000);
    preRows = await tx.unsafe(files.preflight);
    verRows = await tx.unsafe(files.verify);
  });
  const rows = preRows.map(r => ({ check_name: String(r.check_name), ok: r.ok === true }));
  const pinned = PINNED.fingerprints[major];
  const present = rows.some(r => r.check_name === 'sponsor schema state is present');
  const matches = pinned !== undefined && verRows?.length === 1 && verRows[0].fingerprint === pinned && verRows[0].lines === PINNED.fingerprintLines;
  if (present && pinned === undefined) refuse('no_pinned_fingerprint_for_server_major');
  return { rows, structure: { matches }, major };
}

export async function main({ argv, env, connect, read = readFile, dir = HERE }) {
  const args = parseArgs(argv);
  const files = await loadPinned(read, dir);
  const url = env[args.urlEnv];
  if (!url) refuse('database_url_env_not_set');
  const sql = await connect(url);
  try {
    const [who] = await sql`select (select system_identifier::text from pg_control_system()) as id, current_database()::text as db, current_user::text as cu, session_user::text as su`;
    if (who.id !== args.targetId) refuse('target_system_identifier_mismatch');
    if (who.db !== args.database) refuse('target_database_mismatch');
    if (who.cu !== args.user || who.su !== args.user) refuse('target_user_mismatch');
    const first = await inspect(sql, files), before = decide(first.rows, first.structure);
    const receipt = { schema: 'ezil-sponsor-schema-receipt-v1', mode: args.apply ? 'apply' : 'preflight', serverMajor: first.major, sqlSha256: PINNED.sql, preflightSha256: PINNED.preflight,
      verifySha256: PINNED.verify, before: before.state, failedChecks: before.failed.length };
    if (before.action === 'refuse') { receipt.result = before.failed.includes('schema_drift_from_pinned_fingerprint') ? 'refused_schema_drift' : 'refused_preflight'; receipt.failed = before.failed; return { code: 2, receipt }; }
    if (!args.apply) { receipt.result = before.action === 'noop' ? 'present_identical_no_action_needed' : 'ready_to_apply'; return { code: 0, receipt }; }
    if (before.action === 'noop') { receipt.result = 'already_present_identical'; receipt.after = 'present'; return { code: 0, receipt }; }
    // One advisory lock, a re-inspection under it, then exactly the pinned SQL (it carries its own BEGIN/COMMIT), then a postflight that must match the fingerprint.
    const [{ locked }] = await sql`select pg_try_advisory_lock(hashtextextended(${LOCK_KEY}, 0)) as locked`;
    if (!locked) refuse('another_runner_holds_the_lock');
    let applyError = null, afterInspect;
    try {
      const recheck = await inspect(sql, files);
      if (decide(recheck.rows, recheck.structure).action !== 'apply') refuse('schema_changed_under_the_lock');
      try { await sql.unsafe(files.sql); } catch (error) { applyError = error?.code ?? 'apply_failed'; }
      // Uncertain-apply recovery, STILL under the lock: whatever happened (success, error, dropped connection), the only truth is a fresh catalog inspection.
      afterInspect = await inspect(sql, files);
    } finally { await sql`select pg_advisory_unlock(hashtextextended(${LOCK_KEY}, 0))`; }
    const after = decide(afterInspect.rows, afterInspect.structure);
    receipt.after = after.state;
    if (after.action === 'noop') { receipt.result = applyError ? 'apply_reported_error_but_schema_present_and_identical' : 'applied_and_verified'; if (applyError) receipt.applyError = String(applyError); return { code: 0, receipt }; }
    receipt.result = after.state === 'absent' && applyError ? 'apply_failed_nothing_changed' : 'applied_but_postflight_failed_or_drifted';
    if (applyError) receipt.applyError = String(applyError);
    receipt.failed = after.failed;
    return { code: 2, receipt };
  } finally { await sql.end?.({ timeout: 5 }); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { default: postgres } = await import('postgres');
  main({ argv: process.argv.slice(2), env: process.env, connect: async url => postgres(url, { max: 1, prepare: false, onnotice: () => undefined, connect_timeout: 10 }) })
    .then(({ code, receipt }) => { process.stdout.write(JSON.stringify(receipt) + '\n'); process.exitCode = code; })
    .catch(error => { process.stdout.write(JSON.stringify({ result: error instanceof Refusal ? 'refused' : 'failed', code: error instanceof Refusal ? error.code : 'unexpected_error' }) + '\n'); process.exitCode = error instanceof Refusal ? 2 : 1; });
}
