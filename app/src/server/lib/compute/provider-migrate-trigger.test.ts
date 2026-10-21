import { describe, expect, it, vi } from 'vitest';
import { processStripeEvent } from '@/server/billing/processor';
import type { ProcessorDeps } from '@/server/billing/ports';
import { schedulePaidMigration } from './provider-migrate-orchestrator';
vi.mock('./provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));
const start = new Date('2026-10-01'), end = new Date('2026-11-01');
function fixture(sku = 'standard_monthly_v3') {
    const grant = vi.fn(async () => 'inserted');
    const deps = { now: () => start, store: { userForStripeCustomer: async () => 'user', upsertSubscription: async () => 'applied',
        resolvePaymentIssue: async () => {}, insertGrant: grant }, stripe: {
        retrieveInvoice: async () => ({ id: 'in', status: 'paid', customer: 'cus', subscriptionId: 'sub', billingReason: 'subscription_create',
            lines: [{ lookupKey: `ezil_${sku}`, subscriptionId: 'sub', amount: 2000, periodStart: start, periodEnd: end }] }),
        retrieveSubscription: async () => ({ id: 'sub', customer: 'cus', sku, status: 'active', currentPeriodStart: start, currentPeriodEnd: end }),
    } } as unknown as ProcessorDeps;
    const event = { id: 'evt', livemode: false, type: 'invoice.paid', created: start.getTime() / 1000, data: { object: { id: 'in', customer: 'cus', subscription: 'sub', lines: { data: [] } } } };
    return { deps, grant, event };
}
describe('grant commit ordering', () => {
    it.each(['standard_monthly_v3', 'premium_monthly_v3'])('schedules %s only after committed grant', async sku => {
        vi.mocked(schedulePaidMigration).mockClear(); const f = fixture(sku);
        f.grant.mockImplementation(async () => { expect(schedulePaidMigration).not.toHaveBeenCalled(); return 'inserted'; });
        expect(await processStripeEvent(f.event, f.deps)).toBe('applied');
        expect(schedulePaidMigration).toHaveBeenCalledWith('user', sku, 'invoice.paid');
    });
    it('never schedules a failed grant write', async () => {
        vi.mocked(schedulePaidMigration).mockClear(); const f = fixture(); f.grant.mockRejectedValue(new Error('write failed'));
        await expect(processStripeEvent(f.event, f.deps)).rejects.toThrow(); expect(schedulePaidMigration).not.toHaveBeenCalled();
    });
});
