/** Public aliases are existing signed-registry partner IDs, never Stripe coupons or redirect targets. */
export const SPONSOR_COUPON_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
export const SPONSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export type SponsorEntryInput = { kind: 'token'; value: string } | { kind: 'coupon'; value: string };
export function sponsorCouponValue(value: unknown): string | null {
    return typeof value === 'string' && SPONSOR_COUPON_PATTERN.test(value) ? value : null;
}
/** Preserve a root coupon before the ordinary OS/login redirect; invalid or duplicate input lands on the unavailable document. */
export function sponsorCouponEntryPath(value: unknown, hasOpaqueToken = false): string {
    const coupon = hasOpaqueToken ? null : sponsorCouponValue(value);
    return coupon === null ? '/sponsor/coupon' : `/sponsor/coupon?coupon=${encodeURIComponent(coupon)}`;
}
export function sponsorCouponFromQuery(params: URLSearchParams): string | null {
    if (params.toString().length > 2048 || params.has('token') || params.getAll('coupon').length !== 1) return null;
    return sponsorCouponValue(params.get('coupon'));
}
/** Exactly one selection; duplicates, mixed opaque/alias fields and extra redirect/price inputs refuse. */
export function sponsorEntryFromForm(params: URLSearchParams): SponsorEntryInput | null {
    const entries = [...params.entries()];
    if (entries.length !== 1) return null;
    const [kind, value] = entries[0]!;
    if (kind === 'coupon' && sponsorCouponValue(value) !== null) return { kind, value };
    if (kind === 'token' && SPONSOR_TOKEN_PATTERN.test(value)) return { kind, value };
    return null;
}
