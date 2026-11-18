/**
 * Browser consent for a native authorization intent: the `/native/authorize/<operationId>` page and its
 * explicit allow/deny POST to `/api/native/authorize/<operationId>`.
 *
 * Identity is the normal sign-in cookie only (`getUser()` through the standard server client). An intent is
 * looked up under (signed-in user, operation id): another account, including after an account switch, sees
 * exactly what a missing intent shows, and nothing ever rebinds an intent to the current account.
 *
 * The POST, in order:
 * 1. Gate, canonical lowercase UUID path, then the existing cookie write guard: no bearer, the exact
 *    configured Origin, `Sec-Fetch-Site: same-origin` when sent.
 * 2. `application/x-www-form-urlencoded`, small, exactly `decision` (allow|deny) and `inputDigest`, each once.
 *    `inputDigest` binds the decision to the exact intent the page showed.
 * 3. The owner's intent under that key while its computer is still theirs, else 404 with no fields.
 * 4. Anything but an undecided, unexpired intent changes nothing (303 back to the page): a reload or a second
 *    tab never dispatches again.
 * 5. Deny: `required>denied`. Allow (create only; renewals are never browser-approved): admitted consent terms
 *    and readiness first (sealed exchange config, task resolver, available private host supporting the kind);
 *    missing either is a terminal `required>blocked` with zero proof, exchange, claim or queue. Ready: one
 *    transaction approves with the finite terms and seals the private artifact; only the request that won that CAS runs the
 *    trusted broker runner, with this request's own cookie headers and client. A definite refusal before any
 *    operation exists is recorded as `approved>blocked`; once an operation exists its exact state is the status.
 *
 * Neither handler logs or returns the instruction outside the owner's own page.
 */

import {
    NATIVE_SCOPE_WRITE, SHA256_DIGEST, UUID, nativeAuthorizePath, nativeConsentTermsConfig, nativeConsentTermsDigest, nativeTaskRef,
    type NativeConsentTermsConfig,
} from './contract';
import { readApprovedNativeConsentBinding, readNativeConsentHistory, type NativeConsentBinding } from './consent-binding';
import { NATIVE_AUTHORIZATION_REASONS, nativeCapabilities, projectNativeIntent, type NativeIntentReceipt } from './projection';
import {
    NativeIntentIntegrityError, approveNativeIntent, blockApprovedNativeIntent, decideNativeIntent, lookupNativeIntent, nativeArtifactTaskResolver,
    nativeConsentRevokedAt, revokeNativeConsent, type NativeConsentTerms, type NativeIntent,
} from './store';
import { nativeAuthIntentsEnabled } from './rest';

import { lookupNativeOperation, type NativeAuthorityDb, type NativeOperationRequest } from '@/server/native-session/authority';
import {
    nativeCookieWriteGuard, nativeRunBlocker, nativeSessionsOrigin, productionNativeSessionDeps, runNativeOperation,
    type NativeSessionDeps, type NativeSessionSupabase,
} from '@/server/native-session/http';
import { PlacementIsolationError } from '@/server/lib/compute/placement';
import type { NativeSourceAuthorization } from '@/server/native-session/host-transport';
import { NativeOperationIntegrityError } from '@/server/native-session/authority';
import { loadNativeAuthorizationConfig } from '@/server/native-session/native-authorization-config';
import { prepareNativeRevoke, dispatchNativeOperationOnce } from '@/server/native-session/native-authorization-outbox';
import { readNativeConsentRevocation } from './store';
import { shellJson } from '@/server/shell/http';
import { RETURN_URL_PARAM, Routes } from '@/utils/constants';

export const NATIVE_CONSENT_BODY_MAX_BYTES = 512;

/** Production wiring: the real artifact resolver; the host transport stays truthfully unavailable. */
export function productionNativeConsentDeps(db: NativeAuthorityDb, supabase: () => Promise<NativeSessionSupabase>): NativeSessionDeps {
    return { ...productionNativeSessionDeps(db, supabase), taskResolver: nativeArtifactTaskResolver(db) };
}

export interface NativeConsentView {
    receipt: NativeIntentReceipt;
    /** The exact private task text, for the signed-in owner's own page only. Null for a renewal. */
    instruction: string | null;
    /** Bound into the decision form. */
    inputDigest: string;
    /** True only while a create intent is undecided and unexpired and terms are admitted. Renewals are never browser-approved. */
    decidable: boolean;
    clientId: string;
    /**
     * The actual terms: what an approval now would bind (`offered`, from the admitted configuration), and what
     * this intent bound (`bound`, null before approval and for rows approved before terms existed).
     */
    terms: { offered: NativeConsentTermsConfig | null; bound: NativeConsentTerms | null };
    /** Digest of the offered terms, bound into the decision form; null when none are admitted. */
    termsDigest: string | null;
    /** When the owner stopped the bound consent, or null (also null when nothing is bound). */
    revokedAt: Date | null;
    /**
     * The digest of the bound terms when this approved create has no operation yet and may be started again under
     * the same id (same-ID recovery); null otherwise.
     */
    recoveryTermsDigest: string | null;
}

/** The signed-in owner's consent view, or null (unknown key, another account, or a computer no longer theirs). */
export async function loadNativeConsent(deps: Pick<NativeSessionDeps, 'db' | 'now' | 'env' | 'hostTransport'>, userId: string,
    operationId: string): Promise<NativeConsentView | null> {
    const origin = nativeSessionsOrigin(deps.env);
    if (!origin || !UUID.test(userId) || !UUID.test(operationId)) return null;
    const intent = await lookupNativeIntent(deps.db, userId, operationId);
    if (!intent) return null;
    const receipt = await projectNativeIntent(deps.db, intent, deps.now(), origin, nativeCapabilities(deps));
    if (!receipt) return null;
    const offered = nativeConsentTermsConfig(deps.env);
    const revokedAt = intent.terms ? await nativeConsentRevokedAt(deps.db, userId, intent.terms.authzId) : null;
    const recoverable = intent.kind === 'create' && intent.state === 'approved' && intent.terms !== null && revokedAt === null
        && receipt.operation === null && !(await lookupNativeOperation(deps.db, userId, operationId));
    return {
        receipt, instruction: intent.instruction, inputDigest: intent.inputDigest, clientId: intent.clientId,
        decidable: intent.kind === 'create' && receipt.authorization.state === 'required' && offered !== null,
        terms: { offered, bound: intent.terms }, termsDigest: offered ? nativeConsentTermsDigest(offered) : null, revokedAt,
        recoveryTermsDigest: recoverable && intent.terms ? nativeBoundTermsDigest(intent.terms) : null,
    };
}

const MESSAGES: Readonly<Record<string, string>> = {
    native_auth_disabled: 'Native authorization is not available.',
    not_found: 'Not found.',
    unsupported_media_type: 'Expected a form submission.',
    body_too_large: 'The request body is too large.',
    bad_request: 'The request is not a valid decision.',
    intent_changed: 'This request changed since the page was shown. Reload and review it again.',
    terms_changed: 'The terms changed since the page was shown. Reload and review them again.',
    consent_changed: 'This consent is not the one the page showed. Reload and review it again.',
    internal_error: 'Something went wrong on our side.',
};
const refuse = (code: string, status: number) => shellJson({ error: { code, message: MESSAGES[code] ?? MESSAGES.bad_request } }, status);

function internalError(error: unknown): Response {
    const category = error instanceof NativeIntentIntegrityError || error instanceof NativeOperationIntegrityError ? 'integrity'
        : error instanceof PlacementIsolationError ? 'isolation' : 'unexpected';
    console.error('[native-auth] POST /api/native/authorize/[operationId] failed', { category });
    return refuse('internal_error', 500);
}

function seeOther(location: string): Response {
    return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store, no-cache, must-revalidate' } });
}

type Decision =
    | { decision: 'allow' | 'deny'; inputDigest: string; termsDigest: string }
    /** Stop the whole AI consent this page shows (not a cancel of one instruction). */
    | { decision: 'revoke'; inputDigest: string; authorizationId: string };

async function readDecision(req: Request): Promise<Decision | Response> {
    const type = req.headers.get('content-type') ?? '';
    if (!/^application\/x-www-form-urlencoded\s*(?:;\s*charset=utf-8\s*)?$/i.test(type)) return refuse('unsupported_media_type', 415);
    const declared = req.headers.get('content-length');
    if (declared !== null && (!/^\d{1,9}$/.test(declared) || Number(declared) > NATIVE_CONSENT_BODY_MAX_BYTES)) return refuse('body_too_large', 413);
    if (!req.body) return refuse('bad_request', 400);
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > NATIVE_CONSENT_BODY_MAX_BYTES) { void reader.cancel().catch(() => {}); return refuse('body_too_large', 413); }
        chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return refuse('bad_request', 400); }
    const form = new URLSearchParams(text);
    const keys = [...form.keys()].sort();
    const decision = form.get('decision');
    const inputDigest = form.get('inputDigest') ?? '';
    if (!SHA256_DIGEST.test(inputDigest)) return refuse('bad_request', 400);
    if (decision === 'revoke') {
        const authorizationId = form.get('authorizationId') ?? '';
        if (keys.join(',') !== 'authorizationId,decision,inputDigest' || !UUID.test(authorizationId)) return refuse('bad_request', 400);
        return { decision, inputDigest, authorizationId };
    }
    const termsDigest = form.get('termsDigest') ?? '';
    if (keys.join(',') !== 'decision,inputDigest,termsDigest' || (decision !== 'allow' && decision !== 'deny') || !SHA256_DIGEST.test(termsDigest)) {
        return refuse('bad_request', 400);
    }
    return { decision, inputDigest, termsDigest };
}

/** The consent metadata the private host delivery carries, copied field for field from the trusted reader's binding. */
export function sourceAuthorizationOf(binding: NativeConsentBinding): NativeSourceAuthorization {
    return Object.freeze({
        authorizationId: binding.authorizationId, epoch: binding.epoch, authorizationDeadline: binding.authorizationDeadline,
        clientId: binding.clientId, profileId: binding.profileId, policyId: binding.policyId, budgetMicro: binding.budgetMicro,
        initialApprovalAt: binding.initialApprovalAt,
    });
}

/** The broker request an approved intent admits: the server derives the task reference, nothing else. */
export function brokerRequestFor(intent: NativeIntent): NativeOperationRequest {
    if (intent.kind === 'renew') return { kind: 'renew', operationId: intent.operationId, sessionId: intent.sessionId };
    return {
        kind: 'create', operationId: intent.operationId, sessionId: intent.sessionId, computerId: intent.computerId, instructionRevision: 1,
        instructionDigest: intent.instructionDigest!, taskRef: nativeTaskRef(intent.operationId),
    };
}

export async function handleNativeConsentDecision(req: Request, operationId: string, deps: NativeSessionDeps): Promise<Response> {
    try {
        if (!nativeAuthIntentsEnabled(deps.env)) return refuse('native_auth_disabled', 404);
        if (!UUID.test(operationId)) return refuse('not_found', 404);
        const guard = nativeCookieWriteGuard(req, deps.env);
        if (guard) return guard;
        const origin = nativeSessionsOrigin(deps.env)!;
        const page = `${origin}${nativeAuthorizePath(operationId)}`;
        const body = await readDecision(req);
        if (body instanceof Response) return body;

        const supabase = await deps.supabase();
        const id = (await supabase.auth.getUser()).data.user?.id;
        const userId = typeof id === 'string' && UUID.test(id.toLowerCase()) ? id.toLowerCase() : null;
        if (!userId) {
            return seeOther(`${origin}${Routes.LOGIN}?${new URLSearchParams({ [RETURN_URL_PARAM]: nativeAuthorizePath(operationId) })}`);
        }

        const intent = await lookupNativeIntent(deps.db, userId, operationId);
        const view = intent ? await projectNativeIntent(deps.db, intent, deps.now(), origin, nativeCapabilities(deps)) : null;
        if (!intent || !view) return refuse('not_found', 404);
        if (body.inputDigest !== intent.inputDigest) return refuse('intent_changed', 409);
        if (body.decision === 'revoke') {
            // The owner stops the whole consent this page shows: a local terminal tombstone first, so no binding is
            // read and no renewal derives from it again. Existing operations are not touched, resumed or cancelled.
            if (!intent.terms || intent.terms.authzId !== body.authorizationId) return refuse('consent_changed', 409);
            await revokeNativeConsent(deps.db, userId, intent.terms.authzId);
            // Local STOP commits before configuration, 0033 preparation or Gateway send.
            await revokeGatewayAuthorization(deps, userId, intent.terms.authzId);
            return seeOther(page);
        }
        // A renewal is never browser-approved: it derives its session's consent at prepare time, with no browser proof.
        if (intent.kind !== 'create') return seeOther(page);
        // Same-ID recovery: an approved create whose one dispatch never produced an operation (for example the
        // request died between the approval and the claim) may be started again by its owner, under the SAME
        // operation id, body and stored binding. Any existing operation answers with zero effects; nothing slides.
        if (intent.state === 'approved') {
            if (body.decision !== 'allow' || !intent.terms) return seeOther(page);
            if (body.termsDigest !== nativeBoundTermsDigest(intent.terms)) return refuse('terms_changed', 409);
            if (await lookupNativeOperation(deps.db, userId, operationId)) return seeOther(page);
            const blocker = nativeRunBlocker(deps, 'create');
            if (blocker) {
                await blockApprovedNativeIntent(deps.db, userId, operationId, blocker);
                return seeOther(page);
            }
            await dispatchApproved(deps, req, supabase, userId, intent);
            return seeOther(page);
        }
        // Decided (or a reload of a decided page): nothing changes and nothing is dispatched again.
        if (intent.state !== 'required') return seeOther(page);
        if (deps.now() >= intent.expiresAt.getTime()) {
            await decideNativeIntent(deps.db, userId, operationId, 'expired');
            return seeOther(page);
        }
        if (body.decision === 'deny') {
            await decideNativeIntent(deps.db, userId, operationId, 'denied');
            return seeOther(page);
        }
        // The intent was prepared with write scope; nothing else may be dispatched from it.
        if (!intent.scope.split(' ').includes(NATIVE_SCOPE_WRITE)) {
            await decideNativeIntent(deps.db, userId, operationId, 'blocked', 'scope_missing');
            return seeOther(page);
        }

        // Preflight: admitted consent terms, then a deployment that can deliver. Missing either blocks for good,
        // before any proof, exchange or claim.
        const terms = nativeConsentTermsConfig(deps.env);
        const blocker = terms ? nativeRunBlocker(deps, intent.kind) : 'consent_terms_unavailable';
        if (blocker || !terms) {
            await decideNativeIntent(deps.db, userId, operationId, 'blocked', blocker ?? 'consent_terms_unavailable');
            return seeOther(page);
        }
        // The owner approves only the terms the page showed: changed budget, policy, epoch or lifetime is a
        // stale page (no state change); a reload shows the current terms.
        if (body.termsDigest !== nativeConsentTermsDigest(terms)) return refuse('terms_changed', 409);

        const approval = await approveNativeIntent(deps.db, userId, operationId, intent.computerId, intent.inputDigest, terms);
        if (approval.kind === 'refused') {
            // The computer is not deliverable now (checked under the broker's own locks): blocked before any proof or claim.
            await decideNativeIntent(deps.db, userId, operationId, 'blocked', approval.reason);
            return seeOther(page);
        }
        if (approval.kind !== 'approved' || !approval.intent.terms) {
            // Lost the CAS (another tab decided) or the database clock says it expired: settle expiry, never dispatch.
            await decideNativeIntent(deps.db, userId, operationId, 'expired');
            return seeOther(page);
        }
        await dispatchApproved(deps, req, supabase, userId, approval.intent);
        return seeOther(page);
    } catch (error) {
        return internalError(error);
    }
}

/**
 * The one dispatch attempt for an approved create, with this request's own cookie identity and headers. The
 * delivery metadata and approved tuple come from the trusted reader, never from memory; the claim compares the
 * live tuple with the approved one inside its own transaction and arbitrates concurrent attempts atomically.
 */
async function dispatchApproved(deps: NativeSessionDeps, req: Request, supabase: NativeSessionSupabase, userId: string,
    approved: NativeIntent): Promise<void> {
    const { operationId } = approved;
    const key = { ownerUserId: userId, operationId };
    const binding = await readApprovedNativeConsentBinding(deps.db, key);
    if (!binding) {
        // A stopped consent leaves the persisted intent approved (it reads as blocked). Otherwise (the tuple drifted,
        // the owner changed or the deadline passed) this is a definite pre-claim refusal.
        if (!approved.terms || !(await nativeConsentRevokedAt(deps.db, userId, approved.terms.authzId))) {
            await blockApprovedNativeIntent(deps.db, userId, operationId, 'authorization_unavailable');
        }
        return;
    }
    const consentRecheck = async () => (await readApprovedNativeConsentBinding(deps.db, key)) ? 'ok' as const
        : (await nativeConsentRevokedAt(deps.db, userId, binding.authorizationId)) ? 'authorization_revoked' as const : 'authorization_unavailable' as const;
    const result = await runNativeOperation(deps, { userId, supabase, headers: req.headers }, brokerRequestFor(approved),
        { placement: binding.placement, computerId: binding.computerId, sourceAuthorization: sourceAuthorizationOf(binding), consentRecheck, consentOperationId: operationId });
    if (result.kind !== 'operation') {
        // Definite pre-claim refusal. Matches nothing once an operation exists under this key.
        const reason = result.kind === 'blocked' ? result.reason : (result.reason ?? result.code);
        await blockApprovedNativeIntent(deps.db, userId, operationId, NATIVE_AUTHORIZATION_REASONS.has(reason) ? reason : 'dispatch_refused');
    }
}

/** The digest of the terms an approval bound, as the owner's page shows them for a same-ID recovery. */
export function nativeBoundTermsDigest(terms: NativeConsentTerms): string {
    return nativeConsentTermsDigest({ policyId: terms.policyId, epoch: terms.epoch, budgetMicro: terms.budgetMicro,
        ttlSeconds: Math.round((terms.authorizationDeadline.getTime() - terms.initialApprovalAt.getTime()) / 1000) });
}

/** Cleanup only: historical terms revoke after STOP, never authorize a new grant. */
async function revokeGatewayAuthorization(deps: NativeSessionDeps, ownerUserId: string, authorizationId: string): Promise<void> {
    const loaded = deps.nativeAuthorizationConfig ? { state: 'ready' as const, config: deps.nativeAuthorizationConfig }
        : await loadNativeAuthorizationConfig(deps.env, deps.now());
    if (loaded.state !== 'ready') return;
    const revoked = await readNativeConsentRevocation(deps.db, ownerUserId, authorizationId);
    if (!revoked) return;
    const outbox = { config: loaded.config, now: deps.now, fetchImpl: deps.fetch,
        readConsent: async (tx: import('@/server/lib/compute/placement').PlacementExecutor,
            key: { ownerUserId: string; operationId: string }) => (await readNativeConsentHistory(tx, key))?.binding ?? null };
    const operationId = revoked.gatewayRevokeOperationId;
    const prepared = await prepareNativeRevoke(deps.db, outbox, { ownerUserId, operationId,
        consentOperationId: revoked.consentOperationId, authorizationId });
    if (prepared.kind === 'prepared') await dispatchNativeOperationOnce(deps.db, outbox, { ownerUserId, operationId });
}
