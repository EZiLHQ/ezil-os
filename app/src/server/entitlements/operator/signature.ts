/**
 * Product entitlements v1 sender verification (EZIL-AE-V1): every Gateway request is signed with the Gateway's
 * dedicated, least-privilege Ed25519 sender key over
 * "EZIL-AE-V1\n" + METHOD + "\n" + path-with-query + "\n" + unix-seconds + "\n" + hex(sha256(body bytes)).
 *
 * The accepted public keys come only from EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS: JSON {kid: key}, where the key is a
 * public JWK {kty OKP, crv Ed25519, x} or the bare 32-byte key in base64/base64url (Universe's shape). Unset, empty
 * or unreadable configuration is "not configured" (the routes answer 503); a private JWK or a wrong length fails closed.
 */
import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';

export const SENDER_KEYS_ENV = 'EZIL_OS_ADMIN_ENTITLEMENT_SENDER_KEYS';
export const SIGNATURE_DOMAIN = 'EZIL-AE-V1';
export const HEADERS = { kid: 'x-ezil-ae-kid', timestamp: 'x-ezil-ae-timestamp', signature: 'x-ezil-ae-signature' } as const;
export const MAX_SKEW_SECONDS = 300;

const KID = /^[A-Za-z0-9._:-]{1,80}$/;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

function publicKey(value: unknown): KeyObject | null {
    let x: string;
    if (typeof value === 'string') {
        if (!B64.test(value)) return null;
        const raw = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64');
        if (raw.length !== 32) return null;
        x = raw.toString('base64url');
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const jwk = value as Record<string, unknown>;
        // A private key (or anything but a bare public OKP Ed25519 JWK) is refused, never used.
        if (Object.hasOwn(jwk, 'd') || jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519' || typeof jwk.x !== 'string') return null;
        if (!/^[A-Za-z0-9_-]{43}$/.test(jwk.x) || Buffer.from(jwk.x, 'base64url').length !== 32) return null;
        x = jwk.x;
    } else return null;
    try {
        return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
    } catch {
        return null;
    }
}

/** kid → public key. null = not configured (unset, empty, unparseable, or any entry invalid: fail closed). */
export function readSenderKeys(raw: string | undefined): ReadonlyMap<string, KeyObject> | null {
    if (!raw?.trim()) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return null; }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const keys = new Map<string, KeyObject>();
    for (const [kid, value] of Object.entries(parsed)) {
        const key = KID.test(kid) ? publicKey(value) : null;
        if (!key) return null;
        keys.set(kid, key);
    }
    return keys.size > 0 ? keys : null;
}

export function signingInput(method: string, pathWithQuery: string, timestamp: number, body: Uint8Array): Buffer {
    const digest = createHash('sha256').update(body).digest('hex');
    return Buffer.from(`${SIGNATURE_DOMAIN}\n${method}\n${pathWithQuery}\n${timestamp}\n${digest}`);
}

/** The verified sender kid, or null (unknown kid, skew over 300 s, malformed or bad signature). */
export function verifySender(keys: ReadonlyMap<string, KeyObject>, request: { method: string; pathWithQuery: string; headers: Pick<Headers, 'get'>; body: Uint8Array },
    nowSeconds: number): string | null {
    const kid = request.headers.get(HEADERS.kid) ?? '';
    const key = KID.test(kid) ? keys.get(kid) : undefined;
    const ts = Number(request.headers.get(HEADERS.timestamp));
    const sig = request.headers.get(HEADERS.signature) ?? '';
    if (!key || !/^\d{1,12}$/.test(request.headers.get(HEADERS.timestamp) ?? '') || !Number.isSafeInteger(ts)
        || Math.abs(nowSeconds - ts) > MAX_SKEW_SECONDS || !/^[A-Za-z0-9_-]{86}$/.test(sig)) return null;
    try {
        return verify(null, signingInput(request.method.toUpperCase(), request.pathWithQuery, ts, request.body), key, Buffer.from(sig, 'base64url')) ? kid : null;
    } catch {
        return null;
    }
}
