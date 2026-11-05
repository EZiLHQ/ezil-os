import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkDatabaseUrl, parseAllowlist, parseArgs, run, PAYLOAD_KEYS } from './free-starter-receipt-repair.mjs';

const refusedWith = code => error => error?.code === code;
const digest = key => createHash('sha256').update(key, 'utf8').digest('hex');

describe('arguments and allowlist', () => {
    test('a dry run is the default and apply needs --yes', () => {
        assert.equal(parseArgs(['--expect-system-id', '7', '--allowlist', 'f', '--expect', '2']).mode, 'dry-run');
        assert.throws(() => parseArgs(['apply', '--expect-system-id', '7', '--allowlist', 'f', '--expect', '2']), refusedWith('usage_apply_requires_yes'));
        assert.equal(parseArgs(['apply', '--expect-system-id', '7', '--allowlist', 'f', '--expect', '2', '--yes']).yes, true);
        assert.throws(() => parseArgs(['dry-run', '--expect-system-id', '7', '--allowlist', 'f', '--expect', '2', '--yes']), refusedWith('usage_yes_only_with_apply'));
    });
    test('the target pin, count and allowlist are required; unknown input is refused', () => {
        assert.throws(() => parseArgs(['capture']), refusedWith('usage_expect_system_id_digits'));
        assert.throws(() => parseArgs(['capture', '--expect-system-id', 'abc']), refusedWith('usage_expect_system_id_digits'));
        assert.throws(() => parseArgs(['capture', '--expect-system-id', '7', '--expect', '1']), refusedWith('usage_capture_takes_only_system_id'));
        assert.throws(() => parseArgs(['--expect-system-id', '7', '--expect', '1']), refusedWith('usage_allowlist_required'));
        assert.throws(() => parseArgs(['--expect-system-id', '7', '--allowlist', 'f']), refusedWith('usage_expect_count_required'));
        assert.throws(() => parseArgs(['--expect-system-id', '7', '--allowlist', 'f', '--expect', '0']), refusedWith('usage_expect_count_required'));
        assert.throws(() => parseArgs(['reset', '--expect-system-id', '7']), refusedWith('usage_unknown_mode'));
        assert.throws(() => parseArgs(['capture', '--expect-system-id', '7', '--all']), refusedWith('usage_unknown_argument'));
    });
    test('the allowlist is exact sha256 digests, unique, and pinned to the expected count', () => {
        const [a, b] = [digest('a'), digest('b')];
        assert.deepEqual(parseAllowlist(`# window 1\n${a}\n\n${b}  # second\n`, 2), [a, b]);
        assert.throws(() => parseAllowlist(`${a}\n`, 2), refusedWith('allowlist_count_mismatch'));
        assert.throws(() => parseAllowlist(`${a}\n${a}\n`, 2), refusedWith('allowlist_duplicate_entry'));
        assert.throws(() => parseAllowlist(`${a.toUpperCase()}\n`, 1), refusedWith('allowlist_entry_not_sha256_hex'));
        assert.throws(() => parseAllowlist('ezil-os:v1:free-once:x:grant\n', 1), refusedWith('allowlist_entry_not_sha256_hex'));
    });
    test('the production project is refused even when URL-encoded, before any connection', async () => {
        assert.throws(() => checkDatabaseUrl('postgres://u:p@db.btgqfmnzycdecmeyqubx.supabase.co/postgres'), refusedWith('database_url_forbidden_production'));
        assert.throws(() => checkDatabaseUrl('postgres://u:p@h/postgres?x=%62tgqfmnzycdecmeyqubx'), refusedWith('database_url_forbidden_production'));
        const lines = [];
        let connected = false;
        const code = await run(['capture', '--expect-system-id', '7'], { databaseUrl: undefined, print: line => lines.push(line),
            postgres: () => { connected = true; } });
        assert.equal(code, 1);
        assert.equal(connected, false);
        assert.deepEqual(lines, [{ event: 'refused', code: 'database_url_missing', committed: false }]);
    });
});

const url = process.env.BILLING_TEST_DATABASE_URL;
describe('against PostgreSQL', { skip: !url && 'BILLING_TEST_DATABASE_URL is not set' }, () => {
    const postgres = createRequire(import.meta.url)('postgres');
    let db, systemId;
    const users = [];
    const T0 = new Date(Date.now() - 3_600_000);
    const payloadOf = userId => ({
        protocol: 'ezil-ai-credits-v1', policyVersion: 1, invoiceId: null,
        entitlementId: `ezil-os:v1:free-once:${userId}`, credits: 100,
        expiresAt: new Date(T0.getTime() + 365 * 86_400_000).toISOString(),
        eventId: `ezil-os:v1:free-once:${userId}:grant`, action: 'grant',
    });
    /** One user with the pre-fix sign-in receipt, stored exactly as the double-encoded jsonb string. */
    async function user({ paid = false, enrolled = true, gatewayGrant = false, attempts = 0, rawString, objectRow = false } = {}) {
        const id = randomUUID();
        users.push(id);
        await db`insert into auth.users (id) values (${id})`;
        if (enrolled) await db`insert into ezil_works.ai_members (auth_user_id) values (${id})`;
        if (paid) await db`insert into public.ezil_billing_subscriptions (stripe_subscription_id, user_id, status, sku, stripe_event_created)
            values (${`sub_${id}`}, ${id}, 'active', 'standard_monthly_v3', now())`;
        const payload = payloadOf(id);
        if (gatewayGrant) await db`insert into ezil_ai.grants (auth_user_id, source, entitlement_id, credits_micro, expires_at)
            values (${id}, 'entitlement', ${payload.entitlementId}, 100000000, ${payload.expiresAt})`;
        const text = rawString ?? JSON.stringify(payload);
        if (objectRow) {
            await db`insert into public.ezil_billing_outbox (event_key, user_id, kind, payload, created_at, attempts, last_error)
                values (${payload.eventId}, ${id}, 'ai_grant', ${JSON.stringify({ ...payload, delivery: { status: 'retry', blockedBy: 'needs_ezil_id' } })}::text::jsonb,
                    ${T0}, 87, 'no_ai_account')`;
        } else {
            await db`insert into public.ezil_billing_outbox (event_key, user_id, kind, payload, created_at, attempts)
                values (${payload.eventId}, ${id}, 'ai_grant', to_jsonb(${text}::text), ${T0}, ${attempts})`;
        }
        return { id, key: payload.eventId, hash: digest(payload.eventId), payload };
    }
    const snapshot = async () => JSON.stringify(await db`select id, event_key, user_id, kind, payload::text as payload, attempts, last_error,
        delivered_at, created_at from public.ezil_billing_outbox order by id`);
    const repair = async (argv, allowlist = '') => {
        const lines = [];
        const code = await run(argv, { databaseUrl: url, readFile: () => allowlist, print: line => lines.push(line) });
        return { code, lines, last: lines.at(-1) };
    };
    const pin = () => ['--expect-system-id', systemId];

    before(async () => {
        db = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
        // The Gateway's tables are not OS migrations: give the disposable database their minimal shape.
        await db.unsafe(`create schema if not exists ezil_works;
            create table if not exists ezil_works.ai_members (auth_user_id uuid primary key, public_id uuid not null default gen_random_uuid());
            create schema if not exists ezil_ai;
            create table if not exists ezil_ai.grants (id uuid primary key default gen_random_uuid(), auth_user_id uuid not null,
                source text not null, entitlement_id text unique, credits_micro bigint not null, expires_at timestamptz not null, revoked_at timestamptz);
            create table if not exists ezil_ai.funding_events (event_id text primary key, entitlement_id text not null, action text not null,
                credits bigint not null, expires_at timestamptz)`);
        [{ systemId }] = await db`select system_identifier::text as "systemId" from pg_control_system()`;
    });
    test.afterEach(async () => {
        const ids = users.splice(0);
        if (!ids.length) return;
        await db`delete from ezil_ai.funding_events where entitlement_id in ${db(ids.map(id => `ezil-os:v1:free-once:${id}`))}`;
        await db`delete from ezil_ai.grants where auth_user_id in ${db(ids)}`;
        await db`delete from public.ezil_billing_outbox where user_id in ${db(ids)}`;
        await db`delete from public.ezil_billing_subscriptions where user_id in ${db(ids)}`;
        await db`delete from ezil_works.ai_members where auth_user_id in ${db(ids)}`;
        await db`delete from auth.users where id in ${db(ids)}`;
    });
    after(async () => { await db?.end(); });

    test('capture classifies every jsonb-string row and lists only digests', async () => {
        const a = await user(), b = await user(), paid = await user({ paid: true }), unenrolled = await user({ enrolled: false });
        const granted = await user({ gatewayGrant: true }), attempted = await user({ attempts: 1 }), garbled = await user({ rawString: 'not json' });
        const parked = await user({ objectRow: true });
        const { code, lines } = await repair(['capture', ...pin()]);
        assert.equal(code, 0);
        const byHash = new Map(lines.filter(line => line.event === 'candidate').map(line => [line.hash, line]));
        assert.deepEqual([a, b].map(u => byHash.get(u.hash).reasons), [[], []]);
        assert.deepEqual(byHash.get(paid.hash).reasons, ['not_currently_free']);
        assert.deepEqual(byHash.get(unenrolled.hash).reasons, ['not_enrolled']);
        assert.deepEqual(byHash.get(granted.hash).reasons, ['gateway_grant_exists']);
        assert.deepEqual(byHash.get(attempted.hash).reasons, ['attempted']);
        assert.deepEqual(byHash.get(garbled.hash).reasons, ['payload_not_object', 'payload_protocol', 'not_own_free_once', 'credits', 'expiry_invalid']);
        assert.equal(byHash.has(parked.hash), false);
        assert.deepEqual(lines.at(-1), { event: 'capture', stringRows: 7, eligible: 2 });
        const printed = JSON.stringify(lines);
        for (const u of [a, b, paid, parked]) { assert.equal(printed.includes(u.id), false); assert.equal(printed.includes(u.key), false); }
    });

    test('a dry run converts, verifies and rolls back: nothing changes', async () => {
        const a = await user(), b = await user(), paid = await user({ paid: true });
        const before = await snapshot();
        const { code, last } = await repair(['dry-run', ...pin(), '--allowlist', 'f', '--expect', '2'], `${a.hash}\n${b.hash}\n`);
        assert.equal(code, 0);
        assert.equal(last.event, 'dry-run');
        assert.equal(last.converted, 2);
        assert.equal(last.committed, false);
        assert.equal(await snapshot(), before);
        void paid;
    });

    test('apply converts exactly the allowlisted rows to their own object; everything else is untouched; a rerun refuses', async () => {
        const a = await user(), b = await user(), paid = await user({ paid: true }), parked = await user({ objectRow: true });
        const others = async () => JSON.stringify((await db`select id, event_key, user_id, kind, payload::text as payload, attempts, last_error,
            delivered_at, created_at from public.ezil_billing_outbox where user_id <> all(${[a.id, b.id]}::uuid[]) order by id`));
        const [beforeOthers, [{ n: total }]] = [await others(), await db`select count(*)::int as n from public.ezil_billing_outbox`];
        const { code, last } = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '2', '--yes'], `${a.hash}\n${b.hash}\n`);
        assert.equal(code, 0);
        assert.deepEqual([last.event, last.converted, last.committed], ['applied', 2, true]);
        for (const u of [a, b]) {
            const [row] = await db`select jsonb_typeof(payload) as type, payload, attempts, last_error, delivered_at, event_key, user_id, kind
                from public.ezil_billing_outbox where event_key = ${u.key}`;
            assert.equal(row.type, 'object');
            assert.deepEqual(row.payload, u.payload);
            assert.deepEqual(Object.keys(row.payload).sort(), [...PAYLOAD_KEYS]);
            assert.deepEqual([row.attempts, row.last_error, row.delivered_at, row.event_key, row.user_id, row.kind], [0, null, null, u.key, u.id, 'ai_grant']);
            // The outbox claim's own filter now matches it.
            const [{ claimable }] = await db`select payload->>'protocol' = 'ezil-ai-credits-v1'
                and coalesce(payload->'delivery'->>'status', 'pending') = 'pending' as claimable from public.ezil_billing_outbox where event_key = ${u.key}`;
            assert.equal(claimable, true);
        }
        assert.equal(await others(), beforeOthers);
        assert.equal((await db`select count(*)::int as n from public.ezil_billing_outbox`)[0].n, total);
        assert.equal((await db`select count(*)::int as n from ezil_ai.grants where auth_user_id in ${db([a.id, b.id])}`)[0].n, 0);

        const after = await snapshot();
        const rerun = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '2', '--yes'], `${a.hash}\n${b.hash}\n`);
        assert.equal(rerun.code, 1);
        assert.deepEqual([rerun.last.event, rerun.last.code, rerun.last.eligible], ['refused', 'rows_not_eligible', 0]);
        assert.equal(await snapshot(), after);
        void paid; void parked;
    });

    test('one ineligible row refuses the whole batch with its reason, and nothing is written', async () => {
        const a = await user(), paid = await user({ paid: true });
        const before = await snapshot();
        const { code, last } = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '2', '--yes'], `${a.hash}\n${paid.hash}\n`);
        assert.equal(code, 1);
        assert.equal(last.code, 'rows_not_eligible');
        assert.deepEqual(last.blocked, [{ hash: paid.hash.slice(0, 12), reasons: ['not_currently_free'] }]);
        assert.equal(await snapshot(), before);
    });

    test('an unknown digest, a count mismatch and the wrong database refuse with nothing written', async () => {
        const a = await user();
        const before = await snapshot();
        const missing = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '2', '--yes'], `${a.hash}\n${digest('absent')}\n`);
        assert.deepEqual([missing.code, missing.last.code, missing.last.found], [1, 'allowlist_rows_not_found', 1]);
        const count = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '2', '--yes'], `${a.hash}\n`);
        assert.deepEqual([count.code, count.last.code], [1, 'allowlist_count_mismatch']);
        const wrong = await repair(['apply', '--expect-system-id', '1', '--allowlist', 'f', '--expect', '1', '--yes'], `${a.hash}\n`);
        assert.deepEqual([wrong.code, wrong.last.code], [1, 'system_identifier_mismatch']);
        assert.equal(await snapshot(), before);
    });

    test('a side effect on any other row (here a trigger) refuses the run and rolls everything back', async () => {
        const a = await user(), sentinel = await user({ paid: true });
        await db.unsafe(`create function public.zz_repair_side_effect() returns trigger language plpgsql as $$
            begin update public.ezil_billing_outbox set attempts = attempts + 1 where event_key = '${sentinel.key}'; return new; end $$;
            create trigger zz_repair_side_effect after update of payload on public.ezil_billing_outbox
                for each row when (old.event_key = '${a.key}') execute function public.zz_repair_side_effect()`);
        try {
            const before = await snapshot();
            const { code, last } = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '1', '--yes'], `${a.hash}\n`);
            assert.deepEqual([code, last.code, last.committed], [1, 'other_rows_changed', false]);
            assert.equal(await snapshot(), before);
        } finally {
            await db.unsafe('drop trigger zz_repair_side_effect on public.ezil_billing_outbox; drop function public.zz_repair_side_effect()');
        }
    });

    test('a row another transaction holds refuses at once (NOWAIT) with nothing written', async () => {
        const a = await user();
        const before = await snapshot();
        const holder = postgres(url, { max: 1, prepare: false, onnotice: () => {} });
        let release;
        const held = new Promise(resolve => { release = resolve; });
        let locked;
        const isLocked = new Promise(resolve => { locked = resolve; });
        const holding = holder.begin(async tx => {
            await tx`select id from public.ezil_billing_outbox where event_key = ${a.key} for update`;
            locked();
            await held;
        });
        await isLocked;
        const { code, last } = await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '1', '--yes'], `${a.hash}\n`);
        release();
        await holding;
        await holder.end();
        assert.deepEqual([code, last.event, last.code], [1, 'error', '55P03']);
        assert.equal(await snapshot(), before);
    });

    test('verify waits for the drain, then passes on exactly one exact grant and event, and fails on a duplicate', async () => {
        const a = await user(), excluded = await user({ paid: true });
        assert.equal((await repair(['apply', ...pin(), '--allowlist', 'f', '--expect', '1', '--yes'], `${a.hash}\n`)).code, 0);
        const waiting = await repair(['verify', ...pin(), '--allowlist', 'f', '--expect', '1'], `${a.hash}\n`);
        assert.equal(waiting.code, 2);
        assert.equal(waiting.lines.find(line => line.event === 'verify-row').state, 'pending');
        assert.deepEqual(waiting.lines.filter(line => line.event === 'string-row-outside-allowlist').map(line => line.hash), [excluded.hash.slice(0, 12)]);

        // What the normal drain and the Gateway record for one delivery.
        await db`update public.ezil_billing_outbox set delivered_at = now(), attempts = 1,
            payload = jsonb_set(payload, '{delivery}', '{"status":"done"}'::jsonb) where event_key = ${a.key}`;
        await db`insert into ezil_ai.grants (auth_user_id, source, entitlement_id, credits_micro, expires_at)
            values (${a.id}, 'entitlement', ${a.payload.entitlementId}, 100000000, ${a.payload.expiresAt})`;
        await db`insert into ezil_ai.funding_events (event_id, entitlement_id, action, credits, expires_at)
            values (${a.key}, ${a.payload.entitlementId}, 'grant', 100, ${a.payload.expiresAt})`;
        const done = await repair(['verify', ...pin(), '--allowlist', 'f', '--expect', '1'], `${a.hash}\n`);
        assert.equal(done.code, 0);
        assert.equal(done.lines.find(line => line.event === 'verify-row').state, 'delivered_once');

        await db`insert into ezil_ai.funding_events (event_id, entitlement_id, action, credits, expires_at)
            values (${`${a.key}:replayed`}, ${a.payload.entitlementId}, 'grant', 100, ${a.payload.expiresAt})`;
        const duplicate = await repair(['verify', ...pin(), '--allowlist', 'f', '--expect', '1'], `${a.hash}\n`);
        assert.equal(duplicate.code, 1);
        assert.equal(duplicate.lines.find(line => line.event === 'verify-row').state, 'mismatch');
    });
});
