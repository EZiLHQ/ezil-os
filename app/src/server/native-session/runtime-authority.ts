/**
 * Native runtime authority: who may observe or control one native session, resolved from stored facts only.
 *
 * - The session is the caller's `0029` create (`readNativeSessionStatus`, live owned computer, no lock or write).
 * - The native AI binding comes from the auth-intent lane (`0031`) through `NativeAiAuthorityPort` only: history is
 *   identification, `active` is the live approval (null proves nothing about why), revocation is positive stop
 *   metadata. This module imports nothing of `0031`; the production port is absent until that lane freezes its
 *   exports, which blocks every runtime call with `session_binding_unavailable`.
 * - The current placement is read the way `authority.ts` admits one (owned computer row, the placement module's
 *   read, AWS, RUNNING, well-formed instance and fence, unexpired lease on the database clock), in one read-only
 *   statement sequence with no advisory lock and no write.
 *
 * Nothing here calls the host, mints, wakes, renews or writes.
 */
import { sql } from 'drizzle-orm';

import {
    ImageJobConflictError, PlacementIntegrityError, PlacementOwnerError, readPlacement, type PlacementExecutor,
} from '@/server/lib/compute/placement';
import { readNativeSessionStatus, type NativeOperation } from './authority';
import {
    PRODUCER_DIGEST, isUuid, isoTimestamp, type AiAuthorizationBinding, type RuntimePlacement, type RuntimeReason,
} from './runtime-contract';

/** The immutable `0031` consent binding of one session as the auth owner exports it (identification only). */
export interface NativeAiConsentBinding {
    authorizationId: string;
    originalOAuthClientId: string;
    sessionId: string;
    computerId: string;
    expiresAt: string;
    policyDigest: string | null;
}

/** Adapter over the auth owner's frozen exports. Every method is read-only; throwing fails closed. */
export interface NativeAiAuthorityPort {
    /** `readNativeConsentHistory(db, {ownerUserId, operationId})`: the binding snapshot, or null. Not permission. */
    history(ownerUserId: string, createOperationId: string): Promise<NativeAiConsentBinding | null>;
    /** The live approved binding, or null. Null is "not active"; no cause is inferred from it. */
    active(ownerUserId: string, createOperationId: string): Promise<NativeAiConsentBinding | null>;
    /** `readNativeConsentRevocation(db, userId, authzId)`: positive captured stop metadata, else null. */
    revocation(ownerUserId: string, authorizationId: string): Promise<{ revokedAt: string } | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;

function rowsOf(result: unknown): Record<string, unknown>[] {
    if (Array.isArray(result)) return result as Record<string, unknown>[];
    return ((result as { rows?: Record<string, unknown>[] } | null)?.rows ?? []) as Record<string, unknown>[];
}

function validBinding(b: NativeAiConsentBinding | null, ownerSession: { sessionId: string; computerId: string }): b is NativeAiConsentBinding {
    return b !== null && isUuid(b.authorizationId) && typeof b.originalOAuthClientId === 'string'
        && b.originalOAuthClientId.length >= 1 && b.originalOAuthClientId.length <= 512
        && b.sessionId === ownerSession.sessionId && b.computerId === ownerSession.computerId && isoTimestamp(b.expiresAt) !== null
        && (b.policyDigest === null || (typeof b.policyDigest === 'string' && PRODUCER_DIGEST.test(b.policyDigest)));
}

export interface RuntimeSessionBinding {
    ownerUserId: string;
    sessionId: string;
    computerId: string;
    /** The session's `0029` create: its `operationId` is the original consent operation and the initial task id. */
    created: NativeOperation;
    originalOAuthClientId: string;
    aiAuthorization: AiAuthorizationBinding;
}

export type SessionBindingResult =
    | { ok: true; binding: RuntimeSessionBinding }
    | { ok: false; status: 'not_found' }
    | { ok: false; status: 'blocked'; reason: RuntimeReason };

/**
 * The caller's session, its original client and its AI state. `not_found` covers absent, another owner's, a
 * deleted or reassigned computer, and another client's session: none of them is distinguishable from absent.
 */
export async function resolveSessionBinding(db: PlacementExecutor, port: NativeAiAuthorityPort | null, ownerUserId: string,
    clientId: string, sessionId: string): Promise<SessionBindingResult> {
    const status = await readNativeSessionStatus(db, ownerUserId, sessionId);
    if (!status) return { ok: false, status: 'not_found' };
    if (!port) return { ok: false, status: 'blocked', reason: 'session_binding_unavailable' };
    const created = status.created;
    const scope = { sessionId, computerId: created.computerId };
    let history: NativeAiConsentBinding | null;
    try { history = await port.history(ownerUserId, created.operationId); } catch { history = null; }
    // An old cookie create without a 0031 row has no binding and is never upgraded.
    if (!validBinding(history, scope)) return { ok: false, status: 'blocked', reason: 'session_binding_unavailable' };
    if (history.originalOAuthClientId !== clientId) return { ok: false, status: 'not_found' };
    let state: AiAuthorizationBinding['state'] = 'inactive';
    try {
        const revoked = await port.revocation(ownerUserId, history.authorizationId);
        if (revoked) state = 'revoked';
        else {
            const live = await port.active(ownerUserId, created.operationId);
            if (validBinding(live, scope) && live.authorizationId === history.authorizationId
                && live.originalOAuthClientId === history.originalOAuthClientId) state = 'active';
        }
    } catch {
        state = 'inactive';
    }
    return {
        ok: true,
        binding: {
            ownerUserId, sessionId, computerId: created.computerId, created, originalOAuthClientId: history.originalOAuthClientId,
            aiAuthorization: { authorizationId: history.authorizationId, state, expiresAt: history.expiresAt, policyDigest: history.policyDigest },
        },
    };
}

export type CurrentPlacement = { ok: true; placement: RuntimePlacement; leaseUntil: Date; now: Date } | { ok: false; reason: RuntimeReason };

/** The live placement of an owned computer, as admission would see it; read-only (no lock, no write). */
export async function readCurrentPlacement(db: PlacementExecutor, ownerUserId: string, computerId: string): Promise<CurrentPlacement> {
    if (!UUID.test(ownerUserId) || !UUID.test(computerId)) throw new TypeError('invalid runtime placement key');
    const owner = rowsOf(await db.execute(sql`/* native-runtime:computer-owner */ SELECT id::text AS id FROM public.ezil_computers
        WHERE id = ${computerId}::uuid AND user_id = ${ownerUserId}::uuid AND deleted_at IS NULL`));
    if (owner.length !== 1) return { ok: false, reason: 'computer_not_found' };
    let record;
    try {
        record = (await readPlacement(db, computerId, ownerUserId)).record;
    } catch (error) {
        if (error instanceof PlacementOwnerError) return { ok: false, reason: 'computer_not_found' };
        if (error instanceof ImageJobConflictError) return { ok: false, reason: 'computer_busy' };
        if (error instanceof PlacementIntegrityError) return { ok: false, reason: 'placement_invalid' };
        throw error;
    }
    if (!record || record.provider !== 'aws-ec2') return { ok: false, reason: 'computer_not_aws' };
    if (record.state !== 'RUNNING') return { ok: false, reason: 'computer_not_running' };
    const fenceToken = record.fenceToken?.toLowerCase() ?? '';
    if (!record.instanceId || !INSTANCE.test(record.instanceId) || !UUID.test(fenceToken)) return { ok: false, reason: 'placement_unavailable' };
    const clock = rowsOf(await db.execute(sql`/* native-runtime:clock */ SELECT clock_timestamp() AS now`))[0]?.now;
    const now = clock instanceof Date ? clock : typeof clock === 'string' ? new Date(clock) : null;
    if (!now || !Number.isFinite(now.getTime())) throw new TypeError('invalid database clock');
    if (!record.leaseUntil || record.leaseUntil.getTime() <= now.getTime()) return { ok: false, reason: 'lease_expired' };
    return {
        ok: true,
        placement: { generation: String(record.generation), leaseEpoch: String(record.leaseEpoch), instanceId: record.instanceId, fenceToken },
        leaseUntil: record.leaseUntil,
        now,
    };
}
