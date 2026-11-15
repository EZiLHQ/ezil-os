/** A signed-registry partner ID: 3–64 characters, underscores allowed. */
export const LEGACY_PARTNER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
/** A Stripe Product promoter alias (v3/trial-campaigns.ts PROMOTER_CODE_PATTERN): 2–32 characters, no underscore. */
const PRODUCT_PROMOTER_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
/**
 * Public aliases are names, never Stripe coupon objects or redirect targets: the UNION of the two grammars, so neither authority's valid
 * alias is blocked at entry. The legacy registry decides first; only an alias it does not know may be a Product promoter.
 */
export const SPONSOR_COUPON_PATTERN = new RegExp(`^(?:${LEGACY_PARTNER_ID_PATTERN.source.slice(1, -1)}|${PRODUCT_PROMOTER_PATTERN.source.slice(1, -1)})$`);
export const SPONSOR_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
export const SPONSOR_BILLING_RETURN = '/os?settings=billing';
export type SponsorEntryInput = { kind: 'token'; value: string } | { kind: 'coupon'; value: string };
export function sponsorCouponValue(value: unknown): string | null {
    return typeof value === 'string' && SPONSOR_COUPON_PATTERN.test(value) ? value : null;
}
/** Preserve a root coupon before the ordinary OS/login redirect; invalid or duplicate input reaches Billing with an unavailable status. */
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
