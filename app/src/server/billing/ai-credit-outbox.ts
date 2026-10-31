import type { BillingConfig } from './config';
import { AI_CREDIT_PROTOCOL, parseAiCreditEventId } from './ai-credits';
import { AI_GATEWAY_TIMEOUT_MS, sendAiCreditEvent, type AiGatewayEvent, type AiLogger, type AiRestoreOutcome } from './ai-gateway-client';

export const AI_CREDIT_MAX_ATTEMPTS = 10;
export const AI_CREDIT_LEASE_MS = 30_000;
export interface AiCreditOutboxRow {
    id: string; eventKey: string; userId: string; kind: string; payload: Record<string, unknown>; attempts: number; exhausted?: boolean;
    /** Completed account waits do not consume the delivery failure budget. */
    dependencyWaits?: number;
    restoreConflict?: boolean;
    restoreDisposition?: 'terminal' | 'review' | null;
}
export interface AiCreditDelivery {
    status: 'done' | 'failed' | 'retry'; reason: string | null; nextAttemptAt?: number;
    outcome?: AiRestoreOutcome; reviewRequired?: boolean;
    /** Round 5 D1: why a `no_ai_account` wait is still blocked (the drain's enrollment result); stored as delivery.blockedBy. */
    blockedBy?: AiEnrollForResult;
}
/**
 * Round 5 D1 drain-side enrollment result (fixed codes only):
 * `enrolled`; `needs_ezil_id` (no EZiL ID linked: parked 24 h, woken by the sign-in kick);
 * `refused:<SQL refusal | email_unconfirmed | user_not_found>`; `unavailable:<OS-side code>`.
 */
export type AiEnrollForResult = 'enrolled' | 'needs_ezil_id' | `refused:${string}` | `unavailable:${string}`;
/** At most this many enrollment attempts per drain pass (each user at most once). */
export const AI_ENROLL_MAX_PER_PASS = 3;
/**
 * Worst-case enrollFor time: the admin read and any email confirm (one shared 2 s window) + the owned-client work (5 s,
 * ai-enrollment.ts WORK_MS) + close (1 s) + 1 s margin. The drain enrolls only while this
 * plus one Gateway request (10 s + 1 s) still fits before the deadline, i.e. with >= 20 s left.
 */
export const AI_ENROLL_BUDGET_MS = 9_000;
export const AI_ENROLL_ADMIN_READ_MS = 2_000;
/** needs_ezil_id rows wait a day (not hourly); a successful EZiL ID sign-in kicks them at once. */
export const AI_NEEDS_EZIL_ID_PARK_MS = 24 * 3_600_000;
/**
 * A user's stored AI grant receipt: the frozen wire terms and whether the Gateway acknowledged it.
 * `failed` (round 5 D1): delivery ended terminally (never "waiting"; an operator requeue clears it).
 */
export interface AiCreditReceipt { entitlementId: string; credits: number; expiresAt: string; deliveredAt: string | null; failed?: true }
export interface AiCreditOutboxStore {
    claim(now: number): Promise<AiCreditOutboxRow | null>;
    accountFor(row: AiCreditOutboxRow): Promise<string | null>;
    pinAccount(row: AiCreditOutboxRow, accountPublicId: string): Promise<boolean>;
    finish(row: AiCreditOutboxRow, result: AiCreditDelivery, now: number): Promise<void>;
    /**
     * Round 5 D1 (optional): try to enroll the user as an AI member with the stored EZiL ID subject.
     * Must not throw (the drain maps a throw to `unavailable:connect_failed`).
     */
    enrollFor?(userId: string): Promise<AiEnrollForResult>;
    /** Newest first, at most 200 grant receipts of one user (read-only; splits the balance by bucket). */
    receiptsFor?(userId: string): Promise<AiCreditReceipt[]>;
    /** Operator-only (D5): dry run unless `apply`; see `planAiCreditRequeue`. */
    requeueFailed?(input: AiCreditRequeueInput): Promise<AiCreditRequeueResult>;
}

export interface AiCreditRequeueInput { eventKeys?: readonly string[]; userId?: string; apply: boolean; now: number }
export interface AiCreditRequeueCandidate {
    id: string; eventKey: string; userId: string; kind: string; payload: Record<string, unknown>;
    attempts: number; lastError: string | null; revoked: boolean;
}
export type AiCreditRequeueDecision = 'eligible' | 'requeued' | 'lost_race' | 'still_expired' | 'revoked' | 'not_retryable' | 'invalid_payload';
export interface AiCreditRequeueResult {
    dryRun: boolean; selected: number; eligible: number; requeued: number;
    decisions: { eventKey: string; userId: string; lastError: string | null; decision: AiCreditRequeueDecision }[];
}

/**
 * Round 3 D5: only grants that can still be delivered are reset. The six wire fields are
 * immutable, so a grant past its expiry stays failed (`still_expired`: it needs a new grant at
 * current terms, never a replay); a revoked root, a restore, or a permanent payload/review
 * failure is never replayed.
 */
const REQUEUE_REASONS = new Set(['no_ai_account', 'account_not_found', 'attempts_exhausted', 'delivery_unavailable',
    'deadline_or_lease', 'transport_unavailable', 'expired']);
const requeueable = (reason: string | null) => reason !== null && (REQUEUE_REASONS.has(reason) || /^http_5\d\d$/.test(reason));
export function planAiCreditRequeue(row: AiCreditRequeueCandidate, now: number): AiCreditRequeueDecision {
    const event = plannedAiCreditEvent(row);
    if (row.kind !== 'ai_grant' || !event || event.action !== 'grant') return 'invalid_payload';
    if (row.revoked) return 'revoked';
    if (Date.parse(event.expiresAt) <= now) return 'still_expired';
    if ((row.payload.delivery as { reviewRequired?: unknown } | undefined)?.reviewRequired === true
        || !requeueable(row.lastError)) return 'not_retryable';
    return 'eligible';
}
export const aiCreditBackoffMs = (attempt: number) => Math.min(3_600_000, 60_000 * 2 ** Math.max(0, attempt - 1));
export const isAiAccountDependency = (reason: string | null) => reason === 'no_ai_account' || reason === 'account_not_found';

export const isAiDeliveryDependency = (reason: string | null) => isAiAccountDependency(reason) || reason === 'restore_hold_pending';

export function plannedAiCreditEvent(row: AiCreditOutboxRow): Omit<AiGatewayEvent, 'accountPublicId'> | null {
    const p = row.payload;
    if (p.protocol !== AI_CREDIT_PROTOCOL || typeof p.entitlementId !== 'string'
        || (p.action !== 'grant' && p.action !== 'revoke' && p.action !== 'restore') || row.kind !== `ai_${p.action}`
        || typeof p.eventId !== 'string' || !parseAiCreditEventId(p.entitlementId, p.eventId, p.action) || row.eventKey !== p.eventId
        || typeof p.credits !== 'number' || !Number.isSafeInteger(p.credits) || p.credits < 1 || p.credits > 1_000_000
        || typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt))) return null;
    return { eventId: p.eventId, entitlementId: p.entitlementId, action: p.action, credits: p.credits, expiresAt: p.expiresAt };
}

let warnedDisabled = false;
/** deadlineMs is an absolute wall-clock deadline shared with the session sweep. */
export async function drainAiCreditOutbox(deps: {
    config: Pick<BillingConfig, 'fundingUrl' | 'fundingHmacSecret'>;
    aiCredits?: AiCreditOutboxStore; clock?: () => number; fetch?: typeof fetch; log?: AiLogger;
}, { limit, deadlineMs }: { limit: number; deadlineMs: number }) {
    const counts = { claimed: 0, done: 0, failed: 0, retry: 0, skipped: 0 };
    const log = deps.log ?? console.warn;
    if (!deps.config.fundingUrl || !deps.config.fundingHmacSecret) {
        if (!warnedDisabled) { warnedDisabled = true; log('[billing.ai] funding disabled'); }
        return counts;
    }
    const store = deps.aiCredits;
    if (!store) return counts;
    const clock = deps.clock ?? Date.now;
    const hasTime = () => deadlineMs - clock() >= AI_GATEWAY_TIMEOUT_MS + 1_000;
    // Round 5 D1: one enrollment attempt per user per pass, at most AI_ENROLL_MAX_PER_PASS per pass.
    const enrolledThisPass = new Map<string, AiEnrollForResult>();
    const enrollOnce = async (userId: string): Promise<AiEnrollForResult | 'deferred'> => {
        const known = enrolledThisPass.get(userId);
        if (known) return known;
        if (enrolledThisPass.size >= AI_ENROLL_MAX_PER_PASS
            || deadlineMs - clock() < AI_GATEWAY_TIMEOUT_MS + 1_000 + AI_ENROLL_BUDGET_MS) return 'deferred';
        let result: AiEnrollForResult;
        try { result = await store.enrollFor!(userId); }
        catch { result = 'unavailable:connect_failed'; }
        enrolledThisPass.set(userId, result);
        return result;
    };
    for (let i = 0; i < Math.min(200, Math.max(0, Math.floor(limit))); i++) {
        if (!hasTime()) break;
        const row = await store.claim(clock());
        if (!row) break;
        counts.claimed++;
        let result: AiCreditDelivery;
        let enroll: AiEnrollForResult | 'deferred' | undefined;
        const event = plannedAiCreditEvent(row);
        if (row.exhausted) result = { status: 'failed', reason: 'attempts_exhausted' };
        else if (!event) result = { status: 'failed', reason: 'invalid_payload', ...(row.kind === 'ai_restore' ? { reviewRequired: true } : {}) };
        else if (row.restoreDisposition === 'terminal') result = { status: 'done', reason: null, outcome: 'restore_refused_terminal' };
        else if (row.restoreDisposition === 'review') result = { status: 'failed', reason: 'restore_review_required', reviewRequired: true };
        else if (row.restoreConflict) result = { status: 'failed', reason: 'restore_mismatch', reviewRequired: true };
        else if (event.action === 'grant' && Date.parse(event.expiresAt) <= clock()) result = { status: 'failed', reason: 'expired' };
        else {
            try {
                let account = typeof row.payload.accountPublicId === 'string' ? row.payload.accountPublicId : await store.accountFor(row);
                // Round 5 D1: a grant waiting on the account tries enrollment (stored EZiL ID subject) and,
                // once enrolled, continues to pin/send in this pass. The reason stays no_ai_account.
                if (!account && event.action === 'grant' && store.enrollFor) {
                    enroll = await enrollOnce(row.userId);
                    if (enroll === 'enrolled') account = await store.accountFor(row);
                }
                // A sign-in can link, enroll and kick while this row is processing (the kick skips
                // processing rows): re-read the account before parking it for a day (lost wakeup).
                if (!account && enroll === 'needs_ezil_id') account = await store.accountFor(row);
                if (!account) {
                    result = { status: 'retry', reason: 'no_ai_account',
                        ...(enroll && enroll !== 'deferred' ? { blockedBy: enroll } : {}),
                        ...(enroll === 'needs_ezil_id' ? { nextAttemptAt: clock() + AI_NEEDS_EZIL_ID_PARK_MS } : {}) };
                    counts.skipped++;
                } else if (!hasTime() || !await store.pinAccount(row, account) || !hasTime()) {
                    result = { status: 'retry', reason: 'deadline_or_lease' };
                } else {
                    const sent = await sendAiCreditEvent({ url: deps.config.fundingUrl, secret: deps.config.fundingHmacSecret,
                        event: { ...event, accountPublicId: account }, fetch: deps.fetch, now: clock, log });
                    result = sent.status === 'ok' ? { status: 'done', reason: null, ...(sent.outcome ? { outcome: sent.outcome } : {}) }
                        : { status: sent.status === 'retryable' ? 'retry' : 'failed', reason: sent.reason,
                            ...(sent.status === 'review' ? { reviewRequired: true } : {}) };
                    if (sent.status === 'review') log('[billing.ai] restore review required', { entitlementId: event.entitlementId });
                }
            } catch (error) {
                // SQL/transport errors may contain URLs, credentials or tokens. Store only a fixed code.
                result = error instanceof Error && error.message === 'ai_payer_conflict'
                    ? { status: 'failed', reason: 'restore_mismatch', reviewRequired: true }
                    : { status: 'retry', reason: 'delivery_unavailable' };
            }
        }
        if (result.status === 'retry') {
            if (!isAiDeliveryDependency(result.reason) && row.attempts - (row.dependencyWaits ?? 0) >= AI_CREDIT_MAX_ATTEMPTS) {
                result = { status: 'failed', reason: 'attempts_exhausted' };
            }
            else result.nextAttemptAt ??= clock() + aiCreditBackoffMs(row.attempts);
        }
        await store.finish(row, result, clock());
        // One structured line per finished delivery (ids and fixed codes only, never payload values).
        console.info(JSON.stringify({ event: 'ai-outbox', eventKey: row.eventKey, status: result.status,
            attempts: row.attempts, reason: result.reason, ...(enroll ? { enroll } : {}) }));
        counts[result.status]++;
    }
    return counts;
}
