/**
 * Read-only: the exact finite consent binding an approved native operation runs under, for the separate
 * Gateway-proof lane. Never writes, refreshes, exchanges, wakes or dispatches.
 *
 * One READ COMMITTED transaction under the broker's own computer authority read (`currentAuthority`: the
 * canonical per-computer advisory lock, the live owner row `FOR SHARE`, the placement module's read, AWS,
 * RUNNING, instance, fence and an unexpired lease). The binding is answered only while ALL of this holds now:
 * - the owner's intent under that exact operation id is `approved` WITH terms (an approved row from before
 *   terms existed is null, never upgraded), the owner has not revoked that consent, and the authorization
 *   deadline has not passed;
 * - the computer is still the owner's and the live tuple equals the tuple pinned at approval, exactly, with
 *   generation and lease epoch >= 1;
 * - if the broker has claimed an operation under the same key, it is the same kind, session and computer
 *   (and, for a create, the derived task and digest) and its pinned tuple equals the approved tuple.
 * Authorization is separate from execution: the operation's state is NOT consulted, so a live consent stays
 * readable while its operation is `exchange_unknown` or `delivery_unknown`, for explicit reconciliation of that
 * same original operation. Reading it never replays, resends or restarts anything.
 * The approved tuple is the one stored at consent; it is never inferred from later placement or operations.
 */

import { sql } from 'drizzle-orm';

import type { PlacementExecutor } from '@/server/lib/compute/placement';
import { currentAuthority, samePlacement, type NativeAuthorityDb } from '@/server/native-session/authority';

import { NATIVE_CONSENT_PROFILE, NATIVE_CONSENT_SERVICE, POSITIVE_DECIMAL, UUID, nativeTaskRef } from './contract';
import { lookupNativeIntent, nativeConsentRevokedAt } from './store';

/** Root's exact binding shape. Strings only; times are canonical UTC with milliseconds. */
export interface NativeConsentBinding {
    authorizationId: string;
    /** Positive canonical decimals. */
    epoch: string;
    budgetMicro: string;
    ownerUserId: string;
    sessionId: string;
    computerId: string;
    /** The full tuple approved at consent; generation and lease epoch are positive canonical decimals. */
    placement: { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string };
    clientId: string;
    serviceId: typeof NATIVE_CONSENT_SERVICE;
    profileId: typeof NATIVE_CONSENT_PROFILE;
    policyId: string;
    initialApprovalAt: string;
    authorizationDeadline: string;
}

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

/**
 * The immutable binding a create consent recorded, tagged `purpose: 'history'` so it can never be passed where a
 * live binding (`readConsent`) is expected. Historical identity is NOT permission: no owner, tuple, lease,
 * deadline or revocation check is made. Use it only for a receipt namespace or revoke cleanup, never to submit,
 * renew or admit anything.
 */
export interface NativeConsentHistory {
    readonly binding: Readonly<NativeConsentBinding>;
    readonly purpose: 'history';
}

/** `key.operationId` is the ORIGINAL create consent operation id. Null when it never bound terms. */
export async function readNativeConsentHistory(db: PlacementExecutor,
    key: { ownerUserId: string; operationId: string }): Promise<NativeConsentHistory | null> {
    const { ownerUserId, operationId } = key;
    if (!UUID.test(ownerUserId) || !UUID.test(operationId)) throw new TypeError('invalid native consent key');
    const intent = await lookupNativeIntent(db, ownerUserId, operationId);
    const terms = intent?.terms;
    if (!intent || intent.kind !== 'create' || !terms) return null;
    return Object.freeze({
        purpose: 'history' as const,
        binding: Object.freeze({
            authorizationId: terms.authzId, epoch: terms.epoch, budgetMicro: terms.budgetMicro, ownerUserId, sessionId: intent.sessionId,
            computerId: intent.computerId, placement: Object.freeze({ ...terms.placement }), clientId: intent.clientId, serviceId: terms.service,
            profileId: terms.profile, policyId: terms.policyId, initialApprovalAt: terms.initialApprovalAt.toISOString(),
            authorizationDeadline: terms.authorizationDeadline.toISOString(),
        }),
    });
}

/** Opens its own READ COMMITTED transaction and runs `readApprovedNativeConsentBindingTx` in it. */
export function readApprovedNativeConsentBinding(db: NativeAuthorityDb,
    key: { ownerUserId: string; operationId: string }): Promise<Readonly<NativeConsentBinding> | null> {
    if (!UUID.test(key.ownerUserId) || !UUID.test(key.operationId)) throw new TypeError('invalid native consent key');
    return db.transaction(tx => readApprovedNativeConsentBindingTx(tx, key));
}

/**
 * The same read inside the CALLER's transaction (for example the Gateway-proof outbox's own), which must be READ
 * COMMITTED: the broker's computer lock asserts it. Takes the canonical computer lock and the owner row `FOR SHARE`
 * in that transaction; no nested transaction is opened. `key.operationId` is the ORIGINAL create consent
 * operation id, also for every renewal under that consent (never a per-renewal operation id).
 */
export async function readApprovedNativeConsentBindingTx(tx: PlacementExecutor,
    key: { ownerUserId: string; operationId: string }): Promise<Readonly<NativeConsentBinding> | null> {
    const { ownerUserId, operationId } = key;
    if (!UUID.test(ownerUserId) || !UUID.test(operationId)) throw new TypeError('invalid native consent key');
    // The computer id is immutable intent identity; reading it first only selects which lock to take.
    const located = await lookupNativeIntent(tx, ownerUserId, operationId);
    if (!located?.terms) return null;
    const authority = await currentAuthority(tx, ownerUserId, located.computerId);
    if (!authority.ok) return null;
    const intent = await lookupNativeIntent(tx, ownerUserId, operationId);
    const terms = intent?.terms;
    if (!intent || intent.state !== 'approved' || !terms || intent.computerId !== located.computerId) return null;
    const approved = terms.placement;
    if (!POSITIVE_DECIMAL.test(approved.generation) || !POSITIVE_DECIMAL.test(approved.leaseEpoch) || !samePlacement(approved, authority.placement)) return null;

    // A local STOP is terminal for the whole consent, whatever the Gateway-side revocation outcome.
    if (await nativeConsentRevokedAt(tx, ownerUserId, terms.authzId)) return null;

    const clock = rowsOf(await tx.execute(sql`/* native-auth:binding-clock */ SELECT clock_timestamp() AS now`))[0]?.now;
    const now = clock instanceof Date ? clock.getTime() : Date.parse(String(clock));
    if (!Number.isFinite(now) || terms.authorizationDeadline.getTime() <= now) return null;

    const ops = rowsOf(await tx.execute(sql`/* native-auth:binding-operation */ SELECT kind, session_id::text AS session_id,
        computer_id::text AS computer_id, instruction_digest, task_ref, placement_generation::text AS generation,
        placement_lease_epoch::text AS lease_epoch, placement_instance_id AS instance_id, placement_fence_token::text AS fence_token
        FROM public.ezil_native_session_operations WHERE user_id = ${ownerUserId}::uuid AND operation_id = ${operationId}::uuid`));
    if (ops.length > 1) return null;
    const op = ops[0];
    if (op && (op.kind !== intent.kind || op.session_id !== intent.sessionId || op.computer_id !== intent.computerId
        || (intent.kind === 'create' && (op.task_ref !== nativeTaskRef(operationId) || op.instruction_digest !== intent.instructionDigest))
        || !samePlacement(approved, { generation: String(op.generation), leaseEpoch: String(op.lease_epoch), instanceId: String(op.instance_id),
            fenceToken: String(op.fence_token) }))) return null;

    return Object.freeze({
        authorizationId: terms.authzId, epoch: terms.epoch, budgetMicro: terms.budgetMicro, ownerUserId, sessionId: intent.sessionId,
        computerId: intent.computerId, placement: Object.freeze({ ...approved }), clientId: intent.clientId, serviceId: terms.service,
        profileId: terms.profile, policyId: terms.policyId, initialApprovalAt: terms.initialApprovalAt.toISOString(),
        authorizationDeadline: terms.authorizationDeadline.toISOString(),
    });
}
