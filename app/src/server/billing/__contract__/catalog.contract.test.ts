import { describe, expect, it, vi } from 'vitest';
import {
    AI_PACKS, CATALOG_VERSION, FREE_PLAN, PRO_PLAN, catalogPro,
    findPack, serviceFeeCents, storageCapBytes, workspaceAllowanceSeconds,
} from '../catalog';
import { checkoutAvailable, readBillingConfig } from '../config';

/** Independent expectations come from the frozen prices and gates in contract §§2 and 7. */
describe('billing catalog contract', () => {
    it('keeps versioned Pro at $20 USD monthly and the documented allowances', () => {
        expect(CATALOG_VERSION).toBe(1);
        expect(catalogPro()).toEqual({
            sku: 'pro_monthly_v1', unitAmountCents: 2000, currency: 'usd', interval: 'month',
        });
        expect(FREE_PLAN.sku).toBe('free_v1');
        expect(workspaceAllowanceSeconds('free')).toBe(28_800);
        expect(workspaceAllowanceSeconds('pro')).toBe(72_000);
        expect(FREE_PLAN.aiTrialMicro).toBe(BigInt(500_000));
        expect(PRO_PLAN.aiIncludedMicro).toBe(BigInt(3_000_000));
    });

    it.each([0, 1, 100, 999, 1000, 2500, 10_000])('charges the ceiling service fee for %i cents', credit => {
        const total = Math.ceil((credit + 30) / 0.951);
        expect(serviceFeeCents(credit)).toBe(total - credit);
        expect(total * 0.951 - 30).toBeGreaterThanOrEqual(credit);
        // The previous whole-cent total must fail to cover the credit.
        expect((total - 1) * 0.951 - 30).toBeLessThan(credit);
    });

    it('lists both packs with face value, flat service fee and total', () => {
        expect(AI_PACKS).toEqual([
            { sku: 'ai_pack_10_v1', creditCents: 1000, serviceFeeCents: 84, totalCents: 1084 },
            { sku: 'ai_pack_25_v1', creditCents: 2500, serviceFeeCents: 161, totalCents: 2661 },
        ]);
        expect(findPack('ai_pack_10_v1')).toEqual(AI_PACKS[0]);
        expect(findPack('ai_pack_25_v1')).toEqual(AI_PACKS[1]);
        expect(findPack('unrecognised_sku')).toBeUndefined();
    });

    it('raises only Pro storage and only after the large-storage gate', () => {
        expect(storageCapBytes('pro', true)).toBe(BigInt(20_000_000_000));
        expect(storageCapBytes('pro', false)).toBe(BigInt(2_000_000_000));
        expect(storageCapBytes('free', true)).toBe(BigInt(2_000_000_000));
        expect(storageCapBytes('free', false)).toBe(BigInt(2_000_000_000));
    });
});

const flags = [
    ['BILLING_TAB_ENABLED', 'tabEnabled'],
    ['PRICING_PAGE_ENABLED', 'pricingPageEnabled'],
    ['CHECKOUT_ENABLED', 'checkoutEnabled'],
    ['BILLING_ENFORCEMENT', 'enforcementEnabled'],
    ['BILLING_LARGE_STORAGE', 'largeStorageEnabled'],
] as const;

describe('billing configuration contract', () => {
    it.each(flags)('enables %s only for the exact string 1', (envKey, configKey) => {
        expect(readBillingConfig({ [envKey]: '1' })[configKey]).toBe(true);
        for (const value of [undefined, '', '0', 'true', 'TRUE', 'yes', '01', '1 ', ' 1', '\n1']) {
            expect(readBillingConfig({ [envKey]: value })[configKey]).toBe(false);
        }
    });

    it('requires both the checkout flag and a nonempty key', () => {
        expect(checkoutAvailable(readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'synthetic-key' }))).toBe(true);
        expect(checkoutAvailable(readBillingConfig({ STRIPE_SECRET: 'synthetic-key' }))).toBe(false);
        for (const value of [undefined, '', '   ']) {
            expect(checkoutAvailable(readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: value }))).toBe(false);
        }
    });

    it('does not log synthetic secrets or expose them through availability consumers', () => {
        const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
        const spies = methods.map(method => vi.spyOn(console, method));
        const env = {
            CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'synthetic-stripe-key',
            STRIPE_WEBHOOK_SECRET: 'synthetic-webhook-key', STRIPE_PRICE_PRO_MONTHLY: 'synthetic-price',
            BILLING_USAGE_HMAC_SECRET: 'synthetic-usage-key', BILLING_FUNDING_URL: 'synthetic-funding-url',
            BILLING_FUNDING_HMAC_SECRET: 'synthetic-funding-key',
        };
        try {
            const configured = readBillingConfig(env);
            expect(configured.stripeSecret).toBe(env.STRIPE_SECRET);
            expect(checkoutAvailable(configured)).toBe(true);
            expect(checkoutAvailable(readBillingConfig({}))).toBe(false);
            const publicResult = JSON.stringify({ checkout: checkoutAvailable(configured), catalog: catalogPro() });
            expect(JSON.parse(publicResult).checkout).toBe(true);
            for (const value of Object.values(env).filter(value => value !== '1')) {
                expect(publicResult).not.toContain(value);
            }
            // A positive control proves each spy actually observes console calls.
            for (const [index, spy] of spies.entries()) {
                expect(spy).not.toHaveBeenCalled();
                spy.mockImplementation(() => undefined);
                console[methods[index]!]('contract-positive-control');
                expect(spy).toHaveBeenCalledWith('contract-positive-control');
            }
        } finally {
            for (const spy of spies) spy.mockRestore();
        }
    });
});
