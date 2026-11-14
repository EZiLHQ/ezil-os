import 'server-only';

import { randomBytes } from 'node:crypto';
import { authorizeSponsorQuote, signSponsorContext, verifySponsorContext, type SponsorCampaign } from '@/server/billing/v3/sponsor';
import { readSponsorRuntime } from '@/server/billing/v3/sponsor-runtime';

export const SPONSOR_ENTRY_COOKIE = '__Host-ezil-sponsor-entry';
export const SPONSOR_ENTRY_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const MAX_AGE_MS = 600_000;

/**
 * How the visitor entered, sealed server-side into the entry (and then the Billing) context: an opaque invitation token, or a public alias
 * (the campaign's canonical partner id). `unknown` = a context sealed before provenance existed; it never counts as opaque.
 */
export type SponsorEntryProvenance = 'opaque' | 'alias' | 'unknown';
const entrySubject = (origin: string, provenance: SponsorEntryProvenance) =>
    `sponsor-entry|${new URL(origin).origin}${provenance === 'unknown' ? '' : `|${provenance}`}`;

/** A pending login selection, not an identity, checkout authorization or trial claim. No opaque invitation token is kept. */
export function sponsorEntryContext(campaign: SponsorCampaign, origin: string, now = new Date(), provenance: Exclude<SponsorEntryProvenance, 'unknown'> = 'alias'): string {
    return signSponsorContext(process.env.SPONSOR_KEY!, { kind: 'login', campaignId: campaign.campaignId,
        configSha256: campaign.configSha256, issuedAt: now, nonce: randomBytes(24).toString('base64url'),
        subject: entrySubject(origin, provenance) });
}

/** Separate subject domain prevents using this handoff as an OAuth state/nonce or account-creation hint. */
export function sponsorFromEntryContext(value: string | undefined, origin: string, now = new Date()): SponsorCampaign | null {
    return verifiedSponsorEntry(value, origin, now)?.campaign ?? null;
}

/**
 * The same verification, plus the entry's ORIGINAL issue time: the only time a carried Billing context may be derived from (never the auth
 * transaction's re-minted login context).
 */
export function verifiedSponsorEntry(value: string | undefined, origin: string, now = new Date()):
    { campaign: SponsorCampaign; issuedAt: Date; provenance: SponsorEntryProvenance } | null {
    // The provenance is part of the MAC'd subject: exactly one of these verifies for a given value.
    for (const provenance of ['opaque', 'alias', 'unknown'] as const) {
        const context = verifySponsorContext(process.env.SPONSOR_KEY ?? '', value, entrySubject(origin, provenance), now);
        if (!context) continue;
        if (context.kind !== 'login' || now.getTime() - context.issuedAt.getTime() > MAX_AGE_MS) return null;
        const runtime = readSponsorRuntime();
        const authorized = authorizeSponsorQuote({ enabled: runtime.enabled, registry: runtime.registry,
            campaignId: context.campaignId, configSha256: context.configSha256, now });
        return authorized.ok ? { campaign: authorized.campaign, issuedAt: context.issuedAt, provenance } : null;
    }
    return null;
}
