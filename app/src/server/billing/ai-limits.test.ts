import { describe, expect, it } from 'vitest';
import { parseAiLimits } from './ai-limits';

describe('member limits projection', () => {
    it('reads the actual nested effective policy, ceilings, counters and pauses without leaking reasons', () => {
        const result = parseAiLimits({ account_public_id: 'private-id', policy: { policy: { rpm: 20, concurrency: 0,
            daily_budget_micro: '9007199254740991000000', allowed_models: ['ezil-code'] }, sources: { rpm: 'user' } },
        models: { 'ezil-code': { policy: { tpm: 500 } } }, ceilings: { rpm: 10, concurrency: 3 },
        counters: { rpm: 0, tpm: 2, inflight: 2, pending: 1, open_micro: '1000001', day_micro: '1000002', month_micro: '2000002' },
        pauses: [{ scope: 'user', reason: 'private operator reason', target: 'private-target' }],
        entitlement: { required: true, basis: 'subscription', subscription: { id: 'private-subscription' } } });
        expect(result).toMatchObject({ state: 'available', limits: { policy: { rpm: 20, concurrency: 0, dailyBudgetMicro: '9007199254740991000000' },
            ceilings: { rpm: 10, concurrency: 3 }, counters: { rpm: 0, openMicro: '1000001', dayMicro: '1000002', monthMicro: '2000002' },
            pauses: [{ scope: 'user' }], entitlement: { required: true, basis: 'subscription' }, models: { 'ezil-code': { tpm: 500 } } } });
        expect(JSON.stringify(result)).not.toMatch(/private|sources|subscription_id/);
    });
    it('retains valid partial data; absent, malformed and zero limits stay distinct', () => {
        expect(parseAiLimits(null)).toEqual({ state: 'unavailable', limits: null });
        expect(parseAiLimits({})).toEqual({ state: 'unavailable', limits: null });
        expect(parseAiLimits({ policy: { policy: { rpm: 0, concurrency: -1, monthly_budget_micro: 1.5 } },
            counters: { inflight: 1 }, pauses: [{ scope: 'invented' }] })).toMatchObject({ state: 'available', limits: {
            policy: { rpm: 0, concurrency: null, dailyBudgetMicro: null, monthlyBudgetMicro: null },
            ceilings: null, counters: { inflight: 1, pending: null, dayMicro: null }, pauses: null, entitlement: null,
        } });
    });
    it('does not treat an ambiguous policy as effective', () => {
        expect(parseAiLimits({ policy: { ambiguous: true, policy: { rpm: 20 } }, pauses: [] })).toMatchObject({ limits: { policy: null, pauses: [] } });
    });
    it('rejects coerced pause scopes and entitlement bases', () => {
        expect(parseAiLimits({ pauses: [{ scope: ['user'] }], entitlement: { required: true, basis: ['subscription'] } }))
            .toEqual({ state: 'unavailable', limits: null });
    });
});
