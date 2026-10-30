import { describe, expect, it } from 'vitest';

import { OVERAGE_GRACE_SECONDS, OVERAGE_RATING_VERSION, overageEligibility, overageIdempotencyKey } from './usage-billing';

const periodEnd = new Date('2026-10-01T00:00:00Z');
const input = { overageEnabled: true, cents: 1, periodEnd, now: new Date('2026-10-01T01:00:00Z') };

describe('overage billing helpers', () => {
    it('pins the grace, rating version and Unix-second idempotency key', () => {
        expect(OVERAGE_GRACE_SECONDS).toBe(3600);
        expect(OVERAGE_RATING_VERSION).toBe(1);
        const start = new Date('2026-09-01T00:00:00.999Z');
        expect(overageIdempotencyKey('sub_fixture', start, 1)).toBe(`overage:sub_fixture:${Math.floor(start.getTime() / 1000)}:1`);
        expect(overageIdempotencyKey('sub_fixture', start, 2)).toMatch(/:2$/);
    });

    it('prioritizes disabled overage over other skip reasons', () => {
        expect(overageEligibility({ ...input, overageEnabled: false, cents: 0, now: periodEnd })).toBe('overage_disabled');
    });

    it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects unbillable cents %s', cents => {
        expect(overageEligibility({ ...input, cents })).toBe('nothing_to_bill');
    });

    it('becomes eligible exactly at the grace watermark', () => {
        expect(overageEligibility({ ...input, now: new Date(input.now.getTime() - 1) })).toBe('period_not_closed');
        expect(overageEligibility(input)).toBeNull();
        expect(overageEligibility({ ...input, now: new Date(input.now.getTime() + 1) })).toBeNull();
    });

    it('does not bill invalid dates', () => {
        expect(overageEligibility({ ...input, periodEnd: new Date(NaN) })).toBe('period_not_closed');
        expect(overageEligibility({ ...input, now: new Date(NaN) })).toBe('period_not_closed');
    });
});
