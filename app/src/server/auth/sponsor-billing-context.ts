/**
 * The carried legacy sponsor context for OS Billing (Root carrier decision 2026-11-14): one server-only cookie, minted only from a fresh
 * legitimate sponsor entry that this request verified, bound to the origin and the AUTHENTICATED OS user, and never refreshed.
 *
 *  - HMAC-SHA256 under SPONSOR_KEY with its own domain (`ezil-sponsor-billing-v1:`); the MAC covers `origin|userId|body`, so the value is
 *    useless to another user, another origin, or as an entry/login/creation context (and those are useless here).
 *  - The body is [2, campaignId, configSha256, issuedAt, nonce, provenance, alias]: issuedAt is the ORIGINAL entry's (a signed-in direct
 *    entry: now; after sign-in: the separately verified entry cookie's), never the auth transaction's re-minted time; provenance/alias are
 *    the entry's sealed opaque/alias/unknown origin and canonical public alias.
 *  - Lifetime = min(issuedAt + 600 s, campaign.expiresAt) - now, positive only; a future issuedAt is accepted only within 60 s.
 *  - Verifying returns the claims only. The trial authority (v3/trial-authority.ts) re-authorizes them against the live signed registry and
 *    config hash on every summary, quote and checkout. No opaque invitation token is carried or stored.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SponsorCampaign, SponsorContext } from '@/server/billing/v3/sponsor';

export const SPONSOR_BILLING_COOKIE = '__Host-ezil-sponsor-billing';
export const SPONSOR_BILLING_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const DOMAIN = 'ezil-sponsor-billing-v1:';
export const SPONSOR_BILLING_WINDOW_SECONDS = 600;
const FUTURE_SKEW_SECONDS = 60;

const usableKey = (key: string | undefined): key is string => typeof key === 'string' && key.length >= 32;
const mac = (key: string, origin: string, userId: string, body: string) => createHmac('sha256', key).update(`${DOMAIN}${origin}|${userId}|${body}`).digest();
const canonicalOrigin = (origin: string) => new URL(origin).origin;

/**
 * How the original entry arrived (sealed by the entry, never inferred later): `opaque` = an invitation token, `alias` = a public alias (then
 * `alias` is the campaign's canonical partner id), `unknown` = an entry sealed before provenance existed. Ephemeral, cookie-only.
 */
export type SponsorBillingProvenance = 'opaque' | 'alias' | 'unknown';
export type VerifiedSponsorBillingContext = SponsorContext & { provenance: SponsorBillingProvenance; alias: string | null };

/** null: nothing to carry (no usable key, an issuedAt too far ahead, no positive lifetime left, or an alias provenance without its alias). */
export function mintSponsorBillingContext(key: string | undefined, input: { campaign: Pick<SponsorCampaign, 'campaignId' | 'configSha256' | 'expiresAt'>;
    origin: string; userId: string; issuedAt: Date; now: Date; provenance: SponsorBillingProvenance; alias?: string | null }): { value: string; maxAge: number } | null {
    if (!usableKey(key) || !input.userId) return null;
    const alias = input.provenance === 'alias' ? input.alias ?? null : null;
    if (input.provenance === 'alias' && (alias === null || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(alias))) return null;
    const issued = Math.floor(input.issuedAt.getTime() / 1000), now = input.now.getTime() / 1000;
    if (!Number.isSafeInteger(issued) || issued - now > FUTURE_SKEW_SECONDS) return null;
    const maxAge = Math.floor(Math.min(issued + SPONSOR_BILLING_WINDOW_SECONDS, input.campaign.expiresAt.getTime() / 1000) - now);
    if (!(maxAge > 0)) return null;
    const body = Buffer.from(JSON.stringify([2, input.campaign.campaignId, input.campaign.configSha256, issued, randomBytes(18).toString('base64url'),
        input.provenance, alias])).toString('base64url');
    return { value: `${body}.${mac(key, canonicalOrigin(input.origin), input.userId, body).toString('base64url')}`, maxAge };
}

/** The verified claims, or null for anything else (wrong user/origin/domain, malformed, expired, or issued too far ahead). */
export function verifySponsorBillingContext(key: string | undefined, value: string | undefined, input: { origin: string; userId: string; now: Date }): VerifiedSponsorBillingContext | null {
    const match = /^([A-Za-z0-9_-]{20,1024})\.([A-Za-z0-9_-]{43})$/.exec(value ?? '');
    if (!match || !usableKey(key) || !input.userId) return null;
    const presented = Buffer.from(match[2]!, 'base64url'), expected = mac(key, canonicalOrigin(input.origin), input.userId, match[1]!);
    if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null;
    try {
        const parts = JSON.parse(Buffer.from(match[1]!, 'base64url').toString('utf8')) as unknown[];
        const [v, campaignId, configSha256, issued, nonce, provenance, alias] = parts;
        if (parts.length !== 7 || v !== 2 || typeof campaignId !== 'string' || typeof configSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(configSha256)
            || typeof issued !== 'number' || !Number.isSafeInteger(issued) || typeof nonce !== 'string' || nonce.length < 8 || nonce.length > 64
            || (provenance !== 'opaque' && provenance !== 'alias' && provenance !== 'unknown')
            || (provenance === 'alias' ? typeof alias !== 'string' || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(alias) : alias !== null)) return null;
        const age = input.now.getTime() / 1000 - issued;
        if (age < -FUTURE_SKEW_SECONDS || age > SPONSOR_BILLING_WINDOW_SECONDS) return null;
        return { kind: 'login', campaignId, configSha256, issuedAt: new Date(issued * 1000), nonce, provenance, alias: provenance === 'alias' ? alias as string : null };
    } catch {
        return null;
    }
}

/** The cookie's value from a Cookie header, or undefined when absent. Several cookies of this name are treated as one invalid value. */
export function sponsorBillingCookie(header: string | null | undefined): string | undefined {
    const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${SPONSOR_BILLING_COOKIE}=`))
        .map(part => part.slice(SPONSOR_BILLING_COOKIE.length + 1));
    return values.length === 0 ? undefined : values.length === 1 ? values[0] : '';
}
