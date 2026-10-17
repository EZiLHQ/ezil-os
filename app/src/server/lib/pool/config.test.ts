import { describe, expect, it } from 'vitest';

import { parsePoolConfig, POOL_HARD_MAX } from './config';
import { COMPUTE_SHAPES, eligibleShapes } from './shapes';

describe('pool configuration and compute catalog', () => {
    it('is off by default, with the contract reserve and TTL', () => {
        expect(parsePoolConfig({})).toEqual({
            enabled: false, targets: { standard: 0, performance: 0 }, maxTotal: 0,
            subscriberReserve: 1, readyTtlSeconds: 1800,
        });
        expect(parsePoolConfig({ POOL_TARGET_STANDARD: '2' }).enabled).toBe(false);
        expect(parsePoolConfig({ POOL_MAX_TOTAL: '2' }).enabled).toBe(false);
    });

    it('clamps capacity to a constant eight, ignoring an env hard-max override', () => {
        const config = parsePoolConfig({ POOL_TARGET_STANDARD: '200', POOL_TARGET_PERFORMANCE: '99',
            POOL_MAX_TOTAL: '100', POOL_HARD_MAX: '500' });
        expect(POOL_HARD_MAX).toBe(8);
        expect(config).toMatchObject({ enabled: true, maxTotal: 8, targets: { standard: 8, performance: 8 } });
    });

    it.each(['-1', '1.5', '2junk', '', 'NaN', 'Infinity', '99999999999999999999999'])('fails closed on invalid capacity %s', (value) => {
        const config = parsePoolConfig({ POOL_TARGET_STANDARD: value, POOL_MAX_TOTAL: value });
        expect(config.enabled).toBe(false);
        expect(config.maxTotal).toBe(0);
    });

    it('offers exactly the C1 shapes and reserves performance for subscribers', () => {
        expect(COMPUTE_SHAPES.map(({ id, vcpu, memoryGiB, diskGB }) => ({ id, vcpu, memoryGiB, diskGB }))).toEqual([
            { id: 'standard', vcpu: 2, memoryGiB: 6, diskGB: 16 },
            { id: 'performance', vcpu: 4, memoryGiB: 12, diskGB: 20 },
        ]);
        expect(eligibleShapes('free').map((shape) => shape.id)).toEqual(['standard']);
        expect(eligibleShapes('subscriber').map((shape) => shape.id)).toEqual(['standard', 'performance']);
    });
});
