import { describe, expect, it } from 'vitest';
import { admitStart, fairUseStatusOf } from './admission';
import { CATALOG_V3, type AdmitStartV3 } from './contract';

const base: Parameters<AdmitStartV3>[0] = { sku: 'free_v3', planActive: true, paymentIssue: false,
    usedSeconds: 0, legacyFree: false, runningComputers: 0, poolHostAvailable: true, now: '2026-10-19T12:00:00Z' };

describe('v3 admission golden cases', () => {
    it.each([['std-2', 1], ['cmp-4', 2], ['cmp-8', 4]] as const)(
        'converts standard-seconds to actual seconds for %s', (size, weight) => {
            const args = { ...base, sku: 'premium_monthly_v3' as const, size };
            expect(admitStart({ ...args, usedSeconds: 0 })).toMatchObject({ admit: true, size, maxRunSeconds: 21600 });
            expect(admitStart({ ...args, usedSeconds: 1800000 - (60 * weight - 1) })).toEqual({ admit: false, reason: 'fair_use_paused' });
            expect(admitStart({ ...args, usedSeconds: 1800000 - 60 * weight })).toMatchObject({ admit: true, maxRunSeconds: 60, deadline: '2026-10-19T12:01:00Z' });
            expect(admitStart({ ...args, usedSeconds: 1800000 })).toEqual({ admit: false, reason: 'fair_use_paused' });
        });
    it.each([['free_v3', 'std-2'], ['standard_monthly_v3', 'cmp-8'], ['premium_monthly_v3', 'free-cf']] as const)(
        '%s refuses disallowed %s', (sku, size) => expect(admitStart({ ...base, sku, size })).toEqual({ admit: false, reason: 'size_not_allowed' }));

    it.each([
        ['free_v3', 3600, 'free-cf', false, 0],
        ['standard_monthly_v3', 7200, 'std-2', true, 1],
        ['premium_monthly_v3', 21600, 'std-2', true, 2],
    ] as const)('%s session cap', (sku, maxRunSeconds, size, fromPool, poolPriority) => {
        expect(admitStart({ ...base, sku })).toEqual({ admit: true, size, maxRunSeconds, fromPool, poolPriority,
            deadline: new Date(Date.parse(base.now) + maxRunSeconds * 1000).toISOString().replace('.000Z', 'Z') });
    });
    it.each(Object.values(CATALOG_V3))('$sku refuses 100% and 59 seconds, admits exactly 60', offer => {
        for (const remaining of [0, 59]) expect(admitStart({ ...base, sku: offer.sku, usedSeconds: offer.fairUseSeconds - remaining }))
            .toEqual({ admit: false, reason: 'fair_use_paused' });
        expect(admitStart({ ...base, sku: offer.sku, usedSeconds: offer.fairUseSeconds - 60 }))
            .toMatchObject({ admit: true, maxRunSeconds: 60 });
    });
    it('legacy Free keeps eight hours but still has one-hour sessions', () => {
        expect(admitStart({ ...base, legacyFree: true, usedSeconds: 7 * 3600 })).toMatchObject({ admit: true, maxRunSeconds: 3600 });
        expect(admitStart({ ...base, legacyFree: true, usedSeconds: 8 * 3600 })).toEqual({ admit: false, reason: 'fair_use_paused' });
        expect(admitStart({ ...base, usedSeconds: 5 * 3600 })).toEqual({ admit: false, reason: 'fair_use_paused' });
    });
    it.each([
        [{ sku: null }, 'no_plan'], [{ planActive: false }, 'no_plan'],
        [{ paymentIssue: true }, 'payment_issue'], [{ runningComputers: 1 }, 'concurrent_limit'],
        [{ runningComputers: 2 }, 'concurrent_limit'],
    ] as const)('refuses %j', (overrides, reason) => {
        expect(admitStart({ ...base, ...overrides })).toEqual({ admit: false, reason });
    });
    it('falls back to a cold host when the pool is empty', () => {
        expect(admitStart({ ...base, sku: 'premium_monthly_v3', poolHostAvailable: false })).toMatchObject({ admit: true, fromPool: false, poolPriority: 2 });
    });
    it.each([[0, 'ok'], [79, 'ok'], [80, 'near'], [99, 'near'], [100, 'paused'], [101, 'paused']] as const)
    ('status at %s percent', (usedSeconds, expected) => expect(fairUseStatusOf({ usedSeconds, fairUseSeconds: 100 })).toBe(expected));
});
