import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const WINDOW_SECONDS = 60;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_NONCES = 10_000;
const NONCE = /^[A-Za-z0-9_-]{16,64}$/;
const SIGNATURE = /^[a-f0-9]{64}$/;
const CONTROL_PATH = /^\/v1\/[a-z][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*$/;

export type ControlHeaders = Record<string, string | string[] | undefined>;
export type SignedControlRequest = {
    method: string;
    path: string;
    body: Uint8Array;
    headers: ControlHeaders;
};
export type AuthResult = { ok: true } | {
    ok: false;
    code: 'invalid_request' | 'stale_request' | 'invalid_signature' | 'replayed_request' | 'replay_capacity';
};

function header(headers: ControlHeaders, name: string): string | undefined {
    const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
    if (matches.length !== 1) return undefined;
    const value = matches[0]?.[1];
    return typeof value === 'string' ? value : undefined;
}

function canonicalBytes(method: string, path: string, timestamp: string, nonce: string, body: Uint8Array): Buffer {
    const bodyDigest = createHash('sha256').update(body).digest('hex');
    return Buffer.from(`ezil-supervisor-v1\n${method}\n${path}\n${timestamp}\n${nonce}\n${bodyDigest}`, 'utf8');
}

/** A bounded in-process replay guard. The host service must also enforce a
 * durable installation generation and idempotency key across restarts. */
export class ControlReplayGuard {
    private readonly seen = new Map<string, number>();

    reserve(nonce: string, validUntilMs: number, nowMs: number): 'ok' | 'replay' | 'full' {
        for (const [key, expiry] of this.seen) {
            if (expiry < nowMs) this.seen.delete(key);
        }
        if (this.seen.has(nonce)) return 'replay';
        if (this.seen.size >= MAX_NONCES) return 'full';
        this.seen.set(nonce, validUntilMs);
        return 'ok';
    }
}

/** The caller obtains the secret from host-only provisioning. It is never an
 * app manifest, database field visible to users, or container environment. */
export function verifyControlRequest(
    request: SignedControlRequest,
    secret: Uint8Array,
    replay: ControlReplayGuard,
    nowMs = Date.now(),
): AuthResult {
    if (secret.length < 32) throw new Error('control_secret_too_short');
    if (request.method !== 'POST' || request.path.length > 128 || !CONTROL_PATH.test(request.path)
        || request.body.byteLength > MAX_BODY_BYTES) {
        return { ok: false, code: 'invalid_request' };
    }
    const timestamp = header(request.headers, 'x-ezil-timestamp');
    const nonce = header(request.headers, 'x-ezil-nonce');
    const signature = header(request.headers, 'x-ezil-signature');
    if (!timestamp || !/^[1-9][0-9]{9}$/.test(timestamp) || !nonce || !NONCE.test(nonce)
        || !signature || !SIGNATURE.test(signature)) {
        return { ok: false, code: 'invalid_request' };
    }
    const sentSeconds = Number(timestamp);
    if (!Number.isFinite(nowMs) || Math.abs(sentSeconds * 1000 - nowMs) > WINDOW_SECONDS * 1000) {
        return { ok: false, code: 'stale_request' };
    }
    const expected = createHmac('sha256', secret)
        .update(canonicalBytes(request.method, request.path, timestamp, nonce, request.body)).digest();
    const supplied = Buffer.from(signature, 'hex');
    if (!timingSafeEqual(expected, supplied)) {
        return { ok: false, code: 'invalid_signature' };
    }
    const reservation = replay.reserve(nonce, (sentSeconds + WINDOW_SECONDS) * 1000, nowMs);
    if (reservation === 'replay') return { ok: false, code: 'replayed_request' };
    if (reservation === 'full') return { ok: false, code: 'replay_capacity' };
    return { ok: true };
}

/** Helper for a narrowly scoped control-plane client; no user-supplied
 * billing, resource IDs, host paths, or application credentials belong here. */
export function signControlRequest(
    method: 'POST',
    path: string,
    body: Uint8Array,
    secret: Uint8Array,
    timestampSeconds = Math.floor(Date.now() / 1000),
    nonce = randomBytes(24).toString('base64url'),
): ControlHeaders {
    if (secret.length < 32) throw new Error('control_secret_too_short');
    if (path.length > 128 || !CONTROL_PATH.test(path) || !NONCE.test(nonce) || body.byteLength > MAX_BODY_BYTES
        || !Number.isSafeInteger(timestampSeconds) || !/^[1-9][0-9]{9}$/.test(String(timestampSeconds))) {
        throw new Error('invalid_control_request');
    }
    const timestamp = String(timestampSeconds);
    const signature = createHmac('sha256', secret)
        .update(canonicalBytes(method, path, timestamp, nonce, body)).digest('hex');
    return {
        'x-ezil-timestamp': timestamp,
        'x-ezil-nonce': nonce,
        'x-ezil-signature': signature,
    };
}
