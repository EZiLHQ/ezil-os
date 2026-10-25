import { describe, expect, it } from 'vitest';
import { aiCreditEntitlement, aiCreditOutboxItem, aiCreditRevokeItem } from './ai-credits';

const input = { userId: 'user', sku: 'standard_monthly_v3' as const, subscriptionId: 'sub',
    periodStart: new Date('2026-10-01T00:00:00Z'), periodEnd: new Date('2026-11-01T00:00:00Z'), invoiceId: 'invoice' };

describe('AI credit planning', () => {
    it('reverses the immutable receipt and strips grant delivery metadata', () => {
        const grant = aiCreditOutboxItem('user', aiCreditEntitlement(input), 'grant', 'invoice');
        Object.assign(grant.payload, { credits: 1234, accountPublicId: 'original-account', delivery: { status: 'done' } });
        const revoke = aiCreditRevokeItem(grant);
        expect(revoke).toMatchObject({ kind: 'ai_revoke', eventKey: `${grant.payload.entitlementId}:revoke`,
            payload: { credits: 1234, policyVersion: 1, action: 'revoke', accountPublicId: 'original-account' } });
        expect(revoke.payload).not.toHaveProperty('delivery');
        expect(grant.payload.action).toBe('grant');
    });
    it.each([['standard_monthly_v3', 4000], ['premium_monthly_v3', 20000]] as const)('plans %s with deterministic period ids and grace', (sku, credits) => {
        const grant = aiCreditEntitlement({ ...input, sku });
        expect(grant).toEqual({ entitlementId: `ezil-os:v1:${sku}:sub:2026-10-01T00:00:00.000Z`, credits,
            expiresAt: '2026-11-04T00:00:00.000Z' });
        expect(aiCreditEntitlement({ ...input, sku, invoiceId: 'another-invoice' })).toEqual(grant);
        expect(aiCreditOutboxItem('user', grant, 'grant', 'invoice').eventKey).toBe(`${grant.entitlementId}:grant`);
        expect(aiCreditOutboxItem('user', grant, 'revoke', 'invoice').eventKey).toBe(`${grant.entitlementId}:revoke`);
    });
    it('gives Free 500 credits once with exactly 365 days, including leap years', () => {
        const free = { ...input, sku: 'free_v3' as const, subscriptionId: null, invoiceId: null, periodEnd: null,
            periodStart: new Date('2024-02-29T12:00:00Z') };
        expect(aiCreditEntitlement(free)).toEqual({ entitlementId: 'ezil-os:v1:free-once:user', credits: 500,
            expiresAt: '2025-02-28T12:00:00.000Z' });
        expect(aiCreditEntitlement({ ...free, periodStart: input.periodStart }).entitlementId).toBe('ezil-os:v1:free-once:user');
        expect(aiCreditEntitlement({ ...free, userId: 'other' }).entitlementId).not.toBe(aiCreditEntitlement(free).entitlementId);
    });
    it.each([{ subscriptionId: 'other' }, { sku: 'premium_monthly_v3' as const }, { periodStart: new Date('2026-10-02Z') }])
    ('isolates distinct paid entitlements %j', change => {
        expect(aiCreditEntitlement({ ...input, ...change }).entitlementId).not.toBe(aiCreditEntitlement(input).entitlementId);
    });
    it.each([{ userId: '' }, { periodStart: new Date('invalid') }, { periodEnd: null }, { periodEnd: new Date('invalid') },
        { periodEnd: input.periodStart }, { subscriptionId: null }, { invoiceId: null }])('rejects invalid grant inputs %j', change => {
        expect(() => aiCreditEntitlement({ ...input, ...change })).toThrow(TypeError);
    });
});
