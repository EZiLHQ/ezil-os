import { afterEach, describe, expect, it, vi } from 'vitest';

import { pushAiPlan } from '../../lib/ai-credential';
import { createHmac, createHash } from 'node:crypto';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow } from '../ports';
import { aiIncludedModels, aiIncludedModelsFor, FREE_AI_MODELS, STANDARD_AI_MODELS, PREMIUM_ONLY_AI_MODELS } from './ai-models';
import type { OperatorEntitlementRow } from './operator-access';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const USER = 'user_a';
const DAY = 86_400_000;
const NOW = new Date('2026-10-18T12:00:00.789Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const START = ago(8 * DAY), END = new Date(NOW.getTime() + 22 * DAY);

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    stripeSubscriptionId: 'sub_a', sku: 'standard_monthly_v3', status: 'active',
    currentPeriodStart: START, currentPeriodEnd: END, cancelAtPeriodEnd: false, ...over,
});
const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
    id: 'grant_a', userId: USER, subscriptionId: 'sub_a', meter: 'compute_std_seconds', kind: 'plan_period',
    amount: BigInt(144_000), periodStart: START, periodEnd: END, sourceType: 'invoice', sourceId: 'in_a', createdAt: START, ...over,
});
const issue = (stripeEventCreated: Date): PaymentIssueRow => ({
    stripeInvoiceId: 'in_issue', userId: USER, subscriptionId: 'sub_a', invoiceKind: 'subscription', issue: 'payment_failed',
    hostedInvoiceUrl: null, stripeEventCreated, updatedAt: stripeEventCreated, resolvedAt: null,
});
const operatorGrant = (): OperatorEntitlementRow => ({ ref: 'osg-00000000-0000-4000-8000-000000000001', revision: 1, userId: USER,
    accountPublicId: '10000000-0000-4000-8000-0000000000a1', sku: 'standard_monthly_v3', startsAt: ago(DAY), endsAt: new Date(NOW.getTime() + 30 * DAY), endedAt: null });
// A failed renewal: the period moved on and its invoice is unpaid (compute-access.test.ts round 4).
const renewal = () => subscription({ status: 'past_due', currentPeriodStart: ago(2 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 28 * DAY) });

/** The reads loadComputeBillingState makes, over fixed rows; every other store access is an error. */
function deps(rows: { subs?: SubscriptionRow[]; grants?: GrantRow[]; paymentIssues?: PaymentIssueRow[]; operator?: OperatorEntitlementRow[] } = {},
    config = readBillingConfig({ BILLING_TAB_ENABLED: '1' })): BillingDeps {
    const methods = {
        subscriptionsFor: async () => rows.subs ?? [], operatorEntitlementsFor: async () => rows.operator ?? [],
        userCreatedAt: async () => null, openPlanChanges: async () => [], epochsFor: async () => [],
        grantsForPeriod: async () => rows.grants ?? [], latestConsent: async () => null,
        openPaymentIssues: async () => rows.paymentIssues ?? [], sizePreference: async () => null,
    } satisfies Partial<BillingStore>;
    const store = new Proxy(methods, {
        get(target, key) {
            if (!(key in target)) throw new Error(`Unexpected store access: ${String(key)}`);
            return target[key as keyof typeof target];
        },
    }) as unknown as BillingStore;
    return { config, store, stripe: null, usage: null, now: () => NOW };
}

afterEach(() => vi.restoreAllMocks());

describe('aiIncludedModels: Free includes a curated low-tier set (Flash first); Standard has a closed model list; Premium includes every model', () => {
    it('keys on the plan the computer runs under', () => {
        expect(FREE_AI_MODELS).toEqual(['gemini-3.8-flash', 'qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3']);
        // Bounded and valid for the Worker push (1-16 distinct aliases): at most 3, Flash first as the preferred default.
        expect(FREE_AI_MODELS.length).toBeLessThanOrEqual(3);
        expect(FREE_AI_MODELS[0]).toBe('gemini-3.8-flash');
        expect(new Set(FREE_AI_MODELS).size).toBe(FREE_AI_MODELS.length);
        for (const alias of FREE_AI_MODELS) expect(alias).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
        for (const sku of ['free_v3', 'free_v2', 'free_v1_legacy'] as const) expect(aiIncludedModels(sku)).toBe(FREE_AI_MODELS);
        for (const sku of ['standard_monthly_v3', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'] as const) {
            expect(aiIncludedModels(sku)).toBe(STANDARD_AI_MODELS);
        }
    });

    it('keeps Premium unrestricted and lower plans closed to protected and future aliases', () => {
        expect(aiIncludedModels('premium_monthly_v3')).toBeNull();
        expect(aiIncludedModels('unknown' as Parameters<typeof aiIncludedModels>[0])).toBe(FREE_AI_MODELS);
        expect(STANDARD_AI_MODELS).toHaveLength(14);
        expect(new Set(STANDARD_AI_MODELS).size).toBe(14);
        expect(STANDARD_AI_MODELS.length).toBeLessThanOrEqual(16);
        for (const alias of STANDARD_AI_MODELS) expect(alias).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
        for (const alias of PREMIUM_ONLY_AI_MODELS) {
            expect(FREE_AI_MODELS).not.toContain(alias); expect(STANDARD_AI_MODELS).not.toContain(alias);
        }
        for (const alias of FREE_AI_MODELS) expect(STANDARD_AI_MODELS).toContain(alias);
        expect(STANDARD_AI_MODELS).toContain('claude-opus-5-5');
        expect(STANDARD_AI_MODELS).toContain('gpt-6.1-sol');
        expect(STANDARD_AI_MODELS).not.toContain('unregistered-future-model');
    });

    it.each([
        ['Free (no subscription)', {}, FREE_AI_MODELS],
        ['Standard, paid this period', { subs: [subscription()], grants: [grant()] }, STANDARD_AI_MODELS],
        ['Standard trial', { subs: [subscription({ status: 'trialing' })], grants: [grant()] }, STANDARD_AI_MODELS],
        ['Premium, paid this period', { subs: [subscription({ sku: 'premium_monthly_v3' })], grants: [grant({ amount: BigInt(1_800_000) })] }, null],
        ['operator-granted Standard (no Stripe)', { operator: [operatorGrant()] }, STANDARD_AI_MODELS],
        ['legacy Standard v2', { subs: [subscription({ sku: 'standard_monthly_v2' })], grants: [grant({ amount: BigInt(216_000) })] }, STANDARD_AI_MODELS],
        ['legacy Compute v2', { subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant({ amount: BigInt(216_000) })] }, STANDARD_AI_MODELS],
        ['legacy v2 past_due (runs as Free)', { subs: [subscription({ sku: 'standard_monthly_v2', status: 'past_due' })] }, FREE_AI_MODELS],
        ['Standard renewal unpaid, inside its seven-day grace', { subs: [renewal()], paymentIssues: [issue(ago(2 * DAY))] }, STANDARD_AI_MODELS],
        ['Standard renewal unpaid, grace ended (runs as Free)', { subs: [renewal()], paymentIssues: [issue(ago(7 * DAY))] }, FREE_AI_MODELS],
        ['Standard cancelled (runs as Free)', { subs: [subscription({ status: 'canceled' })], grants: [grant()] }, FREE_AI_MODELS],
        ['Standard never paid (incomplete)', { subs: [subscription({ status: 'incomplete' })] }, FREE_AI_MODELS],
    ] as const)('%s', async (_name, rows, expected) => {
        expect(await aiIncludedModelsFor(USER, () => deps(rows as Parameters<typeof deps>[0]))).toEqual(expected);
    });

    it('billing metering off: every model, with no billing read', async () => {
        const off = deps({}, readBillingConfig({}));
        off.store = new Proxy({}, { get: () => { throw new Error('no read while metering is off'); } }) as BillingStore;
        expect(await aiIncludedModelsFor(USER, () => off)).toBeNull();
    });

    it('a failed read or composition is unknown (undefined), never every model, and never throws', async () => {
        const failing = deps({});
        failing.store = new Proxy({}, { get: () => async () => { throw new Error('db down'); } }) as BillingStore;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await aiIncludedModelsFor(USER, () => failing)).toBeUndefined();
        expect(await aiIncludedModelsFor(USER, () => { throw new Error('no config'); })).toBeUndefined();
        expect(warn).toHaveBeenCalledWith('[billing.ai-models] plan read failed', { userId: USER });
    });
});

// The normal app refresh signs the exact selected policy, without a Worker or provider.
it('pushes refreshed Standard over old null, keeps the prior policy on read error, and clears it on successful Premium', async () => {
    const sandbox = 'guac-abcdef0123456789-fedcba9876543210';
    const testKey = 'offline-model-policy-hmac-fixture-only';
    const now = Date.now();
    let stored: readonly string[] | null = null;
    let pushes = 0;
    const config = { workerUrl: 'https://worker.invalid', hasHmacSecret: true, isConfigured: true } as Parameters<typeof pushAiPlan>[0];
    const receive: typeof fetch = async (input, init) => {
        pushes++;
        const request = new Request(input, init);
        const endpoint = `/sandbox/${sandbox}/ai-credential`;
        expect(new URL(request.url).pathname).toBe(endpoint);
        const body = await request.text();
        const digest = createHash('sha256').update(body).digest('hex');
        const signature = createHmac('sha256', testKey).update(`${now}.POST.${endpoint}.${digest}`).digest('hex');
        expect(request.headers.get('x-ezil-signature')).toBe(`t=${now},v1=${signature}`);
        stored = JSON.parse(body).includedModels;
        return Response.json({ ok: true, planStored: true });
    };
    const refresh = async (models: readonly string[] | null | undefined) => {
        if (models !== undefined) expect(await pushAiPlan(config, testKey, sandbox, models, new AbortController().signal, receive, now)).toEqual({ ok: true, stored: true });
    };
    await refresh(await aiIncludedModelsFor(USER, () => deps({ subs: [subscription()], grants: [grant()] })));
    expect(stored).toEqual(STANDARD_AI_MODELS);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refresh(await aiIncludedModelsFor(USER, () => { throw new Error('offline'); }));
    expect(pushes).toBe(1); expect(stored).toEqual(STANDARD_AI_MODELS);
    await refresh(await aiIncludedModelsFor(USER, () => deps({ subs: [subscription({ sku: 'premium_monthly_v3' })], grants: [grant({ amount: BigInt(1_800_000) })] })));
    expect(pushes).toBe(2); expect(stored).toBeNull();
});
