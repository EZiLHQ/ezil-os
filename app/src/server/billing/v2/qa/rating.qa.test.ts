/**
 * Independent QA (request os-billing-compute-20261018-v2). Every expectation is
 * derived from CONTRACT-v2.md / contract.ts / golden.json, never from the
 * implementation's own tests.
 */
import { describe, expect, it } from 'vitest';

import golden from '../fixtures/golden.json';
import {
    CATALOG_V2, MIN_START_ACTUAL_SECONDS, OVERAGE_MAX_CAP_CENTS, SESSION_MAX_SECONDS, SIZES,
    STD_SECONDS_PER_OVERAGE_CENT, type ComputeEpoch, type PlanSku, type SizeCode,
} from '../contract';
import { admitStart, ratePeriod, rateWindow, upgradeGrantStdSeconds } from '../rating';

const iso = (s: number) => new Date(s * 1000).toISOString().replace(/\.000Z$/, 'Z');
const sec = (value: string) => Date.parse(value) / 1000;

function epoch(size: SizeCode, readyAt: string, endedAt: string | null, extra: Partial<ComputeEpoch> = {}): ComputeEpoch {
    return {
        id: `e-${readyAt}-${size}`, userId: 'u', computerId: 'c', size, weight: SIZES[size].weight,
        readyAt, endedAt, endReason: endedAt === null ? null : 'user_stop', overheadSeconds: 0, ...extra,
    };
}

describe('qa golden oracle (independent python oracle)', () => {
    it.each(golden.rateWindow.map(c => [c.name, c] as const))('rateWindow %s', (_name, c) => {
        expect(rateWindow(c.input as Parameters<typeof rateWindow>[0])).toEqual(c.expected);
    });
    it.each(golden.ratePeriod.map(c => [c.name, c] as const))('ratePeriod %s', (_name, c) => {
        expect(ratePeriod(c.input as Parameters<typeof ratePeriod>[0])).toEqual(c.expected);
    });
    it.each(golden.upgradeGrant.map(c => [c.name, c] as const))('upgradeGrant %s', (_name, c) => {
        const got = upgradeGrantStdSeconds(c.input as Parameters<typeof upgradeGrantStdSeconds>[0]);
        expect(got).toBe(c.expected);
        // Never the full Compute period allowance: at most the Standard→Compute delta.
        expect(got).toBeLessThanOrEqual(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds - CATALOG_V2.standard_monthly_v2.allowanceStdSeconds);
    });
    it.each(golden.admitStart.map(c => [c.name, c] as const))('admitStart %s', (_name, c) => {
        expect(admitStart(c.input as Parameters<typeof admitStart>[0])).toEqual(c.expected);
    });
});

describe('qa metering', () => {
    const W = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };

    it('never returns a fraction, even for millisecond instants and odd weights', () => {
        let seed = 42;
        const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
        const sizes: SizeCode[] = ['std-2', 'cmp-4', 'cmp-8', 'free-cf'];
        for (let round = 0; round < 300; round++) {
            const epochs: ComputeEpoch[] = [];
            for (let i = 0; i < 5; i++) {
                const ready = sec(W.start) * 1000 + Math.floor(rnd() * 31 * 86400 * 1000) + 0.5;
                const end = ready + Math.floor(rnd() * 30_000_000);
                const size = sizes[Math.floor(rnd() * sizes.length)];
                epochs.push(epoch(size, new Date(ready).toISOString(), rnd() < 0.2 ? null : new Date(end).toISOString()));
            }
            const usage = rateWindow({ epochs, window: W, now: '2026-10-20T12:34:56.789Z' });
            expect(Number.isSafeInteger(usage.stdSeconds)).toBe(true);
            for (const v of Object.values(usage.actualSecondsBySize)) expect(Number.isSafeInteger(v)).toBe(true);
            const p = ratePeriod({ usedStdSeconds: usage.stdSeconds, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: 2_500 } });
            for (const v of Object.values(p)) expect(Number.isSafeInteger(v)).toBe(true);
        }
    });

    it('rounds readyAt up and endedAt down (customer favour)', () => {
        const usage = rateWindow({
            epochs: [epoch('cmp-4', '2026-10-02T00:00:00.001Z', '2026-10-02T01:00:00.999Z')],
            window: W, now: '2026-10-03T00:00:00Z',
        });
        expect(usage.actualSecondsBySize['cmp-4']).toBe(3599);
        expect(usage.stdSeconds).toBe(7198);
    });

    it('splitting a window at any second preserves the total (cmp-8, 2 h epoch across a month boundary)', () => {
        const ep = epoch('cmp-8', '2026-10-31T23:00:00Z', '2026-11-01T01:00:00Z');
        const outer = { start: '2026-10-31T00:00:00Z', end: '2026-11-02T00:00:00Z' };
        const total = rateWindow({ epochs: [ep], window: outer, now: '2026-11-05T00:00:00Z' }).stdSeconds;
        expect(total).toBe(7200 * 4);
        const from = sec('2026-10-31T22:59:00Z');
        for (let cut = from; cut <= from + 7320; cut++) {
            const left = rateWindow({ epochs: [ep], window: { start: outer.start, end: iso(cut) }, now: '2026-11-05T00:00:00Z' }).stdSeconds;
            const right = rateWindow({ epochs: [ep], window: { start: iso(cut), end: outer.end }, now: '2026-11-05T00:00:00Z' }).stdSeconds;
            if (left + right !== total) throw new Error(`split at ${iso(cut)} lost ${total - left - right}`);
        }
    });

    it('an open epoch never counts past readyAt + 21600, whatever now is', () => {
        for (const nowOffset of [21_599, 21_600, 21_601, 86_400 * 40]) {
            const usage = rateWindow({
                epochs: [epoch('cmp-8', '2026-10-05T00:00:00Z', null)],
                window: { start: '2026-10-01T00:00:00Z', end: '2027-01-01T00:00:00Z' },
                now: iso(sec('2026-10-05T00:00:00Z') + nowOffset),
            });
            expect(usage.actualSecondsBySize['cmp-8']).toBe(Math.min(nowOffset, SESSION_MAX_SECONDS));
        }
    });

    it('a closed epoch whose stop arrived days late is capped at readyAt + 21600', () => {
        const usage = rateWindow({ epochs: [epoch('std-2', '2026-10-05T00:00:00Z', '2026-10-09T00:00:00Z')], window: W, now: '2026-10-20T00:00:00Z' });
        expect(usage.stdSeconds).toBe(SESSION_MAX_SECONDS);
    });

    it('the 6 h cap applies from readyAt even when the window starts later (no reset at a period boundary)', () => {
        // Ready 23:00 Oct 31, missed stop. Only 5 h fall into November.
        const usage = rateWindow({
            epochs: [epoch('std-2', '2026-10-31T23:00:00Z', null)],
            window: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' }, now: '2026-11-03T00:00:00Z',
        });
        expect(usage.stdSeconds).toBe(5 * 3600);
    });

    it('overhead is never billed', () => {
        const a = rateWindow({ epochs: [epoch('cmp-4', '2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')], window: W, now: '2026-10-03T00:00:00Z' });
        const b = rateWindow({ epochs: [epoch('cmp-4', '2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z', { overheadSeconds: 99_999 })], window: W, now: '2026-10-03T00:00:00Z' });
        expect(b).toEqual(a);
    });

    it('a forged weight is refused, not billed at the cheaper/dearer rate', () => {
        expect(() => rateWindow({ epochs: [epoch('cmp-8', '2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z', { weight: 1 })], window: W, now: '2026-10-03T00:00:00Z' })).toThrow();
    });

    it('a full 31-day month of back-to-back 6 h cmp-8 sessions is exact (no float drift)', () => {
        const epochs: ComputeEpoch[] = [];
        const start = sec('2026-10-01T00:00:00Z');
        for (let i = 0; i < 124; i++) epochs.push(epoch('cmp-8', iso(start + i * 21_600), iso(start + (i + 1) * 21_600)));
        const usage = rateWindow({ epochs, window: W, now: '2026-11-05T00:00:00Z' });
        expect(usage.actualSecondsBySize['cmp-8']).toBe(31 * 86_400);
        expect(usage.stdSeconds).toBe(31 * 86_400 * 4);
        const p = ratePeriod({ usedStdSeconds: usage.stdSeconds, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: OVERAGE_MAX_CAP_CENTS } });
        expect(p.overStdSeconds).toBe(31 * 86_400 * 4 - 1_800_000);
        expect(p.overageCents).toBe(Math.floor((31 * 86_400 * 4 - 1_800_000) / STD_SECONDS_PER_OVERAGE_CENT));
        expect(p.billableOverageCents).toBe(OVERAGE_MAX_CAP_CENTS);
    });

    it('overage is never billable when disabled or absent, and never above the cap', () => {
        for (const cap of [0, 100, 2_500, 10_000]) {
            for (const used of [0, 1_800_000, 1_800_143, 1_800_144, 9_999_999_999]) {
                const on = ratePeriod({ usedStdSeconds: used, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: cap } });
                expect(on.billableOverageCents).toBeLessThanOrEqual(cap);
                expect(ratePeriod({ usedStdSeconds: used, allowanceStdSeconds: 1_800_000, overage: { enabled: false, capCents: cap } }).billableOverageCents).toBe(0);
                expect(ratePeriod({ usedStdSeconds: used, allowanceStdSeconds: 216_000, overage: null }).billableOverageCents).toBe(0);
            }
        }
        expect(ratePeriod({ usedStdSeconds: 1_800_143, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: 2_500 } }).billableOverageCents).toBe(0);
        expect(ratePeriod({ usedStdSeconds: 1_800_144, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: 2_500 } }).billableOverageCents).toBe(1);
    });

    it('CONTRACT §2 example: 150 h at 8 vCPU on Compute = $25 overage', () => {
        const p = ratePeriod({ usedStdSeconds: 150 * 3600 * 4, allowanceStdSeconds: 1_800_000, overage: { enabled: true, capCents: 10_000 } });
        expect(p.overageCents).toBe(2_500);
        expect(p.billableOverageCents).toBe(2_500);
    });
});

describe('qa admission', () => {
    const base = {
        planActive: true, paymentIssue: false, upgradePending: false, usedStdSeconds: 0,
        overage: null, runningComputers: 0, now: '2026-11-10T09:00:00Z',
    } as const;
    const offer = (sku: PlanSku) => CATALOG_V2[sku];

    it('every refusal reason in the contract is reachable', () => {
        const reasons = new Set<string>();
        const tryIt = (input: Partial<Parameters<typeof admitStart>[0]>) => {
            const d = admitStart({ ...base, planSku: 'compute_monthly_v2', size: 'std-2', allowanceStdSeconds: 1_800_000, ...input });
            if (!d.admit) reasons.add(d.reason);
            return d;
        };
        tryIt({ planSku: null });
        tryIt({ size: 'free-cf' });
        tryIt({ usedStdSeconds: 1_800_000 });
        tryIt({ usedStdSeconds: 1_800_000 + 2_500 * 144, overage: { enabled: true, capCents: 2_500 } });
        tryIt({ paymentIssue: true });
        tryIt({ runningComputers: 1 });
        tryIt({ upgradePending: true });
        expect([...reasons].sort()).toEqual(['allowance_exhausted', 'concurrent_limit', 'no_plan', 'overage_cap_reached', 'payment_issue', 'size_not_allowed', 'upgrade_pending']);
    });

    it('the 60 actual-second minimum is per size weight (cmp-8: 239 std-s refused, 240 admitted)', () => {
        const at = (left: number) => admitStart({ ...base, planSku: 'compute_monthly_v2', size: 'cmp-8', allowanceStdSeconds: 1_800_000, usedStdSeconds: 1_800_000 - left });
        expect(at(239)).toEqual({ admit: false, reason: 'allowance_exhausted' });
        expect(at(240)).toMatchObject({ admit: true, maxRunSeconds: MIN_START_ACTUAL_SECONDS });
    });

    it('maxRunSeconds is bounded by the session limit and by headroom / weight, deadline = now + maxRun', () => {
        const d = admitStart({ ...base, planSku: 'compute_monthly_v2', size: 'cmp-4', allowanceStdSeconds: 1_800_000, usedStdSeconds: 1_800_000 - 10_001 });
        expect(d).toEqual({ admit: true, size: 'cmp-4', weight: 2, maxRunSeconds: 5_000, deadline: '2026-11-10T10:23:20Z' });
        const fresh = admitStart({ ...base, planSku: 'compute_monthly_v2', size: 'cmp-8', allowanceStdSeconds: 1_800_000 });
        expect(fresh).toMatchObject({ admit: true, maxRunSeconds: SESSION_MAX_SECONDS });
    });

    it('used > allowance (negative remaining) never wraps into headroom', () => {
        const d = admitStart({ ...base, planSku: 'standard_monthly_v2', size: 'std-2', allowanceStdSeconds: 216_000, usedStdSeconds: 9_000_000 });
        expect(d).toEqual({ admit: false, reason: 'allowance_exhausted' });
    });

    it('a legacy/unsold SKU is still bounded to its own sizes', () => {
        expect(offer('pro_monthly_v1').sizes).toEqual(['std-2']);
        expect(admitStart({ ...base, planSku: 'pro_monthly_v1', size: 'cmp-8', allowanceStdSeconds: 72_000 })).toEqual({ admit: false, reason: 'size_not_allowed' });
    });
});
