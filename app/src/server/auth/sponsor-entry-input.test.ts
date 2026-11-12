import { describe, expect, it } from 'vitest';
import { sponsorCouponEntryPath, sponsorCouponFromQuery, sponsorEntryFromForm } from './sponsor-entry-input';
describe('coupon selection is bounded and has no client campaign or redirect authority', () => {
    it('keeps a plain registered-slug root URL', () => {
        expect(sponsorCouponEntryPath('staging-qa')).toBe('/sponsor/coupon?coupon=staging-qa');
        expect(sponsorCouponEntryPath('staging-qa', true)).toBe('/sponsor/coupon');
        expect(sponsorCouponFromQuery(new URLSearchParams('coupon=staging-qa'))).toBe('staging-qa');
    });
    it.each(['', 'coupon=', 'coupon=staging-qa&coupon=staging-qa', 'coupon=staging-qa&%63oupon=other', 'coupon=../bad', 'coupon=staging-qa&token=', 'coupon=staging-qa&%74oken=t', 'coupon=https://evil.example', 'coupon='+ 'x'.repeat(65), 'coupon=staging-qa&large='+ 'x'.repeat(2048)])('rejects missing, duplicate, unsafe or oversized query %j', query => {
        expect(sponsorCouponFromQuery(new URLSearchParams(query))).toBeNull();
    });
    it('accepts exactly one alias or legacy token field', () => {
        expect(sponsorEntryFromForm(new URLSearchParams('coupon=staging-qa'))).toEqual({ kind: 'coupon', value: 'staging-qa' });
        expect(sponsorEntryFromForm(new URLSearchParams({ token: 't'.repeat(43) }))).toEqual({ kind: 'token', value: 't'.repeat(43) });
    });
    it.each(['coupon=staging-qa&coupon=staging-qa', 'token='+ 't'.repeat(43)+'&coupon=staging-qa', 'coupon=staging-qa&returnUrl=https://evil.example', 'campaignId=staging-qa', 'coupon[]=staging-qa', 'token=short'])('rejects duplicate, mixed or client-authority fields %j', form => {
        expect(sponsorEntryFromForm(new URLSearchParams(form))).toBeNull();
    });
});
