/**
 * The enrollment refusal log (aws-enroll-log.ts): one bounded line per distinct refusal per
 * minute under a global cap, naming a computer only once its nonce was proven, with nothing
 * secret in it.
 */
import { describe, expect, it } from 'vitest';

import {
    createEnrollRefusalLogger, ENROLL_REFUSAL_LOG_MAX_LINES, ENROLL_REFUSAL_LOG_TAG, ENROLL_REFUSAL_LOG_WINDOW_MS,
    ENROLL_REFUSALS_SUPPRESSED_LOG_TAG, enrollSubject, type EnrollRefusal,
} from './aws-enroll-log';

const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const NONCE = Buffer.alloc(32, 5).toString('base64url');
const proven = (over: Partial<{ computerId: string; generation: number; leaseEpoch: number }> = {}) => ({ computerId: C1, generation: 2, leaseEpoch: 3, ...over });
const ANONYMOUS = { computerId: null, generation: null, leaseEpoch: null };

function harness(opts: { maxKeys?: number; maxLines?: number } = {}) {
    let now = 1_000_000;
    const lines: [string, Record<string, unknown>][] = [];
    const log = createEnrollRefusalLogger({ nowMs: () => now, warn: (tag, fields) => lines.push([tag, fields]), ...opts });
    return { log, lines, advance: (ms: number) => { now += ms; } };
}

describe('enrollSubject', () => {
    it('keeps only a UUID computer id (lower-cased) and in-range integer counters', () => {
        expect(enrollSubject(proven({ computerId: C1.toUpperCase() }))).toEqual({ computerId: C1, generation: 2, leaseEpoch: 3 });
        for (const computerId of ['x', `${C1} `, `${C1}\n`, 'c'.repeat(36), 7, null, `${'a'.repeat(4096)}`]) {
            expect(enrollSubject({ ...proven(), computerId }).computerId).toBeNull();
        }
        for (const v of [0, -1, 1.5, 2147483648, '2', null, Number.NaN]) {
            expect(enrollSubject({ ...proven(), generation: v, leaseEpoch: v })).toMatchObject({ generation: null, leaseEpoch: null });
        }
        for (const raw of [null, undefined, 'text', [C1], 42]) expect(enrollSubject(raw)).toEqual(ANONYMOUS);
    });
});

describe('createEnrollRefusalLogger', () => {
    it('one line per refusal with the bounded fields, the Worker tunnel diagnosis included; never a 200', () => {
        const h = harness();
        h.log({ status: 200, body: { tunnelToken: 'tunnel-token-xxxxxxxxxxxxxxxx' } });
        h.log({ status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject: proven(),
            tunnel: { code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' } });
        h.log({ status: 403, body: { error: 'enroll_instance_mismatch' }, subject: proven({ computerId: C2 }) });
        expect(h.lines).toEqual([
            [ENROLL_REFUSAL_LOG_TAG, { status: 503, error: 'tunnel_unavailable', retryable: true, computerId: C1, generation: 2, leaseEpoch: 3,
                tunnel: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_403' }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'enroll_instance_mismatch', retryable: false, computerId: C2, generation: 2, leaseEpoch: 3 }],
        ]);
    });

    it('rate limit: the first refusal per key, then at most one per minute with the suppressed count', () => {
        const h = harness();
        const refused = { status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject: proven(), tunnel: { code: 'tunnel_http_502', detail: 'cf_api_403' } };
        h.log(refused);
        for (let i = 0; i < 20; i++) { h.advance(2_000); h.log(refused); } // a host retrying every 2 s for 40 s
        expect(h.lines).toHaveLength(1);
        // Another error for the same computer, and the same error for another computer, are their own keys.
        h.log({ status: 403, body: { error: 'enroll_instance_mismatch' }, subject: proven() });
        h.log({ ...refused, subject: proven({ computerId: C2 }) });
        expect(h.lines).toHaveLength(3);
        h.advance(ENROLL_REFUSAL_LOG_WINDOW_MS - 40_000 - 1);
        h.log(refused);
        expect(h.lines).toHaveLength(3);
        h.advance(1);
        h.log(refused);
        expect(h.lines).toHaveLength(4);
        expect(h.lines[3]![1]).toMatchObject({ computerId: C1, error: 'tunnel_unavailable', suppressed: 21 });
        h.log(refused);
        expect(h.lines).toHaveLength(4);
    });

    it('a changed diagnosis inside the window is its own line: status, retryable, epoch and every Worker code are in the key', () => {
        const h = harness();
        const base: EnrollRefusal = { status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject: proven(),
            tunnel: { code: 'tunnel_http_502', workerError: 'tunnel_create_failed', detail: 'cf_api_transport' } };
        const changed: EnrollRefusal[] = [
            { ...base, tunnel: { ...base.tunnel!, detail: 'cf_api_403' } },
            { ...base, tunnel: { ...base.tunnel!, workerError: 'tunnel_fence_failed' } },
            { ...base, tunnel: { ...base.tunnel!, code: 'tunnel_http_503' } },
            // The final answer after the retryable ones (aws-enroll.ts: 502 once the create was answered).
            { ...base, status: 502, body: { error: 'tunnel_unavailable' }, tunnel: { code: 'tunnel_http_409', workerError: 'tunnel_claims_mismatch' } },
            { ...base, body: { error: 'tunnel_unavailable' } },
            { ...base, subject: proven({ leaseEpoch: 4 }) },
            { ...base, subject: proven({ generation: 3 }) },
        ];
        h.log(base);
        for (const r of changed) { h.advance(1_000); h.log(r); }
        expect(h.lines).toHaveLength(1 + changed.length);
        expect(h.lines[4]![1]).toEqual({ status: 502, error: 'tunnel_unavailable', retryable: false, computerId: C1, generation: 2, leaseEpoch: 3,
            tunnel: 'tunnel_http_409', workerError: 'tunnel_claims_mismatch' });
        for (const r of [base, ...changed]) h.log(r); // each again, inside its window
        expect(h.lines).toHaveLength(1 + changed.length);
    });

    it('the key map is bounded: the least recently logged key is evicted first', () => {
        const h = harness({ maxKeys: 2 });
        const refused = (computerId: string) => ({ status: 403, body: { error: 'enroll_refused' }, subject: proven({ computerId }) });
        h.log(refused(C1));
        h.log(refused(C2));
        h.log(refused(C1));
        expect(h.lines).toHaveLength(2);
        h.log(refused('33333333-3333-4333-8333-333333333333')); // evicts C1
        h.log(refused(C2)); // still limited
        h.log(refused(C1)); // a fresh key again
        expect(h.lines.map(([, f]) => f.computerId)).toEqual([C1, C2, '33333333-3333-4333-8333-333333333333', C1]);
    });

    it('without a proven subject a refusal is anonymous: a flood of them is one line per (status, error) per minute', () => {
        const h = harness();
        // Unauthenticated callers (schema-invalid bodies, AWS off, a wrong nonce): nothing they send reaches the logger.
        for (let i = 0; i < 5000; i++) {
            h.log({ status: 400, body: { error: 'enroll_request_invalid' } });
            h.log({ status: 404, body: { error: 'not_found', retryable: true } });
            h.log({ status: 503, body: { error: 'enroll_unavailable', retryable: true } });
        }
        expect(h.lines).toEqual([
            [ENROLL_REFUSAL_LOG_TAG, { status: 400, error: 'enroll_request_invalid', retryable: false, ...ANONYMOUS }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 404, error: 'not_found', retryable: true, ...ANONYMOUS }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 503, error: 'enroll_unavailable', retryable: true, ...ANONYMOUS }],
        ]);
    });

    it('a real host keeps its own key and suppression however many anonymous refusals are interleaved', () => {
        const h = harness();
        const host = { status: 503, body: { error: 'tunnel_unavailable', retryable: true }, subject: proven(), tunnel: { code: 'tunnel_http_502', detail: 'cf_api_403' } };
        for (let retry = 0; retry < 10; retry++) {
            h.log(host);
            for (let i = 0; i < 1100; i++) h.log({ status: 403, body: { error: 'enroll_nonce_invalid' } });
            h.advance(5_000);
        }
        expect(h.lines.map(([, f]) => [f.error, f.computerId])).toEqual([['tunnel_unavailable', C1], ['enroll_nonce_invalid', null]]);
    });

    it('a global cap per window: past it refusals are only counted, and the next window opens with one summary line', () => {
        const h = harness({ maxLines: 3 });
        const refused = (leaseEpoch: number) => ({ status: 403, body: { error: 'enroll_instance_mismatch' }, subject: proven({ leaseEpoch }) });
        for (let e = 1; e <= 10; e++) h.log(refused(e));
        expect(h.lines.map(([, f]) => f.leaseEpoch)).toEqual([1, 2, 3]);
        h.advance(ENROLL_REFUSAL_LOG_WINDOW_MS - 1);
        h.log(refused(11));
        expect(h.lines).toHaveLength(3);
        h.advance(1);
        // The next window: the summary first, then the capped key itself (it was never logged, so it is not limited).
        h.log(refused(4));
        expect(h.lines.slice(3)).toEqual([
            [ENROLL_REFUSALS_SUPPRESSED_LOG_TAG, { suppressed: 8 }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'enroll_instance_mismatch', retryable: false, computerId: C1, generation: 2, leaseEpoch: 4 }],
        ]);
        // A per-key suppression is not a cap: it never adds to the summary.
        h.log(refused(4));
        h.advance(ENROLL_REFUSAL_LOG_WINDOW_MS);
        h.log(refused(1));
        expect(h.lines.slice(5)).toEqual([[ENROLL_REFUSAL_LOG_TAG, expect.objectContaining({ leaseEpoch: 1 })]]);
    });

    it('distinct proven keys past the default cap write exactly the cap per window', () => {
        const h = harness();
        for (let e = 1; e <= ENROLL_REFUSAL_LOG_MAX_LINES * 3; e++) h.log({ status: 403, body: { error: 'enroll_zone_mismatch' }, subject: proven({ leaseEpoch: e }) });
        expect(h.lines).toHaveLength(ENROLL_REFUSAL_LOG_MAX_LINES);
        h.advance(ENROLL_REFUSAL_LOG_WINDOW_MS);
        h.log({ status: 400, body: { error: 'enroll_request_invalid' } });
        expect(h.lines.slice(ENROLL_REFUSAL_LOG_MAX_LINES)).toEqual([
            [ENROLL_REFUSALS_SUPPRESSED_LOG_TAG, { suppressed: ENROLL_REFUSAL_LOG_MAX_LINES * 2 }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 400, error: 'enroll_request_invalid', retryable: false, ...ANONYMOUS }],
        ]);
    });

    it('free-form codes and malformed subjects are replaced, so nothing unbounded is logged', () => {
        const h = harness();
        h.log({ status: 403, body: { error: `Bad ${NONCE}` }, subject: proven(), tunnel: { code: 'tunnel_http_502', workerError: 'Not Allowed', detail: `cf ${NONCE}` } });
        h.log({ status: 403, body: { error: 'enroll_refused' }, subject: { computerId: `not-a-uuid ${NONCE}`, generation: 0, leaseEpoch: 1.5 } });
        expect(h.lines).toEqual([
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'unknown', retryable: false, computerId: C1, generation: 2, leaseEpoch: 3, tunnel: 'tunnel_http_502' }],
            [ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'enroll_refused', retryable: false, ...ANONYMOUS }],
        ]);
    });

    it('never logs a field of the subject beyond its ids (a whole placement passed by mistake)', () => {
        const h = harness();
        const placement = { ...proven(), enrollNonceHash: NONCE, instanceId: 'i-0123456789abcdef0', fenceToken: 'fence-secret', publicIp: '13.0.0.5' };
        h.log({ status: 403, body: { error: 'enroll_instance_mismatch' }, subject: placement });
        expect(h.lines).toEqual([[ENROLL_REFUSAL_LOG_TAG, { status: 403, error: 'enroll_instance_mismatch', retryable: false, ...proven() }]]);
        const logged = JSON.stringify(h.lines);
        for (const secret of [NONCE, 'i-0123456789abcdef0', 'fence-secret', '13.0.0.5']) expect(logged).not.toContain(secret);
    });
});
