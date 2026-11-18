/**
 * Native runtime control v1: the shared, closed contract (`docs/NATIVE-RUNTIME-CONTROL-v1.md`, r2).
 *
 * Pure: no database, environment, network or clock. Everything another lane must agree on byte for byte lives
 * here: the six tools' scopes, routes and procedures, the exact POST bodies and their strict parser, the
 * `EZIL-NATIVE-REST/1` transcript, the request digest, the public DTOs, the private host RPC envelope and the
 * strict projections of host replies. A value that does not fit is refused, never coerced. The Core prompt
 * digest is carried exactly as produced and never recomputed here.
 */
import { createHash } from 'node:crypto';

// ── Identity, gates, scopes ──────────────────────────────────────────────

export const RUNTIME_READ_SCOPE = 'ezil:native-runtime:read';
export const RUNTIME_CONTROL_SCOPE = 'ezil:native-runtime:control';
export const RUNTIME_PROFILE_ID = 'ezil-native-claude-v1';
export const RUNTIME_RPC_VERSION = 'ezil-native-runtime-rpc/1';
export const RUNTIME_DIGEST_DOMAIN = 'ezil.native-runtime.request.v1';
export const RUNTIME_LEASE_DOMAIN = 'ezil.native-runtime.lease.v1';
export const NATIVE_REST_TRANSCRIPT_PREFIX = 'EZIL-NATIVE-REST/1';

/** `EZIL_NATIVE_RUNTIME_CONTROL=1` exactly, and only together with the existing `EZIL_NATIVE_SESSIONS=1`. */
export function nativeRuntimeControlEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
    return env.EZIL_NATIVE_SESSIONS === '1' && env.EZIL_NATIVE_RUNTIME_CONTROL === '1';
}

// ── Bounds ───────────────────────────────────────────────────────────────

export const RUNTIME_LIMITS = Object.freeze({
    instructionBytes: 16_384,
    publicBodyBytes: 65_536,
    messageBytes: 2_048,
    promptInputBytes: 65_536,
    eventTextBytes: 65_536,
    /** OS DTO bound: leaves 4096 bytes so the complete MCP result envelope stays within `mcpResultBytes`. */
    responseBytes: 126_976,
    mcpResultBytes: 131_072,
    mcpSummaryBytes: 512,
    nativeHopBytes: 131_072,
    eventsLimitMax: 100,
    eventsLimitDefault: 50,
    pendingPromptsMax: 32,
    rootRequestIdsMax: 16,
    consentWindowMs: 10 * 60_000,
    controlWindowMs: 15 * 60_000,
    consentBodyBytes: 512,
    readTimeoutMs: 10_000,
    revisionMax: 2_147_483_647,
});

// ── Patterns ─────────────────────────────────────────────────────────────

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `sha256:` + lowercase hex: instruction, request, message and lease digests. */
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** Bare lowercase hex: the Core producer's prompt input and policy fingerprints. */
export const PRODUCER_DIGEST = /^[0-9a-f]{64}$/;
export const COUNTER = /^(0|[1-9][0-9]{0,18})$/;
export const CURSOR = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(0|[1-9][0-9]{0,18})$/;
const NATIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const INSTANCE = /^i-[0-9a-f]{8,17}$/;
const HOST_EPOCH = /^[A-Za-z0-9_-]{1,128}$/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
export const utf8Bytes = (value: string): number => Buffer.byteLength(value, 'utf8');
export const sha256Hex = (value: string): string => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

/** Exactly what `Date.prototype.toISOString` produces, else null. */
export function isoTimestamp(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value ? value : null;
}

// ── Tools, routes, procedures ────────────────────────────────────────────

export const RUNTIME_TOOLS = [
    'read_native_session', 'get_native_prompt', 'get_native_operation',
    'send_native_instruction', 'answer_native_prompt', 'cancel_native_operation',
] as const;
export type RuntimeTool = (typeof RUNTIME_TOOLS)[number];

export type RuntimeRoute = 'read' | 'promptGet' | 'requestGet' | 'send' | 'answer' | 'cancel';
export type RuntimeAuthority = 'read' | 'control';

export const RUNTIME_ROUTES: Readonly<Record<RuntimeRoute, {
    method: 'GET' | 'POST'; procedure: string; scope: string; tool: RuntimeTool; authority: RuntimeAuthority;
}>> = {
    read: { method: 'POST', procedure: 'nativeRuntime.read', scope: RUNTIME_READ_SCOPE, tool: 'read_native_session', authority: 'read' },
    promptGet: { method: 'GET', procedure: 'nativeRuntime.promptGet', scope: RUNTIME_READ_SCOPE, tool: 'get_native_prompt', authority: 'read' },
    requestGet: { method: 'GET', procedure: 'nativeRuntime.requestGet', scope: RUNTIME_READ_SCOPE, tool: 'get_native_operation', authority: 'read' },
    send: { method: 'POST', procedure: 'nativeRuntime.send', scope: RUNTIME_CONTROL_SCOPE, tool: 'send_native_instruction', authority: 'control' },
    answer: { method: 'POST', procedure: 'nativeRuntime.answer', scope: RUNTIME_CONTROL_SCOPE, tool: 'answer_native_prompt', authority: 'control' },
    cancel: { method: 'POST', procedure: 'nativeRuntime.cancel', scope: RUNTIME_CONTROL_SCOPE, tool: 'cancel_native_operation', authority: 'control' },
};

/** The receivers' fixed delegation policy (procedure → exact scope). A source constant, never request data. */
export const RUNTIME_SCOPE_BY_PROCEDURE: ReadonlyMap<string, string> = new Map(
    Object.values(RUNTIME_ROUTES).map(route => [route.procedure, route.scope]));

export function runtimePathname(route: RuntimeRoute, sessionId: string, selector?: string): string {
    if (!isUuid(sessionId)) throw new TypeError('invalid session id');
    const base = `/api/mcp/native-sessions/${sessionId}/runtime`;
    if (route === 'promptGet' || route === 'requestGet') {
        if (!isUuid(selector)) throw new TypeError('invalid selector');
        return `${base}/${route === 'promptGet' ? 'prompts' : 'requests'}/${selector}`;
    }
    if (selector !== undefined) throw new TypeError('unexpected selector');
    return `${base}/${route}`;
}

/** `EZIL-NATIVE-REST/1` LF METHOD LF PATHNAME LF BODY: the delegation `serializedInput` of every native REST call. */
export function nativeRestTranscript(method: 'GET' | 'POST', pathname: string, body: string): string {
    if (method === 'GET' && body !== '') throw new TypeError('GET has an empty body');
    return `${NATIVE_REST_TRANSCRIPT_PREFIX}\n${method}\n${pathname}\n${body}`;
}

// ── Strings ──────────────────────────────────────────────────────────────

/** The v1 instruction rules: well-formed, not `\s`-only, no NUL, at most 16 KiB UTF-8. Kept byte-exact. */
export function validInstruction(value: unknown): value is string {
    return typeof value === 'string' && !LONE_SURROGATE.test(value) && !/^\s*$/u.test(value) && !value.includes('\u0000')
        && utf8Bytes(value) <= RUNTIME_LIMITS.instructionBytes;
}

export function validMessage(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && !LONE_SURROGATE.test(value) && !value.includes('\u0000')
        && utf8Bytes(value) <= RUNTIME_LIMITS.messageBytes;
}

export const validRevision = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= RUNTIME_LIMITS.revisionMax;

// ── Bodies ───────────────────────────────────────────────────────────────

export interface RuntimeReadBody { kind: 'read'; sessionId: string; cursor: string | null; limit: number }
export interface RuntimeSendBody {
    kind: 'send'; requestId: string; sessionId: string; instructionRevision: 1; instructionDigest: string; instruction: string;
}
export interface RuntimeAnswerBody {
    kind: 'answer'; requestId: string; sessionId: string; promptId: string; revision: number; promptInputDigest: string;
    decision: 'allow' | 'deny'; message: string | null;
}
export interface RuntimeCancelBody { kind: 'cancel'; requestId: string; sessionId: string; targetRequestId: string }
export type RuntimeControlBody = RuntimeSendBody | RuntimeAnswerBody | RuntimeCancelBody;
export type RuntimeBody = RuntimeReadBody | RuntimeControlBody;

export const RUNTIME_BODY_KEYS: Readonly<Record<RuntimeBody['kind'], readonly string[]>> = {
    read: ['kind', 'sessionId', 'cursor', 'limit'],
    send: ['kind', 'requestId', 'sessionId', 'instructionRevision', 'instructionDigest', 'instruction'],
    answer: ['kind', 'requestId', 'sessionId', 'promptId', 'revision', 'promptInputDigest', 'decision', 'message'],
    cancel: ['kind', 'requestId', 'sessionId', 'targetRequestId'],
};

export function plainObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** Exactly these own keys, in exactly this order. */
export function orderedKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key, i) => own[i] === key);
}

/**
 * Parse the exact raw body of one POST route. Canonical only: the bytes must be precisely what one
 * `JSON.stringify` of the closed object produces, so duplicate keys, other orders, whitespace and escapes are
 * refused and every digest is over the bytes the caller signed.
 */
export function parseRuntimeBody<K extends RuntimeBody['kind']>(kind: K, raw: string, pathSessionId: string): Extract<RuntimeBody, { kind: K }> | null {
    if (utf8Bytes(raw) > RUNTIME_LIMITS.publicBodyBytes) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!plainObject(value) || !orderedKeys(value, RUNTIME_BODY_KEYS[kind]) || JSON.stringify(value) !== raw) return null;
    if (value.kind !== kind || value.sessionId !== pathSessionId || !isUuid(value.sessionId)) return null;
    const ok = (): Extract<RuntimeBody, { kind: K }> => value as unknown as Extract<RuntimeBody, { kind: K }>;
    switch (kind) {
        case 'read': {
            const cursor = value.cursor;
            if (cursor !== null && (typeof cursor !== 'string' || !CURSOR.test(cursor))) return null;
            if (!Number.isSafeInteger(value.limit) || (value.limit as number) < 1 || (value.limit as number) > RUNTIME_LIMITS.eventsLimitMax) return null;
            return ok();
        }
        case 'send':
            if (!isUuid(value.requestId) || value.instructionRevision !== 1 || !validInstruction(value.instruction)
                || value.instructionDigest !== sha256Hex(value.instruction)) return null;
            return ok();
        case 'answer':
            if (!isUuid(value.requestId) || !isUuid(value.promptId) || !validRevision(value.revision)
                || typeof value.promptInputDigest !== 'string' || !PRODUCER_DIGEST.test(value.promptInputDigest)) return null;
            if (value.decision === 'allow' ? value.message !== null
                : value.decision !== 'deny' || (value.message !== null && !validMessage(value.message))) return null;
            return ok();
        case 'cancel':
            if (!isUuid(value.requestId) || !isUuid(value.targetRequestId) || value.targetRequestId === value.requestId) return null;
            return ok();
    }
    return null;
}

/** The OS canonical request digest of one control request (§6). Kind and session are inside; the key is not. */
export function runtimeRequestDigest(body: RuntimeControlBody): string {
    const fields = body.kind === 'send'
        ? ['send', body.sessionId, '1', body.instructionDigest]
        : body.kind === 'answer'
            ? ['answer', body.sessionId, body.promptId, String(body.revision), body.promptInputDigest, body.decision,
                body.message === null ? '' : sha256Hex(body.message)]
            : ['cancel', body.sessionId, body.targetRequestId];
    return sha256Hex(JSON.stringify([RUNTIME_DIGEST_DOMAIN, ...fields]));
}

// ── Reasons and states ───────────────────────────────────────────────────

export const RUNTIME_STATES = ['starting', 'ready', 'busy', 'needs_input', 'stopping', 'stopped', 'exited', 'failed', 'unknown'] as const;
export type RuntimeState = (typeof RUNTIME_STATES)[number];
/** Runtime states that can take a send or an answer. */
export const CONTROLLABLE_RUNTIME_STATES: ReadonlySet<RuntimeState> = new Set<RuntimeState>(['ready', 'busy', 'needs_input']);

export const RUNTIME_EVENT_TYPES = [
    'runtime.state', 'turn.started', 'assistant.text', 'tool.started', 'tool.result', 'prompt.opened', 'prompt.closed',
    'prompt.unsupported', 'request.recorded', 'request.settled', 'turn.completed',
] as const;
export type RuntimeEventType = (typeof RUNTIME_EVENT_TYPES)[number];
export const EVENT_OUTCOMES = ['success', 'error', 'interrupted', 'refused'] as const;
export const EVENT_PAYLOAD_STATUSES = ['complete', 'oversize', 'unsupported'] as const;

export const RUNTIME_REASONS = [
    'session_not_found', 'session_not_active', 'session_binding_unavailable', 'client_mismatch',
    'ai_authorization_inactive', 'ai_authorization_revoked', 'computer_not_found', 'computer_not_aws',
    'computer_not_running', 'placement_unavailable', 'placement_changed', 'lease_expired', 'computer_busy',
    'placement_invalid', 'runtime_unavailable', 'runtime_changed', 'host_unavailable', 'host_refused', 'host_timeout',
    'host_no_ack', 'host_invalid_reply',
    'core_unsupported', 'control_deadline_passed', 'control_action_not_allowed', 'prompt_not_found', 'prompt_not_open',
    'prompt_revision_changed', 'prompt_context_changed', 'prompt_expired', 'prompt_input_mismatch',
    'prompt_input_incomplete', 'prompt_unsupported', 'target_session_mismatch', 'target_settled', 'request_limit',
    'authorization_unavailable',
] as const;
export type RuntimeReason = (typeof RUNTIME_REASONS)[number];
export const isRuntimeReason = (value: unknown): value is RuntimeReason =>
    typeof value === 'string' && (RUNTIME_REASONS as readonly string[]).includes(value);
/** Any reason outside the closed set becomes the fixed fallback; raw strings never reach a caller. */
export const publicReason = (value: unknown): RuntimeReason => isRuntimeReason(value) ? value : 'authorization_unavailable';

export type ControlKind = 'send' | 'answer' | 'cancel';
export const CONTROL_KINDS: readonly ControlKind[] = ['send', 'answer', 'cancel'];
export const AUTHORIZATION_STATES = ['required', 'approved', 'denied', 'expired', 'blocked'] as const;
export type AuthorizationState = (typeof AUTHORIZATION_STATES)[number];

export const CONTROL_STATES = [
    'authorization_required', 'authorization_denied', 'authorization_expired', 'blocked', 'approved', 'dispatching',
    'host_refused', 'dispatch_unknown', 'recorded', 'delivering', 'accepted', 'cancelling', 'completed', 'failed',
    'cancelled', 'unknown', 'cancelled_before_dispatch',
] as const;
export type ControlState = (typeof CONTROL_STATES)[number];

/** Settled for good. `dispatch_unknown` and `unknown` are held instead: neither settled nor completion. */
export const CONTROL_TERMINAL_STATES: ReadonlySet<ControlState> = new Set<ControlState>([
    'authorization_denied', 'authorization_expired', 'blocked', 'host_refused', 'completed', 'failed', 'cancelled',
    'cancelled_before_dispatch',
]);
export const CONTROL_HELD_STATES: ReadonlySet<ControlState> = new Set<ControlState>(['dispatch_unknown', 'unknown']);

/** States a Core receipt may report; the OS never infers them. */
export const CORE_RECEIPT_STATES = ['recorded', 'delivering', 'accepted', 'cancelling', 'completed', 'failed', 'blocked', 'cancelled', 'unknown'] as const;
export type CoreReceiptState = (typeof CORE_RECEIPT_STATES)[number];

export const CONTROL_EFFECTS = ['none', 'tombstone_before_dispatch', 'recorded', 'written_unacknowledged', 'native_observed', 'unknown'] as const;
export type ControlEffect = (typeof CONTROL_EFFECTS)[number];

// ── Public DTOs ──────────────────────────────────────────────────────────

export interface RuntimeView {
    runtimeId: string; state: RuntimeState; startedAt: string | null; lastProgressAt: string | null; activeRequestId: string | null;
}

export interface RuntimeEvent {
    seq: string; at: string; type: RuntimeEventType; requestId: string | null; promptId: string | null;
    toolUseId: string | null; toolName: string | null; outcome: (typeof EVENT_OUTCOMES)[number] | null;
    runtimeState: RuntimeState | null; payloadStatus: (typeof EVENT_PAYLOAD_STATUSES)[number]; text: string | null;
}

/** Producer lineage fences, passed through exactly; never synthesized by OS or MCP. */
export interface PromptContext {
    instructionRequestId: string;
    instructionRevision: number;
    expiresAt: string;
}

export interface PromptSummary {
    promptId: string; revision: number; toolName: string; toolUseId: string; promptInputDigest: string; inputBytes: number;
    openedAt: string; context: PromptContext; answerable: boolean;
}

export const samePromptContext = (a: PromptContext, b: PromptContext): boolean =>
    a.instructionRequestId === b.instructionRequestId && a.instructionRevision === b.instructionRevision && a.expiresAt === b.expiresAt;

export interface NativeRuntimeRead {
    statusKind: 'runtime_read';
    sessionId: string;
    availability: 'available' | 'blocked';
    reason: RuntimeReason | null;
    runtime: RuntimeView | null;
    events: RuntimeEvent[];
    nextCursor: string | null;
    hasMore: boolean;
    cursorReset: boolean;
    pendingPrompts: PromptSummary[];
    pendingPromptsComplete: boolean;
}

export const PROMPT_KINDS = ['permission', 'question', 'plan', 'other'] as const;
export const PROMPT_STATES = ['open', 'decided', 'closed', 'expired'] as const;
export const PROMPT_INPUT_STATUSES = ['complete', 'oversize', 'redacted', 'unavailable'] as const;

export interface NativePrompt {
    statusKind: 'runtime_prompt';
    sessionId: string; runtimeId: string; promptId: string; revision: number; nativeRequestId: string;
    toolUseId: string; toolName: string;
    promptKind: (typeof PROMPT_KINDS)[number];
    state: (typeof PROMPT_STATES)[number];
    inputStatus: (typeof PROMPT_INPUT_STATUSES)[number];
    input: Record<string, unknown> | null;
    promptInputDigest: string;
    inputBytes: number;
    context: PromptContext;
    answerable: boolean;
    rootRequestIds: string[];
}

export interface NativeControlReceipt {
    statusKind: 'runtime_request';
    requestId: string; kind: ControlKind; sessionId: string; requestDigest: string;
    instructionDigest: string | null;
    promptId: string | null; revision: number | null; decision: 'allow' | 'deny' | null;
    targetRequestId: string | null;
    runtimeId: string | null;
    authorization: { state: AuthorizationState; expiresAt: string; authorizationUrl: string | null; reason: RuntimeReason | null };
    state: ControlState;
    effect: ControlEffect;
    reason: RuntimeReason | null;
    settled: boolean;
    createdAt: string;
    updatedAt: string;
}

export const INITIAL_TASK_STATES = ['starting', 'recorded', 'delivering', 'accepted', 'completed', 'failed', 'blocked', 'cancelling', 'cancelled', 'unknown'] as const;
export type InitialTaskState = (typeof INITIAL_TASK_STATES)[number];
export const INITIAL_TASK_TERMINAL_STATES: ReadonlySet<InitialTaskState> = new Set<InitialTaskState>(['completed', 'failed', 'blocked', 'cancelled']);
export const INITIAL_TASK_EFFECTS = ['none', 'recorded', 'written_unacknowledged', 'native_observed', 'unknown'] as const;

/** The session's initial task (its `0029` create), observed only. Never a control receipt; no authorization of any kind. */
export interface NativeInitialTaskReceipt {
    statusKind: 'runtime_initial_request';
    kind: 'initial_task';
    requestId: string;
    sessionId: string;
    computerId: string;
    instructionDigest: string;
    runtimeId: string | null;
    observation: 'observed' | 'unavailable';
    state: InitialTaskState;
    effect: (typeof INITIAL_TASK_EFFECTS)[number];
    reason: RuntimeReason | null;
    settled: boolean;
    createdAt: string;
    updatedAt: string;
}

export type NativeOperationResult = NativeControlReceipt | NativeInitialTaskReceipt;

export function runtimeAuthorizationUrl(origin: string, requestId: string): string {
    if (!isUuid(requestId)) throw new TypeError('invalid request id');
    return `${origin}/native/runtime-authorize/${requestId}`;
}

/** The whole serialized response must fit the public bound, wrapper included. */
export const fitsResponse = (dto: unknown): boolean => utf8Bytes(JSON.stringify(dto)) <= RUNTIME_LIMITS.responseBytes;

// ── Private host RPC ─────────────────────────────────────────────────────

export interface RuntimePlacement { generation: string; leaseEpoch: string; instanceId: string; fenceToken: string }

export const AI_AUTHORIZATION_STATES = ['active', 'inactive', 'revoked'] as const;
export type AiAuthorizationState = (typeof AI_AUTHORIZATION_STATES)[number];

/** The `0031` native AI binding of one session. Distinct from any control lease; never substituted. */
export interface AiAuthorizationBinding {
    authorizationId: string;
    state: AiAuthorizationState;
    expiresAt: string;
    policyDigest: string | null;
}

/** Server-derived, never caller-supplied. */
export interface RuntimeRequestScope {
    authority: RuntimeAuthority;
    ownerUserId: string;
    originalOAuthClientId: string;
    sessionId: string;
    computerId: string;
    runtimeId: string | null;
    hostEpoch: string | null;
    placement: RuntimePlacement;
    profile: typeof RUNTIME_PROFILE_ID;
    policyDigest: string | null;
    aiAuthorization: AiAuthorizationBinding;
    controlAuthorizationId: string | null;
    controlDeadline: string | null;
}

export type RuntimeRpcAction = 'read' | 'prompt_get' | 'request_get' | 'send' | 'answer' | 'cancel';
export const READ_RPC_ACTIONS: ReadonlySet<RuntimeRpcAction> = new Set(['read', 'prompt_get', 'request_get']);

export type RuntimeRpcPayload =
    | { action: 'read'; cursor: { runtimeId: string; seq: string } | null; limit: number }
    | { action: 'prompt_get'; promptId: string }
    | { action: 'request_get'; requestId: string }
    | { action: 'send'; instructionRevision: 1; instructionDigest: string; instruction: string }
    | { action: 'answer'; promptId: string; revision: number; promptInputDigest: string; decision: 'allow' | 'deny'; message: string | null }
    | { action: 'cancel'; targetRequestId: string };

export interface RuntimeRpcRequest {
    v: typeof RUNTIME_RPC_VERSION;
    action: RuntimeRpcAction;
    scope: RuntimeRequestScope;
    rootRequestId: string | null;
    requestDigest: string | null;
    deadline: string;
    payload: RuntimeRpcPayload;
}

export function validPlacement(value: unknown): value is RuntimePlacement {
    return plainObject(value) && orderedKeys(value, ['generation', 'leaseEpoch', 'instanceId', 'fenceToken'])
        && typeof value.generation === 'string' && COUNTER.test(value.generation)
        && typeof value.leaseEpoch === 'string' && COUNTER.test(value.leaseEpoch)
        && typeof value.instanceId === 'string' && INSTANCE.test(value.instanceId) && isUuid(value.fenceToken);
}

export const samePlacement = (a: RuntimePlacement, b: RuntimePlacement): boolean =>
    a.generation === b.generation && a.leaseEpoch === b.leaseEpoch && a.instanceId === b.instanceId && a.fenceToken === b.fenceToken;

const nullableUuid = (v: unknown) => v === null || isUuid(v);
const nullableIso = (v: unknown) => v === null || isoTimestamp(v) !== null;
const inSet = <T extends string>(set: readonly T[], v: unknown): v is T => typeof v === 'string' && (set as readonly string[]).includes(v);

/** Rebuild a scope in canonical key order; throws on anything outside the contract or the authority rules. */
export function canonicalScope(scope: RuntimeRequestScope): RuntimeRequestScope {
    const s = scope as unknown as Record<string, unknown>;
    const placement = { generation: scope.placement?.generation, leaseEpoch: scope.placement?.leaseEpoch,
        instanceId: scope.placement?.instanceId, fenceToken: scope.placement?.fenceToken };
    const ai = scope.aiAuthorization as unknown as Record<string, unknown> | undefined;
    const aiOk = plainObject(ai) && isUuid(ai.authorizationId) && inSet(AI_AUTHORIZATION_STATES, ai.state)
        && isoTimestamp(ai.expiresAt) !== null && (ai.policyDigest === null || (typeof ai.policyDigest === 'string' && PRODUCER_DIGEST.test(ai.policyDigest)));
    const control = s.authority === 'control';
    if (!(s.authority === 'read' || control) || !isUuid(s.ownerUserId) || typeof s.originalOAuthClientId !== 'string'
        || s.originalOAuthClientId.length < 1 || s.originalOAuthClientId.length > 512 || !isUuid(s.sessionId) || !isUuid(s.computerId)
        || !nullableUuid(s.runtimeId) || !(s.hostEpoch === null || (typeof s.hostEpoch === 'string' && HOST_EPOCH.test(s.hostEpoch)))
        || (s.runtimeId === null) !== (s.hostEpoch === null) || !validPlacement(placement) || s.profile !== RUNTIME_PROFILE_ID
        || !(s.policyDigest === null || (typeof s.policyDigest === 'string' && PRODUCER_DIGEST.test(s.policyDigest))) || !aiOk
        || (control ? !isUuid(s.controlAuthorizationId) || isoTimestamp(s.controlDeadline) === null
            : s.controlAuthorizationId !== null || s.controlDeadline !== null)) throw new TypeError('invalid runtime request scope');
    return {
        authority: scope.authority, ownerUserId: scope.ownerUserId, originalOAuthClientId: scope.originalOAuthClientId,
        sessionId: scope.sessionId, computerId: scope.computerId, runtimeId: scope.runtimeId, hostEpoch: scope.hostEpoch,
        placement: placement as RuntimePlacement, profile: RUNTIME_PROFILE_ID, policyDigest: scope.policyDigest,
        aiAuthorization: { authorizationId: scope.aiAuthorization.authorizationId, state: scope.aiAuthorization.state,
            expiresAt: scope.aiAuthorization.expiresAt, policyDigest: scope.aiAuthorization.policyDigest },
        controlAuthorizationId: scope.controlAuthorizationId, controlDeadline: scope.controlDeadline,
    };
}

/** Serialize one RPC request canonically; throws on an authority mismatch or over the native hop bound. */
export function serializeRuntimeRpc(request: RuntimeRpcRequest): string {
    const read = READ_RPC_ACTIONS.has(request.action);
    const scope = canonicalScope(request.scope);
    if (request.v !== RUNTIME_RPC_VERSION || request.payload.action !== request.action || isoTimestamp(request.deadline) === null
        || scope.authority !== (read ? 'read' : 'control')
        || (read ? request.requestDigest !== null || (request.action === 'request_get') !== (request.rootRequestId !== null)
            : scope.runtimeId === null || !isUuid(request.rootRequestId) || typeof request.requestDigest !== 'string'
                || !DIGEST.test(request.requestDigest))) {
        throw new TypeError('invalid runtime rpc request');
    }
    const body = JSON.stringify({
        v: request.v, action: request.action, scope, rootRequestId: request.rootRequestId, requestDigest: request.requestDigest,
        deadline: request.deadline, payload: request.payload,
    });
    if (utf8Bytes(body) > RUNTIME_LIMITS.nativeHopBytes) throw new RangeError('runtime rpc request too large');
    return body;
}

// ── Host reply projections (strict; failure means unavailable, never partial) ─

const byteCount = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= RUNTIME_LIMITS.nativeHopBytes * 512;

export function projectRuntimeView(value: unknown): RuntimeView | null {
    if (!plainObject(value) || !isUuid(value.runtimeId) || !inSet(RUNTIME_STATES, value.state) || !nullableIso(value.startedAt)
        || !nullableIso(value.lastProgressAt) || !nullableUuid(value.activeRequestId)) return null;
    return {
        runtimeId: value.runtimeId, state: value.state, startedAt: value.startedAt as string | null,
        lastProgressAt: value.lastProgressAt as string | null, activeRequestId: value.activeRequestId as string | null,
    };
}

export function projectRuntimeEvent(value: unknown): RuntimeEvent | null {
    if (!plainObject(value) || typeof value.seq !== 'string' || !COUNTER.test(value.seq) || isoTimestamp(value.at) === null
        || !inSet(RUNTIME_EVENT_TYPES, value.type) || !nullableUuid(value.requestId) || !nullableUuid(value.promptId)
        || !(value.toolUseId === null || (typeof value.toolUseId === 'string' && NATIVE_ID.test(value.toolUseId)))
        || !(value.toolName === null || (typeof value.toolName === 'string' && TOOL_NAME.test(value.toolName)))
        || !(value.outcome === null || inSet(EVENT_OUTCOMES, value.outcome))
        || !(value.runtimeState === null || inSet(RUNTIME_STATES, value.runtimeState))
        || (value.type === 'runtime.state') !== (value.runtimeState !== null)
        || !inSet(EVENT_PAYLOAD_STATUSES, value.payloadStatus)) return null;
    const text = value.text;
    if (value.payloadStatus === 'complete' ? !(text === null || (typeof text === 'string' && !LONE_SURROGATE.test(text))) : text !== null) return null;
    const event: RuntimeEvent = {
        seq: value.seq, at: value.at as string, type: value.type, requestId: value.requestId as string | null,
        promptId: value.promptId as string | null, toolUseId: value.toolUseId as string | null,
        toolName: value.toolName as string | null, outcome: value.outcome as RuntimeEvent['outcome'],
        runtimeState: value.runtimeState as RuntimeState | null, payloadStatus: value.payloadStatus, text: text as string | null,
    };
    // The bound is on the whole serialized event (escaping can grow text), never on raw text. A producer event over it
    // must arrive as `oversize`; one that does not is refused whole, never clipped.
    return utf8Bytes(JSON.stringify(event)) <= RUNTIME_LIMITS.eventTextBytes ? event : null;
}

/** The producer's lineage fences; a reply without all three is not a prompt. */
export function projectPromptContext(value: unknown): PromptContext | null {
    // Reply objects are matched by exact key SET (host serializers may reorder); only signed requests pin key order.
    if (!plainObject(value) || Object.keys(value).sort().join(',') !== 'expiresAt,instructionRequestId,instructionRevision'
        || !isUuid(value.instructionRequestId) || !validRevision(value.instructionRevision) || isoTimestamp(value.expiresAt) === null) return null;
    return { instructionRequestId: value.instructionRequestId, instructionRevision: value.instructionRevision, expiresAt: value.expiresAt as string };
}

/** `answerableNow` is the OS's own fence: AI authority active and the context unexpired at `now`. */
export function projectPromptSummary(value: unknown, answerableNow: (context: PromptContext) => boolean): PromptSummary | null {
    if (!plainObject(value) || !isUuid(value.promptId) || !validRevision(value.revision) || typeof value.toolName !== 'string'
        || !TOOL_NAME.test(value.toolName) || typeof value.toolUseId !== 'string' || !NATIVE_ID.test(value.toolUseId)
        || typeof value.promptInputDigest !== 'string' || !PRODUCER_DIGEST.test(value.promptInputDigest) || !byteCount(value.inputBytes)
        || isoTimestamp(value.openedAt) === null || typeof value.answerable !== 'boolean') return null;
    const context = projectPromptContext(value.context);
    if (!context) return null;
    return {
        promptId: value.promptId, revision: value.revision, toolName: value.toolName, toolUseId: value.toolUseId,
        promptInputDigest: value.promptInputDigest, inputBytes: value.inputBytes as number, openedAt: value.openedAt as string,
        context,
        answerable: value.answerable && (value.inputBytes as number) <= RUNTIME_LIMITS.promptInputBytes && answerableNow(context),
    };
}

const compareSeq = (a: string, b: string) => a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);

export function blockedRuntimeRead(sessionId: string, reason: RuntimeReason): NativeRuntimeRead {
    return {
        statusKind: 'runtime_read', sessionId, availability: 'blocked', reason, runtime: null, events: [], nextCursor: null,
        hasMore: false, cursorReset: false, pendingPrompts: [], pendingPromptsComplete: true,
    };
}

/** The private part of a host `read` reply: the runtime's host epoch and Core policy digest. Never public. */
export interface HostRuntimeBinding { runtimeId: string; hostEpoch: string; policyDigest: string | null }

export function projectHostRuntimeBinding(reply: unknown): HostRuntimeBinding | null {
    if (!plainObject(reply) || !plainObject(reply.runtime) || !isUuid(reply.runtime.runtimeId) || typeof reply.hostEpoch !== 'string'
        || !HOST_EPOCH.test(reply.hostEpoch)
        || !(reply.policyDigest === null || (typeof reply.policyDigest === 'string' && PRODUCER_DIGEST.test(reply.policyDigest)))) return null;
    return { runtimeId: reply.runtime.runtimeId, hostEpoch: reply.hostEpoch, policyDigest: reply.policyDigest as string | null };
}

/**
 * Project a host `read` reply into the public read. Events must be whole, gap-free and strictly increasing after
 * the cursor (unless it named another runtime). The page then stops before the first event that would push the
 * whole response over 131072 bytes; omitted events are never passed by `nextCursor`.
 */
export function projectRuntimeRead(sessionId: string, cursor: string | null, limit: number, reply: unknown,
    answerableNow: (context: PromptContext) => boolean): NativeRuntimeRead | null {
    if (!plainObject(reply)) return null;
    const runtime = reply.runtime === null ? null : projectRuntimeView(reply.runtime);
    if (reply.runtime !== null && !runtime) return null;
    if (!Array.isArray(reply.events) || !Array.isArray(reply.pendingPrompts) || typeof reply.hasMore !== 'boolean'
        || typeof reply.pendingPromptsComplete !== 'boolean') return null;
    if (reply.events.length > limit || reply.pendingPrompts.length > RUNTIME_LIMITS.pendingPromptsMax) return null;
    if (runtime === null && (reply.events.length > 0 || reply.pendingPrompts.length > 0)) return null;
    const at = cursor ? CURSOR.exec(cursor) : null;
    const cursorReset = Boolean(at && runtime && at[1] !== runtime.runtimeId);
    let last = at && !cursorReset ? at[2]! : null;
    const events: RuntimeEvent[] = [];
    for (const raw of reply.events) {
        const event = projectRuntimeEvent(raw);
        if (!event || (last !== null && compareSeq(event.seq, last) <= 0)) return null;
        last = event.seq;
        events.push(event);
    }
    const pendingPrompts: PromptSummary[] = [];
    for (const raw of reply.pendingPrompts) {
        const prompt = projectPromptSummary(raw, answerableNow);
        if (!prompt) return null;
        pendingPrompts.push(prompt);
    }
    const page = (count: number, prompts: PromptSummary[], promptsComplete: boolean): NativeRuntimeRead => {
        const shown = events.slice(0, count);
        const tail = shown.at(-1);
        return {
            statusKind: 'runtime_read', sessionId, availability: 'available', reason: null, runtime, events: shown,
            nextCursor: tail && runtime ? `${runtime.runtimeId}.${tail.seq}` : null,
            hasMore: (reply.hasMore as boolean) || count < events.length, cursorReset, pendingPrompts: prompts,
            pendingPromptsComplete: promptsComplete,
        };
    };
    let prompts = pendingPrompts;
    let promptsComplete = reply.pendingPromptsComplete as boolean;
    while (prompts.length > 0 && !fitsResponse(page(0, prompts, promptsComplete))) {
        prompts = prompts.slice(0, -1);
        promptsComplete = false;
    }
    // Largest whole-event prefix that fits; monotone in count, so a linear walk from the front is exact.
    let count = 0;
    while (count < events.length && fitsResponse(page(count + 1, prompts, promptsComplete))) count += 1;
    return page(count, prompts, promptsComplete);
}

/**
 * Project a host `prompt_get` reply. The producer digest and context are kept exactly; the input object is
 * size-checked only. `answerableNow` adds the OS's own fences (AI authority active, context unexpired).
 */
export function projectNativePrompt(sessionId: string, promptId: string, reply: unknown,
    answerableNow: (context: PromptContext) => boolean): NativePrompt | null {
    const v = reply;
    const context = plainObject(v) ? projectPromptContext(v.context) : null;
    if (!plainObject(v) || !context || !isUuid(v.runtimeId) || v.promptId !== promptId || !validRevision(v.revision)
        || typeof v.nativeRequestId !== 'string' || !NATIVE_ID.test(v.nativeRequestId) || typeof v.toolUseId !== 'string'
        || !NATIVE_ID.test(v.toolUseId) || typeof v.toolName !== 'string' || !TOOL_NAME.test(v.toolName)
        || !inSet(PROMPT_KINDS, v.promptKind) || !inSet(PROMPT_STATES, v.state) || !inSet(PROMPT_INPUT_STATUSES, v.inputStatus)
        || typeof v.promptInputDigest !== 'string' || !PRODUCER_DIGEST.test(v.promptInputDigest) || !byteCount(v.inputBytes)
        || !Array.isArray(v.rootRequestIds) || v.rootRequestIds.length > RUNTIME_LIMITS.rootRequestIdsMax
        || !v.rootRequestIds.every(isUuid) || typeof v.answerable !== 'boolean') return null;
    let inputStatus = v.inputStatus;
    let input: Record<string, unknown> | null = null;
    if (inputStatus === 'complete') {
        if (!plainObject(v.input)) return null;
        let size: number;
        try { size = utf8Bytes(JSON.stringify(v.input)); } catch { return null; }
        if (size !== v.inputBytes) return null;
        if (size > RUNTIME_LIMITS.promptInputBytes) inputStatus = 'oversize';
        else input = v.input;
    } else if (v.input !== null) return null;
    const answerable = v.answerable && input !== null && v.promptKind === 'permission' && v.state === 'open' && answerableNow(context);
    const prompt: NativePrompt = {
        statusKind: 'runtime_prompt', sessionId, runtimeId: v.runtimeId, promptId, revision: v.revision,
        nativeRequestId: v.nativeRequestId, toolUseId: v.toolUseId, toolName: v.toolName, promptKind: v.promptKind,
        state: v.state, inputStatus, input, promptInputDigest: v.promptInputDigest, inputBytes: v.inputBytes as number,
        context, answerable, rootRequestIds: [...(v.rootRequestIds as string[])],
    };
    return fitsResponse(prompt) ? prompt : { ...prompt, inputStatus: 'oversize', input: null, answerable: false };
}

/** A Core durable request receipt as the host relays it (`request_get`, or the reply of send/answer/cancel). */
export interface CoreRequestReceipt {
    requestId: string;
    kind: ControlKind;
    requestDigest: string;
    state: CoreReceiptState;
    effect: Exclude<ControlEffect, 'none'>;
    reason: string | null;
    runtimeId: string;
}

export function projectCoreReceipt(requestId: string, kind: ControlKind, requestDigest: string, runtimeId: string, reply: unknown): CoreRequestReceipt | null {
    if (!plainObject(reply) || reply.requestId !== requestId || reply.kind !== kind || reply.requestDigest !== requestDigest
        || reply.runtimeId !== runtimeId || !inSet(CORE_RECEIPT_STATES, reply.state) || !inSet(CONTROL_EFFECTS, reply.effect)
        || reply.effect === 'none' || !(reply.reason === null || typeof reply.reason === 'string')) return null;
    // Core tombstones an unseen cancel target before any later submit can reserve it: only a cancel may report it, and
    // only as a terminal cancel outcome. It is never a native stop.
    if (reply.effect === 'tombstone_before_dispatch') {
        if (kind !== 'cancel' || (reply.state !== 'cancelled' && reply.state !== 'completed')) return null;
    } else if ((reply.state === 'accepted' || reply.state === 'completed') && reply.effect !== 'native_observed') {
        // A state that claims a native effect needs exact native evidence; nothing is inferred upwards.
        return null;
    }
    if (reply.state === 'unknown' && reply.effect !== 'unknown') return null;
    return {
        requestId, kind, requestDigest, state: reply.state, effect: reply.effect as CoreRequestReceipt['effect'],
        reason: reply.reason as string | null, runtimeId,
    };
}

/** The host's `request_get` reply for an initial task: its persisted create mapping as the producer reports it. */
export interface InitialTaskObservation {
    state: InitialTaskState;
    effect: (typeof INITIAL_TASK_EFFECTS)[number];
    reason: string | null;
    runtimeId: string | null;
}

export function projectInitialTaskObservation(requestId: string, reply: unknown): InitialTaskObservation | null {
    if (!plainObject(reply) || reply.requestId !== requestId || reply.kind !== 'initial_task' || !inSet(INITIAL_TASK_STATES, reply.state)
        || !inSet(INITIAL_TASK_EFFECTS, reply.effect) || !(reply.reason === null || typeof reply.reason === 'string')
        || !nullableUuid(reply.runtimeId)) return null;
    // The host adopts the Core UUID at prepare, before any SDK ACK: `starting`, `unknown` and `failed` may carry the
    // persisted UUID or none, as the evidence is. A native claim needs both a real UUID and native evidence.
    if ((reply.state === 'accepted' || reply.state === 'completed') && (reply.runtimeId === null || reply.effect !== 'native_observed')) return null;
    if (reply.state === 'unknown' && reply.effect !== 'unknown') return null;
    return { state: reply.state, effect: reply.effect, reason: reply.reason as string | null, runtimeId: reply.runtimeId as string | null };
}

// ── Required next Core ABI (unavailable until the Core owner ships it) ──

/** The host-side producer each RPC action resolves to; declared here so OS, host and Core share one shape. */
export interface NativeRuntimeCoreAbi {
    read(input: { principal: string; requestScope: RuntimeRequestScope; cursor: { runtimeId: string; seq: string } | null; limit: number }): Promise<unknown>;
    getRequest(input: { principal: string; requestScope: RuntimeRequestScope; requestId: string }): Promise<unknown>;
    getPrompt(input: { principal: string; requestScope: RuntimeRequestScope; promptId: string }): Promise<unknown>;
    submit(input: { principal: string; requestScope: RuntimeRequestScope; requestId: string; requestDigest: string; instruction: string }): Promise<unknown>;
    decide(input: { principal: string; requestScope: RuntimeRequestScope; requestId: string; promptId: string; revision: number;
        promptInputDigest: string; decision: 'allow' | 'deny'; message?: string }): Promise<unknown>;
    cancel(input: { principal: string; requestScope: RuntimeRequestScope; requestId: string; targetRequestId: string }): Promise<unknown>;
}
