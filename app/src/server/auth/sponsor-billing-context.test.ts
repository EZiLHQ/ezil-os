/** The carried Billing context: its own HMAC domain, bound to origin and user, capped at the original entry + 600 s and the campaign's end. */
import { describe, expect, it } from 'vitest';
import { signSponsorContext, verifySponsorContext } from '@/server/billing/v3/sponsor';
import { mintSponsorBillingContext, SPONSOR_BILLING_COOKIE, SPONSOR_BILLING_COOKIE_OPTIONS, sponsorBillingCookie, verifySponsorBillingContext } from './sponsor-billing-context';

const KEY = 'k'.repeat(40);
const NOW = new Date('2026-11-14T12:00:00.000Z');
const ORIGIN = 'https://os-staging.ezil.work', USER = '11111111-1111-4111-8111-111111111111';
const campaign = { campaignId: 'camp-acme', configSha256: 'c'.repeat(64), expiresAt: new Date('2026-12-31T00:00:00.000Z') };
const mint = (over: Partial<Parameters<typeof mintSponsorBillingContext>[1]> = {}, key = KEY) =>
    mintSponsorBillingContext(key, { campaign, origin: ORIGIN, userId: USER, issuedAt: NOW, now: NOW, provenance: 'opaque', ...over });
const verify = (value: string | undefined, over: Partial<{ origin: string; userId: string; now: Date }> = {}, key = KEY) =>
    verifySponsorBillingContext(key, value, { origin: ORIGIN, userId: USER, now: NOW, ...over });

describe('sponsor Billing context', () => {
    it('is a server-only Secure, HttpOnly, SameSite=Lax, Path=/ cookie with no Domain', () => {
        expect(SPONSOR_BILLING_COOKIE.startsWith('__Host-')).toBe(true);
        expect(SPONSOR_BILLING_COOKIE_OPTIONS).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
    });
    it('round-trips the campaign, config and ORIGINAL issue time for exactly this user and origin', () => {
        const minted = mint()!;
        expect(minted.maxAge).toBe(600);
        expect(verify(minted.value)).toMatchObject({ campaignId: 'camp-acme', configSha256: 'c'.repeat(64), issuedAt: NOW });
        expect(verify(minted.value, { origin: `${ORIGIN}/os?x=1` })).not.toBeNull();   // the origin is canonicalized
    });
    it('is bound: another user, origin, key or a tampered body never verifies', () => {
        const { value } = mint()!;
        expect(verify(value, { userId: '22222222-2222-4222-8222-222222222222' })).toBeNull();
        expect(verify(value, { origin: 'https://os.ezil.work' })).toBeNull();
        expect(verify(value, {}, 'x'.repeat(40))).toBeNull();
        const [body, mac] = value.split('.');
        const forged = Buffer.from(JSON.stringify([1, 'camp-other', 'c'.repeat(64), Math.floor(NOW.getTime() / 1000), 'n'.repeat(24)])).toString('base64url');
        expect(verify(`${forged}.${mac}`)).toBeNull();
        // The MAC's first character carries six full bits (its last one also carries base64url padding bits).
        expect(verify(`${body}.${mac!.startsWith('A') ? 'B' : 'A'}${mac!.slice(1)}`)).toBeNull();
    });
    it('domain separation, both directions: entry/login/creation contexts are not Billing contexts, and a Billing context is not one of them', () => {
        for (const subject of [`sponsor-entry|${ORIGIN}`, `sponsor-billing|${ORIGIN}|${USER}`, `${ORIGIN}|state|nonce`, `${USER}|auth0|abc`]) {
            const other = signSponsorContext(KEY, { kind: 'login', campaignId: 'camp-acme', configSha256: 'c'.repeat(64), issuedAt: NOW, nonce: 'n'.repeat(24), subject });
            expect(verify(other), subject).toBeNull();
        }
        const { value } = mint()!;
        for (const subject of [`sponsor-entry|${ORIGIN}`, `sponsor-billing|${ORIGIN}|${USER}`, `${USER}|auth0|abc`]) expect(verifySponsorContext(KEY, value, subject, NOW), subject).toBeNull();
    });
    it('lives until min(original entry + 600 s, campaign end), never longer, never refreshed by re-verification', () => {
        expect(mint({ issuedAt: new Date(NOW.getTime() - 590_000) })!.maxAge).toBe(10);
        expect(mint({ issuedAt: new Date(NOW.getTime() - 600_000) })).toBeNull();
        expect(mint({ campaign: { ...campaign, expiresAt: new Date(NOW.getTime() + 30_000) } })!.maxAge).toBe(30);
        expect(mint({ campaign: { ...campaign, expiresAt: NOW } })).toBeNull();
        const { value } = mint({ issuedAt: new Date(NOW.getTime() - 300_000) })!;
        expect(verify(value, { now: new Date(NOW.getTime() + 299_000) })).not.toBeNull();
        expect(verify(value, { now: new Date(NOW.getTime() + 301_000) })).toBeNull();   // verification never extends it
    });
    it('a future issue time is accepted only within 60 s; no key, a short key or no user mints nothing', () => {
        expect(mint({ issuedAt: new Date(NOW.getTime() + 60_000) })).not.toBeNull();
        expect(mint({ issuedAt: new Date(NOW.getTime() + 61_000) })).toBeNull();
        expect(mintSponsorBillingContext(undefined, { campaign, origin: ORIGIN, userId: USER, issuedAt: NOW, now: NOW, provenance: 'opaque' })).toBeNull();
        expect(mint({}, 'short')).toBeNull();
        expect(mint({ userId: '' })).toBeNull();
        const ahead = mint({ issuedAt: new Date(NOW.getTime() + 60_000) })!;
        expect(verify(ahead.value)).not.toBeNull();
    });
    it('seals the entry provenance (opaque / alias + canonical alias / unknown) under the MAC; it cannot be changed or invented', () => {
        expect(verify(mint({ provenance: 'opaque' })!.value)).toMatchObject({ provenance: 'opaque', alias: null });
        expect(verify(mint({ provenance: 'alias', alias: 'acme' })!.value)).toMatchObject({ provenance: 'alias', alias: 'acme' });
        expect(verify(mint({ provenance: 'unknown' })!.value)).toMatchObject({ provenance: 'unknown', alias: null });
        expect(verify(mint({ provenance: 'opaque', alias: 'acme' })!.value)).toMatchObject({ alias: null });   // only an alias entry carries one
        expect(mint({ provenance: 'alias' })).toBeNull();                                                  // an alias entry needs its alias
        expect(mint({ provenance: 'alias', alias: 'Not Canonical' })).toBeNull();
        // Rewriting the provenance without the key never verifies.
        const { value } = mint({ provenance: 'alias', alias: 'acme' })!;
        const [body, mac] = value.split('.');
        const parts = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8')) as unknown[];
        const rewritten = Buffer.from(JSON.stringify([...parts.slice(0, 5), 'opaque', null])).toString('base64url');
        expect(verify(`${rewritten}.${mac}`)).toBeNull();
    });
    it('reads exactly one cookie of its name; several are one invalid value', () => {
        expect(sponsorBillingCookie(null)).toBeUndefined();
        expect(sponsorBillingCookie('a=1; b=2')).toBeUndefined();
        expect(sponsorBillingCookie(`a=1; ${SPONSOR_BILLING_COOKIE}=abc; b=2`)).toBe('abc');
        expect(sponsorBillingCookie(`${SPONSOR_BILLING_COOKIE}=abc; ${SPONSOR_BILLING_COOKIE}=def`)).toBe('');
    });
});
