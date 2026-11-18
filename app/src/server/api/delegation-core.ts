/**
 * Shared `Authorization: EZiL-Delegation <jws>` verification engine.
 *
 * One implementation of the pinned configuration, ES256 signature, claim set, issuer/audience/client checks,
 * identity mapping, lifetime and the injected one-time `jti` and account lookup. Wrappers own everything about
 * their transport: each derives a strict `binding` ({procedure, serializedInput}) from the actual request it
 * already validated, and passes its own `policy` (procedure → exact scope), a SOURCE constant, never request
 * data. The core never chooses a policy and never retries another one.
 *
 * Imports no database, environment, cookie client or network: all I/O is injected. Order matters and is the
 * same for every wrapper: gate, configuration and binding presence, then every pure check (signature, claims,
 * policy, binding digest, time) before any I/O, then the `jti` claim (shared across ALL policies, so one
 * assertion is accepted once anywhere), then the account. A rejected delegation is never "none": wrappers
 * must not fall back to a cookie.
 *
 * The verified caller's identity comes only from the signature-verified claims and the existing account the
 * lookup returned; nothing is taken from raw HTTP.
 */
import { createHash, webcrypto } from 'node:crypto';

export const DELEGATION_SCHEME = 'EZiL-Delegation';
export const DELEGATION_TYPE = 'ezil-delegation+jwt';
/** `exp = iat + 60` at most. */
export const DELEGATION_MAX_TTL_SECONDS = 60;
/** Tolerated clock difference for an `iat` slightly in the future (MCP Worker vs OS host). */
export const DELEGATION_CLOCK_SKEW_SECONDS = 10;
/** Rotation overlap is old + new key; more than that is a misconfiguration. */
const MAX_PINNED_KEYS = 3;
const MAX_ASSERTION_LENGTH = 4096;

export interface DelegationConfig {
    /** The one trusted presenter: the MCP's public origin. */
    issuer: string;
    /** This OS's own canonical origin, exactly as the MCP signs it. Never derived from the request. */
    audience: string;
    /** OS's own Supabase issuer (`${NEXT_PUBLIC_SUPABASE_URL}/auth/v1`); `sub` is an `auth.users.id` there. */
    supabaseIssuer: string;
    /** EZiL ID's issuer; `sub` is a linked `raw_app_meta_data.auth0_sub`. */
    auth0Issuer: string;
    /** Exact OAuth client ids the MCP may act for. */
    clientIds: ReadonlySet<string>;
    /** Pinned public keys by `kid`. */
    keys: ReadonlyMap<string, webcrypto.CryptoKey>;
}

export interface DelegationEnv {
    EZIL_DELEGATION_ISSUER?: string;
    EZIL_DELEGATION_AUDIENCE?: string;
    EZIL_DELEGATION_PUBLIC_JWKS?: string;
    EZIL_DELEGATION_CLIENT_IDS?: string;
    NEXT_PUBLIC_SUPABASE_URL?: string;
}

/** Which of OS's own issuers vouches for `sub`, and so how it maps to an account. */
export type DelegatedIdentity = { issuer: 'supabase' | 'auth0'; subject: string };

/** The mapped OS account: only what an `auth.users` row proves. */
export interface DelegatedAccount {
    id: string;
    createdAt: string;
}

export type DelegationRejection =
    | 'transport' | 'disabled' | 'not_configured' | 'binding' | 'malformed' | 'header' | 'unknown_key' | 'signature'
    | 'claims' | 'issuer' | 'audience' | 'identity_issuer' | 'client' | 'scope' | 'expired' | 'lifetime'
    | 'not_yet_valid' | 'replayed' | 'replay_store_unavailable' | 'unknown_account';

/** What the wrapper's own validated request asks for. `serializedInput` is digested exactly, never reserialised. */
export interface DelegationCoreBinding {
    procedure: string;
    serializedInput: string;
}

/** The wrapper's fixed policy: each procedure it serves and the one exact scope that procedure requires. */
export interface DelegationPolicy {
    scopeByProcedure: ReadonlyMap<string, string>;
}

/** A verified caller: the mapped OS account plus the exact verified claims that produced it. */
export interface VerifiedDelegatedCaller {
    /** The existing mapped `auth.users.id` (for EZiL ID, not the Auth0 subject). */
    userId: string;
    /** The exact verified `idp_iss`. */
    idpIssuer: string;
    /** The exact verified `sub`. */
    subject: string;
    clientId: string;
    scope: string;
    procedure: string;
    jti: string;
}

export interface DelegationCoreDeps {
    enabled: boolean;
    config: DelegationConfig | undefined;
    /** The request's own procedure and exact input; undefined (no valid request for this wrapper) rejects before I/O. */
    binding: DelegationCoreBinding | undefined;
    policy: DelegationPolicy;
    /** Seconds since the epoch. */
    now: () => number;
    /** Record `jti` until `expiresAt` (epoch seconds): true only for the first use. Throwing rejects. */
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    /** The ONE existing, verified, not deleted/banned account for this identity, else null. */
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
}

export type DelegationCoreOutcome =
    | { kind: 'none' }
    | { kind: 'rejected'; reason: DelegationRejection }
    | { kind: 'accepted'; caller: VerifiedDelegatedCaller; account: DelegatedAccount };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** `<connection>|<id>` (the id may itself contain `|`), at most 255 chars, no whitespace or control characters. */
const AUTH0_SUBJECT = /^(?=.{3,255}$)[^|\s\x00-\x1f\x7f]+\|[^\s\x00-\x1f\x7f]+$/;
const B64URL = /^[A-Za-z0-9_-]+$/;

/** Is this `Authorization` header a delegation attempt (well-formed or not)? */
export const isDelegationHeader = (header: string | null): boolean =>
    header !== null && /^EZiL-Delegation(?:[ \t]|$)/i.test(header.trim());

/** Canonical base64url only: a non-canonical encoding is a different token, so it is refused. */
function decodeSegment(segment: string): Buffer | undefined {
    if (!B64URL.test(segment)) return undefined;
    const bytes = Buffer.from(segment, 'base64url');
    return bytes.toString('base64url') === segment ? bytes : undefined;
}

function parseJsonObject(bytes: Buffer): Record<string, unknown> | undefined {
    try {
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
    } catch {
        return undefined;
    }
}

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
};

const CLAIMS = ['iss', 'aud', 'sub', 'idp_iss', 'client_id', 'scope', 'proc', 'inp', 'jti', 'iat', 'exp'] as const;

/** base64url (unpadded) SHA-256 of the exact input string, as the MCP computes it. */
export const inputDigest = (input: string) => createHash('sha256').update(input, 'utf8').digest('base64url');

/** A bare https origin (no path, query, credentials or trailing slash), else undefined. */
export function bareHttpsOrigin(value: string | undefined): string | undefined {
    if (!value || value !== value.trim()) return undefined;
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && url.origin === value ? value : undefined;
    } catch {
        return undefined;
    }
}

/** `${NEXT_PUBLIC_SUPABASE_URL without trailing slash}/auth/v1`, the same rule the MCP snapshots. */
export function identityIssuerOf(supabaseUrl: string | undefined): string | undefined {
    if (!supabaseUrl) return undefined;
    try {
        const url = new URL(supabaseUrl.trim());
        if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname))) return undefined;
        return `${supabaseUrl.trim().replace(/\/+$/, '')}/auth/v1`;
    } catch {
        return undefined;
    }
}

let cachedConfig: { source: string; config: Promise<DelegationConfig | undefined> } | undefined;

/** The pinned configuration, parsed once per distinct value. Undefined when ANY part is missing or unsafe. */
export function delegationConfig(env: DelegationEnv, auth0Issuer: string): Promise<DelegationConfig | undefined> {
    const source = JSON.stringify([env.EZIL_DELEGATION_ISSUER, env.EZIL_DELEGATION_AUDIENCE, env.EZIL_DELEGATION_PUBLIC_JWKS,
        env.EZIL_DELEGATION_CLIENT_IDS, env.NEXT_PUBLIC_SUPABASE_URL, auth0Issuer]);
    if (cachedConfig?.source !== source) cachedConfig = { source, config: parseDelegationConfig(env, auth0Issuer) };
    return cachedConfig.config;
}

export async function parseDelegationConfig(env: DelegationEnv, auth0Issuer: string): Promise<DelegationConfig | undefined> {
    // Exactly one issuer and audience, each a bare https origin: a list is refused rather than half-trusted.
    const issuer = bareHttpsOrigin(env.EZIL_DELEGATION_ISSUER);
    const audience = bareHttpsOrigin(env.EZIL_DELEGATION_AUDIENCE);
    // Derived, never configured: a free-standing value could name another project's issuer.
    const supabaseIssuer = identityIssuerOf(env.NEXT_PUBLIC_SUPABASE_URL);
    const clientIds = (env.EZIL_DELEGATION_CLIENT_IDS ?? '').split(/[\s,]+/).filter(Boolean);
    if (!issuer || !audience || !supabaseIssuer || !auth0Issuer || supabaseIssuer === auth0Issuer || issuer === audience
        || !clientIds.length || clientIds.some(id => id.length > 512 || id === '*')) return undefined;

    let jwks: unknown;
    try {
        jwks = JSON.parse(env.EZIL_DELEGATION_PUBLIC_JWKS ?? '');
    } catch {
        return undefined;
    }
    if (!jwks || typeof jwks !== 'object' || Array.isArray(jwks) || !hasExactly(jwks as Record<string, unknown>, ['keys'])) return undefined;
    const list = (jwks as { keys: unknown }).keys;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PINNED_KEYS) return undefined;

    const keys = new Map<string, webcrypto.CryptoKey>();
    for (const entry of list as unknown[]) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
        const jwk = entry as Record<string, unknown>;
        // Public members only; a private member (`d`) means a secret was pasted into a public slot.
        const allowed = new Set(['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use']);
        if (Object.keys(jwk).some(key => !allowed.has(key))) return undefined;
        if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') return undefined;
        if (jwk.alg !== undefined && jwk.alg !== 'ES256') return undefined;
        if (jwk.use !== undefined && jwk.use !== 'sig') return undefined;
        const { kid, x, y } = jwk;
        if (typeof kid !== 'string' || !kid || kid.length > 128 || keys.has(kid)) return undefined;
        if (typeof x !== 'string' || typeof y !== 'string') return undefined;
        if (decodeSegment(x)?.length !== 32 || decodeSegment(y)?.length !== 32) return undefined;
        try {
            keys.set(kid, await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x, y },
                { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']));
        } catch {
            return undefined;
        }
    }
    return { issuer, audience, supabaseIssuer, auth0Issuer, clientIds: new Set(clientIds), keys };
}

/** Verify a delegation against the wrapper's own binding and fixed policy. */
export async function verifyDelegation(headers: Headers, deps: DelegationCoreDeps): Promise<DelegationCoreOutcome> {
    const header = headers.get('authorization');
    if (!isDelegationHeader(header)) return { kind: 'none' };
    const reject = (reason: DelegationRejection) => ({ kind: 'rejected', reason }) as const;

    if (!deps.enabled) return reject('disabled');
    const config = deps.config;
    if (!config) return reject('not_configured');
    // The wrapper's validated request first: anything it could not bind never reaches verification or I/O.
    const binding = deps.binding;
    if (!binding) return reject('binding');

    const match = /^EZiL-Delegation[ \t]+([A-Za-z0-9_.-]+)$/i.exec(header!.trim());
    if (!match || match[1]!.length > MAX_ASSERTION_LENGTH) return reject('malformed');
    const parts = match[1]!.split('.');
    if (parts.length !== 3) return reject('malformed');
    const [h, p, s] = parts as [string, string, string];
    const headerBytes = decodeSegment(h);
    const payloadBytes = decodeSegment(p);
    const signature = decodeSegment(s);
    if (!headerBytes || !payloadBytes || !signature) return reject('malformed');

    const jose = parseJsonObject(headerBytes);
    if (!jose || !hasExactly(jose, ['alg', 'typ', 'kid']) || jose.alg !== 'ES256' || jose.typ !== DELEGATION_TYPE
        || typeof jose.kid !== 'string') return reject('header');
    const key = config.keys.get(jose.kid);
    if (!key) return reject('unknown_key');
    // ES256 is raw r||s, 32 bytes each (RFC 7518 §3.4); DER or truncated forms are refused.
    if (signature.length !== 64) return reject('signature');
    const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Uint8Array.from(signature),
        new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return reject('signature');

    const claims = parseJsonObject(payloadBytes);
    if (!claims || !hasExactly(claims, CLAIMS)) return reject('claims');
    const { iss, aud, sub, idp_iss, client_id, scope, proc, inp, jti, iat, exp } = claims;
    if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string' || typeof idp_iss !== 'string'
        || typeof client_id !== 'string' || typeof scope !== 'string' || typeof proc !== 'string' || typeof inp !== 'string'
        || typeof jti !== 'string' || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || !UUID.test(jti)) return reject('claims');
    if (iss !== config.issuer) return reject('issuer');
    if (aud !== config.audience) return reject('audience');
    const identity: DelegatedIdentity | undefined = idp_iss === config.supabaseIssuer ? { issuer: 'supabase', subject: sub }
        : idp_iss === config.auth0Issuer ? { issuer: 'auth0', subject: sub } : undefined;
    if (!identity) return reject('identity_issuer');
    if (!(identity.issuer === 'supabase' ? UUID : AUTH0_SUBJECT).test(sub)) return reject('claims');
    if (!config.clientIds.has(client_id)) return reject('client');
    // Exactly the one scope this wrapper's policy requires for the procedure, then this request's own path and input.
    const required = deps.policy.scopeByProcedure.get(proc);
    if (required === undefined || scope !== required) return reject('scope');
    if (proc !== binding.procedure || inp !== inputDigest(binding.serializedInput)) return reject('binding');

    const now = deps.now();
    const issuedAt = iat as number;
    const expiresAt = exp as number;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > DELEGATION_MAX_TTL_SECONDS) return reject('lifetime');
    if (issuedAt > now + DELEGATION_CLOCK_SKEW_SECONDS) return reject('not_yet_valid');
    if (expiresAt <= now) return reject('expired');

    let first: boolean;
    try {
        first = await deps.consumeJti(jti, expiresAt + DELEGATION_CLOCK_SKEW_SECONDS);
    } catch {
        return reject('replay_store_unavailable');
    }
    if (!first) return reject('replayed');

    let account: DelegatedAccount | null;
    try {
        account = await deps.findAccount(identity);
    } catch {
        account = null;
    }
    if (!account || !UUID.test(account.id) || (identity.issuer === 'supabase' && account.id !== sub)) return reject('unknown_account');

    return {
        kind: 'accepted',
        caller: { userId: account.id, idpIssuer: idp_iss, subject: sub, clientId: client_id, scope, procedure: proc, jti },
        account,
    };
}
