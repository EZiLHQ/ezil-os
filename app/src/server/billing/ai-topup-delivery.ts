import type { BillingConfig } from './config';
import { drainAiCreditOutbox, type AiCreditOutboxStore } from './ai-credit-outbox';

/** The Gateway request budget of one in-request attempt (the sweep keeps its 10 s). */
export const AI_TOPUP_REQUEST_MS = 2_000;
/** The drain admits a claim only with the request plus 1 s left; 0.25 s more is the least room for the scope read and the claim. */
export const AI_TOPUP_ADMISSION_MS = AI_TOPUP_REQUEST_MS + 1_000 + 250;
/** The whole attempt when the caller names no deadline: a full second for the scope read and the claim. */
export const AI_TOPUP_BUDGET_MS = AI_TOPUP_REQUEST_MS + 1_000 + 1_000;

export type AiTopupDelivery = 'delivered' | 'queued' | 'review' | 'skipped';

/**
 * One bounded attempt to deliver the receipt of ONE paid top-up, on the request that just learned it is paid: the
 * verified webhook that committed it, and the payer's own `billing.topupStatus` poll while it is still pending. Until
 * now only the minute sweep delivered these receipts, so a paid top-up waited on a scheduler the payer cannot see.
 *
 * It is the normal outbox delivery, scoped to that one grant event (as `deliverStarterCredits` is for the Free
 * starter): the same atomic SKIP LOCKED claim with its 30 s lease, backoff (`nextAttemptAt`) and attempt cap, the same
 * account pin and finish fences, the same HMAC event and idempotent `eventId`. So a webhook, a poll and the sweep
 * cannot send it twice at once, a failed attempt is not repeated before its backoff, and a repeat the Gateway does
 * see applies once. The scope comes from the stored receipt (`topupScope`): its own owner, an existing ledger grant,
 * and no reversal on the payment. `userId` (the poll's signed-in user) only narrows it.
 *
 * - `skipped`: nothing here for another attempt to deliver: the store has no scope read, the payment has no
 *   deliverable receipt (none, another owner's, already delivered, terminally failed, or reversed), or the caller's
 *   deadline leaves under 3.25 s. Nothing was claimed.
 * - `delivered`: the Gateway acknowledged and the row is finished.
 * - `review`: this attempt ended the delivery for good (the Gateway refused the event, or its attempts ran out). The
 *   row is `failed` and waits for an operator (`requeueAiCredits`); no retry from a request will change it.
 * - `queued`: still genuinely pending (not due yet, leased by another worker, a failed or timed-out send, a store
 *   that could not be read or written, or a deliverable receipt while the funding URL or key is not configured:
 *   `funding_unconfigured`). The row keeps its normal retry state; the next attempt after its backoff (a poll, a
 *   webhook redelivery, the sweep) sends the same `eventId` again.
 *
 * Its log lines carry the status, attempt count and fixed reason code only: the event key of a top-up names its
 * payment, so it is not logged from a request. A terminal failure adds one error-level `ai-topup-delivery-alert`
 * line (paid, not credited, needs an operator) with the same fixed code and nothing that identifies the payer.
 *
 * Never throws, and never changes what the caller reports: a paid top-up stays "processing" until its receipt is done.
 */
export async function deliverPaidTopup(deps: {
    config: Pick<BillingConfig, 'fundingUrl' | 'fundingHmacSecret'>; aiCredits?: AiCreditOutboxStore;
}, input: { paymentIntentId: string; userId?: string; deadlineAt?: number; fetch?: typeof fetch; clock?: () => number }): Promise<AiTopupDelivery> {
    const clock = input.clock ?? Date.now;
    try {
        const store = deps.aiCredits;
        if (!store?.topupScope) return 'skipped';
        // One observation decides admission: a default deadline is never refused by the clock moving between two reads.
        const startedAt = clock();
        const deadlineAt = input.deadlineAt ?? startedAt + AI_TOPUP_BUDGET_MS;
        if (deadlineAt - startedAt < AI_TOPUP_ADMISSION_MS) return 'skipped';
        const scope = await store.topupScope({ paymentIntentId: input.paymentIntentId, ...(input.userId === undefined ? {} : { userId: input.userId }) });
        if (!scope || scope.kind !== 'ai_grant' || (input.userId !== undefined && scope.userId !== input.userId)) return 'skipped';
        // A paid receipt exists but this deployment cannot reach the Gateway right now (the funding URL or key is
        // missing): that is pending, not "nothing to deliver". Nothing is claimed, so no attempt or backoff is spent.
        if (!deps.config.fundingUrl || !deps.config.fundingHmacSecret) {
            console.warn(JSON.stringify({ event: 'ai-topup-delivery', status: 'pending', attempts: null, reason: 'funding_unconfigured' }));
            return 'queued';
        }
        const counts = await drainAiCreditOutbox({ config: deps.config, aiCredits: store, clock, fetch: input.fetch, log: () => {} },
            { limit: 1, deadlineMs: deadlineAt, requestTimeoutMs: AI_TOPUP_REQUEST_MS, scope, report: line => {
                console.info(JSON.stringify({ event: 'ai-topup-delivery', status: line.status, attempts: line.attempts, reason: line.reason }));
                if (line.status === 'failed') console.error(JSON.stringify({ event: 'ai-topup-delivery-alert', alert: 'paid_topup_not_credited', reason: line.reason }));
            } });
        return counts.done === 1 ? 'delivered' : counts.failed === 1 ? 'review' : 'queued';
    } catch {
        return 'queued';
    }
}
