/**
 * The native authorization intent contract (root inline v1). Pure: no I/O, no clock, no secrets.
 *
 * Prepare body, exactly one of:
 * - `{kind:"create", operationId, sessionId, computerId, instructionRevision:1, instructionDigest, instruction}`
 * - `{kind:"renew", operationId, sessionId}`
 *
 * Ids are lowercase UUIDs. `instruction` is accepted as its exact UTF-8 bytes: never trimmed or normalised.
 * It must be well-formed Unicode (no lone surrogate, including one written as a JSON `\u` escape), contain
 * a non-whitespace character and no U+0000 (PostgreSQL `text` cannot hold it), and be at most 16384 bytes.
 * `instructionDigest` is `sha256:` + 64 lowercase hex over those bytes and is recomputed here; a mismatch is
 * refused. The whole raw body is at most 65536 UTF-8 bytes. No task reference, path, model, command or
 * Gateway field exists: the server alone derives `native-task:<operationId>`, and only on browser consent.
 *
 * The public digest form is the broker's own (`^sha256:[0-9a-f]{64}$`, migration 0029), so the value passes
 * through unchanged; there is no prefix translation.
 */

import { createHash } from 'node:crypto';

export const NATIVE_INTENT_BODY_MAX_BYTES = 65_536;
export const NATIVE_INSTRUCTION_MAX_BYTES = 16_384;
export const NATIVE_INTENT_TTL_MS = 5 * 60_000;

export const NATIVE_INTENTS_PATH = '/api/mcp/native-auth-intents';
export const NATIVE_SESSIONS_PATH = '/api/mcp/native-sessions';
export const NATIVE_AUTHORIZE_PATH = '/native/authorize';

/** Scopes the native protocol requires, on top of the shared receiver's MCP account scope. */
export const NATIVE_SCOPE_READ = 'ezil:native-sessions:read';
export const NATIVE_SCOPE_WRITE = 'ezil:native-sessions:write';

/**
 * Capabilities of this four-tool protocol. `create` and `renew` report what this deployment can actually
 * deliver right now (see `nativeCapabilities`); nothing beyond create, renew and status exists.
 */
export interface NativeCapabilities {
    create: boolean;
    renew: boolean;
    status: true;
    send: false;
    prompts: false;
    answer: false;
    cancel: false;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ── Finite consent terms ─────────────────────────────────────────────────

/** Literal service and profile a consent binds. */
export const NATIVE_CONSENT_SERVICE = 'ezil-os-native';
export const NATIVE_CONSENT_PROFILE = 'ezil-native-claude-v1';
/** A consent lasts at most 24 hours from the owner's first approval; the challenge itself lasts five minutes. */
export const NATIVE_CONSENT_MAX_TTL_SECONDS = 86_400;
/** Positive canonical decimal: no sign, no leading zero, at most 19 digits. */
export const POSITIVE_DECIMAL = /^[1-9][0-9]{0,18}$/;

/** The admitted terms a new approval binds, all from deployment configuration, never from a caller. */
export interface NativeConsentTermsConfig {
    policyId: string;
    epoch: string;
    /** Microcredits (10^6 per credit), a positive canonical decimal string. */
    budgetMicro: string;
    ttlSeconds: number;
}

/**
 * `EZIL_NATIVE_AUTHORIZATION_POLICY_ID` (UUID), `EZIL_NATIVE_CONSENT_EPOCH` and `EZIL_NATIVE_CONSENT_BUDGET_MICRO`
 * (positive canonical decimals) and `EZIL_NATIVE_CONSENT_TTL_SECONDS` (1..86400). Null when any is missing or
 * malformed: an approval is then blocked before any proof or claim.
 */
export function nativeConsentTermsConfig(env: Readonly<Record<string, string | undefined>>): NativeConsentTermsConfig | null {
    const policyId = env.EZIL_NATIVE_AUTHORIZATION_POLICY_ID?.toLowerCase();
    const epoch = env.EZIL_NATIVE_CONSENT_EPOCH;
    const budgetMicro = env.EZIL_NATIVE_CONSENT_BUDGET_MICRO;
    const ttl = env.EZIL_NATIVE_CONSENT_TTL_SECONDS;
    if (!policyId || !UUID.test(policyId) || !epoch || !POSITIVE_DECIMAL.test(epoch) || !budgetMicro || !POSITIVE_DECIMAL.test(budgetMicro)
        || !ttl || !/^[1-9][0-9]{0,4}$/.test(ttl) || Number(ttl) > NATIVE_CONSENT_MAX_TTL_SECONDS) return null;
    return { policyId, epoch, budgetMicro, ttlSeconds: Number(ttl) };
}

/**
 * sha256 over the canonical offered terms (with the literal service and profile). The consent form carries the
 * digest of the terms it displayed and approval requires it to equal the terms admitted at POST time, so a
 * changed budget, policy, epoch or lifetime can never be approved unseen.
 */
export function nativeConsentTermsDigest(terms: NativeConsentTermsConfig): string {
    const canonical = ['ezil.native-consent-terms.v1', NATIVE_CONSENT_SERVICE, NATIVE_CONSENT_PROFILE, terms.policyId, terms.epoch, terms.budgetMicro,
        String(terms.ttlSeconds)];
    return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}
export const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

export interface NativeCreateIntentInput {
    kind: 'create';
    operationId: string;
    sessionId: string;
    computerId: string;
    instructionRevision: 1;
    instructionDigest: string;
    instruction: string;
}

export interface NativeRenewIntentInput {
    kind: 'renew';
    operationId: string;
    sessionId: string;
}

export type NativeIntentInput = NativeCreateIntentInput | NativeRenewIntentInput;

export type NativeIntentParse =
    | { ok: true; input: NativeIntentInput }
    | { ok: false; code: 'bad_request' | 'instruction_invalid' | 'instruction_too_large' | 'instruction_digest_mismatch' };

const utf8 = new TextEncoder();

export function utf8Bytes(value: string): number {
    return utf8.encode(value).byteLength;
}

/** True when every UTF-16 surrogate is paired. */
export function isWellFormedUnicode(value: string): boolean {
    for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(i + 1);
            if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
            i += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            return false;
        }
    }
    return true;
}

/** `sha256:` + lowercase hex over the exact UTF-8 bytes. Only for well-formed input (lone surrogates would be replaced). */
export function nativeInstructionDigest(instruction: string): string {
    if (!isWellFormedUnicode(instruction)) throw new TypeError('instruction is not well-formed Unicode');
    return `sha256:${createHash('sha256').update(utf8.encode(instruction)).digest('hex')}`;
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
    const own = Reflect.ownKeys(value);
    return own.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** Instruction rules, in order: shape, size, then digest. */
export function checkInstruction(instruction: string): 'instruction_invalid' | 'instruction_too_large' | null {
    if (!isWellFormedUnicode(instruction) || instruction.includes('\u0000') || !/\S/u.test(instruction)) return 'instruction_invalid';
    if (utf8Bytes(instruction) > NATIVE_INSTRUCTION_MAX_BYTES) return 'instruction_too_large';
    return null;
}

export function parseNativeIntentBody(value: unknown): NativeIntentParse {
    const kind = value && typeof value === 'object' ? (value as { kind?: unknown }).kind : undefined;
    if (kind === 'renew') {
        if (!exactKeys(value, ['kind', 'operationId', 'sessionId'])) return { ok: false, code: 'bad_request' };
        const { operationId, sessionId } = value;
        if (!isUuid(operationId) || !isUuid(sessionId)) return { ok: false, code: 'bad_request' };
        return { ok: true, input: { kind: 'renew', operationId, sessionId } };
    }
    if (kind !== 'create'
        || !exactKeys(value, ['kind', 'operationId', 'sessionId', 'computerId', 'instructionRevision', 'instructionDigest', 'instruction'])) {
        return { ok: false, code: 'bad_request' };
    }
    const { operationId, sessionId, computerId, instructionRevision, instructionDigest, instruction } = value;
    if (!isUuid(operationId) || !isUuid(sessionId) || !isUuid(computerId) || instructionRevision !== 1
        || typeof instructionDigest !== 'string' || !SHA256_DIGEST.test(instructionDigest) || typeof instruction !== 'string') {
        return { ok: false, code: 'bad_request' };
    }
    const problem = checkInstruction(instruction);
    if (problem) return { ok: false, code: problem };
    if (nativeInstructionDigest(instruction) !== instructionDigest) return { ok: false, code: 'instruction_digest_mismatch' };
    return { ok: true, input: { kind: 'create', operationId, sessionId, computerId, instructionRevision: 1, instructionDigest, instruction } };
}

/**
 * sha256 over the canonical prepared input. For a create the instruction is bound through its verified
 * digest. The operation id is the key, not part of the digest.
 */
export function nativeIntentInputDigest(input: NativeIntentInput): string {
    const canonical = input.kind === 'create'
        ? ['ezil.native-auth-intent.v1', 'create', input.sessionId, input.computerId, '1', input.instructionDigest]
        : ['ezil.native-auth-intent.v1', 'renew', input.sessionId];
    return `sha256:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

/** The only task reference this feature produces. Fits the broker's `task_ref` rule. */
export function nativeTaskRef(operationId: string): string {
    if (!UUID.test(operationId)) throw new TypeError('invalid operation id');
    return `native-task:${operationId}`;
}

export function nativeAuthorizePath(operationId: string): string {
    if (!UUID.test(operationId)) throw new TypeError('invalid operation id');
    return `${NATIVE_AUTHORIZE_PATH}/${operationId}`;
}

// ── Signed REST input binding ────────────────────────────────────────────

/** The three fixed receiver procedures. Never caller-chosen: derived from the matched route. */
export type NativeProcedure = 'nativeAuthorization.prepare' | 'nativeAuthorization.get' | 'nativeSession.get';

export interface NativeRestRoute {
    procedure: NativeProcedure;
    method: 'GET' | 'POST';
    /** The exact canonical pathname, as signed. */
    pathname: string;
    /** The lowercase UUID path parameter, when the route has one. */
    id: string | null;
}

const UUID_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const INTENT_ITEM = new RegExp(`^${NATIVE_INTENTS_PATH}/(${UUID_SOURCE})$`);
const SESSION_ITEM = new RegExp(`^${NATIVE_SESSIONS_PATH}/(${UUID_SOURCE})$`);

/**
 * Match a raw request URL to exactly one fixed route, or null. Refused: any query or fragment (even an empty
 * `?`), percent-encoding, uppercase or non-canonical UUIDs, trailing slashes, extra segments and any method
 * other than the route's own. The raw string is inspected, never a normalised URL object, so an encoded
 * path cannot match.
 */
export function matchNativeRestRoute(method: string, rawUrl: string): NativeRestRoute | null {
    const schemeEnd = rawUrl.indexOf('://');
    if (schemeEnd < 0) return null;
    const pathStart = rawUrl.indexOf('/', schemeEnd + 3);
    if (pathStart < 0) return null;
    const pathname = rawUrl.slice(pathStart);
    if (/[?#%\\]/.test(pathname)) return null;
    if (method === 'POST' && pathname === NATIVE_INTENTS_PATH) return { procedure: 'nativeAuthorization.prepare', method, pathname, id: null };
    if (method !== 'GET') return null;
    const intent = INTENT_ITEM.exec(pathname);
    if (intent) return { procedure: 'nativeAuthorization.get', method, pathname, id: intent[1]! };
    const session = SESSION_ITEM.exec(pathname);
    if (session) return { procedure: 'nativeSession.get', method, pathname, id: session[1]! };
    return null;
}

/**
 * The exact serialized input handed to the shared receiver core (root correction): the UTF-8 transcript
 * `EZIL-NATIVE-REST/1\n` + METHOD + `\n` + canonical pathname + `\n` + body, with real line feeds, where the
 * body is the exact raw POST text or empty for GET. The receiver signs base64url(SHA-256(transcript)), so a GET
 * is bound to its path and never to the hash of an empty string.
 */
export function nativeRestTranscript(route: Pick<NativeRestRoute, 'method' | 'pathname'>, rawBody: string): string {
    if (route.method === 'GET' && rawBody !== '') throw new TypeError('GET has no body');
    return `EZIL-NATIVE-REST/1\n${route.method}\n${route.pathname}\n${rawBody}`;
}

/** base64url(SHA-256(UTF-8 transcript)): what the signed `inp` claim must equal. For tests and diagnostics. */
export function nativeRestInputHash(transcript: string): string {
    return createHash('sha256').update(utf8.encode(transcript)).digest('base64url');
}
