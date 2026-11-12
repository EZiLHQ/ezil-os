import 'server-only';
import { auth0Enabled } from './auth0';
import { sponsorFromCoupon, sponsorFromLink } from './sponsor';
import type { SponsorCampaign } from '@/server/billing/v3/sponsor';
import { checkoutAvailable, readBillingConfig } from '@/server/billing/config';
import { sponsorSchemaReady, type SqlRunner } from '@/server/billing/v3/sponsor-store';

/** No database is initialized until an enabled, live campaign and normal checkout are available. */
export async function sponsorEntryAvailable(token: string): Promise<boolean> {
    return entryAvailable(sponsorFromLink(token));
}
export async function sponsorCouponEntryAvailable(coupon: string): Promise<boolean> {
    return entryAvailable(sponsorFromCoupon(coupon));
}
async function entryAvailable(campaign: SponsorCampaign | null): Promise<boolean> {
    if (!campaign || !auth0Enabled() || !checkoutAvailable(readBillingConfig())) return false;
    try {
        const { db } = await import('@/server/db');
        return await sponsorSchemaReady(db as unknown as SqlRunner);
    } catch { return false; }
}
