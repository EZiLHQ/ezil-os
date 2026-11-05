#!/usr/bin/env node
// Hand-run, staging only. Restores the stored representation of sign-in Free starter receipts that
// app/src/server/auth/staging-ai-enrollment.ts bound as a JSON string before its fix: such a row is a
// jsonb STRING the AI-credit outbox never claims (payload->>'protocol' is null). This converts each
// allowlisted row to the jsonb object it already contains. It never creates a row or a grant and never
// changes an owner, key, amount, expiry, attempt count or delivery state; the normal drain delivers.
//
// Modes (run from the app directory, so postgres.js resolves; SUPABASE_DATABASE_URL is the app's own):
//   capture --expect-system-id DIGITS                                  read-only: classify every string row
//   [dry-run] --expect-system-id DIGITS --allowlist FILE --expect N    default: convert, verify, ROLL BACK
//   apply --expect-system-id DIGITS --allowlist FILE --expect N --yes  the same, then COMMIT
//   verify --expect-system-id DIGITS --allowlist FILE --expect N       read-only: after the drain
// The allowlist holds sha256(event_key) hex digests, one per line, captured per window and kept local.
// Output is JSON lines with digests, timestamps, counts and fixed codes only: never an id, key, email,
// payload value or the database URL.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTOCOL = 'ezil-ai-credits-v1';
export const FREE_ONCE = 'ezil-os:v1:free-once:';
export const PAYLOAD_KEYS = Object.freeze(['action', 'credits', 'entitlementId', 'eventId', 'expiresAt', 'invoiceId', 'policyVersion', 'protocol']);
// Statuses after which a subscription no longer makes its owner paid. Anything else is not Free.
export const ENDED_SUBSCRIPTION = Object.freeze(['canceled', 'incomplete_expired']);
const FORBIDDEN_REFS = ['btgqfmnzycdecmeyqubx'];
const HASH = /^[0-9a-f]{64}$/;
const MODES = ['capture', 'dry-run', 'apply', 'verify'];

export class Refusal extends Error {
    constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}
const refuse = (code, detail) => { throw new Refusal(code, detail); };
class RolledBack extends Error {}

export function parseArgs(argv) {
    const args = [...argv];
    const mode = args[0] && !args[0].startsWith('--') ? args.shift() : 'dry-run';
    if (!MODES.includes(mode)) refuse('usage_unknown_mode');
    const options = { mode, yes: false };
    while (args.length) {
        const flag = args.shift();
        if (flag === '--yes') { options.yes = true; continue; }
        if (!['--expect-system-id', '--allowlist', '--expect'].includes(flag)) refuse('usage_unknown_argument');
        const value = args.shift();
        if (value === undefined || value.startsWith('--')) refuse('usage_missing_value');
        options[{ '--expect-system-id': 'systemId', '--allowlist': 'allowlist', '--expect': 'expect' }[flag]] = value;
    }
    if (!/^[0-9]+$/.test(options.systemId ?? '')) refuse('usage_expect_system_id_digits');
    if (mode === 'capture') {
        if (options.allowlist !== undefined || options.expect !== undefined || options.yes) refuse('usage_capture_takes_only_system_id');
        return options;
    }
    if (!options.allowlist) refuse('usage_allowlist_required');
    if (!/^[1-9][0-9]*$/.test(options.expect ?? '')) refuse('usage_expect_count_required');
    options.expect = Number(options.expect);
    if (mode === 'apply' && !options.yes) refuse('usage_apply_requires_yes');
    if (mode !== 'apply' && options.yes) refuse('usage_yes_only_with_apply');
    return options;
}

export function parseAllowlist(text, expect) {
    const hashes = text.split('\n').map(line => line.replace(/#.*/, '').trim()).filter(Boolean);
    if (hashes.some(hash => !HASH.test(hash))) refuse('allowlist_entry_not_sha256_hex');
    if (new Set(hashes).size !== hashes.length) refuse('allowlist_duplicate_entry');
    if (hashes.length !== expect) refuse('allowlist_count_mismatch', { listed: hashes.length, expect });
    return hashes;
}

export function checkDatabaseUrl(url) {
    if (!url || typeof url !== 'string') refuse('database_url_missing');
    let decoded = url;
    try { decoded = decodeURIComponent(url); } catch { /* inspect the raw value */ }
    if (FORBIDDEN_REFS.some(ref => `${url}\n${decoded}`.toLowerCase().includes(ref))) refuse('database_url_forbidden_production');
    return url;
}

function loadPostgres() {
    for (const base of [join(process.cwd(), 'package.json'), fileURLToPath(import.meta.url)]) {
        try { return createRequire(base)('postgres'); } catch { /* try the next base */ }
    }
    return refuse('postgres_js_unavailable');
}

const short = hash => hash.slice(0, 12);
const csv = values => values.join(',');

/** Every jsonb-string outbox row in scope, with the reasons it may not be converted (empty = eligible). */
function classify(tx, scope) {
    return tx`
        with s as (
            select o.id, o.event_key, o.user_id, o.kind, o.attempts, o.last_error, o.delivered_at, o.created_at,
                encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') as hash,
                ${FREE_ONCE} || o.user_id::text as root,
                case when pg_input_is_valid(o.payload #>> '{}', 'jsonb') then (o.payload #>> '{}')::jsonb end as body
            from public.ezil_billing_outbox o
            where jsonb_typeof(o.payload) = 'string' and ${scope}
        )
        select s.id, s.hash, s.root, s.created_at as "createdAt", array_to_string(array_remove(array[
            case when s.kind <> 'ai_grant' then 'kind' end,
            case when s.delivered_at is not null then 'delivered' end,
            case when s.attempts <> 0 then 'attempted' end,
            case when s.last_error is not null then 'has_error' end,
            case when jsonb_typeof(s.body) is distinct from 'object' then 'payload_not_object'
                when (select array_agg(k order by k) from jsonb_object_keys(s.body) k)
                    is distinct from string_to_array(${csv(PAYLOAD_KEYS)}::text, ',') then 'payload_keys' end,
            case when s.body->>'protocol' is distinct from ${PROTOCOL} or s.body->'policyVersion' is distinct from '1'::jsonb
                or s.body->'invoiceId' is distinct from 'null'::jsonb or s.body->>'action' is distinct from 'grant' then 'payload_protocol' end,
            case when s.body->>'entitlementId' is distinct from s.root or s.body->>'eventId' is distinct from s.event_key
                or s.event_key is distinct from s.root || ':grant' then 'not_own_free_once' end,
            case when s.body->'credits' is distinct from '100'::jsonb then 'credits' end,
            case when not coalesce(pg_input_is_valid(s.body->>'expiresAt', 'timestamptz'), false) then 'expiry_invalid'
                when (s.body->>'expiresAt')::timestamptz <= now() then 'expired'
                when abs(extract(epoch from (s.body->>'expiresAt')::timestamptz - (s.created_at + interval '365 days'))) > 300
                    then 'expiry_not_original' end,
            case when not exists (select 1 from auth.users u where u.id = s.user_id and u.deleted_at is null)
                then 'user_missing_or_deleted' end,
            case when exists (select 1 from public.ezil_billing_subscriptions b where b.user_id = s.user_id
                and b.status <> all(string_to_array(${csv(ENDED_SUBSCRIPTION)}::text, ','))) then 'not_currently_free' end,
            case when not exists (select 1 from ezil_works.ai_members m where m.auth_user_id = s.user_id) then 'not_enrolled' end,
            case when exists (select 1 from public.ezil_billing_outbox d where d.id <> s.id
                and (left(d.event_key, length(s.root) + 1) = s.root || ':'
                    or (jsonb_typeof(d.payload) = 'object' and d.payload->>'entitlementId' = s.root))) then 'other_outbox_row_same_root' end,
            case when exists (select 1 from ezil_ai.grants g where g.entitlement_id = s.root) then 'gateway_grant_exists' end,
            case when exists (select 1 from ezil_ai.funding_events f where f.event_id = s.event_key or f.entitlement_id = s.root)
                then 'gateway_event_exists' end
        ], null), ',') as reasons
        from s order by s.created_at, s.id`.then(rows => rows.map(row => ({ ...row, reasons: row.reasons ? row.reasons.split(',') : [] })));
}

const fixedColumns = tx => tx`concat_ws('|', o.event_key, o.user_id, o.kind, o.attempts, coalesce(o.last_error, '∅'),
    coalesce(o.delivered_at::text, '∅'), o.created_at)`;

async function pinSystem(tx, systemId) {
    const [{ id }] = await tx`select system_identifier::text as id from pg_control_system()`;
    if (id !== systemId) refuse('system_identifier_mismatch');
}

async function capture(sql, options, print) {
    return sql.begin('read only, isolation level repeatable read', async tx => {
        await pinSystem(tx, options.systemId);
        const rows = await classify(tx, tx`true`);
        for (const row of rows) {
            print({ event: 'candidate', hash: row.hash, createdAt: new Date(row.createdAt).toISOString(),
                eligible: row.reasons.length === 0, reasons: row.reasons });
        }
        print({ event: 'capture', stringRows: rows.length, eligible: rows.filter(row => row.reasons.length === 0).length });
        return 0;
    });
}

async function convert(sql, options, hashes, print) {
    let report;
    try {
        await sql.begin('isolation level repeatable read', async tx => {
            await tx`set local lock_timeout = '3s'`;
            await tx`set local statement_timeout = '30s'`;
            await pinSystem(tx, options.systemId);
            const [{ free }] = await tx`select pg_try_advisory_xact_lock(hashtextextended('ezil:free-starter-receipt-repair', 0)) as free`;
            if (!free) refuse('another_repair_in_progress');
            // Lock exactly the allowlisted rows; a row another transaction holds or changed aborts the run.
            const locked = await tx`
                select o.id, encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') as hash from public.ezil_billing_outbox o
                where encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') = any(string_to_array(${csv(hashes)}::text, ','))
                order by o.id for update nowait`;
            const found = new Set(locked.map(row => row.hash));
            if (locked.length !== options.expect || hashes.some(hash => !found.has(hash))) {
                refuse('allowlist_rows_not_found', { found: locked.length, expect: options.expect,
                    missing: hashes.filter(hash => !found.has(hash)).map(short) });
            }
            const ids = locked.map(row => row.id);
            const scope = tx`o.id = any(string_to_array(${csv(ids)}::text, ',')::uuid[])`;
            const rows = await classify(tx, scope);
            const blocked = rows.filter(row => row.reasons.length);
            if (rows.length !== ids.length || blocked.length) {
                refuse('rows_not_eligible', { eligible: rows.length - blocked.length, expect: ids.length,
                    blocked: blocked.map(row => ({ hash: short(row.hash), reasons: row.reasons })) });
            }
            // The drain's own per-root lock (ai-credit-outbox-store.ts pinAccount) keeps any delivery of these roots out.
            for (const row of rows) {
                const [{ free: rootFree }] = await tx`select pg_try_advisory_xact_lock(hashtextextended(${`billing:ai_root:${row.root}`}, 0)) as free`;
                if (!rootFree) refuse('root_lock_busy', { hash: short(row.hash) });
            }
            const others = () => tx`select count(*)::int as n, md5(coalesce(string_agg(concat_ws('|', o.id, ${fixedColumns(tx)},
                o.payload::text), ',' order by o.id), '')) as digest from public.ezil_billing_outbox o where not (${scope})`;
            const [before] = await others();
            const targets = new Map((await tx`select o.id, md5(${fixedColumns(tx)}) as fixed, md5(((o.payload #>> '{}')::jsonb)::text) as body
                from public.ezil_billing_outbox o where ${scope}`).map(row => [row.id, row]));
            const updated = await tx`
                update public.ezil_billing_outbox o set payload = (o.payload #>> '{}')::jsonb
                where ${scope} and jsonb_typeof(o.payload) = 'string' and o.kind = 'ai_grant'
                    and o.delivered_at is null and o.attempts = 0 and o.last_error is null
                returning o.id, md5(${fixedColumns(tx)}) as fixed, md5(o.payload::text) as body, jsonb_typeof(o.payload) as type,
                    o.payload->>'protocol' = ${PROTOCOL} and coalesce(o.payload->'delivery'->>'status', 'pending') = 'pending' as claimable`;
            if (updated.length !== ids.length) refuse('update_count_mismatch', { updated: updated.length, expect: ids.length });
            for (const row of updated) {
                const was = targets.get(row.id);
                if (row.type !== 'object' || !row.claimable || row.body !== was?.body || row.fixed !== was?.fixed) refuse('conversion_not_exact');
            }
            const [after] = await others();
            if (after.n !== before.n || after.digest !== before.digest) refuse('other_rows_changed');
            report = { converted: updated.length, otherRows: after.n, hashes: rows.map(row => short(row.hash)) };
            if (options.mode !== 'apply') throw new RolledBack();
        });
    } catch (error) {
        if (!(error instanceof RolledBack)) throw error;
        print({ event: 'dry-run', ...report, committed: false });
        return 0;
    }
    print({ event: 'applied', ...report, committed: true });
    return 0;
}

async function verify(sql, options, hashes, print) {
    return sql.begin('read only, isolation level repeatable read', async tx => {
        await pinSystem(tx, options.systemId);
        const rows = await tx`
            with t as (
                select o.*, encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') as hash, ${FREE_ONCE} || o.user_id::text as root,
                    case when jsonb_typeof(o.payload) = 'object' and pg_input_is_valid(o.payload->>'expiresAt', 'timestamptz')
                        then (o.payload->>'expiresAt')::timestamptz end as expiry
                from public.ezil_billing_outbox o
                where encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') = any(string_to_array(${csv(hashes)}::text, ','))
            )
            select t.hash, jsonb_typeof(t.payload) as type, t.delivered_at is not null as delivered, t.last_error is null as "noError",
                t.payload->'delivery'->>'status' as status,
                (select count(*) from ezil_ai.grants g where g.entitlement_id = t.root)::int as grants,
                (select count(*) from ezil_ai.grants g where g.entitlement_id = t.root and g.source::text = 'entitlement'
                    and g.revoked_at is null and g.expires_at = t.expiry)::int as "exactGrants",
                (select count(*) from ezil_ai.funding_events f where f.entitlement_id = t.root)::int as events,
                (select count(*) from ezil_ai.funding_events f where f.event_id = t.event_key and f.entitlement_id = t.root
                    and f.action = 'grant' and f.credits = 100 and f.expires_at = t.expiry)::int as "exactEvents",
                (select min(g.credits_micro) from ezil_ai.grants g where g.entitlement_id = t.root)::text as "creditsMicro"
            from t order by t.created_at, t.id`;
        const [reference] = await tx`select coalesce(string_agg(distinct g.credits_micro::text, ','), '') as micro from ezil_ai.grants g
            where left(g.entitlement_id, ${FREE_ONCE.length}) = ${FREE_ONCE}
                and g.entitlement_id <> all(select ${FREE_ONCE} || o.user_id::text from public.ezil_billing_outbox o
                    where encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') = any(string_to_array(${csv(hashes)}::text, ',')))`;
        const remaining = await tx`select encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') as hash, o.created_at as "createdAt"
            from public.ezil_billing_outbox o where jsonb_typeof(o.payload) = 'string'
                and encode(sha256(convert_to(o.event_key, 'UTF8')), 'hex') <> all(string_to_array(${csv(hashes)}::text, ','))
            order by o.created_at`;
        let failed = rows.length !== options.expect;
        let pending = false;
        for (const row of rows) {
            const done = row.type === 'object' && row.delivered && row.noError && row.status === 'done'
                && row.grants === 1 && row.exactGrants === 1 && row.events === 1 && row.exactEvents === 1;
            const waiting = row.type === 'object' && !row.delivered && row.grants === 0 && row.events === 0;
            if (!done && !waiting) failed = true;
            if (waiting) pending = true;
            print({ event: 'verify-row', hash: short(row.hash), state: done ? 'delivered_once' : waiting ? 'pending' : 'mismatch',
                type: row.type, delivered: row.delivered, status: row.status ?? null, grants: row.grants, exactGrants: row.exactGrants,
                events: row.events, exactEvents: row.exactEvents, creditsMicro: row.creditsMicro });
        }
        for (const row of remaining) {
            print({ event: 'string-row-outside-allowlist', hash: short(row.hash), createdAt: new Date(row.createdAt).toISOString() });
        }
        print({ event: 'verify', rows: rows.length, expect: options.expect, failed, pending,
            starterCreditsMicroBefore: reference.micro ? reference.micro.split(',') : [], stringRowsOutsideAllowlist: remaining.length });
        return failed ? 1 : pending ? 2 : 0;
    });
}

/** Exit code: 0 ok, 1 refused or failed (nothing committed), 2 verify still waiting for the drain. */
export async function run(argv, { databaseUrl = process.env.SUPABASE_DATABASE_URL, print = line => console.log(JSON.stringify(line)),
    readFile = path => readFileSync(path, 'utf8'), postgres } = {}) {
    let sql;
    try {
        const options = parseArgs(argv);
        const hashes = options.mode === 'capture' ? [] : parseAllowlist(readFile(options.allowlist), options.expect);
        checkDatabaseUrl(databaseUrl);
        sql = (postgres ?? loadPostgres())(databaseUrl, { max: 1, prepare: false, fetch_types: false,
            idle_timeout: 2, connect_timeout: 10, onnotice: () => {} });
        print({ event: 'start', mode: options.mode, expect: options.expect ?? null, dryRun: options.mode !== 'apply' });
        if (options.mode === 'capture') return await capture(sql, options, print);
        if (options.mode === 'verify') return await verify(sql, options, hashes, print);
        return await convert(sql, options, hashes, print);
    } catch (error) {
        // Fixed codes only: driver errors may carry hosts, roles or values.
        print(error instanceof Refusal ? { event: 'refused', code: error.code, ...error.detail, committed: false }
            : { event: 'error', code: typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : 'unexpected', committed: false });
        return 1;
    } finally {
        await sql?.end({ timeout: 5 }).catch(() => {});
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    process.exitCode = await run(process.argv.slice(2));
}
