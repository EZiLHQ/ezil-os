import { describe, expect, it, vi } from 'vitest';

import type { BillingStore, GrantRow, OverageConsentRow, OverageInvoiceRow, UsageBillingPort } from '../ports';
import { closePeriodAndInvoiceOverage } from './close-period';
import { CATALOG_V2, OVERAGE_TERMS_VERSION, type ComputeEpoch } from './contract';
import { OVERAGE_GRACE_SECONDS, OVERAGE_RATING_VERSION } from './usage-billing';

const userId = 'user_fixture';
const subscriptionId = 'sub_fixture';
const start = new Date('2026-09-01T00:00:00Z');
const end = new Date('2026-10-01T00:00:00Z');
const now = new Date(end.getTime() + OVERAGE_GRACE_SECONDS * 1000);
const input = { userId, now };

function fixture() {
    const grants: GrantRow[] = [{
        id: 'grant_period', userId, subscriptionId, meter: 'compute_std_seconds', kind: 'plan_period',
        amount: BigInt(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds), periodStart: start, periodEnd: end,
        sourceType: 'invoice', sourceId: 'in_period', createdAt: start,
    }];
    const consents: OverageConsentRow[] = [{ id: BigInt(1), userId, subscriptionId, enabled: true, capCents: 2500,
        termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25, actor: userId, acceptedAt: start }];
    const epochs: ComputeEpoch[] = Array.from({ length: 25 }, (_, i) => ({
        id: `epoch_${i}`, userId, computerId: 'computer_fixture', size: 'cmp-8', weight: 4,
        readyAt: new Date(start.getTime() + i * 6 * 3600_000).toISOString(),
        endedAt: new Date(start.getTime() + (i + 1) * 6 * 3600_000).toISOString(), endReason: 'session_max', overheadSeconds: 0,
    }));
    const rows: OverageInvoiceRow[] = [];
    const store = {
        subscriptionsFor: vi.fn<BillingStore['subscriptionsFor']>().mockResolvedValue([{
            stripeSubscriptionId: subscriptionId, status: 'active', sku: 'standard_monthly_v2', cancelAtPeriodEnd: false,
            // A renewal/downgrade has already installed NEW dates. The old ledger controls the charge.
            currentPeriodStart: end, currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
        }]),
        grantsForPeriod: vi.fn<BillingStore['grantsForPeriod']>(async (user, window, meters) => grants.filter(grant =>
            grant.userId === user && meters.includes(grant.meter) && grant.periodStart !== null && grant.periodEnd !== null
            && grant.periodStart < window.end && grant.periodEnd > window.start)),
        epochsFor: vi.fn<BillingStore['epochsFor']>().mockResolvedValue(epochs),
        consentAsOf: vi.fn<BillingStore['consentAsOf']>(async (user, subscription, at) => consents.filter(row => row.userId === user
            && row.subscriptionId === subscription && row.acceptedAt < at).sort((a, b) => b.acceptedAt.getTime() - a.acceptedAt.getTime()
                || Number(b.id - a.id))[0] ?? null),
        upsertOverageInvoice: vi.fn<BillingStore['upsertOverageInvoice']>(async value => {
            const row = rows.find(row => row.subscriptionId === value.subscriptionId && row.periodStart.getTime() === value.periodStart.getTime()
                && row.ratingVersion === value.ratingVersion);
            if (row) return { status: 'exists', row };
            const created: OverageInvoiceRow = { ...value, id: 'overage_fixture', stripeInvoiceId: null, status: 'pending', createdAt: now, updatedAt: now };
            rows.push(created);
            return { status: 'inserted', row: created };
        }),
        stripeCustomerFor: vi.fn<BillingStore['stripeCustomerFor']>().mockResolvedValue('cus_fixture'),
        attachOverageStripeInvoice: vi.fn<BillingStore['attachOverageStripeInvoice']>(async (id, invoiceId) => {
            rows.find(row => row.id === id)!.stripeInvoiceId = invoiceId;
        }),
        markOverageInvoiceOpen: vi.fn<BillingStore['markOverageInvoiceOpen']>(async invoiceId => {
            const row = rows.find(row => row.stripeInvoiceId === invoiceId);
            if (row?.status === 'pending') row.status = 'open';
        }),
    } satisfies Parameters<typeof closePeriodAndInvoiceOverage>[0]['store'];
    const invoiceOverage = vi.fn<UsageBillingPort['invoiceOverage']>(async (_value, hooks) => {
        await hooks?.onDraftCreated?.('in_overage');
        return { status: 'invoiced', invoiceId: 'in_overage', invoiceStatus: 'open', hostedInvoiceUrl: null };
    });
    const deps = { store, usage: { invoiceOverage } };
    return { deps, store, invoiceOverage, grants, consents, epochs, rows };
}

describe('closePeriodAndInvoiceOverage', () => {
    it('bills 25 six-hour cmp-8 epochs at exactly $25 once and persists the draft identity', async () => {
        const f = fixture();
        await expect(closePeriodAndInvoiceOverage(f.deps, input)).resolves.toMatchObject({ status: 'invoiced', invoiceId: 'in_overage' });
        expect(f.invoiceOverage).toHaveBeenCalledTimes(1);
        expect(f.invoiceOverage).toHaveBeenCalledWith({ customerId: 'cus_fixture', subscriptionId, periodStart: start,
            periodEnd: end, ratingVersion: OVERAGE_RATING_VERSION, cents: 2500, overageEnabled: true, now, existingInvoiceId: null },
        { onDraftCreated: expect.any(Function) });
        expect(f.store.attachOverageStripeInvoice).toHaveBeenCalledExactlyOnceWith('overage_fixture', 'in_overage');
        expect(f.rows[0]).toMatchObject({ status: 'open', stripeInvoiceId: 'in_overage', stdSecondsOver: BigInt(360000), cents: 2500 });
        // More than 24h later, the durable row must protect against expired Stripe idempotency keys.
        await expect(closePeriodAndInvoiceOverage(f.deps, { ...input, now: new Date(now.getTime() + 2 * 86400_000) }))
            .resolves.toEqual({ status: 'exists', invoiceId: 'in_overage' });
        expect(f.invoiceOverage).toHaveBeenCalledTimes(1);
        expect(f.store.consentAsOf).toHaveBeenCalledWith(userId, subscriptionId, end);
        expect(f.store.epochsFor).toHaveBeenCalledWith(userId, start);
    });

    it.each(['no subscription', 'foreign subscription', 'grace', 'disabled', 'no consent', 'zero usage', 'zero cap', 'standard'] as const)
        ('skips %s without creating a row or calling the port', async scenario => {
            const f = fixture();
            let value: typeof input & { subscriptionId?: string } = { ...input };
            let reason: string;
            switch (scenario) {
                case 'no subscription': f.store.subscriptionsFor.mockResolvedValue([]); reason = 'not_found'; break;
                case 'foreign subscription': value.subscriptionId = 'sub_foreign'; reason = 'not_found'; break;
                case 'grace': value.now = new Date(now.getTime() - 1); reason = 'no_closed_period'; break;
                case 'disabled': f.consents[0].enabled = false; reason = 'overage_disabled'; break;
                case 'no consent': f.consents.length = 0; reason = 'overage_disabled'; break;
                case 'zero usage': f.epochs.length = 0; reason = 'nothing_to_bill'; break;
                case 'zero cap': f.consents[0].capCents = 0; reason = 'nothing_to_bill'; break;
                case 'standard': f.grants[0].amount = BigInt(CATALOG_V2.standard_monthly_v2.allowanceStdSeconds); reason = 'not_compute'; break;
            }
            await expect(closePeriodAndInvoiceOverage(f.deps, value)).resolves.toEqual({ status: 'skipped', reason });
            expect(f.invoiceOverage).not.toHaveBeenCalled();
            expect(f.store.upsertOverageInvoice).not.toHaveBeenCalled();
        });

    it.each([0, 1])('ignores consent changed %s milliseconds after the exclusive period end', async offset => {
        const f = fixture();
        f.consents.push({ ...f.consents[0], id: BigInt(2), enabled: false, capCents: 0, acceptedAt: new Date(end.getTime() + offset) });
        await expect(closePeriodAndInvoiceOverage(f.deps, input)).resolves.toMatchObject({ status: 'invoiced' });
        expect(f.invoiceOverage.mock.calls[0][0].cents).toBe(2500);
    });

    it('uses the latest eligible period, rather than an older Compute period for a downgraded Standard subscription', async () => {
        const f = fixture();
        f.grants.push({ ...f.grants[0], id: 'standard_period', amount: BigInt(216000), periodStart: end, periodEnd: new Date('2026-11-01T00:00:00Z') });
        await expect(closePeriodAndInvoiceOverage(f.deps, { ...input, now: new Date('2026-11-01T01:00:00Z') }))
            .resolves.toEqual({ status: 'skipped', reason: 'not_compute' });
        expect(f.invoiceOverage).not.toHaveBeenCalled();
    });

    it('recognizes an upgraded period and sums its ledger including suspends/revokes, ignoring foreign grants', async () => {
        const f = fixture();
        f.grants[0].amount = BigInt(216000);
        f.grants.push({ ...f.grants[0], id: 'upgrade', kind: 'upgrade_prorated', amount: BigInt(1584000) },
            { ...f.grants[0], id: 'revoke', kind: 'revoke', amount: BigInt(-14400) },
            { ...f.grants[0], id: 'suspend', kind: 'suspend', amount: BigInt(-14400) },
            { ...f.grants[0], id: 'other_sub', subscriptionId: 'foreign', amount: BigInt(9000000) },
            { ...f.grants[0], id: 'other_meter', meter: 'workspace_seconds', amount: BigInt(9000000) });
        f.consents[0].capCents = 10000;
        await closePeriodAndInvoiceOverage(f.deps, input);
        expect(f.invoiceOverage.mock.calls[0][0].cents).toBe(2700);
    });

    it('floors a negative allowance at zero', async () => {
        const f = fixture();
        f.grants.push({ ...f.grants[0], id: 'revoke', kind: 'revoke', amount: BigInt(-2000000) });
        await closePeriodAndInvoiceOverage(f.deps, input);
        expect(f.rows[0].stdSecondsOver).toBe(BigInt(2160000));
    });

    it('chooses the most recent subscription unless the caller supplies an owned one', async () => {
        const f = fixture();
        const [recent] = await f.store.subscriptionsFor(userId);
        f.store.subscriptionsFor.mockResolvedValue([{ ...recent, stripeSubscriptionId: 'sub_old', currentPeriodStart: start }, recent]);
        await expect(closePeriodAndInvoiceOverage(f.deps, input)).resolves.toMatchObject({ status: 'invoiced' });
        await expect(closePeriodAndInvoiceOverage(f.deps, { ...input, subscriptionId: 'sub_old' }))
            .resolves.toEqual({ status: 'skipped', reason: 'no_closed_period' });
    });

    it('skips a missing customer and retries the persisted amount after the link is restored', async () => {
        const f = fixture();
        f.store.stripeCustomerFor.mockResolvedValueOnce(null);
        await expect(closePeriodAndInvoiceOverage(f.deps, input)).resolves.toEqual({ status: 'skipped', reason: 'no_customer' });
        expect(f.invoiceOverage).not.toHaveBeenCalled();
        f.consents[0].capCents = 100;
        await closePeriodAndInvoiceOverage(f.deps, input);
        expect(f.invoiceOverage.mock.calls[0][0].cents).toBe(2500);
    });

    it('resumes an attached pending draft after a port failure instead of creating another invoice', async () => {
        const f = fixture();
        f.invoiceOverage.mockImplementationOnce(async (_value, hooks) => {
            await hooks?.onDraftCreated?.('in_draft');
            throw new Error('provider unavailable after draft');
        });
        await expect(closePeriodAndInvoiceOverage(f.deps, input)).rejects.toThrow('provider unavailable');
        expect(f.rows[0]).toMatchObject({ status: 'pending', stripeInvoiceId: 'in_draft' });
        expect(f.store.markOverageInvoiceOpen).not.toHaveBeenCalled();
        f.invoiceOverage.mockResolvedValueOnce({ status: 'invoiced', invoiceId: 'in_draft', invoiceStatus: 'open', hostedInvoiceUrl: null });
        await closePeriodAndInvoiceOverage(f.deps, input);
        expect(f.invoiceOverage.mock.calls[1][0].existingInvoiceId).toBe('in_draft');
        expect(f.rows[0].status).toBe('open');
    });

    it.each(['paid', 'payment_failed', 'requires_action', 'void', 'uncollectible'] as const)
        ('preserves webhook %s during finalization and avoids future port calls', async status => {
            const f = fixture();
            f.invoiceOverage.mockImplementationOnce(async (_value, hooks) => {
                await hooks?.onDraftCreated?.('in_overage');
                f.rows[0].status = status;
                return { status: 'invoiced', invoiceId: 'in_overage', invoiceStatus: status, hostedInvoiceUrl: null };
            });
            await closePeriodAndInvoiceOverage(f.deps, input);
            expect(f.rows[0].status).toBe(status);
            await expect(closePeriodAndInvoiceOverage(f.deps, input)).resolves.toEqual({ status: 'exists', invoiceId: 'in_overage' });
            expect(f.invoiceOverage).toHaveBeenCalledTimes(1);
        });
});
