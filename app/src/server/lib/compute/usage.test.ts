import { describe, expect, it } from 'vitest';

import { AWS_MONTHLY_CAP_REASON, awsMonthlyCapReached, awsMonthlyCapRefusal, monthUsageFromRows, rowHoursInMonth, rowOverlapsMonth, summarizeUsage, utcMonthStart, utcNextMonthStart } from './usage';

const U1 = 'u1';
const U2 = 'u2';
const row = (userId: string, startedAt: string, stoppedAt: string | null, egressBytes: number | null = null) => ({
    computerId: 'c',
    userId,
    instanceType: 'm6i.large',
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
        expect(summarizeUsage(rows, U1, now)).toEqual({ user: { hours: 3, weightedSeconds: 10_800, egressBytes: 105 }, global: { hours: 13, weightedSeconds: 46_800, egressBytes: 105 } });
    });

    it('egress of a boundary-spanning row counts in both months (over-count, safe direction)', () => {
        const sept = new Date('2026-09-30T23:59:00Z');
        expect(summarizeUsage([rows[1]!], U1, sept).user.egressBytes).toBe(100);
        expect(summarizeUsage([rows[1]!], U1, now).user.egressBytes).toBe(100);
    });
});

describe('integer weighted usage', () => {
    const now = new Date('2026-10-13T12:00:00Z');
    it('one cmp-8 hour is 14,400 weighted seconds, retaining one wall-clock hour', () => {
        const rows = [{ ...row(U1, '2026-10-13T11:00:00Z', null), instanceType: 'm6i.2xlarge' }];
        const totals = { hours: 1, weightedSeconds: 14_400, egressBytes: 0 };
        expect(summarizeUsage(rows, U1, now)).toEqual({ user: totals, global: totals });
        expect(monthUsageFromRows(rows, now).byUser.get(U1)).toEqual(totals);
    });

    it('clips to the UTC month and now, then floors each row before weighting', () => {
        const instant = new Date('2026-10-01T00:00:01.999Z');
        const rows = [
            { ...row(U1, '2026-09-30T23:59:59.100Z', null), instanceType: 'm6i.2xlarge' },
            { ...row(U1, '2026-10-01T00:00:01.100Z', '2026-10-01T00:00:02.999Z'), instanceType: 'm6i.xlarge' },
        ];
        expect(summarizeUsage(rows, U1, instant).user.weightedSeconds).toBe(4);
        expect(monthUsageFromRows(rows, instant).global.weightedSeconds).toBe(4);
    });

    it.each(['c6i.xlarge', 'm6i.xlarge', 'unknown', null])('%j is weighted without under-metering', instanceType => {
        const rows = [{ ...row(U1, '2026-10-13T11:00:00Z', null), instanceType }];
        expect(monthUsageFromRows(rows, now).global.weightedSeconds).toBe(instanceType?.endsWith('.xlarge') ? 7_200 : 14_400);
    });
});

const capNow = new Date('2026-10-28T12:00:00Z');
const capRow = (over: Partial<ReturnType<typeof row>> = {}) => ({ ...row('User-A', '2026-10-22T00:00:00Z', null), ...over });

describe('round 3 D11 AWS monthly cap (read-only)', () => {
    it('reads the ledger cap exactly as admission does, including a row left open since the 22nd', () => {
        // Open since 2026-10-22T00:00Z: 156 h at 2 vCPU by now.
        const usage = monthUsageFromRows([capRow()], capNow);
        expect(awsMonthlyCapReached(usage, 'user-a', 156)).toBe(true);
        expect(awsMonthlyCapReached(usage, 'user-a', 157)).toBe(false);
        // 4 vCPU counts double (2-vCPU units).
        expect(awsMonthlyCapReached(monthUsageFromRows([capRow({ instanceType: 'm6i.xlarge', stoppedAt: new Date('2026-10-22T10:00:00Z') })], capNow), 'user-a', 20)).toBe(true);
        expect(awsMonthlyCapReached(usage, 'someone-else', 1)).toBe(false);
        expect(awsMonthlyCapReached(usage, 'user-a', Number.NaN)).toBe(false);
    });
    it('names the compute refusal for billing without touching other reasons', () => {
        expect(AWS_MONTHLY_CAP_REASON).toBe('aws_monthly_cap');
        expect(awsMonthlyCapRefusal('user_hours_cap')).toBe('aws_monthly_cap');
        for (const reason of ['global_hours_cap', 'max_running', null, undefined]) expect(awsMonthlyCapRefusal(reason)).toBeNull();
    });
});
