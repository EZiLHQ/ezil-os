import { describe, expect, it } from 'vitest';

import { rowHoursInMonth, rowOverlapsMonth, summarizeUsage, utcMonthStart, utcNextMonthStart } from './usage';

const U1 = 'u1';
const U2 = 'u2';
const row = (userId: string, startedAt: string, stoppedAt: string | null, egressBytes: number | null = null) => ({
    computerId: 'c',
    userId,
    startedAt: new Date(startedAt),
    stoppedAt: stoppedAt === null ? null : new Date(stoppedAt),
    egressBytes,
});

describe('UTC month boundaries', () => {
    it('months are UTC, not local', () => {
        expect(utcMonthStart(new Date('2026-11-01T00:30:00+05:30')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
        expect(utcMonthStart(new Date('2026-10-31T23:59:59Z')).toISOString()).toBe('2026-10-01T00:00:00.000Z');
        expect(utcNextMonthStart(new Date('2026-12-15T00:00:00Z')).toISOString()).toBe('2027-01-01T00:00:00.000Z');
    });
});

describe('hours', () => {
    const now = new Date('2026-10-13T12:00:00Z');

    it('a closed row inside the month counts its duration', () => {
        expect(rowHoursInMonth(row(U1, '2026-10-10T00:00:00Z', '2026-10-10T05:30:00Z'), now)).toBe(5.5);
    });

    it('an open row counts up to now', () => {
        expect(rowHoursInMonth(row(U1, '2026-10-13T09:00:00Z', null), now)).toBe(3);
    });

    it('a row that began last month is clipped to the month start', () => {
        expect(rowHoursInMonth(row(U1, '2026-09-30T22:00:00Z', '2026-10-01T03:00:00Z'), now)).toBe(3);
    });

    it('a row entirely last month counts zero and does not overlap', () => {
        const r = row(U1, '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z', 999);
        expect(rowHoursInMonth(r, now)).toBe(0);
        expect(rowOverlapsMonth(r, now)).toBe(false);
    });

    it('a row stopped before it started, or starting after now, counts zero', () => {
        expect(rowHoursInMonth(row(U1, '2026-10-10T05:00:00Z', '2026-10-10T04:00:00Z'), now)).toBe(0);
        expect(rowHoursInMonth(row(U1, '2026-10-14T00:00:00Z', null), now)).toBe(0);
    });
});

describe('summaries', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    const rows = [
        row(U1, '2026-10-13T10:00:00Z', null, 5),
        row(U1, '2026-09-30T23:00:00Z', '2026-10-01T01:00:00Z', 100), // spans the boundary: egress counted in full
        row(U2, '2026-10-01T00:00:00Z', '2026-10-01T10:00:00Z', null), // not yet observed: 0
        row(U2, '2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z', 1_000), // last-but-one month: ignored
    ];

    it('splits per user and global', () => {
        expect(summarizeUsage(rows, U1, now)).toEqual({ user: { hours: 3, egressBytes: 105 }, global: { hours: 13, egressBytes: 105 } });
    });

    it('egress of a boundary-spanning row counts in both months (over-count, safe direction)', () => {
        const sept = new Date('2026-09-30T23:59:00Z');
        expect(summarizeUsage([rows[1]!], U1, sept).user.egressBytes).toBe(100);
        expect(summarizeUsage([rows[1]!], U1, now).user.egressBytes).toBe(100);
    });
});
