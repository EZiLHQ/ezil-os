/**
 * Round 4 (plan jaunty-singing-tulip §12 D16-D19): the computer's standing, derived on every read and
 * never stored. Pure: subscriptions, open payment issues, the placement provider and `now` in, the
 * standing out. See docs/billing/STANDING-CONTRACT.md for the state table.
 *
 * - paid: a current paid period with no unresolved subscription payment issue.
 * - grace (D17): a raw `past_due` status or an unresolved subscription invoice issue. The paid
 *   computer stays usable until `graceEndsAt` = min(first issue + 7 days, Stripe's final action).
 *   The final action is an `uncollectible` invoice (its event time), or the status moving to
 *   `canceled`/`unpaid`, which drops at once. With no issue row a past_due anchors on the period start.
 * - plan_ending (D18): cancel_at_period_end inside the period; paid until `planEndsAt`.
 * - files_on_aws / free: on Free (no paid period, an immediate or dunning cancel, raw `unpaid`, a never-paid
 *   `incomplete`, or grace over). `files_on_aws` while any of the user's computers still has an aws-ec2
 *   placement (D16 hold); nothing has moved (the move is Phase B, `computer.move` stays null).
 * - D19: a refund is a negative grant, never a status change, so it never changes the standing.
 */
import type { SubscriptionRow } from '../meters';
import type { PaymentIssueRow } from '../ports';
import { epochSeconds, isoSeconds } from '../v2/time';
import { planFromSubscriptions } from './catalog';

export const PAYMENT_GRACE_DAYS = 7 as const;
export const PAYMENT_GRACE_SECONDS = PAYMENT_GRACE_DAYS * 86_400;

export type ComputeStandingV3 = 'paid' | 'grace' | 'plan_ending' | 'files_on_aws' | 'free';

export interface StandingV3 {
    standing: ComputeStandingV3;
    /** Set in grace: the paid computer is usable while now < graceEndsAt. */
    graceEndsAt: string | null;
    /** Set for a cancel at period end (also during grace): the paid period's end. */
    planEndsAt: string | null;
    /** Where the files are: the user's aws-ec2 placement, else Cloudflare. */
    filesOn: 'aws' | 'cloudflare';
    /** files_on_aws only: when the plan stopped covering the AWS computer; null when not recorded (an immediate cancel). */
    heldSince: string | null;
}

export type StandingIssue = Pick<PaymentIssueRow, 'subscriptionId' | 'invoiceKind' | 'issue' | 'resolvedAt' | 'stripeEventCreated'>;

const PAID_ACCESS: readonly ComputeStandingV3[] = ['paid', 'grace', 'plan_ending'];

/** True when the standing still gives the paid plan's computer (paid, grace or plan_ending). */
export const paidAccess = (standing: ComputeStandingV3): boolean => PAID_ACCESS.includes(standing);

const at = (date: Date) => isoSeconds(epochSeconds(date));

/** Unresolved issues on the subscription's own invoices (upgrade/overage invoices never threaten the plan). */
export function subscriptionIssues(issues: readonly StandingIssue[], subscriptionId: string | null): StandingIssue[] {
    return subscriptionId === null ? [] : issues.filter(issue => issue.subscriptionId === subscriptionId
        && issue.resolvedAt === null && issue.issue !== 'voided' && issue.invoiceKind === 'subscription');
}

/** min(first issue + 7 days, the first uncollectible issue); null when nothing anchors the grace. */
export function graceEndsAt(issues: readonly StandingIssue[], periodStart: Date | null): number | null {
    const times = (list: readonly StandingIssue[]) => list.filter(issue => Number.isFinite(issue.stripeEventCreated.getTime()))
        .map(issue => epochSeconds(issue.stripeEventCreated));
    const first = times(issues).sort((a, b) => a - b)[0];
    const anchor = first ?? (periodStart !== null && Number.isFinite(periodStart.getTime()) ? epochSeconds(periodStart) : undefined);
    if (anchor === undefined) return null;
    const finalAction = times(issues.filter(issue => issue.issue === 'uncollectible')).sort((a, b) => a - b)[0];
    return Math.min(anchor + PAYMENT_GRACE_SECONDS, finalAction ?? Infinity);
}

export function deriveStanding(input: {
    subscriptions: readonly SubscriptionRow[];
    paymentIssues: readonly StandingIssue[];
    /** Any aws-ec2 placement among the user's live computers → 'aws-ec2'; null = unknown or none. */
    placementProvider: 'aws-ec2' | 'cloudflare' | null;
    now: Date;
}): StandingV3 {
    const filesOn = input.placementProvider === 'aws-ec2' ? 'aws' : 'cloudflare';
    const now = epochSeconds(input.now);
    // The same subscription precedence as the plan the Billing tab shows.
    const plan = planFromSubscriptions({ subs: [...input.subscriptions], now: input.now, userCreatedAt: null });
    const sub = input.subscriptions.find(row => row.stripeSubscriptionId === plan.subscriptionId);
    const free = (heldSince: string | null): StandingV3 => ({
        standing: filesOn === 'aws' ? 'files_on_aws' : 'free', graceEndsAt: null, planEndsAt: null, filesOn,
        heldSince: filesOn === 'aws' ? heldSince : null,
    });
    if (!sub || plan.subscriptionId === null) return free(lastEndedPeriod(input.subscriptions, now));
    // planStatusFromStripe folds `unpaid` into past_due; D18 drops it at once (Stripe's final action).
    if (sub.status === 'unpaid' || plan.status === 'incomplete') return free(null);
    const issues = subscriptionIssues(input.paymentIssues, plan.subscriptionId);
    const planEndsAt = plan.status === 'cancels' || sub.cancelAtPeriodEnd ? plan.cancelsAt : null;
    if (sub.status === 'past_due' || issues.length) {
        const ends = graceEndsAt(issues, sub.status === 'past_due' ? sub.currentPeriodStart : null);
        if (ends !== null && now < ends) return { standing: 'grace', graceEndsAt: isoSeconds(ends), planEndsAt, filesOn, heldSince: null };
        return free(ends === null ? null : isoSeconds(ends));
    }
    if (!plan.planActive) return free(null);
    if (plan.status === 'cancels') return { standing: 'plan_ending', graceEndsAt: null, planEndsAt, filesOn, heldSince: null };
    return { standing: 'paid', graceEndsAt: null, planEndsAt: null, filesOn, heldSince: null };
}

/**
 * When the newest paid subscription's period ended in the past, that end is when Free began (a cancel at
 * period end, or an expired period). An immediate cancel keeps a future period end and records no cancel
 * time on the row, so it is unknown (null), never guessed.
 */
function lastEndedPeriod(subs: readonly SubscriptionRow[], now: number): string | null {
    const ends = subs.map(sub => sub.currentPeriodEnd).filter((end): end is Date => end !== null && Number.isFinite(end.getTime()))
        .sort((a, b) => b.getTime() - a.getTime());
    const newest = ends[0];
    return newest !== undefined && epochSeconds(newest) <= now ? at(newest) : null;
}
