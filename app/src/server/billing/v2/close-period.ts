import type { BillingStore, OverageInvoiceResult, UsageBillingPort } from '../ports';
import { CATALOG_V2, GRANT_METER_COMPUTE } from './contract';
import { ratePeriod, rateWindow } from './rating';
import { epochSeconds, isoSeconds } from './time';
import { OVERAGE_GRACE_SECONDS, OVERAGE_RATING_VERSION } from './usage-billing';

type ClosePeriodStore = Pick<BillingStore, 'subscriptionsFor' | 'grantsForPeriod' | 'epochsFor' | 'consentAsOf'
    | 'upsertOverageInvoice' | 'stripeCustomerFor' | 'attachOverageStripeInvoice' | 'markOverageInvoiceOpen'>;

export type ClosePeriodResult = OverageInvoiceResult
    | { status: 'exists'; invoiceId: string }
    | { status: 'skipped'; reason: 'not_found' | 'no_closed_period' | 'not_compute' | 'no_customer' };

/** Invoice the last ledger-backed closed period, even after renewal/downgrade replaced the subscription dates. */
export async function closePeriodAndInvoiceOverage(
    deps: { store: ClosePeriodStore; usage: UsageBillingPort },
    input: { userId: string; subscriptionId?: string; now: Date },
): Promise<ClosePeriodResult> {
    const { store, usage } = deps;
    const { userId, now } = input;
    const subscriptions = await store.subscriptionsFor(userId);
    const subscription = input.subscriptionId !== undefined
        ? subscriptions.find(sub => sub.stripeSubscriptionId === input.subscriptionId)
        : [...subscriptions].sort((a, b) => (b.currentPeriodStart?.getTime() ?? 0) - (a.currentPeriodStart?.getTime() ?? 0))[0];
    if (!subscription) return { status: 'skipped', reason: 'not_found' };
    const subscriptionId = subscription.stripeSubscriptionId;
    const recent = await store.grantsForPeriod(userId, {
        start: new Date(now.getTime() - 70 * 24 * 3600 * 1000), end: now,
    }, [GRANT_METER_COMPUTE]);
    const period = recent.filter(grant => grant.subscriptionId === subscriptionId && grant.meter === GRANT_METER_COMPUTE
        && grant.kind === 'plan_period' && grant.periodStart !== null && grant.periodEnd !== null
        && grant.periodEnd > grant.periodStart && grant.periodEnd.getTime() + OVERAGE_GRACE_SECONDS * 1000 <= now.getTime())
        .sort((a, b) => b.periodEnd!.getTime() - a.periodEnd!.getTime())[0];
    if (!period) return { status: 'skipped', reason: 'no_closed_period' };
    const periodStart = period.periodStart!;
    const periodEnd = period.periodEnd!;
    const grants = (await store.grantsForPeriod(userId, { start: periodStart, end: periodEnd }, [GRANT_METER_COMPUTE]))
        .filter(grant => grant.subscriptionId === subscriptionId && grant.meter === GRANT_METER_COMPUTE
            && grant.periodStart !== null && grant.periodEnd !== null && grant.periodStart < periodEnd && grant.periodEnd > periodStart);
    if (period.amount !== BigInt(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds)
        && !grants.some(grant => grant.kind === 'upgrade_prorated')) return { status: 'skipped', reason: 'not_compute' };
    const allowance = grants.reduce((sum, grant) => sum + grant.amount, BigInt(0));
    const allowanceStdSeconds = Number(allowance < BigInt(0) ? BigInt(0) : allowance);
    if (!Number.isSafeInteger(allowanceStdSeconds)) throw new RangeError('Compute allowance exceeds safe integer range');
    const [epochs, consent] = await Promise.all([
        store.epochsFor(userId, periodStart), store.consentAsOf(userId, subscriptionId, periodEnd),
    ]);
    const used = rateWindow({ epochs, window: {
        start: isoSeconds(epochSeconds(periodStart)), end: isoSeconds(epochSeconds(periodEnd)),
    }, now: isoSeconds(epochSeconds(now)) });
    const rating = ratePeriod({ usedStdSeconds: used.stdSeconds, allowanceStdSeconds,
        overage: consent ? { enabled: consent.enabled, capCents: consent.capCents } : null });
    if (!consent?.enabled) return { status: 'skipped', reason: 'overage_disabled' };
    if (rating.billableOverageCents === 0) return { status: 'skipped', reason: 'nothing_to_bill' };
    const { row } = await store.upsertOverageInvoice({ userId, subscriptionId, periodStart, periodEnd,
        ratingVersion: OVERAGE_RATING_VERSION, stdSecondsOver: BigInt(rating.overStdSeconds), cents: rating.billableOverageCents });
    // Durable guard: Stripe's idempotency keys alone do not protect retries after 24 hours.
    if (row.stripeInvoiceId !== null && row.status !== 'pending') return { status: 'exists', invoiceId: row.stripeInvoiceId };
    const customerId = await store.stripeCustomerFor(userId);
    if (customerId === null) return { status: 'skipped', reason: 'no_customer' };
    const result = await usage.invoiceOverage({ customerId, subscriptionId, periodStart: row.periodStart, periodEnd: row.periodEnd,
        ratingVersion: row.ratingVersion, cents: row.cents, overageEnabled: true, now, existingInvoiceId: row.stripeInvoiceId }, {
        onDraftCreated: id => store.attachOverageStripeInvoice(row.id, id),
    });
    if (result.status === 'invoiced') await store.markOverageInvoiceOpen(result.invoiceId);
    return result;
}
