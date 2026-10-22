import { afterEach, describe, expect, it, vi } from 'vitest';

import { plusPlanIds, resolveEntitlement, resolveTier, tierForEntitlement, type EntitlementReader, type EntitlementRecord } from './tier';

const user = '11111111-1111-4111-8111-111111111111';
const env = { EZIL_AWS_PLUS_PLAN_IDS: 'os-plus-monthly, os-plus-yearly' };
const reader = (value: unknown): EntitlementReader => ({ read: async () => value as never });

describe('billing v2 sizes', () => {
    const paid: EntitlementRecord = { source: 'billing_v2', status: 'active', planId: 'compute_monthly_v2', provider: 'aws', size: 'std-2', paymentIssue: false };

    it.each([['std-2', 'plus'], ['cmp-4', 'compute4'], ['cmp-8', 'compute8'], ['free-cf', 'free']] as const)(
        '%s maps to %s without the legacy plan list', (size, tier) => {
            expect(tierForEntitlement({ ...paid, size }, new Set())).toBe(tier);
        },
    );

    it.each([
        { paymentIssue: true }, { provider: 'cloudflare' }, { provider: undefined }, { size: undefined },
        { status: 'past_due' }, { status: 'expired' }, { size: 'unknown' }, { source: 'unknown' }, { planId: null },
    ])('missing or invalid billing evidence remains free (%j)', over => {
        expect(tierForEntitlement({ ...paid, ...over } as EntitlementRecord, new Set(['compute_monthly_v2']))).toBe('free');
    });

    it('resolves the record once and normalizes absent records to null', async () => {
        const read = vi.fn(async () => paid);
        expect(await resolveEntitlement(user, { read })).toBe(paid);
        expect(read).toHaveBeenCalledExactlyOnceWith(user);
        expect(await resolveEntitlement(user, undefined)).toBeNull();
        expect(await resolveEntitlement(user, reader(undefined))).toBeNull();
    });
});

afterEach(() => vi.restoreAllMocks());

describe('tier: plus only on positive evidence', () => {
    it('active entitlement on a listed plan → plus', async () => {
        await expect(resolveTier(user, reader({ status: 'active', planId: 'os-plus-monthly' }), env)).resolves.toBe('plus');
        await expect(resolveTier(user, reader({ status: 'active', planId: 'os-plus-yearly' }), env)).resolves.toBe('plus');
    });

    it('cancelled / expired / past_due / trialing on a listed plan → free', async () => {
        for (const status of ['cancelled', 'expired', 'past_due', 'trialing', 'ACTIVE', '']) {
            await expect(resolveTier(user, reader({ status, planId: 'os-plus-monthly' }), env)).resolves.toBe('free');
        }
    });

    it('missing data → free: no reader, no record, no plan, unlisted plan', async () => {
        await expect(resolveTier(user, undefined, env)).resolves.toBe('free');
        await expect(resolveTier(user, reader(null), env)).resolves.toBe('free');
        await expect(resolveTier(user, reader(undefined), env)).resolves.toBe('free');
        await expect(resolveTier(user, reader({ status: 'active', planId: null }), env)).resolves.toBe('free');
        await expect(resolveTier(user, reader({ status: 'active', planId: 'os-free' }), env)).resolves.toBe('free');
        await expect(resolveTier(user, reader({ status: 'active' }), env)).resolves.toBe('free');
    });

    it('no plus plans configured → nobody is plus, even an active paid plan', async () => {
        await expect(resolveTier(user, reader({ status: 'active', planId: 'os-plus-monthly' }), {})).resolves.toBe('free');
        await expect(resolveTier(user, reader({ status: 'active', planId: '' }), { EZIL_AWS_PLUS_PLAN_IDS: ' , ' })).resolves.toBe('free');
    });

    it('a reader that throws → free, never plus', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const broken: EntitlementReader = { read: async () => { throw new Error('subscription db down'); } };
        await expect(resolveTier(user, broken, env)).resolves.toBe('free');
    });

    it('the reader is asked about THIS user', async () => {
        const read = vi.fn(async () => ({ status: 'active', planId: 'os-plus-monthly' }));
        await resolveTier(user, { read }, env);
        expect(read).toHaveBeenCalledWith(user);
    });

    it('plan list parsing trims and drops empties', () => {
        expect([...plusPlanIds({ EZIL_AWS_PLUS_PLAN_IDS: ' a ,b,, ' })]).toEqual(['a', 'b']);
        expect(plusPlanIds({}).size).toBe(0);
        expect(tierForEntitlement({ status: 'active', planId: 'b' }, plusPlanIds({ EZIL_AWS_PLUS_PLAN_IDS: 'a,b' }))).toBe('plus');
    });
});
