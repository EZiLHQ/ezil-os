/**
 * Sponsor attribution persistence (request sponsor-checkout-20261111): raw SQL against the two service-only tables of
 * migrations/sponsor/0001_sponsor_attribution.sql, deliberately NOT modelled in the Drizzle schema (drizzle-kit reads schema/index.ts, and the
 * sponsor SQL stays outside the ordered journal). Every function runs inside the caller's transaction and the caller's existing per-person locks;
 * none of them decides eligibility or touches a grant. The trial row stays the only trial authority.
 */
import { sql } from 'drizzle-orm';
import type { SponsorBindMetadata, SponsorQuoteInput } from './trial';

/** The slice of a Drizzle database/transaction these functions use. */
export interface SqlRunner { execute<T extends Record<string, unknown>>(query: ReturnType<typeof sql>): Promise<Iterable<T>> }

/** Record the account's attribution (first accepted campaign wins, never overwritten) and say whether THIS campaign is the one it holds. */
export async function ensureAttribution(db: SqlRunner, sponsor: SponsorQuoteInput): Promise<'same' | 'other_campaign'> {
    await db.execute(sql`insert into public.ezil_sponsor_attributions (account_key, campaign_id, partner_id, config_sha256)
        values (${sponsor.accountKey}::uuid, ${sponsor.campaignId}, ${sponsor.partnerId}, ${sponsor.configSha256})
        on conflict (account_key) do nothing`);
    const rows = [...await db.execute<{ campaign_id: string }>(sql`select campaign_id from public.ezil_sponsor_attributions where account_key = ${sponsor.accountKey}::uuid`)];
    return rows[0]?.campaign_id === sponsor.campaignId ? 'same' : 'other_campaign';
}

/**
 * Freeze the campaign and its config hash on this quote. An unclaimed linkage of the same campaign is refreshed (a re-quote re-freezes the hash and
 * time); a claimed one, or one of another campaign, is left alone and reported as a conflict.
 */
export async function linkQuote(db: SqlRunner, trialId: string, sponsor: SponsorQuoteInput, quotedAt: Date): Promise<'linked' | 'conflict'> {
    const rows = [...await db.execute<{ trial_id: string }>(sql`insert into public.ezil_sponsor_trial_claims (trial_id, account_key, campaign_id, partner_id, config_sha256, quoted_at)
        values (${trialId}::uuid, ${sponsor.accountKey}::uuid, ${sponsor.campaignId}, ${sponsor.partnerId}, ${sponsor.configSha256}, ${quotedAt.toISOString()}::timestamptz)
        on conflict (trial_id) do update set quoted_at = excluded.quoted_at, config_sha256 = excluded.config_sha256
            where ezil_sponsor_trial_claims.claimed_at is null and ezil_sponsor_trial_claims.campaign_id = excluded.campaign_id
                and ezil_sponsor_trial_claims.account_key = excluded.account_key
        returning trial_id::text as trial_id`)];
    return rows.length === 1 ? 'linked' : 'conflict';
}

/** A public re-quote never strips a sponsor linkage: an unclaimed one just follows the new quote time. */
export async function refreshLinkedQuote(db: SqlRunner, trialId: string, quotedAt: Date): Promise<void> {
    await db.execute(sql`update public.ezil_sponsor_trial_claims set quoted_at = ${quotedAt.toISOString()}::timestamptz where trial_id = ${trialId}::uuid and claimed_at is null`);
}

/**
 * At subscription bind, in the same transaction as the binding: the persisted linkage and the server-written Stripe metadata must agree. Both absent
 * is a plain public trial. A linkage with no matching metadata, metadata with no linkage, or any difference is a mismatch (the caller rolls the bind
 * back and sends it to review); it never funds anything differently. claimed_at and the subscription are set together, once; a replay is idempotent.
 */
export async function claimLinkage(db: SqlRunner, input: { trialId: string; subscriptionId: string; now: Date; metadata: SponsorBindMetadata | null }):
    Promise<'none' | 'claimed' | 'mismatch'> {
    const link = [...await db.execute<{ campaign_id: string; config_sha256: string; claimed_at: string | null; stripe_subscription_id: string | null }>(sql`
        select campaign_id, config_sha256, claimed_at, stripe_subscription_id from public.ezil_sponsor_trial_claims where trial_id = ${input.trialId}::uuid for update`)][0];
    if (!link) return input.metadata === null ? 'none' : 'mismatch';
    if (!input.metadata || input.metadata.campaignId !== link.campaign_id || input.metadata.configSha256 !== link.config_sha256) return 'mismatch';
    if (link.claimed_at !== null) return link.stripe_subscription_id === input.subscriptionId ? 'claimed' : 'mismatch';
    await db.execute(sql`update public.ezil_sponsor_trial_claims set claimed_at = greatest(${input.now.toISOString()}::timestamptz, quoted_at), stripe_subscription_id = ${input.subscriptionId}
        where trial_id = ${input.trialId}::uuid and claimed_at is null`);
    return 'claimed';
}
