import 'server-only';

import { randomBytes } from 'node:crypto';
import { authorizeSponsorQuote, signSponsorContext, verifySponsorContext, type SponsorCampaign } from '@/server/billing/v3/sponsor';
import { readSponsorRuntime } from '@/server/billing/v3/sponsor-runtime';

export const SPONSOR_ENTRY_COOKIE = '__Host-ezil-sponsor-entry';
export const SPONSOR_ENTRY_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const MAX_AGE_MS = 600_000;

/** A pending login selection, not an identity, checkout authorization or trial claim. No opaque invitation token is kept. */
export function sponsorEntryContext(campaign: SponsorCampaign, origin: string, now = new Date()): string {
    return signSponsorContext(process.env.SPONSOR_KEY!, { kind: 'login', campaignId: campaign.campaignId,
        configSha256: campaign.configSha256, issuedAt: now, nonce: randomBytes(24).toString('base64url'),
        subject: `sponsor-entry|${new URL(origin).origin}` });
}

/** Separate subject domain prevents using this handoff as an OAuth state/nonce or account-creation hint. */
export function sponsorFromEntryContext(value: string | undefined, origin: string, now = new Date()): SponsorCampaign | null {
    const context = verifySponsorContext(process.env.SPONSOR_KEY ?? '', value, `sponsor-entry|${new URL(origin).origin}`, now);
    if (!context || context.kind !== 'login' || now.getTime() - context.issuedAt.getTime() > MAX_AGE_MS) return null;
    const runtime = readSponsorRuntime();
    const authorized = authorizeSponsorQuote({ enabled: runtime.enabled, registry: runtime.registry,
        campaignId: context.campaignId, configSha256: context.configSha256, now });
    return authorized.ok ? authorized.campaign : null;
}
