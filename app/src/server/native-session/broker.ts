/**
 * Native Gateway grant broker: exchanges the signed-in owner's current Supabase access token (the proof) for
 * a short EZiL Gateway grant at ONE fixed staging endpoint, using the sealed `ezs_` service credential.
 *
 * Wire (Gateway c9): `POST https://ai-staging.ezil.work/v1/token/exchange`, `Authorization: Bearer ezs_…`,
 * body exactly `{ policyId: <uuid>, proofKind: 'supabase', subjectToken }`; success is `201` with exactly
 * `{ token_type: 'Bearer', access_token: 'ezg_' + 43 base64url, grant_id: <uuid>, expires_at: <RFC 3339> }`,
 * where c9 forwards PostgreSQL's `timestamptz` rendering unchanged (for example `2026-11-16T17:30:00+00:00`).
 *
 * - Sent at most once per call. No retry, redirect (`redirect: 'error'`), cache, fallback endpoint or provider.
 * - Request and response bodies are capped; the whole exchange, body included, has one timeout.
 * - A clean 4xx is a definite refusal. Everything else after send (network error, timeout, redirect, 5xx,
 *   a non-201 2xx or any 201 that fails validation) is `unknown`: a grant may exist, so the caller must
 *   quarantine the operation instead of exchanging again.
 * - The grant must expire after the response is received and at most five minutes after it (c9 stamps expiry
 *   at issuance, after request latency), and never after the absolute caps: the proof's own expiry, the sealed
 *   service credential's expiry and the caller's `notAfter` (the admitted placement lease). An answer later
 *   than the exchange timeout is unknown. c9 accepts no TTL or issued-at field, so the caller refuses before
 *   claiming when the lease cannot hold `nativeGrantCeiling`, which reserves the whole timeout for issuance.
 * - The grant is service and subject scoped, not computer or session scoped: the private host relay must
 *   enforce the bound computer, session, generation, lease and policy on every call itself.
 *
 * Never logs, and never returns, the service credential, the proof or a response body; only the validated
 * grant leaves this module, and its token must stay in memory.
 */

import { readAccessTokenClaims } from '@/server/lib/ai-credential';

export const NATIVE_GATEWAY_EXCHANGE_URL = 'https://ai-staging.ezil.work/v1/token/exchange';
export const NATIVE_GRANT_MAX_TTL_MS = 5 * 60_000;
export const NATIVE_EXCHANGE_TIMEOUT_MS = 8_000;
export const NATIVE_EXCHANGE_REQUEST_MAX_BYTES = 8_192;
export const NATIVE_EXCHANGE_RESPONSE_MAX_BYTES = 4_096;

/** c9 opaque secrets: prefix plus exactly 43 base64url characters (32 random bytes). */
const SERVICE_CREDENTIAL = /^ezs_[A-Za-z0-9_-]{43}$/;
const GRANT_TOKEN = /^ezg_[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339 = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;
const GRANT_KEYS = ['access_token', 'expires_at', 'grant_id', 'token_type'];

/**
 * Strict RFC 3339 date-time with `Z` or an explicit numeric offset (PostgreSQL `timestamptz` JSON renders
 * `+00:00`). Every field is range-checked against the real calendar, so an impossible date such as Feb 30
 * is refused instead of being normalised. Returns the exact instant, or null.
 */
export function parseRfc3339(value: unknown): Date | null {
    if (typeof value !== 'string') return null;
    const m = RFC3339.exec(value);
    if (!m) return null;
    const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    // Years below 100 are refused: Date.UTC would map them to 19xx.
    if (year < 100 || month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
    let offsetMinutes = 0;
    if (!m[8]) {
        const [oh, om] = [Number(m[10]), Number(m[11])];
        if (oh > 23 || om > 59) return null;
        offsetMinutes = (m[9] === '-' ? -1 : 1) * (oh * 60 + om);
    }
    const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
    const local = Date.UTC(year, month - 1, day, hour, minute, second, millis);
    const at = local - offsetMinutes * 60_000;
    return Number.isFinite(at) ? new Date(at) : null;
}

/** The sealed exchange configuration. All three values come from deployment configuration, never a caller. */
export interface NativeExchangeConfig {
    readonly policyId: string;
    readonly serviceCredential: string;
    readonly serviceExpiresAt: Date;
}

/**
 * `EZIL_NATIVE_GATEWAY_POLICY_ID` (UUID), `EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL` (`ezs_` + 43 base64url)
 * and `EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT` (RFC 3339, in the future). Null when any is missing, malformed
 * or expired: the caller reports blocked and sends nothing.
 */
export function nativeExchangeConfig(env: Readonly<Record<string, string | undefined>>, now: number): NativeExchangeConfig | null {
    const policyId = env.EZIL_NATIVE_GATEWAY_POLICY_ID;
    const serviceCredential = env.EZIL_NATIVE_GATEWAY_SERVICE_CREDENTIAL;
    const serviceExpiresAt = parseRfc3339(env.EZIL_NATIVE_GATEWAY_SERVICE_EXPIRES_AT);
    if (typeof policyId !== 'string' || !UUID.test(policyId)) return null;
    if (typeof serviceCredential !== 'string' || !SERVICE_CREDENTIAL.test(serviceCredential)) return null;
    if (!serviceExpiresAt || serviceExpiresAt.getTime() <= now) return null;
    return Object.freeze({ policyId: policyId.toLowerCase(), serviceCredential, serviceExpiresAt });
}

/**
 * The latest expiry c9 can return for an exchange started now: issuance may happen as late as the exchange
 * deadline (`budgetMs`, the full exchange timeout) and then runs its fixed five minutes, capped by the proof
 * and the service credential. c9 takes no TTL or issued-at field, so a lease that ends at or before this
 * cannot hold the grant and must be refused before any claim or exchange. Null when the proof is unreadable
 * or expired.
 */
export function nativeGrantCeiling(config: NativeExchangeConfig, subjectToken: string, now: number,
    budgetMs: number = NATIVE_EXCHANGE_TIMEOUT_MS): Date | null {
    const proof = nativeProofExpiry(subjectToken, now);
    if (!proof || config.serviceExpiresAt.getTime() <= now) return null;
    return new Date(Math.min(now + budgetMs + NATIVE_GRANT_MAX_TTL_MS, proof.getTime(), config.serviceExpiresAt.getTime()));
}

export interface NativeGrant {
    /** In memory only, for the private host relay. Never stored, logged or returned to a browser. */
    readonly accessToken: string;
    readonly grantId: string;
    readonly expiresAt: Date;
}

export type NativeExchangeUnknown = 'gateway_timeout' | 'gateway_unavailable' | 'gateway_invalid_response';

export type NativeExchangeOutcome =
    | { kind: 'granted'; grant: NativeGrant }
    | { kind: 'refused'; status: number }
    | { kind: 'unknown'; reason: NativeExchangeUnknown };

export interface NativeExchangeOptions {
    fetchImpl: typeof fetch;
    now: () => number;
    /** An extra upper bound on the grant's expiry (for example a session deadline). */
    notAfter?: Date;
    timeoutMs?: number;
}

/**
 * Thrown before any send when the caller's inputs cannot produce a valid exchange, judged on the clock at the
 * moment of sending. Nothing reached the Gateway, so it is a definite refusal, never an unknown outcome.
 */
export class NativeExchangePreconditionError extends Error {
    constructor(readonly reason: 'proof_invalid' | 'service_expired' | 'request_too_large' | 'lease_boundary') {
        super(`native_exchange_${reason}`);
        this.name = 'NativeExchangePreconditionError';
    }
}

/** The proof's expiry, or null when it is not a readable, unexpired access token. */
export function nativeProofExpiry(subjectToken: string, now: number): Date | null {
    const claims = readAccessTokenClaims(subjectToken);
    return claims && claims.expiresAt > now ? new Date(claims.expiresAt) : null;
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

/**
 * `received` is the response-receive clock: c9 stamps expiry from its database clock at issuance, after the
 * request's network, auth and database delay, so its fixed five minutes is measured from then, not from the
 * request start. `absolute` holds the immutable caps (proof, service credential, admitted lease).
 */
function parseGrant(text: string, received: number, absolute: number, secrets: readonly string[]): NativeGrant | null {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return null; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value).map(String).sort();
    if (keys.join(',') !== GRANT_KEYS.join(',')) return null;
    const grant = value as Record<string, unknown>;
    if (grant.token_type !== 'Bearer') return null;
    const token = grant.access_token;
    if (typeof token !== 'string' || !GRANT_TOKEN.test(token) || secrets.includes(token)) return null;
    if (typeof grant.grant_id !== 'string' || !UUID.test(grant.grant_id)) return null;
    const expiresAt = parseRfc3339(grant.expires_at);
    const at = expiresAt?.getTime() ?? Number.NaN;
    if (!expiresAt || !Number.isFinite(at) || at <= received || at - received > NATIVE_GRANT_MAX_TTL_MS || at > absolute) return null;
    return Object.freeze({ accessToken: token, grantId: grant.grant_id.toLowerCase(), expiresAt });
}

/** One exchange. Never throws after send; throws `NativeExchangePreconditionError` (nothing sent) before. */
export async function exchangeNativeGrant(
    config: NativeExchangeConfig,
    subjectToken: string,
    options: NativeExchangeOptions,
): Promise<NativeExchangeOutcome> {
    const now = options.now();
    const proofExpiresAt = nativeProofExpiry(subjectToken, now);
    if (!proofExpiresAt) throw new NativeExchangePreconditionError('proof_invalid');
    if (config.serviceExpiresAt.getTime() <= now) throw new NativeExchangePreconditionError('service_expired');
    const body = JSON.stringify({ policyId: config.policyId, proofKind: 'supabase', subjectToken });
    if (new TextEncoder().encode(body).byteLength > NATIVE_EXCHANGE_REQUEST_MAX_BYTES) throw new NativeExchangePreconditionError('request_too_large');
    const absolute = Math.min(proofExpiresAt.getTime(), config.serviceExpiresAt.getTime(), options.notAfter?.getTime() ?? Number.POSITIVE_INFINITY);
    const timeoutMs = options.timeoutMs ?? NATIVE_EXCHANGE_TIMEOUT_MS;
    // Fresh admission on the send-time clock: queueing for the claim or CAS may have used up the lease budget
    // the caller's earlier preflight saw. The latest grant c9 could still issue must fit the admitted lease.
    const ceiling = nativeGrantCeiling(config, subjectToken, now, timeoutMs);
    if (options.notAfter && (!ceiling || ceiling.getTime() >= options.notAfter.getTime())) {
        throw new NativeExchangePreconditionError('lease_boundary');
    }

    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response;
    try {
        response = await options.fetchImpl(NATIVE_GATEWAY_EXCHANGE_URL, {
            method: 'POST',
            redirect: 'error',
            cache: 'no-store',
            credentials: 'omit',
            headers: {
                accept: 'application/json',
                authorization: `Bearer ${config.serviceCredential}`,
                'content-type': 'application/json',
            },
            body,
            signal,
        });
    } catch (error) {
        return { kind: 'unknown', reason: isTimeout(error) ? 'gateway_timeout' : 'gateway_unavailable' };
    }
    if (response.status >= 400 && response.status < 500) {
        void response.body?.cancel().catch(() => {});
        return { kind: 'refused', status: response.status };
    }
    if (response.status !== 201 || !response.body
        || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
        void response.body?.cancel().catch(() => {});
        return { kind: 'unknown', reason: response.status >= 500 ? 'gateway_unavailable' : 'gateway_invalid_response' };
    }
    let text: string | null;
    try { text = await readCapped(response.body, NATIVE_EXCHANGE_RESPONSE_MAX_BYTES); }
    catch (error) { return { kind: 'unknown', reason: isTimeout(error) || signal.aborted ? 'gateway_timeout' : 'gateway_unavailable' }; }
    const received = options.now();
    // The preflight reserved `timeoutMs` of issuance latency; an answer arriving later (an implementation that
    // ignored the abort) falls outside what the lease was admitted for and is never used.
    if (received - now > timeoutMs) return { kind: 'unknown', reason: 'gateway_timeout' };
    const grant = text === null ? null : parseGrant(text, received, absolute, [subjectToken, config.serviceCredential]);
    return grant ? { kind: 'granted', grant } : { kind: 'unknown', reason: 'gateway_invalid_response' };
}
