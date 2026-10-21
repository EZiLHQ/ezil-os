import { describe, expect, it } from 'vitest';

import {
    CATALOG_V2,
    OVERAGE_MAX_CAP_CENTS,
    SESSION_MAX_SECONDS,
    SIZES,
    type AdmitStart,
    type ComputeEpoch,
    type RateWindow,
    type UpgradeGrantStdSeconds,
} from './contract';
import golden from './fixtures/golden.json';
import { admitStart, ratePeriod, rateWindow, upgradeGrantStdSeconds } from './rating';

// Adapt JSON data at the boundary; the production contract remains strict.
function goldenWindowInput(input: typeof golden.rateWindow[number]['input']): Parameters<RateWindow>[0] {
    return {
        ...input,
        epochs: input.epochs.map((epoch): ComputeEpoch => ({
            ...epoch,
            userId: 'golden-user',
            computerId: 'golden-computer',
            size: epoch.size as ComputeEpoch['size'],
            weight: epoch.weight as ComputeEpoch['weight'],
            endReason: epoch.endReason as ComputeEpoch['endReason'],
        })),
    };
}

function goldenUpgradeInput(input: typeof golden.upgradeGrant[number]['input']): Parameters<UpgradeGrantStdSeconds>[0] {
    return {
        ...input,
        fromSku: input.fromSku as Parameters<UpgradeGrantStdSeconds>[0]['fromSku'],
        toSku: input.toSku as Parameters<UpgradeGrantStdSeconds>[0]['toSku'],
    };
}

function goldenAdmitInput(input: typeof golden.admitStart[number]['input']): Parameters<AdmitStart>[0] {
    return {
        ...input,
        planSku: input.planSku as Parameters<AdmitStart>[0]['planSku'],
        size: input.size as ComputeEpoch['size'],
    };
}

describe('rating against the independent golden oracle', () => {
    it.each([-100, 0])('never subtracts included allowance for an overage cap of %i', capCents => {
        expect(admitStart({ planSku: 'compute_monthly_v2', planActive: true, paymentIssue: false, upgradePending: false,
            size: 'std-2', allowanceStdSeconds: 1800000, usedStdSeconds: 1799940, overage: { enabled: true, capCents },
            runningComputers: 0, now: '2026-11-01T00:00:00Z' }))
            .toMatchObject({ admit: true, maxRunSeconds: 60, deadline: '2026-11-01T00:01:00Z' });
    });

    it('retains every pinned row in all four groups', () => {
        expect(golden.rateWindow).toHaveLength(15);
        expect(golden.ratePeriod).toHaveLength(12);
        expect(golden.upgradeGrant).toHaveLength(6);
        expect(golden.admitStart).toHaveLength(18);
    });

    it.each(golden.rateWindow)('rateWindow: $name', ({ input, expected }) => {
        expect(rateWindow(goldenWindowInput(input))).toEqual(expected);
    });
    it.each(golden.ratePeriod)('ratePeriod: $name', ({ input, expected }) => {
        expect(ratePeriod(input)).toEqual(expected);
    });
    it.each(golden.upgradeGrant)('upgradeGrant: $name', ({ input, expected }) => {
        expect(upgradeGrantStdSeconds(goldenUpgradeInput(input))).toEqual(expected);
    });
    it.each(golden.admitStart)('admitStart: $name', ({ input, expected }) => {
        expect(admitStart(goldenAdmitInput(input))).toEqual(expected);
    });
});

const ITERATIONS = 600;
const BASE = Date.parse('2026-11-01T00:00:00Z') / 1000;
const sizes = Object.values(SIZES);
const offers = Object.values(CATALOG_V2);
const instant = (seconds: number, ms = 0): string => new Date(seconds * 1000 + ms).toISOString();

function seeded(seed: number): (min: number, max: number) => number {
    let state = seed >>> 0;
    return (min, max) => {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        return min + (state >>> 0) % (max - min + 1);
    };
}

function randomWindow(random: ReturnType<typeof seeded>) {
    const a = BASE + random(-86_400, 86_400);
    const c = a + random(2, 3 * 86_400);
    const b = a + random(0, c - a - 1);
    const epochs = Array.from({ length: 8 }, (_, i): ComputeEpoch => {
        const size = sizes[i % sizes.length];
        const ready = a + random(-SESSION_MAX_SECONDS, c - a);
        const open = i < sizes.length;
        return {
            id: `epoch-${i}`, userId: 'property-user', computerId: 'property-computer',
            size: size.code, weight: size.weight,
            readyAt: instant(ready, random(1, 999)),
            endedAt: open ? null : instant(ready + random(0, 2 * SESSION_MAX_SECONDS), random(1, 999)),
            endReason: open ? null : 'user_stop',
            overheadSeconds: random(0, 10_000),
        };
    });
    return {
        a, b, c, epochs,
        window: { start: instant(a), end: instant(c) },
        now: instant(a + random(0, c - a + SESSION_MAX_SECONDS), random(1, 999)),
    };
}

function expectSafeNumbers(value: unknown): void {
    if (typeof value === 'number') {
        expect(Number.isSafeInteger(value)).toBe(true);
    } else if (value !== null && typeof value === 'object') {
        for (const child of Object.values(value)) expectSafeNumbers(child);
    }
}

describe('deterministic rating properties (600 iterations each)', () => {
    it('splits the window without losing or double-counting seconds at any size', () => {
        const random = seeded(0xa1a001);
        for (let i = 0; i < ITERATIONS; i++) {
            const input = randomWindow(random);
            const whole = rateWindow(input);
            const left = rateWindow({ ...input, window: { start: instant(input.a), end: instant(input.b) } });
            const right = rateWindow({ ...input, window: { start: instant(input.b), end: instant(input.c) } });
            expect(left.stdSeconds + right.stdSeconds).toBe(whole.stdSeconds);
            for (const size of sizes) {
                expect((left.actualSecondsBySize[size.code] ?? 0) + (right.actualSecondsBySize[size.code] ?? 0))
                    .toBe(whole.actualSecondsBySize[size.code] ?? 0);
            }
        }
    });

    it('returns only safe integer quantities from all four functions and whole-second deadlines', () => {
        const random = seeded(0xa1a002);
        for (let i = 0; i < ITERATIONS; i++) {
            const input = randomWindow(random);
            expectSafeNumbers(rateWindow(input));
            const allowanceStdSeconds = random(0, 5_000_000);
            const usedStdSeconds = random(0, 5_000_000);
            const overage = i % 3 === 0 ? null : { enabled: i % 3 === 1, capCents: random(0, OVERAGE_MAX_CAP_CENTS) };
            expectSafeNumbers(ratePeriod({ usedStdSeconds, allowanceStdSeconds, overage }));
            expectSafeNumbers(upgradeGrantStdSeconds({
                fromSku: offers[random(0, offers.length - 1)].sku,
                toSku: offers[random(0, offers.length - 1)].sku,
                periodStart: instant(input.a, random(1, 999)),
                periodEnd: instant(input.c, random(1, 999)),
                effectiveAt: instant(input.a + random(-86_400, input.c - input.a + 86_400), random(1, 999)),
            }));
            const offer = offers[i % offers.length];
            const decision = admitStart({
                planSku: i % 17 === 0 ? null : offer.sku,
                planActive: i % 19 !== 0, paymentIssue: i % 23 === 0, upgradePending: i % 29 === 0,
                size: i % 7 === 0 ? sizes[random(0, sizes.length - 1)].code : offer.defaultSize,
                allowanceStdSeconds, usedStdSeconds, overage, runningComputers: i % 31 === 0 ? 1 : 0,
                now: input.now,
            });
            expectSafeNumbers(decision);
            if (decision.admit) {
                expect(decision.deadline).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
                expect(Number.isSafeInteger(Date.parse(decision.deadline) / 1000)).toBe(true);
                expect(Date.parse(decision.deadline) / 1000 - Math.floor(Date.parse(input.now) / 1000))
                    .toBe(decision.maxRunSeconds);
            }
        }
    });

    it('never bills above the cap and never bills disabled or absent overage', () => {
        const random = seeded(0xa1a003);
        for (let i = 0; i < ITERATIONS; i++) {
            const input = { allowanceStdSeconds: random(0, 2_000_000), usedStdSeconds: random(0, 10_000_000) };
            const capCents = random(0, OVERAGE_MAX_CAP_CENTS);
            const enabled = ratePeriod({ ...input, overage: { enabled: true, capCents } });
            expect(enabled.billableOverageCents).toBeLessThanOrEqual(capCents);
            expect(enabled.billableOverageCents).toBeGreaterThanOrEqual(0);
            expect(ratePeriod({ ...input, overage: { enabled: false, capCents } }).billableOverageCents).toBe(0);
            expect(ratePeriod({ ...input, overage: null }).billableOverageCents).toBe(0);
        }
    });

    it('a later restart only adds usage and leaves all earlier epochs unchanged', () => {
        const random = seeded(0xa1a004);
        for (let i = 0; i < ITERATIONS; i++) {
            let ready = BASE;
            const makeEpoch = (id: string): ComputeEpoch => {
                const size = sizes[random(0, sizes.length - 1)];
                const end = ready + random(1, SESSION_MAX_SECONDS * 2);
                const epoch: ComputeEpoch = {
                    id, userId: 'property-user', computerId: 'same-computer', size: size.code, weight: size.weight,
                    readyAt: instant(ready, random(1, 999)), endedAt: instant(end, random(1, 999)),
                    endReason: 'user_stop', overheadSeconds: random(0, 1000),
                };
                ready = end + random(1, 3600);
                return Object.freeze(epoch);
            };
            const earlier = Object.freeze(Array.from({ length: 3 }, (_, j) => makeEpoch(`earlier-${j}`)));
            const restart = makeEpoch('restart');
            const context = { window: { start: instant(BASE), end: instant(ready) }, now: instant(ready) };
            const before = rateWindow({ ...context, epochs: earlier });
            const later = rateWindow({ ...context, epochs: [restart] });
            const combined = rateWindow({ ...context, epochs: [...earlier, restart] });
            expect(combined.stdSeconds).toBeGreaterThanOrEqual(before.stdSeconds);
            expect(combined.stdSeconds - later.stdSeconds).toBe(before.stdSeconds);
            expect(rateWindow({ ...context, epochs: earlier })).toEqual(before);
            for (const size of sizes) {
                expect((combined.actualSecondsBySize[size.code] ?? 0) - (later.actualSecondsBySize[size.code] ?? 0))
                    .toBe(before.actualSecondsBySize[size.code] ?? 0);
            }
        }
    });

    it('bounds every open and closed epoch to six actual hours, before clipping', () => {
        const random = seeded(0xa1a005);
        for (let i = 0; i < ITERATIONS; i++) {
            const input = randomWindow(random);
            for (const epoch of input.epochs) {
                const ready = Math.floor(Date.parse(epoch.readyAt) / 1000);
                const usage = rateWindow({
                    epochs: [epoch],
                    window: { start: instant(ready - 86_400), end: instant(ready + 3 * SESSION_MAX_SECONDS) },
                    now: instant(ready + 3 * SESSION_MAX_SECONDS, 999),
                });
                const actual = usage.actualSecondsBySize[epoch.size] ?? 0;
                expect(actual).toBeGreaterThanOrEqual(0);
                expect(actual).toBeLessThanOrEqual(SESSION_MAX_SECONDS);
                expect(usage.stdSeconds).toBeLessThanOrEqual(SESSION_MAX_SECONDS * epoch.weight);
                expect(Object.values(usage.actualSecondsBySize).every(seconds => seconds > 0)).toBe(true);
            }
        }
    });
});

describe('rating edge cases beyond the oracle', () => {
    it('rejects an epoch whose stored weight disagrees with its size', () => {
        const input = goldenWindowInput(golden.rateWindow[0].input);
        expect(() => rateWindow({ ...input, epochs: [{ ...input.epochs[0], weight: 4 }] })).toThrow(RangeError);
    });

    it('clamps grants before the period, for empty/reversed periods, and for downgrades', () => {
        const input = goldenUpgradeInput(golden.upgradeGrant[0].input);
        expect(upgradeGrantStdSeconds({ ...input, effectiveAt: '2026-10-01T00:00:00Z' })).toBe(1_584_000);
        expect(upgradeGrantStdSeconds({ ...input, periodEnd: input.periodStart })).toBe(0);
        expect(upgradeGrantStdSeconds({ ...input, periodEnd: '2026-10-01T00:00:00Z' })).toBe(0);
        expect(upgradeGrantStdSeconds({ ...input, fromSku: input.toSku, toSku: input.fromSku })).toBe(0);
        expect(upgradeGrantStdSeconds({ ...input, toSku: input.fromSku })).toBe(0);
    });

    it('preserves the floor when an intermediate product exceeds safe integer precision', () => {
        // Floating multiplication/division rounds this up to 1,583,999.
        const period = 15_839_999_999;
        expect(upgradeGrantStdSeconds({
            fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
            periodStart: instant(0), periodEnd: instant(period), effectiveAt: instant(10_000),
        })).toBe(1_583_998);
    });
});

describe('uncapped paid fair-use billing bound', () => {
    it.each([['std-2', 1], ['cmp-4', 2], ['cmp-8', 4]] as const)('bounds missed open and late closed stops for %s', (size, weight) => {
        const window = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
        const prior = { id: 'prior', userId: 'u', computerId: 'c', size: 'std-2' as const, weight: 1 as const,
            readyAt: window.start, endedAt: '2026-10-01T01:00:00Z', endReason: 'user_stop' as const, overheadSeconds: 0 };
        const open = { ...prior, id: 'open', size, weight, readyAt: '2026-10-02T00:00:00Z', endedAt: null };
        const now = '2026-10-10T00:00:00Z';
        for (const endedAt of [null, now]) {
            const usage = rateWindow({ epochs: [{ ...open, endedAt }, prior], window, now,
                sessionMaxSeconds: null, allowanceStdSeconds: 144000 });
            expect(usage.stdSeconds).toBe(144000);
            expect(usage.actualSecondsBySize[size]).toBe((144000 - 3600) / weight + (size === 'std-2' ? 3600 : 0));
        }
    });
    it.each([undefined, Infinity, NaN, -1])('rejects unbounded allowance %s', allowanceStdSeconds => {
        expect(() => rateWindow({ epochs: [], window: { start: '2026-10-01', end: '2026-11-01' },
            now: '2026-10-10', sessionMaxSeconds: null, allowanceStdSeconds })).toThrow(RangeError);
    });
});
