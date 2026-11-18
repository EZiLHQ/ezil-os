/**
 * Native runtime control service: the six tools' OS semantics over the store, the authority resolver and the
 * private host channel (docs/NATIVE-RUNTIME-CONTROL-v1.md §5–§10). Transport-free: the REST receivers verify the
 * caller and hand over `{userId, clientId}` and the strictly parsed body.
 *
 * Order for a control request: replay/conflict on the stored row first (no resolver, transport or host call), then
 * the `0029` alias, then session/AI binding, current placement and a host read (an observation), then one short
 * admission transaction, then at most one dispatch. Reads never write and never dispatch.
 */
import { lookupNativeOperation, nativeComputerOwnedNow, type NativeAuthorityDb } from './authority';
import {
    readCurrentPlacement, resolveSessionBinding, type NativeAiAuthorityPort, type RuntimeSessionBinding,
} from './runtime-authority';
import {
    CONTROLLABLE_RUNTIME_STATES, CONTROL_TERMINAL_STATES, CURSOR, INITIAL_TASK_TERMINAL_STATES, RUNTIME_LIMITS, RUNTIME_PROFILE_ID,
    RUNTIME_RPC_VERSION, blockedRuntimeRead, fitsResponse, isoTimestamp, projectCoreReceipt, projectHostRuntimeBinding,
    projectInitialTaskObservation, projectNativePrompt, projectRuntimeRead, publicReason, runtimeAuthorizationUrl,
    runtimeRequestDigest, samePlacement, samePromptContext, type AuthorizationState, type ControlEffect, type ControlState,
    type NativeControlReceipt, type NativeInitialTaskReceipt, type NativePrompt, type NativeRuntimeRead, type PromptContext,
    type RuntimeControlBody, type RuntimePlacement, type RuntimeReadBody, type RuntimeReason, type RuntimeRequestScope,
    type RuntimeRpcPayload, type RuntimeRpcRequest,
} from './runtime-contract';
import { callRuntimeHost, type NativeRuntimeHostChannel, type RuntimeHostResult } from './runtime-host';
import {
    admitRuntimeRequest, adoptApprovedLease, advanceRuntimeRequest, claimRuntimeDispatch, consentDigestOf, decideRuntimeConsent,
    isNativeOperationId, lookupRuntimeRequest, sameRequestSemantics, tombstoneBeforeDispatch, type AdmissionDecision,
    type RuntimeLeaseScope, type StoredRuntimeRequest,
} from './runtime-store';

export interface RuntimeServiceDeps {
    db: NativeAuthorityDb;
    /** The `0031` adapter; null until the auth owner freezes its exports (every call then blocks). */
    aiPort: NativeAiAuthorityPort | null;
    host: NativeRuntimeHostChannel;
    /** The canonical https origin (`EZIL_NATIVE_SESSIONS_ORIGIN`). */
    origin: string;
    now: () => number;
    /** Hard per-call bound for one host RPC; defaults to the read timeout. */
    rpcTimeoutMs?: number;
}

export interface RuntimeCaller { userId: string; clientId: string }

export type ServiceResult<T> =
    | { status: 200; body: T }
    | { status: 404 }
    | { status: 409 }
    | { status: 503; reason: RuntimeReason };

// ── Projection ───────────────────────────────────────────────────────────

/** Overlay of a Core receipt observed by a read (never persisted by the read). */
interface Observed { state: ControlState; effect: ControlEffect; reason: string | null }

export function controlReceipt(stored: StoredRuntimeRequest, origin: string, now: number, observed: Observed | null = null): NativeControlReceipt {
    const { request: r, lease } = stored;
    let state: ControlState = r.state;
    let authorization: AuthorizationState;
    let expiresAt: Date;
    if (!lease) {
        authorization = 'blocked';
        expiresAt = r.createdAt;
    } else {
        expiresAt = lease.state === 'required' ? lease.consentExpiresAt : r.requestDeadline ?? lease.controlDeadline;
        authorization = lease.state === 'approved' ? 'approved' : lease.state === 'denied' ? 'denied'
            : lease.consentExpiresAt.getTime() > now ? 'required' : 'expired';
        if (r.state === 'authorization_required') {
            // Derived at read time; only the consent decision persists these moves.
            if (authorization === 'denied') state = 'authorization_denied';
            else if (authorization === 'expired') state = 'authorization_expired';
            else if (authorization === 'approved') state = (r.requestDeadline?.getTime() ?? 0) > now ? 'approved' : 'authorization_expired';
        } else if (r.state === 'authorization_denied') authorization = 'denied';
        else if (r.state === 'authorization_expired') authorization = 'expired';
    }
    let effect = r.effect;
    let reason = r.reason;
    if (observed) ({ state, effect, reason } = observed);
    const required = authorization === 'required' && state === 'authorization_required';
    return {
        statusKind: 'runtime_request', requestId: r.requestId, kind: r.kind, sessionId: r.sessionId, requestDigest: r.requestDigest,
        instructionDigest: r.instructionDigest, promptId: r.promptId, revision: r.promptRevision, decision: r.decision,
        targetRequestId: r.targetRequestId, runtimeId: lease?.runtimeId ?? null,
        authorization: {
            // A lease still pending consent that this request no longer waits on (tombstoned meanwhile) is not "required".
            state: required ? 'required' : authorization === 'required' ? 'blocked' : authorization,
            expiresAt: expiresAt.toISOString(), authorizationUrl: required ? runtimeAuthorizationUrl(origin, r.requestId) : null,
            reason: authorization === 'blocked' && r.reason ? publicReason(r.reason) : null,
        },
        state, effect, reason: reason === null ? null : publicReason(reason), settled: CONTROL_TERMINAL_STATES.has(state),
        createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
    };
}

// ── Host calls ───────────────────────────────────────────────────────────

function readScope(binding: RuntimeSessionBinding, placement: RuntimePlacement, runtime: { runtimeId: string; hostEpoch: string } | null,
    policyDigest: string | null): RuntimeRequestScope {
    return {
        authority: 'read', ownerUserId: binding.ownerUserId, originalOAuthClientId: binding.originalOAuthClientId,
        sessionId: binding.sessionId, computerId: binding.computerId, runtimeId: runtime?.runtimeId ?? null,
        hostEpoch: runtime?.hostEpoch ?? null, placement: { ...placement }, profile: RUNTIME_PROFILE_ID, policyDigest,
        aiAuthorization: { ...binding.aiAuthorization }, controlAuthorizationId: null, controlDeadline: null,
    };
}

function rpc(deps: RuntimeServiceDeps, scope: RuntimeRequestScope, payload: RuntimeRpcPayload, rootRequestId: string | null,
    requestDigest: string | null, deadlineMs: number): Promise<RuntimeHostResult> {
    const timeout = Math.max(0, Math.min(deps.rpcTimeoutMs ?? RUNTIME_LIMITS.readTimeoutMs, deadlineMs - deps.now()));
    const request: RuntimeRpcRequest = {
        v: RUNTIME_RPC_VERSION, action: payload.action, scope, rootRequestId, requestDigest,
        deadline: new Date(deps.now() + timeout).toISOString(), payload,
    };
    return callRuntimeHost(deps.host, request, timeout);
}

/** A host result that is not an `ok` value, as a public reason. */
function hostReason(result: RuntimeHostResult): RuntimeReason {
    switch (result.kind) {
        case 'unsupported': return 'core_unsupported';
        case 'refused': return 'host_refused';
        case 'unavailable': return result.reason;
        case 'unknown': return result.reason;
        default: return 'host_invalid_reply';
    }
}

const answerableNow = (binding: RuntimeSessionBinding, now: number) => (context: PromptContext) =>
    binding.aiAuthorization.state === 'active' && Date.parse(context.expiresAt) > now;

interface LiveRuntime { runtimeId: string; hostEpoch: string; policyDigest: string | null; state: string }

/** Observe the session's current runtime (read action). Null runtime = none exists yet. */
async function observeRuntime(deps: RuntimeServiceDeps, binding: RuntimeSessionBinding, placement: RuntimePlacement)
    : Promise<{ ok: true; runtime: LiveRuntime | null } | { ok: false; reason: RuntimeReason }> {
    const result = await rpc(deps, readScope(binding, placement, null, null), { action: 'read', cursor: null, limit: 1 }, null, null,
        deps.now() + RUNTIME_LIMITS.readTimeoutMs);
    if (result.kind !== 'ok') return { ok: false, reason: hostReason(result) };
    const read = projectRuntimeRead(binding.sessionId, null, 1, result.result, () => false);
    if (!read) return { ok: false, reason: 'host_invalid_reply' };
    if (!read.runtime) return { ok: true, runtime: null };
    const priv = projectHostRuntimeBinding(result.result);
    if (!priv || priv.runtimeId !== read.runtime.runtimeId) return { ok: false, reason: 'host_invalid_reply' };
    return { ok: true, runtime: { runtimeId: priv.runtimeId, hostEpoch: priv.hostEpoch, policyDigest: priv.policyDigest, state: read.runtime.state } };
}

async function fetchPrompt(deps: RuntimeServiceDeps, binding: RuntimeSessionBinding, placement: RuntimePlacement, promptId: string)
    : Promise<{ ok: true; prompt: NativePrompt | null } | { ok: false; reason: RuntimeReason }> {
    const result = await rpc(deps, readScope(binding, placement, null, null), { action: 'prompt_get', promptId }, null, null,
        deps.now() + RUNTIME_LIMITS.readTimeoutMs);
    if (result.kind !== 'ok') return { ok: false, reason: hostReason(result) };
    if (result.result === null) return { ok: true, prompt: null };
    const prompt = projectNativePrompt(binding.sessionId, promptId, result.result, answerableNow(binding, deps.now()));
    return prompt ? { ok: true, prompt } : { ok: false, reason: 'host_invalid_reply' };
}

// ── Reads ────────────────────────────────────────────────────────────────

export async function readNativeRuntime(deps: RuntimeServiceDeps, caller: RuntimeCaller, body: RuntimeReadBody): Promise<ServiceResult<NativeRuntimeRead>> {
    const session = await resolveSessionBinding(deps.db, deps.aiPort, caller.userId, caller.clientId, body.sessionId);
    if (!session.ok) return session.status === 'not_found' ? { status: 404 } : { status: 200, body: blockedRuntimeRead(body.sessionId, session.reason) };
    const live = await readCurrentPlacement(deps.db, caller.userId, session.binding.computerId);
    if (!live.ok) return live.reason === 'computer_not_found' ? { status: 404 } : { status: 200, body: blockedRuntimeRead(body.sessionId, live.reason) };
    const at = body.cursor ? CURSOR.exec(body.cursor) : null;
    const result = await rpc(deps, readScope(session.binding, live.placement, null, null),
        { action: 'read', cursor: at ? { runtimeId: at[1]!, seq: at[2]! } : null, limit: body.limit }, null, null,
        deps.now() + RUNTIME_LIMITS.readTimeoutMs);
    if (result.kind !== 'ok') return { status: 200, body: blockedRuntimeRead(body.sessionId, hostReason(result)) };
    const read = projectRuntimeRead(body.sessionId, body.cursor, body.limit, result.result, answerableNow(session.binding, deps.now()));
    if (!read) return { status: 200, body: blockedRuntimeRead(body.sessionId, 'host_invalid_reply') };
    if (read.runtime && !CONTROLLABLE_RUNTIME_STATES.has(read.runtime.state)) {
        read.pendingPrompts = read.pendingPrompts.map(p => ({ ...p, answerable: false }));
    }
    return { status: 200, body: read };
}

export async function getNativeRuntimePrompt(deps: RuntimeServiceDeps, caller: RuntimeCaller, sessionId: string, promptId: string)
    : Promise<ServiceResult<NativePrompt>> {
    const session = await resolveSessionBinding(deps.db, deps.aiPort, caller.userId, caller.clientId, sessionId);
    if (!session.ok) return session.status === 'not_found' ? { status: 404 } : { status: 503, reason: session.reason };
    const live = await readCurrentPlacement(deps.db, caller.userId, session.binding.computerId);
    if (!live.ok) return live.reason === 'computer_not_found' ? { status: 404 } : { status: 503, reason: live.reason };
    const fetched = await fetchPrompt(deps, session.binding, live.placement, promptId);
    if (!fetched.ok) return { status: 503, reason: fetched.reason };
    return fetched.prompt ? { status: 200, body: fetched.prompt } : { status: 404 };
}

/**
 * `get_native_operation`: the exact `0032` row first, else the session's initial task (`0029` create), else 404.
 * Both use the stored original namespace; the host is asked only while that stored placement is still live.
 */
export async function getNativeRuntimeOperation(deps: RuntimeServiceDeps, caller: RuntimeCaller, sessionId: string, requestId: string)
    : Promise<ServiceResult<NativeControlReceipt | NativeInitialTaskReceipt>> {
    const stored = await lookupRuntimeRequest(deps.db, caller.userId, requestId);
    if (stored) {
        const r = stored.request;
        if (r.sessionId !== sessionId || r.clientId !== caller.clientId) return { status: 404 };
        if (!(await nativeComputerOwnedNow(deps.db, caller.userId, r.computerId))) return { status: 404 };
        let observed: Observed | null = null;
        const lease = stored.lease;
        if (r.dispatchClaimedAt && lease?.runtimeId && lease.hostEpoch && deps.host.available) {
            const live = await readCurrentPlacement(deps.db, caller.userId, r.computerId);
            const session = live.ok && samePlacement(live.placement, lease.placement)
                ? await resolveSessionBinding(deps.db, deps.aiPort, caller.userId, caller.clientId, sessionId) : null;
            if (live.ok && session?.ok) {
                const scope = readScope(session.binding, lease.placement, { runtimeId: lease.runtimeId, hostEpoch: lease.hostEpoch }, lease.policyDigest);
                const result = await rpc(deps, scope, { action: 'request_get', requestId }, requestId, null, deps.now() + RUNTIME_LIMITS.readTimeoutMs);
                const receipt = result.kind === 'ok' && result.result !== null
                    ? projectCoreReceipt(requestId, r.kind, r.requestDigest, lease.runtimeId, result.result) : null;
                if (receipt) observed = { state: receipt.state, effect: receipt.effect, reason: receipt.reason };
            }
        }
        return { status: 200, body: controlReceipt(stored, deps.origin, deps.now(), observed) };
    }
    const created = await lookupNativeOperation(deps.db, caller.userId, requestId);
    if (!created || created.kind !== 'create' || created.sessionId !== sessionId) return { status: 404 };
    const session = await resolveSessionBinding(deps.db, deps.aiPort, caller.userId, caller.clientId, sessionId);
    if (!session.ok && session.status === 'not_found') return { status: 404 };
    if (!(await nativeComputerOwnedNow(deps.db, caller.userId, created.computerId))) return { status: 404 };
    const base: NativeInitialTaskReceipt = {
        statusKind: 'runtime_initial_request', kind: 'initial_task', requestId, sessionId, computerId: created.computerId,
        instructionDigest: created.instructionDigest, runtimeId: null, observation: 'unavailable', state: 'unknown', effect: 'unknown',
        reason: 'host_unavailable', settled: false, createdAt: created.createdAt.toISOString(), updatedAt: created.updatedAt.toISOString(),
    };
    if (!session.ok) return { status: 200, body: { ...base, reason: session.reason } };
    const live = await readCurrentPlacement(deps.db, caller.userId, created.computerId);
    if (!live.ok) return { status: 200, body: { ...base, reason: live.reason } };
    if (!samePlacement(live.placement, created.placement)) return { status: 200, body: { ...base, reason: 'placement_changed' } };
    const result = await rpc(deps, readScope(session.binding, created.placement, null, null), { action: 'request_get', requestId },
        requestId, null, deps.now() + RUNTIME_LIMITS.readTimeoutMs);
    if (result.kind !== 'ok') return { status: 200, body: { ...base, reason: hostReason(result) } };
    const seen = result.result === null ? null : projectInitialTaskObservation(requestId, result.result);
    if (!seen) return { status: 200, body: { ...base, reason: result.result === null ? 'core_unsupported' : 'host_invalid_reply' } };
    return {
        status: 200,
        body: {
            ...base, runtimeId: seen.runtimeId, observation: 'observed', state: seen.state, effect: seen.effect,
            reason: seen.reason === null ? null : publicReason(seen.reason), settled: INITIAL_TASK_TERMINAL_STATES.has(seen.state),
        },
    };
}

// ── Control ──────────────────────────────────────────────────────────────

async function decideAdmission(deps: RuntimeServiceDeps, binding: RuntimeSessionBinding, body: RuntimeControlBody)
    : Promise<AdmissionDecision> {
    const ai = binding.aiAuthorization;
    const blocked = (reason: RuntimeReason): AdmissionDecision => ({ kind: 'blocked', reason });
    if (body.kind !== 'cancel' && ai.state !== 'active') return blocked(ai.state === 'revoked' ? 'ai_authorization_revoked' : 'ai_authorization_inactive');
    const live = await readCurrentPlacement(deps.db, binding.ownerUserId, binding.computerId);
    if (!live.ok) return blocked(live.reason);
    const scopeOf = (runtime: LiveRuntime | null): RuntimeLeaseScope => ({
        ownerUserId: binding.ownerUserId, clientId: binding.originalOAuthClientId, sessionId: binding.sessionId,
        computerId: binding.computerId, runtimeId: runtime?.runtimeId ?? null, hostEpoch: runtime?.hostEpoch ?? null,
        placement: live.placement, policyDigest: runtime?.policyDigest ?? null, aiAuthorizationId: ai.authorizationId,
        actionSet: runtime ? 'runtime' : 'cancel_only',
    });
    const aiExpiresAt = body.kind === 'cancel' ? null : new Date(ai.expiresAt);
    const observed = deps.host.available ? await observeRuntime(deps, binding, live.placement) : { ok: false as const, reason: 'host_unavailable' as const };

    if (body.kind === 'cancel') {
        if (observed.ok && observed.runtime) return { kind: 'lease', scope: scopeOf(observed.runtime), leaseUntil: live.leaseUntil, aiExpiresAt, promptSnapshot: null };
        // No runtime to address: only a tombstone is possible, which needs an undispatched or unseen target.
        // The session's own initial task is a dispatched target: never OS-tombstoned, it needs a qualified Core cancel.
        const target = await lookupRuntimeRequest(deps.db, binding.ownerUserId, body.targetRequestId);
        const operation = await lookupNativeOperation(deps.db, binding.ownerUserId, body.targetRequestId);
        const initial = operation?.kind === 'create' && operation.sessionId === binding.sessionId;
        if (initial || target?.request.dispatchClaimedAt) return blocked(observed.ok ? 'runtime_unavailable' : observed.reason);
        return { kind: 'lease', scope: scopeOf(null), leaseUntil: live.leaseUntil, aiExpiresAt, promptSnapshot: null };
    }
    if (!observed.ok) return blocked(observed.reason);
    if (!observed.runtime || !CONTROLLABLE_RUNTIME_STATES.has(observed.runtime.state as never)) return blocked('runtime_unavailable');
    let promptSnapshot: Record<string, unknown> | null = null;
    if (body.kind === 'answer') {
        const fetched = await fetchPrompt(deps, binding, live.placement, body.promptId);
        if (!fetched.ok) return blocked(fetched.reason);
        const prompt = fetched.prompt;
        const refusal = promptRefusal(prompt, body, observed.runtime.runtimeId, deps.now());
        if (refusal) return blocked(refusal);
        promptSnapshot = { ...prompt! };
    }
    return { kind: 'lease', scope: scopeOf(observed.runtime), leaseUntil: live.leaseUntil, aiExpiresAt, promptSnapshot };
}

function promptRefusal(prompt: NativePrompt | null, body: Extract<RuntimeControlBody, { kind: 'answer' }>, runtimeId: string, now: number): RuntimeReason | null {
    if (!prompt) return 'prompt_not_found';
    if (prompt.runtimeId !== runtimeId) return 'runtime_changed';
    if (prompt.state !== 'open') return 'prompt_not_open';
    if (prompt.promptKind !== 'permission') return 'prompt_unsupported';
    if (Date.parse(prompt.context.expiresAt) <= now) return 'prompt_expired';
    if (prompt.revision !== body.revision) return 'prompt_revision_changed';
    if (prompt.promptInputDigest !== body.promptInputDigest) return 'prompt_input_mismatch';
    if (body.decision === 'allow' && (prompt.inputStatus !== 'complete' || !prompt.answerable)) {
        return prompt.inputStatus === 'complete' ? 'prompt_unsupported' : 'prompt_input_incomplete';
    }
    return null;
}

function snapshotContext(snapshot: Record<string, unknown> | null): PromptContext | null {
    const c = snapshot?.context as Record<string, unknown> | undefined;
    if (!c || typeof c.instructionRequestId !== 'string' || typeof c.instructionRevision !== 'number' || isoTimestamp(c.expiresAt) === null) return null;
    return { instructionRequestId: c.instructionRequestId, instructionRevision: c.instructionRevision, expiresAt: c.expiresAt as string };
}

/**
 * Dispatch one approved request at most once. Every current fact is re-read first (no lock across the network);
 * a definite refusal before the claim is recorded as `blocked`, an unavailable host leaves the row `approved`.
 */
async function dispatch(deps: RuntimeServiceDeps, stored: StoredRuntimeRequest): Promise<StoredRuntimeRequest> {
    const { request: r, lease } = stored;
    const owner = r.ownerUserId;
    const reread = async () => (await lookupRuntimeRequest(deps.db, owner, r.requestId)) ?? stored;
    if (r.state !== 'approved' || r.dispatchClaimedAt || !lease || lease.state !== 'approved') return stored;
    const block = async (reason: RuntimeReason) => (await advanceRuntimeRequest(deps.db, owner, r.requestId, 'approved', 'blocked', 'none', reason)) ?? reread();

    // Current authority first, for every kind (the tombstone transaction re-validates owner, placement and deadlines).
    const live = await readCurrentPlacement(deps.db, owner, r.computerId);
    if (!live.ok) return block(live.reason);
    if (!samePlacement(live.placement, lease.placement)) return block('placement_changed');
    const session = await resolveSessionBinding(deps.db, deps.aiPort, owner, r.clientId, r.sessionId);
    if (!session.ok) return session.status === 'not_found' ? block('session_not_found') : block(session.reason);
    const ai = session.binding.aiAuthorization;
    if (ai.authorizationId !== lease.aiAuthorizationId) return block('ai_authorization_inactive');
    if (r.kind !== 'cancel' && ai.state !== 'active') return block(ai.state === 'revoked' ? 'ai_authorization_revoked' : 'ai_authorization_inactive');
    if (r.kind === 'cancel') {
        const tomb = await tombstoneBeforeDispatch(deps.db, r);
        if (tomb.kind === 'tombstoned' || tomb.kind === 'refused') return tomb.stored;
        if (tomb.kind === 'stale') return reread();
        if (!lease.runtimeId) return block('runtime_unavailable');
    }
    if (!deps.host.available) return stored;
    if (r.kind === 'answer') {
        const fetched = await fetchPrompt(deps, session.binding, live.placement, r.promptId!);
        if (!fetched.ok) return stored;
        const prompt = fetched.prompt;
        const stale = promptRefusal(prompt, {
            kind: 'answer', requestId: r.requestId, sessionId: r.sessionId, promptId: r.promptId!, revision: r.promptRevision!,
            promptInputDigest: r.promptInputDigest!, decision: r.decision!, message: r.message,
        }, lease.runtimeId!, deps.now());
        if (stale) return block(stale);
        const before = snapshotContext(r.promptSnapshot);
        if (!before || !samePromptContext(before, prompt!.context)) return block('prompt_context_changed');
    }
    const claimed = await claimRuntimeDispatch(deps.db, owner, r.requestId);
    if (!claimed) return reread();

    const scope: RuntimeRequestScope = {
        authority: 'control', ownerUserId: owner, originalOAuthClientId: lease.clientId, sessionId: r.sessionId, computerId: r.computerId,
        runtimeId: lease.runtimeId, hostEpoch: lease.hostEpoch, placement: { ...lease.placement }, profile: RUNTIME_PROFILE_ID,
        policyDigest: lease.policyDigest, aiAuthorization: { ...ai }, controlAuthorizationId: lease.controlAuthorizationId,
        controlDeadline: lease.controlDeadline.toISOString(),
    };
    const payload: RuntimeRpcPayload = r.kind === 'send'
        ? { action: 'send', instructionRevision: 1, instructionDigest: r.instructionDigest!, instruction: r.instruction! }
        : r.kind === 'answer'
            ? { action: 'answer', promptId: r.promptId!, revision: r.promptRevision!, promptInputDigest: r.promptInputDigest!, decision: r.decision!, message: r.message }
            : { action: 'cancel', targetRequestId: r.targetRequestId! };
    const result = await rpc(deps, scope, payload, r.requestId, r.requestDigest, r.requestDeadline!.getTime());
    const settle = (to: ControlState, effect: ControlEffect, reason: string | null) =>
        advanceRuntimeRequest(deps.db, owner, r.requestId, 'dispatching', to, effect, reason).then(next => next ?? reread());
    switch (result.kind) {
        case 'ok': {
            const receipt = projectCoreReceipt(r.requestId, r.kind, r.requestDigest, lease.runtimeId!, result.result);
            if (!receipt) return settle('dispatch_unknown', 'unknown', 'host_invalid_reply');
            if (receipt.state === 'blocked') return settle('blocked', receipt.effect === 'unknown' ? 'unknown' : 'none', publicReason(receipt.reason));
            return settle(receipt.state, receipt.effect, receipt.reason === null ? null : publicReason(receipt.reason));
        }
        case 'refused': return settle('host_refused', 'none', 'host_refused');
        case 'unsupported': return settle('blocked', 'none', 'core_unsupported');
        case 'unavailable': return settle('host_refused', 'none', result.reason);
        case 'unknown': return settle('dispatch_unknown', 'unknown', result.reason);
    }
}

/**
 * One control request. A stored request answers from its own row before anything current is consulted; only an
 * approved request whose outbox was never claimed is dispatched (once).
 */
export async function controlNativeRuntime(deps: RuntimeServiceDeps, caller: RuntimeCaller, body: RuntimeControlBody)
    : Promise<ServiceResult<NativeControlReceipt>> {
    const requestDigest = runtimeRequestDigest(body);
    const receipt = (stored: StoredRuntimeRequest): ServiceResult<NativeControlReceipt> => {
        const dto = controlReceipt(stored, deps.origin, deps.now());
        return fitsResponse(dto) ? { status: 200, body: dto } : { status: 503, reason: 'authorization_unavailable' };
    };

    let stored = await lookupRuntimeRequest(deps.db, caller.userId, body.requestId);
    if (stored) {
        if (!sameRequestSemantics(stored.request, caller.clientId, body, requestDigest)) return { status: 409 };
        if (!(await nativeComputerOwnedNow(deps.db, caller.userId, stored.request.computerId))) return { status: 404 };
        if (stored.request.state === 'authorization_required' && stored.lease?.state === 'approved') {
            stored = (await adoptApprovedLease(deps.db, caller.userId, body.requestId)) ?? stored;
        }
        return receipt(stored.request.state === 'approved' ? await dispatch(deps, stored) : stored);
    }
    if (await isNativeOperationId(deps.db, caller.userId, body.requestId)) return { status: 409 };

    const session = await resolveSessionBinding(deps.db, deps.aiPort, caller.userId, caller.clientId, body.sessionId);
    if (!session.ok) return session.status === 'not_found' ? { status: 404 } : { status: 503, reason: session.reason };
    const decision = await decideAdmission(deps, session.binding, body);
    const admitted = await admitRuntimeRequest(deps.db, {
        ownerUserId: caller.userId, clientId: caller.clientId, computerId: session.binding.computerId, body, requestDigest, decision,
    });
    if (admitted.kind === 'conflict') return { status: 409 };
    stored = admitted.stored;
    return receipt(stored.request.state === 'approved' ? await dispatch(deps, stored) : stored);
}

// ── Consent (normal cookie) ──────────────────────────────────────────────

/** What the owner's browser is shown before approving: the lease and exactly one pending action, in full. */
export interface RuntimeConsentView {
    requestId: string;
    kind: 'send' | 'answer' | 'cancel';
    sessionId: string;
    computerId: string;
    runtimeId: string | null;
    requestDigest: string;
    instruction: string | null;
    prompt: Record<string, unknown> | null;
    decision: 'allow' | 'deny' | null;
    message: string | null;
    targetRequestId: string | null;
    lease: { state: AuthorizationState; actions: readonly ('send' | 'answer' | 'cancel')[]; consentExpiresAt: string; controlDeadline: string };
    state: ControlState;
    leaseDigest: string;
    approvable: boolean;
}

function consentView(stored: StoredRuntimeRequest, now: number): RuntimeConsentView | null {
    const { request: r, lease } = stored;
    if (!lease) return null;
    const receipt = controlReceipt(stored, 'https://invalid.example', now);
    const snapshot = r.promptSnapshot;
    const context = snapshotContext(snapshot);
    const answerOk = r.kind !== 'answer' || (snapshot !== null && context !== null && Date.parse(context.expiresAt) > now
        && (r.decision === 'deny' || (snapshot.inputStatus === 'complete' && snapshot.answerable === true)));
    return {
        requestId: r.requestId, kind: r.kind, sessionId: r.sessionId, computerId: r.computerId, runtimeId: lease.runtimeId,
        requestDigest: r.requestDigest, instruction: r.instruction, prompt: snapshot, decision: r.decision, message: r.message,
        targetRequestId: r.targetRequestId,
        lease: {
            state: receipt.authorization.state, actions: lease.actionSet === 'runtime' ? ['send', 'answer', 'cancel'] : ['cancel'],
            consentExpiresAt: lease.consentExpiresAt.toISOString(), controlDeadline: lease.controlDeadline.toISOString(),
        },
        state: receipt.state, leaseDigest: consentDigestOf(lease, r),
        approvable: receipt.state === 'authorization_required' && receipt.authorization.state === 'required' && answerOk,
    };
}

/** Owner-only consent display. Read only: no write, no host call. */
export async function readRuntimeConsent(deps: RuntimeServiceDeps, userId: string, requestId: string): Promise<RuntimeConsentView | null> {
    const stored = await lookupRuntimeRequest(deps.db, userId, requestId);
    if (!stored || !(await nativeComputerOwnedNow(deps.db, userId, stored.request.computerId))) return null;
    return consentView(stored, deps.now());
}

/**
 * The owner's decision. Approve is refused (unchanged) for anything not approvable as displayed, e.g. an `allow`
 * whose stored prompt input is incomplete or whose context expired. An approval then dispatches that one request.
 */
export async function decideRuntimeConsentRequest(deps: RuntimeServiceDeps, userId: string, requestId: string,
    decision: 'approve' | 'deny', digest: string): Promise<{ status: 200; body: RuntimeConsentView } | { status: 404 } | { status: 409 }> {
    const before = await lookupRuntimeRequest(deps.db, userId, requestId);
    if (!before || !(await nativeComputerOwnedNow(deps.db, userId, before.request.computerId))) return { status: 404 };
    const view = consentView(before, deps.now());
    if (!view) return { status: 404 };
    if (view.leaseDigest !== digest) return { status: 409 };
    if (decision === 'approve' && !view.approvable) return { status: 200, body: view };
    const result = await decideRuntimeConsent(deps.db, userId, requestId, decision, digest);
    if (result.kind === 'not_found') return { status: 404 };
    if (result.kind === 'digest_mismatch') return { status: 409 };
    let stored = result.stored;
    if (result.kind === 'decided' && stored.request.state === 'approved') stored = await dispatch(deps, stored);
    return { status: 200, body: consentView(stored, deps.now()) ?? view };
}
