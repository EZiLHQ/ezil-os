/**
 * Identity AI credits from the REAL Gateway `GET /v1/me/balance` shape, end to end on the server.
 *
 * The balance body is the one a live probe of staging account e2e-standard returned on 2026-11-01
 * (Standard plan): USD unit fields, the 0028 credit `window`, one operator grant, three live entitlement
 * grants and two revoked ones. Two gaps in that capture are filled from the Gateway's own serializer
 * (migrations 0031 `ezil_ai.balance`: every grant carries `expires_at`, NOT NULL in `ezil_ai.grants`):
 * the revoked grants' `expires_at` (not captured; any date at or after 2027-10-21 keeps the Gateway's
 * `order by expires_at`) and the window's `started_at`/`resets_at`. The probe did not capture
 * `/v1/me/usage`, so the open requests behind `held_micro` are synthetic, in the Gateway's
 * `request_json` shape (0021).
 *
 * The path is the real one: the tRPC `billing.summary` procedure → `readAiAccount` (`createAiReader`,
 * `parseAiBalanceMicro`, `parseAiGrants`, `parseAiOpenHolds`, `readAiUsage`, `readAiLimits`) →
 * `buildSummaryV3` → `aiAccountV3`; only `fetch` and the billing store are stubbed.
 *
 * The wire summaries it produces are pinned in shell/ezil/ui/Settings/ai-account-real-shape.fixture.json,
 * which shell/ezil/ui/Settings/credits-real-shape-browser-test.mjs renders in a real browser, so the
 * shell is tested with exactly what this server sends. Regenerate after an intended summary change:
 *   UPDATE_REAL_SHAPE_FIXTURE=1 npx vitest run src/server/billing/ai-account-real-shape.test.ts
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from './config';
import type { BillingDeps, BillingStore } from './ports';
import { aiCreditEntitlement } from './ai-credits';
import type { AiCreditReceipt } from './ai-credit-outbox';
import { CATALOG_V3 } from './v3/contract';
import type { createTRPCContext } from '@/server/api/trpc';
import { createBillingRouter } from '@/server/api/routers/billing';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn() }));

const FIXTURE = new URL('../../../../shell/ezil/ui/Settings/ai-account-real-shape.fixture.json', import.meta.url);
/** Synthetic Supabase user ids (the probe's real ids are not needed and not recorded). */
const USER_A = '6b1f4c2e-0d6a-4b7e-9c51-2f7a1e9d0a11', USER_B = '0c9e7a55-3f2b-4d8e-a6c4-9b1d2e3f4a5b';
const now = new Date('2026-11-01T07:00:00Z');

/** e2e-standard's `/v1/me/balance` as probed (see the header for the two filled gaps). */
const realBalance = () => ({
    account_public_id: '3d2c7b1a-9e8f-4a6b-8c5d-1e2f3a4b5c6d', micro_per_credit: 1000000, credit_currency: 'USD', usd_per_credit: '0.10',
    state: 'ok', available_micro: 1263815391, held_micro: 17409094,
    window: { seconds: 7200, started_at: '2026-11-01T06:00:00+00:00', resets_at: '2026-11-01T08:00:00+00:00',
        budget_micro: '5000000', used_micro: '220359', remaining_micro: '4779641' },
    grants: [
        { source: 'admin', credits_micro: 1000000000, remaining_micro: 963815391, live: true, expires_at: '2026-11-21T07:29:00Z', revoked_at: null },
        { source: 'entitlement', credits_micro: 200000000, remaining_micro: 200000000, live: true, expires_at: '2026-11-24T08:04:45Z' },
        { source: 'entitlement', credits_micro: 100000000, remaining_micro: 100000000, live: true, expires_at: '2027-10-21T00:00:00Z' },
        { source: 'entitlement', credits_micro: 4000000000, remaining_micro: 0, live: false, expires_at: '2027-10-27T00:00:00Z', revoked_at: '2026-10-28T00:00:00Z' },
        { source: 'entitlement', credits_micro: 500000000, remaining_micro: 0, live: false, expires_at: '2027-10-27T00:00:00Z', revoked_at: '2026-10-28T00:00:00Z' },
    ],
});

/** A `/v1/me/usage` row in the Gateway's `request_json` shape. */
const request = (createdAt: string, status: 'reserved' | 'pending' | 'settled', holdMicro: number, costMicro: number | null) => ({
    id: `req-${createdAt}`, billing_resolution: 'user', model: 'ezil-fast', status, stream: true, created_at: createdAt, hold_micro: holdMicro,
    pending_reason: status === 'pending' ? 'upstream_timeout' : null, settled_at: status === 'settled' ? createdAt : null,
    cost_micro: costMicro, uncollected_micro: status === 'settled' ? 0 : null,
});
/** The open requests (one in progress, one awaiting settlement) hold exactly `held_micro`, all placed after the revocation. */
const openUsage = () => ({ object: 'list', data: [
    request('2026-11-01T06:58:12.512345+00:00', 'reserved', 1409094, null),
    request('2026-11-01T06:41:07.104211+00:00', 'pending', 16000000, null),
    request('2026-11-01T06:30:00.000000+00:00', 'settled', 9000000, 220359),
] });

function gateway(balance: unknown, overrides: Record<string, unknown> = {}) {
    const bodies: Record<string, unknown> = { '/v1/me/balance': balance, '/v1/models': { killswitch: false, pause: null },
        '/v1/me/usage': openUsage(), '/v1/me/limits': { policy: { policy: {} }, pauses: [], entitlement: { required: false, basis: 'not_required' } }, ...overrides };
    return vi.fn<typeof fetch>(async url => {
        const body = bodies[new URL(String(url)).pathname];
        return body === undefined ? new Response('down', { status: 503 }) : Response.json(body);
    });
}

const subscriptionId = 'sub_e2eStandardFixture';
const periodStart = new Date('2026-10-21T08:04:45Z'), periodEnd = new Date('2026-11-21T08:04:45Z');
/** The OS receipts the real outbox would have stored for these grants, derived by the real `aiCreditEntitlement`. */
function receiptsA(): AiCreditReceipt[] {
    const plan = aiCreditEntitlement({ userId: USER_A, sku: 'standard_monthly_v3', subscriptionId, periodStart, periodEnd, invoiceId: 'in_e2eStandardFixture' });
    const starter = aiCreditEntitlement({ userId: USER_A, sku: 'free_v3', subscriptionId: null, periodStart: new Date('2026-10-21T00:00:00Z'), periodEnd: null, invoiceId: null });
    return [{ ...plan, deliveredAt: '2026-10-21T08:05:10.000Z' }, { ...starter, deliveredAt: '2026-10-21T00:00:05.000Z' }];
}

function fixture(userId: string, sku: 'free_v3' | 'standard_monthly_v3', receipts: () => Promise<AiCreditReceipt[]>) {
    const store = {
        subscriptionsFor: vi.fn().mockResolvedValue(sku === 'free_v3' ? [] : [{ sku, stripeSubscriptionId: subscriptionId, status: 'active',
            currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false }]),
        userCreatedAt: vi.fn().mockResolvedValue(new Date('2026-10-21T00:00:00Z')), openPlanChanges: vi.fn().mockResolvedValue([]),
        // This period's computer time (Standard), so the pane around the AI meter is an ordinary one, not "used up".
        epochsFor: vi.fn().mockResolvedValue([]), grantsForPeriod: vi.fn().mockResolvedValue(sku === 'free_v3' ? [] : [{ id: 'grant', userId, subscriptionId,
            meter: 'compute_std_seconds', kind: 'plan_period', amount: BigInt(CATALOG_V3[sku].fairUseSeconds), periodStart, periodEnd,
            sourceType: 'invoice', sourceId: 'in_e2eStandardFixture', createdAt: periodStart }]),
        latestConsent: vi.fn().mockResolvedValue(null), computerOwner: vi.fn().mockResolvedValue(null),
        openPaymentIssues: vi.fn().mockResolvedValue([]), latestStorageFor: vi.fn().mockResolvedValue([]), sizePreference: vi.fn().mockResolvedValue(null),
        stripeCustomerFor: vi.fn().mockResolvedValue(null), overageInvoicesFor: vi.fn().mockResolvedValue([]), enqueueOutbox: vi.fn().mockResolvedValue('queued'),
    };
    const deps: BillingDeps = { config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_FUNDING_URL: 'https://ai-staging.gateway.test' }),
        store: store as unknown as BillingStore, stripe: null, usage: null, now: () => now,
        aiCredits: { claim: vi.fn(), accountFor: vi.fn(), pinAccount: vi.fn(), finish: vi.fn(), receiptsFor: vi.fn(receipts) } };
    const ctx = { user: { id: userId }, headers: new Headers({ authorization: `Bearer token-${userId}` }), db: {} } as Awaited<ReturnType<typeof createTRPCContext>>;
    return createBillingRouter(() => deps).createCaller(ctx);
}

type Account = { userId: string | null; state: string; totalMicro: string | null; remainingMicro: string | null; heldMicro: string | null;
    usedMicro: string | null; planBaselineMicro: string | null; labelled: boolean; grants: { kind: string; creditsMicro: string }[] };
type Wire = Record<string, unknown> & { ai: Record<string, unknown> & { account: Account } };
/** What the shell receives: the DTO through JSON. */
async function summaryOf(userId: string, sku: 'free_v3' | 'standard_monthly_v3', fetcher: typeof fetch, receipts: () => Promise<AiCreditReceipt[]> = async () => receiptsA()) {
    vi.stubGlobal('fetch', fetcher);
    return JSON.parse(JSON.stringify(await fixture(userId, sku, receipts).summary())) as Wire;
}
/** The same user's `billing.usage` (the Usage pane's other read; it carries no AI figures). */
async function usageOf(userId: string, sku: 'free_v3' | 'standard_monthly_v3') {
    return JSON.parse(JSON.stringify(await fixture(userId, sku, async () => []).usage())) as Record<string, unknown>;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('ai.account from the real e2e-standard /v1/me/balance shape', () => {
    it('totals the three live grants (1,300), never the two revoked ones, and proves used = total − remaining − held', async () => {
        const fetcher = gateway(realBalance());
        const summary = await summaryOf(USER_A, 'standard_monthly_v3', fetcher);
        expect(summary.ai.account).toEqual({
            userId: USER_A, state: 'ok', asOf: '2026-11-01T07:00:00Z',
            totalMicro: '1300000000', remainingMicro: '1263815391', heldMicro: '17409094', usedMicro: '18775515',
            // The Standard catalog allowance is a label only (200 per period), never the denominator.
            planBaselineMicro: '200000000', labelled: true,
            grants: [
                { kind: 'added', creditsMicro: '1000000000', remainingMicro: '963815391', expiresAt: '2026-11-21T07:29:00.000Z' },
                { kind: 'plan', creditsMicro: '200000000', remainingMicro: '200000000', expiresAt: '2026-11-24T08:04:45.000Z' },
                { kind: 'starter', creditsMicro: '100000000', remainingMicro: '100000000', expiresAt: '2027-10-21T00:00:00.000Z' },
            ],
        });
        // The identity holds for these exact numbers: 1,300 − 1,263.815391 − 17.409094 = 18.775515.
        expect(BigInt('1300000000') - BigInt('1263815391') - BigInt('17409094')).toBe(BigInt('18775515'));
        const text = JSON.stringify(summary.ai.account);
        // Revoked 4,000 and 500, their sum with the live ones (5,800), and the credit window's budget figures never appear.
        for (const absent of ['4000000000', '500000000', '5800000000', '4779641', '220359']) expect(text).not.toContain(absent);
        // Only the member's own reads, with the member's bearer; never a payer or user selector.
        expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual(['/v1/me/balance', '/v1/me/limits', '/v1/me/usage', '/v1/models']);
        for (const [url, init] of fetcher.mock.calls) {
            expect(String(url)).not.toMatch(/userId|payer|subject/);
            expect(init?.headers).toEqual({ Authorization: `Bearer token-${USER_A}` });
        }
        // Server-side evidence never reaches the wire; the older fields still read the exact balance.
        for (const key of ['gatewayGrants', 'openHolds', 'gatewayState']) expect(summary.ai).not.toHaveProperty(key);
        expect(summary.ai).toMatchObject({ balanceMicro: '1263815391', heldMicro: '17409094', balance: 1263.815391, grant: { amount: 200, per: 'period' } });
        pin('ok', summary);
        const usage = await usageOf(USER_A, 'standard_monthly_v3');
        expect(JSON.stringify(usage)).not.toMatch(/credit|Micro/i);
        pin('usageA', usage);
    });

    it('the used figure follows the lane\'s rule: unexplained or pre-revocation holds leave it unproven (null), the rest unchanged', async () => {
        const expected = { totalMicro: '1300000000', remainingMicro: '1263815391', heldMicro: '17409094', planBaselineMicro: '200000000', labelled: true };
        // The usage page shows no open request, so held_micro is not proven to sit on live grants.
        const settledOnly = { object: 'list', data: [request('2026-11-01T06:30:00.000000+00:00', 'settled', 9000000, 220359)] };
        const unexplained = await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance(), { '/v1/me/usage': settledOnly }));
        expect(unexplained.ai.account).toMatchObject({ ...expected, usedMicro: null });
        pin('unproven', unexplained);
        // An open hold placed before the revocation (+5 min margin) may sit on a now-dead grant.
        const early = { object: 'list', data: [request('2026-11-01T06:58:12.512345+00:00', 'reserved', 1409094, null),
            request('2026-10-28T00:04:00.000000+00:00', 'pending', 16000000, null)] };
        expect((await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance(), { '/v1/me/usage': early }))).ai.account)
            .toMatchObject({ ...expected, usedMicro: null });
        // A platform-absorbed request releases its hold on the ledger but still counts in held_micro.
        const absorbed = openUsage();
        absorbed.data[1] = { ...absorbed.data[1]!, billing_resolution: 'platform_absorbed' };
        expect((await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance(), { '/v1/me/usage': absorbed }))).ai.account)
            .toMatchObject({ ...expected, usedMicro: null });
        // The usage page unreadable.
        expect((await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance(), { '/v1/me/usage': undefined }))).ai.account)
            .toMatchObject({ ...expected, usedMicro: null });
    });

    it('receipts only label: unreadable receipts keep the 1,300 total and drop the Plan/Added split', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const summary = await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance()), async () => { throw new Error('db down'); });
        expect(summary.ai.account).toMatchObject({ totalMicro: '1300000000', remainingMicro: '1263815391', usedMicro: '18775515', labelled: false });
        // Without the starter receipt the 100-credit entitlement is "added"; the operator grant stays "added" either way.
        const planOnly = await summaryOf(USER_A, 'standard_monthly_v3', gateway(realBalance()), async () => receiptsA().slice(0, 1));
        expect(planOnly.ai.account.grants.map(g => [g.kind, g.creditsMicro])).toEqual([['added', '1000000000'], ['plan', '200000000'], ['added', '100000000']]);
        expect(planOnly.ai.account).toMatchObject({ totalMicro: '1300000000', labelled: true });
    });

    it('an inconsistent read (available_micro ≠ Σ live remaining) has no total, never a guessed one', async () => {
        const balance = realBalance();
        balance.available_micro = 1263815390;
        expect((await summaryOf(USER_A, 'standard_monthly_v3', gateway(balance))).ai.account)
            .toMatchObject({ totalMicro: null, remainingMicro: '1263815390', usedMicro: null, grants: [] });
    });

    it('Gateway unavailable: the key stays for this user with no figures (the shell says so, never the catalog 200)', async () => {
        const down = await summaryOf(USER_A, 'standard_monthly_v3', vi.fn<typeof fetch>(async () => new Response('down', { status: 503 })));
        expect(down.ai.account).toEqual({ userId: USER_A, state: 'unavailable', asOf: '2026-11-01T07:00:00Z', totalMicro: null, remainingMicro: null,
            heldMicro: null, usedMicro: null, planBaselineMicro: '200000000', labelled: false, grants: [] });
        pin('unavailable', down);
    });

    it('user B (Free, one starter grant) reads only B\'s own balance: 37.25 of 100', async () => {
        const balance = { account_public_id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d', micro_per_credit: 1000000, credit_currency: 'USD', usd_per_credit: '0.10',
            state: 'ok', available_micro: 37250000, held_micro: 0,
            window: { seconds: 7200, started_at: '2026-11-01T06:00:00+00:00', resets_at: '2026-11-01T08:00:00+00:00', budget_micro: '5000000', used_micro: '0', remaining_micro: '5000000' },
            grants: [{ source: 'entitlement', credits_micro: 100000000, remaining_micro: 37250000, live: true, expires_at: '2027-10-30T10:00:00Z', revoked_at: null }] };
        const starter = aiCreditEntitlement({ userId: USER_B, sku: 'free_v3', subscriptionId: null, periodStart: new Date('2026-10-30T10:00:00Z'), periodEnd: null, invoiceId: null });
        const fetcher = gateway(balance, { '/v1/me/usage': { object: 'list', data: [] } });
        const b = await summaryOf(USER_B, 'free_v3', fetcher, async () => [{ ...starter, deliveredAt: '2026-10-30T10:00:05.000Z' }]);
        expect(b.ai.account).toEqual({ userId: USER_B, state: 'ok', asOf: '2026-11-01T07:00:00Z', totalMicro: '100000000', remainingMicro: '37250000',
            heldMicro: '0', usedMicro: '62750000', planBaselineMicro: '100000000', labelled: true,
            grants: [{ kind: 'starter', creditsMicro: '100000000', remainingMicro: '37250000', expiresAt: '2027-10-30T10:00:00.000Z' }] });
        for (const [, init] of fetcher.mock.calls) expect(init?.headers).toEqual({ Authorization: `Bearer token-${USER_B}` });
        pin('userB', b);
        pin('usageB', await usageOf(USER_B, 'free_v3'));
        // B's read with the Gateway down names B, with no figures (the shell must not fall back to A's kept balance).
        const down = await summaryOf(USER_B, 'free_v3', vi.fn<typeof fetch>(async () => new Response('down', { status: 503 })));
        expect(down.ai.account).toMatchObject({ userId: USER_B, state: 'unavailable', totalMicro: null, remainingMicro: null, grants: [] });
        pin('unavailableB', down);
    });

    it('the committed browser fixture is exactly what this server produced', () => {
        expect(Object.keys(produced).sort()).toEqual(['ok', 'unavailable', 'unavailableB', 'unproven', 'usageA', 'usageB', 'userB']);
        const expected = { ...produced, users: { a: USER_A, b: USER_B } };
        if (process.env.UPDATE_REAL_SHAPE_FIXTURE === '1') writeFileSync(FIXTURE, `${JSON.stringify(expected, null, 2)}\n`);
        expect(JSON.parse(readFileSync(FIXTURE, 'utf8'))).toEqual(expected);
    });
});

const produced: Record<string, unknown> = {};
function pin(name: string, summary: unknown) { produced[name] = summary; }
