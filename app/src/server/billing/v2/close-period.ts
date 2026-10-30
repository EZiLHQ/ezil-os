import type { BillingStore, OverageInvoiceResult, UsageBillingPort } from '../ports';
import { CATALOG_V2, GRANT_METER_COMPUTE, OVERAGE_CENTS_PER_STD_HOUR, OVERAGE_TERMS_VERSION, STD_SECONDS_PER_OVERAGE_CENT } from './contract';
import { rateWindow } from './rating';
import { hasOveragePaymentFailure } from './summary';
import { epochSeconds, isoSeconds } from './time';
import { OVERAGE_GRACE_SECONDS, OVERAGE_RATING_VERSION } from './usage-billing';

type ClosePeriodStore = Pick<BillingStore, 'subscriptionsFor' | 'grantsForPeriod' | 'epochsFor' | 'consentDecisionsForPeriod'
    | 'openPaymentIssues' | 'overageInvoicesFor'
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
    const [paymentIssues, overageInvoices] = await Promise.all([
        store.openPaymentIssues(userId), store.overageInvoicesFor(userId),
    ]);
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
    const existing = overageInvoices.find(invoice => invoice.subscriptionId === subscriptionId
        && invoice.periodStart.getTime() === periodStart.getTime() && invoice.ratingVersion === OVERAGE_RATING_VERSION
        && invoice.stripeInvoiceId !== null && invoice.status !== 'pending');
    if (existing?.stripeInvoiceId) return { status: 'exists', invoiceId: existing.stripeInvoiceId };
    // Conservatively bill nothing while a failure is unresolved, regardless of later consent.
    if (hasOveragePaymentFailure(subscriptionId, paymentIssues, overageInvoices)) {
        return { status: 'skipped', reason: 'overage_disabled' };
    }
    const grants = (await store.grantsForPeriod(userId, { start: periodStart, end: periodEnd }, [GRANT_METER_COMPUTE]))
        .filter(grant => grant.subscriptionId === subscriptionId && grant.meter === GRANT_METER_COMPUTE
            && grant.periodStart !== null && grant.periodEnd !== null && grant.periodStart < periodEnd && grant.periodEnd > periodStart);
    if (period.amount !== BigInt(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds)
        && !grants.some(grant => grant.kind === 'upgrade_prorated')) return { status: 'skipped', reason: 'not_compute' };
    const allowance = grants.reduce((sum, grant) => sum + grant.amount, BigInt(0));
    const allowanceStdSeconds = Number(allowance < BigInt(0) ? BigInt(0) : allowance);
    if (!Number.isSafeInteger(allowanceStdSeconds)) throw new RangeError('Compute allowance exceeds safe integer range');
    const [epochs, decisions] = await Promise.all([
        store.epochsFor(userId, periodStart), store.consentDecisionsForPeriod(userId, subscriptionId, periodStart, periodEnd),
    ]);
    const startSeconds = epochSeconds(periodStart);
    const endSeconds = epochSeconds(periodEnd);
    const activeIntervals: { start: number; end: number }[] = [];
    let capCents = 0;
    for (let i = 0; i < decisions.length; i++) {
        const decision = decisions[i];
        if (!decision.enabled || decision.termsVersion !== OVERAGE_TERMS_VERSION
            || decision.rateCentsPerStdHour !== OVERAGE_CENTS_PER_STD_HOUR) continue;
        const start = Math.max(startSeconds, epochSeconds(decision.acceptedAt));
        const end = Math.min(endSeconds, epochSeconds(decisions[i + 1]?.acceptedAt ?? periodEnd));
        // Only decisions in force for a positive interval can supply the cap.
        if (end <= start) continue;
        capCents = decision.capCents;
        const previous = activeIntervals[activeIntervals.length - 1];
        if (previous?.end === start) previous.end = end;
        else activeIntervals.push({ start, end });
    }
    if (activeIntervals.length === 0) return { status: 'skipped', reason: 'overage_disabled' };
    const windowStart = isoSeconds(startSeconds);
    const ratedAt = isoSeconds(epochSeconds(now));
    // Cumulative overage keeps the allowance shared across enabled and paused usage.
    const over = (end: number) => Math.max(0, rateWindow({ epochs,
        window: { start: windowStart, end: isoSeconds(end) }, now: ratedAt,
    }).stdSeconds - allowanceStdSeconds);
    const billableStd = activeIntervals.reduce((sum, interval) => sum + over(interval.end) - over(interval.start), 0);
    const cents = Math.min(Math.floor(billableStd / STD_SECONDS_PER_OVERAGE_CENT), capCents);
    if (cents === 0) return { status: 'skipped', reason: 'nothing_to_bill' };
    const { row } = await store.upsertOverageInvoice({ userId, subscriptionId, periodStart, periodEnd,
        ratingVersion: OVERAGE_RATING_VERSION, stdSecondsOver: BigInt(billableStd), cents });
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
