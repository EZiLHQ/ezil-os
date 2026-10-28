import { describe, expect, it } from 'vitest';
import { offeredPack } from '../stripe/packs.test-support';
import { readBillingConfig } from '../config';
import { CATALOG_V3, type SellableSkuV3 } from './contract';
import { buildSummaryV3, usedSecondsInWindow } from './summary';

const now = new Date('2026-10-19T12:00:00Z');
const start = new Date('2026-10-10T00:00:00Z'), end = new Date('2026-11-10T00:00:00Z');
type Input = Parameters<typeof buildSummaryV3>[0];
function input(sku?: SellableSkuV3): Input {
    return { config: readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }), now, userCreatedAt: null,
        subs: sku ? [{ sku, stripeSubscriptionId: 'sub', status: 'active', currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }] : [],
        epochs: [], grants: sku ? [{ id: 'grant', userId: 'u', subscriptionId: 'sub', kind: 'plan_period', meter: 'compute_std_seconds',
            amount: BigInt(CATALOG_V3[sku].fairUseSeconds), periodStart: start, periodEnd: end, sourceType: 'invoice', sourceId: 'in', createdAt: start }] : [],
        consent: null, planChanges: [], paymentIssues: [], storage: [], sizePreference: null, hasCustomer: !!sku,
        packs: [offeredPack],
        renewal: sku ? { at: '2026-11-10T00:00:00Z', amountCents: 1700 } : null };
}
const epoch = (overrides: Partial<Input['epochs'][number]> = {}): Input['epochs'][number] => ({ id: 'e', userId: 'u', computerId: 'c',
    size: 'cmp-4', weight: 2, readyAt: '2026-10-19T11:00:00Z', endedAt: null, endReason: null, overheadSeconds: 100, ...overrides });

function sessions(hours: number, size: 'std-2' | 'cmp-8'): Input['epochs'] {
    return Array.from({ length: Math.ceil(hours / 6) }, (_, i) => epoch({ id: `session_${i}`, size,
        weight: size === 'cmp-8' ? 4 : 1, readyAt: new Date(start.getTime() + i * 6 * 3600000).toISOString(),
        endedAt: new Date(start.getTime() + Math.min(hours, (i + 1) * 6) * 3600000).toISOString(),
    }));
}

describe('v3 summary', () => {
    it.each([undefined, 'standard_monthly_v3', 'premium_monthly_v3'] as const)('offers top-ups independently of subscription checkout for %s', sku => {
        const summary = buildSummaryV3(input(sku));
        expect(summary.actions.topup).toBe(true);
        expect(summary.catalog.packs).toEqual([
            { sku: 'ai_pack_fixture', aiCredits: 1000, creditCents: 10000, discountPercent: 20, totalCents: 8000, currency: 'usd' },
        ]);
        expect(summary.catalog.customTopup).toEqual({ minCents: 1000, maxCents: 1000000, centsPerCredit: 10 });
    });
    it.each(['flag', 'secret'] as const)('disables top-ups without the checkout %s', missing => {
        const args = input();
        if (missing === 'flag') args.config.checkoutEnabled = false;
        else args.config.stripeSecret = undefined;
        expect(buildSummaryV3(args).actions).toMatchObject({ checkout: false, topup: false });
    });
    it('keeps custom checkout available when Stripe offers no packs', () => {
        const summary = buildSummaryV3({ ...input(), packs: [] });
        expect(summary.actions).toMatchObject({ checkout: true, topup: true });
        expect(summary.catalog.packs).toEqual([]);
        expect(buildSummaryV3({ ...input(), stripeAvailable: false }).actions.topup).toBe(false);
    });
    it.each([[100, 400, 'near'], [125, 500, 'paused']] as const)(
        '%s hours at cmp-8 uses %s standard-hours and is %s', (hours, standardHours, status) => {
            const args = input('premium_monthly_v3');
            args.epochs = sessions(hours, 'cmp-8');
            expect(usedSecondsInWindow(args.epochs, { start: start.toISOString(), end: end.toISOString() }, now)).toBe(standardHours * 3600);
            expect(buildSummaryV3(args).fairUse.status).toBe(status);
        });
    it('one hour at cmp-8 is four standard-hours and verifies stored weights', () => {
        const window = { start: start.toISOString(), end: end.toISOString() };
        expect(usedSecondsInWindow([epoch({ size: 'cmp-8', weight: 4 })], window, now)).toBe(14400);
        expect(() => usedSecondsInWindow([epoch({ size: 'cmp-8', weight: 2 })], window, now)).toThrow(RangeError);
    });
    it('clips usage at the deadline, now, and window end', () => {
        const e = epoch({ size: 'cmp-8', weight: 4, endedAt: '2026-10-19T15:00:00Z', deadlineAt: '2026-10-19T11:30:00Z' });
        const window = { start: start.toISOString(), end: end.toISOString() };
        expect(usedSecondsInWindow([e], window, now)).toBe(7200);
        expect(usedSecondsInWindow([{ ...e, deadlineAt: null }], window, now)).toBe(14400);
        expect(usedSecondsInWindow([e], { ...window, end: '2026-10-19T11:15:00Z' }, now)).toBe(3600);
    });
    it('bounds the active deadline by the running weight, even after a preference change', () => {
        const args = input('premium_monthly_v3');
        args.sizePreference = 'std-2';
        args.epochs = [epoch({ size: 'cmp-8', weight: 4 })];
        args.grants = [{ ...args.grants[0]!, amount: BigInt(14400 + 241) }];
        expect(buildSummaryV3(args).computer.activeDeadline).toBe('2026-10-19T12:01:00Z');
    });
    it.each([['std-2', 2, 8], ['cmp-4', 4, 16], ['cmp-8', 8, 32]] as const)(
        'reports selected Premium %s and all choices', (size, vcpu, memoryGiB) => {
            const args = input('premium_monthly_v3'); args.sizePreference = size;
            expect(buildSummaryV3(args).computer).toMatchObject({ size, vcpu, memoryGiB,
                machineChoice: [{ size: 'std-2', weight: 1 }, { size: 'cmp-4', weight: 2 }, { size: 'cmp-8', weight: 4 }] });
            args.subs[0]!.sku = 'standard_monthly_v3';
            expect(buildSummaryV3(args).computer).toMatchObject({ size: 'std-2', vcpu: 2, memoryGiB: 8 });
        });
    it('defaults Premium to std-2 and rejects an incompatible stored preference', () => {
        const args = input('premium_monthly_v3');
        expect(buildSummaryV3(args).computer.size).toBe('std-2');
        args.sizePreference = 'free-cf';
        expect(buildSummaryV3(args).computer.size).toBe('std-2');
        args.subs = []; args.sizePreference = 'cmp-8';
        expect(buildSummaryV3(args).computer.size).toBe('free-cf');
    });

    it('Free wire shape has one fair-use status and no usage meters', () => {
        const summary = buildSummaryV3(input());
        expect(summary).toMatchObject({ enabled: true, version: 3, plan: { sku: 'free_v3', name: 'Free', status: 'free', renewal: null },
            computer: { vcpu: 2, memoryGiB: 6, sessionMaxSeconds: 3600, opening: 'standard', activeDeadline: null },
            fairUse: { status: 'ok', resetsAt: '2026-11-01T00:00:00Z' }, actions: { checkout: true, upgrade: false }, catalog: { version: 3 } });
        expect(Object.keys(summary).sort()).toEqual(['enabled', 'version', 'plan', 'computer', 'fairUse', 'storage', 'actions', 'catalog', 'ai'].sort());
        expect(Object.keys(summary.fairUse)).toEqual(['status', 'resetsAt']);
    });
    it('uses the next invoice amount and date, not catalog price or past charges', () => {
        const summary = buildSummaryV3(input('standard_monthly_v3'));
        expect(summary.plan.renewal).toEqual({ at: '2026-11-10T00:00:00Z', amountCents: 1700 });
        expect(summary.fairUse.resetsAt).toBe('2026-11-10T00:00:00Z');
        expect(summary.actions).toMatchObject({ checkout: false, upgrade: true });
        const args = input('standard_monthly_v3'); args.subs[0]!.cancelAtPeriodEnd = true;
        expect(buildSummaryV3(args).plan).toMatchObject({ status: 'cancels', renewal: null, cancelsAt: '2026-11-10T00:00:00Z' });
    });
    it('counts weighted running time across sizes, clips the window, and excludes overhead', () => {
        expect(usedSecondsInWindow([epoch({ readyAt: '2026-10-09T23:00:00Z', endedAt: '2026-10-10T01:00:00Z' }), epoch()],
            { start: start.toISOString(), end: end.toISOString() }, now)).toBe(14400);
        const args = input('premium_monthly_v3'); args.epochs = [epoch()]; args.sizePreference = 'cmp-4';
        expect(buildSummaryV3(args).computer).toMatchObject({ vcpu: 4, memoryGiB: 16, sessionMaxSeconds: null, opening: 'standard', activeDeadline: '2026-10-29T21:00:00Z' });
    });
    it.each([[0.8, 'near'], [1, 'paused']] as const)('reports %s usage as %s', (ratio, status) => {
        const args = input('standard_monthly_v3');
        args.epochs = sessions(40 * ratio, 'std-2');
        expect(buildSummaryV3(args).fairUse.status).toBe(status);
    });
    it('ignores grants for other subscriptions and stops after a refund reversal', () => {
        const args = input('standard_monthly_v3');
        args.grants = [{ ...args.grants[0]!, subscriptionId: 'other' }];
        expect(buildSummaryV3(args).fairUse.status).toBe('paused');
        const paid = input('standard_monthly_v3'); paid.grants = [...paid.grants, { ...paid.grants[0]!, amount: -paid.grants[0]!.amount, kind: 'revoke' }];
        expect(buildSummaryV3(paid).fairUse.status).toBe('paused');
    });
    it('isolates pending changes and payment issues to the selected subscription', () => {
        const args = input('standard_monthly_v3');
        args.planChanges = [{ id: 'change', userId: 'u', subscriptionId: 'sub', fromSku: 'standard_monthly_v3', toSku: 'premium_monthly_v3',
            kind: 'upgrade', state: 'requires_action', stripeInvoiceId: 'in_upgrade', stripeScheduleId: null, hostedInvoiceUrl: 'https://invoice.example',
            effectiveAt: null, expiresAt: end, createdAt: now, updatedAt: now }];
        args.paymentIssues = [{ stripeInvoiceId: 'in_upgrade', userId: 'u', subscriptionId: 'sub', invoiceKind: 'upgrade', issue: 'requires_action',
            hostedInvoiceUrl: null, stripeEventCreated: now, updatedAt: now, resolvedAt: null }];
        expect(buildSummaryV3(args).plan).toMatchObject({ sku: 'standard_monthly_v3', status: 'upgrade_pending', paymentIssue: null,
            pendingUpgrade: { toSku: 'premium_monthly_v3', expiresAt: '2026-11-10T00:00:00Z' } });
        args.planChanges = args.planChanges.map(change => ({ ...change, subscriptionId: 'foreign' }));
        expect(buildSummaryV3(args).plan).toMatchObject({ status: 'active', pendingUpgrade: null, paymentIssue: null });
    });
    it('uses newest storage samples and maps over-cap to exhausted', () => {
        const args = input(); args.storage = [{ computerId: 'c', bytes: BigInt(1), measuredAt: start }, { computerId: 'c', bytes: BigInt(10) ** BigInt(15), measuredAt: now }];
        expect(buildSummaryV3(args).storage).toMatchObject({ usedBytes: '1000000000000000', state: 'exhausted' });
    });
});

describe('paid fair-use exhaustion deadlines', () => {
    it.each([['standard_monthly_v3', 'std-2', 1], ['premium_monthly_v3', 'std-2', 1],
        ['premium_monthly_v3', 'cmp-4', 2], ['premium_monthly_v3', 'cmp-8', 4]] as const)(
        '%s / %s stays anchored after a missed stop and ignores the retired session deadline', (sku, size, weight) => {
            const args = input(sku);
            args.grants[0]!.amount = BigInt(144000);
            const readyAt = '2026-10-19T00:00:00Z';
            args.epochs = [epoch({ id: 'prior', size: 'std-2', weight: 1, readyAt: '2026-10-18T00:00:00Z', endedAt: '2026-10-18T01:00:00Z' }),
                epoch({ size, weight, readyAt, deadlineAt: '2026-10-19T02:00:00Z' })];
            const deadline = new Date(Date.parse(readyAt) + (144000 - 3600) / weight * 1000).toISOString().replace('.000Z', 'Z');
            for (const current of [new Date(readyAt), new Date(Date.parse(deadline) + 3600000)]) {
                args.now = current;
                expect(buildSummaryV3(args).computer).toMatchObject({ sessionMaxSeconds: null, activeDeadline: deadline });
            }
        });
});

describe('round 3 AI credit buckets (D2/D4)', () => {
    const M = (credits: number) => String(BigInt(credits) * BigInt(1_000_000));
    const expiry = (date: Date) => new Date(date.getTime() + 3 * 86_400_000).toISOString();
    const prev = new Date('2026-09-10T00:00:00Z');
    const receipt = (entitlementId: string, credits: number, expiresAt: string, delivered = true) =>
        ({ entitlementId, credits, expiresAt, deliveredAt: delivered ? start.toISOString() : null });
    const standard = receipt(`ezil-os:v1:standard_monthly_v3:sub:${start.toISOString()}`, 200, expiry(end));
    const upgrade = receipt('ezil-os:v1:premium_monthly_v3:sub:2026-10-13T00:00:00.000Z:upgrade', 696, expiry(end));
    const grant = (credits: number, remaining: number, expiresAt: string, live = true) =>
        ({ creditsMicro: M(credits), remainingMicro: M(remaining), expiresAt, live });
    function summary(sku: SellableSkuV3 | undefined, receipts: Parameters<typeof buildSummaryV3>[0]['ai'] extends infer A
        ? A extends { receipts: infer R } ? R : never : never, gatewayGrants: ReturnType<typeof grant>[] | null, balanceMicro?: string | null) {
        const total = (gatewayGrants ?? []).filter(g => g.live).reduce((sum, g) => sum + BigInt(g.remainingMicro), BigInt(0)).toString();
        return buildSummaryV3({ ...input(sku), ai: { receipts, gatewayGrants, balanceMicro: balanceMicro === undefined ? total : balanceMicro } }).ai;
    }
    it('right after an upgrade, Standard\'s live 90 of 200 is NOT low and the renewal adds 1,000', () => {
        // Upgrade grant still queued: only the Standard period grant is on the Gateway.
        const ai = summary('premium_monthly_v3', [standard, { ...upgrade, deliveredAt: null }], [grant(200, 90, standard.expiresAt)]);
        expect(ai).toMatchObject({ grant: { amount: 1000 }, balance: 90, state: 'ok',
            included: { granted: 200, remaining: 90, periodEnd: end.toISOString().replace('.000', '') },
            purchased: null, starter: null, pendingFromRenewal: { credits: 1000, at: end.toISOString().replace('.000', '') } });
    });
    it('counts the delivered upgrade grant in this period\'s credits', () => {
        const ai = summary('premium_monthly_v3', [standard, upgrade], [grant(200, 150, standard.expiresAt), grant(696, 696, upgrade.expiresAt)]);
        expect(ai).toMatchObject({ balance: 846, state: 'ok', included: { granted: 896, remaining: 846 } });
        expect(summary('premium_monthly_v3', [standard, upgrade], [grant(200, 0, standard.expiresAt), grant(696, 80, upgrade.expiresAt)]).state).toBe('low');
    });
    it('keeps the previous period\'s 3-day tail out of this period\'s meter (no "1,200 of 1,000")', () => {
        const last = receipt(`ezil-os:v1:premium_monthly_v3:sub:${prev.toISOString()}`, 1000, expiry(start));
        const renewal = receipt(`ezil-os:v1:premium_monthly_v3:sub:${start.toISOString()}`, 1000, expiry(end));
        const ai = summary('premium_monthly_v3', [renewal, last], [grant(1000, 200, last.expiresAt), grant(1000, 1000, renewal.expiresAt)]);
        expect(ai).toMatchObject({ balance: 1200, state: 'ok', included: { granted: 1000, remaining: 1000 }, pendingFromRenewal: null });
    });
    it('reports purchased and starter credits separately and never lets them hide a low plan bucket', () => {
        const topup = receipt('ezil-os:v1:topup:ai_pack_10_v1:pi_1', 500, '2027-09-01T00:00:00.000Z');
        const starter = receipt('ezil-os:v1:free-once:u', 100, '2027-08-01T00:00:00.000Z');
        const ai = summary('standard_monthly_v3', [standard, topup, starter],
            [grant(200, 10, standard.expiresAt), grant(500, 400, topup.expiresAt), grant(100, 30, starter.expiresAt), grant(50, 50, '2026-12-01T00:00:00.000Z')]);
        expect(ai).toMatchObject({ balance: 490, state: 'low', included: { granted: 200, remaining: 10 },
            purchased: { remaining: 400, expiresAt: '2027-09-01T00:00:00.000Z' }, starter: { remaining: 30 }, pendingFromRenewal: null });
    });
    it('Free judges its starter grant; nothing spendable is exhausted', () => {
        const starter = receipt('ezil-os:v1:free-once:u', 100, '2027-08-01T00:00:00.000Z');
        expect(summary(undefined, [starter], [grant(100, 10, starter.expiresAt)])).toMatchObject({ state: 'low', included: null, starter: { remaining: 10 } });
        expect(summary(undefined, [starter], [grant(100, 11, starter.expiresAt)]).state).toBe('ok');
        expect(summary(undefined, [starter], [grant(100, 0, starter.expiresAt)]).state).toBe('exhausted');
    });
    it('falls back to the total against the period receipts (else the catalog) when the Gateway gives no grants', () => {
        expect(summary('premium_monthly_v3', [standard], null, M(90))).toMatchObject({ state: 'ok', balance: 90,
            included: { granted: 200, remaining: null }, purchased: null, starter: null });
        expect(summary('premium_monthly_v3', [], null, M(90))).toMatchObject({ state: 'low', included: { granted: 0, remaining: null } });
        expect(summary('premium_monthly_v3', null, null, M(90))).toMatchObject({ state: 'low', pendingFromRenewal: null });
        expect(summary('premium_monthly_v3', null, null, null).state).toBe('unavailable');
    });
    it('ignores revoked or foreign-subscription grants and announces no renewal for a canceling plan', () => {
        const foreign = receipt(`ezil-os:v1:premium_monthly_v3:sub_other:${start.toISOString()}`, 1000, expiry(end));
        const ai = summary('premium_monthly_v3', [standard, foreign], [grant(200, 200, standard.expiresAt, false), grant(1000, 1000, foreign.expiresAt)]);
        expect(ai).toMatchObject({ balance: 1000, included: { granted: 0, remaining: 0 }, pendingFromRenewal: { credits: 1000 } });
        const args = input('premium_monthly_v3');
        args.subs[0]!.cancelAtPeriodEnd = true;
        expect(buildSummaryV3({ ...args, ai: { receipts: [], gatewayGrants: [], balanceMicro: '0' } }).ai.pendingFromRenewal).toBeNull();
    });
});
