import { z } from 'zod';

import { CATALOG_V3 } from '../v3/contract';

/** Edit this string metadata on the Product of the canonical Standard monthly Price in Stripe. */
export const PUBLIC_STANDARD_TRIAL_METADATA_KEY = 'ezil_public_standard_trial';
export const PUBLIC_STANDARD_TRIAL_LOOKUP_KEY = CATALOG_V3.standard_monthly_v3.stripeLookupKey;

const product = z.object({
    id: z.string().regex(/^prod_[A-Za-z0-9_]+$/), active: z.literal(true), livemode: z.boolean(),
    metadata: z.record(z.string(), z.string()),
});
const response = z.object({
    has_more: z.literal(false),
    data: z.array(z.object({
        id: z.string().regex(/^price_[A-Za-z0-9_]+$/), lookup_key: z.literal(PUBLIC_STANDARD_TRIAL_LOOKUP_KEY),
        active: z.literal(true), livemode: z.boolean(), type: z.literal('recurring'),
        unit_amount: z.literal(2_000), currency: z.literal('usd'),
        recurring: z.object({ interval: z.literal('month'), interval_count: z.literal(1) }), product,
    })).length(1),
});

/**
 * No environment default or client-supplied product can enable this offer. A missing key on a VERIFIED
 * Standard Product preserves the existing public offer; an explicit false disables it. Unknown values,
 * malformed/unexpanded/ambiguous catalog data and a TEST/LIVE mismatch all fail closed.
 */
export function publicStandardTrialEnabledFromStripe(raw: unknown, expectedLiveMode: boolean): boolean {
    if (PUBLIC_STANDARD_TRIAL_LOOKUP_KEY === null) return false;
    const parsed = response.safeParse(raw);
    if (!parsed.success) return false;
    const price = parsed.data.data[0]!;
    if (price.livemode !== expectedLiveMode || price.product.livemode !== expectedLiveMode) return false;
    const metadata = price.product.metadata;
    return !Object.prototype.hasOwnProperty.call(metadata, PUBLIC_STANDARD_TRIAL_METADATA_KEY)
        || metadata[PUBLIC_STANDARD_TRIAL_METADATA_KEY] === 'true';
}
