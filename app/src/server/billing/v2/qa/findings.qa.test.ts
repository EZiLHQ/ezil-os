/**
 * QA FINDINGS (pure). Each test states a CONTRACT-v2 rule and FAILS at base
 * 14195711. Intentionally red: a passing run here means the defect is fixed.
 */
import { describe, expect, it } from 'vitest';

import { admitStart } from '../rating';

describe('qa FINDINGS (admission)', () => {
    const base = {
        planActive: true, paymentIssue: false, upgradePending: false, runningComputers: 0, now: '2026-11-10T09:00:00Z',
    } as const;

    it('F-ADMIT-OVERAGE: Standard is a hard stop — an overage input never adds headroom', () => {
        const d = admitStart({ ...base, planSku: 'standard_monthly_v2', size: 'std-2', allowanceStdSeconds: 216_000,
            usedStdSeconds: 216_000, overage: { enabled: true, capCents: 10_000 } });
        expect(d).toEqual({ admit: false, reason: 'allowance_exhausted' });
    });

    it('F-ADMIT-OVERAGE: Free never gets overage headroom', () => {
        const d = admitStart({ ...base, planSku: 'free_v2', size: 'free-cf', allowanceStdSeconds: 7_200,
            usedStdSeconds: 7_200, overage: { enabled: true, capCents: 10_000 } });
        expect(d).toEqual({ admit: false, reason: 'allowance_exhausted' });
    });

    it('F-ADMIT-OVERAGE: a cap above OVERAGE_MAX_CAP_CENTS never widens headroom past $100', () => {
        const d = admitStart({ ...base, planSku: 'compute_monthly_v2', size: 'std-2', allowanceStdSeconds: 1_800_000,
            usedStdSeconds: 1_800_000 + 10_000 * 144, overage: { enabled: true, capCents: 1_000_000 } });
        expect(d).toEqual({ admit: false, reason: 'overage_cap_reached' });
    });
});
