import { describe, expect, it } from 'vitest';
import { offeredPack } from '../stripe/packs.test-support';
import { readBillingConfig } from '../config';
import { CATALOG_V3, type SellableSkuV3 } from './contract';
import { planFromSubscriptions } from './catalog';
import { buildSummaryV3, usedGiBOf, usedSecondsInWindow } from './summary';

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
        const args = input('standard_monthly_v3'); args.storage = [{ computerId: 'c', bytes: BigInt(1), measuredAt: start }, { computerId: 'c', bytes: BigInt(10) ** BigInt(15), measuredAt: now }];
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
    it('reports unknown, never "0 of 0", when delivered receipts match no Gateway grant (e.g. a unit change)', () => {
        const ai = summary('premium_monthly_v3', [standard], [grant(20, 9, standard.expiresAt)], M(90));
        expect(ai).toMatchObject({ state: 'ok', included: { granted: 200, remaining: null }, purchased: null, starter: null });
        const topup = receipt('ezil-os:v1:topup:ai_pack_10_v1:pi_1', 500, '2027-09-01T00:00:00.000Z');
        expect(summary('premium_monthly_v3', [standard, topup], [grant(500, 400, topup.expiresAt)], M(400)))
            .toMatchObject({ included: { granted: 200, remaining: null }, purchased: null });
    });
    it('round 6 (R1-10/R4-05): on Free after an immediate cancel, the paid period\'s remainder is its own bucket with its expiry', () => {
        // contact@ on 10-30: 100 starter credits plus 663 left of a cancelled Premium period (kept to periodEnd + 3 days).
        const cancelled = receipt('ezil-os:v1:premium_monthly_v3:sub:2026-10-27T12:00:00.000Z', 1000, '2026-11-30T12:00:00.000Z');
        const starter = receipt('ezil-os:v1:free-once:u', 100, '2027-10-27T00:00:00.000Z');
        const ai = summary(undefined, [cancelled, starter], [grant(1000, 663, cancelled.expiresAt), grant(100, 100, starter.expiresAt)]);
        expect(ai).toMatchObject({ balance: 763, state: 'ok', included: null, purchased: null, starter: { remaining: 100 },
            previous: { remaining: 663, expiresAt: '2026-11-30T12:00:00.000Z' } });
        // Two earlier grants (a period and an upgrade): one total, the EARLIEST expiry.
        const upgradeEarlier = receipt('ezil-os:v1:premium_monthly_v3:sub:2026-10-28T00:00:00.000Z:upgrade', 300, '2026-11-29T00:00:00.000Z');
        expect(summary(undefined, [cancelled, upgradeEarlier], [grant(1000, 663, cancelled.expiresAt), grant(300, 37, upgradeEarlier.expiresAt)]).previous)
            .toEqual({ remaining: 700, expiresAt: '2026-11-29T00:00:00.000Z' });
    });
    it('round 6: previous is the paid plan\'s 3-day tail of the last period; null when spent, none, or unknown', () => {
        const last = receipt(`ezil-os:v1:premium_monthly_v3:sub:${prev.toISOString()}`, 1000, expiry(start));
        const renewal = receipt(`ezil-os:v1:premium_monthly_v3:sub:${start.toISOString()}`, 1000, expiry(end));
        expect(summary('premium_monthly_v3', [renewal, last], [grant(1000, 200, last.expiresAt), grant(1000, 1000, renewal.expiresAt)]).previous)
            .toEqual({ remaining: 200, expiresAt: last.expiresAt });
        expect(summary('premium_monthly_v3', [renewal, last], [grant(1000, 0, last.expiresAt), grant(1000, 1000, renewal.expiresAt)]).previous).toBeNull();
        expect(summary('premium_monthly_v3', [renewal], [grant(1000, 1000, renewal.expiresAt)]).previous).toBeNull();
        expect(summary('premium_monthly_v3', [renewal, last], null, M(1200)).previous).toBeNull();
    });
    it('ignores revoked or foreign-subscription grants and announces no renewal for a canceling plan', () => {
        const foreign = receipt(`ezil-os:v1:premium_monthly_v3:sub_other:${start.toISOString()}`, 1000, expiry(end));
        const ai = summary('premium_monthly_v3', [{ ...standard, deliveredAt: null }, foreign],
            [grant(200, 200, standard.expiresAt, false), grant(1000, 1000, foreign.expiresAt)]);
        expect(ai).toMatchObject({ balance: 1000, included: { granted: 0, remaining: 0 }, pendingFromRenewal: { credits: 1000 } });
        const args = input('premium_monthly_v3');
        args.subs[0]!.cancelAtPeriodEnd = true;
        expect(buildSummaryV3({ ...args, ai: { receipts: [], gatewayGrants: [], balanceMicro: '0' } }).ai.pendingFromRenewal).toBeNull();
    });
});

describe('round 3 storage: the provisioned disk, never the v1 2 GB (D10)', () => {
    const GiB50 = String(50 * 1024 ** 3);
    it.each([['standard_monthly_v3', null], ['premium_monthly_v3', null], ['premium_monthly_v3', 'cmp-8']] as const)('%s (%s) caps at the 50 GiB AWS data volume', (sku, preference) => {
        const args = input(sku); args.sizePreference = preference;
        const summary = buildSummaryV3(args);
        expect(summary.storage).toEqual({ usedBytes: null, capBytes: GiB50, state: 'unavailable' });
        expect(summary.computer.disk).toEqual({ provisionedGiB: 50, usedBytes: null, growsOnSwitch: false });
        args.storage = [{ computerId: 'c', bytes: BigInt(43) * BigInt(1024) ** BigInt(3), measuredAt: now }];
        expect(buildSummaryV3(args).storage).toEqual({ usedBytes: String(43 * 1024 ** 3), capBytes: GiB50, state: 'low' });
        expect(buildSummaryV3(args).computer.disk).toEqual({ provisionedGiB: 50, usedBytes: String(43 * 1024 ** 3), growsOnSwitch: false });
    });
    it('a legacy plan with no sample is unmeasured (null, unavailable), never "0 of 2 GB" ok; measured, it meters against 2 GiB', () => {
        const args = { ...input(), subs: [{ sku: 'standard_monthly_v2', stripeSubscriptionId: 'sub', status: 'active',
            currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }] };
        expect(buildSummaryV3(args).plan.sku).toBe('legacy');
        expect(buildSummaryV3(args).storage).toEqual({ usedBytes: null, capBytes: String(2 * 1024 ** 3), state: 'unavailable' });
        expect(buildSummaryV3(args).computer.disk.usedBytes).toBeNull();
        // Positive controls: a measured zero is ok; 1.8e9 bytes is 83.8% of 2 GiB (low); two computers sum.
        expect(buildSummaryV3({ ...args, storage: [{ computerId: 'c', bytes: BigInt(0), measuredAt: now }] }).storage)
            .toEqual({ usedBytes: '0', capBytes: String(2 * 1024 ** 3), state: 'ok' });
        expect(buildSummaryV3({ ...args, storage: [{ computerId: 'c', bytes: BigInt(1_000_000_000), measuredAt: now },
            { computerId: 'deleted-unpurged', bytes: BigInt(800_000_000), measuredAt: start }] }).storage)
            .toEqual({ usedBytes: '1800000000', capBytes: String(2 * 1024 ** 3), state: 'low' });
    });
    it('Free shows no invented cap, even with the large-storage flag or a sample', () => {
        const args = input(); args.config.largeStorageEnabled = true;
        expect(buildSummaryV3(args).storage).toEqual({ usedBytes: null, capBytes: '0', state: 'unavailable' });
        args.storage = [{ computerId: 'c', bytes: BigInt(5), measuredAt: now }];
        expect(buildSummaryV3(args)).toMatchObject({ storage: { usedBytes: '5', capBytes: '0', state: 'unavailable' },
            computer: { disk: { provisionedGiB: null, usedBytes: '5' } } });
    });
});

describe('round 4: standing fields (additive)', () => {
    it('paid by default, with the placement deciding filesOn and move always null', () => {
        expect(buildSummaryV3(input('standard_monthly_v3')).computer).toMatchObject({ standing: 'paid', filesOn: 'cloudflare', heldSince: null, move: null });
        expect(buildSummaryV3({ ...input('standard_monthly_v3'), placementProvider: 'aws-ec2' }).computer).toMatchObject({ standing: 'paid', filesOn: 'aws' });
        expect(buildSummaryV3(input()).computer).toMatchObject({ standing: 'free', filesOn: 'cloudflare' });
        expect(buildSummaryV3({ ...input(), placementProvider: 'aws-ec2' }).computer).toMatchObject({ standing: 'files_on_aws', filesOn: 'aws' });
        expect(buildSummaryV3(input()).plan).toMatchObject({ graceEndsAt: null, planEndsAt: null });
    });
    it('files_on_aws reports the held std-2 computer, not the Free offer size (Billing agrees with Computer/System)', () => {
        expect(buildSummaryV3({ ...input(), placementProvider: 'aws-ec2' }).computer)
            .toMatchObject({ standing: 'files_on_aws', size: 'std-2', vcpu: 2, memoryGiB: 8, sessionMaxSeconds: 3600, disk: { provisionedGiB: 50 } });
        expect(buildSummaryV3(input()).computer).toMatchObject({ standing: 'free', size: 'free-cf', vcpu: 2, memoryGiB: 6 });
        expect(buildSummaryV3({ ...input('standard_monthly_v3'), placementProvider: 'aws-ec2' }).computer).toMatchObject({ standing: 'paid', size: 'std-2' });
    });
    it('grace keeps the paid allowance when the unpaid renewal has no receipt, and a refund reversal still pauses', () => {
        const args = { ...input('premium_monthly_v3'), grants: [], placementProvider: 'aws-ec2' as const,
            subs: [{ sku: 'premium_monthly_v3' as const, stripeSubscriptionId: 'sub', status: 'past_due', currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }],
            paymentIssues: [{ stripeInvoiceId: 'in', userId: 'u', subscriptionId: 'sub', invoiceKind: 'subscription' as const, issue: 'payment_failed' as const,
                hostedInvoiceUrl: null, stripeEventCreated: new Date('2026-10-15T00:00:00Z'), resolvedAt: null, updatedAt: now }] };
        expect(buildSummaryV3(args)).toMatchObject({ plan: { status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: '2026-10-22T00:00:00Z' },
            computer: { standing: 'grace' }, fairUse: { status: 'ok' } });
        expect(buildSummaryV3({ ...args, grants: [{ ...input('premium_monthly_v3').grants[0]!, amount: BigInt(0) }] }).fairUse.status).toBe('paused');
        expect(buildSummaryV3({ ...args, now: new Date('2026-10-22T00:00:00Z') }).computer).toMatchObject({ standing: 'files_on_aws', heldSince: '2026-10-22T00:00:00Z' });
    });
    it('round 6 review (dunning into the hold): after grace the computer is rated as Free, as the start gate rates it', () => {
        // A Premium renewal failed on 11-01, grace ended 11-08, the files are on AWS; a std-2 hold session runs at 11-12 12:00.
        const at = new Date('2026-11-12T12:00:00Z');
        const lapsed: Input = { ...input('premium_monthly_v3'), now: at, userCreatedAt: new Date('2026-09-01T00:00:00Z'), grants: [],
            placementProvider: 'aws-ec2', volumeGiB: 50,
            subs: [{ sku: 'premium_monthly_v3', stripeSubscriptionId: 'sub', status: 'past_due', currentPeriodStart: new Date('2026-11-01T00:00:00Z'),
                currentPeriodEnd: new Date('2026-12-01T00:00:00Z'), cancelAtPeriodEnd: false }],
            paymentIssues: [{ stripeInvoiceId: 'in', userId: 'u', subscriptionId: 'sub', invoiceKind: 'subscription', issue: 'payment_failed',
                hostedInvoiceUrl: null, stripeEventCreated: new Date('2026-11-01T01:00:00Z'), resolvedAt: null, updatedAt: at }],
            epochs: [epoch({ size: 'std-2', weight: 1, readyAt: '2026-11-12T11:30:00Z', deadlineAt: '2026-11-12T12:29:59Z' })] };
        const free = planFromSubscriptions({ subs: [], now: at, userCreatedAt: lapsed.userCreatedAt });
        const summary = buildSummaryV3(lapsed);
        // The plan block still names the unpaid subscription; the computer runs under Free's limits and month.
        expect(summary.plan).toMatchObject({ sku: 'premium_monthly_v3', status: 'past_due', paymentIssue: 'payment_failed' });
        expect(summary.computer).toMatchObject({ standing: 'files_on_aws', size: 'std-2', sessionMaxSeconds: 3600,
            activeDeadline: '2026-11-12T12:29:59Z', machineChoice: [{ size: 'free-cf' }] });
        expect(summary.fairUse).toEqual({ status: 'ok', resetsAt: free.window.end });
        // Without an AWS placement (standing free) it is still Free's limits, at Free's size.
        expect(buildSummaryV3({ ...lapsed, placementProvider: null, epochs: [] }).computer).toMatchObject({ standing: 'free', size: 'free-cf', sessionMaxSeconds: 3600 });
        // Still in grace (11-05): the paid plan's limits stand (no session cap, the paid period).
        const grace = buildSummaryV3({ ...lapsed, now: new Date('2026-11-05T12:00:00Z'), epochs: [] });
        expect(grace.computer).toMatchObject({ standing: 'grace', sessionMaxSeconds: null });
        expect(grace.fairUse).toMatchObject({ status: 'ok', resetsAt: '2026-12-01T00:00:00Z' });
        // A never-paid (incomplete) subscription is Free too.
        expect(buildSummaryV3({ ...lapsed, subs: [{ ...lapsed.subs[0]!, status: 'incomplete' }], paymentIssues: [] }).computer)
            .toMatchObject({ sessionMaxSeconds: 3600 });
    });
    it('round 6 (R1-06): the Free offer in the summary says the hours THIS account gets on Free; paid offers and publicOffers() are unchanged', () => {
        // FREE_V2_EFFECTIVE_AT is null: every account keeps the legacy 8 hours.
        const legacy = buildSummaryV3({ ...input(), placementProvider: 'aws-ec2' });
        expect(legacy.catalog.offers.map(offer => [offer.sku, offer.fairUseHours])).toEqual([['free_v3', 8], ['standard_monthly_v3', 40], ['premium_monthly_v3', 500]]);
        expect(buildSummaryV3(input('premium_monthly_v3')).catalog.offers[0]!.fairUseHours).toBe(8);
        const newer = { ...input(), userCreatedAt: now, freeEffectiveAt: '2026-10-01T00:00:00Z' };
        expect(buildSummaryV3(newer).catalog.offers[0]!.fairUseHours).toBe(5);
    });
    it('round 6 review (R4-02): awsSize is the PLACED AWS size (any standing), apart from the hold size and the preference', () => {
        // A Premium cmp-8 computer cancelled at once: held, the size that would open is std-2, the placement is cmp-8.
        const held = buildSummaryV3({ ...input(), placementProvider: 'aws-ec2', awsSize: 'cmp-8' }).computer;
        expect(held).toMatchObject({ standing: 'files_on_aws', size: 'std-2', vcpu: 2, awsSize: { size: 'cmp-8', vcpu: 8, memoryGiB: 32 } });
        expect(buildSummaryV3({ ...input(), placementProvider: 'aws-ec2', awsSize: 'cmp-4' }).computer.awsSize).toEqual({ size: 'cmp-4', vcpu: 4, memoryGiB: 16 });
        // Paid: the preference (next start) and the placement are separate facts.
        const paid = buildSummaryV3({ ...input('premium_monthly_v3'), placementProvider: 'aws-ec2', sizePreference: 'std-2', awsSize: 'cmp-8' }).computer;
        expect(paid).toMatchObject({ standing: 'paid', size: 'std-2', awsSize: { size: 'cmp-8' } });
        // Unknown, mixed or a non-AWS size: null, never a guess.
        for (const awsSize of [undefined, null, 'free-cf'] as const)
            expect(buildSummaryV3({ ...input(), placementProvider: 'aws-ec2', awsSize }).computer.awsSize).toBeNull();
    });
    it('round 6 (CR-2): a running hold session carries its stored deadline (ready + 1 h) for "This session ends at HH:MM"', () => {
        const held = { ...input(), placementProvider: 'aws-ec2' as const, epochs: [epoch({ size: 'std-2', weight: 1, readyAt: '2026-10-19T11:30:00Z',
            deadlineAt: '2026-10-19T12:29:59Z' })] };
        expect(buildSummaryV3(held).computer).toMatchObject({ standing: 'files_on_aws', sessionMaxSeconds: 3600, activeDeadline: '2026-10-19T12:29:59Z' });
    });
    it('cancel at period end reads plan_ending with planEndsAt', () => {
        const args = input('premium_monthly_v3');
        args.subs = [{ ...args.subs[0]!, cancelAtPeriodEnd: true }];
        expect(buildSummaryV3(args)).toMatchObject({ plan: { status: 'cancels', planEndsAt: '2026-11-10T00:00:00Z', cancelsAt: '2026-11-10T00:00:00Z' },
            computer: { standing: 'plan_ending' } });
    });
});

describe('round 5 contract pin (W0): enrollment, storage and heal fields default with no behaviour change', () => {
    it.each([undefined, 'standard_monthly_v3', 'premium_monthly_v3'] as const)('%s: enrolled, nothing waiting, no EZiL ID link, no per-configuration disk', sku => {
        for (const ai of [undefined, { receipts: [], gatewayGrants: [], balanceMicro: '0' }]) {
            const summary = buildSummaryV3({ ...input(sku), ai });
            expect(summary.ai.enrollment).toBe('enrolled');
            expect(summary.ai.waiting).toBeNull();
            expect(summary.actions.ezilId).toBeNull();
            expect(summary.computer.machineChoice.length).toBeGreaterThan(0);
            for (const option of summary.computer.machineChoice) expect(option.diskGiB).toBeNull();
            expect(summary.computer.disk?.growsOnSwitch).toBe(false);
            expect(summary.catalog.offers.map(offer => offer.storageGiB)).toEqual([null, 50, 100]);
        }
    });
});

describe('round 5 D1: AI enrollment, waiting credits and the EZiL ID action', () => {
    const link = '/auth/auth0/login?returnUrl=/os';
    const future = '2027-10-19T12:00:00.000Z', past = '2026-10-19T11:59:59.000Z';
    const receipts = [
        { entitlementId: 'ezil-os:v1:free-once:u', credits: 100, expiresAt: future, deliveredAt: null },
        { entitlementId: 'ezil-os:v1:standard_monthly_v3:sub:2026-10-10T00:00:00.000Z', credits: 200, expiresAt: future, deliveredAt: null },
        { entitlementId: 'ezil-os:v1:topup:p:pi:grant', credits: 1000, expiresAt: future, deliveredAt: '2026-10-11T00:00:00.000Z' },
        { entitlementId: 'ezil-os:v1:standard_monthly_v3:sub:2026-09-10T00:00:00.000Z', credits: 200, expiresAt: past, deliveredAt: null },
    ];
    const ai = { receipts, gatewayGrants: null, balanceMicro: null };
    it.each([undefined, 'standard_monthly_v3', 'premium_monthly_v3'] as const)('%s needs_ezil_id: CTA link, waiting credits, no top-up', sku => {
        const summary = buildSummaryV3({ ...input(sku), ai, enrollment: { state: 'needs_ezil_id', ezilIdUrl: link } });
        expect(summary.ai.enrollment).toBe('needs_ezil_id');
        expect(summary.ai.waiting).toEqual({ credits: 300 });
        expect(summary.actions).toMatchObject({ topup: false, ezilId: link });
    });
    it('activating: waiting credits, no top-up, no CTA', () => {
        const summary = buildSummaryV3({ ...input('standard_monthly_v3'), ai, enrollment: { state: 'activating', ezilIdUrl: link } });
        expect(summary.ai).toMatchObject({ enrollment: 'activating', waiting: { credits: 300 } });
        expect(summary.actions).toMatchObject({ topup: false, ezilId: null });
    });
    it('enrolled: top-up stays, no CTA, nothing parked', () => {
        const summary = buildSummaryV3({ ...input('standard_monthly_v3'), ai, enrollment: { state: 'enrolled', ezilIdUrl: link } });
        expect(summary.ai).toMatchObject({ enrollment: 'enrolled', waiting: null });
        expect(summary.actions).toMatchObject({ topup: true, ezilId: null });
    });
    it('needs_ezil_id without EZiL ID sign-in configured has no link; nothing undelivered means waiting null', () => {
        const summary = buildSummaryV3({ ...input(), ai: { ...ai, receipts: receipts.slice(2) }, enrollment: { state: 'needs_ezil_id', ezilIdUrl: null } });
        expect(summary.ai.waiting).toBeNull();
        expect(summary.actions).toMatchObject({ topup: false, ezilId: null });
        expect(buildSummaryV3({ ...input(), ai: { ...ai, receipts: null }, enrollment: { state: 'needs_ezil_id', ezilIdUrl: null } }).ai.waiting).toBeNull();
    });
    // Review fix (r5 L1): a terminally failed grant (invalid_payload, attempts_exhausted, review) will not
    // arrive on sign-in, so it is not "waiting".
    it('does not count terminally failed undelivered grants as waiting', () => {
        const failed = { entitlementId: 'ezil-os:v1:premium_monthly_v3:sub:2026-10-12T00:00:00.000Z', credits: 1000,
            expiresAt: future, deliveredAt: null, failed: true };
        const summary = buildSummaryV3({ ...input(), ai: { ...ai, receipts: [...receipts, failed] }, enrollment: { state: 'needs_ezil_id', ezilIdUrl: link } });
        expect(summary.ai.waiting).toEqual({ credits: 300 });
    });
    it('checkout off keeps top-up off in every state', () => {
        const args = input(); args.config.checkoutEnabled = false;
        expect(buildSummaryV3({ ...args, enrollment: { state: 'enrolled', ezilIdUrl: null } }).actions.topup).toBe(false);
    });
});

describe('round 5 D3: the shown disk is the computer\'s REAL volume; machine options carry no disk figure', () => {
    const GiB = 1024 ** 3;
    it.each([null, 'cmp-4', 'cmp-8'] as const)('Premium at %s: a computer created today shows its 100 GiB volume, an older one its 50 GiB volume', preference => {
        const today = { ...input('premium_monthly_v3'), sizePreference: preference, volumeGiB: 100 };
        expect(buildSummaryV3(today).computer.disk).toEqual({ provisionedGiB: 100, usedBytes: null, growsOnSwitch: false });
        expect(buildSummaryV3(today).storage).toEqual({ usedBytes: null, capBytes: String(100 * GiB), state: 'unavailable' });
        const older = { ...today, volumeGiB: 50, storage: [{ computerId: 'c', bytes: BigInt(43) * BigInt(GiB), measuredAt: now }] };
        expect(buildSummaryV3(older).computer.disk).toEqual({ provisionedGiB: 50, usedBytes: String(43 * GiB), growsOnSwitch: false });
        expect(buildSummaryV3(older).storage).toEqual({ usedBytes: String(43 * GiB), capBytes: String(50 * GiB), state: 'low' });
    });
    it.each([undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16385])('an unreadable or implausible volume (%s) falls back to 50, never the plan figure', volumeGiB => {
        for (const sku of ['standard_monthly_v3', 'premium_monthly_v3'] as const) {
            expect(buildSummaryV3({ ...input(sku), volumeGiB }).computer.disk?.provisionedGiB).toBe(50);
        }
    });
    it('Free keeps no GB figure even when a volume size is passed', () => {
        expect(buildSummaryV3({ ...input(), volumeGiB: 100 }).computer.disk).toEqual({ provisionedGiB: null, usedBytes: null, growsOnSwitch: false });
    });
    // D3 + the W0 pin (contract.ts MachineOptionV3.diskGiB): tiles carry NO disk figure until a grow path exists
    // (a switch keeps the computer's volume); plan storage is on the plan cards (offer storageGiB) only.
    it('machineChoice diskGiB is null on every tile, past-due Premium included; offers carry storageGiB (Free null, Standard 50, Premium 100)', () => {
        const disks = (sku?: SellableSkuV3) => buildSummaryV3(input(sku)).computer.machineChoice.map(option => [option.size, option.diskGiB]);
        expect(disks()).toEqual([['free-cf', null]]);
        expect(disks('standard_monthly_v3')).toEqual([['std-2', null]]);
        expect(disks('premium_monthly_v3')).toEqual([['std-2', null], ['cmp-4', null], ['cmp-8', null]]);
        const pastDue = input('premium_monthly_v3');
        pastDue.subs = [{ ...pastDue.subs[0]!, status: 'past_due' }];
        for (const option of buildSummaryV3(pastDue).computer.machineChoice) expect(option.diskGiB).toBeNull();
        expect(buildSummaryV3(input('premium_monthly_v3')).catalog.offers.map(offer => [offer.sku, offer.storageGiB]))
            .toEqual([['free_v3', null], ['standard_monthly_v3', 50], ['premium_monthly_v3', 100]]);
    });
    it('copy guard: no "unlimited" anywhere; configuration tiles carry no per-configuration disk claim', () => {
        for (const sku of [undefined, 'standard_monthly_v3', 'premium_monthly_v3'] as const) {
            const summary = buildSummaryV3({ ...input(sku), volumeGiB: 100 });
            expect(JSON.stringify(summary)).not.toMatch(/unlimited/i);
            // No tile carries a disk figure at all (none claims a disk a switch would not deliver).
            for (const option of summary.computer.machineChoice) expect(option.diskGiB).toBeNull();
            for (const option of summary.computer.machineChoice) {
                expect(Object.values(option).every(value => typeof value !== 'string' || /^(free-cf|std-2|cmp-4|cmp-8|x86_64)$/.test(value))).toBe(true);
            }
        }
    });
});

describe('round 5 D3: used space in GiB, the same unit as the cap', () => {
    const GiB = BigInt(1024) ** BigInt(3);
    it('divides by 1024^3 (a full 50 GiB disk reads 50, not 53.7), one decimal', () => {
        expect(usedGiBOf(BigInt(50) * GiB)).toBe(50);
        expect(usedGiBOf(String(BigInt(50) * GiB))).toBe(50);
        expect(usedGiBOf(BigInt(43) * GiB + GiB / BigInt(2))).toBe(43.5);
        expect(usedGiBOf(BigInt(1_000_000_000))).toBe(0.9);
        expect(usedGiBOf(BigInt(0))).toBe(0);
        // Rounded to the nearest tenth, not floored: 0.96 GiB reads 1, 0.94 GiB reads 0.9.
        expect(usedGiBOf(BigInt(Math.round(0.96 * 1024 ** 3)))).toBe(1);
        expect(usedGiBOf(BigInt(Math.round(0.94 * 1024 ** 3)))).toBe(0.9);
    });
    it('null, negative or malformed input is null (no invented figure)', () => {
        for (const value of [null, undefined, '', 'abc', '-5', BigInt(-1)]) expect(usedGiBOf(value as never)).toBeNull();
    });
});
