import { describe, expect, it } from 'vitest';
import { CATALOG_V3, hoursLeftAtWeight, OPENING_MILESTONES_V3, upgradeAiCredits } from './contract';
import { upgradeGrantSeconds } from './catalog';

const period = { periodStart: '2026-10-25T00:00:00Z', periodEnd: '2026-11-24T00:00:00Z' };
const skus = { fromSku: 'standard_monthly_v3', toSku: 'premium_monthly_v3' } as const;

describe('upgradeAiCredits (round 3 D1)', () => {
    it('grants the whole difference at period start and nothing at period end', () => {
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: period.periodStart })).toBe(800);
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: period.periodEnd })).toBe(0);
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: '2026-12-01T00:00:00Z' })).toBe(0);
    });
    it('prorates with the same integer fraction as the compute grant', () => {
        for (const effectiveAt of ['2026-10-28T03:07:11Z', '2026-11-09T00:00:00Z', '2026-11-23T23:59:59Z']) {
            const credits = upgradeAiCredits({ ...skus, ...period, effectiveAt });
            const seconds = upgradeGrantSeconds({ ...period, effectiveAt });
            const computeDelta = CATALOG_V3.premium_monthly_v3.fairUseSeconds - CATALOG_V3.standard_monthly_v3.fairUseSeconds;
            // Both are floor(delta × remaining / period): the ratios agree to within one unit of rounding.
            expect(Math.abs(credits / 800 - seconds / computeDelta)).toBeLessThan(1 / 800 + 1 / computeDelta);
            expect(Number.isInteger(credits)).toBe(true);
        }
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: '2026-11-09T00:00:00Z' })).toBe(400);
    });
    it('never throws and never goes negative on bad input', () => {
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: 'not-a-date' })).toBe(0);
        expect(upgradeAiCredits({ ...skus, periodStart: period.periodEnd, periodEnd: period.periodStart, effectiveAt: period.periodStart })).toBe(0);
        expect(upgradeAiCredits({ fromSku: 'premium_monthly_v3', toSku: 'standard_monthly_v3', ...period, effectiveAt: period.periodStart })).toBe(0);
        expect(upgradeAiCredits({ ...skus, ...period, effectiveAt: '2026-10-01T00:00:00Z' })).toBe(800);
    });
});

describe('hoursLeftAtWeight (round 3 D3)', () => {
    it('divides standard-seconds by the configuration weight, whole hours', () => {
        const remaining = 452 * 3600 + 1799;
        expect(hoursLeftAtWeight(remaining, 1)).toBe(452);
        expect(hoursLeftAtWeight(remaining, 2)).toBe(226);
        expect(hoursLeftAtWeight(remaining, 4)).toBe(113);
    });
    it('is 0 for exhausted, negative, non-finite or invalid weights', () => {
        expect(hoursLeftAtWeight(0, 1)).toBe(0);
        expect(hoursLeftAtWeight(-5, 1)).toBe(0);
        expect(hoursLeftAtWeight(Number.NaN, 1)).toBe(0);
        expect(hoursLeftAtWeight(7200, 0)).toBe(0);
        expect(hoursLeftAtWeight(7200, 1.5)).toBe(0);
    });
});

describe('opening milestones', () => {
    it('are ordered and unique', () => {
        expect([...OPENING_MILESTONES_V3]).toEqual(['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready']);
        expect(new Set(OPENING_MILESTONES_V3).size).toBe(OPENING_MILESTONES_V3.length);
    });
});
