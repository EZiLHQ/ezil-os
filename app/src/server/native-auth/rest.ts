import { createProductionNativeHostTransport } from '@/server/native-session/production';
/**
 * Native authorization REST for the EZiL MCP server, behind `/api/mcp/native-auth-intents` and
 * `/api/mcp/native-sessions/{sessionId}`. Route files only wire production dependencies.
 *
 * Off unless `EZIL_NATIVE_AUTH_INTENTS=1` and `EZIL_NATIVE_SESSIONS=1`: every route answers 404 before
 * touching anything. Then, for every request, in this order:
 * 1. The raw URL must be exactly one fixed route (no query, fragment, encoding or trailing slash) with that
 *    route's own method; the procedure is derived from the route, never from the caller.
 * 2. Readiness: the canonical origin (for the authorization URL), the native client policy
 *    (`EZIL_NATIVE_AUTH_CLIENT_IDS`) and the shared delegation verifier. Missing any is
 *    `503 native_auth_blocked`, before any ledger or account read.
 * 3. POST: `application/json`, at most 65536 raw bytes, valid UTF-8.
 * 4. The shared verifier checks the request over the full `EZIL-NATIVE-REST/1` transcript (method, canonical
 *    path, exact raw body), so a tampered path, method or body fails here, before any ledger read.
 * 5. Native policy again on the verified caller: the procedure's scope and an allowed client.
 * 6. Prepare (POST) parses exactly and stores a `required` intent, or replays the same key: different input
 *    or another client/issuer/subject is `409 operation_conflict` forever (the only definite 409); identical
 *    input answers the same immutable intent's current projection. Prepare never dispatches anything.
 * 7. GET intent: the caller's own intent under that exact operation id, from its issuing client, while its
 *    computer is still the caller's; else `404 not_found` with no fields. GET session: the broker status.
 *
 * Every valid receipt is 200. Every read is pure: no proof helper, Gateway exchange, claim, host call, write
 * or dispatch. Responses and logs never carry the instruction, a token or a verifier error's text.
 */

import { nativeComputerOwnedNow, readNativeSessionStatus, type NativeAuthorityDb } from '@/server/native-session/authority';
import { type NativeHostTransport } from '@/server/native-session/host-transport';
import { nativeOperationView, nativeRunBlocker, nativeSessionsOrigin } from '@/server/native-session/http';
import { shellJson } from '@/server/shell/http';

import {
    NATIVE_INTENT_BODY_MAX_BYTES, UUID, matchNativeRestRoute, nativeIntentInputDigest, nativeRestTranscript, parseNativeIntentBody,
    type NativeIntentInput,
} from './contract';
import type { SqlExecutor } from '@/server/api/delegation-store';

import { NATIVE_SCOPE_BY_PROCEDURE, type NativeDelegationVerifier, type NativeVerifiedCaller } from './delegation';
import { productionNativeDelegationVerifier } from './delegation-verifier';
import { nativeCapabilities, projectNativeIntent } from './projection';
import {
    NativeIntentIntegrityError, blockApprovedNativeIntent, decideNativeIntent, deriveRenewNativeIntent, insertNativeIntent, lookupNativeIntent,
    type NativeIntent, type NativeIntentActor,
} from './store';

export interface NativeAuthRestDeps {
    env: Readonly<Record<string, string | undefined>>;
    db: NativeAuthorityDb;
    /** The trusted wrapper over the shared core (`delegation-verifier.ts`); null blocks every route (503). */
    verifier: NativeDelegationVerifier | null;
    /** Read only for the projected capabilities; nothing here delivers. */
    hostTransport: NativeHostTransport;
    now: () => number;
}

/** Production wiring: the real shared-core wrapper; the host transport stays truthfully unavailable. */
export function productionNativeAuthRestDeps(db: NativeAuthorityDb): NativeAuthRestDeps {
    return {
        env: process.env, db, verifier: productionNativeDelegationVerifier(db as unknown as SqlExecutor),
        hostTransport: createProductionNativeHostTransport(process.env), now: () => Date.now(),
    };
}

const JSON_TYPE = /^application\/json\s*(?:;\s*charset=utf-8\s*)?$/i;
const CLIENT_ID = /^[\x21-\x2b\x2d-\x7e]{1,256}$/;

const MESSAGES: Readonly<Record<string, string>> = {
    native_auth_disabled: 'Native authorization is not available.',
    native_auth_blocked: 'Native authorization is not ready on this deployment.',
    not_found: 'Not found.',
    unsupported_media_type: 'Expected a JSON body.',
    body_too_large: 'The request body is too large.',
    bad_request: 'The request is not a valid native authorization request.',
    instruction_invalid: 'The instruction must be non-blank, well-formed text.',
    instruction_too_large: 'The instruction is too large.',
    instruction_digest_mismatch: 'The instruction digest does not match the instruction.',
    scope_missing: 'The delegation does not grant native session access.',
    client_not_allowed: 'This client may not use native sessions.',
    delegation_refused: 'The delegation was refused.',
    operation_conflict: 'That operation id was already used for a different request.',
    session_exists: 'That session already has a create request.',
    internal_error: 'Something went wrong on our side.',
};

const refuse = (code: string, status: number, reason?: string) =>
    shellJson({ error: { code, message: MESSAGES[code] ?? MESSAGES.bad_request, ...(reason ? { reason } : {}) } }, status);

export function nativeAuthIntentsEnabled(env: NativeAuthRestDeps['env']): boolean {
    return env.EZIL_NATIVE_AUTH_INTENTS === '1' && env.EZIL_NATIVE_SESSIONS === '1';
}

/** The exact allowed MCP client ids (comma separated), or null when the policy is missing or malformed. */
export function nativeClientPolicy(env: NativeAuthRestDeps['env']): ReadonlySet<string> | null {
    const raw = env.EZIL_NATIVE_AUTH_CLIENT_IDS;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const ids = raw.split(',');
    return ids.every(id => CLIENT_ID.test(id)) ? new Set(ids) : null;
}

async function readRawBody(req: Request): Promise<{ ok: true; text: string } | { ok: false; response: Response }> {
    if (!JSON_TYPE.test(req.headers.get('content-type') ?? '')) return { ok: false, response: refuse('unsupported_media_type', 415) };
    const declared = req.headers.get('content-length');
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > NATIVE_INTENT_BODY_MAX_BYTES)) {
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
        if (bytes > NATIVE_INTENT_BODY_MAX_BYTES) {
            void reader.cancel().catch(() => {});
            return { ok: false, response: refuse('body_too_large', 413) };
        }
        chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    try {
        // Fatal decoding and no BOM stripping: the text is exactly the signed bytes.
        return { ok: true, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw) };
    } catch {
        return { ok: false, response: refuse('bad_request', 400) };
    }
}

/** Verified scope tokens: the core's scope string(s), split on single spaces. */
const scopeTokens = (caller: NativeVerifiedCaller) => caller.scope.flatMap(s => s.split(' ')).filter(Boolean);

function actorOf(caller: NativeVerifiedCaller): NativeIntentActor {
    return { clientId: caller.clientId, idpIssuer: caller.idpIssuer, subject: caller.subject, scope: [...new Set(scopeTokens(caller))].sort().join(' ') };
}

const sameActor = (intent: NativeIntent, caller: NativeVerifiedCaller) =>
    intent.clientId === caller.clientId && intent.idpIssuer === caller.idpIssuer && intent.subject === caller.subject;

/** Logs a fixed route label and one fixed category. Never an error's name, message, stack or cause. */
function internalError(route: string, error: unknown): Response {
    console.error(`[native-auth] ${route} failed`, { category: error instanceof NativeIntentIntegrityError ? 'integrity' : 'unexpected' });
    return refuse('internal_error', 500);
}

/** Every valid receipt is 200, new or replayed; a computer no longer the caller's is 404 with no fields. */
async function receipt(deps: NativeAuthRestDeps, intent: NativeIntent, origin: string): Promise<Response> {
    const projected = await projectNativeIntent(deps.db, intent, deps.now(), origin, nativeCapabilities(deps));
    return projected ? shellJson(projected, 200) : refuse('not_found', 404);
}

/** Same key: different input or actor conflicts forever; identical input answers the same intent, never a new dispatch. */
async function replay(deps: NativeAuthRestDeps, prior: NativeIntent, input: NativeIntentInput, inputDigest: string,
    caller: NativeVerifiedCaller, origin: string): Promise<Response> {
    if (prior.inputDigest !== inputDigest || prior.kind !== input.kind || prior.sessionId !== input.sessionId || !sameActor(prior, caller)) {
        return refuse('operation_conflict', 409);
    }
    return receipt(deps, prior, origin);
}

async function prepare(deps: NativeAuthRestDeps, caller: NativeVerifiedCaller, rawBody: string, origin: string): Promise<Response> {
    let value: unknown;
    try { value = JSON.parse(rawBody); } catch { return refuse('bad_request', 400); }
    const parsed = parseNativeIntentBody(value);
    if (!parsed.ok) return refuse(parsed.code, parsed.code === 'instruction_too_large' ? 413 : 400);
    const input = parsed.input;
    const inputDigest = nativeIntentInputDigest(input);
    const userId = caller.userId;

    const prior = await lookupNativeIntent(deps.db, userId, input.operationId);
    if (prior) return replay(deps, prior, input, inputDigest, caller, origin);

    let computerId: string;
    if (input.kind === 'create') {
        // The computer must be the caller's live computer before anything is stored.
        if (!(await nativeComputerOwnedNow(deps.db, userId, input.computerId))) return refuse('not_found', 404);
        computerId = input.computerId;
    } else {
        // A renewal binds to the session's create, read while its computer is still the caller's.
        const status = await readNativeSessionStatus(deps.db, userId, input.sessionId);
        if (!status) return refuse('not_found', 404);
        computerId = status.created.computerId;
    }

    const stored = await insertNativeIntent(deps.db, userId, input, computerId, inputDigest, actorOf(caller));
    // 409 is reserved for operation_conflict; every other refusal is non-definite to the client.
    if (stored.kind === 'session_exists') return refuse('session_exists', 422);
    if (stored.kind === 'existing') return replay(deps, stored.intent, input, inputDigest, caller, origin);
    if (stored.intent.kind === 'renew') return receipt(deps, await settleRenewal(deps, stored.intent), origin);
    return receipt(deps, stored.intent, origin);
}

/**
 * A new renewal derives its session's existing consent (same authorization, deadline and budget; no browser
 * approval, no new approval time, no browser JWT); without one it is blocked (`session_not_active`). A renewal
 * still needs a proof that does not come from a browser, and no such wire exists in this build, so a derived
 * renewal is then blocked before any claim: by the deployment's own readiness when that is missing (an
 * unsupported kind is `host_unavailable`), else `subject_token_unavailable`. Zero proof, exchange, claim or
 * delivery either way, and a replay of the same key never runs this again.
 */
async function settleRenewal(deps: NativeAuthRestDeps, intent: NativeIntent): Promise<NativeIntent> {
    const { userId, operationId } = intent;
    const derived = await deriveRenewNativeIntent(deps.db, userId, operationId);
    if (!derived) {
        await decideNativeIntent(deps.db, userId, operationId, 'blocked', 'session_not_active');
    } else {
        const blocker = nativeRunBlocker({ env: deps.env, now: deps.now, hostTransport: deps.hostTransport, taskResolver: null }, 'renew');
        await blockApprovedNativeIntent(deps.db, userId, operationId, blocker ?? 'subject_token_unavailable');
    }
    return (await lookupNativeIntent(deps.db, userId, operationId)) ?? intent;
}

async function getIntent(deps: NativeAuthRestDeps, caller: NativeVerifiedCaller, operationId: string, origin: string): Promise<Response> {
    const intent = await lookupNativeIntent(deps.db, caller.userId, operationId);
    // Another client's intent is indistinguishable from none.
    if (!intent || intent.clientId !== caller.clientId) return refuse('not_found', 404);
    return receipt(deps, intent, origin);
}

/** Root DTO freeze: `{statusKind:'broker_status', session:{sessionId, computerId, instructionRevision:1, created, latest}}`. */
async function getSession(deps: NativeAuthRestDeps, caller: NativeVerifiedCaller, sessionId: string): Promise<Response> {
    const status = await readNativeSessionStatus(deps.db, caller.userId, sessionId);
    if (!status) return refuse('not_found', 404);
    return shellJson({
        statusKind: 'broker_status',
        session: {
            sessionId, computerId: status.created.computerId, instructionRevision: 1,
            created: nativeOperationView(status.created), latest: nativeOperationView(status.latest),
        },
    });
}

export async function handleNativeAuthRest(req: Request, deps: NativeAuthRestDeps): Promise<Response> {
    let label = 'native-auth';
    try {
        if (!nativeAuthIntentsEnabled(deps.env)) return refuse('native_auth_disabled', 404);
        const route = matchNativeRestRoute(req.method, req.url);
        if (!route) return refuse('not_found', 404);
        label = route.procedure;
        const origin = nativeSessionsOrigin(deps.env);
        if (!origin) return refuse('native_auth_blocked', 503, 'origin_unconfigured');
        const clients = nativeClientPolicy(deps.env);
        if (!clients) return refuse('native_auth_blocked', 503, 'client_policy_unconfigured');
        if (!deps.verifier) return refuse('native_auth_blocked', 503, 'delegation_verifier_unavailable');

        let rawBody = '';
        if (route.method === 'POST') {
            const body = await readRawBody(req);
            if (!body.ok) return body.response;
            rawBody = body.text;
        }

        const verified = await deps.verifier.verify({
            headers: req.headers, procedure: route.procedure, serializedInput: nativeRestTranscript(route, rawBody), allowedClientIds: clients,
        });
        if (!verified.ok) return refuse('delegation_refused', verified.status === 403 ? 403 : 401);
        const caller = verified.caller;
        // Defence in depth on the verified caller: the procedure's own scope and an allowed client.
        if (!scopeTokens(caller).includes(NATIVE_SCOPE_BY_PROCEDURE.get(route.procedure)!)) return refuse('scope_missing', 403);
        if (!clients.has(caller.clientId)) return refuse('client_not_allowed', 403);
        if (!UUID.test(caller.userId)) return refuse('delegation_refused', 401);

        if (route.procedure === 'nativeAuthorization.prepare') return await prepare(deps, caller, rawBody, origin);
        if (route.procedure === 'nativeAuthorization.get') return await getIntent(deps, caller, route.id!, origin);
        return await getSession(deps, caller, route.id!);
    } catch (error) {
        return internalError(label, error);
    }
}
