/**
 * Native session BFF behind `/api/shell/native-sessions/*`. Route files only wire production dependencies.
 *
 * Off unless `EZIL_NATIVE_SESSIONS=1`; while off every handler answers 404 before touching Supabase, the
 * database, the network or the host transport.
 *
 * Writes (create, renew):
 * 1. Any `Authorization` header is refused: normal cookie only, even where tRPC would accept a bearer.
 * 2. `Origin` must equal the configured canonical origin (`EZIL_NATIVE_SESSIONS_ORIGIN`, exact https origin)
 *    character for character; Host and X-Forwarded-* are never consulted. `Sec-Fetch-Site`, when sent, must be
 *    `same-origin`. Missing, `null` or foreign origins are refused.
 * 3. `application/json`, streamed with a small byte cap, exact fields only.
 * 4. Cookie `getUser()`, then the caller's own stored operation for that key: a different request conflicts;
 *    the same request returns the original read-only receipt only while its computer is still a live computer
 *    of the caller (else 404, no receipt). Nothing below runs for a stored key.
 * 5. Readiness for a new key: sealed exchange configuration, an owned task resolver (create) and an available
 *    private host transport that supports this kind. Missing anything is a typed blocked answer with zero
 *    proof, exchange or launch.
 * 6. The original approved CREATE id binds the live 0031 reader inside 0033 transactions.
 * 7. Claim once, prepare and persist the encrypted candidate, dispatch once, open it only for private host
 *    delivery, and recheck authority/consent/lease. No browser access token is read. Unknown outcomes remain
 *    quarantined on their original operation; known-key replay never sends again.
 *
 * Status (GET) is the persisted current-owner projection: the standard normal-cookie `getUser()` and one
 * SELECT. That standard Supabase client may refresh the browser's own login session internally, as it does
 * for every authenticated route; this module adds no refresh of its own. "Pure" means no native proof helper
 * (`currentAccessToken`), Gateway exchange, host call, operation write, wake or dispatch.
 *
 * Responses and logs carry only sanitised state, reason codes, grant id and expiry: never the proof, service
 * credential, grant or a relay capability.
 */

import { createProductionNativeHostTransport } from './production';
import { currentAccessToken, type SessionSource } from '@/server/lib/ai-credential';
import { shellJson, shellUnauthenticated } from '@/server/shell/http';

import { PlacementIsolationError } from '@/server/lib/compute/placement';

import {
    NATIVE_TERMINAL_STATES, NativeOperationIntegrityError, advanceNativeOperation, claimNativeOperation, lookupNativeOperation,
    nativeComputerOwnedNow, nativeRequestDigest,
    readNativeSessionStatus, recheckNativeAuthority, type NativeAuthorityDb, type NativeOperation, type NativeOperationRequest,
    type NativeOperationState, type NativeRefusal, type PinnedPlacement,
} from './authority';
import { NATIVE_AUTHORIZATION_ENV, loadNativeAuthorizationConfig, type NativeAuthorizationConfig } from './native-authorization-config';
import { dispatchNativeOperationOnce, openNativeGrantCandidate, prepareNativeRenewal, type NativeDispatchDeps } from './native-authorization-outbox';
import { readApprovedNativeConsentBindingTx } from '@/server/native-auth/consent-binding';
import {
    NATIVE_PROFILE_ID, type NativeDeliveryOutcome, type NativeHostReadiness, type NativeHostReadinessTarget,
    type NativeHostTransport, type NativeSourceAuthorization, type NativeTaskResolver, type SealedNativeTask,
} from './host-transport';

export const NATIVE_SESSION_BODY_MAX_BYTES = 2_048;
export const NATIVE_DELIVERY_TIMEOUT_MS = 10_000;
/** Hard deadline for the host's pure readiness probe. */
export const NATIVE_READINESS_TIMEOUT_MS = 5_000;

export interface NativeSessionSupabase extends SessionSource {
    auth: SessionSource['auth'] & { getUser(): Promise<{ data: { user: { id: string } | null } }> };
}

export interface NativeSessionDeps {
    env: Readonly<Record<string, string | undefined>>;
    supabase: () => Promise<NativeSessionSupabase>;
    db: NativeAuthorityDb;
    fetch: typeof fetch;
    hostTransport: NativeHostTransport;
    /** Null in this build: no owned task artifact store exists, so create is blocked. */
    taskResolver: NativeTaskResolver | null;
    currentAccessToken: (userId: string, headers: Headers, supabase: SessionSource) => Promise<string | null>;
    now: () => number;
    /** Hard delivery deadline; defaults to `NATIVE_DELIVERY_TIMEOUT_MS`. */
    deliveryTimeoutMs?: number;
    /** Hard readiness deadline; defaults to `NATIVE_READINESS_TIMEOUT_MS`. */
    readinessTimeoutMs?: number;
    /** Imported non-extractable configuration; fixtures may inject RAM-only keys. */
    nativeAuthorizationConfig?: NativeAuthorizationConfig;
}

/** Production wiring. Host transport stays truthfully unavailable and no task resolver is admitted. */
export function productionNativeSessionDeps(db: NativeAuthorityDb, supabase: () => Promise<NativeSessionSupabase>): NativeSessionDeps {
    return {
        env: process.env, db, supabase, fetch: (input, init) => fetch(input, init),
        hostTransport: createProductionNativeHostTransport(process.env), taskResolver: null, currentAccessToken, now: () => Date.now(),
    };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TASK_REF = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const JSON_TYPE = /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i;

const MESSAGES: Readonly<Record<string, string>> = {
    native_sessions_disabled: 'Native sessions are not available.',
    native_session_blocked: 'Native sessions are not ready on this deployment.',
    bearer_not_accepted: 'Sign in with your browser session to use native sessions.',
    origin_refused: 'This request came from another site, so EZiL OS refused it.',
    unsupported_media_type: 'Expected a JSON body.',
    body_too_large: 'The request body is too large.',
    bad_request: 'The request is not a valid native session request.',
    subject_token_unavailable: 'Sign in again to start a native session.',
    task_unavailable: 'That task is not available to you.',
    operation_conflict: 'That operation id was already used for a different request.',
    session_exists: 'That session already exists.',
    session_not_found: 'Native session not found.',
    computer_not_found: 'Computer not found.',
    not_found: 'Not found.',
    internal_error: 'Something went wrong on our side.',
};
const REFUSED_MESSAGE = 'The computer cannot accept this native session right now.';

const refuse = (code: string, status: number, reason?: string) =>
    shellJson({ error: { code, message: MESSAGES[code] ?? REFUSED_MESSAGE, ...(reason ? { reason } : {}) } }, status);
const blocked = (reason: string) => refuse('native_session_blocked', 503, reason);

/**
 * Logs a fixed route label and one fixed category chosen by class identity. Never an error's name, code,
 * message, stack or cause: each is writable and can carry request or token data.
 */
function internalError(route: string, error: unknown): Response {
    const category = error instanceof NativeOperationIntegrityError ? 'integrity'
        : error instanceof PlacementIsolationError ? 'isolation' : 'unexpected';
    console.error(`[native-session] ${route} failed`, { category });
    return refuse('internal_error', 500);
}

export function nativeSessionsEnabled(env: NativeSessionDeps['env']): boolean {
    return env.EZIL_NATIVE_SESSIONS === '1';
}

/** The configured canonical origin, or null unless it is exactly an https origin (no path, slash or default port). */
export function nativeSessionsOrigin(env: NativeSessionDeps['env']): string | null {
    const value = env.EZIL_NATIVE_SESSIONS_ORIGIN;
    if (typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value ? value : null;
    } catch {
        return null;
    }
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export function parseNativeCreateBody(value: unknown): Extract<NativeOperationRequest, { kind: 'create' }> | null {
    if (!exactKeys(value, ['operationId', 'sessionId', 'computerId', 'instructionRevision', 'instructionDigest', 'taskRef'])) return null;
    const { operationId, sessionId, computerId, instructionRevision, instructionDigest, taskRef } = value;
    if (!isUuid(operationId) || !isUuid(sessionId) || !isUuid(computerId) || instructionRevision !== 1
        || typeof instructionDigest !== 'string' || !DIGEST.test(instructionDigest) || typeof taskRef !== 'string' || !TASK_REF.test(taskRef)) return null;
    return { kind: 'create', operationId, sessionId, computerId, instructionRevision: 1, instructionDigest, taskRef };
}

export function parseNativeRenewBody(value: unknown, sessionId: string): Extract<NativeOperationRequest, { kind: 'renew' }> | null {
    if (!exactKeys(value, ['operationId']) || !isUuid(value.operationId) || !UUID.test(sessionId)) return null;
    return { kind: 'renew', operationId: value.operationId, sessionId };
}

/** The normal-cookie write guard: no bearer, exact configured Origin, `Sec-Fetch-Site: same-origin` when sent. */
export function nativeCookieWriteGuard(req: Request, env: NativeSessionDeps['env']): Response | null {
    return writeGuard(req, env);
}

function writeGuard(req: Request, env: NativeSessionDeps['env']): Response | null {
    if (req.headers.has('authorization')) return refuse('bearer_not_accepted', 401);
    const origin = nativeSessionsOrigin(env);
    if (!origin) return blocked('origin_unconfigured');
    const site = req.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return refuse('origin_refused', 403);
    if (req.headers.get('origin') !== origin) return refuse('origin_refused', 403);
    return null;
}

async function readJsonBody(req: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
    if (!JSON_TYPE.test(req.headers.get('content-type') ?? '')) return { ok: false, response: refuse('unsupported_media_type', 415) };
    const declared = req.headers.get('content-length');
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > NATIVE_SESSION_BODY_MAX_BYTES)) {
        return { ok: false, response: refuse('body_too_large', 413) };
    }
    if (!req.body) return { ok: false, response: refuse('bad_request', 400) };
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > NATIVE_SESSION_BODY_MAX_BYTES) {
            void reader.cancel().catch(() => {});
            return { ok: false, response: refuse('body_too_large', 413) };
        }
        chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    try {
        return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) };
    } catch {
        return { ok: false, response: refuse('bad_request', 400) };
    }
}

async function cookieUserId(supabase: NativeSessionSupabase): Promise<string | null> {
    const id = (await supabase.auth.getUser()).data.user?.id;
    return typeof id === 'string' && UUID.test(id.toLowerCase()) ? id.toLowerCase() : null;
}

// ── Views ────────────────────────────────────────────────────────────────

const DEFINITE_FAILURES: ReadonlySet<NativeOperationState> = new Set(['exchange_refused', 'authority_changed', 'host_refused']);

/** The frozen base view (root DTO freeze): no `replayed`, which only the cookie POST receipt adds. */
export interface NativeOperationView {
    operationId: string;
    kind: 'create' | 'renew';
    sessionId: string;
    computerId: string;
    state: NativeOperationState;
    reason: string | null;
    settled: boolean;
    grantId: string | null;
    grantExpiresAt: string | null;
}

/** The only operation fields a browser sees. */
export function nativeOperationView(op: NativeOperation): NativeOperationView {
    return {
        operationId: op.operationId, kind: op.kind, sessionId: op.sessionId, computerId: op.computerId, state: op.state,
        reason: op.reason, settled: NATIVE_TERMINAL_STATES.has(op.state), grantId: op.grantId,
        grantExpiresAt: op.grantExpiresAt?.toISOString() ?? null,
    };
}

/** HTTP status of an operation view: `201` delivered, `409` definite non-delivery, `202` in flight or unknown. */
export function nativeOperationStatus(op: NativeOperation): number {
    return op.state === 'delivered' ? 201 : DEFINITE_FAILURES.has(op.state) ? 409 : 202;
}

function operationResponse(op: NativeOperation, replayed: boolean): Response {
    return shellJson({ operation: { ...nativeOperationView(op), replayed } }, nativeOperationStatus(op));
}

const REFUSAL_STATUS: Partial<Record<NativeRefusal, number>> = { computer_not_found: 404, session_not_found: 404 };

// ── Operation pipeline ───────────────────────────────────────────────────

/**
 * The already-authenticated normal-cookie caller: the user id `getUser()` returned and the same request's
 * own headers and Supabase client, which `currentAccessToken` reads for the proof. Built only by a cookie
 * route after its own guard; never from caller JSON or from synthesised headers.
 */
export interface NativeCookieCaller {
    readonly userId: string;
    readonly supabase: NativeSessionSupabase;
    readonly headers: Headers;
}

/** Re-reads the owner's consent through the trusted reader: still readable, stopped, or otherwise unreadable. */
export type NativeConsentRecheck = () => Promise<'ok' | 'authorization_revoked' | 'authorization_unavailable'>;

/** The typed outcome of one run. `blocked` and `refused` happened before any tombstone was written. */
export type NativeRunResult =
    | { kind: 'operation'; operation: NativeOperation; replayed: boolean }
    | { kind: 'blocked'; reason: string }
    | { kind: 'refused'; code: string; status: number; reason?: string };

/** The cookie-route answer for a run result (also used by tests of the admitted path). */
export function nativeRunResponse(result: NativeRunResult): Response {
    return runResponse(result);
}

function runResponse(result: NativeRunResult): Response {
    if (result.kind === 'operation') return operationResponse(result.operation, result.replayed);
    if (result.kind === 'blocked') return blocked(result.reason);
    return refuse(result.code, result.status, result.reason);
}

/**
 * Answer an operation key the caller already used. Order matters:
 * 1. Different canonical input is `409 operation_conflict` forever, whoever owns the computer now.
 * 2. Identical input returns the original receipt only while its computer is still a live computer of the
 *    caller; after deletion or reassignment it is `404 not_found` with no receipt fields. The private
 *    tombstone itself is untouched.
 * The receipt is read only: no proof helper, exchange, host dispatch or write, whatever the placement now is.
 */
async function replay(deps: NativeSessionDeps, userId: string, prior: NativeOperation, request: NativeOperationRequest): Promise<NativeRunResult> {
    if (prior.requestDigest !== nativeRequestDigest(request) || prior.kind !== request.kind || prior.sessionId !== request.sessionId) {
        return { kind: 'refused', code: 'operation_conflict', status: 409 };
    }
    if (!(await nativeComputerOwnedNow(deps.db, userId, prior.computerId))) return { kind: 'refused', code: 'not_found', status: 404 };
    return { kind: 'operation', operation: prior, replayed: true };
}

async function stored(deps: NativeSessionDeps, op: NativeOperation): Promise<NativeOperation> {
    return (await lookupNativeOperation(deps.db, op.userId, op.operationId)) ?? op;
}

/** The durable 0033 candidate commits before its single Gateway send. */
async function settle(deps: NativeSessionDeps, claimed: NativeOperation, admittedLeaseUntil: Date,
    outbox: NativeDispatchDeps, consentOperationId: string, task: SealedNativeTask | null,
    consentRecheck: NativeConsentRecheck, authorizationDeadline: string): Promise<NativeOperation> {
    const exchanging = await advanceNativeOperation(deps.db, claimed, 'claimed', 'exchanging');
    if (!exchanging) return stored(deps, claimed);
    // Fresh clock after claim and CAS waits. Lease and fixed consent deadline never move.
    const leaseExpiresAt = new Date(Math.min(admittedLeaseUntil.getTime(), Date.parse(authorizationDeadline), deps.now() + 280_000)).toISOString();
    const key = { ownerUserId: claimed.userId, operationId: claimed.operationId };
    const prepared = await prepareNativeRenewal(deps.db, outbox, { ...key, consentOperationId, leaseExpiresAt });
    if (prepared.kind !== 'prepared' && prepared.kind !== 'existing') {
        const reason = prepared.kind === 'refused' && prepared.reason === 'service_expired' ? 'service_expired'
            : prepared.kind === 'refused' && ['lease_invalid', 'deadline_passed'].includes(prepared.reason) ? 'lease_boundary' : 'gateway_refused';
        return (await advanceNativeOperation(deps.db, exchanging, 'exchanging', 'exchange_refused', { reason })) ?? stored(deps, claimed);
    }
    const outcome = await dispatchNativeOperationOnce(deps.db, outbox, key);
    const status = outcome.kind === 'settled' ? outcome.status : outcome.kind === 'blocked' ? outcome.status : undefined;
    if (!status || status.state !== 'granted' || !status.grantId || !status.grantExpiresAt) {
        const unknown = status?.state === 'delivery_unknown' || status?.state === 'dispatching' || outcome.kind === 'superseded';
        return (await advanceNativeOperation(deps.db, exchanging, 'exchanging', unknown ? 'exchange_unknown' : 'exchange_refused',
            { reason: unknown ? (['gateway_timeout', 'gateway_unavailable', 'gateway_invalid_response'].includes(status?.reason ?? '')
                ? status!.reason! : 'gateway_unavailable') : 'gateway_refused' })) ?? stored(deps, claimed);
    }
    const granted = await advanceNativeOperation(deps.db, exchanging, 'exchanging', 'granted',
        { grant: { id: status.grantId, expiresAt: new Date(status.grantExpiresAt) } });
    if (!granted) return stored(deps, claimed);
    const opened = await openNativeGrantCandidate(deps.db, outbox, key);
    if (opened.kind !== 'opened') return (await advanceNativeOperation(deps.db, granted, 'granted', 'authority_changed',
        { reason: opened.reason === 'authorization_revoked' ? 'authorization_revoked' : 'authorization_unavailable' })) ?? stored(deps, claimed);
    const grant = { accessToken: opened.bearer.authorizationHeader().slice(7), grantId: status.grantId, expiresAt: new Date(status.grantExpiresAt) };
    const sourceAuthorization = opened.sourceAuthorization;

    // The exchange was an async boundary: authority and the lease are re-read now, just before delivery.
    const check = await recheckNativeAuthority(deps.db, granted);
    if (!check.ok) return (await advanceNativeOperation(deps.db, granted, 'granted', 'authority_changed', { reason: check.reason })) ?? stored(deps, claimed);
    if (grant.expiresAt.getTime() > check.leaseUntil.getTime()) {
        return (await advanceNativeOperation(deps.db, granted, 'granted', 'authority_changed', { reason: 'lease_boundary' })) ?? stored(deps, claimed);
    }
    // The consent is re-read through the trusted reader after the exchange and before any host dispatch: a stop
    // or an unreadable consent ends the operation here, never at the host.
    const consent = await consentRecheck();
    if (consent !== 'ok') return (await advanceNativeOperation(deps.db, granted, 'granted', 'authority_changed', { reason: consent })) ?? stored(deps, claimed);
    const delivering = await advanceNativeOperation(deps.db, granted, 'granted', 'delivering');
    if (!delivering) return stored(deps, claimed);
    // A hard deadline, not just an abort signal: an adapter that ignores the signal still cannot hold this
    // request open. After the deadline the outcome is delivery_unknown for good; a late acknowledgement is
    // dropped and can never promote the operation to delivered.
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<NativeDeliveryOutcome>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown', reason: 'host_timeout' }); },
            deps.deliveryTimeoutMs ?? NATIVE_DELIVERY_TIMEOUT_MS);
    });
    // Fresh clock after delivery CAS and consent re-read waits; never send a spent grant or lease.
    if (grant.expiresAt.getTime() - deps.now() < 10_000 || check.leaseUntil.getTime() <= deps.now()
        || Date.parse(sourceAuthorization.authorizationDeadline) <= deps.now()) {
        clearTimeout(timer);
        return (await advanceNativeOperation(deps.db, delivering, 'delivering', 'host_refused', { reason: 'host_refused' })) ?? stored(deps, claimed);
    }
    const attempt = Promise.resolve().then(() => deps.hostTransport.deliver({
        profileId: NATIVE_PROFILE_ID, kind: delivering.kind, operationId: delivering.operationId, sessionId: delivering.sessionId,
        computerId: delivering.computerId, ownerUserId: delivering.userId, placement: { ...delivering.placement },
        leaseUntil: check.leaseUntil.toISOString(), task, sourceAuthorization,
        grant: { accessToken: grant.accessToken, tokenSha256: opened.tokenSha256,
            grantId: grant.grantId, expiresAt: grant.expiresAt.toISOString() },
    }, controller.signal)).catch((): NativeDeliveryOutcome => ({ kind: 'unknown', reason: 'host_no_ack' }));
    let delivered: NativeDeliveryOutcome;
    try {
        delivered = await Promise.race([attempt, deadline]);
    } finally {
        clearTimeout(timer);
    }
    const next = delivered.kind === 'acknowledged'
        ? advanceNativeOperation(deps.db, delivering, 'delivering', 'delivered')
        : delivered.kind === 'refused'
            ? advanceNativeOperation(deps.db, delivering, 'delivering', 'host_refused', { reason: delivered.reason })
            : advanceNativeOperation(deps.db, delivering, 'delivering', 'delivery_unknown', { reason: delivered.reason });
    return (await next) ?? stored(deps, claimed);
}

/**
 * Readiness for a new key, with no side effect: the sealed exchange configuration, an owned task resolver
 * (create) and an available private host transport. Null when ready, else the fixed blocked reason.
 */
export function nativeRunBlocker(deps: Pick<NativeSessionDeps, 'env' | 'now' | 'taskResolver' | 'hostTransport' | 'nativeAuthorizationConfig'>,
    kind: NativeOperationRequest['kind']): string | null {
    if (!deps.nativeAuthorizationConfig && (deps.env.EZIL_NATIVE_AUTHORIZATION !== 'enabled'
        || !NATIVE_AUTHORIZATION_ENV.every(key => Boolean(deps.env[key])))) return 'gateway_exchange_unconfigured';
    if (kind === 'create' && !deps.taskResolver) return 'task_resolver_unavailable';
    if (!deps.hostTransport.available || deps.hostTransport.supportsKind(kind) !== true) return 'host_unavailable';
    return null;
}

/**
 * The host's pure readiness for exactly `target`, bounded by a hard deadline that does not rely on the adapter
 * honouring abort. True only for `ready`; refused, unknown, a rejection or the deadline are all false.
 */
async function hostReady(deps: NativeSessionDeps, target: NativeHostReadinessTarget): Promise<boolean> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<NativeHostReadiness>(resolve => {
        timer = setTimeout(() => { controller.abort(); resolve({ kind: 'unknown' }); }, deps.readinessTimeoutMs ?? NATIVE_READINESS_TIMEOUT_MS);
    });
    const frozen = Object.freeze({ ...target, placement: Object.freeze({ ...target.placement }) });
    const attempt = Promise.resolve().then(() => deps.hostTransport.checkReadiness(frozen, controller.signal))
        .catch((): NativeHostReadiness => ({ kind: 'unknown' }));
    try {
        return (await Promise.race([attempt, deadline]))?.kind === 'ready';
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The trusted typed broker runner, below every HTTP guard. The caller has already passed its own route's
 * guard (cookie identity, origin, body) and hands over the request's own headers and Supabase client.
 * A new key runs only when `admitted` comes from the trusted consent reader: `placement` is the full approved
 * tuple (the claim compares it with the live tuple inside its own transaction), `sourceAuthorization` is handed to
 * the private host delivery unchanged, and `consentRecheck` re-reads the consent after the exchange, before any
 * host dispatch.
 */
export async function runNativeOperation(deps: NativeSessionDeps, caller: NativeCookieCaller, request: NativeOperationRequest,
    admitted: { placement?: PinnedPlacement; computerId?: string; sourceAuthorization?: NativeSourceAuthorization;
        consentRecheck?: NativeConsentRecheck; consentOperationId?: string } = {}): Promise<NativeRunResult> {
    const { userId } = caller;
    // A stored operation answers from its tombstone before any current capability is consulted: the same key
    // replays even after the resolver, transport or configuration disappear, with no proof, exchange or launch.
    const prior = await lookupNativeOperation(deps.db, userId, request.operationId);
    if (prior) return replay(deps, userId, prior, request);

    // Readiness for a new key: a deployment that cannot deliver never claims, exchanges or mints.
    const blocker = nativeRunBlocker(deps, request.kind);
    if (blocker) return { kind: 'blocked', reason: blocker };
    const loaded = deps.nativeAuthorizationConfig ? { state: 'ready' as const, config: deps.nativeAuthorizationConfig }
        : await loadNativeAuthorizationConfig(deps.env, deps.now());
    if (loaded.state !== 'ready') return { kind: 'blocked', reason: 'gateway_exchange_unconfigured' };
    const outbox: NativeDispatchDeps = { config: loaded.config, readConsent: readApprovedNativeConsentBindingTx, now: deps.now, fetchImpl: deps.fetch };
    // A new key runs only under a consent the trusted reader returned: without one (the legacy Supabase-only
    // cookie route) nothing is minted, so a host that needs that metadata is never left refusing a live grant.
    const { sourceAuthorization, placement: approvedPlacement, consentRecheck, computerId, consentOperationId } = admitted;
    if (!sourceAuthorization || !approvedPlacement || !consentRecheck || !computerId || !consentOperationId
        || (request.kind === 'create' && consentOperationId !== request.operationId)) return { kind: 'blocked', reason: 'consent_terms_unavailable' };
    // The host is asked about exactly this target, under a hard deadline, before any proof, claim or exchange.
    if (!(await hostReady(deps, { kind: request.kind, profileId: NATIVE_PROFILE_ID, ownerUserId: userId, computerId, placement: approvedPlacement }))) {
        return { kind: 'blocked', reason: 'host_unavailable' };
    }

    let task: SealedNativeTask | null = null;
    if (request.kind === 'create') {
        task = await deps.taskResolver!.resolve(request.taskRef, { userId });
        if (!task || task.taskRef !== request.taskRef || task.instructionRevision !== request.instructionRevision
            || task.instructionDigest !== request.instructionDigest) return { kind: 'refused', code: 'task_unavailable', status: 409 };
    }

    // Renew requires actual Core admission revision CAS; unavailable until that ABI is qualified.
    if (request.kind === 'renew') return { kind: 'blocked', reason: 'host_unavailable' };
    const claim = await claimNativeOperation(deps.db, userId, request, { expectPlacement: approvedPlacement });
    if (claim.kind === 'existing') return replay(deps, userId, claim.operation, request);
    if (claim.kind === 'conflict') return { kind: 'refused', code: claim.reason, status: 409 };
    if (claim.kind === 'refused') return { kind: 'refused', code: claim.reason, status: REFUSAL_STATUS[claim.reason] ?? 409, reason: claim.reason };
    return { kind: 'operation', operation: await settle(deps, claim.operation, claim.leaseUntil, outbox, consentOperationId, task,
        consentRecheck, sourceAuthorization.authorizationDeadline), replayed: false };
}

async function runOperation(req: Request, deps: NativeSessionDeps, request: NativeOperationRequest): Promise<Response> {
    const supabase = await deps.supabase();
    const userId = await cookieUserId(supabase);
    if (!userId) return shellUnauthenticated();
    return runResponse(await runNativeOperation(deps, { userId, supabase, headers: req.headers }, request));
}

// ── Handlers ─────────────────────────────────────────────────────────────

const disabled = () => refuse('native_sessions_disabled', 404);

export async function handleNativeSessionCreate(req: Request, deps: NativeSessionDeps): Promise<Response> {
    try {
        if (!nativeSessionsEnabled(deps.env)) return disabled();
        const guard = writeGuard(req, deps.env);
        if (guard) return guard;
        const body = await readJsonBody(req);
        if (!body.ok) return body.response;
        const request = parseNativeCreateBody(body.value);
        return request ? await runOperation(req, deps, request) : refuse('bad_request', 400);
    } catch (error) {
        return internalError('POST /api/shell/native-sessions', error);
    }
}

export async function handleNativeSessionRenew(req: Request, sessionId: string, deps: NativeSessionDeps): Promise<Response> {
    try {
        if (!nativeSessionsEnabled(deps.env)) return disabled();
        const guard = writeGuard(req, deps.env);
        if (guard) return guard;
        const body = await readJsonBody(req);
        if (!body.ok) return body.response;
        const request = parseNativeRenewBody(body.value, sessionId);
        return request ? await runOperation(req, deps, request) : refuse('bad_request', 400);
    } catch (error) {
        return internalError('POST /api/shell/native-sessions/[sessionId]/renew', error);
    }
}

export async function handleNativeSessionStatus(req: Request, sessionId: string, deps: NativeSessionDeps): Promise<Response> {
    try {
        if (!nativeSessionsEnabled(deps.env)) return disabled();
        if (req.headers.has('authorization')) return refuse('bearer_not_accepted', 401);
        if (!UUID.test(sessionId)) return refuse('bad_request', 400);
        const userId = await cookieUserId(await deps.supabase());
        if (!userId) return shellUnauthenticated();
        const status = await readNativeSessionStatus(deps.db, userId, sessionId);
        if (!status) return refuse('session_not_found', 404);
        return shellJson({
            session: {
                sessionId, computerId: status.created.computerId, instructionRevision: Number(status.created.instructionRevision),
                created: nativeOperationView(status.created), latest: nativeOperationView(status.latest),
            },
        });
    } catch (error) {
        return internalError('GET /api/shell/native-sessions/[sessionId]', error);
    }
}
