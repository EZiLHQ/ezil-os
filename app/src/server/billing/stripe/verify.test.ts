import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { verifyStripeSignature, WebhookNotVerified } from './verify';

const rawBody = '{"id":"evt_fixture","message":"billing ✓"}\n';
const secret = 'fixture-only-webhook-secret';
const timestamp = 1_800_000_000;
const nowMs = timestamp * 1000;

// Node's HMAC is an independent oracle for the production WebCrypto port.
function signature(time: number | string = timestamp, key = secret, body = rawBody): string {
    return createHmac('sha256', key).update(`${time}.${body}`).digest('hex');
}

function header(time: number | string = timestamp): string {
    return `t=${time},v1=${signature(time)}`;
}

const valid = { rawBody, secret, nowMs, header: header() };

async function rejects(overrides: Partial<Parameters<typeof verifyStripeSignature>[0]>): Promise<void> {
    await expect(verifyStripeSignature(valid)).resolves.toBeUndefined();
    await expect(verifyStripeSignature({ ...valid, ...overrides })).rejects.toThrow(WebhookNotVerified);
}

describe('verifyStripeSignature', () => {
    it('verifies the original UTF-8 body against an independently signed header', async () => {
        await expect(verifyStripeSignature(valid)).resolves.toBeUndefined();
    });

    it('accepts the second v1 during secret rotation', async () => {
        const previous = signature(timestamp, 'fixture-only-previous-secret');
        await expect(verifyStripeSignature({
            ...valid, header: `t=${timestamp},v1=${previous},v1=${signature()}`,
        })).resolves.toBeUndefined();
        await expect(verifyStripeSignature({
            ...valid, header: `t=${timestamp},v1=${previous}`,
        })).rejects.toThrow(WebhookNotVerified);
    });

    it('keeps a first-candidate match when later candidates differ', async () => {
        await expect(verifyStripeSignature({
            ...valid, header: `${header()},v1=${signature(timestamp, 'fixture-only-other-secret')}`,
        })).resolves.toBeUndefined();
    });

    it('accepts whitespace between components, uppercase hex, and unrelated versions', async () => {
        await expect(verifyStripeSignature({
            ...valid, header: `t=${timestamp}, v0=ignored, v1=${signature().toUpperCase()}`,
        })).resolves.toBeUndefined();
    });

    it('signs the timestamp text exactly as received', async () => {
        await expect(verifyStripeSignature({ ...valid, header: header(`0${timestamp}`) })).resolves.toBeUndefined();
    });

    it('rejects a tampered body, including JSON reserialization', async () => {
        await rejects({ rawBody: JSON.stringify(JSON.parse(rawBody)) });
    });

    it('rejects a tampered timestamp even inside the tolerance window', async () => {
        await rejects({ header: `t=${timestamp + 1},v1=${signature()}` });
    });

    it.each([-1, 1])('enforces the timestamp window in direction %i', async direction => {
        await expect(verifyStripeSignature({
            ...valid, header: header(timestamp + direction * 300),
        })).resolves.toBeUndefined();
        await expect(verifyStripeSignature({
            ...valid, header: header(timestamp + direction * 301),
        })).rejects.toThrow(WebhookNotVerified);
    });

    it('honors a custom tolerance, including zero', async () => {
        await expect(verifyStripeSignature({ ...valid, toleranceSeconds: 0 })).resolves.toBeUndefined();
        await expect(verifyStripeSignature({
            ...valid, toleranceSeconds: 0, header: header(timestamp - 1),
        })).rejects.toThrow(WebhookNotVerified);
        await expect(verifyStripeSignature({
            ...valid, toleranceSeconds: 600, header: header(timestamp - 600),
        })).resolves.toBeUndefined();
        await expect(verifyStripeSignature({
            ...valid, toleranceSeconds: 600, header: header(timestamp - 601),
        })).rejects.toThrow(WebhookNotVerified);
    });

    it.each([
        undefined, null, '', ' ', 'nonsense', `v1=${signature()}`, `t=${timestamp}`,
        `t=${timestamp},v0=${signature()}`, `t=${timestamp},v1=zz`,
        `t=${timestamp},v1=abc`, `t=${timestamp},v1=`, `t=${timestamp},v1=00`,
        `t=${timestamp},v1=${signature()}=extra`, `t=,v1=${signature()}`,
        `t=NaN,v1=${signature()}`, `t=Infinity,v1=${signature()}`,
        `t=1.8e9,v1=${signature()}`, `t=1800000000.5,v1=${signature()}`,
        `t=${timestamp},t=${timestamp},v1=${signature()}`,
        `t=9007199254740992,v1=${signature()}`,
    ])('rejects malformed header %#', async malformed => {
        await rejects({ header: malformed });
    });

    it.each(['', '   '])('refuses an empty secret %#', async empty => {
        await rejects({ secret: empty, header: `t=${timestamp},v1=${signature(timestamp, empty)}` });
    });

    it.each([NaN, Infinity, -1])('rejects an invalid tolerance %s', async toleranceSeconds => {
        await rejects({ toleranceSeconds });
    });

    it.each([NaN, Infinity])('rejects an invalid clock %s', async clock => {
        await rejects({ nowMs: clock });
    });

    it.each([0, 15, 31])('rejects a digest changed at byte %i', async index => {
        const bytes = Buffer.from(signature(), 'hex');
        bytes[index] ^= 1;
        await rejects({ header: `t=${timestamp},v1=${bytes.toString('hex')}` });
    });
});
