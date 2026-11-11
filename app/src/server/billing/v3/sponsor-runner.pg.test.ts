/**
 * The sponsor schema RUNNER (migrations/sponsor/run-sponsor-schema.mjs, a proposal, never run against a real database), exercised as the ACTUAL module:
 * strict preflight decisions, exact target pins (cluster + database + user), a hostile search_path, the structural fingerprint against deliberate drift, the
 * identical-schema no-op, and uncertain-apply recovery. The disposable half runs on its own throwaway databases on the disposable server and needs
 * BILLING_TEST_DATABASE_URL; the rest is offline. Every assertion about a database is made over a connection to THAT database, never the admin one.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapSponsorFixture } from './sponsor-fixture';
import * as runnerModule from '../../../../migrations/sponsor/run-sponsor-schema.mjs';

/* eslint-disable @typescript-eslint/no-explicit-any -- the runner is a plain ES module; this is its public surface as the tests use it */
interface Runner {
    main(options: { argv: string[]; env: Record<string, string | undefined>; connect: (url: string) => Promise<any>; read?: (path: string) => Promise<Buffer>; dir?: string }): Promise<{ code: number; receipt: Record<string, any> }>;
    PINNED: Record<string, any>; FIXED_CHECKS: readonly string[];
    parseArgs(argv: string[]): Record<string, any>; decide(rows: unknown, structure?: unknown): Record<string, any>;
    loadPinned(read?: (path: string) => Promise<Buffer>, dir?: string): Promise<Record<string, string>>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
const { main, PINNED, FIXED_CHECKS, parseArgs, decide, loadPinned } = runnerModule as unknown as Runner;

const DIR = resolve(__dirname, '../../../../migrations/sponsor');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const refusal = async (fn: () => unknown) => { try { await fn(); return 'no_refusal'; } catch (e) { return (e as { code?: string }).code ?? 'unexpected'; } };
const rows = (over: Record<string, boolean | undefined> = {}, state = 'absent') => [...FIXED_CHECKS.map((check_name: string) => ({ check_name, ok: Object.hasOwn(over, check_name) ? over[check_name] : true })),
    { check_name: `sponsor schema state is ${state}`, ok: true }];

describe('runner pins, arguments and strict decisions (offline, the actual module)', () => {
    it('the three pinned hashes are the bytes on disk', async () => {
        for (const [file, pin] of [[PINNED.sqlFile, PINNED.sql], [PINNED.preflightFile, PINNED.preflight], [PINNED.verifyFile, PINNED.verify]]) expect(sha(await readFile(resolve(DIR, file)))).toBe(pin);
    });
    it('every target pin and the exact hashes are required; nothing defaults', () => {
        const base = ['--target-id', '1234567890', '--database', 'ezil_staging', '--user', 'postgres'];
        expect(parseArgs(base)).toMatchObject({ apply: false, database: 'ezil_staging', user: 'postgres' });
        const code = (argv: string[]) => { try { parseArgs(argv); return 'ok'; } catch (e) { return (e as { code: string }).code; } };
        expect(code([])).toBe('target_system_identifier_required');
        expect(code(['--target-id', 'abc', '--database', 'd', '--user', 'u'])).toBe('target_system_identifier_required');
        expect(code(['--target-id', '1234567890', '--user', 'postgres'])).toBe('target_database_required');
        expect(code(['--target-id', '1234567890', '--database', 'd'])).toBe('target_user_required');
        expect(code(['--target-id', '1234567890', '--database', 'd;drop', '--user', 'u'])).toBe('target_database_required');
        expect(code([...base, '--wat'])).toBe('unknown_argument');
        expect(code([...base, '--apply'])).toBe('apply_requires_yes_and_both_exact_file_hashes');
        expect(code([...base, '--apply', '--yes', '--sql-sha256', PINNED.sql])).toBe('apply_requires_yes_and_both_exact_file_hashes');
        expect(code([...base, '--apply', '--yes', '--sql-sha256', 'f'.repeat(64), '--preflight-sha256', PINNED.preflight])).toBe('apply_requires_yes_and_both_exact_file_hashes');
        expect(code([...base, '--apply', '--yes', '--sql-sha256', PINNED.sql, '--preflight-sha256', PINNED.preflight])).toBe('ok');
        expect(code([...base, '--url-env', 'lower'])).toBe('invalid_url_env_name');
    });
    it('refuses any of the three files whose bytes differ from the pin', async () => {
        const tamper = (name: string) => async (path: string) => { const b = await readFile(path); return path.endsWith(name) ? Buffer.concat([b, Buffer.from('\n-- x\n')]) : b; };
        expect(await refusal(() => loadPinned(tamper(PINNED.sqlFile), DIR))).toBe('sql_file_differs_from_pin');
        expect(await refusal(() => loadPinned(tamper(PINNED.preflightFile), DIR))).toBe('preflight_file_differs_from_pin');
        expect(await refusal(() => loadPinned(tamper(PINNED.verifyFile), DIR))).toBe('verify_file_differs_from_pin');
    });
    it('decide is strict: the exact nine unique known rows, one state, every ok literally true; empty, missing, state-only, duplicate or unknown rows never reach DDL', () => {
        const match = { matches: true };
        expect(decide(rows())).toMatchObject({ action: 'apply', state: 'absent' });
        expect(decide(rows({}, 'present'), match)).toMatchObject({ action: 'noop', state: 'present' });
        const refused = (r: unknown, s: unknown = null) => (decide(r as never, s as never) as { action: string }).action === 'refuse';
        expect(refused([])).toBe(true); expect(refused(undefined)).toBe(true); expect(refused(null)).toBe(true); expect(refused({})).toBe(true);
        expect(refused([{ check_name: 'sponsor schema state is absent', ok: true }])).toBe(true);                         // state-only
        expect(refused(rows().slice(0, -1))).toBe(true);                                                                   // no state row
        expect(refused(rows().slice(1))).toBe(true);                                                                       // a fixed check missing
        expect(refused([...rows(), { check_name: 'extra', ok: true }])).toBe(true);
        expect(refused([...rows().slice(0, -1), { check_name: 'unknown check', ok: true }, { check_name: 'sponsor schema state is absent', ok: true }])).toBe(true);
        expect(refused([...rows().slice(0, -1), rows()[0], { check_name: 'sponsor schema state is absent', ok: true }])).toBe(true);   // duplicate row
        expect(refused([...rows().slice(1), { check_name: 'sponsor schema state is absent', ok: true }, { check_name: 'sponsor schema state is present', ok: true }])).toBe(true);   // contradictory states
        for (const bad of [false, undefined, 'true', 1, null]) expect(refused(rows({ [FIXED_CHECKS[0]]: bad as never }))).toBe(true);
        expect(refused(rows({}, 'present'))).toBe(true); expect(refused(rows({}, 'present'), { matches: false })).toBe(true); expect(refused(rows({}, 'present'), {})).toBe(true);
        expect(refused(rows({ [FIXED_CHECKS[6]]: false }, 'present'), match)).toBe(true);                                 // a failed check beats a matching fingerprint
        expect(decide(rows({}, 'present'), { matches: false })).toMatchObject({ failed: ['schema_drift_from_pinned_fingerprint'] });
    });
});

/** A scripted fake of the postgres.js surface the runner uses, to test uncertain-apply recovery and lock ordering without a database. */
function fake(script: { inspections: { rows: ReturnType<typeof rows>; fingerprint?: string }[]; applyError?: string }) {
    const calls: string[] = [];
    let inspection = 0;
    const text = (strings: TemplateStringsArray) => strings.join('?');
    const route = (t: string) => {
        if (t.includes('pg_control_system')) return [{ id: '1234567890', db: 'd', cu: 'u', su: 'u' }];
        if (t.includes('pg_try_advisory_lock')) { calls.push('lock'); return [{ locked: true }]; }
        if (t.includes('pg_advisory_unlock')) { calls.push('unlock'); return []; }
        if (t.includes('show server_version_num')) return [{ server_version_num: '170000' }];
        return [];
    };
    const tagger = () => (strings: TemplateStringsArray) => Promise.resolve(route(text(strings)));   // a distinct function per object: tx.unsafe must not overwrite sql.unsafe
    const sql = Object.assign(tagger(), {
        begin: async (_o: string, fn: (tx: unknown) => Promise<void>) => {
            const current = script.inspections[Math.min(inspection, script.inspections.length - 1)]!;
            inspection++; calls.push('inspect');
            const tx = Object.assign(tagger(), { unsafe: async (t: string) => (t.includes('sponsor schema state') ? current.rows : [{ fingerprint: current.fingerprint ?? PINNED.fingerprints[17], lines: PINNED.fingerprintLines }]) });
            await fn(tx);
        },
        unsafe: async () => { calls.push('apply'); if (script.applyError) throw Object.assign(new Error('boom'), { code: script.applyError }); return []; },
        end: async () => undefined,
    });
    return { sql, calls };
}
describe('uncertain-apply recovery and lock ordering (scripted fake, actual module)', () => {
    const argv = ['--target-id', '1234567890', '--database', 'd', '--user', 'u', '--apply', '--yes', '--sql-sha256', PINNED.sql, '--preflight-sha256', PINNED.preflight];
    const go = (script: Parameters<typeof fake>[0]) => { const f = fake(script); return main({ argv, env: { SPONSOR_DB_URL: 'x' }, connect: async () => f.sql, dir: DIR }).then(r => ({ ...r, calls: f.calls })); };
    it('the postflight inspection runs BEFORE the advisory lock is released', async () => {
        const r = await go({ inspections: [{ rows: rows() }, { rows: rows() }, { rows: rows({}, 'present') }] });
        expect(r.receipt.result).toBe('applied_and_verified'); expect(r.code).toBe(0);
        expect(r.calls).toEqual(['inspect', 'lock', 'inspect', 'apply', 'inspect', 'unlock']);
    });
    it('an apply error with the schema then present and identical is verified, never assumed; with nothing changed it is reported as such', async () => {
        const a = await go({ inspections: [{ rows: rows() }, { rows: rows() }, { rows: rows({}, 'present') }], applyError: '57P01' });
        expect(a.receipt.result).toBe('apply_reported_error_but_schema_present_and_identical'); expect(a.code).toBe(0);
        const b = await go({ inspections: [{ rows: rows() }, { rows: rows() }, { rows: rows() }], applyError: '40001' });
        expect(b.receipt.result).toBe('apply_failed_nothing_changed'); expect(b.code).toBe(2);
    });
    it('a postflight that does not match the fingerprint is a failure, and the schema changing under the lock aborts before any DDL', async () => {
        const drift = await go({ inspections: [{ rows: rows() }, { rows: rows() }, { rows: rows({}, 'present'), fingerprint: 'e'.repeat(64) }] });
        expect(drift.receipt.result).toBe('applied_but_postflight_failed_or_drifted'); expect(drift.code).toBe(2);
        const changed = await refusal(() => go({ inspections: [{ rows: rows() }, { rows: rows({}, 'present') }] }));
        expect(changed).toBe('schema_changed_under_the_lock');
    });
});

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('runner against disposable databases (never a real one)', () => {
    const ADMIN = process.env.BILLING_TEST_DATABASE_URL!;
    const suffix = randomUUID().slice(0, 8), DB = `sponsor_runner_${suffix}`, OTHER = `sponsor_runner_other_${suffix}`;
    let admin: ReturnType<typeof postgres>, probe: ReturnType<typeof postgres>, url: string, otherUrl: string, sysId: string, user: string;
    const swap = (db: string) => ADMIN.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
    const connect = async (u: string) => postgres(u, { max: 1, prepare: false, onnotice: () => undefined });
    const pins = () => ['--target-id', sysId, '--database', DB, '--user', user];
    const apply = () => [...pins(), '--apply', '--yes', '--sql-sha256', PINNED.sql, '--preflight-sha256', PINNED.preflight];
    const run = (argv: string[], target = url, extra: Record<string, unknown> = {}) => main({ argv, env: { SPONSOR_DB_URL: target }, connect, dir: DIR, ...extra });
    const objects = async () => (await probe.unsafe(`select 1 from pg_class where relkind = 'r' and relname like 'ezil_sponsor_%'`)).length;
    beforeAll(async () => {
        admin = postgres(ADMIN, { max: 1, prepare: false, onnotice: () => undefined });
        for (const db of [DB, OTHER]) await admin.unsafe(`create database ${db}`);
        [url, otherUrl] = [swap(DB), swap(OTHER)];
        await bootstrapSponsorFixture(url, { applySponsor: false });
        await bootstrapSponsorFixture(otherUrl, { applySponsor: false });
        const [who] = await admin`select (select system_identifier::text from pg_control_system()) as id, current_user::text as u`;
        sysId = who!.id as string; user = who!.u as string;
        probe = postgres(url, { max: 1, prepare: false, onnotice: () => undefined });   // a connection to the RUNNER's target database, for assertions only
    });
    afterAll(async () => { await probe?.end(); for (const db of [DB, OTHER]) await admin?.unsafe(`drop database if exists ${db} with (force)`); await admin?.end(); });

    it('preflight is read-only: ready_to_apply on a 0021-only database, nothing created, the URL never in the receipt', async () => {
        const { code, receipt } = await run(pins());
        expect(receipt).toMatchObject({ mode: 'preflight', before: 'absent', result: 'ready_to_apply', failedChecks: 0, serverMajor: 17 }); expect(code).toBe(0);
        expect(JSON.stringify(receipt)).not.toContain('postgres://'); expect(await objects()).toBe(0);
    });
    it('refuses a wrong cluster, a same-cluster wrong DATABASE, a wrong USER and a missing URL, each before anything is read or written', async () => {
        expect(await refusal(() => run(['--target-id', '9999999999999999', '--database', DB, '--user', user]))).toBe('target_system_identifier_mismatch');
        expect(await refusal(() => run(pins(), otherUrl))).toBe('target_database_mismatch');                      // same cluster, the OTHER database
        expect(await refusal(() => run(['--target-id', sysId, '--database', DB, '--user', 'nobody']))).toBe('target_user_mismatch');
        expect(await refusal(() => main({ argv: pins(), env: {}, connect, dir: DIR }))).toBe('database_url_env_not_set');
        expect(await refusal(() => run(apply().slice(0, -2)))).toBe('apply_requires_yes_and_both_exact_file_hashes');
        expect(await objects()).toBe(0);
        const o = postgres(otherUrl, { max: 1, prepare: false }); expect((await o`select to_regclass('public.ezil_sponsor_attributions') as t`)[0]!.t).toBeNull(); await o.end();
    });
    it('a hostile search_path (a writable schema first) cannot receive any object: everything lands in public and is verified', async () => {
        await probe.unsafe(`create schema hostile`);
        await admin.unsafe(`alter database ${DB} set search_path = hostile, public`);
        try {
            expect((await run(apply())).receipt.result).toBe('applied_and_verified');
            expect((await probe.unsafe(`select count(*)::int as n from pg_class where relnamespace = 'hostile'::regnamespace`))[0]!.n).toBe(0);
            expect((await probe.unsafe(`select count(*)::int as n from pg_proc where pronamespace = 'hostile'::regnamespace`))[0]!.n).toBe(0);
            expect((await probe.unsafe(`select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'ezil_sponsor_%'`))[0]!.n).toBe(2);
        } finally {
            await admin.unsafe(`alter database ${DB} reset search_path`);
            await probe.unsafe(`drop table if exists public.ezil_sponsor_trial_claims, public.ezil_sponsor_attributions cascade; drop function if exists public.ezil_sponsor_attribution_guard(), public.ezil_sponsor_trial_claim_guard(); drop schema hostile cascade`);
        }
        expect(await objects()).toBe(0);
    });
    it('refuses a partial schema (only a table, or only a function) and applies nothing more', async () => {
        await probe.unsafe(`create table public.ezil_sponsor_attributions (account_key uuid primary key)`);
        const a = await run(apply()); expect(a.code).toBe(2); expect(a.receipt.result).toBe('refused_preflight'); expect(await objects()).toBe(1);
        await probe.unsafe(`drop table public.ezil_sponsor_attributions; create function public.ezil_sponsor_attribution_guard() returns trigger language plpgsql as 'begin return new; end'`);
        const b = await run(apply()); expect(b.code).toBe(2); expect(b.receipt.result).toBe('refused_preflight'); expect(await objects()).toBe(0);
        await probe.unsafe(`drop function public.ezil_sponsor_attribution_guard()`);
    });
    it('applies exactly the pinned SQL once and verifies the fingerprint; a second run and a preflight are identical-schema no-ops', async () => {
        const first = await run(apply());
        expect(first.receipt).toMatchObject({ mode: 'apply', before: 'absent', after: 'present', result: 'applied_and_verified' }); expect(first.code).toBe(0);
        expect(await objects()).toBe(2);
        expect((await run(apply())).receipt).toMatchObject({ before: 'present', result: 'already_present_identical' });
        expect((await run(pins())).receipt).toMatchObject({ before: 'present', result: 'present_identical_no_action_needed' });
    });
    it('any structural drift is refused (never a no-op, never an apply): RLS, ACL, index, column, constraint, trigger, policy and function changes', async () => {
        const T = 'public.ezil_sponsor_trial_claims', A = 'public.ezil_sponsor_attributions';
        const drifts: [string, string, string][] = [
            ['rls disabled', `alter table ${A} disable row level security`, `alter table ${A} enable row level security`],
            ['rls forced', `alter table ${A} force row level security`, `alter table ${A} no force row level security`],
            ['anon can read', `grant select on ${T} to anon`, `revoke select on ${T} from anon`],
            ['public can write', `grant insert on ${A} to public`, `revoke insert on ${A} from public`],
            ['extra index', `create index drift_idx on ${T} (config_sha256)`, `drop index public.drift_idx`],
            ['extra column', `alter table ${A} add column drift int`, `alter table ${A} drop column drift`],
            ['constraint dropped', `alter table ${A} drop constraint ezil_sponsor_attributions_config_chk`, `alter table ${A} add constraint ezil_sponsor_attributions_config_chk check (config_sha256 ~ '^[0-9a-f]{64}$')`],
            ['constraint weakened', `alter table ${A} drop constraint ezil_sponsor_attributions_campaign_chk, add constraint ezil_sponsor_attributions_campaign_chk check (true)`,
                `alter table ${A} drop constraint ezil_sponsor_attributions_campaign_chk, add constraint ezil_sponsor_attributions_campaign_chk check (campaign_id ~ '^[a-z0-9][a-z0-9_-]{2,63}$')`],
            ['trigger disabled', `alter table ${A} disable trigger ezil_sponsor_attribution_guard`, `alter table ${A} enable trigger ezil_sponsor_attribution_guard`],
            ['policy replaced', `drop policy "Service role full access sponsor attributions" on ${A}; create policy "Service role full access sponsor attributions" on ${A} for all using (true)`,
                `drop policy "Service role full access sponsor attributions" on ${A}; create policy "Service role full access sponsor attributions" on ${A} for all using (auth.role() = 'service_role')`],
            ['function granted', `grant execute on function public.ezil_sponsor_trial_claim_guard() to authenticated`, `revoke execute on function public.ezil_sponsor_trial_claim_guard() from authenticated`],
            ['function made definer', `alter function public.ezil_sponsor_attribution_guard() security definer`, `alter function public.ezil_sponsor_attribution_guard() security invoker`],
        ];
        for (const [name, mutate, restore] of drifts) {
            await probe.unsafe(mutate);
            const pre = await run(pins()), app = await run(apply());
            expect([pre.code, app.code], name).toEqual([2, 2]);
            expect(['refused_schema_drift', 'refused_preflight'], name).toContain(pre.receipt.result);
            expect(app.receipt.result, name).not.toMatch(/applied|already_present/);
            await probe.unsafe(restore);
            expect((await run(pins())).receipt.result, `${name} restored`).toBe('present_identical_no_action_needed');
        }
    });
    it('a function body changed in place is drift too, and a tampered SQL file is refused before any connection', async () => {
        await probe.unsafe(`create or replace function public.ezil_sponsor_trial_claim_guard() returns trigger language plpgsql set search_path = '' as $$ begin return new; end $$`);
        expect((await run(pins())).receipt.result).toBe('refused_schema_drift');
        const read = async (p: string) => { const b = await readFile(p); return p.endsWith(PINNED.sqlFile) ? Buffer.concat([b, Buffer.from('\nDROP TABLE x;\n')]) : b; };
        let connected = false;
        expect(await refusal(() => main({ argv: apply(), env: { SPONSOR_DB_URL: url }, connect: async (u: string) => { connected = true; return connect(u); }, read, dir: DIR }))).toBe('sql_file_differs_from_pin');
        expect(connected).toBe(false);
    });
});
