/**
 * RETRY-118, React side: what the `/computer/[id]` canvas's user-facing "Try again"
 * does. The shell's twin is `shell/ezil/session.js` `userRetry` / `readCapacityResetReply`.
 *
 * - The failure on screen is `capacity_attempt_expired` with a `capacityAttemptId`:
 *   reset exactly that attempt once (an in-flight guard joins repeated clicks), THEN
 *   reload through the normal boot, whatever the reset answered.
 * - Anything else: reload immediately, exactly as before.
 * - The reset reply is read strictly: only an app-level `ok` consistent with a known
 *   outcome counts; anything else is `malformed_reply`, a rejection is `request_failed`.
 *
 * Never call it from a poll, `refetchInterval` or TanStack's retry: those keep the code
 * terminal (`isRetryableBootErrorCode` is false for it).
 */
export type CapacityResetOutcome = 'reset' | 'already_reset' | 'superseded' | 'not_found';
export type CapacityRetryResult = { reset: boolean; outcome?: CapacityResetOutcome; errorCode?: 'malformed_reply' | 'request_failed' };

export interface CapacityRetryDeps {
    computerId: string;
    /** The preview answer currently rendered (a not-ok value), or undefined. */
    failure: unknown;
    reset(input: { computerId: string; attemptId: string }): Promise<unknown>;
    reload(): void;
    inFlight: { current: Promise<CapacityRetryResult> | null };
}

/** The app-level `ok` each known outcome must carry. */
const OUTCOME_OK: Record<CapacityResetOutcome, boolean> = { reset: true, already_reset: true, superseded: true, not_found: false };

/** The attempt id an explicit Retry may reset, or null. */
export function expiredCapacityAttemptId(failure: unknown): string | null {
    const f = failure as { ok?: unknown; errorCode?: unknown; capacityAttemptId?: unknown } | null | undefined;
    return f?.ok === false && f.errorCode === 'capacity_attempt_expired' && typeof f.capacityAttemptId === 'string'
        && f.capacityAttemptId !== '' ? f.capacityAttemptId : null;
}

/** Strict reading of a `resetCapacityAttempt` reply. */
export function readCapacityResetReply(reply: unknown): CapacityRetryResult {
    const r = reply as { ok?: unknown; outcome?: unknown } | null | undefined;
    const outcome = r && typeof r === 'object' ? r.outcome : undefined;
    if (typeof outcome !== 'string' || !Object.prototype.hasOwnProperty.call(OUTCOME_OK, outcome)
        || r!.ok !== OUTCOME_OK[outcome as CapacityResetOutcome]) return { reset: false, errorCode: 'malformed_reply' };
    return { reset: outcome === 'reset', outcome: outcome as CapacityResetOutcome };
}

export function retryAfterCapacityExpiry(deps: CapacityRetryDeps): Promise<CapacityRetryResult> {
    const attemptId = expiredCapacityAttemptId(deps.failure);
    if (!attemptId) {
        deps.reload();
        return Promise.resolve({ reset: false });
    }
    if (deps.inFlight.current) return deps.inFlight.current;
    const pending = deps.reset({ computerId: deps.computerId, attemptId })
        .then(readCapacityResetReply, (): CapacityRetryResult => ({ reset: false, errorCode: 'request_failed' }))
        .then((result) => {
            deps.inFlight.current = null;
            deps.reload(); // the next open's answer is the truth, never this one
            return result;
        });
    deps.inFlight.current = pending;
    return pending;
}
