import { describe, expect, it } from 'vitest';

import {
    CATALOG_V2,
    FREE_V2_EFFECTIVE_AT,
    OVERAGE_CENTS_PER_STD_HOUR,
    OVERAGE_DEFAULT_CAP_CENTS,
    OVERAGE_MAX_CAP_CENTS,
    SECONDS_PER_HOUR,
    SESSION_MAX_SECONDS,
    SIZES,
    STD_SECONDS_PER_OVERAGE_CENT,
    type PlanSku,
} from './contract';
import golden from './fixtures/golden.json';

describe('billing contract v2 (pinned constants)', () => {
    it('prices overage at exactly $0.25 per standard-hour in whole cents', () => {
        expect(SECONDS_PER_HOUR / OVERAGE_CENTS_PER_STD_HOUR).toBe(STD_SECONDS_PER_OVERAGE_CENT);
        expect(Number.isInteger(STD_SECONDS_PER_OVERAGE_CENT)).toBe(true);
        // 100 standard-hours over = $25.
        expect((100 * SECONDS_PER_HOUR) / STD_SECONDS_PER_OVERAGE_CENT).toBe(2_500);
    });

    it('weights sizes by vCPU relative to 2 vCPU and never offers unverified ARM', () => {
        for (const size of Object.values(SIZES)) {
            expect(size.weight).toBe(size.vcpu / 2);
            expect(size.arm === null || size.arm.archVerified === false).toBe(true);
        }
        expect(SIZES['free-cf'].memoryGiB).toBe(6);
        expect(SIZES['std-2'].memoryGiB).toBe(8);
        expect(SIZES['free-cf'].provider).toBe('cloudflare');
        expect(SIZES['std-2'].provider).toBe('aws');
    });

    it('pins the commercial terms of every offer', () => {
        const terms = (sku: PlanSku) => {
            const o = CATALOG_V2[sku];
            return [o.priceCents, o.allowanceStdSeconds, o.sizes.join(','), o.sellable, o.overage !== null];
        };
        expect(terms('standard_monthly_v2')).toEqual([2_000, 216_000, 'std-2', true, false]);
        expect(terms('compute_monthly_v2')).toEqual([10_000, 1_800_000, 'std-2,cmp-4,cmp-8', true, true]);
        expect(terms('free_v2')).toEqual([0, 7_200, 'free-cf', false, false]);
        expect(terms('free_v1_legacy')).toEqual([0, 28_800, 'free-cf', false, false]);
        expect(terms('pro_monthly_v1')).toEqual([2_000, 72_000, 'std-2', false, false]);
        // 500 standard-hours = 125 actual hours at 8 vCPU.
        expect(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds / SIZES['cmp-8'].weight).toBe(125 * SECONDS_PER_HOUR);
    });

    it('keeps overage opt-in, separately billed and capped inside the platform ceiling', () => {
        const overage = CATALOG_V2.compute_monthly_v2.overage!;
        expect(overage.requiresConsent).toBe(true);
        expect(overage.billedSeparately).toBe(true);
        expect(OVERAGE_DEFAULT_CAP_CENTS).toBe(2_500);
        expect(OVERAGE_DEFAULT_CAP_CENTS).toBeLessThanOrEqual(OVERAGE_MAX_CAP_CENTS);
    });

    it('uses unique immutable lookup keys only for sellable offers', () => {
        const keys = Object.values(CATALOG_V2).filter(o => o.sellable).map(o => o.stripeLookupKey);
        expect(keys).toEqual(['ezil_standard_monthly_v2', 'ezil_compute_monthly_v2']);
        for (const o of Object.values(CATALOG_V2)) {
            if (!o.sellable) expect(o.stripeLookupKey).toBeNull();
            expect(o.storageOffered).toBe(false);
            expect(o.maxConcurrentComputers).toBe(1);
        }
    });

    it('does not silently move existing Free accounts to 2 h', () => {
        expect(FREE_V2_EFFECTIVE_AT).toBeNull();
    });

    it('bounds a session at 6 hours', () => {
        expect(SESSION_MAX_SECONDS).toBe(6 * SECONDS_PER_HOUR);
    });
});

describe('golden fixtures (independent oracle)', () => {
    const byName = <T extends { name: string }>(rows: T[], name: string): T => {
        const row = rows.find(r => r.name === name);
        if (!row) throw new Error(`missing golden case ${name}`);
        return row;
    };

    it('contains the acceptance arithmetic rows', () => {
        expect(byName(golden.rateWindow, 'compute_cmp8_150h_is_600_std_hours').expected.stdSeconds).toBe(2_160_000);
        expect(byName(golden.ratePeriod, 'compute_600_std_hours_is_25_dollars').expected.billableOverageCents).toBe(2_500);
        expect(byName(golden.ratePeriod, 'over_by_143s_is_0_cents').expected.overageCents).toBe(0);
        expect(byName(golden.ratePeriod, 'over_by_144s_is_1_cent').expected.overageCents).toBe(1);
        expect(byName(golden.ratePeriod, 'standard_never_bills_overage').expected.billableOverageCents).toBe(0);
        expect(byName(golden.rateWindow, 'open_epoch_past_session_bound_is_capped').expected.stdSeconds).toBe(SESSION_MAX_SECONDS);
        expect(byName(golden.upgradeGrant, 'upgrade_after_10_days').expected).toBe(1_056_000);
    });

    it('splits a boundary-crossing epoch without losing or double-counting a second', () => {
        const nov = byName(golden.rateWindow, 'period_boundary_split_november_side').expected.stdSeconds;
        const dec = byName(golden.rateWindow, 'period_boundary_split_december_side').expected.stdSeconds;
        expect(nov + dec).toBe(3_600);
    });
});
