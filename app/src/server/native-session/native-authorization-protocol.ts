/**
 * EZiL OS side of the native authorization v1 assertion (`ezil_native_authorization`): the fixed-consent proof the
 * OS signs for the Gateway's native renewal and revoke endpoints. Implemented here from the protocol, not copied
 * from the Gateway.
 *
 *   payload = UTF-8 canonical JSON of the claim: object keys sorted by UTF-16 code unit, no whitespace, strings
 *             exactly as JSON.stringify writes them; base64url without padding
 *   signed  = UTF-8 of `ezil.native-authorization.v1:signature` + "." + payload      (domain separated)
 *   token   = payload + "." + base64url(Ed25519 signature, 64 bytes)
 *
 * The claim is the ENVELOPE (format, alg, keyId, issuer, audience, issuedAt, expiresAt; at most 60 s, refreshed per
 * delivery) plus the SEMANTIC tuple, which is immutable per operationId. The semantic tuple is built only from the
 * trusted approved consent binding, the operation and, for a renewal, the per-operation lease and the token hash.
 * Every value is a string; no field is nullable, derived from another field or invented.
 */

import { createHash } from 'node:crypto';

import { NATIVE_PROFILE_ID } from './host-transport';

import { nativeGatewayTargetForIssuer, type NativeGatewayEnvironment } from './native-gateway-origin';

export const NATIVE_AUTHORIZATION_FORMAT = 'ezil.native-authorization.v1';
export const NATIVE_AUTHORIZATION_PROOF_KIND = 'ezil_native_authorization';
export const NATIVE_AUTHORIZATION_SIGNATURE_DOMAIN = 'ezil.native-authorization.v1:signature';
export const NATIVE_AUTHORIZATION_ALG = 'Ed25519';
/** The Gateway's reserved native service: it accepts only this proof kind. */
export const NATIVE_SERVICE_ID = 'ezil-os-native';
/** Default for existing staging callers; production passes its configured Gateway environment. */
export const NATIVE_AUTHORIZATION_ENVIRONMENT = 'staging';
export type NativeAuthorizationEnvironment = NativeGatewayEnvironment;
export const NATIVE_ASSERTION_MAX_TTL_MS = 60_000;
export const NATIVE_ASSERTION_DEFAULT_TTL_MS = 30_000;
export const NATIVE_ASSERTION_CLOCK_SKEW_MS = 10_000;
export const NATIVE_ASSERTION_MAX_CHARS = 6_000;
export const NATIVE_CONSENT_MAX_MS = 24 * 3_600_000;
/** The signed native lease of one renewal operation. */
export const NATIVE_LEASE_MAX_MS = 5 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DECIMAL = /^[1-9][0-9]{0,18}$/;
const INSTANCE = /^i-[a-f0-9]{8,17}$/;
const CLIENT = /^[\x21-\x7e]{1,256}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISSUER = /^https:\/\/[\x21-\x7e]{1,500}$/;
const BASE64URL = /^[A-Za-z0-9_-]*$/;
// No BigInt literal: the app compiles for ES2017.
const INT8_MAX = BigInt('9223372036854775807');

const BINDING_KEYS = ['authorizationDeadline', 'authorizationId', 'budgetMicro', 'clientId', 'computerId', 'epoch',
    'initialApprovalAt', 'ownerUserId', 'placement', 'policyId', 'profileId', 'serviceId', 'sessionId'];
const PLACEMENT_KEYS = ['fenceToken', 'generation', 'instanceId', 'leaseEpoch'];
const SEMANTIC_KEYS = [...BINDING_KEYS, 'environment', 'operation', 'operationId'].sort();
const RENEW_KEYS = [...SEMANTIC_KEYS, 'leaseExpiresAt', 'tokenSha256'].sort();
const ENVELOPE_KEYS = ['alg', 'audience', 'expiresAt', 'format', 'issuedAt', 'issuer', 'keyId'];

export interface NativePlacementBinding {
    readonly generation: string;
    readonly leaseEpoch: string;
    readonly instanceId: string;
    readonly fenceToken: string;
}

/**
 * The immutable terms of one explicitly approved normal-cookie consent, as the session-visibility owner's
 * `readApprovedNativeConsentBinding` returns them. Rebinding any field needs a new consent and authorizationId.
 */
export interface NativeConsentBinding {
    readonly authorizationId: string;
    /** Canonical positive decimal. */
    readonly epoch: string;
    /** The Supabase `auth.users` id of the owner. */
    readonly ownerUserId: string;
    readonly sessionId: string;
    readonly computerId: string;
    readonly placement: NativePlacementBinding;
    /** The original MCP OAuth client. */
    readonly clientId: string;
    readonly profileId: typeof NATIVE_PROFILE_ID;
    readonly policyId: string;
    readonly serviceId: typeof NATIVE_SERVICE_ID;
    /** Canonical positive decimal, in micro-credits (10^6 per credit), not micro-USD. */
    readonly budgetMicro: string;
    /** UTC ISO-8601 with milliseconds, as `Date.prototype.toISOString` writes it. */
    readonly initialApprovalAt: string;
    /** Fixed at approval; at most 24 hours after `initialApprovalAt`. */
    readonly authorizationDeadline: string;
}

/** Key of the trusted reader: the owner and the auth owner's approved consent operation. */
export interface NativeConsentKey {
    readonly ownerUserId: string;
    readonly operationId: string;
}

export type NativeOperationKind = 'renew' | 'revoke';

interface NativeSemanticBase extends NativeConsentBinding {
    readonly operation: NativeOperationKind;
    readonly operationId: string;
    readonly environment: NativeAuthorizationEnvironment;
}

export interface NativeRevokeSemantic extends NativeSemanticBase {
    readonly operation: 'revoke';
}

export interface NativeRenewSemantic extends NativeSemanticBase {
    readonly operation: 'renew';
    /** The signed native lease of this operation: at most five minutes, fixed in the tuple. */
    readonly leaseExpiresAt: string;
    /** Lowercase hex SHA-256 of the full UTF-8 `ezg_` candidate token. */
    readonly tokenSha256: string;
}

export type NativeSemantic = NativeRenewSemantic | NativeRevokeSemantic;

export interface NativeAssertionSigner {
    readonly keyId: string;
    sign(message: Uint8Array): Promise<Uint8Array>;
}

export interface NativeAssertionEnvelopeOptions {
    readonly issuer: string;
    readonly audience: string;
    readonly nowMs: number;
    readonly ttlMs?: number;
}

export interface NativeAssertion {
    /** The subject token. Not a bearer, but never logged or returned to a browser either. */
    readonly token: string;
    readonly issuedAt: string;
    readonly expiresAt: string;
}

export class NativeAuthorizationProtocolError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NativeAuthorizationProtocolError';
    }
}

/* ------------------------------------------------------------------ shapes */

function isPlain(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
    const own = Reflect.ownKeys(value).map(String).sort();
    const want = [...keys].sort();
    return own.length === want.length && own.every((key, i) => key === want[i]);
}

/** A UTC instant written exactly as `toISOString` writes it (one spelling per instant). */
export function isNativeInstant(value: unknown): value is string {
    if (typeof value !== 'string' || !INSTANT.test(value)) return false;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Canonical positive decimal string, at most PostgreSQL's int8 maximum. */
export function isNativeDecimal(value: unknown): value is string {
    return typeof value === 'string' && DECIMAL.test(value) && BigInt(value) <= INT8_MAX;
}

export function isNativeUuid(value: unknown): value is string {
    return typeof value === 'string' && UUID.test(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
    return typeof value === 'string' && pattern.test(value);
}

function placementValid(value: unknown): value is NativePlacementBinding {
    return isPlain(value) && hasExactKeys(value, PLACEMENT_KEYS) && isNativeUuid(value.fenceToken)
        && isNativeDecimal(value.generation) && matches(value.instanceId, INSTANCE) && isNativeDecimal(value.leaseEpoch);
}

function bindingFieldsValid(value: Record<string, unknown>): boolean {
    for (const key of ['authorizationId', 'ownerUserId', 'sessionId', 'computerId', 'policyId']) {
        if (!isNativeUuid(value[key])) return false;
    }
    if (!isNativeDecimal(value.epoch) || !isNativeDecimal(value.budgetMicro) || !placementValid(value.placement)) return false;
    if (!matches(value.clientId, CLIENT) || value.profileId !== NATIVE_PROFILE_ID || value.serviceId !== NATIVE_SERVICE_ID) return false;
    if (!isNativeInstant(value.initialApprovalAt) || !isNativeInstant(value.authorizationDeadline)) return false;
    const initial = Date.parse(value.initialApprovalAt);
    const deadline = Date.parse(value.authorizationDeadline);
    return deadline > initial && deadline - initial <= NATIVE_CONSENT_MAX_MS;
}

function frozenBinding(value: Record<string, unknown>): NativeConsentBinding {
    const placement = value.placement as NativePlacementBinding;
    return Object.freeze({
        authorizationId: value.authorizationId as string,
        epoch: value.epoch as string,
        ownerUserId: value.ownerUserId as string,
        sessionId: value.sessionId as string,
        computerId: value.computerId as string,
        placement: Object.freeze({
            generation: placement.generation, leaseEpoch: placement.leaseEpoch,
            instanceId: placement.instanceId, fenceToken: placement.fenceToken,
        }),
        clientId: value.clientId as string,
        profileId: NATIVE_PROFILE_ID,
        policyId: value.policyId as string,
        serviceId: NATIVE_SERVICE_ID,
        budgetMicro: value.budgetMicro as string,
        initialApprovalAt: value.initialApprovalAt as string,
        authorizationDeadline: value.authorizationDeadline as string,
    });
}

/**
 * A frozen copy of an approved consent binding, or null unless `value` is exactly the v1 shape: every key present,
 * no extra key, lowercase UUIDs, canonical positive decimals, `toISOString` instants and a deadline at most 24 hours
 * after the initial approval. A row without complete v1 terms is null, never completed with defaults.
 */
export function nativeConsentBinding(value: unknown): NativeConsentBinding | null {
    if (!isPlain(value) || !hasExactKeys(value, BINDING_KEYS) || !bindingFieldsValid(value)) return null;
    return frozenBinding(value);
}

/** True only for an exact renew or revoke semantic tuple. */
export function isNativeSemantic(value: unknown): value is NativeSemantic {
    if (!isPlain(value)) return false;
    const renew = value.operation === 'renew';
    if (!renew && value.operation !== 'revoke') return false;
    if (!hasExactKeys(value, renew ? RENEW_KEYS : SEMANTIC_KEYS)) return false;
    if (!isNativeUuid(value.operationId) || (value.environment !== 'staging' && value.environment !== 'production') || !bindingFieldsValid(value)) return false;
    return !renew || (isNativeInstant(value.leaseExpiresAt) && matches(value.tokenSha256, SHA256_HEX));
}

function bindingPart(binding: NativeConsentBinding): NativeConsentBinding {
    const fields: Record<string, unknown> = {};
    for (const key of BINDING_KEYS) fields[key] = (binding as unknown as Record<string, unknown>)[key];
    const copy = nativeConsentBinding({ ...fields, placement: { ...binding.placement } });
    if (!copy) throw new NativeAuthorizationProtocolError('the consent binding is not a v1 binding');
    return copy;
}

export function nativeRenewSemantic(binding: NativeConsentBinding, operationId: string, leaseExpiresAt: string,
    tokenSha256: string, environment: NativeAuthorizationEnvironment = NATIVE_AUTHORIZATION_ENVIRONMENT): NativeRenewSemantic {
    const semantic = { ...bindingPart(binding), operation: 'renew' as const, operationId, environment,
        leaseExpiresAt, tokenSha256 };
    if (!isNativeSemantic(semantic)) throw new NativeAuthorizationProtocolError('the renew tuple is invalid');
    return semantic;
}

export function nativeRevokeSemantic(binding: NativeConsentBinding, operationId: string,
    environment: NativeAuthorizationEnvironment = NATIVE_AUTHORIZATION_ENVIRONMENT): NativeRevokeSemantic {
    const semantic = { ...bindingPart(binding), operation: 'revoke' as const, operationId, environment };
    if (!isNativeSemantic(semantic)) throw new NativeAuthorizationProtocolError('the revoke tuple is invalid');
    return semantic;
}

/** The consent binding inside a semantic tuple. */
export function nativeSemanticBinding(semantic: NativeSemantic): NativeConsentBinding {
    return bindingPart(semantic);
}

/* ------------------------------------------------------------------ encoding */

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace, strings and numbers as JSON.stringify writes
 * them. Refuses undefined members, non-plain objects and values JSON cannot represent.
 */
export function nativeCanonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(nativeCanonicalJson).join(',')}]`;
    if (value !== null && typeof value === 'object') {
        if (!isPlain(value)) throw new NativeAuthorizationProtocolError('only plain objects are canonical');
        const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (entries.some(([, member]) => member === undefined)) throw new NativeAuthorizationProtocolError('undefined member');
        return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${nativeCanonicalJson(member)}`).join(',')}}`;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) throw new NativeAuthorizationProtocolError('non-finite number');
    const text = JSON.stringify(value);
    if (text === undefined) throw new NativeAuthorizationProtocolError('value has no JSON form');
    return text;
}

/** `sha256:` plus the lowercase hex SHA-256 of the canonical JSON. */
export function nativeCanonicalDigest(value: unknown): string {
    return `sha256:${createHash('sha256').update(nativeCanonicalJson(value), 'utf8').digest('hex')}`;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/** Strict: base64url alphabet only, no padding, and the one encoding that round-trips. */
export function base64UrlDecode(text: string): Uint8Array | null {
    if (!BASE64URL.test(text) || text.length % 4 === 1) return null;
    const bytes = Buffer.from(text, 'base64url');
    return bytes.toString('base64url') === text ? new Uint8Array(bytes) : null;
}

export function nativeSignedBytes(payloadSegment: string): Uint8Array {
    return new TextEncoder().encode(`${NATIVE_AUTHORIZATION_SIGNATURE_DOMAIN}.${payloadSegment}`);
}

/* ------------------------------------------------------------------ signing */

/**
 * Signs `semantic` under a fresh envelope valid from `nowMs` for `ttlMs` (1 to 60 s). Throws, before signing, any
 * claim the Gateway would refuse for its shape or its consent window. Never logs.
 */
export async function signNativeAssertion(signer: NativeAssertionSigner, semantic: NativeSemantic,
    options: NativeAssertionEnvelopeOptions): Promise<NativeAssertion> {
    const ttlMs = options.ttlMs ?? NATIVE_ASSERTION_DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > NATIVE_ASSERTION_MAX_TTL_MS) {
        throw new NativeAuthorizationProtocolError('an assertion lives one to sixty seconds');
    }
    if (!Number.isSafeInteger(options.nowMs)) throw new NativeAuthorizationProtocolError('invalid issue time');
    if (!isNativeSemantic(semantic)) throw new NativeAuthorizationProtocolError('invalid semantic tuple');
    const target = typeof options.issuer === 'string' ? nativeGatewayTargetForIssuer(options.issuer) : null;
    if (!matches(signer.keyId, KEY_ID) || !matches(options.issuer, ISSUER) || !target
        || options.audience !== target.gatewayOrigin || semantic.environment !== target.environment) {
        throw new NativeAuthorizationProtocolError('invalid envelope configuration');
    }
    const issuedAt = new Date(options.nowMs).toISOString();
    const expiresAt = new Date(options.nowMs + ttlMs).toISOString();
    if (Date.parse(semantic.initialApprovalAt) > options.nowMs + NATIVE_ASSERTION_CLOCK_SKEW_MS) {
        throw new NativeAuthorizationProtocolError('the consent is not yet approved at issue time');
    }
    const claim: Record<string, unknown> = {
        ...semantic, placement: { ...semantic.placement },
        format: NATIVE_AUTHORIZATION_FORMAT, alg: NATIVE_AUTHORIZATION_ALG, keyId: signer.keyId,
        issuer: options.issuer, audience: options.audience, issuedAt, expiresAt,
    };
    if (!hasExactKeys(claim, [...(semantic.operation === 'renew' ? RENEW_KEYS : SEMANTIC_KEYS), ...ENVELOPE_KEYS])) {
        throw new NativeAuthorizationProtocolError('claim keys');
    }
    const payload = base64UrlEncode(new TextEncoder().encode(nativeCanonicalJson(claim)));
    const signature = await signer.sign(nativeSignedBytes(payload));
    if (!(signature instanceof Uint8Array) || signature.byteLength !== 64) throw new NativeAuthorizationProtocolError('not an Ed25519 signature');
    const token = `${payload}.${base64UrlEncode(signature)}`;
    if (token.length > NATIVE_ASSERTION_MAX_CHARS) throw new NativeAuthorizationProtocolError('assertion too long');
    return Object.freeze({ token, issuedAt, expiresAt });
}

/** An Ed25519 signer over a non-extractable WebCrypto private key; nothing here can export it. */
export function ed25519NativeSigner(keyId: string, privateKey: CryptoKey): NativeAssertionSigner {
    if (!KEY_ID.test(keyId)) throw new NativeAuthorizationProtocolError('keyId must be an opaque reference');
    return Object.freeze({
        keyId,
        async sign(message: Uint8Array): Promise<Uint8Array> {
            return new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, message as Uint8Array<ArrayBuffer>));
        },
    });
}

export function isNativeKeyId(value: unknown): value is string {
    return matches(value, KEY_ID);
}

export function isNativeIssuer(value: unknown): value is string {
    return matches(value, ISSUER);
}
