import { describe, expect, it } from 'vitest';
import {
    EMPTY_REGISTRY, SPONSOR_CONTEXT_TTL_SECONDS, SPONSOR_CREATION_HINT_TTL_SECONDS, accountKeyFor, authorizeSponsorQuote, campaignActive, hashSponsorToken,
    parseSponsorRegistry, publicTrialEnabled, resolveById, resolveByToken, signSponsorContext, signSponsorRegistry, sponsorTrialsEnabled, verifySponsorContext,
    type SponsorContext,
} from './sponsor';

const KEY = 'k'.repeat(40);
const NOW = new Date('2026-11-12T00:00:00Z');
const entry = (over: Record<string, unknown> = {}) => ({ campaignId: 'test-campaign-a', partnerId: 'test-partner-a', version: 1, enabled: true,
    startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken('token-a-0000000000000000'), ...over });
const registryOf = (campaigns: unknown[], key = KEY, tamper = false) => {
    const document = JSON.stringify({ v: 1, campaigns });
    return parseSponsorRegistry({ document: tamper ? document.replace('1', '2') : document, signature: signSponsorRegistry(document, key), key: KEY });
};

describe('signed registry fails closed', () => {
    it('accepts a valid signed document and hashes each canonical entry', () => {
        const registry = registryOf([entry(), entry({ campaignId: 'test-campaign-b', partnerId: 'test-partner-b', tokenSha256: hashSponsorToken('token-b-0000000000000000') })]);
        expect(registry.size).toBe(2);
        const a = registry.get('test-campaign-a')!;
        expect(a.configSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(registryOf([entry({ version: 2 })]).get('test-campaign-a')!.configSha256).not.toBe(a.configSha256);
        expect(registryOf([entry()]).get('test-campaign-a')!.configSha256).toBe(a.configSha256);
    });
    it('returns no campaigns for a missing, unsigned, tampered, wrongly signed or short-keyed registry', () => {
        const document = JSON.stringify({ v: 1, campaigns: [entry()] });
        const good = signSponsorRegistry(document, KEY);
        expect(parseSponsorRegistry({ document: undefined, signature: good, key: KEY })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document, signature: undefined, key: KEY })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document, signature: good, key: undefined })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document, signature: good, key: 'short' })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document: document.replace('"version":1', '"version":9'), signature: good, key: KEY })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document, signature: signSponsorRegistry(document, 'j'.repeat(40)), key: KEY })).toBe(EMPTY_REGISTRY);
        expect(parseSponsorRegistry({ document, signature: 'not base64url!!', key: KEY })).toBe(EMPTY_REGISTRY);
        expect(registryOf([entry()], KEY, true)).toBe(EMPTY_REGISTRY);
    });
    it('is strict: unknown fields, bad ids, bad windows, duplicate ids or tokens and wrong versions all empty the registry', () => {
        for (const bad of [entry({ extra: 1 }), entry({ campaignId: 'X' }), entry({ campaignId: 'has space' }), entry({ version: 0 }), entry({ tokenSha256: 'abc' }),
            entry({ expiresAt: '2026-10-01T00:00:00Z' }), entry({ startsAt: 'yesterday' }), entry({ price: 0 }), entry({ redirectTo: 'https://x.invalid' }), entry({ coupon: 'FREE' })])
            expect(registryOf([bad])).toBe(EMPTY_REGISTRY);
        expect(registryOf([entry(), entry()])).toBe(EMPTY_REGISTRY);
        expect(registryOf([entry(), entry({ campaignId: 'test-campaign-b' })])).toBe(EMPTY_REGISTRY);   // same token on two campaigns
        const document = JSON.stringify({ v: 2, campaigns: [] });
        expect(parseSponsorRegistry({ document, signature: signSponsorRegistry(document, KEY), key: KEY })).toBe(EMPTY_REGISTRY);
        const notJson = '{not json';
        expect(parseSponsorRegistry({ document: notJson, signature: signSponsorRegistry(notJson, KEY), key: KEY })).toBe(EMPTY_REGISTRY);
    });
});

describe('gates and resolution', () => {
    it('sponsor is off unless exactly "1"; the public trial is on unless exactly "0"; the two are independent', () => {
        expect([undefined, '', '0', 'true', 'yes'].map(v => sponsorTrialsEnabled({ SPONSOR_TRIALS_ENABLED: v }))).toEqual([false, false, false, false, false]);
        expect(sponsorTrialsEnabled({ SPONSOR_TRIALS_ENABLED: '1' })).toBe(true);
        expect([undefined, '', '1', 'false'].map(v => publicTrialEnabled({ BILLING_PUBLIC_STANDARD_TRIAL: v }))).toEqual([true, true, true, true]);
        expect(publicTrialEnabled({ BILLING_PUBLIC_STANDARD_TRIAL: '0' })).toBe(false);
        // public off + sponsor on: a valid sponsor authorizes while the public offer is off
        const registry = registryOf([entry()]);
        expect(publicTrialEnabled({ BILLING_PUBLIC_STANDARD_TRIAL: '0' })).toBe(false);
        expect(authorizeSponsorQuote({ enabled: sponsorTrialsEnabled({ SPONSOR_TRIALS_ENABLED: '1' }), registry, campaignId: 'test-campaign-a', configSha256: null, now: NOW }).ok).toBe(true);
    });
    it('resolves by token or opaque id, never by a guess', () => {
        const registry = registryOf([entry()]);
        expect(resolveByToken(registry, 'token-a-0000000000000000')?.campaignId).toBe('test-campaign-a');
        expect(resolveByToken(registry, 'token-a-0000000000000001')).toBeNull();
        expect(resolveByToken(EMPTY_REGISTRY, 'token-a-0000000000000000')).toBeNull();
        expect(resolveById(registry, 'test-campaign-a')?.partnerId).toBe('test-partner-a');
        expect(resolveById(registry, 'nope')).toBeNull();
    });
    it('authorizes a new quote only for an enabled, in-window campaign whose frozen hash is unchanged', () => {
        const registry = registryOf([entry()]);
        const hash = registry.get('test-campaign-a')!.configSha256;
        const ask = (over: Partial<Parameters<typeof authorizeSponsorQuote>[0]> = {}) => authorizeSponsorQuote({ enabled: true, registry, campaignId: 'test-campaign-a', configSha256: hash, now: NOW, ...over });
        expect(ask().ok).toBe(true);
        expect(ask({ enabled: false })).toEqual({ ok: false, reason: 'sponsor_disabled' });
        expect(ask({ campaignId: 'nope' })).toEqual({ ok: false, reason: 'unknown_campaign' });
        expect(ask({ registry: EMPTY_REGISTRY })).toEqual({ ok: false, reason: 'unknown_campaign' });
        expect(ask({ configSha256: 'f'.repeat(64) })).toEqual({ ok: false, reason: 'config_changed' });
        expect(ask({ now: new Date('2026-10-31T23:59:59Z') })).toEqual({ ok: false, reason: 'campaign_inactive' });
        expect(ask({ now: new Date('2026-12-01T00:00:00Z') })).toEqual({ ok: false, reason: 'campaign_inactive' });
        expect(authorizeSponsorQuote({ enabled: true, registry: registryOf([entry({ enabled: false })]), campaignId: 'test-campaign-a', configSha256: null, now: NOW })).toEqual({ ok: false, reason: 'campaign_inactive' });
        expect(campaignActive(registry.get('test-campaign-a')!, NOW)).toBe(true);
    });
});

describe('account key and signed context', () => {
    const user = '11111111-1111-4111-8111-111111111111';
    it('is a stable UUID-shaped pseudonym per user and key, and differs by user and key', () => {
        const a = accountKeyFor(user, KEY);
        expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(accountKeyFor(user.toUpperCase(), KEY)).toBe(a);
        expect(accountKeyFor('22222222-2222-4222-8222-222222222222', KEY)).not.toBe(a);
        expect(accountKeyFor(user, 'j'.repeat(40))).not.toBe(a);
        expect(a).not.toContain(user.slice(0, 8));
        expect(() => accountKeyFor(user, 'short')).toThrow('sponsor_key_unusable');
    });
    const ctx = (over: Partial<SponsorContext & { subject: string }> = {}) => ({ kind: 'login' as const, campaignId: 'test-campaign-a', configSha256: 'a'.repeat(64), issuedAt: NOW, nonce: 'nonce-12345678', subject: 'auth0:abc', ...over });
    it('round-trips only for the bound subject, within its window, and rejects tampering and the wrong key', () => {
        const token = signSponsorContext(KEY, ctx());
        expect(verifySponsorContext(KEY, token, 'auth0:abc', NOW)).toEqual({ kind: 'login', campaignId: 'test-campaign-a', configSha256: 'a'.repeat(64), issuedAt: NOW, nonce: 'nonce-12345678' });
        expect(verifySponsorContext(KEY, token, 'auth0:other', NOW)).toBeNull();
        expect(verifySponsorContext('j'.repeat(40), token, 'auth0:abc', NOW)).toBeNull();
        expect(verifySponsorContext(KEY, `${token}x`, 'auth0:abc', NOW)).toBeNull();
        expect(verifySponsorContext(KEY, undefined, 'auth0:abc', NOW)).toBeNull();
        expect(verifySponsorContext(KEY, token.replace(/^./, c => (c === 'W' ? 'X' : 'W')), 'auth0:abc', NOW)).toBeNull();
        expect(verifySponsorContext(KEY, token, 'auth0:abc', new Date(NOW.getTime() + (SPONSOR_CONTEXT_TTL_SECONDS + 1) * 1000))).toBeNull();
        expect(verifySponsorContext(KEY, token, 'auth0:abc', new Date(NOW.getTime() - 120_000))).toBeNull();
    });
    it('a creation hint outlives a login context, for recovery after an auth-create or SQL failure', () => {
        const hint = signSponsorContext(KEY, ctx({ kind: 'creation' }));
        expect(verifySponsorContext(KEY, hint, 'auth0:abc', new Date(NOW.getTime() + (SPONSOR_CONTEXT_TTL_SECONDS + 60) * 1000))?.kind).toBe('creation');
        expect(verifySponsorContext(KEY, hint, 'auth0:abc', new Date(NOW.getTime() + (SPONSOR_CREATION_HINT_TTL_SECONDS + 1) * 1000))).toBeNull();
    });
    it('refuses to sign with an unusable key', () => expect(() => signSponsorContext('short', ctx())).toThrow('sponsor_key_unusable'));
});
