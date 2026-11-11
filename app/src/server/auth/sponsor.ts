import 'server-only';

import { randomBytes } from 'node:crypto';
import type { SqlRunner } from '@/server/billing/v3/sponsor-store';
import { readSponsorRuntime } from '@/server/billing/v3/sponsor-runtime';
import { authorizeSponsorQuote, campaignActive, resolveByToken, signSponsorContext, verifySponsorContext, type SponsorCampaign } from '@/server/billing/v3/sponsor';

/** No token, signed context or provider identity is logged. */
export function sponsorFromLink(token: string | undefined, now = new Date()): SponsorCampaign | null {
    if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) return null;
    const runtime = readSponsorRuntime();
    const campaign = runtime.enabled ? resolveByToken(runtime.registry, token) : null;
    return campaign && campaignActive(campaign, now) ? campaign : null;
}
export function loginSponsorContext(campaign: SponsorCampaign, origin: string, state: string, nonce: string): string {
    return signSponsorContext(process.env.SPONSOR_KEY!, { kind: 'login', campaignId: campaign.campaignId,
        configSha256: campaign.configSha256, issuedAt: new Date(), nonce, subject: `${origin}|${state}|${nonce}` });
}
export function sponsorFromTransaction(value: string, origin: string, state: string, nonce: string, now = new Date()): SponsorCampaign | null {
    const runtime = readSponsorRuntime();
    const context = verifySponsorContext(process.env.SPONSOR_KEY ?? '', value, `${origin}|${state}|${nonce}`, now);
    if (!context || context.kind !== 'login' || context.nonce !== nonce) return null;
    const authorization = authorizeSponsorQuote({ enabled: runtime.enabled, registry: runtime.registry,
        campaignId: context.campaignId, configSha256: context.configSha256, now });
    return authorization.ok ? authorization.campaign : null;
}

export const SPONSOR_CREATION_METADATA = 'ezil_sponsor_creation_v1';
/** Written ONLY during Admin createUser, never on a login/link/update of an existing user. */
export function sponsorCreationHint(campaign: SponsorCampaign, userId: string, verifiedSubject: string): string {
    return signSponsorContext(process.env.SPONSOR_KEY!, { kind: 'creation', campaignId: campaign.campaignId,
        configSha256: campaign.configSha256, issuedAt: new Date(), nonce: randomBytes(24).toString('base64url'), subject: `${userId}|${verifiedSubject}` });
}
export function sponsorFromCreationHint(value: unknown, userId: string, verifiedSubject: string, now = new Date()): { campaign: SponsorCampaign; signedUpAt: Date } | null {
    if (typeof value !== 'string') return null;
    const context = verifySponsorContext(process.env.SPONSOR_KEY ?? '', value, `${userId}|${verifiedSubject}`, now);
    if (!context || context.kind !== 'creation') return null;
    const runtime = readSponsorRuntime();
    const authorization = authorizeSponsorQuote({ enabled: runtime.enabled, registry: runtime.registry,
        campaignId: context.campaignId, configSha256: context.configSha256, now });
    return authorization.ok ? { campaign: authorization.campaign, signedUpAt: context.issuedAt } : null;
}

let writer: Promise<readonly [typeof import('@/server/db'), typeof import('./sponsor-attribution')]> | undefined;

/** Lazy DB import keeps ordinary auth independent of sponsor SQL/config. Called only after verified OTP session. */
export async function materializeSponsorAttribution(input: { userId: string; verifiedSubject: string; metadata: Record<string, unknown>; campaign?: SponsorCampaign }): Promise<void> {
    const runtime = readSponsorRuntime();
    if (!runtime.enabled || input.metadata.auth0_sub !== input.verifiedSubject) return;
    const recovered = sponsorFromCreationHint(input.metadata[SPONSOR_CREATION_METADATA], input.userId, input.verifiedSubject);
    const campaign = recovered?.campaign ?? input.campaign;
    if (!campaign) return;
    const authorization = authorizeSponsorQuote({ enabled: runtime.enabled, registry: runtime.registry,
        campaignId: campaign.campaignId, configSha256: campaign.configSha256, now: new Date() });
    if (!authorization.ok) return;
    try {
        const [{ db }, { recordSponsorAttribution }] = await (writer ??= Promise.all([import('@/server/db'), import('./sponsor-attribution')]));
        await recordSponsorAttribution(db as unknown as SqlRunner, { accountKey: runtime.accountKey(input.userId)!, campaign,
            signedUpAt: recovered?.signedUpAt ?? null });
    } catch (error) { writer = undefined; throw error; }
}
