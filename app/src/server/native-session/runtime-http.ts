import { createProductionNativeAiPort } from './production';
import { createNativeRuntimeAiPort, type NativeConsentReadPorts } from './runtime-composition';
/**
 * Native runtime control receivers (docs/NATIVE-RUNTIME-CONTROL-v1.md §4, §6, §9). Route files only wire
 * production dependencies.
 *
 * MCP REST (`/api/mcp/native-sessions/<sessionId>/runtime/*`): gate, exact canonical URL, strict body, then the
 * shared `delegation-core` verifier with this module's fixed policy and the `EZIL-NATIVE-REST/1` transcript of the
 * request actually received. A delegation that is absent or rejected is refused; there is no cookie fallback.
 *
 * Consent (`/api/shell/native-runtime/authorizations/<requestId>`): normal cookie only (an `Authorization` header is
 * refused), canonical `Origin`, `Sec-Fetch-Site`, exact small JSON body, owner from `getUser()`.
 *
 * Every refusal is a fixed code and message; raw errors, request data and assertions are never echoed or logged.
 */
import {
    delegationConfig, verifyDelegation, type DelegatedAccount, type DelegatedIdentity, type DelegationConfig,
} from '@/server/api/delegation-core';
import { consumeDelegationJti, findDelegatedAccount, type SqlExecutor } from '@/server/api/delegation-store';
import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { shellJson, shellUnauthenticated } from '@/server/shell/http';
import { PlacementIsolationError } from '@/server/lib/compute/placement';
import { NativeOperationIntegrityError, type NativeAuthorityDb } from './authority';
import { nativeSessionsOrigin, type NativeSessionSupabase } from './http';
import type { NativeAiAuthorityPort } from './runtime-authority';
import {
    DIGEST, RUNTIME_LIMITS, RUNTIME_ROUTES, RUNTIME_SCOPE_BY_PROCEDURE, isUuid, nativeRestTranscript, nativeRuntimeControlEnabled,
    orderedKeys, parseRuntimeBody, plainObject, runtimePathname, type RuntimeBody, type RuntimeRoute,
} from './runtime-contract';
import { createAwsRuntimeHostChannel, type NativeRuntimeHostChannel } from './runtime-host';
import {
    controlNativeRuntime, decideRuntimeConsentRequest, getNativeRuntimeOperation, getNativeRuntimePrompt, readNativeRuntime,
    readRuntimeConsent, type RuntimeServiceDeps, type ServiceResult,
} from './runtime-service';
import { RuntimeStoreIntegrityError } from './runtime-store';

export interface NativeRuntimeHttpDeps {
    env: Readonly<Record<string, string | undefined>>;
    db: NativeAuthorityDb;
    aiPort: NativeAiAuthorityPort | null;
    host: NativeRuntimeHostChannel;
    /** The pinned delegation configuration, or undefined when absent (refused, never a cookie fallback). */
    delegationConfig: () => Promise<DelegationConfig | undefined>;
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
    supabase: () => Promise<NativeSessionSupabase>;
    now: () => number;
}

/**
 * Production wiring. Truthfully blocked: the `0031` AI port is absent until the auth owner freezes its exports, and
 * the host channel is unavailable until the host lane ships a qualified transport. Neither is stubbed as success.
 */
export function productionNativeRuntimeDeps(db: NativeAuthorityDb & SqlExecutor, supabase: () => Promise<NativeSessionSupabase>,
    composition?: { consent: NativeConsentReadPorts; installedPolicyDigest: string | null }): NativeRuntimeHttpDeps {
    return {
        env: process.env, db, aiPort: composition ? createNativeRuntimeAiPort(db, composition.consent, composition.installedPolicyDigest) : createProductionNativeAiPort(db, process.env), host: createAwsRuntimeHostChannel(process.env),
        // Read per request from process.env, as the computer receiver does: absent pins only refuse.
        delegationConfig: () => delegationConfig({
            EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
            EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
            EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
            EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
            NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
        }, AUTH0_ISSUER),
        consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
        findAccount: identity => findDelegatedAccount(db, identity),
        supabase, now: () => Date.now(),
    };
}

const JSON_TYPE = /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i;

const MESSAGES: Readonly<Record<string, string>> = {
    not_found: 'Not found.',
    bad_request: 'The request is not a valid native runtime request.',
    unsupported_media_type: 'Expected a JSON body.',
    body_too_large: 'The request body is too large.',
    delegation_required: 'This endpoint needs a delegated EZiL MCP request.',
    delegation_refused: 'The delegated request was refused.',
    bearer_not_accepted: 'Sign in with your browser session to approve native session control.',
    origin_refused: 'This request came from another site, so EZiL OS refused it.',
    request_conflict: 'That request id was already used for a different request.',
    consent_changed: 'This request changed since it was shown. Reload and review it again.',
    native_runtime_blocked: 'Native session control is not available right now.',
    internal_error: 'Something went wrong on our side.',
};

const refuse = (code: string, status: number, reason?: string) =>
    shellJson({ error: { code, message: MESSAGES[code] ?? MESSAGES.internal_error, ...(reason ? { reason } : {}) } }, status);
const notFound = () => refuse('not_found', 404);

/** A fixed route label and one fixed category chosen by class identity; never an error's own text. */
function internalError(route: string, error: unknown): Response {
    const category = error instanceof NativeOperationIntegrityError || error instanceof RuntimeStoreIntegrityError ? 'integrity'
        : error instanceof PlacementIsolationError ? 'isolation' : 'unexpected';
    console.error(`[native-runtime] ${route} failed`, { category });
    return refuse('internal_error', 500);
}

async function readRawBody(req: Request, max: number): Promise<{ ok: true; raw: string } | { ok: false; response: Response }> {
    if (!JSON_TYPE.test(req.headers.get('content-type') ?? '')) return { ok: false, response: refuse('unsupported_media_type', 415) };
    const declared = req.headers.get('content-length');
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > max)) return { ok: false, response: refuse('body_too_large', 413) };
    if (!req.body) return { ok: false, response: refuse('bad_request', 400) };
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > max) {
            void reader.cancel().catch(() => {});
            return { ok: false, response: refuse('body_too_large', 413) };
        }
        chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    try {
        return { ok: true, raw: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) };
    } catch {
        return { ok: false, response: refuse('bad_request', 400) };
    }
}

function serviceResponse<T>(result: ServiceResult<T>): Response {
    switch (result.status) {
        case 200: return shellJson(result.body);
        case 404: return notFound();
        case 409: return refuse('request_conflict', 409);
        case 503: return refuse('native_runtime_blocked', 503, result.reason);
    }
}

function serviceDeps(deps: NativeRuntimeHttpDeps, origin: string): RuntimeServiceDeps {
    return { db: deps.db, aiPort: deps.aiPort, host: deps.host, origin, now: deps.now };
}

/**
 * One MCP runtime call. `selector` is the prompt or request id for the two GET routes. The exact received URL must be
 * the canonical one (no query, fragment, encoding variant or trailing slash).
 */
export async function handleNativeRuntimeRest(req: Request, route: RuntimeRoute, sessionId: string, selector: string | undefined,
    deps: NativeRuntimeHttpDeps): Promise<Response> {
    const label = `${RUNTIME_ROUTES[route].method} /api/mcp/native-sessions/[sessionId]/runtime/${route}`;
    try {
        if (!nativeRuntimeControlEnabled(deps.env)) return notFound();
        const origin = nativeSessionsOrigin(deps.env);
        if (!origin) return refuse('native_runtime_blocked', 503, 'authorization_unavailable');
        const spec = RUNTIME_ROUTES[route];
        if (req.method !== spec.method || !isUuid(sessionId) || ((route === 'promptGet' || route === 'requestGet') !== isUuid(selector))) return notFound();
        let url: URL;
        try { url = new URL(req.url); } catch { return notFound(); }
        const pathname = runtimePathname(route, sessionId, route === 'promptGet' || route === 'requestGet' ? selector : undefined);
        if (url.search !== '' || url.hash !== '' || url.pathname !== pathname || req.url.includes('?') || req.url.includes('#')) return notFound();

        let raw = '';
        if (spec.method === 'POST') {
            const body = await readRawBody(req, RUNTIME_LIMITS.publicBodyBytes);
            if (!body.ok) return body.response;
            raw = body.raw;
        } else if (req.body !== null || (req.headers.get('content-length') ?? '0') !== '0') {
            return refuse('bad_request', 400);
        }
        const kind = route === 'read' || route === 'send' || route === 'answer' || route === 'cancel' ? route : null;
        const parsed: RuntimeBody | null = kind ? parseRuntimeBody(kind, raw, sessionId) : null;
        if (kind && !parsed) return refuse('bad_request', 400);

        const config = await deps.delegationConfig();
        const outcome = await verifyDelegation(req.headers, {
            enabled: true, config, binding: { procedure: spec.procedure, serializedInput: nativeRestTranscript(spec.method, pathname, raw) },
            policy: { scopeByProcedure: RUNTIME_SCOPE_BY_PROCEDURE }, now: () => Math.floor(deps.now() / 1000),
            consumeJti: deps.consumeJti, findAccount: deps.findAccount,
        });
        if (outcome.kind === 'none') return refuse('delegation_required', 401);
        if (outcome.kind === 'rejected') {
            console.info(JSON.stringify({ event: 'ezil_native_runtime_delegation', route, outcome: `rejected:${outcome.reason}` }));
            return outcome.reason === 'not_configured' ? refuse('native_runtime_blocked', 503, 'authorization_unavailable') : refuse('delegation_refused', 401);
        }
        const caller = { userId: outcome.caller.userId, clientId: outcome.caller.clientId };
        const service = serviceDeps(deps, origin);
        if (route === 'promptGet') return serviceResponse(await getNativeRuntimePrompt(service, caller, sessionId, selector!));
        if (route === 'requestGet') return serviceResponse(await getNativeRuntimeOperation(service, caller, sessionId, selector!));
        if (!parsed) return refuse('bad_request', 400);
        return parsed.kind === 'read'
            ? serviceResponse(await readNativeRuntime(service, caller, parsed))
            : serviceResponse(await controlNativeRuntime(service, caller, parsed));
    } catch (error) {
        return internalError(label, error);
    }
}

// ── Consent (normal cookie) ──────────────────────────────────────────────

async function cookieUserId(supabase: NativeSessionSupabase): Promise<string | null> {
    const id = (await supabase.auth.getUser()).data.user?.id;
    return typeof id === 'string' && isUuid(id.toLowerCase()) ? id.toLowerCase() : null;
}

function consentWriteGuard(req: Request, origin: string): Response | null {
    if (req.headers.has('authorization')) return refuse('bearer_not_accepted', 401);
    const site = req.headers.get('sec-fetch-site');
    if (site !== null && site !== 'same-origin') return refuse('origin_refused', 403);
    if (req.headers.get('origin') !== origin) return refuse('origin_refused', 403);
    return null;
}

/** `GET /api/shell/native-runtime/authorizations/<requestId>`: the owner's display view. Read only. */
export async function handleRuntimeConsentGet(req: Request, requestId: string, deps: NativeRuntimeHttpDeps): Promise<Response> {
    try {
        if (!nativeRuntimeControlEnabled(deps.env)) return notFound();
        const origin = nativeSessionsOrigin(deps.env);
        if (!origin) return refuse('native_runtime_blocked', 503, 'authorization_unavailable');
        if (req.headers.has('authorization')) return refuse('bearer_not_accepted', 401);
        if (!isUuid(requestId)) return notFound();
        const userId = await cookieUserId(await deps.supabase());
        if (!userId) return shellUnauthenticated();
        const view = await readRuntimeConsent(serviceDeps(deps, origin), userId, requestId);
        return view ? shellJson({ authorization: view }) : notFound();
    } catch (error) {
        return internalError('GET /api/shell/native-runtime/authorizations/[requestId]', error);
    }
}

/** `POST /api/shell/native-runtime/authorizations/<requestId>` body exactly `{"decision","leaseDigest"}`. */
export async function handleRuntimeConsentPost(req: Request, requestId: string, deps: NativeRuntimeHttpDeps): Promise<Response> {
    try {
        if (!nativeRuntimeControlEnabled(deps.env)) return notFound();
        const origin = nativeSessionsOrigin(deps.env);
        if (!origin) return refuse('native_runtime_blocked', 503, 'authorization_unavailable');
        const guard = consentWriteGuard(req, origin);
        if (guard) return guard;
        if (!isUuid(requestId)) return notFound();
        const body = await readRawBody(req, RUNTIME_LIMITS.consentBodyBytes);
        if (!body.ok) return body.response;
        let value: unknown;
        try { value = JSON.parse(body.raw); } catch { return refuse('bad_request', 400); }
        if (!plainObject(value) || !orderedKeys(value, ['decision', 'leaseDigest']) || (value.decision !== 'approve' && value.decision !== 'deny')
            || typeof value.leaseDigest !== 'string' || !DIGEST.test(value.leaseDigest)) return refuse('bad_request', 400);
        const userId = await cookieUserId(await deps.supabase());
        if (!userId) return shellUnauthenticated();
        const result = await decideRuntimeConsentRequest(serviceDeps(deps, origin), userId, requestId, value.decision, value.leaseDigest);
        if (result.status === 404) return notFound();
        if (result.status === 409) return refuse('consent_changed', 409);
        return shellJson({ authorization: result.body });
    } catch (error) {
        return internalError('POST /api/shell/native-runtime/authorizations/[requestId]', error);
    }
}
