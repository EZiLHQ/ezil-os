import { describe, expect, it } from 'vitest';

import { PUBLIC_STANDARD_TRIAL_METADATA_KEY as KEY, publicStandardTrialEnabledFromStripe as enabled } from './public-standard-trial';

const product = () => ({ id: 'prod_standard', active: true, livemode: false, metadata: {} as Record<string, string> });
const price = () => ({ id: 'price_standard', lookup_key: 'ezil_standard_monthly_v3', active: true, livemode: false,
    type: 'recurring', unit_amount: 2000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 }, product: product() });
const page = () => ({ has_more: false, data: [price()] });

describe('Stripe-controlled public Standard trial', () => {
    it('preserves default on only for the fully verified canonical Product, and accepts explicit true/false', () => {
        const value = page();
        expect(enabled(value, false)).toBe(true);
        value.data[0]!.product.metadata[KEY] = 'true';
        expect(enabled(value, false)).toBe(true);
        value.data[0]!.product.metadata[KEY] = 'false';
        expect(enabled(value, false)).toBe(false);
    });
    it.each(['', 'TRUE', 'False', 'on', 'off', '1', '0', 'false '])('unknown value %j fails closed', value => {
        const raw = page(); raw.data[0]!.product.metadata[KEY] = value;
        expect(enabled(raw, false)).toBe(false);
    });
    it.each([
        {}, { has_more: false, data: [] }, { has_more: true, data: [price()] }, { has_more: false, data: [price(), price()] },
        ...[{ active: false }, { lookup_key: 'ezil_premium_monthly_v3' }, { unit_amount: 2001 }, { currency: 'eur' },
            { type: 'one_time' }, { recurring: null }, { recurring: { interval: 'year', interval_count: 1 } },
            { recurring: { interval: 'month', interval_count: 2 } }, { product: 'prod_standard' },
            { product: { ...product(), active: false } }, { product: { id: 'prod_standard', active: true, livemode: false } },
            { product: { ...product(), metadata: null } }].map(change => ({ has_more: false, data: [{ ...price(), ...change }] })),
    ])('malformed, ambiguous or mismatched catalog %# never enables', raw => { expect(enabled(raw, false)).toBe(false); });
    it('binds both Price and expanded Product to the active Stripe key mode', () => {
        const raw = page();
        expect(enabled(raw, true)).toBe(false);
        raw.data[0]!.livemode = true;
        expect(enabled(raw, false)).toBe(false);
        expect(enabled(raw, true)).toBe(false);
        raw.data[0]!.product.livemode = true;
        expect(enabled(raw, true)).toBe(true);
    });
});
