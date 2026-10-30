import { describe, expect, it } from 'vitest';
import type { SizeCode } from '@/server/billing/v2/contract';
import { AWS_TIERS, AWS_TIER_DATA_GIB, INSTANCE_VCPU, awsCanaryConfig, awsDirectSince, awsTierForSize, instanceTypeForTier, instanceVcpu, sizeForInstanceType, meteredSizeForInstanceType } from './aws-config';
import { KNOWN_INSTANCE_TYPES } from './aws-intent';

describe('direct AWS creation cutoff', () => {
    it.each([undefined, '', ' ', '2026-10-14', '2026-10-14T00:00:00', 'yesterday', '2026-13-40T00:00:00Z'])('fails closed for SINCE %j', since => {
        expect(awsDirectSince({ EZIL_AWS_CANARY_SINCE: since })).toBeNull();
    });

    it.each(['2026-10-14T00:00Z', ' 2026-10-14T00:00:00Z ', '2026-10-14T05:30:00+05:30', '2026-10-14T00:00:00.000000000Z'])('shares the strict canary grammar for %j without requiring a user list', since => {
        const env = { EZIL_AWS_CANARY_SINCE: since };
        expect(awsDirectSince(env)).toEqual(new Date('2026-10-14T00:00:00Z'));
        expect(awsCanaryConfig({ ...env, EZIL_AWS_CANARY_USER_IDS: '*' })?.since).toEqual(awsDirectSince(env));
        expect(awsCanaryConfig(env)).toBeNull();
        expect(awsDirectSince({ ...env, EZIL_AWS_CANARY_USER_IDS: 'not-a-uuid' })).toEqual(awsDirectSince(env));
    });
});

describe('billing v2 AWS sizes', () => {
    it.each([
        ['std-2', 'plus', 'm6i.large'],
        ['cmp-4', 'compute4', 'm6i.xlarge'],
        ['cmp-8', 'compute8', 'm6i.2xlarge'],
    ] as const)('%s selects tier %s and type %s with 50 GiB data', (size, tier, type) => {
        expect(awsTierForSize(size)).toBe(tier);
        expect(AWS_TIERS[tier]).toEqual([type]);
        expect(instanceTypeForTier(tier)).toBe(type);
        expect(AWS_TIER_DATA_GIB[tier]).toBe(50);
    });

    it('free-cf has no AWS tier; legacy free AWS data stays 20 GiB', () => {
        expect(awsTierForSize('free-cf')).toBeNull();
        expect(AWS_TIER_DATA_GIB.free).toBe(20);
    });

    it('every known type has a vCPU count in allowlist order', () => {
        expect(Object.keys(INSTANCE_VCPU)).toEqual(KNOWN_INSTANCE_TYPES);
    });

    it.each<[string, number, SizeCode]>([
        ['t3a.medium', 2, 'std-2'], ['t3.medium', 2, 'std-2'], ['m6i.large', 2, 'std-2'],
        ['c6i.xlarge', 4, 'cmp-4'], ['m6i.xlarge', 4, 'cmp-4'], ['m6i.2xlarge', 8, 'cmp-8'],
    ])('%s consumes %i vCPU and meters as %s', (type, vcpu, size) => {
        expect(instanceVcpu(type)).toBe(vcpu);
        expect(sizeForInstanceType(type)).toBe(size);
    });

    it.each([null, undefined, '', 'unknown', 'toString', '__proto__', 'constructor'])('unknown type %j fails closed at cmp-8', type => {
        expect(instanceVcpu(type)).toBe(8);
        expect(sizeForInstanceType(type)).toBe('cmp-8');
    });
});

describe('metered AWS sizes', () => {
    it('does not accept an inherited vCPU mapping as an explicitly listed machine', () => {
        const type = 'unlisted.test-machine';
        Object.defineProperty(Object.prototype, type, { value: 2, configurable: true });
        try {
            expect(meteredSizeForInstanceType(type)).toBeNull();
            expect(instanceVcpu(type)).toBe(8);
        } finally {
            Reflect.deleteProperty(Object.prototype, type);
        }
    });

    it.each([
        ['t3a.medium', 'std-2'], ['t3.medium', 'std-2'], ['m6i.large', 'std-2'],
        ['c6i.xlarge', 'cmp-4'], ['m6i.xlarge', 'cmp-4'], ['m6i.2xlarge', 'cmp-8'],
    ] as const)('meters listed type %s as %s', (type, size) => {
        expect(meteredSizeForInstanceType(type)).toBe(size);
    });

    it.each([null, undefined, '', 'unknown', 'm7g.large', 'toString', '__proto__', 'constructor'])
    ('does not meter %j while capacity still counts 8 vCPU', type => {
        expect(meteredSizeForInstanceType(type)).toBeNull();
        expect(instanceVcpu(type)).toBe(8);
    });
});
