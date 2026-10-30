import { describe, expect, it, vi } from 'vitest';
import { expiredCapacityAttemptId, readCapacityResetReply, retryAfterCapacityExpiry, type CapacityRetryResult } from './capacity-retry';

const ATTEMPT = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
const expired = { ok: false, errorCode: 'capacity_attempt_expired', capacityAttemptId: ATTEMPT };

describe('React canvas Retry after capacity_attempt_expired (RETRY-118)', () => {
    it('resets exactly the stored attempt once, THEN reloads once; a second click while in flight joins', async () => {
        let release!: () => void;
        const reset = vi.fn(() => new Promise<unknown>((r) => { release = () => r({ ok: true, outcome: 'reset', provider: 'cloudflare-guacamole' }); }));
        const reload = vi.fn();
        const inFlight = { current: null as Promise<CapacityRetryResult> | null };
        const first = retryAfterCapacityExpiry({ computerId: 'c-1', failure: expired, reset, reload, inFlight });
        const second = retryAfterCapacityExpiry({ computerId: 'c-1', failure: expired, reset, reload, inFlight });
        expect(reset).toHaveBeenCalledExactlyOnceWith({ computerId: 'c-1', attemptId: ATTEMPT });
        expect(reload).not.toHaveBeenCalled();
        release();
        expect(await Promise.all([first, second])).toEqual([{ reset: true, outcome: 'reset' }, { reset: true, outcome: 'reset' }]);
        expect(reload).toHaveBeenCalledOnce();
        expect(inFlight.current).toBeNull();
    });
    it('a failed reset still reloads (the next answer is the truth) and says so', async () => {
        const reload = vi.fn();
        expect(await retryAfterCapacityExpiry({ computerId: 'c-1', failure: expired, reset: vi.fn(async () => { throw new Error('offline'); }),
            reload, inFlight: { current: null } })).toEqual({ reset: false, errorCode: 'request_failed' });
        expect(reload).toHaveBeenCalledOnce();
    });
    it.each([
        [{ ok: true, outcome: 'reset' }, { reset: true, outcome: 'reset' }],
        [{ ok: true, outcome: 'already_reset' }, { reset: false, outcome: 'already_reset' }],
        [{ ok: true, outcome: 'superseded' }, { reset: false, outcome: 'superseded' }],
        [{ ok: false, outcome: 'not_found' }, { reset: false, outcome: 'not_found' }],
        // Malformed: an app-level failure claiming reset, an inconsistent ok, unknown/missing outcomes, non-objects.
        [{ ok: false, outcome: 'reset' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'not_found' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: 'true', outcome: 'reset' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'done' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true, outcome: 'toString' }, { reset: false, errorCode: 'malformed_reply' }],
        [{ ok: true }, { reset: false, errorCode: 'malformed_reply' }],
        [null, { reset: false, errorCode: 'malformed_reply' }],
        ['reset', { reset: false, errorCode: 'malformed_reply' }],
    ] as const)('reads %j strictly as %j, and always reloads once', async (reply, expected) => {
        expect(readCapacityResetReply(reply)).toEqual(expected);
        const reload = vi.fn();
        expect(await retryAfterCapacityExpiry({ computerId: 'c-1', failure: expired, reset: vi.fn(async () => reply),
            reload, inFlight: { current: null } })).toEqual(expected);
        expect(reload).toHaveBeenCalledOnce();
    });
    it.each([undefined, null, { ok: false, errorCode: 'capacity_unavailable', capacityAttemptId: ATTEMPT },
        { ...expired, capacityAttemptId: '' }, { ...expired, capacityAttemptId: 7 }, { ok: true, errorCode: 'capacity_attempt_expired', capacityAttemptId: ATTEMPT }])(
        'anything else reloads immediately with no reset (%j)', async (failure) => {
            const reset = vi.fn(async () => {}), reload = vi.fn();
            await retryAfterCapacityExpiry({ computerId: 'c-1', failure, reset, reload, inFlight: { current: null } });
            expect(reset).not.toHaveBeenCalled();
            expect(reload).toHaveBeenCalledOnce();
            expect(expiredCapacityAttemptId(failure)).toBeNull();
        });
    it('the canvas wires it to the failed panel\'s Retry only, never to polling or TanStack retry', async () => {
        const { readFileSync } = await import('node:fs');
        const src = readFileSync(new URL('./cloudflare-guacamole-canvas.tsx', import.meta.url), 'utf8');
        expect(src.match(/retryAfterCapacityExpiry\(/g)).toHaveLength(1);
        expect(src).toMatch(/onRetry=\{handleRetry\}/);
        // The poll and the query retry policy never see the reset mutation.
        const query = src.slice(src.indexOf('const previewQuery'), src.indexOf('const { requestStatus, errorCode }'));
        expect(query).not.toMatch(/resetCapacityAttempt|retryAfterCapacityExpiry|handleRetry/);
    });
});
