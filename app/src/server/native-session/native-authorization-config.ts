/**
 * Deployment pins for native authorization. All absent is OFF; any present-but-incomplete or invalid set is
 * MISCONFIGURED. Either way the caller refuses before any claim, database write, signature or fetch. Only READY
 * carries a configuration, and nothing here generates, fetches or provisions a key.
 *
 * | Variable | Value |
 * |---|---|
 * | `EZIL_NATIVE_AUTHORIZATION` | exactly `enabled` |
 * | `EZIL_NATIVE_AUTHORIZATION_ISSUER` | the OS signer issuer the Gateway pins, `https://…` |
 * | `EZIL_NATIVE_AUTHORIZATION_AUDIENCE` | the Gateway audience it pins |
 * | `EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID` | the kid the Gateway pins for the public key |
 * | `EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY` | Ed25519 private JWK `{kty:"OKP",crv:"Ed25519",x,d}`, imported non-extractable |
 * | `EZIL_NATIVE_AUTHORIZATION_POLICY_ID` | lowercase UUID of the `ezil-os-native` policy |
 * | `EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL` | that service's `ezs_` credential (not the Supabase broker's) |
 * | `EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT` | its expiry, RFC 3339, in the future |
 * | `EZIL_NATIVE_GRANT_WRAPPING_KEY_ID` | id of the candidate wrapping key |
 * | `EZIL_NATIVE_GRANT_WRAPPING_KEY` | 32 random bytes, base64url, imported non-extractable for AES-256-GCM |
 *
 * The configuration object keeps the service credential in a private field and serialises to non-secret metadata.
 */

import { inspect } from 'node:util';

import { parseRfc3339 } from './broker';
import { nativeGatewayTarget, nativeGatewayTargetForIssuer, type NativeGatewayEnvironment, type NativeGatewayOrigin } from './native-gateway-origin';
import type { NativeWrappingKey } from './native-authorization-candidate';
import {
    base64UrlDecode, ed25519NativeSigner, isNativeIssuer, isNativeKeyId, isNativeUuid,
    nativeSignedBytes, type NativeAssertionSigner,
} from './native-authorization-protocol';

export const NATIVE_AUTHORIZATION_ENV = [
    'EZIL_NATIVE_AUTHORIZATION', 'EZIL_NATIVE_AUTHORIZATION_ISSUER', 'EZIL_NATIVE_AUTHORIZATION_AUDIENCE',
    'EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID', 'EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY', 'EZIL_NATIVE_AUTHORIZATION_POLICY_ID',
    'EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL', 'EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT',
    'EZIL_NATIVE_GRANT_WRAPPING_KEY_ID', 'EZIL_NATIVE_GRANT_WRAPPING_KEY',
] as const;

const SERVICE_CREDENTIAL = /^ezs_[A-Za-z0-9_-]{43}$/;
const ED25519_COORDINATE = /^[A-Za-z0-9_-]{43}$/;

export type NativeAuthorizationMisconfiguration = 'gate' | 'issuer' | 'audience' | 'signing_key' | 'policy' | 'service_credential'
    | 'service_expired' | 'wrapping_key';

export class NativeAuthorizationConfig {
    readonly #serviceCredential: string;
    readonly environment: NativeGatewayEnvironment;
    readonly gatewayOrigin: NativeGatewayOrigin;

    constructor(
        readonly issuer: string,
        readonly audience: string,
        readonly policyId: string,
        serviceCredential: string,
        readonly serviceExpiresAt: Date,
        readonly signer: NativeAssertionSigner,
        readonly wrapping: NativeWrappingKey,
    ) {
        const target = nativeGatewayTargetForIssuer(issuer);
        if (!target || target.gatewayOrigin !== audience) throw new Error('Native Gateway issuer and audience mismatch');
        this.environment = target.environment;
        this.gatewayOrigin = target.gatewayOrigin;
        this.#serviceCredential = serviceCredential;
        Object.freeze(this);
    }

    /** The `Authorization` header for the Gateway, for the exchange module only. */
    serviceAuthorization(): string {
        return `Bearer ${this.#serviceCredential}`;
    }

    /** Values a response must never echo. */
    isServiceCredential(value: string): boolean {
        return value === this.#serviceCredential;
    }

    toJSON(): Record<string, string> {
        return {
            issuer: this.issuer, audience: this.audience, policyId: this.policyId, environment: this.environment,
            serviceExpiresAt: this.serviceExpiresAt.toISOString(), signingKeyId: this.signer.keyId, wrappingKeyId: this.wrapping.keyId,
        };
    }

    [inspect.custom](): string {
        return `NativeAuthorizationConfig ${JSON.stringify(this.toJSON())}`;
    }
}

export type NativeAuthorizationConfigState =
    | { readonly state: 'off' }
    | { readonly state: 'misconfigured'; readonly reason: NativeAuthorizationMisconfiguration }
    | { readonly state: 'ready'; readonly config: NativeAuthorizationConfig };

async function importSigner(keyId: string | undefined, jwkText: string | undefined): Promise<NativeAssertionSigner | null> {
    if (!isNativeKeyId(keyId) || typeof jwkText !== 'string') return null;
    let jwk: unknown;
    try { jwk = JSON.parse(jwkText); } catch { return null; }
    if (!jwk || typeof jwk !== 'object' || Array.isArray(jwk)) return null;
    const { kty, crv, x, d, ...rest } = jwk as Record<string, unknown>;
    // Only the four members: no kid, use, key_ops, alg or anything that could widen the key's purpose.
    if (Object.keys(rest).length > 0 || kty !== 'OKP' || crv !== 'Ed25519' || typeof x !== 'string' || typeof d !== 'string'
        || !ED25519_COORDINATE.test(x) || !ED25519_COORDINATE.test(d) || !base64UrlDecode(x) || !base64UrlDecode(d)) return null;
    try {
        const privateKey = await crypto.subtle.importKey('jwk', { kty, crv, x, d }, { name: 'Ed25519' }, false, ['sign']);
        const publicKey = await crypto.subtle.importKey('jwk', { kty, crv, x }, { name: 'Ed25519' }, false, ['verify']);
        const signer = ed25519NativeSigner(keyId, privateKey);
        // The pinned public half must be the private key's: a mismatched pair would sign what the Gateway refuses.
        const probe = nativeSignedBytes('ezil-native-authorization-config-probe');
        const signature = await signer.sign(probe);
        const valid = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature as Uint8Array<ArrayBuffer>, probe as Uint8Array<ArrayBuffer>);
        return valid ? signer : null;
    } catch {
        return null;
    }
}

async function importWrapping(keyId: string | undefined, keyText: string | undefined): Promise<NativeWrappingKey | null> {
    if (!isNativeKeyId(keyId) || typeof keyText !== 'string') return null;
    const raw = base64UrlDecode(keyText);
    if (!raw || raw.byteLength !== 32) return null;
    try {
        const key = await crypto.subtle.importKey('raw', raw as Uint8Array<ArrayBuffer>, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        return Object.freeze({ keyId, key });
    } catch {
        return null;
    }
}

/** Reads the pins once. Never logs or returns a secret value, and never throws. */
export async function loadNativeAuthorizationConfig(env: Readonly<Record<string, string | undefined>>,
    now: number): Promise<NativeAuthorizationConfigState> {
    if (NATIVE_AUTHORIZATION_ENV.every(name => env[name] === undefined)) return { state: 'off' };
    const fail = (reason: NativeAuthorizationMisconfiguration) => ({ state: 'misconfigured' as const, reason });
    if (env.EZIL_NATIVE_AUTHORIZATION !== 'enabled') return fail('gate');
    const issuer = env.EZIL_NATIVE_AUTHORIZATION_ISSUER;
    const osOrigin = env.EZIL_NATIVE_SESSIONS_ORIGIN;
    const target = nativeGatewayTarget(osOrigin);
    if (!target || !osOrigin || !isNativeIssuer(issuer) ||
        (issuer !== osOrigin && !issuer.startsWith(osOrigin + '/')) ||
        nativeGatewayTargetForIssuer(issuer)?.gatewayOrigin !== target.gatewayOrigin) return fail('issuer');
    const audience = env.EZIL_NATIVE_AUTHORIZATION_AUDIENCE;
    if (audience !== target.gatewayOrigin) return fail('audience');
    const policyId = env.EZIL_NATIVE_AUTHORIZATION_POLICY_ID;
    if (!isNativeUuid(policyId)) return fail('policy');
    const credential = env.EZIL_NATIVE_AUTHORIZATION_SERVICE_CREDENTIAL;
    if (typeof credential !== 'string' || !SERVICE_CREDENTIAL.test(credential)) return fail('service_credential');
    const serviceExpiresAt = parseRfc3339(env.EZIL_NATIVE_AUTHORIZATION_SERVICE_EXPIRES_AT);
    if (!serviceExpiresAt) return fail('service_credential');
    if (serviceExpiresAt.getTime() <= now) return fail('service_expired');
    const signer = await importSigner(env.EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY_ID, env.EZIL_NATIVE_AUTHORIZATION_SIGNING_KEY);
    if (!signer) return fail('signing_key');
    const wrapping = await importWrapping(env.EZIL_NATIVE_GRANT_WRAPPING_KEY_ID, env.EZIL_NATIVE_GRANT_WRAPPING_KEY);
    if (!wrapping) return fail('wrapping_key');
    return { state: 'ready', config: new NativeAuthorizationConfig(issuer, audience, policyId, credential, serviceExpiresAt, signer, wrapping) };
}
