import { describe, expect, it } from 'vitest';
import { planFromSubscriptions } from './catalog';
import {
    isOperatorOverrideSku, isOperatorSku, operatorAccess, operatorGrantInEffect, operatorOverrideInEffect, operatorPlan, type OperatorEntitlementRow,
} from './operator-access';

const NOW = new Date('2026-11-25T12:00:00.000Z');
const at = (ms: number) => new Date(NOW.getTime() + ms);
const row = (over: Partial<OperatorEntitlementRow>): OperatorEntitlementRow => ({ ref: 'osg-1', revision: 1, userId: 'u', accountPublicId: 'a',
    sku: 'standard_monthly_v3', startsAt: at(-60_000), endsAt: null, endedAt: null, ...over });

describe('operator access primitives with explicit overrides (0038)', () => {
    it('isOperatorSku stays paid-only; isOperatorOverrideSku adds Free', () => {
        expect(['free_v3', 'standard_monthly_v3', 'premium_monthly_v3', 'legacy'].map(isOperatorSku)).toEqual([false, true, true, false]);
        expect(['free_v3', 'standard_monthly_v3', 'premium_monthly_v3', 'legacy'].map(isOperatorOverrideSku)).toEqual([true, true, true, false]);
    });
    it('operatorGrantInEffect never returns an override; operatorOverrideInEffect returns only an unexpired, unended one', () => {
        const grant = row({ ref: 'osg-grant' });
        const free = row({ ref: 'osg-free', sku: 'free_v3', accessOverride: true, startsAt: at(-1_000) });
        expect(operatorGrantInEffect([free, grant], NOW)).toBe(grant);
        expect(operatorGrantInEffect([free], NOW)).toBeNull();
        expect(operatorGrantInEffect([row({ sku: 'premium_monthly_v3', accessOverride: true })], NOW)).toBeNull();
        expect(operatorOverrideInEffect([grant, free], NOW)).toBe(free);
        expect(operatorOverrideInEffect([grant], NOW)).toBeNull();
        expect(operatorOverrideInEffect([{ ...free, endsAt: NOW }], NOW)).toBeNull();
        expect(operatorOverrideInEffect([{ ...free, endsAt: at(1) }], NOW)).not.toBeNull();
        expect(operatorOverrideInEffect([{ ...free, endedAt: NOW }], NOW)).toBeNull();
        // A Free row that is not an override is never access of either kind.
        expect(operatorGrantInEffect([row({ sku: 'free_v3' })], NOW)).toBeNull();
        expect(operatorOverrideInEffect([row({ sku: 'free_v3' })], NOW)).toBeNull();
    });
    it('operatorAccess (the ordinary rule readers use today) is unchanged by an override row', () => {
        const override = row({ ref: 'osg-o', sku: 'premium_monthly_v3', accessOverride: true });
        expect(operatorAccess({ grants: [override], now: NOW, stripePaidAccess: false })).toBeNull();
        const grant = row({ ref: 'osg-g' });
        expect(operatorAccess({ grants: [override, grant], now: NOW, stripePaidAccess: false })).toBe(grant);
        expect(operatorAccess({ grants: [override, grant], now: NOW, stripePaidAccess: true })).toBeNull();
    });
    it('operatorPlan: a paid row gives the paid offer; a Free override gives the Free plan carrying the row', () => {
        const free = planFromSubscriptions({ subs: [], now: NOW, userCreatedAt: null });
        expect(operatorPlan(row({ sku: 'premium_monthly_v3' }), free)).toMatchObject({ sku: 'premium_monthly_v3', planActive: true, subscriptionId: null });
        const override = row({ sku: 'free_v3', accessOverride: true });
        expect(operatorPlan(override, free)).toEqual({ ...free, operator: override });
    });
});
