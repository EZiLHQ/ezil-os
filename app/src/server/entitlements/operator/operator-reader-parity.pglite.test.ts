/** Offline PostgreSQL regressions for RF1–RF7. Set EZIL_PGLITE_MODULE to an installed PGlite ESM entry.
 * Production migration, transactions, resolvers and compute SQL; synthetic local identities only. */
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow } from '@/server/billing/ports';
import { billingV2EntitlementReader, gateComputerStart, loadComputeBillingState, paidComputeUnmeteredState } from '@/server/billing/v2/compute-access';
import { paidCloudflareCandidates } from '@/server/lib/compute/placement';
import { readPaidPoolEligibility } from '@/server/lib/compute/ready-pool';
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
const COMPUTER = '00000000-0000-4000-8000-000000000101';
const NOW = new Date('2026-11-04T13:30:00.000Z');
const START = '2026-10-24T00:00:00.000Z', END = '2026-11-24T00:00:00.000Z';
const REVISION = sourceCatalog().catalog_revision;
// Public RFC 8032 test vector, also used by the pinned Gateway signature fixture. Never a deployed sender key.
const TEST_PUBLIC = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64url');
const TEST_PRIVATE = createPrivateKey({ key: Buffer.from('302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex'), format: 'der', type: 'pkcs8' });

describe.skipIf(!MODULE)('operator reader parity on offline PostgreSQL', () => {
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
            currentPeriodStart: date(r.current_period_start), currentPeriodEnd: date(r.current_period_end), cancelAtPeriodEnd: r.cancel_at_period_end === true,
        })),
        openPaymentIssues: async (): Promise<PaymentIssueRow[]> => (await rows(sql`SELECT * FROM public.ezil_billing_payment_issues WHERE user_id = ${USER}::uuid`)).map(r => ({
            userId: USER, subscriptionId: String(r.subscription_id), invoiceKind: String(r.invoice_kind), issue: String(r.issue),
            resolvedAt: date(r.resolved_at), stripeEventCreated: date(r.stripe_event_created)!,
        } as PaymentIssueRow)),
        grantsForPeriod: async (): Promise<GrantRow[]> => (await rows(sql`SELECT * FROM public.ezil_billing_grants WHERE user_id = ${USER}::uuid`)).map(r => ({
            id: String(r.id), userId: USER, subscriptionId: String(r.subscription_id), meter: String(r.meter), amount: BigInt(String(r.amount)),
            periodStart: date(r.period_start), periodEnd: date(r.period_end), kind: 'plan_period', sourceType: 'invoice', sourceId: 'synthetic_receipt', createdAt: NOW,
        } as GrantRow)),
        userCreatedAt: async () => null, openPlanChanges: async () => [], epochsFor: async () => [], openEpochFor: async () => null, sizePreference: async () => 'cmp-8',
        operatorEntitlementsFor: (id: string) => readOperatorEntitlements(db, id),
    } as unknown as BillingStore;
    const billing: BillingDeps = { config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }), store, stripe: null, usage: null, now: () => now };
    const source = createOperatorEntitlementDeps(db, billing, () => now);
    const target = { kind: 'individual' as const, os_user_id: USER, account_public_id: ACCOUNT };
    const command = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        format: 'ezil.admin-entitlement-command.v1', command_id: randomUUID(), action: 'assign', producer: 'ezil-os', scope: 'individual',
        operator: { via: 'auth0_operator', actor: 'synthetic_operator', email: null }, product: { ref: 'standard_monthly_v3', catalog_revision: REVISION },
        target, quantity: null, starts_at: null, validity: { until_revoked: true }, reason: 'Synthetic local reader regression', assignment: null,
        billing_effect: 'none', credit_option: 'none', ...over,
    });
    const request = async (endpoint: Endpoint, body?: Record<string, unknown>) => {
        const method = body ? 'POST' : 'GET', timestamp = Math.floor(now.getTime() / 1000);
        const suffix = endpoint === 'assignments' ? `?os_user_id=${USER}&account_public_id=${ACCOUNT}` : '';
        const url = new URL(`https://os.synthetic.test/api/gateway/admin-entitlements/v1/${endpoint}${suffix}`);
        const text = body ? JSON.stringify(body) : '', bytes = new TextEncoder().encode(text);
        const signature = sign(null, signingInput(method, url.pathname + url.search, timestamp, bytes), TEST_PRIVATE).toString('base64url');
        return handleAdminEntitlementRequest(new Request(url, { method, body: body ? text : undefined,
            headers: { [HEADERS.kid]: 'synthetic-ae', [HEADERS.timestamp]: String(timestamp), [HEADERS.signature]: signature } }),
            endpoint, { deps: async () => source, nowSeconds: () => timestamp });
    };
    const send = async (body: Record<string, unknown>): Promise<Result> => {
        const response = await request('commands', body); expect(response.status).toBe(200); return response.json();
    };
    const assign = async (sku = 'standard_monthly_v3') => {
        const result = await send(command({ product: { ref: sku, catalog_revision: REVISION } }));
        expect(result.outcome).toBe('applied'); return result;
    };
    const stripe = (status: string, sku = 'premium_monthly_v3', start = START, end = END) => db.execute(sql`
        INSERT INTO public.ezil_billing_subscriptions VALUES ('sub_synthetic', ${USER}::uuid, ${sku}, ${status}, ${start}::timestamptz, ${end}::timestamptz, false)`);
    const receipt = (amount = 1_800_000) => db.execute(sql`INSERT INTO public.ezil_billing_grants
        (id, user_id, subscription_id, meter, amount, period_start, period_end)
        VALUES (${randomUUID()}, ${USER}::uuid, 'sub_synthetic', 'compute_std_seconds', ${amount}, ${START}::timestamptz, ${END}::timestamptz)`);
    const pool = () => readPaidPoolEligibility(db, USER, now);
    const migration = () => paidCloudflareCandidates(db, now);
    const state = () => loadComputeBillingState(billing, USER, now);
    const reader = () => billingV2EntitlementReader(() => billing).read(USER);
    const assignmentRead = async () => { const response = await request('assignments'); expect(response.status).toBe(200); return response.json(); };

    beforeAll(async () => {
        const { PGlite } = await import(/* @vite-ignore */ MODULE!);
        pg = new PGlite() as LocalPg;
        await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA ezil_works;
            CREATE TABLE auth.users (id uuid PRIMARY KEY, deleted_at timestamptz, banned_until timestamptz, is_anonymous boolean);
            CREATE TABLE ezil_works.ai_members (auth_user_id uuid, public_id uuid);
            CREATE TABLE public.ezil_billing_subscriptions (stripe_subscription_id text PRIMARY KEY, user_id uuid, sku text, status text,
                current_period_start timestamptz, current_period_end timestamptz, cancel_at_period_end boolean);
            CREATE TABLE public.ezil_billing_size_preferences (user_id uuid PRIMARY KEY, size text);
            CREATE TABLE public.ezil_billing_grants (id text, user_id uuid, subscription_id text, meter text, amount bigint, period_start timestamptz, period_end timestamptz);
            CREATE TABLE public.ezil_billing_payment_issues (user_id uuid, subscription_id text, invoice_kind text, resolved_at timestamptz, issue text, stripe_event_created timestamptz);
            CREATE TABLE public.ezil_computers (id uuid PRIMARY KEY, user_id uuid, slot int DEFAULT 1, deleted_at timestamptz);
            CREATE TABLE public.ezil_computer_placements (computer_id uuid PRIMARY KEY, provider text);
            CREATE TABLE public.ezil_compute_migrations (computer_id uuid, user_id uuid, state text, last_error text, updated_at timestamptz);`);
        await pg.exec(readFileSync(path.resolve(__dirname, '../../../../drizzle/0019_operator_entitlements.sql'), 'utf8'));
    });
    beforeEach(async () => {
        now = new Date(NOW); resetOperatorEntitlementsInstalled();
        vi.stubEnv(SENDER_KEYS_ENV, JSON.stringify({ 'synthetic-ae': TEST_PUBLIC }));
        await pg.exec(`TRUNCATE public.ezil_operator_entitlement_events, public.ezil_operator_entitlements, auth.users, ezil_works.ai_members,
            public.ezil_billing_subscriptions, public.ezil_billing_grants, public.ezil_billing_payment_issues,
            public.ezil_billing_size_preferences, public.ezil_computers, public.ezil_computer_placements, public.ezil_compute_migrations CASCADE;
            INSERT INTO auth.users (id) VALUES ('${USER}'); INSERT INTO ezil_works.ai_members VALUES ('${USER}', '${ACCOUNT}');
            INSERT INTO public.ezil_computers (id, user_id) VALUES ('${COMPUTER}', '${USER}');
            INSERT INTO public.ezil_billing_size_preferences VALUES ('${USER}', 'cmp-8');`);
    });
    afterEach(() => vi.unstubAllEnvs());
    afterAll(async () => { await pg?.close(); });

    it.each([
        ['expired fallback grace', 'past_due', null, null],
        ['expired issue grace', 'active', 'payment_failed', '2026-10-28T13:30:00.000Z'],
        ['Stripe final action', 'active', 'uncollectible', '2026-11-04T13:29:00.000Z'],
    ])('RF1: %s lets the existing operator grant decide every reader', async (_name, status, issue, issueAt) => {
        await assign(); await stripe(status!);
        if (issue) await db.execute(sql`INSERT INTO public.ezil_billing_payment_issues VALUES
            (${USER}::uuid, 'sub_synthetic', 'subscription', NULL, ${issue}, ${issueAt}::timestamptz)`);
        expect((await state()).planSku).toBe('standard_monthly_v3');
        expect(await reader()).toMatchObject({ status: 'active', planId: 'standard_monthly_v3' });
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'operator' } });
        expect(await pool()).toEqual({ instanceType: 'm6i.large' });
        expect(await migration()).toEqual([{ userId: USER, computerId: COMPUTER, toSize: 'standard' }]);
    });

    it('RF1: live renewal grace wins without a receipt, then the operator takes over at its exact end', async () => {
        await assign(); await stripe('past_due', 'premium_monthly_v3', '2026-11-01T13:30:00.000Z');
        expect(await reader()).toMatchObject({ status: 'active', planId: 'premium_monthly_v3' });
        expect(await pool()).toEqual({ instanceType: 'm6i.2xlarge' });
        expect(await migration()).toEqual([{ userId: USER, computerId: COMPUTER, toSize: 'premium' }]);
        now = new Date('2026-11-08T13:30:00.000Z');
        expect((await state()).planSku).toBe('standard_monthly_v3');
        expect(await pool()).toEqual({ instanceType: 'm6i.large' });
    });

    it.each([0, -1])('RF3: unfunded/refunded Stripe (%s) still conflicts, but reports no paid access and cannot fall through to operator', async amount => {
        await assign(); await stripe('active', 'standard_monthly_v3');
        if (amount < 0) { await receipt(); await receipt(-1_800_000); }
        expect((await state()).planSku).toBe('standard_monthly_v3');
        expect(paidComputeUnmeteredState(await state())).toBe(false);
        expect(await reader()).toMatchObject({ status: 'expired', planId: 'standard_monthly_v3' });
        expect(await gateComputerStart({ deps: billing, userId: USER, computerId: COMPUTER, kind: 'aws-ec2', instanceType: 'm6i.large', now })).toMatchObject({ allowed: false, reason: 'fair_use_paused' });
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'none', product_ref: null, via: null }, stripe: { state: 'active', product_ref: 'standard_monthly_v3' } });
        expect(await send(command())).toMatchObject({ refusal: { code: 'paid_subscription_conflict' }, effective_access: { state: 'none' } });
        expect(await pool()).toBeNull(); expect(await migration()).toEqual([]);
        expect(await rows(sql`SELECT * FROM public.ezil_operator_entitlements`)).toHaveLength(1);
        expect(await rows(sql`SELECT * FROM public.ezil_operator_entitlement_events`)).toHaveLength(1);
    });

    it('RF1: a current Stripe source wins over a later delinquent row, without borrowing its funding', async () => {
        await assign(); await stripe('past_due', 'premium_monthly_v3', '2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
        await db.execute(sql`INSERT INTO public.ezil_billing_subscriptions VALUES
            ('sub_current', ${USER}::uuid, 'standard_monthly_v3', 'active', ${START}::timestamptz, ${END}::timestamptz, false)`);
        await receipt(); // Only the losing delinquent subscription is funded.
        expect(await reader()).toMatchObject({ status: 'expired', planId: 'standard_monthly_v3' });
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'none' } });
        expect(await pool()).toBeNull(); expect(await migration()).toEqual([]);
    });

    it('RF1: a refunded grace receipt is real zero, so neither grace nor operator bypass restores funding', async () => {
        await assign(); await stripe('past_due', 'premium_monthly_v3', '2026-11-01T13:30:00Z');
        await receipt(); await receipt(-1_800_000);
        expect(await reader()).toMatchObject({ status: 'expired', planId: 'premium_monthly_v3' });
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'none' } });
        expect(await send(command())).toMatchObject({ refusal: { code: 'paid_subscription_conflict' } });
        expect(await pool()).toBeNull(); expect(await migration()).toEqual([]);
    });

    it('RF4: a recorded license survives command key rotation and removal in every reader', async () => {
        await assign();
        for (const keys of [JSON.stringify({ rotated: TEST_PUBLIC }), '']) {
            vi.stubEnv(SENDER_KEYS_ENV, keys); resetOperatorEntitlementsInstalled();
            expect((await request('assignments')).status).toBe(keys ? 401 : 503);
            expect(await reader()).toMatchObject({ status: 'active', planId: 'standard_monthly_v3' });
            expect(await pool()).toEqual({ instanceType: 'm6i.large' });
            expect(await migration()).toEqual([{ userId: USER, computerId: COMPUTER, toSize: 'standard' }]);
        }
    });

    it('RF6: funded Stripe Standard wins before sizing an until-revoked operator Premium migration', async () => {
        await assign('premium_monthly_v3'); await stripe('active', 'standard_monthly_v3'); await receipt(144_000);
        expect((await state()).planSku).toBe('standard_monthly_v3');
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'active', product_ref: 'standard_monthly_v3', via: 'stripe' } });
        expect(await pool()).toEqual({ instanceType: 'm6i.large' });
        expect(await migration()).toEqual([{ userId: USER, computerId: COMPUTER, toSize: 'standard' }]);
        expect(await rows(sql`SELECT * FROM public.ezil_billing_subscriptions`)).toHaveLength(1);
        expect(await rows(sql`SELECT * FROM public.ezil_billing_grants`)).toHaveLength(1);
    });

    it('RF7: near-now starts are normalized; a second assign cannot close or revive the first grant', async () => {
        const first = await send(command({ starts_at: '2026-11-04T13:34:00.000Z', validity: { ends_at: '2026-12-01T00:00:00.000Z' } }));
        expect(first).toMatchObject({ outcome: 'applied', assignment: { starts_at: NOW.toISOString() }, effective_access: { via: 'operator' } });
        now = new Date('2026-11-04T13:31:00.000Z');
        expect(await send(command({ product: { ref: 'premium_monthly_v3', catalog_revision: REVISION } }))).toMatchObject({ refusal: { code: 'invalid_command' } });
        now = new Date('2026-11-04T13:34:00.000Z');
        expect((await state()).planSku).toBe('standard_monthly_v3'); expect(await pool()).toEqual({ instanceType: 'm6i.large' });
        expect(await rows(sql`SELECT ended_at FROM public.ezil_operator_entitlements`)).toEqual([{ ended_at: null }]);
        expect(await rows(sql`SELECT * FROM public.ezil_operator_entitlement_events`)).toHaveLength(1);
    });

    it('RF7: a legacy future-start row is never closed as lapsed; a genuinely expired grant closes at its own end', async () => {
        await db.execute(sql`INSERT INTO public.ezil_operator_entitlements (ref, user_id, account_public_id, sku, revision, starts_at, ends_at)
            VALUES ('osg-00000000-0000-4000-8000-000000000099', ${USER}::uuid, ${ACCOUNT}::uuid, 'standard_monthly_v3', 1,
                '2026-11-04T13:34:00Z'::timestamptz, '2026-11-05T00:00:00Z'::timestamptz)`);
        expect(await send(command())).toMatchObject({ refusal: { code: 'invalid_command' } });
        expect(await rows(sql`SELECT ended_at FROM public.ezil_operator_entitlements`)).toEqual([{ ended_at: null }]);
        now = new Date('2026-11-05T00:00:00.000Z');
        expect(await send(command())).toMatchObject({ outcome: 'applied' });
        const grants = await readOperatorEntitlements(db, USER);
        expect(grants.find(g => g.ref.endsWith('000000000099'))?.endedAt?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
    });

    it('RF7: actual closure is terminal even if an old invalid ended_at lies in the future', async () => {
        await assign();
        await db.execute(sql`UPDATE public.ezil_operator_entitlements SET ended_at = '2026-12-01T00:00:00Z'::timestamptz`);
        expect(await assignmentRead()).toMatchObject({ effective_access: { state: 'none' }, assignments: [{ state: 'ended' }] });
        expect((await state()).planSku).toBe('free_v3'); expect(await pool()).toBeNull(); expect(await migration()).toEqual([]);
    });
});
