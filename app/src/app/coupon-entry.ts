/**
 * `/?coupon=<alias>`: a registered promoter's link, carried into OS Billing through the ordinary sign-in.
 *
 * The alias is a name, never a price, Stripe id or destination: the page only re-spells it canonically (trimmed,
 * lower-case) and hands it to Billing, whose server decides everything. The destination is always the fixed Billing
 * path below, so nothing here can become an open redirect, and the carry rides the existing signed Auth0 `returnUrl`
 * (`safeReturnUrl` keeps `/os`'s query byte for byte). A repeated or malformed `coupon` is not dropped to the public
 * offer: it reaches Billing marked invalid, where the link says so.
 */
/** The backend's registered-promoter grammar (`PROMOTER_CODE_PATTERN`, 2-32 characters, no underscore): exactly it, so no valid partner is blocked. */
export const COUPON_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const BILLING = '/os?settings=billing';

export function couponAliasFrom(value: string | string[] | undefined): string | null {
    if (typeof value !== 'string') return null;
    const alias = value.trim().toLowerCase();
    return COUPON_ALIAS_PATTERN.test(alias) ? alias : null;
}

/** The Billing destination for a root `coupon` query value (`undefined` = the key is absent: not a coupon entry). */
export function couponBillingPath(params: Record<string, string | string[] | undefined> | undefined): string | null {
    if (!params || !Object.prototype.hasOwnProperty.call(params, 'coupon')) return null;
    const alias = couponAliasFrom(params.coupon);
    return alias === null ? `${BILLING}&coupon_entry=invalid` : `${BILLING}&coupon=${encodeURIComponent(alias)}`;
}
