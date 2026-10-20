import { describe, expect, it } from 'vitest';
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
        expect(Object.keys(summary).sort()).toEqual(['enabled', 'version', 'plan', 'computer', 'fairUse', 'storage', 'actions', 'catalog'].sort());
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
        expect(buildSummaryV3(args).computer).toMatchObject({ vcpu: 4, memoryGiB: 16, sessionMaxSeconds: 21600, opening: 'standard', activeDeadline: '2026-10-19T17:00:00Z' });
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
