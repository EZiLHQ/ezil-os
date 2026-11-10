import { describe, expect, it, vi } from 'vitest';
import { awsDepsFor } from '@/server/api/routers/compute-dispatch';
import { paidComputeUnmetered, paidUserHoursExemption, PAID_COMPUTE_POLICY_VERSION, UNMETERED_PAID_PLAN_IDS } from './paid-compute-policy';
import type { EntitlementRecord } from './tier';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));

const active = (planId: string, over: Partial<EntitlementRecord> = {}): EntitlementRecord =>
    ({ source: 'billing_v2', status: 'active', planId, provider: 'aws', size: 'std-2', paymentIssue: false, ...over });

describe('paid compute policy v1 (founder e713d157)', () => {
    it('is version 1 and names only Standard and Premium', () => {
        expect(PAID_COMPUTE_POLICY_VERSION).toBe(1);
        expect(UNMETERED_PAID_PLAN_IDS).toEqual(['standard_monthly_v3', 'premium_monthly_v3']);
    });
    it('exempts a verified active Standard or Premium plan (the Standard trial reads active), nothing else', () => {
        expect(paidComputeUnmetered(active('standard_monthly_v3'))).toBe(true);
        expect(paidComputeUnmetered(active('premium_monthly_v3'))).toBe(true);
        for (const [name, record] of [
            ['no record', null], ['not read', undefined], ['Free', active('free_v3')], ['legacy v2', active('standard_monthly_v2')],
            ['expired (no paid-period receipt)', active('premium_monthly_v3', { status: 'expired' })],
            ['past due', active('premium_monthly_v3', { status: 'past_due', paymentIssue: true })],
            ['payment issue', active('standard_monthly_v3', { paymentIssue: true })],
            ['cancelled (runs as Free)', active('free_v3', { provider: 'cloudflare' })],
            ['not from billing', { status: 'active', planId: 'premium_monthly_v3' }],
            ['an operator list entry', { source: 'billing_v2', status: 'active', planId: 'plus_operator' }],
        ] as const) expect(paidComputeUnmetered(record as EntitlementRecord | null | undefined), name).toBe(false);
    });
    it('reads billing once per owner, and any failure is not exempt (the per-person cap keeps applying)', async () => {
        const read = vi.fn(async (userId: string) => userId === 'paid' ? active('premium_monthly_v3') : userId === 'free' ? active('free_v3') : null);
        const exempt = paidUserHoursExemption({ read });
        expect(await exempt('paid')).toBe(true);
        expect(await exempt('PAID')).toBe(true);
        expect(await exempt('free')).toBe(false);
        expect(await exempt('unknown')).toBe(false);
        expect(read).toHaveBeenCalledTimes(3);
        expect(await paidUserHoursExemption({ read: async () => { throw new Error('billing down'); } })('paid')).toBe(false);
    });
    it('the AWS provider deps decide the caller exemption from the same resolved entitlement', async () => {
        expect(await awsDepsFor({}, active('premium_monthly_v3')).paidCompute()).toBe(true);
        expect(await awsDepsFor({}, async () => active('standard_monthly_v3')).paidCompute()).toBe(true);
        expect(await awsDepsFor({}, null).paidCompute()).toBe(false);
        expect(await awsDepsFor({}, async () => active('free_v3')).paidCompute()).toBe(false);
    });
});
