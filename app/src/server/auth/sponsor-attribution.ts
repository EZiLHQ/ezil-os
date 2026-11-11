/** Service-side attribution only. Never writes trial claims, grants or auth.users. */
import { sql } from 'drizzle-orm';
import { sponsorSchemaReady, type SqlRunner } from '@/server/billing/v3/sponsor-store';
import type { SponsorCampaign } from '@/server/billing/v3/sponsor';

export async function recordSponsorAttribution(db: SqlRunner, input: { accountKey: string; campaign: SponsorCampaign; signedUpAt: Date | null }): Promise<'unavailable' | 'same' | 'other_campaign'> {
    if (!await sponsorSchemaReady(db)) return 'unavailable';
    const c = input.campaign;
    // Atomic first attribution. A subject/account-bound creation hint may fill only the matching signup once.
    const rows = [...await db.execute<{ campaign_id: string }>(sql`
        insert into public.ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256, signed_up_at)
        values (${input.accountKey}::uuid, ${c.campaignId}, ${c.partnerId}, ${c.configSha256}, ${input.signedUpAt?.toISOString() ?? null}::timestamptz)
        on conflict (account_key) do update set signed_up_at = coalesce(ezil_sponsor_attributions.signed_up_at, excluded.signed_up_at)
        where ezil_sponsor_attributions.campaign_id = excluded.campaign_id
            and ezil_sponsor_attributions.partner_id = excluded.partner_id
            and ezil_sponsor_attributions.config_sha256 = excluded.config_sha256
        returning campaign_id`)];
    return rows.length === 1 ? 'same' : 'other_campaign';
}
