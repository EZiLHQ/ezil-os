/**
 * One HTTP attempt to the Gateway's native authorization endpoints, at one fixed staging origin.
 *
 * - Renew: `POST https://ai-staging.ezil.work/v1/token/exchange`, `Authorization: Bearer ezs_…` (the native service
 *   credential), body exactly `{policyId, proofKind:"ezil_native_authorization", subjectToken}`. The Gateway answers
 *   `201` for a new grant or `200` for an equal replay, with exactly `{object:"native_authorization_grant", grant_id,
 *   expires_at, authorization_id, epoch, authorization_deadline, budget_micro, replayed}`. There is no access token:
 *   the OS already holds its candidate, and the candidate never travels on this wire.
 * - Revoke: `POST https://ai-staging.ezil.work/v1/token/native-authorization/revoke`, body exactly
 *   `{policyId, subjectToken}`; `200` with exactly `{object:"native_authorization_revocation", authorization_id,
 *   revoked_at, already_revoked}`.
 *
 * Sent once: no retry, redirect (`redirect: 'error'`), cache or fallback. A clean 4xx is a definite refusal: the
 * Gateway's issue and revoke are single transactions that write nothing when they refuse. Everything else after send
 * (network error, timeout, 5xx, another status, a late answer, or any body that fails validation) is UNKNOWN: the
 * operation may have taken effect, so the caller must keep the original operation and candidate and never resend it
 * as a new one. Never logs; never returns a response body or a secret.
 */

import { parseRfc3339 } from './broker';
import type { NativeAuthorizationConfig } from './native-authorization-config';
import {
    NATIVE_AUTHORIZATION_PROOF_KIND, NATIVE_LEASE_MAX_MS, NATIVE_ASSERTION_CLOCK_SKEW_MS, type NativeAssertion,
    type NativeRenewSemantic, type NativeRevokeSemantic,
} from './native-authorization-protocol';

export const NATIVE_GATEWAY_ORIGIN = 'https://ai-staging.ezil.work';
export const NATIVE_RENEW_URL = `${NATIVE_GATEWAY_ORIGIN}/v1/token/exchange`;
export const NATIVE_REVOKE_URL = `${NATIVE_GATEWAY_ORIGIN}/v1/token/native-authorization/revoke`;
export const NATIVE_AUTHORIZATION_TIMEOUT_MS = 8_000;
export const NATIVE_AUTHORIZATION_REQUEST_MAX_BYTES = 12_288;
export const NATIVE_AUTHORIZATION_RESPONSE_MAX_BYTES = 4_096;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANT_KEYS = ['authorization_deadline', 'authorization_id', 'budget_micro', 'epoch', 'expires_at', 'grant_id', 'object', 'replayed'];
const REVOCATION_KEYS = ['already_revoked', 'authorization_id', 'object', 'revoked_at'];

export type NativeUnknownReason = 'gateway_timeout' | 'gateway_unavailable' | 'gateway_invalid_response';

export type NativeRenewOutcome =
    | { readonly kind: 'granted'; readonly grantId: string; readonly expiresAt: Date; readonly replayed: boolean }
    | { readonly kind: 'refused'; readonly status: number }
    | { readonly kind: 'unknown'; readonly reason: NativeUnknownReason };

export type NativeRevokeOutcome =
    | { readonly kind: 'revoked'; readonly revokedAt: Date; readonly alreadyRevoked: boolean }
    | { readonly kind: 'refused'; readonly status: number }
    | { readonly kind: 'unknown'; readonly reason: NativeUnknownReason };

export interface NativeExchangeDeps {
    readonly fetchImpl: typeof fetch;
    readonly now: () => number;
    readonly timeoutMs?: number;
}

/** Thrown before any send: nothing reached the Gateway. */
export class NativeAuthorizationSendError extends Error {
    constructor(readonly reason: 'request_too_large' | 'service_expired') {
        super(`native_authorization_${reason}`);
        this.name = 'NativeAuthorizationSendError';
    }
}

function isTimeout(error: unknown): boolean {
    return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

async function readCapped(body: ReadableStream<Uint8Array>, max: number): Promise<string | null> {
    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > max) { void reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
    }
    const raw = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.byteLength; }
    try { return new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { return null; }
}

function exactObject(text: string, keys: readonly string[]): Record<string, unknown> | null {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const own = Reflect.ownKeys(value).map(String).sort();
    return own.join(',') === [...keys].sort().join(',') ? value as Record<string, unknown> : null;
}

type Answer = { kind: 'body'; status: number; text: string; sentAt: number; received: number }
    | { kind: 'refused'; status: number } | { kind: 'unknown'; reason: NativeUnknownReason };

async function postOnce(url: string, body: Record<string, string>, config: NativeAuthorizationConfig, deps: NativeExchangeDeps,
    successStatuses: readonly number[]): Promise<Answer> {
    const sentAt = deps.now();
    if (config.serviceExpiresAt.getTime() <= sentAt) throw new NativeAuthorizationSendError('service_expired');
    const payload = JSON.stringify(body);
    if (new TextEncoder().encode(payload).byteLength > NATIVE_AUTHORIZATION_REQUEST_MAX_BYTES) throw new NativeAuthorizationSendError('request_too_large');
    const timeoutMs = deps.timeoutMs ?? NATIVE_AUTHORIZATION_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
        response = await deps.fetchImpl(url, {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            credentials: 'omit',
            headers: { accept: 'application/json', authorization: config.serviceAuthorization(), 'content-type': 'application/json' },
            body: payload,
            signal,
        });
    } catch (error) {
        return { kind: 'unknown', reason: isTimeout(error) ? 'gateway_timeout' : 'gateway_unavailable' };
    }
    if (response.status >= 400 && response.status < 500) {
        void response.body?.cancel().catch(() => {});
        return { kind: 'refused', status: response.status };
    }
    if (!successStatuses.includes(response.status) || !response.body
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        return { kind: 'unknown', reason: response.status >= 500 ? 'gateway_unavailable' : 'gateway_invalid_response' };
    }
    let text: string | null;
    try { text = await readCapped(response.body, NATIVE_AUTHORIZATION_RESPONSE_MAX_BYTES); }
    catch (error) { return { kind: 'unknown', reason: isTimeout(error) || signal.aborted ? 'gateway_timeout' : 'gateway_unavailable' }; }
    const received = deps.now();
    // An answer later than the timeout (an implementation that ignored the abort) is never used.
    if (received - sentAt > timeoutMs) return { kind: 'unknown', reason: 'gateway_timeout' };
    if (text === null) return { kind: 'unknown', reason: 'gateway_invalid_response' };
    return { kind: 'body', status: response.status, text, sentAt, received };
}

/**
 * Validates a renew answer against the sealed tuple. Both statuses must bind the authorization id, epoch, budget and
 * deadline exactly, agree with `replayed`, and expire no later than the lease, the deadline and the service
 * credential (the Gateway stores `least` of the three). A new grant (`201`) must also expire after the answer was
 * received and within the five-minute lease of it. An equal replay (`200`) may carry the stored, already expired
 * metadata of the original grant; it is still that grant, and delivery refuses it by its expiry.
 */
function parseRenewal(answer: Extract<Answer, { kind: 'body' }>, semantic: NativeRenewSemantic,
    config: NativeAuthorizationConfig): NativeRenewOutcome {
    const invalid = { kind: 'unknown', reason: 'gateway_invalid_response' } as const;
    const value = exactObject(answer.text, GRANT_KEYS);
    if (!value || value.object !== 'native_authorization_grant' || typeof value.replayed !== 'boolean') return invalid;
    if (value.replayed !== (answer.status === 200)) return invalid;
    if (typeof value.grant_id !== 'string' || !UUID.test(value.grant_id)) return invalid;
    if (value.authorization_id !== semantic.authorizationId || value.epoch !== semantic.epoch || value.budget_micro !== semantic.budgetMicro) return invalid;
    const deadline = parseRfc3339(value.authorization_deadline);
    if (!deadline || deadline.getTime() !== Date.parse(semantic.authorizationDeadline)) return invalid;
    const expiresAt = parseRfc3339(value.expires_at);
    if (!expiresAt) return invalid;
    const at = expiresAt.getTime();
    const ceiling = Math.min(Date.parse(semantic.leaseExpiresAt), deadline.getTime(), config.serviceExpiresAt.getTime());
    if (at > ceiling) return invalid;
    if (!value.replayed && (at <= answer.received || at - answer.received > NATIVE_LEASE_MAX_MS)) return invalid;
    return { kind: 'granted', grantId: value.grant_id, expiresAt, replayed: value.replayed };
}

/** One renewal attempt carrying `assertion` (signed over `semantic`). */
export async function postNativeRenewal(config: NativeAuthorizationConfig, semantic: NativeRenewSemantic, assertion: NativeAssertion,
    deps: NativeExchangeDeps): Promise<NativeRenewOutcome> {
    const answer = await postOnce(NATIVE_RENEW_URL,
        { policyId: config.policyId, proofKind: NATIVE_AUTHORIZATION_PROOF_KIND, subjectToken: assertion.token }, config, deps, [200, 201]);
    return answer.kind === 'body' ? parseRenewal(answer, semantic, config) : answer;
}

/** One revoke attempt carrying `assertion` (signed over `semantic`). */
export async function postNativeRevoke(config: NativeAuthorizationConfig, semantic: NativeRevokeSemantic, assertion: NativeAssertion,
    deps: NativeExchangeDeps): Promise<NativeRevokeOutcome> {
    const answer = await postOnce(NATIVE_REVOKE_URL, { policyId: config.policyId, subjectToken: assertion.token }, config, deps, [200]);
    if (answer.kind !== 'body') return answer;
    const invalid = { kind: 'unknown', reason: 'gateway_invalid_response' } as const;
    const value = exactObject(answer.text, REVOCATION_KEYS);
    if (!value || value.object !== 'native_authorization_revocation' || value.authorization_id !== semantic.authorizationId
        || typeof value.already_revoked !== 'boolean') return invalid;
    const revokedAt = parseRfc3339(value.revoked_at);
    if (!revokedAt || revokedAt.getTime() > answer.received + NATIVE_ASSERTION_CLOCK_SKEW_MS) return invalid;
    return { kind: 'revoked', revokedAt, alreadyRevoked: value.already_revoked };
}
