/** Round 3: compute timings persist through the existing telemetry ingestion (no new table or env). */
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ ingest: vi.fn() }));
vi.mock('@/server/telemetry/ingest', () => ({ ingestBatch: h.ingest }));

import { compactPhases, recordComputeTiming } from './aws-pool-timing';

const C = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const U = '11111111-1111-4111-8111-111111111111';
const drizzleLike = { transaction: vi.fn(), insert: vi.fn() };
const timing = { site: 'compute.pool_session_timing' as const, code: 'pool_session_timing', outcome: 'ok' as const, ownerUserId: U, computerId: C,
    durationMs: 1100, phases: { guardDoneMs: 100, enrollDoneMs: 300, desktopHealthyMs: 300, claimToHealthyMs: 1100 } };
afterEach(() => { h.ingest.mockReset(); vi.restoreAllMocks(); });

describe('recordComputeTiming', () => {
    it('ingests one validated boot_summary row with the phases, the total and only the telemetry user hash', async () => {
        h.ingest.mockResolvedValue({ inserted: 1, attempted: 1, fingerprintsTouched: 1 });
        expect(await recordComputeTiming(drizzleLike, timing)).toBe(true);
        expect(h.ingest).toHaveBeenCalledTimes(1);
        const [db, events, userHash] = h.ingest.mock.calls[0]!;
        expect(db).toBe(drizzleLike);
        expect(userHash).toMatch(/^u_[0-9a-f]{8}$/);
        expect(JSON.stringify(events)).not.toContain(U);
        expect(events).toEqual([expect.objectContaining({ eventClass: 'boot_summary', source: 'app', site: 'compute.pool_session_timing',
            code: 'pool_session_timing', outcome: 'ok', durationMs: 1100, computerId: C,
            attrs: { phases: 'guardDone:100,enrollDone:300,desktopHealthy:300,claimToHealthy:1100', total_ms: 1100 } })]);
    });
    it('writes nothing without a query-builder database, and never throws on an ingest failure', async () => {
        expect(await recordComputeTiming({ execute: vi.fn(), transaction: vi.fn() }, timing)).toBe(false);
        expect(h.ingest).not.toHaveBeenCalled();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        h.ingest.mockRejectedValue(new Error('down'));
        expect(await recordComputeTiming(drizzleLike, timing)).toBe(false);
    });
    it('bounds the duration and the phase list', async () => {
        h.ingest.mockResolvedValue({});
        await recordComputeTiming(drizzleLike, { ...timing, durationMs: 10 ** 12, code: 'Switch-Done!' });
        expect(h.ingest.mock.calls[0]![1][0]).toMatchObject({ durationMs: 86_400_000, code: 'switch_done_' });
        expect(compactPhases(Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`phase${i}Ms`, 123456])))).toHaveLength(160);
        expect(compactPhases({ a: NaN, b: 2 })).toBe('b:2');
    });
});
