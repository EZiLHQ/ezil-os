/**
 * The enrollment refusal log (aws-enroll-log.ts): one bounded line per (computer, error) per
 * minute, from an unauthenticated body, with nothing secret in it.
 */
import { describe, expect, it } from 'vitest';

import { createEnrollRefusalLogger, ENROLL_REFUSAL_LOG_TAG, ENROLL_REFUSAL_LOG_WINDOW_MS, enrollSubject } from './aws-enroll-log';

const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const SIGNATURE = 'MIAGCSqGSIb3DQEHAqCAMIACAQExCzAJBgUrDgMCGgUAMIAGCSqGSIb3DQEHAaCAJIAEggHa';
const DOCUMENT = JSON.stringify({ accountId: '123456789012', instanceId: 'i-0123456789abcdef0', privateIp: '10.0.0.12', region: 'ap-south-1' });
const host = (over: Record<string, unknown> = {}) => ({
    computerId: C1, generation: 2, leaseEpoch: 3, nonce: NONCE, identityDocument: DOCUMENT, signature: SIGNATURE, ...over,
});

function harness(opts: { maxKeys?: number } = {}) {
    let now = 1_000_000;
    const lines: [string, Record<string, unknown>][] = [];
    const log = createEnrollRefusalLogger({ nowMs: () => now, warn: (tag, fields) => lines.push([tag, fields]), ...opts });
    return { log, lines, advance: (ms: number) => { now += ms; } };
}

describe('enrollSubject', () => {
    it('keeps only a UUID computer id (lower-cased) and in-range integer counters', () => {
        expect(enrollSubject(host({ computerId: C1.toUpperCase() }))).toEqual({ computerId: C1, generation: 2, leaseEpoch: 3 });
        for (const computerId of ['x', `${C1} `, `${C1}\n`, 'c'.repeat(36), 7, null, `${'a'.repeat(4096)}`]) {
            expect(enrollSubject(host({ computerId })).computerId).toBeNull();
        }
        for (const v of [0, -1, 1.5, 2147483648, '2', null, Number.NaN]) {
            expect(enrollSubject(host({ generation: v, leaseEpoch: v }))).toMatchObject({ generation: null, leaseEpoch: null });
        }
        for (const raw of [null, undefined, 'text', [C1], 42]) expect(enrollSubject(raw)).toEqual({ computerId: null, generation: null, leaseEpoch: null });
    });
});

describe('createEnrollRefusalLogger', () => {
    it('one line per refusal with the bounded fields, the Worker tunnel diagnosis included; never a 200', () => {
        const h = harness();
        h.log({ status: 200, body: { tunnelToken: 'tunnel-token-xxxxxxxxxxxxxxxx' } }, host());
        h.log({ status: 503, body: { error: 'tunnel_unavailable', retryable: true },
            tunnel: { code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' } }, host());
        h.log({ status: 403, body: { error: 'enroll_nonce_invalid' } }, host({ computerId: C2 }));
        expect(h.lines).toEqual([
            [ENROLL_REFUSAL_LOG_TAG, { status: 503, error: 'tunnel_unavailable', retryable: true, computerId: C1, generation: 2, leaseEpoch: 3,
                tunnel: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'enroll_nonce_invalid', retryable: false, computerId: C2, generation: 2, leaseEpoch: 3 }],
        ]);
    });

    it('rate limit: the first refusal per (computer, error), then at most one per minute with the suppressed count', () => {
        const h = harness();
        const refused = { status: 503, body: { error: 'tunnel_unavailable', retryable: true }, tunnel: { code: 'tunnel_http_502', detail: 'cf_api_403' } };
        h.log(refused, host());
        for (let i = 0; i < 20; i++) { h.advance(2_000); h.log(refused, host()); } // a host retrying every 2 s for 40 s
        expect(h.lines).toHaveLength(1);
        // Another error for the same computer, and the same error for another computer, are their own pairs.
        h.log({ status: 403, body: { error: 'enroll_nonce_expired' } }, host());
        h.log(refused, host({ computerId: C2 }));
        expect(h.lines).toHaveLength(3);
        h.advance(ENROLL_REFUSAL_LOG_WINDOW_MS - 40_000 - 1);
        h.log(refused, host());
        expect(h.lines).toHaveLength(3);
        h.advance(1);
        h.log(refused, host());
        expect(h.lines).toHaveLength(4);
        expect(h.lines[3]![1]).toMatchObject({ computerId: C1, error: 'tunnel_unavailable', suppressed: 21 });
        h.log(refused, host());
        expect(h.lines).toHaveLength(4);
    });

    it('the pair map is bounded: the least recently logged pair is evicted first', () => {
        const h = harness({ maxKeys: 2 });
        const refused = { status: 403, body: { error: 'enroll_refused' } };
        h.log(refused, host({ computerId: C1 }));
        h.log(refused, host({ computerId: C2 }));
        h.log(refused, host({ computerId: C1 }));
        expect(h.lines).toHaveLength(2);
        h.log(refused, host({ computerId: '33333333-3333-4333-8333-333333333333' })); // evicts C1
        h.log(refused, host({ computerId: C2 })); // still limited
        h.log(refused, host({ computerId: C1 })); // a fresh pair again
        expect(h.lines.map(([, f]) => f.computerId)).toEqual([C1, C2, '33333333-3333-4333-8333-333333333333', C1]);
    });

    it('garbage bodies share one pair and free-form codes are replaced, so nothing unbounded is logged', () => {
        const h = harness();
        h.log({ status: 400, body: { error: 'enroll_request_invalid' } }, null);
        h.log({ status: 400, body: { error: 'enroll_request_invalid' } }, { computerId: 'not-a-uuid', nonce: NONCE });
        h.log({ status: 403, body: { error: `Bad ${NONCE}` }, tunnel: { code: 'tunnel_http_502', workerError: 'Not Allowed', detail: `cf ${NONCE}` } }, host());
        expect(h.lines).toEqual([
            [ENROLL_REFUSAL_LOG_TAG, { status: 400, error: 'enroll_request_invalid', retryable: false, computerId: null, generation: null, leaseEpoch: null }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'unknown', retryable: false, computerId: C1, generation: 2, leaseEpoch: 3, tunnel: 'tunnel_http_502' }],
        ]);
    });

    it('never logs the nonce, the identity document, its signature or an address', () => {
        const h = harness();
        for (const error of ['enroll_nonce_invalid', 'identity_signature_mismatch', 'enroll_instance_mismatch', 'tunnel_unavailable']) {
            h.log({ status: 403, body: { error } }, host({ publicIp: '13.0.0.5' }));
        }
        const logged = JSON.stringify(h.lines);
        expect(h.lines).toHaveLength(4);
        for (const secret of [NONCE, SIGNATURE, '123456789012', 'i-0123456789abcdef0', '10.0.0.12', '13.0.0.5']) expect(logged).not.toContain(secret);
    });
});
