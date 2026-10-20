import { describe, expect, it } from 'vitest';
import { START_SLI_SQL, startReadinessByTier, type StartReadinessRow } from './start-sli';

const window = { from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };
const row = (overheadSeconds: number, extra: Partial<StartReadinessRow> = {}): StartReadinessRow => ({
    size: 'std-2', readyAt: '2026-10-20T12:00:00Z', overheadSeconds, endReason: null, ...extra,
});

describe('startReadinessByTier', () => {
    it('returns no tiers for empty input or an empty window', () => {
        expect(startReadinessByTier([], window)).toEqual({});
        expect(startReadinessByTier([row(10, { readyAt: window.from })], { from: window.from, to: window.from })).toEqual({});
    });

    it('a single open epoch has identical percentiles and max', () => {
        expect(startReadinessByTier([row(17)], window)).toEqual({
            'std-2': { count: 1, p50: 17, p95: 17, max: 17, platformFailures: 0 },
        });
    });

    it('retains ties and zero overhead', () => {
        expect(startReadinessByTier([row(0), row(9), row(0), row(9)], window)).toEqual({
            'std-2': { count: 4, p50: 0, p95: 9, max: 9, platformFailures: 0 },
        });
    });

    it.each([
        [2, 1, 2], [3, 2, 3], [19, 10, 19], [20, 10, 19], [21, 11, 20], [100, 50, 95],
    ])('nearest rank for %i observations yields p50=%i and p95=%i', (count, p50, p95) => {
        const rows = Array.from({ length: count }, (_, index) => row(count - index));
        expect(startReadinessByTier(rows, window)).toEqual({
            'std-2': { count, p50, p95, max: count, platformFailures: 0 },
        });
    });

    it('groups all sizes separately and counts only platform_failure endings', () => {
        expect(startReadinessByTier([
            row(8, { size: 'free-cf', endReason: 'user_stop' }),
            row(10, { endReason: 'platform_failure' }), row(20, { endReason: 'provider_stop' }),
            row(30, { size: 'cmp-4', endReason: 'platform_failure' }),
            row(40, { size: 'cmp-4', endReason: 'platform_failure' }), row(90, { size: 'cmp-8' }),
        ], window)).toEqual({
            'free-cf': { count: 1, p50: 8, p95: 8, max: 8, platformFailures: 0 },
            'std-2': { count: 2, p50: 10, p95: 20, max: 20, platformFailures: 1 },
            'cmp-4': { count: 2, p50: 30, p95: 40, max: 40, platformFailures: 2 },
            'cmp-8': { count: 1, p50: 90, p95: 90, max: 90, platformFailures: 0 },
        });
    });

    it('filters readiness timestamps using inclusive from and exclusive to with millisecond precision', () => {
        const from = new Date('2026-10-20T12:00:00.500Z');
        const to = new Date('2026-10-20T12:00:01.500Z');
        const rows = [
            row(999, { readyAt: new Date(from.getTime() - 1), endReason: 'platform_failure' }),
            row(10, { readyAt: from }),
            row(20, { readyAt: '2026-10-20T14:00:01.499+02:00', endReason: 'platform_failure' }),
            row(888, { readyAt: to, endReason: 'platform_failure' }),
            row(777, { readyAt: new Date(to.getTime() + 1), size: 'cmp-8' }),
        ];
        expect(startReadinessByTier(rows, { from, to })).toEqual({
            'std-2': { count: 2, p50: 10, p95: 20, max: 20, platformFailures: 1 },
        });
    });

    it('uses whole seconds without mutating input rows or their order', () => {
        const rows = Object.freeze([Object.freeze(row(12.9)), Object.freeze(row(2.1))]);
        expect(startReadinessByTier(rows, window)).toEqual({
            'std-2': { count: 2, p50: 2, p95: 12, max: 12, platformFailures: 0 },
        });
        expect(rows.map(value => value.overheadSeconds)).toEqual([12.9, 2.1]);
    });

    it.each([NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1])('rejects invalid overhead %s', overhead => {
        expect(() => startReadinessByTier([row(overhead)], window)).toThrow(RangeError);
    });

    it('rejects invalid timestamps and reversed windows', () => {
        expect(() => startReadinessByTier([], { ...window, from: 'invalid' })).toThrow(RangeError);
        expect(() => startReadinessByTier([], { ...window, to: new Date(NaN) })).toThrow(RangeError);
        expect(() => startReadinessByTier([row(1, { readyAt: 'invalid' })], window)).toThrow(RangeError);
        expect(() => startReadinessByTier([], { from: window.to, to: window.from })).toThrow(RangeError);
    });
});

describe('START_SLI_SQL', () => {
    it('selects only report columns with a matching parameterized readiness window', () => {
        expect(START_SLI_SQL.replace(/\s+/g, ' ').trim()).toBe(
            'SELECT size, ready_at AS "readyAt", overhead_seconds AS "overheadSeconds", end_reason AS "endReason" '
            + 'FROM ezil_billing_compute_epochs WHERE ready_at >= $1::timestamptz AND ready_at < $2::timestamptz',
        );
    });
});
