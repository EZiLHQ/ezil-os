/**
 * Billing feature flags and provider configuration (contract §7).
 *
 * Every flag is OFF unless set to exactly `'1'`, so a deploy that configures
 * nothing behaves exactly as before billing existed. Mode checks inspect key
 * prefixes only and never expose key text in their results or diagnostics.
 */
export interface BillingConfig {
    /** Settings → Billing tab and `billing.summary`. */
    tabEnabled: boolean;
    /** Public `/pricing` page and the Plans link on `/login`. */
    pricingPageEnabled: boolean;
    /** Stripe Checkout and the Customer Portal. Also needs `stripeSecret`. */
    checkoutEnabled: boolean;
    /** Refuse starts / pause at zero. Off = shadow metering only. */
    enforcementEnabled: boolean;
    /** Gate G-STOR: Pro's 20 GB cap may be offered. */
    largeStorageEnabled: boolean;
    /** Stripe Tax on Checkout. Turn on once EZiL LLC has a tax registration. */
    automaticTaxEnabled: boolean;
    /** Stripe Adaptive Pricing (local currency at checkout). */
    adaptivePricingEnabled: boolean;
    /** Stripe is merchant of record; enable only after accepting its Managed Payments terms. */
    managedPaymentsEnabled: boolean;
    stripeSecret: string | undefined;
    stripeWebhookSecret: string | undefined;
    /** Publishable key (`pk_…`) for Stripe.js Embedded Checkout. Public by design. */
    stripePublishableKey: string | undefined;
    /** Preserve invalid configuration without exposing a non-publishable key to a browser. */
    stripePublishableKeyInvalid?: boolean;
    /** Optional: a dashboard-managed Price for Pro; otherwise Checkout uses inline price data. */
    stripePriceProMonthly: string | undefined;
    /** HMAC secret the desktop Worker signs usage events with. */
    usageHmacSecret: string | undefined;
    /** Gateway funding hook; the AI outbox stays undelivered until both are set. */
    fundingUrl: string | undefined;
    fundingHmacSecret: string | undefined;
}

type Env = Record<string, string | undefined>;

const on = (v: string | undefined) => v === '1';
/** Only a `pk_` key may ever be sent to a browser. */
const publishable = (v: string | undefined) => (v && /^pk_(test|live)_/.test(v.trim()) ? v.trim() : undefined);
const nonEmpty = (v: string | undefined) => (v && v.trim() !== '' ? v : undefined);

export function readBillingConfig(env: Env = process.env): BillingConfig {
    const rawPublishableKey = nonEmpty(env.STRIPE_PUBLISHABLE_KEY ?? env.STRIPE_KEY);
    const stripePublishableKey = publishable(rawPublishableKey);
    return {
        tabEnabled: on(env.BILLING_TAB_ENABLED),
        pricingPageEnabled: on(env.PRICING_PAGE_ENABLED),
        checkoutEnabled: on(env.CHECKOUT_ENABLED),
        enforcementEnabled: on(env.BILLING_ENFORCEMENT),
        largeStorageEnabled: on(env.BILLING_LARGE_STORAGE),
        automaticTaxEnabled: on(env.BILLING_AUTOMATIC_TAX),
        adaptivePricingEnabled: on(env.BILLING_ADAPTIVE_PRICING),
        managedPaymentsEnabled: on(env.BILLING_MANAGED_PAYMENTS),
        stripeSecret: nonEmpty(env.STRIPE_SECRET),
        stripeWebhookSecret: nonEmpty(env.STRIPE_WEBHOOK_SECRET),
        stripePublishableKey,
        stripePublishableKeyInvalid: rawPublishableKey !== undefined && stripePublishableKey === undefined,
        stripePriceProMonthly: nonEmpty(env.STRIPE_PRICE_PRO_MONTHLY),
        usageHmacSecret: nonEmpty(env.BILLING_USAGE_HMAC_SECRET),
        fundingUrl: nonEmpty(env.BILLING_FUNDING_URL),
        fundingHmacSecret: nonEmpty(env.BILLING_FUNDING_HMAC_SECRET),
    };
}

export type StripeMode = 'test' | 'live';

/** Return only the mode or a safe reason; key text stays inside the config. */
export function stripeMode(config: BillingConfig): { mode: StripeMode } | { mode: null; reason: 'absent' | 'mixed' | 'unrecognized' } {
    const secret = config.stripeSecret;
    if (!secret) return { mode: null, reason: 'absent' };
    const mode = /^(sk|rk)_test_/.test(secret) ? 'test'
        : /^(sk|rk)_live_/.test(secret) ? 'live' : null;
    if (mode === null) return { mode: null, reason: 'unrecognized' };
    if (config.stripePublishableKeyInvalid
        || (config.stripePublishableKey !== undefined && !config.stripePublishableKey.startsWith(`pk_${mode}_`))) {
        return { mode: null, reason: 'mixed' };
    }
    return { mode };
}

/** Checkout and the portal need the flag and a consistent, recognized key mode. */
export function checkoutAvailable(config: BillingConfig): boolean {
    return config.checkoutEnabled && stripeMode(config).mode !== null;
}
