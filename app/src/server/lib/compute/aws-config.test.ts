import { describe, expect, it } from 'vitest';
import type { SizeCode } from '@/server/billing/v2/contract';
import { AWS_TIERS, AWS_TIER_DATA_GIB, INSTANCE_VCPU, awsTierForSize, instanceTypeForTier, instanceVcpu, sizeForInstanceType } from './aws-config';
import { KNOWN_INSTANCE_TYPES } from './aws-intent';

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
