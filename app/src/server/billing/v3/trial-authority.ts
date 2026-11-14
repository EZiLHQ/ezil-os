/**
 * The ONE Standard-trial authority selection behind the Billing summary, `billing.trialOffer`, `billing.quoteTrial` and
 * `billing.createCheckout` (Root policy 2026-11-14). It decides which offer a request may use, never eligibility: the one
 * lifetime claim (v3/trial.ts) is checked first, unchanged, by the caller.
 *
 * In order:
 *  1. A VERIFIED active legacy sponsor context (a verified `SponsorContext`, never an attribution row). An alias beside it
 *     must name the same campaign. An opaque-invitation context keeps legacy priority; an alias or unknown-provenance context
 *     whose campaign alias is also a Product promoter is refused (alias: invalid, unknown: unavailable), re-checked every time.
 *  2. A promoter alias (`?coupon=`, an untrusted hint). A KNOWN legacy alias owns its resolution, deny included: a disabled,
 *     expired, revoked, duplicated or unverifiable legacy registry never falls through to the Product or public offer. An alias
 *     in BOTH authorities is ambiguous and refused. Only an alias unknown to a verified legacy registry may select the Stripe
 *     Product promoter terms (v3/trial-campaigns.ts).
 *  3. With no new selection, the caller's CURRENT pending quote-owned sponsor link (persisted with its own quote, status
 *     quoted/checkout) resumes under Stage's frozen rules: same campaign and config only; config changed = stale. Its provenance
 *     is unknown, so a campaign alias that is also a Product promoter fails closed (unavailable), the link left in place. Proven
 *     disabled, expired or not started (its exact campaign id still known to a VERIFIED registry, runtime on), an unclaimed link
 *     may give way to the public offer (Stage's explicit public re-quote, with `releasePending`). A removed campaign, runtime off,
 *     or an absent/unverifiable registry proves nothing: it stays and refuses (unavailable).
 *  4. Otherwise the public offer, open only while BOTH public controls allow it: the Product's `ezil_public_standard_trial`
 *     (absent or "true", matching live/test mode) and the campaigns metadata `publicEnabled` (absent = on).
 * `pending` reports how a new selection relates to a pending link ('different' = it would retarget the frozen quote); the
 * caller applies the existing explicit resume/expire/re-quote policy to it and never retargets silently.
 * A selected legacy campaign or Product promoter overrides both public controls. Every source needs the verified Standard
 * price (exactly one active USD 2000 monthly price on an active Product). The historical first-touch attribution row is
 * analytics: it has no input here.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { CATALOG_V3 } from './contract';
import { campaignActive, parseSponsorRegistry, signSponsorRegistry, authorizeSponsorQuote, type SponsorCampaign, type SponsorContext, type SponsorRegistry } from './sponsor';
import { TRIAL_POLICY_VERSION, TRIAL_SKU } from './trial';
import { PROMOTER_CODE_PATTERN, selectTrialOffer, trialProductTerms, type TrialOfferSelection, type TrialPriceRead } from './trial-campaigns';

/** Stage's public control on the Standard Product (stripe/public-standard-trial.ts). */
export const PUBLIC_STANDARD_TRIAL_METADATA_KEY = 'ezil_public_standard_trial' as const;
/** Any alias either authority could name: Product promoter grammar or legacy partner-id grammar, after trim + lower-case. */
const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/**
 * The legacy signed registry as configured, without conflating "none configured" with "configured but unverifiable"
 * (`parseSponsorRegistry` returns an empty registry for both). `parseSponsorRegistry` itself is reused unchanged.
 */
export type LegacyRegistryState = { state: 'absent' } | { state: 'invalid' } | { state: 'verified'; registry: SponsorRegistry };

export function inspectSponsorRegistry(input: { document: string | undefined; signature: string | undefined; key: string | undefined }): LegacyRegistryState {
    const { document, signature, key } = input;
    if (!document && !signature) return { state: 'absent' };
    const registry = parseSponsorRegistry({ document, signature, key });
    if (registry.size > 0) return { state: 'verified', registry };
    // Empty: a validly signed empty registry, or something the existing parser refused.
    if (!document || !signature || typeof key !== 'string' || key.length < 32) return { state: 'invalid' };
    const presented = Buffer.from(signature, 'base64url'), expected = Buffer.from(signSponsorRegistry(document, key), 'base64url');
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return { state: 'invalid' };
    try {
        const parsed: unknown = JSON.parse(document);
        return JSON.stringify(parsed) === JSON.stringify({ v: 1, campaigns: [] }) ? { state: 'verified', registry } : { state: 'invalid' };
    } catch { return { state: 'invalid' }; }
}

/** Every legacy entry with this partner id, retained disabled/expired entries included (`resolveByPartnerId` hides duplicates as null). */
export type LegacyAliasMatch = { kind: 'none' } | { kind: 'exact'; campaign: SponsorCampaign } | { kind: 'ambiguous' } | { kind: 'registry_invalid' };
export function legacyAliasMatch(legacy: LegacyRegistryState, alias: string): LegacyAliasMatch {
    if (legacy.state === 'absent') return { kind: 'none' };
    if (legacy.state === 'invalid') return { kind: 'registry_invalid' };
    const matches = [...legacy.registry.values()].filter(campaign => campaign.partnerId === alias);
    return matches.length === 0 ? { kind: 'none' } : matches.length === 1 ? { kind: 'exact', campaign: matches[0]! } : { kind: 'ambiguous' };
}

/** absent or "true" with the read's live/test mode matching the deployment: open. Anything else: closed. */
export function stagePublicTrialOpen(metadata: Readonly<Record<string, string>>, livemodeMatches: boolean): boolean {
    return livemodeMatches && (!Object.hasOwn(metadata, PUBLIC_STANDARD_TRIAL_METADATA_KEY) || metadata[PUBLIC_STANDARD_TRIAL_METADATA_KEY] === 'true');
}

export interface PendingSponsorLink { campaignId: string; configSha256: string; claimed: boolean }
export type TrialAuthorityRefusal = 'trial_offer_invalid' | 'trial_offer_unavailable' | 'trial_unavailable' | 'trial_quote_stale';
export type TrialAuthority =
    | { source: 'public' | 'promoter'; offer: TrialOfferSelection }
    | { source: 'sponsor'; via: 'pending' | 'context' | 'alias'; campaign: SponsorCampaign; offer: TrialOfferSelection };
export interface TrialAuthorityInput {
    /** The client's `coupon` (untrusted); null/undefined = none. */
    alias: unknown;
    /** The caller's own quote's persisted link, ONLY while that quote is pending (quoted/checkout). */
    pendingLink: PendingSponsorLink | null;
    /**
     * A sponsor context the carrier has already verified (signature, subject, TTL); never built from a database row. `provenance` is how the
     * original entry arrived, sealed by it: an `opaque` invitation keeps legacy priority; an `alias` (with its canonical alias) or an
     * `unknown` (older) entry is re-checked against the Product promoters on every request and fails closed on a collision.
     */
    legacyContext: (SponsorContext & { provenance: 'opaque' | 'alias' | 'unknown'; alias: string | null }) | null;
    legacy: LegacyRegistryState;
    /** SPONSOR_TRIALS_ENABLED: off keeps known legacy aliases known, and denied. */
    legacyEnabled: boolean;
    read: TrialPriceRead;
    /** The provider read's live/test mode equals the deployment's (Stage's public control requires it). */
    livemodeMatches: boolean;
    now: Date;
}
/**
 * `pending`: how the selection relates to a pending link ('different' = it would retarget the frozen quote).
 * `releasePending`: a fresh, verified legacy registry proves that pending link's campaign off, revoked or expired, so a
 * public/promoter quote may conditionally release it (the store re-checks the exact unclaimed link under its lock).
 */
export type TrialAuthorityResult =
    | { ok: true; authority: TrialAuthority; pending: 'none' | 'same' | 'different'; releasePending: boolean }
    | { ok: false; code: TrialAuthorityRefusal };

/** sha256 of a legacy selection's frozen terms: a non-secret retry binding, not an authorization. */
export function sponsorOfferFingerprint(campaign: Pick<SponsorCampaign, 'campaignId' | 'configSha256'>, productId: string, priceId: string): string {
    return createHash('sha256').update(JSON.stringify({ v: 1, source: 'sponsor', policy: TRIAL_POLICY_VERSION, sku: TRIAL_SKU, productId, priceId,
        unitAmount: CATALOG_V3[TRIAL_SKU].priceCents, currency: 'usd', interval: 'month', intervalCount: 1,
        campaignId: campaign.campaignId, configSha256: campaign.configSha256 })).digest('hex');
}

export function normalizeTrialAlias(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const alias = raw.trim().toLowerCase();
    return ALIAS_PATTERN.test(alias) ? alias : null;
}

export function selectTrialAuthority(input: TrialAuthorityInput): TrialAuthorityResult {
    const hasAlias = input.alias !== null && input.alias !== undefined;
    const alias = hasAlias ? normalizeTrialAlias(input.alias) : null;
    if (hasAlias && alias === null) return { ok: false, code: 'trial_offer_invalid' };
    const terms = trialProductTerms(input.read);
    if (!terms) return { ok: false, code: 'trial_offer_unavailable' };
    const registry = input.legacy.state === 'verified' ? input.legacy.registry : new Map<string, SponsorCampaign>();
    const sponsor = (campaign: SponsorCampaign, via: 'pending' | 'context' | 'alias'): TrialAuthority => ({ source: 'sponsor', via, campaign,
        offer: { coupon: via === 'alias' ? alias : null, expiresAt: campaign.expiresAt.toISOString(), priceId: terms.priceId,
            fingerprint: sponsorOfferFingerprint(campaign, terms.productId, terms.priceId) } });
    const relation = (authority: TrialAuthority): 'none' | 'same' | 'different' => !input.pendingLink ? 'none'
        : authority.source === 'sponsor' && authority.campaign.campaignId === input.pendingLink.campaignId
            && authority.campaign.configSha256 === input.pendingLink.configSha256 ? 'same' : 'different';
    // The pending link's own standing under Stage's frozen rules. Only a verified registry can prove it off/revoked/expired.
    const pendingAuthorization = input.pendingLink ? authorizeSponsorQuote({ enabled: input.legacyEnabled && input.legacy.state === 'verified', registry,
        campaignId: input.pendingLink.campaignId, configSha256: input.pendingLink.configSha256, now: input.now }) : null;
    // Release proof is an ALLOWLIST derived on its own, never "any other failure": a fresh VERIFIED registry still KNOWS the link's exact
    // campaign id, the runtime is on, the link is unclaimed, and that campaign is explicitly inactive now (disabled, expired or not yet
    // started). Its live config hash may differ from the link's frozen one (enabled and dates are hashed): the frozen hash belongs only in the
    // store's compare-and-delete. A removed (unknown) campaign, runtime off, or an absent/unverifiable registry proves nothing: the link stays.
    const proofCampaign = input.pendingLink && input.legacy.state === 'verified' ? input.legacy.registry.get(input.pendingLink.campaignId) ?? null : null;
    const pendingProvenInactive = !!input.pendingLink && input.legacyEnabled && !input.pendingLink.claimed && proofCampaign !== null
        && proofCampaign.campaignId === input.pendingLink.campaignId && !campaignActive(proofCampaign, input.now);
    const done = (authority: TrialAuthority): TrialAuthorityResult => {
        const pending = relation(authority);
        return { ok: true, authority, pending, releasePending: pending === 'different' && pendingProvenInactive };
    };

    // 1. A verified active context; an alias beside it must name the same campaign.
    if (input.legacyContext) {
        const authorized = authorizeSponsorQuote({ enabled: input.legacyEnabled && input.legacy.state === 'verified', registry,
            campaignId: input.legacyContext.campaignId, configSha256: input.legacyContext.configSha256, now: input.now });
        if (!authorized.ok) return { ok: false, code: 'trial_offer_unavailable' };
        const context = input.legacyContext;
        if (alias !== null && authorized.campaign.partnerId !== alias) return { ok: false, code: 'trial_offer_invalid' };
        if (context.provenance !== 'opaque') {
            // An alias entry (or one whose provenance is unknown) names the campaign's public alias: fresh collision check, never a guess.
            if (context.provenance === 'alias' && context.alias !== authorized.campaign.partnerId) return { ok: false, code: 'trial_offer_invalid' };
            const partner = authorized.campaign.partnerId;
            if (terms.campaigns === null) return { ok: false, code: 'trial_offer_unavailable' };
            if (PROMOTER_CODE_PATTERN.test(partner) && Object.hasOwn(terms.campaigns.promoters, partner)) {
                return { ok: false, code: context.provenance === 'alias' ? 'trial_offer_invalid' : 'trial_offer_unavailable' };
            }
        }
        return done(sponsor(authorized.campaign, 'context'));
    }

    // 2. An alias: the legacy registry decides first, deny included.
    if (alias !== null) {
        const legacy = legacyAliasMatch(input.legacy, alias);
        if (legacy.kind === 'registry_invalid') return { ok: false, code: 'trial_offer_unavailable' };
        const productKnown = terms.campaigns !== null && PROMOTER_CODE_PATTERN.test(alias) && Object.hasOwn(terms.campaigns.promoters, alias);
        if (legacy.kind !== 'none') {
            if (productKnown || legacy.kind === 'ambiguous') return { ok: false, code: 'trial_offer_invalid' };
            // Malformed Product metadata cannot prove the alias is not also a promoter.
            if (terms.campaigns === null) return { ok: false, code: 'trial_offer_unavailable' };
            if (!input.legacyEnabled || !campaignActive(legacy.campaign, input.now)) return { ok: false, code: 'trial_offer_unavailable' };
            return done(sponsor(legacy.campaign, 'alias'));
        }
        // Legacy partner-id grammar only (an underscore, or over 32 characters) and unknown to the legacy registry.
        if (!PROMOTER_CODE_PATTERN.test(alias)) return { ok: false, code: 'trial_offer_invalid' };
        const selected = selectTrialOffer(input.read, alias, input.now);
        return selected.ok ? done({ source: 'promoter', offer: selected.offer }) : { ok: false, code: selected.code };
    }

    // 3. No new selection: the pending link resumes under Stage's frozen rules. Proven off/revoked/expired by a verified
    //    registry, it may give way to the public offer (Stage's explicit public re-quote); otherwise it stays and refuses.
    if (input.pendingLink && pendingAuthorization) {
        if (pendingAuthorization.ok) {
            // A pending link records no entry provenance: it binds the legacy campaign but cannot stand in for a lost opaque invitation, so a
            // campaign alias that is also a Product promoter fails closed (re-checked fresh on every read, quote and checkout).
            const partner = pendingAuthorization.campaign.partnerId;
            if (terms.campaigns === null || (PROMOTER_CODE_PATTERN.test(partner) && Object.hasOwn(terms.campaigns.promoters, partner))) {
                return { ok: false, code: 'trial_offer_unavailable' };
            }
            return done(sponsor(pendingAuthorization.campaign, 'pending'));
        }
        // Proven-inactive cleanup first: an active campaign whose hash changed stays stale; anything unproven stays and refuses.
        if (!pendingProvenInactive) return { ok: false, code: pendingAuthorization.reason === 'config_changed' ? 'trial_quote_stale' : 'trial_unavailable' };
    }

    // 4. The public offer: both controls.
    const product = input.read.prices[0]!.product!;
    if (!stagePublicTrialOpen(product.metadata, input.livemodeMatches)) return { ok: false, code: 'trial_offer_unavailable' };
    const selected = selectTrialOffer(input.read, null, input.now);
    return selected.ok ? done({ source: 'public', offer: selected.offer }) : { ok: false, code: selected.code };
}
