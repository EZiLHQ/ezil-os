import { TRIAL_CAMPAIGNS_METADATA_KEY, type TrialPriceRead } from './trial-campaigns';

export const STANDARD_PRODUCT_ID = 'prod_StandardV3';
export const STANDARD_PRICE_ID = 'price_StandardV3Monthly';
/** The reviewed campaigns value with the public offer and the midhun promoter on. */
export const CAMPAIGNS_ON = JSON.stringify({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true } } });

type Price = TrialPriceRead['prices'][number];
/**
 * The fresh Stripe read of the Standard monthly price: one active USD 2000 monthly price on an active Product whose
 * metadata carries `campaigns` (undefined = no campaigns key at all: the legacy public offer).
 */
export function standardTrialRead(campaigns?: string, over: Partial<Price> = {}, productOver: Partial<NonNullable<Price['product']>> = {}): TrialPriceRead {
    return { hasMore: false, prices: [{ id: STANDARD_PRICE_ID, active: true, unitAmount: 2000, currency: 'usd', interval: 'month', intervalCount: 1,
        product: { id: STANDARD_PRODUCT_ID, active: true, metadata: { ezil_plan: 'standard', ...(campaigns === undefined ? {} : { [TRIAL_CAMPAIGNS_METADATA_KEY]: campaigns }) },
            ...productOver }, ...over }] };
}
