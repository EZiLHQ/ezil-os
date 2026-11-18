/**
 * The current-owner projection of one intent and its exact operation. Read only: one SELECT for ownership and
 * one for the operation stored under the SAME key. Never a proof, exchange, claim, write, wake or dispatch,
 * and never another operation of the session (no latest-operation substitution).
 *
 * Public receipt (root joint freeze r2), flat:
 * `{operationId, kind, sessionId, computerId, authorization: {state, expiresAt, authorizationUrl, reason}, operation, capabilities}`
 * where `operation` is the base operation view (no `replayed`) or null. It never carries the instruction;
 * only `loadNativeConsent` hands that to the owner's own page.
 */

import {
    lookupNativeOperation, nativeComputerOwnedNow, type NativeOperation,
} from '@/server/native-session/authority';
import { NATIVE_AUTHORIZATION_ENV } from '@/server/native-session/native-authorization-config';
import type { NativeHostTransport } from '@/server/native-session/host-transport';
import { nativeOperationView, type NativeOperationView } from '@/server/native-session/http';
import type { PlacementExecutor } from '@/server/lib/compute/placement';

import { nativeAuthorizePath, nativeTaskRef, type NativeCapabilities } from './contract';
import { nativeConsentRevokedAt, type NativeIntent, type NativeIntentState } from './store';

/**
 * How long after approval a missing operation is reported as still being dispatched. The broker claims
 * before its first network call, so after this an approved intent with no operation is `dispatch_unknown`:
 * reported as such, never retried, resumed or re-keyed.
 */
export const NATIVE_DISPATCH_CLAIM_WINDOW_MS = 60_000;

/**
 * The finite reasons a receipt may carry (root freeze r2, 23 codes). A stored reason outside this list is
 * reported as the safe fallback `authorization_unavailable`, never verbatim.
 */
export const NATIVE_AUTHORIZATION_REASONS: ReadonlySet<string> = new Set([
    'scope_missing', 'gateway_exchange_unconfigured', 'task_resolver_unavailable', 'host_unavailable', 'task_unavailable',
    'subject_token_unavailable', 'computer_not_found', 'computer_not_aws', 'computer_not_running', 'placement_unavailable',
    'lease_expired', 'computer_busy', 'placement_invalid', 'session_not_found', 'session_not_active', 'placement_changed',
    'renewal_pending', 'renewal_unreconciled', 'lease_boundary', 'session_exists', 'dispatch_refused', 'dispatch_pending',
    'dispatch_unknown',
]);
export const NATIVE_AUTHORIZATION_FALLBACK_REASON = 'authorization_unavailable';

export interface NativeAuthorizationView {
    state: NativeIntentState;
    expiresAt: string;
    /** Only while the intent can still be decided. Carries the operation id and nothing else. */
    authorizationUrl: string | null;
    reason: string | null;
}

export interface NativeIntentReceipt {
    operationId: string;
    kind: 'create' | 'renew';
    sessionId: string;
    computerId: string;
    authorization: NativeAuthorizationView;
    operation: NativeOperationView | null;
    capabilities: NativeCapabilities;
}

/**
 * What this deployment can actually deliver per kind, read without side effects: the sealed exchange
 * configuration and a private host transport that is available and supports the kind. Create's task resolver
 * is always the owned artifact resolver on the consent path. `renew` is false in this build whatever the host
 * says: a renewal needs a proof that does not come from a browser, and no such wire exists yet.
 */
export function nativeCapabilities(deps: { env: Readonly<Record<string, string | undefined>>; now: () => number; hostTransport: NativeHostTransport }): NativeCapabilities {
    const exchange = deps.env.EZIL_NATIVE_AUTHORIZATION === 'enabled' && NATIVE_AUTHORIZATION_ENV.every(key => Boolean(deps.env[key]));
    const host = deps.hostTransport;
    const create = exchange && host.available && host.supportsKind('create') === true;
    return { create, renew: false, status: true, send: false, prompts: false, answer: false, cancel: false };
}

/** The stored operation counts only when it is exactly the one this intent admits (renewals included). */
export function operationMatchesIntent(op: NativeOperation, intent: NativeIntent): boolean {
    if (op.userId !== intent.userId || op.operationId !== intent.operationId || op.kind !== intent.kind
        || op.sessionId !== intent.sessionId || op.computerId !== intent.computerId) return false;
    return intent.kind === 'renew' || (op.taskRef === nativeTaskRef(intent.operationId)
        && op.instructionDigest === intent.instructionDigest && op.instructionRevision === '1');
}

/** The intent's state as of `now`: an undecided intent past its expiry reads as expired without a write. */
export function projectedIntentState(intent: NativeIntent, now: number): { state: NativeIntentState; reason: string | null } {
    if (intent.state === 'required' && now >= intent.expiresAt.getTime()) return { state: 'expired', reason: null };
    return { state: intent.state, reason: intent.reason };
}

const safeReason = (reason: string | null) =>
    reason === null ? null : NATIVE_AUTHORIZATION_REASONS.has(reason) ? reason : NATIVE_AUTHORIZATION_FALLBACK_REASON;

/**
 * Null when the intent's computer is no longer a live computer of its owner (deleted or reassigned): the
 * caller answers 404 with no fields.
 */
export async function projectNativeIntent(db: PlacementExecutor, intent: NativeIntent, now: number, origin: string,
    capabilities: NativeCapabilities): Promise<NativeIntentReceipt | null> {
    if (!(await nativeComputerOwnedNow(db, intent.userId, intent.computerId))) return null;
    const stored = await lookupNativeOperation(db, intent.userId, intent.operationId);
    const operation = stored && operationMatchesIntent(stored, intent) ? stored : null;
    const projected = projectedIntentState(intent, now);
    const { state } = projected;
    let { reason } = projected;
    if (state === 'approved' && !operation) {
        // Approved, but no exact operation under this key: in flight within the claim window, else unknown.
        reason = now - (intent.decidedAt?.getTime() ?? now) < NATIVE_DISPATCH_CLAIM_WINDOW_MS ? 'dispatch_pending' : 'dispatch_unknown';
    }
    // A stopped consent reads as blocked/authorization_unavailable; the persisted intent and the exact operation
    // (grant and unknown metadata included) are reported unchanged.
    const revoked = intent.terms !== null && (await nativeConsentRevokedAt(db, intent.userId, intent.terms.authzId)) !== null;
    return {
        operationId: intent.operationId, kind: intent.kind, sessionId: intent.sessionId, computerId: intent.computerId,
        authorization: revoked ? { state: 'blocked', expiresAt: intent.expiresAt.toISOString(), authorizationUrl: null, reason: NATIVE_AUTHORIZATION_FALLBACK_REASON } : {
            state, expiresAt: intent.expiresAt.toISOString(),
            authorizationUrl: state === 'required' ? `${origin}${nativeAuthorizePath(intent.operationId)}` : null,
            reason: safeReason(reason),
        },
        operation: operation ? nativeOperationView(operation) : null,
        capabilities,
    };
}
