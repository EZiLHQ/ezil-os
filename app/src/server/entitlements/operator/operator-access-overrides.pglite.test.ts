/** Offline PostgreSQL for explicit access overrides (0038). Set EZIL_PGLITE_MODULE to an installed PGlite ESM entry.
 * The production migrations, the signed routes, the real store and Stripe view; synthetic local identities only. */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore, GrantRow } from '@/server/billing/ports';
import { sourceCatalog, type Result } from './contract';
import { handleAdminEntitlementRequest, type Endpoint } from './http';
import { HEADERS, SENDER_KEYS_ENV, signingInput } from './signature';
import { createOperatorEntitlementDeps, readOperatorEntitlements, resetOperatorEntitlementsInstalled, type Executor, type TransactionalExecutor } from './store';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject local billing deps'); }) }));
interface LocalPg {
    exec(query: string): Promise<unknown>;
    query(query: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    transaction<T>(run: (tx: LocalPg) => Promise<T>): Promise<T>;
    close(): Promise<void>;
}
const MODULE = process.env.EZIL_PGLITE_MODULE;
const USER = '00000000-0000-4000-8000-000000000001', ACCOUNT = '10000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-11-25T12:00:00.000Z');
const START = '2026-11-10T00:00:00.000Z', END = '2026-12-10T00:00:00.000Z';
const DAY = 86_400_000;
const REVISION = sourceCatalog().catalog_revision;
const migration = (file: string) => readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8');
// Public RFC 8032 test vector, also used by the pinned Gateway signature fixture. Never a deployed sender key.
const TEST_PUBLIC = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
const TEST_PRIVATE = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });

// Each case boots its own PGlite (with or without 0038): seconds each, more under a parallel run.
describe.skipIf(!MODULE)('explicit access overrides on offline PostgreSQL', { timeout: 60_000 }, () => {
    let pg: LocalPg, now: Date;
    let activeTransaction: LocalPg | null = null;
    const dialect = new PgDialect();
    const executor = (source: LocalPg): Executor => ({ execute: query => {
        const compiled = dialect.sqlToQuery(query);
        return source.query(compiled.sql, compiled.params);
    } });
    // PGlite has one connection: reads made by injected dependencies join the same local transaction.
    const db: TransactionalExecutor = { execute: query => executor(activeTransaction ?? pg).execute(query), transaction: run => pg.transaction(async tx => {
        activeTransaction = tx;
        try { return await run(executor(tx)); } finally { activeTransaction = null; }
    }) };
    const rows = async (query: SQL) => (await db.execute(query) as { rows: Record<string, unknown>[] }).rows;
    const date = (v: unknown) => v === null ? null : new Date(v as string | Date);
    // Storage adapters only; decisions use production code.
    const store = {
        subscriptionsFor: async (): Promise<SubscriptionRow[]> => (await rows(sql`SELECT * FROM public.ezil_billing_subscriptions WHERE user_id = ${USER}::uuid`)).map(r => ({
            stripeSubscriptionId: String(r.stripe_subscription_id), sku: String(r.sku), status: String(r.status),
            currentPeriodStart: date(r.current_period_start), currentPeriodEnd: date(r.current_period_end), cancelAtPeriodEnd: false,
        })),
        openPaymentIssues: async () => [],
        grantsForPeriod: async (): Promise<GrantRow[]> => (await rows(sql`SELECT * FROM public.ezil_billing_grants WHERE user_id = ${USER}::uuid`)).map(r => ({
            id: String(r.id), userId: USER, subscriptionId: String(r.subscription_id), meter: String(r.meter), amount: BigInt(String(r.amount)),
            periodStart: date(r.period_start), periodEnd: date(r.period_end), kind: 'plan_period', sourceType: 'invoice', sourceId: 'synthetic_receipt', createdAt: NOW,
        } as GrantRow)),
    } as unknown as BillingStore;
    const billing: BillingDeps = { config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }), store, stripe: null, usage: null, now: () => now };
    const target = { kind: 'individual' as const, os_user_id: USER, account_public_id: ACCOUNT };
    const command = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        format: 'ezil.admin-entitlement-command.v1', command_id: randomUUID(), action: 'assign', producer: 'ezil-os', scope: 'individual',
        operator: { via: 'auth0_operator', actor: 'synthetic_operator', email: null }, product: { ref: 'standard_monthly_v3', catalog_revision: REVISION },
        target, quantity: null, starts_at: null, validity: { ends_at: new Date(now.getTime() + 30 * DAY).toISOString() }, reason: 'Synthetic local override regression',
        assignment: null, billing_effect: 'none', credit_option: 'none', ...over,
    });
    const override = (sku: string, validity: Record<string, unknown> = { until_revoked: true }) =>
        command({ access_override: true, product: { ref: sku, catalog_revision: REVISION }, validity });
    const request = async (endpoint: Endpoint, body?: Record<string, unknown>) => {
        const method = body ? 'POST' : 'GET', timestamp = Math.floor(now.getTime() / 1000);
        const suffix = endpoint === 'assignments' ? `?os_user_id=${USER}&account_public_id=${ACCOUNT}` : '';
        const url = new URL(`https://os.synthetic.test/api/gateway/admin-entitlements/v1/${endpoint}${suffix}`);
        const text = body ? JSON.stringify(body) : '', bytes = new TextEncoder().encode(text);
        const signature = sign(null, signingInput(method, url.pathname + url.search, timestamp, bytes), TEST_PRIVATE).toString('base64url');
        return handleAdminEntitlementRequest(new Request(url, { method, body: body ? text : undefined,
            headers: { [HEADERS.kid]: 'synthetic-ae', [HEADERS.timestamp]: String(timestamp), [HEADERS.signature]: signature } }),
            endpoint, { deps: async () => createOperatorEntitlementDeps(db, billing, () => now), nowSeconds: () => timestamp });
    };
    const send = async (body: Record<string, unknown>): Promise<Result> => {
        const response = await request('commands', body); expect(response.status).toBe(200); return response.json();
    };
    const read = async () => { const response = await request('assignments'); expect(response.status).toBe(200); return response.json(); };
    const catalog = async () => (await request('catalog')).json();
    const stripe = async (sku = 'standard_monthly_v3') => {
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES ('sub_synthetic', ${USER}::uuid, ${sku}, 'active', ${START}::timestamptz, ${END}::timestamptz)`);
        await db.execute(sql`INSERT INTO public.ezil_billing_grants VALUES (${randomUUID()}, ${USER}::uuid, 'sub_synthetic', 'compute_std_seconds', 1800000,
            ${START}::timestamptz, ${END}::timestamptz)`);
    };
    const stripeRows = async () => rows(sql`SELECT * FROM public.ezil_billing_subscriptions ORDER BY stripe_subscription_id`);
    const live = async () => rows(sql`SELECT ref, sku, access_override FROM public.ezil_operator_entitlements WHERE ended_at IS NULL ORDER BY access_override, ref`);

    async function open(overrides: boolean) {
        const { PGlite } = await import(/* @vite-ignore */ MODULE!);
        pg = new PGlite() as LocalPg;
        await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA ezil_works;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, deleted_at timestamptz, banned_until timestamptz, is_anonymous boolean);
            CREATE TABLE ezil_works.ai_members (auth_user_id uuid, public_id uuid);
            CREATE TABLE public.ezil_billing_subscriptions (stripe_subscription_id text PRIMARY KEY, user_id uuid, sku text, status text,
                current_period_start timestamptz, current_period_end timestamptz);
            CREATE TABLE public.ezil_billing_grants (id text, user_id uuid, subscription_id text, meter text, amount bigint, period_start timestamptz, period_end timestamptz);
            INSERT INTO auth.users (id) VALUES ('${USER}'); INSERT INTO ezil_works.ai_members VALUES ('${USER}', '${ACCOUNT}');`);
        for (const file of ['0019_operator_entitlements.sql', '0020_operator_refusal_receipts.sql', '0023_operator_issued_by.sql']) await pg.exec(migration(file));
        if (overrides) await pg.exec(migration('0038_operator_access_overrides.sql'));
    }
    beforeEach(() => {
        now = new Date(NOW); resetOperatorEntitlementsInstalled();
        vi.stubEnv(SENDER_KEYS_ENV, JSON.stringify({ 'synthetic-ae': TEST_PUBLIC }));
    });
    afterEach(async () => { vi.unstubAllEnvs(); await pg?.close(); });

    it('before 0038: no catalog capability, an override is 503 with nothing written; then 0038 applies the same command', async () => {
        await open(false);
        expect(Object.hasOwn(await catalog(), 'access_overrides')).toBe(false);
        expect((await send(command())).outcome).toBe('applied');
        const body = override('free_v3');
        const response = await request('commands', body);
        expect([response.status, await response.json()]).toEqual([503, { error: 'source_unavailable' }]);
        expect(await rows(sql`SELECT count(*)::int AS n FROM public.ezil_operator_entitlement_events WHERE command_id = ${body.command_id as string}::uuid`)).toEqual([{ n: 0 }]);
        expect((await readOperatorEntitlements(db, USER)).map(r => [r.sku, r.accessOverride])).toEqual([['standard_monthly_v3', undefined]]);

        await pg.exec(migration('0038_operator_access_overrides.sql'));
        await pg.exec(migration('0038_operator_access_overrides.sql'));
        resetOperatorEntitlementsInstalled();
        expect(await catalog()).toEqual({ ...sourceCatalog(), access_overrides: true });
        expect(await send(body)).toMatchObject({ outcome: 'applied', assignment: { product_ref: 'free_v3', access_override: true },
            effective_access: { state: 'active', product_ref: 'free_v3', via: 'operator' } });
        expect(await live()).toEqual([{ ref: expect.any(String), sku: 'standard_monthly_v3', access_override: false },
            { ref: expect.any(String), sku: 'free_v3', access_override: true }]);
    });

    it('paid Stripe: an active Free override wins, its change and end persist with revisions, and clearing it restores Stripe; Stripe rows untouched', async () => {
        await open(true); await stripe();
        const stripeBefore = await stripeRows();
        expect((await read()).effective_access).toEqual({ state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' });
        const o = await send(override('free_v3'));
        expect(o).toMatchObject({ outcome: 'applied', assignment: { revision: 1, until_revoked: true, access_override: true } });
        expect(await read()).toMatchObject({ effective_access: { state: 'active', product_ref: 'free_v3', via: 'operator' },
            stripe: { state: 'active', product_ref: 'standard_monthly_v3' }, assignments: [{ ref: o.assignment!.ref, access_override: true }] });
        const ends = new Date(now.getTime() + 2 * DAY).toISOString();
        expect(await send(command({ action: 'change', product: { ref: 'premium_monthly_v3', catalog_revision: REVISION }, validity: { ends_at: ends },
            assignment: { ref: o.assignment!.ref, expected_revision: 1 }, access_override: true }))).toMatchObject({ outcome: 'applied',
            assignment: { revision: 2, product_ref: 'premium_monthly_v3', ends_at: ends }, effective_access: { product_ref: 'premium_monthly_v3', via: 'operator' } });
        now = new Date(now.getTime() + DAY);
        expect(await send(command({ action: 'end', product: null, validity: null, assignment: { ref: o.assignment!.ref, expected_revision: 2 }, access_override: true })))
            .toMatchObject({ outcome: 'applied', assignment: { revision: 3, state: 'ended' }, effective_access: { product_ref: 'standard_monthly_v3', via: 'stripe' } });
        expect(await stripeRows()).toEqual(stripeBefore);
        expect(await rows(sql`SELECT action, revision FROM public.ezil_operator_entitlement_events ORDER BY revision`)).toEqual([
            { action: 'assign', revision: 1 }, { action: 'change', revision: 2 }, { action: 'end', revision: 3 }]);
    });

    it('paid Stripe: an expired override falls back to Stripe at its stored end', async () => {
        await open(true); await stripe();
        const ends = new Date(now.getTime() + DAY);
        await send(override('premium_monthly_v3', { ends_at: ends.toISOString() }));
        expect((await read()).effective_access).toEqual({ state: 'active', product_ref: 'premium_monthly_v3', via: 'operator' });
        now = ends;
        expect(await read()).toMatchObject({ effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' },
            assignments: [{ state: 'ended', access_override: true }] });
    });

    it('grant compatibility: an ordinary grant and an override live side by side; one live row per kind holds in the database', async () => {
        await open(true);
        const grant = await send(command());
        const o = await send(override('premium_monthly_v3'));
        expect(o.effective_access).toEqual({ state: 'active', product_ref: 'premium_monthly_v3', via: 'operator' });
        expect(await send(override('free_v3'))).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' }, assignment: null });
        expect(await send(command())).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' } });
        const insert = (ref: string, sku: string, kind: boolean) => db.execute(sql`INSERT INTO public.ezil_operator_entitlements
            (ref, user_id, account_public_id, sku, revision, starts_at, access_override) VALUES (${ref}, ${USER}::uuid, ${ACCOUNT}::uuid, ${sku}, 1, ${now.toISOString()}::timestamptz, ${kind})`);
        await expect(insert(`osg-${randomUUID()}`, 'premium_monthly_v3', true)).rejects.toThrow(/one_live_override/);
        await expect(insert(`osg-${randomUUID()}`, 'premium_monthly_v3', false)).rejects.toThrow(/one_live_grant/);
        await expect(insert(`osg-${randomUUID()}`, 'free_v3', false)).rejects.toThrow(/sku_kind/);
        const listed = (await read()).assignments as Record<string, unknown>[];
        expect(listed.map(a => [a.ref, Object.hasOwn(a, 'access_override')]).sort()).toEqual([[grant.assignment!.ref, false], [o.assignment!.ref, true]].sort());
        // The signed flag must match the stored kind: crossed, both refuse with a receipt and leave the rows as they were.
        const before = await live();
        const crossed = [command({ action: 'end', product: null, validity: null, assignment: { ref: o.assignment!.ref, expected_revision: 1 } }),
            command({ action: 'end', product: null, validity: null, assignment: { ref: grant.assignment!.ref, expected_revision: 1 }, access_override: true })];
        for (const body of crossed) expect(await send(body)).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' }, assignment: null });
        expect(await live()).toEqual(before);
        expect(await rows(sql`SELECT count(*)::int AS n FROM public.ezil_operator_entitlement_events WHERE result->>'outcome' = 'refused'
            AND command_id IN (${crossed[0]!.command_id as string}::uuid, ${crossed[1]!.command_id as string}::uuid)`)).toEqual([{ n: 2 }]);
        expect(await send(command({ action: 'end', product: null, validity: null, assignment: { ref: o.assignment!.ref, expected_revision: 1 }, access_override: true })))
            .toMatchObject({ effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'operator' } });
    });

    it('idempotency and receipts: an override replays; its refusals leave receipts without access', async () => {
        await open(true); await stripe();
        const body = override('free_v3');
        const first = await send(body);
        expect(await send(body)).toEqual({ ...first, outcome: 'replayed' });
        const plain: Record<string, unknown> = { ...body };
        delete plain.access_override;
        expect(await send(plain)).toMatchObject({ outcome: 'refused', refusal: { code: 'payload_mismatch' } });
        const past = override('premium_monthly_v3', { ends_at: new Date(now.getTime() - 1).toISOString() });
        expect(await send(past)).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' } });
        expect(await send(past)).toMatchObject({ outcome: 'refused', refusal: { code: 'invalid_command' } });
        expect(await rows(sql`SELECT result->>'outcome' AS outcome, assignment_ref IS NULL AS bare FROM public.ezil_operator_entitlement_events ORDER BY created_at`))
            .toEqual([{ outcome: 'applied', bare: false }, { outcome: 'refused', bare: true }]);
        expect(await live()).toEqual([{ ref: first.assignment!.ref, sku: 'free_v3', access_override: true }]);
    });
});
