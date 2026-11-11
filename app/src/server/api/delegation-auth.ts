/**
 * `Authorization: EZiL-Delegation <jws>` — the EZiL MCP connector acting for one
 * signed-in person, read-only (EZiL MCP CONTRACT.md, "v2 addendum").
 *
 * The MCP never forwards a user token. For each OS call it mints a 60-second
 * ES256 assertion naming the person (`idp_iss` + `sub`), the OAuth client, and
 * the scope that call needs. This module checks that assertion against keys
 * pinned in OS config — it never fetches keys from the presenter — and maps
 * the subject to an EXISTING, verified `auth.users` row through one of OS's
 * OWN identity issuers: its Supabase GoTrue (`sub` is `auth.users.id`) or EZiL
 * ID (`sub` is the Auth0 subject OS's sign-in bridge stored in
 * `app_metadata.auth0_sub`). It never creates an account and never matches by
 * email.
 *
 * Kept free of `@/server/db` and `@/env`, like `bearer-auth.ts`: the replay
 * store and the account lookup are injected, so every refusal is unit-testable.
 *
 * 🔴 Outcomes mirror `userFromBearer`: `none` means no delegation was offered;
 * `rejected` means one WAS offered and failed. A rejected delegation never
 * falls back to the session cookie.
 */
import { createHash, webcrypto } from 'node:crypto';

export const DELEGATION_SCHEME = 'EZiL-Delegation';
export const DELEGATION_TYPE = 'ezil-delegation+jwt';
/** CONTRACT.md v2: `exp = iat + 60`; anything longer is refused. */
export const DELEGATION_MAX_TTL_SECONDS = 60;
/** Tolerated clock difference for an `iat` slightly in the future (MCP Worker vs OS host). */
export const DELEGATION_CLOCK_SKEW_SECONDS = 10;
/** Rotation overlap is old + new key; more than that is a misconfiguration. */
const MAX_PINNED_KEYS = 3;
const MAX_ASSERTION_LENGTH = 4096;

/**
 * Scope → the only tRPC procedures a delegated call may reach, and each one's
 * type. A query travels as one GET, a mutation as one POST (CONTRACT.md v3.0).
 * OS owns this list; the MCP's list is not trusted (CONTRACT.md v2, requirement 3).
 */
export const DELEGATED_PROCEDURES: Readonly<Record<string, Readonly<Record<string, 'query' | 'mutation'>>>> = Object.freeze({
    'ezil:computers:read': Object.freeze({
        'computer.list': 'query', 'computer.get': 'query', 'computer.progress': 'query', 'computer.systemInfo': 'query',
    }),
    // Session controls (EZiL MCP proposals/session-controls.md): starting a computer is its own scope; the model catalog,
    // a session's settings and a control row's stored outcome are session reads; create and configure are session writes.
    'ezil:computers:start': Object.freeze({ 'computer.start': 'mutation' }),
    'ezil:sessions:read': Object.freeze({
        'agentSession.list': 'query', 'agentSession.get': 'query', 'agentSession.events': 'query', 'agentSession.operation': 'query',
        'agentSession.models': 'query', 'agentSession.settings': 'query', 'agentSession.control': 'query',
    }),
    'ezil:sessions:write': Object.freeze({
        'agentSession.send': 'mutation', 'agentSession.cancel': 'mutation',
        'agentSession.create': 'mutation', 'agentSession.configure': 'mutation',
    }),
});

/** The type of an allow-listed procedure, or undefined when no scope names it. */
export function delegatedProcedureType(procedure: string): 'query' | 'mutation' | undefined {
    for (const procedures of Object.values(DELEGATED_PROCEDURES)) {
        if (Object.hasOwn(procedures, procedure)) return procedures[procedure];
    }
    return undefined;
}

/** A delegated write body is small JSON; anything larger is refused before it is parsed. */
export const DELEGATION_MAX_BODY_BYTES = 64 * 1024;

export interface DelegationConfig {
    /** The one trusted presenter: the MCP's public origin. */
    issuer: string;
    /** This OS's own origin, exactly as the MCP signs it. Never derived from the request. */
    audience: string;
    /** OS's own Supabase issuer (`${NEXT_PUBLIC_SUPABASE_URL}/auth/v1`); `sub` is an `auth.users.id` there. */
    supabaseIssuer: string;
    /** EZiL ID's issuer, the one OS's sign-in bridge trusts; `sub` is a linked `app_metadata.auth0_sub`. */
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

/**
 * What the HTTP request actually asks for, taken from the request by the one
 * route that accepts delegation. The assertion's `proc` and `inp` must name
 * exactly this, so a captured assertion cannot be spent on a different call.
 */
export interface DelegationBinding {
    method: 'GET' | 'POST';
    procedure: string;
    /**
     * GET: the single `input` query parameter, percent-decoded (`URLSearchParams.get`), or '' when absent.
     * POST: the body decoded as UTF-8 (informational; `raw` is what is bound).
     */
    input: string;
    /** POST only: the exact body bytes `{"json":<input>}`; `inp` is their digest. */
    raw?: Uint8Array;
}

/** What the route reads from a request before tRPC does. `raw` is only read for a delegated POST, bounded. */
export interface DelegationRequest {
    method: string;
    url: string;
    contentType?: string | null;
    raw?: Uint8Array | null;
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * The binding of a delegated tRPC request, or undefined when it is not exactly
 * one call: one procedure path, no batch, and either a GET with at most an
 * `input` parameter or a POST with no query string, a JSON content type and a
 * body (at most DELEGATION_MAX_BODY_BYTES of valid UTF-8) that is exactly one
 * object whose only member is `json`.
 */
export function delegationBinding(request: DelegationRequest): DelegationBinding | undefined {
    if (request.method !== 'GET' && request.method !== 'POST') return undefined;
    let parsed: URL;
    try {
        parsed = new URL(request.url);
    } catch {
        return undefined;
    }
    const match = /^\/api\/trpc\/([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)$/.exec(parsed.pathname);
    if (!match) return undefined;
    if (request.method === 'GET') {
        const keys = [...parsed.searchParams.keys()];
        if (keys.some((key) => key !== 'input') || keys.length > 1) return undefined;
        return { method: 'GET', procedure: match[1]!, input: parsed.searchParams.get('input') ?? '' };
    }
    const raw = request.raw;
    if (/[?#]/.test(request.url) || !(raw instanceof Uint8Array) || raw.byteLength > DELEGATION_MAX_BODY_BYTES) return undefined;
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test((request.contentType ?? '').trim())) return undefined;
    let body: string;
    let envelope: unknown;
    try {
        body = STRICT_UTF8.decode(raw);
        envelope = JSON.parse(body);
    } catch {
        return undefined;
    }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || !hasExactly(envelope as Record<string, unknown>, ['json'])) {
        return undefined;
    }
    return { method: 'POST', procedure: match[1]!, input: body, raw };
}

/** A verified, mapped delegated caller. Never contains the assertion itself. */
export interface DelegatedCall {
    jti: string;
    clientId: string;
    /** The asserted subject (an `auth.users.id` or an Auth0 subject). */
    sub: string;
    /** The OS account it mapped to. */
    userId: string;
    scopes: readonly string[];
    /** The one procedure this assertion authorizes (its `proc`, bound to the request). */
    procedure: string;
}

export type DelegationRejection =
    | 'transport'
    | 'not_configured'
    | 'malformed'
    | 'header'
    | 'unknown_key'
    | 'signature'
    | 'claims'
    | 'issuer'
    | 'audience'
    | 'identity_issuer'
    | 'client'
    | 'scope'
    | 'binding'
    | 'expired'
    | 'lifetime'
    | 'not_yet_valid'
    | 'replayed'
    | 'replay_store_unavailable'
    | 'unknown_account';

export type DelegationOutcome =
    | { kind: 'none' }
    | { kind: 'rejected'; reason: DelegationRejection; jti?: string; clientId?: string; sub?: string }
    | { kind: 'accepted'; call: DelegatedCall; account: DelegatedAccount };

/** The mapped OS account: only what an `auth.users` row proves. */
export interface DelegatedAccount {
    id: string;
    createdAt: string;
}

export interface DelegationDeps {
    config: DelegationConfig | undefined;
    /** The request's own procedure and input; undefined (not one plain GET call) rejects. */
    binding: DelegationBinding | undefined;
    /** Seconds since the epoch. */
    now: () => number;
    /**
     * Record `jti` until `expiresAt` (epoch seconds). `true` only for the first
     * use; `false` for a replay. Throwing counts as unavailable → rejected.
     */
    consumeJti: (jti: string, expiresAt: number) => Promise<boolean>;
    /** The ONE existing, verified, not deleted/banned account for this identity, else null. */
    findAccount: (identity: DelegatedIdentity) => Promise<DelegatedAccount | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/**
 * An Auth0 subject is `<connection>|<id>`, and the id may itself contain `|`
 * (`samlp|Customer1|123xyz`, `oauth2|provider|id`). It matches the MCP's EZiL ID check
 * (`/^[^|\s]+\|\S+$/`), with OS's own sign-in bound (at most 255 chars) and no
 * control characters. It is only a shape filter: the account is an exact,
 * parameterized match on the stored link.
 */
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
        const value: unknown = JSON.parse(bytes.toString('utf8'));
        return value !== null && typeof value === 'object' && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : undefined;
    } catch {
        return undefined;
    }
}

const hasExactly = (value: Record<string, unknown>, keys: readonly string[]) => {
    const own = Object.keys(value);
    return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
};

const CLAIMS = ['iss', 'aud', 'sub', 'idp_iss', 'client_id', 'scope', 'proc', 'inp', 'jti', 'iat', 'exp'] as const;

/** base64url (unpadded) SHA-256 of the UTF-8 input string, as the MCP's `inputDigest` computes it. */
export const inputDigest = (input: string) => createHash('sha256').update(input, 'utf8').digest('base64url');
/** The same digest over exact bytes: a delegated POST body is bound as received, never re-encoded. */
export const bytesDigest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64url');

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

/**
 * The delegation config, or undefined when ANY part is missing or unsafe:
 * every delegation is then rejected (`not_configured`), and nothing else changes.
 */
export function delegationConfig(env: DelegationEnv, auth0Issuer: string): Promise<DelegationConfig | undefined> {
    const source = JSON.stringify([
        env.EZIL_DELEGATION_ISSUER, env.EZIL_DELEGATION_AUDIENCE, env.EZIL_DELEGATION_PUBLIC_JWKS,
        env.EZIL_DELEGATION_CLIENT_IDS, env.NEXT_PUBLIC_SUPABASE_URL, auth0Issuer,
    ]);
    if (cachedConfig?.source !== source) cachedConfig = { source, config: parseDelegationConfig(env, auth0Issuer) };
    return cachedConfig.config;
}

export async function parseDelegationConfig(env: DelegationEnv, auth0Issuer: string): Promise<DelegationConfig | undefined> {
    // Exactly one issuer: a list (comma/space) is refused rather than half-trusted.
    const issuer = bareHttpsOrigin(env.EZIL_DELEGATION_ISSUER);
    const audience = bareHttpsOrigin(env.EZIL_DELEGATION_AUDIENCE);
    // Derived, never configured: a free-standing value could name another project's
    // issuer and let its user ids resolve to this database's accounts.
    const supabaseIssuer = identityIssuerOf(env.NEXT_PUBLIC_SUPABASE_URL);
    const clientIds = (env.EZIL_DELEGATION_CLIENT_IDS ?? '').split(/[\s,]+/).filter(Boolean);
    if (!issuer || !audience || !supabaseIssuer || !auth0Issuer || supabaseIssuer === auth0Issuer || issuer === audience
        || !clientIds.length) return undefined;
    if (clientIds.some((id) => id.length > 512)) return undefined;

    let jwks: unknown;
    try {
        jwks = JSON.parse(env.EZIL_DELEGATION_PUBLIC_JWKS ?? '');
    } catch {
        return undefined;
    }
    const list = (jwks as { keys?: unknown } | null)?.keys;
    if (!Array.isArray(list) || list.length === 0 || list.length > MAX_PINNED_KEYS) return undefined;

    const keys = new Map<string, webcrypto.CryptoKey>();
    for (const entry of list as unknown[]) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
        const jwk = entry as Record<string, unknown>;
        // Public members only; a private member (`d`) means a secret was pasted into a public slot.
        const allowed = new Set(['kty', 'crv', 'x', 'y', 'kid', 'alg', 'use']);
        if (Object.keys(jwk).some((key) => !allowed.has(key))) return undefined;
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

/** Short, non-reversible id for log correlation; never the assertion or its signature. */
export const assertionFingerprint = (assertion: string) =>
    createHash('sha256').update(assertion).digest('hex').slice(0, 12);

/**
 * Resolve a delegated caller from the `Authorization` header. Order matters:
 * signature and claims first (no I/O for junk), then the one-time `jti`
 * (so a failed account lookup still burns it), then the account.
 */
export async function authenticateDelegation(headers: Headers, deps: DelegationDeps): Promise<DelegationOutcome> {
    const header = headers.get('authorization');
    if (!isDelegationHeader(header)) return { kind: 'none' };
    const reject = (reason: DelegationRejection, seen: { jti?: string; clientId?: string; sub?: string } = {}) =>
        ({ kind: 'rejected', reason, ...seen }) as const;

    const config = deps.config;
    if (!config) return reject('not_configured');

    const match = /^EZiL-Delegation[ \t]+([A-Za-z0-9_.-]+)$/i.exec(header!.trim());
    if (!match || match[1]!.length > MAX_ASSERTION_LENGTH) return reject('malformed');
    const assertion = match[1]!;
    const parts = assertion.split('.');
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
    const valid = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature,
        new TextEncoder().encode(`${h}.${p}`));
    if (!valid) return reject('signature');

    const claims = parseJsonObject(payloadBytes);
    if (!claims || !hasExactly(claims, CLAIMS)) return reject('claims');
    const { iss, aud, sub, idp_iss, client_id, scope, proc, inp, jti, iat, exp } = claims;
    if (typeof iss !== 'string' || typeof aud !== 'string' || typeof sub !== 'string' || typeof idp_iss !== 'string'
        || typeof client_id !== 'string' || typeof scope !== 'string' || typeof proc !== 'string' || typeof inp !== 'string'
        || typeof jti !== 'string'
        || !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return reject('claims');
    if (!UUID.test(jti)) return reject('claims');
    const seen = { jti, clientId: client_id, sub };
    if (iss !== config.issuer) return reject('issuer', seen);
    if (aud !== config.audience) return reject('audience', seen);
    const identity: DelegatedIdentity | undefined = idp_iss === config.supabaseIssuer ? { issuer: 'supabase', subject: sub }
        : idp_iss === config.auth0Issuer ? { issuer: 'auth0', subject: sub } : undefined;
    if (!identity) return reject('identity_issuer', seen);
    if (!(identity.issuer === 'supabase' ? UUID : AUTH0_SUBJECT).test(sub)) return reject('claims', seen);
    if (!config.clientIds.has(client_id)) return reject('client', seen);

    // Exactly the one scope the procedure needs, and the procedure's own method.
    const procedures = Object.hasOwn(DELEGATED_PROCEDURES, scope) ? DELEGATED_PROCEDURES[scope]! : undefined;
    if (!procedures || !Object.hasOwn(procedures, proc)) return reject('scope', seen);
    const scopes = [scope];
    // Bound to this request: the called path, its method and the exact input, or nothing.
    const binding = deps.binding;
    if (!binding || proc !== binding.procedure || binding.method !== (procedures[proc] === 'mutation' ? 'POST' : 'GET')
        || (binding.method === 'POST') !== Boolean(binding.raw)
        || inp !== (binding.raw ? bytesDigest(binding.raw) : inputDigest(binding.input))) return reject('binding', seen);

    const now = deps.now();
    const issuedAt = iat as number;
    const expiresAt = exp as number;
    if (expiresAt <= issuedAt || expiresAt - issuedAt > DELEGATION_MAX_TTL_SECONDS) return reject('lifetime', seen);
    if (issuedAt > now + DELEGATION_CLOCK_SKEW_SECONDS) return reject('not_yet_valid', seen);
    if (expiresAt <= now) return reject('expired', seen);

    let first: boolean;
    try {
        first = await deps.consumeJti(jti, expiresAt + DELEGATION_CLOCK_SKEW_SECONDS);
    } catch {
        return reject('replay_store_unavailable', seen);
    }
    if (!first) return reject('replayed', seen);

    let account: DelegatedAccount | null;
    try {
        account = await deps.findAccount(identity);
    } catch {
        account = null;
    }
    if (!account || !UUID.test(account.id) || (identity.issuer === 'supabase' && account.id !== sub)) {
        return reject('unknown_account', seen);
    }

    return { kind: 'accepted', call: { jti, clientId: client_id, sub, userId: account.id, scopes, procedure: proc }, account };
}
