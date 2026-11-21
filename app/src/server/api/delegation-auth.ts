/**
 * `Authorization: EZiL-Delegation <jws>`: the EZiL MCP connector reading one signed-in person's computers.
 *
 * Read-only receiver for exactly two procedures, `computer.list` and `computer.get`, under exactly the scope
 * `ezil:computers:read`, each as one plain GET. The MCP never forwards a user token: per call it signs a
 * short ES256 assertion naming the person (`idp_iss` + `sub`), the OAuth client, the scope, the procedure and
 * a digest of the exact input. This module checks it against keys PINNED in server configuration (never
 * fetched from the presenter) and maps the subject to an EXISTING verified `auth.users` row through one of
 * OS's own identity issuers. It never creates or links an account and never matches by email.
 *
 * Off unless `EZIL_DELEGATED_COMPUTER_READS=enabled`. Off, misconfigured or failing in any way, a presented
 * delegation is REJECTED, never ignored: the caller must not fall back to the session cookie.
 *
 * Free of `@/server/db` and `@/env`, like `bearer-auth.ts`: the replay ledger and the account lookup are
 * injected, so every refusal is unit-testable. Order: request binding and every pure check first (no I/O for
 * junk), then the one-time `jti` (so a failed account lookup still burns it), then the account.
 */
import { createHash, webcrypto } from 'node:crypto';

export const DELEGATION_SCHEME = 'EZiL-Delegation';
export const DELEGATION_TYPE = 'ezil-delegation+jwt';
export const DELEGATED_READ_SCOPE = 'ezil:computers:read';
/** `exp = iat + 60` at most. */
export const DELEGATION_MAX_TTL_SECONDS = 60;
/** Tolerated clock difference for an `iat` slightly in the future (MCP Worker vs OS host). */
export const DELEGATION_CLOCK_SKEW_SECONDS = 10;
/** Rotation overlap is old + new key; more than that is a misconfiguration. */
const MAX_PINNED_KEYS = 3;
const MAX_ASSERTION_LENGTH = 4096;

/** The only procedures a delegated call may reach, each a query. OS owns this list; the MCP's is not trusted. */
export const DELEGATED_READ_PROCEDURES: ReadonlySet<string> = new Set(['computer.list', 'computer.get']);

/** `EZIL_DELEGATED_COMPUTER_READS=enabled` exactly; anything else is off. */
export const delegatedReadsEnabled = (value: string | undefined): boolean => value === 'enabled';

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

/** The request line a delegation is checked against, taken by the one route that accepts delegation. */
export interface DelegationRequest {
    method: string;
    url: string;
    /** Whether the request carries a body (stream, Content-Length > 0 or Transfer-Encoding). */
    hasBody: boolean;
}

/** What the request actually asks for. The assertion's `proc` and `inp` must name exactly this. */
export interface DelegationBinding {
    procedure: string;
    /** The single `input` query parameter, percent-decoded (`URLSearchParams.get`), or '' when absent. */
    input: string;
}

/**
 * The binding of a delegated request, or undefined unless it is exactly one plain read: GET, no body, the
 * literal path `/api/trpc/computer.list` or `/api/trpc/computer.get` (no batch, comma, trailing slash or
 * encoded character), and a query of at most one `input` parameter.
 */
export function delegationBinding(request: DelegationRequest): DelegationBinding | undefined {
    if (request.method !== 'GET' || request.hasBody) return undefined;
    let parsed: URL;
    try {
        parsed = new URL(request.url);
    } catch {
        return undefined;
    }
    const prefix = '/api/trpc/';
    if (!parsed.pathname.startsWith(prefix)) return undefined;
    const procedure = parsed.pathname.slice(prefix.length);
    if (!DELEGATED_READ_PROCEDURES.has(procedure)) return undefined;
    const keys = [...parsed.searchParams.keys()];
    if (keys.length > 1 || keys.some(key => key !== 'input')) return undefined;
    return { procedure, input: parsed.searchParams.get('input') ?? '' };
}

/** A verified, mapped delegated caller. Never contains the assertion itself. */
export interface DelegatedCall {
    jti: string;
    clientId: string;
    /** The OS account the subject mapped to. */
    userId: string;
    /** The one procedure this assertion authorizes (its `proc`, bound to the request). */
    procedure: string;
}

export type DelegationRejection =
    | 'transport' | 'disabled' | 'not_configured' | 'binding' | 'malformed' | 'header' | 'unknown_key' | 'signature'
    | 'claims' | 'issuer' | 'audience' | 'identity_issuer' | 'client' | 'scope' | 'expired' | 'lifetime'
    | 'not_yet_valid' | 'replayed' | 'replay_store_unavailable' | 'unknown_account';

export type DelegationOutcome =
    | { kind: 'none' }
    | { kind: 'rejected'; reason: DelegationRejection }
    | { kind: 'accepted'; call: DelegatedCall; account: DelegatedAccount };

/** The mapped OS account: only what an `auth.users` row proves. */
export interface DelegatedAccount {
    id: string;
    createdAt: string;
}

export interface DelegationDeps {
    enabled: boolean;
    config: DelegationConfig | undefined;
    /** The request's own procedure and input; undefined (not one plain GET read) rejects before any I/O. */
    binding: DelegationBinding | undefined;
    /** Seconds since the epoch. */
    now: () => number;
    /** Record `jti` until `expiresAt` (epoch seconds): true only for the first use. Throwing rejects. */
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    /** The ONE existing, verified, not deleted/banned account for this identity, else null. */
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
}

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

/** base64url (unpadded) SHA-256 of the input string exactly as decoded from the query, as the MCP computes it. */
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

/** Resolve a delegated caller from the `Authorization` header. */
export function authenticateDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    return authenticateBoundDelegation(headers, deps, DELEGATED_READ_SCOPE, DELEGATED_READ_PROCEDURES);
}

const BROWSER_PROCEDURES: ReadonlySet<string> = new Set(['browserSession.observe']);

/** Separately scoped authority for the fixed staging Browser observation route. */
export function authenticateBrowserDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    return authenticateBoundDelegation(headers, deps, 'ezil:browser:read', BROWSER_PROCEDURES);
}

const BROWSER_PAGE_PROCEDURES: ReadonlySet<string> = new Set(['browserSession.readPage']);
const BROWSER_CONTROL_PROCEDURES: ReadonlySet<string> = new Set(['browserSession.control']);

export function authenticateBrowserPageDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    return authenticateBoundDelegation(headers, deps, 'ezil:browser:page:read', BROWSER_PAGE_PROCEDURES);
}

export function authenticateBrowserControlDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    return authenticateBoundDelegation(headers, deps, 'ezil:browser:control', BROWSER_CONTROL_PROCEDURES);
}

const BROWSER_OPEN_PROCEDURES: ReadonlySet<string> = new Set(['browserSession.openUrl']);

/** Separately scoped authority for staging project browser navigation. */
export function authenticateBrowserOpenDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    return authenticateBoundDelegation(headers, deps, 'ezil:browser:navigate', BROWSER_OPEN_PROCEDURES);
}

async function authenticateBoundDelegation(
    headers: Headers, deps: DelegationDeps, allowedScope: string, allowedProcedures: ReadonlySet<string>,
): Promise<DelegationOutcome> {
    const header = headers.get('authorization');
    if (!isDelegationHeader(header)) return { kind: 'none' };
    const reject = (reason: DelegationRejection) => ({ kind: 'rejected', reason }) as const;

    if (!deps.enabled) return reject('disabled');
    const config = deps.config;
    if (!config) return reject('not_configured');
    // Each wrapper binds the exact route and input before verification or I/O.
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
    // The wrapper's closed scope/procedure and the request's own exact input.
    if (scope !== allowedScope || !allowedProcedures.has(proc)) return reject('scope');
    if (proc !== binding.procedure || inp !== inputDigest(binding.input)) return reject('binding');

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

    return { kind: 'accepted', call: { jti, clientId: client_id, userId: account.id, procedure: proc }, account };
}
