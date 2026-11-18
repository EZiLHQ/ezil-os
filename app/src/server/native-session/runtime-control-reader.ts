/**
 * The OS fresh control reader the host calls before any native effect (docs/NATIVE-RUNTIME-CONTROL-v1.md §10).
 *
 * Returns the stored immutable resolved scope of exactly one dispatching control request, and only while every
 * current fact still holds: the request is `dispatching` under its approved lease, the caller's ids and digest
 * match, the owner still owns the computer, the live placement equals the lease's, the request deadline is in the
 * future on the database clock, and for send/answer the session's `0031` AI authorization is active and is the one
 * the lease was prepared under. No writes, no locks across calls, no host or network call.
 */
import type { PlacementExecutor } from '@/server/lib/compute/placement';
import { readCurrentPlacement, resolveSessionBinding, type NativeAiAuthorityPort } from './runtime-authority';
import {
    DIGEST, RUNTIME_PROFILE_ID, RUNTIME_LIMITS, canonicalScope, isoTimestamp, isUuid, samePlacement, type ControlKind, type RuntimeReason, type RuntimeRequestScope,
} from './runtime-contract';
import { lookupRuntimeRequest } from './runtime-store';

export interface RuntimeControlRecheckInput {
    ownerUserId: string;
    requestId: string;
    controlAuthorizationId: string;
    requestDigest: string;
    action: ControlKind;
}

export interface ResolvedRuntimeControl {
    scope: RuntimeRequestScope;
    action: ControlKind;
    rootRequestId: string;
    requestDigest: string;
    deadline: string;
}

export type RuntimeControlRecheck = { ok: true; resolved: ResolvedRuntimeControl } | { ok: false; reason: RuntimeReason | 'request_not_dispatching' };

export async function recheckNativeRuntimeControl(db: PlacementExecutor, port: NativeAiAuthorityPort | null,
    input: RuntimeControlRecheckInput): Promise<RuntimeControlRecheck> {
    if (!isUuid(input.ownerUserId) || !isUuid(input.requestId) || !isUuid(input.controlAuthorizationId)
        || !DIGEST.test(input.requestDigest) || !['send', 'answer', 'cancel'].includes(input.action)) {
        return { ok: false, reason: 'authorization_unavailable' };
    }
    const stored = await lookupRuntimeRequest(db, input.ownerUserId, input.requestId);
    if (!stored || !stored.lease) return { ok: false, reason: 'request_not_dispatching' };
    const { request, lease } = stored;
    if (request.state !== 'dispatching' || lease.state !== 'approved' || lease.controlAuthorizationId !== input.controlAuthorizationId
        || request.requestDigest !== input.requestDigest || request.kind !== input.action || !request.requestDeadline) {
        return { ok: false, reason: 'request_not_dispatching' };
    }
    const live = await readCurrentPlacement(db, request.ownerUserId, request.computerId);
    if (!live.ok) return { ok: false, reason: live.reason };
    if (!samePlacement(live.placement, lease.placement)) return { ok: false, reason: 'placement_changed' };
    if (request.requestDeadline.getTime() <= live.now.getTime() || lease.controlDeadline.getTime() <= live.now.getTime()) {
        return { ok: false, reason: 'control_deadline_passed' };
    }
    const session = await resolveSessionBinding(db, port, request.ownerUserId, request.clientId, request.sessionId);
    if (!session.ok) return { ok: false, reason: session.status === 'blocked' ? session.reason : 'session_not_found' };
    const ai = session.binding.aiAuthorization;
    if (ai.authorizationId !== lease.aiAuthorizationId) return { ok: false, reason: 'ai_authorization_inactive' };
    if (request.kind !== 'cancel' && ai.state !== 'active') {
        return { ok: false, reason: ai.state === 'revoked' ? 'ai_authorization_revoked' : 'ai_authorization_inactive' };
    }
    // Network-backed consent reads finish before the final owner/placement/deadline fence.
    const finalLive = await readCurrentPlacement(db, request.ownerUserId, request.computerId);
    if (!finalLive.ok) return { ok: false, reason: finalLive.reason };
    if (!samePlacement(finalLive.placement, lease.placement)) return { ok: false, reason: 'placement_changed' };
    if (request.requestDeadline.getTime() <= finalLive.now.getTime() || lease.controlDeadline.getTime() <= finalLive.now.getTime())
        return { ok: false, reason: 'control_deadline_passed' };
    return {
        ok: true,
        resolved: {
            scope: {
                authority: 'control', ownerUserId: lease.ownerUserId, originalOAuthClientId: lease.clientId, sessionId: lease.sessionId,
                computerId: lease.computerId, runtimeId: lease.runtimeId, hostEpoch: lease.hostEpoch, placement: { ...lease.placement },
                profile: RUNTIME_PROFILE_ID, policyDigest: lease.policyDigest, aiAuthorization: { ...ai },
                controlAuthorizationId: lease.controlAuthorizationId, controlDeadline: lease.controlDeadline.toISOString(),
            },
            action: request.kind, rootRequestId: request.requestId, requestDigest: request.requestDigest,
            deadline: request.requestDeadline.toISOString(),
        },
    };
}

/** Fresh observation authority. History identifies the namespace; inactive AI approval never prevents a read. */
export async function recheckNativeRuntimeRead(db: PlacementExecutor, port: NativeAiAuthorityPort | null,
    input: { scope: RuntimeRequestScope; action: 'read' | 'prompt_get' | 'request_get'; rootRequestId: string | null; deadline: string })
    : Promise<{ ok: true; resolved: { scope: RuntimeRequestScope; action: typeof input.action; rootRequestId: string | null;
        requestDigest: null; deadline: string } } | { ok: false; reason: RuntimeReason }> {
    let scope: RuntimeRequestScope;
    try { scope = canonicalScope(input.scope); } catch { return { ok: false, reason: 'authorization_unavailable' }; }
    if (scope.authority !== 'read' || !['read', 'prompt_get', 'request_get'].includes(input.action)
        || (input.action === 'request_get' ? !isUuid(input.rootRequestId) : input.rootRequestId !== null)
        || isoTimestamp(input.deadline) === null) return { ok: false, reason: 'authorization_unavailable' };
    const session = await resolveSessionBinding(db, port, scope.ownerUserId, scope.originalOAuthClientId, scope.sessionId);
    if (!session.ok) return { ok: false, reason: session.status === 'blocked' ? session.reason : 'session_not_found' };
    const binding = session.binding;
    if (binding.computerId !== scope.computerId || binding.aiAuthorization.authorizationId !== scope.aiAuthorization.authorizationId
        || binding.aiAuthorization.expiresAt !== scope.aiAuthorization.expiresAt
        || binding.aiAuthorization.policyDigest !== scope.aiAuthorization.policyDigest) return { ok: false, reason: 'session_binding_unavailable' };
    if (input.action === 'request_get' && input.rootRequestId !== binding.created.operationId) {
        const stored = await lookupRuntimeRequest(db, scope.ownerUserId, input.rootRequestId!);
        if (stored && (stored.request.sessionId !== scope.sessionId || stored.request.clientId !== scope.originalOAuthClientId))
            return { ok: false, reason: 'target_session_mismatch' };
        if (stored?.lease && (stored.lease.runtimeId !== scope.runtimeId || stored.lease.hostEpoch !== scope.hostEpoch
            || stored.lease.policyDigest !== scope.policyDigest || !samePlacement(stored.lease.placement, scope.placement)))
            return { ok: false, reason: 'placement_changed' };
    }
    const live = await readCurrentPlacement(db, scope.ownerUserId, scope.computerId);
    if (!live.ok) return { ok: false, reason: live.reason };
    if (!samePlacement(live.placement, scope.placement)) return { ok: false, reason: 'placement_changed' };
    const deadline = Date.parse(input.deadline);
    if (deadline <= live.now.getTime() || deadline > live.now.getTime() + RUNTIME_LIMITS.readTimeoutMs)
        return { ok: false, reason: 'control_deadline_passed' };
    return { ok: true, resolved: { scope: { ...scope, aiAuthorization: { ...binding.aiAuthorization } }, action: input.action,
        rootRequestId: input.rootRequestId, requestDigest: null, deadline: input.deadline } };
}
