import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyStripeSignature } from '../stripe/verify';

const secret = 'synthetic-webhook-secret';
const rotatedSecret = 'synthetic-previous-secret';
const rawBody = '{"id":"evt_contract","type":"invoice.paid"}';
const nowMs = Date.parse('2026-10-11T12:00:00.000Z');
const timestamp = Math.floor(nowMs / 1000);

/** Node's HMAC supplies an independent signing oracle, without Stripe or a network call. */
function signature(time = timestamp, body = rawBody, key = secret): string {
    return createHmac('sha256', key).update(`${time}.${body}`).digest('hex');
}

function verify(header: string, body = rawBody, key = secret) {
    return verifyStripeSignature({ rawBody: body, header, secret: key, nowMs });
}

async function validControl() {
    await expect(verify(`t=${timestamp},v1=${signature()}`)).resolves.toBeUndefined();
}

describe('Stripe signature contract', () => {
    it('accepts a valid HMAC over the exact raw body', validControl);

    it('accepts either rotated signature in either candidate order', async () => {
        const current = signature();
        const previous = signature(timestamp, rawBody, rotatedSecret);
        for (const candidates of [[current, previous], [previous, current]]) {
            const header = `t=${timestamp},${candidates.map(value => `v1=${value}`).join(',')}`;
            await expect(verify(header)).resolves.toBeUndefined();
            await expect(verify(header, rawBody, rotatedSecret)).resolves.toBeUndefined();
        }
    });

    it('rejects a changed body or timestamp with a previously valid signature', async () => {
        await validControl();
        await expect(verify(`t=${timestamp},v1=${signature()}`, `${rawBody}\n`)).rejects.toMatchObject({ name: 'WebhookNotVerified' });
        await expect(verify(`t=${timestamp + 1},v1=${signature()}`)).rejects.toMatchObject({ name: 'WebhookNotVerified' });
    });

    it.each([-300, 300])('accepts a correctly signed timestamp at the %i-second boundary', async offset => {
        const time = timestamp + offset;
        await expect(verify(`t=${time},v1=${signature(time)}`)).resolves.toBeUndefined();
    });

    it.each([-301, 301])('rejects a correctly signed timestamp beyond the tolerance (%i seconds)', async offset => {
        await validControl();
        const time = timestamp + offset;
        await expect(verify(`t=${time},v1=${signature(time)}`)).rejects.toMatchObject({ name: 'WebhookNotVerified' });
    });

    it('honours an explicit tolerance on both sides of now', async () => {
        for (const offset of [-10, 10]) {
            const time = timestamp + offset;
            await expect(verifyStripeSignature({ rawBody, header: `t=${time},v1=${signature(time)}`,
                secret, nowMs, toleranceSeconds: 10 })).resolves.toBeUndefined();
        }
        for (const offset of [-11, 11]) {
            const time = timestamp + offset;
            await expect(verifyStripeSignature({ rawBody, header: `t=${time},v1=${signature(time)}`,
                secret, nowMs, toleranceSeconds: 10 })).rejects.toMatchObject({ name: 'WebhookNotVerified' });
        }
    });

    it.each([
        '', 'garbled', `t=${timestamp}`, `v1=${signature()}`, `t=garbled,v1=${signature()}`,
        `t=${timestamp},v1=`, `t=${timestamp},v1=not-hex`, `t=${timestamp},v1=00`,
        `t=${timestamp},v0=${signature()}`, `t=${timestamp},v1=${'0'.repeat(64)}`,
    ])('rejects a missing or garbled signature header: %s', async header => {
        await validControl();
        await expect(verify(header)).rejects.toMatchObject({ name: 'WebhookNotVerified' });
    });
});
