/**
 * Ported from EZiL Works, apps/api/src/routes/money.ts at ce74e03c
 * (`verifyStripe` and its HMAC helpers). EZiL Works is in the same project
 * family; this port is distributed under EZiL OS's AGPL-3.0-only license.
 *
 * The timestamp belongs inside the MAC so a captured callback cannot be
 * made fresh by editing its header. Every rotation candidate is compared.
 */

export class WebhookNotVerified extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'WebhookNotVerified';
    }
}

interface StripeSignatureInput {
    rawBody: string;
    header: string | null | undefined;
    secret: string;
    nowMs: number;
    toleranceSeconds?: number;
}

const encoder = new TextEncoder();

async function hmacSha256(secret: string, message: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey(
        'raw',
        encoder.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
    );
    return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

/** Digest length is public; matching bytes must never end the loop early. */
function equalInConstantTime(left: Uint8Array, right: Uint8Array): boolean {
    if (left.length !== right.length) return false;

    let difference = 0;
    for (let index = 0; index < left.length; index++) {
        difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
    }
    return difference === 0;
}

function bytesFromHex(hex: string): Uint8Array | null {
    if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;

    const bytes = new Uint8Array(hex.length / 2);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
}

/** The caller supplies the raw body and clock; verification has no I/O. */
export async function verifyStripeSignature({
    rawBody,
    header,
    secret,
    nowMs,
    toleranceSeconds = 300,
}: StripeSignatureInput): Promise<void> {
    if (typeof secret !== 'string' || secret.trim() === '') {
        throw new WebhookNotVerified('the Stripe webhook secret is absent');
    }
    if (typeof header !== 'string' || header.trim() === '') {
        throw new WebhookNotVerified('the Stripe-Signature header is absent');
    }
    if (typeof rawBody !== 'string') {
        throw new WebhookNotVerified('the raw Stripe body must be a string');
    }
    if (!Number.isFinite(nowMs) || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
        throw new WebhookNotVerified('the signature clock or tolerance is invalid');
    }

    let timestamp: string | undefined;
    const candidates: Uint8Array[] = [];
    for (const part of header.split(',')) {
        const component = part.trim();
        const separator = component.indexOf('=');
        const name = component.slice(0, separator);
        const value = component.slice(separator + 1);
        if (name === 't') {
            if (timestamp !== undefined || !/^\d+$/.test(value)) {
                throw new WebhookNotVerified('the Stripe-Signature timestamp is malformed');
            }
            timestamp = value;
        }
        if (name === 'v1') {
            const bytes = bytesFromHex(value);
            if (bytes !== null) candidates.push(bytes);
        }
    }

    if (timestamp === undefined || !Number.isSafeInteger(Number(timestamp)) || candidates.length === 0) {
        throw new WebhookNotVerified('the Stripe-Signature header is malformed');
    }
    if (Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) > toleranceSeconds) {
        throw new WebhookNotVerified('its timestamp is outside the accepted window');
    }

    const expected = await hmacSha256(secret, `${timestamp}.${rawBody}`);
    let verified = false;
    // Do not use `some`, `find`, or an early return: later candidates must be
    // compared even when the first one matches during a secret rotation.
    for (const candidate of candidates) {
        if (equalInConstantTime(expected, candidate)) verified = true;
    }
    if (!verified) throw new WebhookNotVerified('the signature does not match the body');
}
