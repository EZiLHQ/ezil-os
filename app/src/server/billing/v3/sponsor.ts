/**
 * Partner sponsor campaigns, server-only and DISABLED by default (request sponsor-checkout-20261111).
 *
 * A sponsor link only OFFERS the existing Standard calendar-month trial (payment method required, then the disclosed $20/month
 * renewal unless cancelled). It never grants anything: the trial is still claimed through `claimTrialQuote` and paid through the
 * provider reread in `applyTrial`. This module only answers "is this campaign real, current and the one this person came from?".
 *
 *  - The registry is a signed document (HMAC-SHA256, its own key and domain). Missing, malformed, unsigned or wrongly signed input
 *    fails closed to "no campaigns". There are no built-in campaigns and no client-supplied price, coupon, metadata or redirect.
 *  - A campaign is immutable per (campaignId, version): its canonical JSON is hashed (`configSha256`) and frozen per quote.
 *  - The account key is a pseudonymous HMAC of the user id (its own key and domain), kept after account deletion for durable counts.
 *  - Auth carries the campaign in a short-lived signed context that is re-validated after authentication; the cookie, the query and
 *    localStorage are never identity or authority.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const REGISTRY_DOMAIN = 'ezil-sponsor-registry-v1:';
const ACCOUNT_DOMAIN = 'ezil-sponsor-account-key-v1:';
const CONTEXT_DOMAIN = 'ezil-sponsor-context-v1:';
export const SPONSOR_CONTEXT_TTL_SECONDS = 30 * 60;
/** How long a creation hint stays usable to materialize an attribution after the auth user was created (recovery window). */
export const SPONSOR_CREATION_HINT_TTL_SECONDS = 24 * 60 * 60;

const ID = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
const campaignSchema = z.object({
    campaignId: ID,
    partnerId: ID,
    version: z.number().int().min(1).max(1_000_000),
    enabled: z.boolean(),
    startsAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    /** sha256 hex of the reusable link token; the token itself is never stored or logged. */
    tokenSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict().refine(c => Date.parse(c.expiresAt) > Date.parse(c.startsAt), { path: ['expiresAt'] });
const registrySchema = z.object({ v: z.literal(1), campaigns: z.array(campaignSchema).max(500) }).strict();

export interface SponsorCampaign {
    campaignId: string; partnerId: string; version: number; enabled: boolean; startsAt: Date; expiresAt: Date; tokenSha256: string;
    /** sha256 of the canonical campaign entry: what a quote freezes. */
    configSha256: string;
}
export type SponsorRegistry = ReadonlyMap<string, SponsorCampaign>;
export const EMPTY_REGISTRY: SponsorRegistry = new Map();

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');
const hmac = (key: string, domain: string, message: string): Buffer => createHmac('sha256', key).update(domain + message).digest();
const safeEqual = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const usableKey = (key: string | undefined): key is string => typeof key === 'string' && key.length >= 32;

export const hashSponsorToken = (token: string): string => sha256Hex(token);
/** Keys sorted, no whitespace: the exact bytes `configSha256` covers. */
export function canonicalCampaign(entry: z.infer<typeof campaignSchema>): string {
    return JSON.stringify({ campaignId: entry.campaignId, enabled: entry.enabled, expiresAt: entry.expiresAt, partnerId: entry.partnerId,
        startsAt: entry.startsAt, tokenSha256: entry.tokenSha256, version: entry.version });
}

/** `document` is the registry JSON, `signature` its base64url HMAC. Anything wrong returns an EMPTY registry (fail closed). */
export function parseSponsorRegistry(input: { document: string | undefined; signature: string | undefined; key: string | undefined }): SponsorRegistry {
    const { document, signature, key } = input;
    if (!document || !signature || !usableKey(key)) return EMPTY_REGISTRY;
    try {
        const presented = Buffer.from(signature, 'base64url');
        if (!safeEqual(presented, hmac(key, REGISTRY_DOMAIN, document))) return EMPTY_REGISTRY;
        const parsed = registrySchema.safeParse(JSON.parse(document));
        if (!parsed.success) return EMPTY_REGISTRY;
        const registry = new Map<string, SponsorCampaign>();
        for (const entry of parsed.data.campaigns) {
            if (registry.has(entry.campaignId)) return EMPTY_REGISTRY;   // an ambiguous registry is no registry
            registry.set(entry.campaignId, { campaignId: entry.campaignId, partnerId: entry.partnerId, version: entry.version, enabled: entry.enabled,
                startsAt: new Date(entry.startsAt), expiresAt: new Date(entry.expiresAt), tokenSha256: entry.tokenSha256, configSha256: sha256Hex(canonicalCampaign(entry)) });
        }
        const tokens = new Set([...registry.values()].map(c => c.tokenSha256));
        return tokens.size === registry.size ? registry : EMPTY_REGISTRY;
    } catch {
        return EMPTY_REGISTRY;
    }
}

/** Signing helper for the registry's owner (tests and the offline tool); the app never signs a registry. */
export function signSponsorRegistry(document: string, key: string): string {
    return hmac(key, REGISTRY_DOMAIN, document).toString('base64url');
}

export const sponsorTrialsEnabled = (env: { SPONSOR_TRIALS_ENABLED?: string | undefined }): boolean => env.SPONSOR_TRIALS_ENABLED === '1';
/** The public trial offer is its own gate. Absent = on, so today's behaviour is unchanged; only an explicit "0" turns it off. */
export const publicTrialEnabled = (env: { BILLING_PUBLIC_STANDARD_TRIAL?: string | undefined }): boolean => env.BILLING_PUBLIC_STANDARD_TRIAL !== '0';

export function campaignActive(campaign: SponsorCampaign, now: Date): boolean {
    return campaign.enabled && now >= campaign.startsAt && now < campaign.expiresAt;
}
/** Resolve a link by its token (constant-time over every entry, so timing does not reveal which campaign matched) or by its opaque id. */
export function resolveByToken(registry: SponsorRegistry, token: string): SponsorCampaign | null {
    const presented = Buffer.from(sha256Hex(token), 'hex');
    let found: SponsorCampaign | null = null;
    for (const campaign of registry.values()) if (safeEqual(Buffer.from(campaign.tokenSha256, 'hex'), presented)) found = campaign;
    return found;
}
/** A public partner alias must identify exactly one registry entry, including retained disabled/expired entries. Never guess between campaigns. */
export function resolveByPartnerId(registry: SponsorRegistry, partnerId: string): SponsorCampaign | null {
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(partnerId)) return null;
    let found: SponsorCampaign | null = null;
    for (const campaign of registry.values()) {
        if (campaign.partnerId !== partnerId) continue;
        if (found !== null) return null;
        found = campaign;
    }
    return found;
}
export const resolveById = (registry: SponsorRegistry, campaignId: string): SponsorCampaign | null => registry.get(campaignId) ?? null;

/** UUID-shaped pseudonym of a user id under the sponsor key. Same user, same key: same value; deleting the account does not change it. */
export function accountKeyFor(userId: string, key: string): string {
    if (!usableKey(key)) throw new Error('sponsor_key_unusable');
    const bytes = hmac(key, ACCOUNT_DOMAIN, userId.toLowerCase()).subarray(0, 16);
    bytes[6] = (bytes[6]! & 0x0f) | 0x50; bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type SponsorContextKind = 'login' | 'creation';
export interface SponsorContext { kind: SponsorContextKind; campaignId: string; configSha256: string; issuedAt: Date; nonce: string }
/**
 * `login`: carried through the signed auth state/nonce transaction. `creation`: the hint the server writes into app_metadata when it creates
 * the account, so attribution can be materialized idempotently after an auth-create or application-SQL failure. Both are bound to the verified
 * subject by the caller; neither is a counter or a grant.
 */
export function signSponsorContext(key: string, context: SponsorContext & { subject: string }): string {
    if (!usableKey(key)) throw new Error('sponsor_key_unusable');
    const body = Buffer.from(JSON.stringify([context.kind, context.campaignId, context.configSha256, Math.floor(context.issuedAt.getTime() / 1000), context.nonce, context.subject])).toString('base64url');
    return `${body}.${hmac(key, CONTEXT_DOMAIN, body).toString('base64url')}`;
}
export function verifySponsorContext(key: string, value: string | undefined, subject: string, now: Date): SponsorContext | null {
    // Includes the bounded UUID + 255-character verified subject used by creation recovery.
    const match = /^([A-Za-z0-9_-]{20,1024})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!match || !usableKey(key) || !safeEqual(Buffer.from(match[2]!, 'base64url'), hmac(key, CONTEXT_DOMAIN, match[1]!))) return null;
    try {
        const [kind, campaignId, configSha256, issued, nonce, boundSubject] = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as unknown[];
        if ((kind !== 'login' && kind !== 'creation') || typeof campaignId !== 'string' || typeof configSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(configSha256)
            || typeof issued !== 'number' || !Number.isSafeInteger(issued) || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64
            || typeof boundSubject !== 'string' || boundSubject !== subject) return null;
        const age = now.getTime() - issued * 1000;
        const ttl = (kind === 'login' ? SPONSOR_CONTEXT_TTL_SECONDS : SPONSOR_CREATION_HINT_TTL_SECONDS) * 1000;
        return age >= -60_000 && age <= ttl ? { kind, campaignId, configSha256, issuedAt: new Date(issued * 1000), nonce } : null;
    } catch {
        return null;
    }
}

export type SponsorRefusal = 'sponsor_disabled' | 'unknown_campaign' | 'campaign_inactive' | 'config_changed';
/**
 * Authorization for a NEW quote: the gate is on, the campaign is in the registry and active now, and its frozen hash is the one the person was
 * shown. A campaign that expired or was revoked stops new starts only; honoured subscriptions and webhook reconciliation never call this.
 */
export function authorizeSponsorQuote(input: { enabled: boolean; registry: SponsorRegistry; campaignId: string; configSha256: string | null; now: Date }):
    { ok: true; campaign: SponsorCampaign } | { ok: false; reason: SponsorRefusal } {
    if (!input.enabled) return { ok: false, reason: 'sponsor_disabled' };
    const campaign = resolveById(input.registry, input.campaignId);
    if (!campaign) return { ok: false, reason: 'unknown_campaign' };
    if (!campaignActive(campaign, input.now)) return { ok: false, reason: 'campaign_inactive' };
    if (input.configSha256 !== null && input.configSha256 !== campaign.configSha256) return { ok: false, reason: 'config_changed' };
    return { ok: true, campaign };
}
