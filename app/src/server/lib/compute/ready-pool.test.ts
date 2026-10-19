import { describe, expect, it } from 'vitest';
import { instanceVcpu } from './aws-config';
import { replenishPlan, type PoolCounts, type PoolTarget } from './ready-pool';

const targets: PoolTarget[] = [
    { region: 'us-east-1', instanceType: 'm6i.2xlarge', count: 8 },
    { region: 'ap-south-1', instanceType: 'm6i.large', count: 10 },
    { region: 'us-east-1', instanceType: 'm6i.xlarge', count: 8 },
];
const pool: PoolCounts[] = [
    { region: 'ap-south-1', instanceType: 'm6i.large', ready: 1, booting: 1, leased: 1, draining: 1 },
];

describe('offline pool replenishment', () => {
    it('never exceeds any budget across combinations of available capacity', () => {
        for (const maxGlobalVcpu of [0, 7, 8, 9, 10, 17, 32, 128]) {
            for (const maxHosts of [0, 3, 4, 5, 12, 100]) {
                for (const maxBootsPerPass of [0, 1, 2, 20]) {
                    const plan = replenishPlan({ pool, runningVcpu: 8,
                        budget: { maxGlobalVcpu, maxHosts, maxBootsPerPass }, targets });
                    const boots = plan.reduce((n, p) => n + p.count, 0);
                    const vcpu = plan.reduce((n, p) => n + p.count * instanceVcpu(p.instanceType), 0);
                    expect(boots).toBeLessThanOrEqual(maxBootsPerPass);
                    expect(boots).toBeLessThanOrEqual(Math.max(0, maxHosts - 4));
                    expect(vcpu).toBeLessThanOrEqual(Math.max(0, maxGlobalVcpu - 8));
                    for (const p of plan) expect(p.count).toBeGreaterThan(0);
                }
            }
        }
    });

    it.each([
        { maxGlobalVcpu: 8, maxHosts: 100, maxBootsPerPass: 100 },
        { maxGlobalVcpu: 100, maxHosts: 4, maxBootsPerPass: 100 },
        { maxGlobalVcpu: 100, maxHosts: 100, maxBootsPerPass: 0 },
    ])('boots zero when a budget is exhausted: %j', budget => {
        expect(replenishPlan({ pool, runningVcpu: 8, budget, targets })).toEqual([]);
    });

    it('counts booting toward targets and all pool states against capacity', () => {
        const budget = { maxGlobalVcpu: 100, maxHosts: 100, maxBootsPerPass: 100 };
        expect(replenishPlan({ pool, runningVcpu: 8, budget, targets: [targets[1]!] })).toEqual([
            { region: 'ap-south-1', instanceType: 'm6i.large', count: 8 },
        ]);
        expect(replenishPlan({ pool, runningVcpu: 0, budget: { ...budget, maxGlobalVcpu: 8 }, targets })).toEqual([]);
        expect(replenishPlan({ pool, runningVcpu: 8, budget, targets: [{ ...targets[1]!, count: 1 }] })).toEqual([]);
    });

    it('is deterministic under input reordering, without mutating inputs', () => {
        const args = { pool, runningVcpu: 8, budget: { maxGlobalVcpu: 32, maxHosts: 12, maxBootsPerPass: 10 }, targets };
        const before = JSON.stringify(args);
        expect(replenishPlan(args)).toEqual(replenishPlan({ ...args, pool: [...pool].reverse(), targets: [...targets].reverse() }));
        expect(JSON.stringify(args)).toBe(before);
    });

    it('continues to a smaller type when remaining vCPU cannot fit a larger one', () => {
        expect(replenishPlan({ pool: [], runningVcpu: 0, budget: { maxGlobalVcpu: 6, maxHosts: 10, maxBootsPerPass: 10 },
            targets: targets.filter(t => t.region === 'us-east-1') })).toEqual([
            { region: 'us-east-1', instanceType: 'm6i.xlarge', count: 1 },
        ]);
    });

    it.each([-1, NaN, Infinity, 1.5])('refuses malformed capacity %s instead of creating headroom', n => {
        expect(() => replenishPlan({ pool, runningVcpu: n, budget: { maxGlobalVcpu: 100, maxHosts: 100, maxBootsPerPass: 10 }, targets })).toThrow('pool_count_invalid');
    });

    it('refuses duplicate targets', () => {
        expect(() => replenishPlan({ pool: [], runningVcpu: 0, budget: { maxGlobalVcpu: 100, maxHosts: 100, maxBootsPerPass: 10 },
            targets: [targets[0]!, targets[0]!] })).toThrow('pool_target_duplicate');
    });
});
