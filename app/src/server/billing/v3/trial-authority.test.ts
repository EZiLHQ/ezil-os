/** The shared trial authority: both public controls, legacy-first alias resolution with deny, ambiguity, pending links and contexts. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signSponsorContext, signSponsorRegistry, verifySponsorContext, type SponsorContext } from './sponsor';
import { inspectSponsorRegistry, legacyAliasMatch, normalizeTrialAlias, PUBLIC_STANDARD_TRIAL_METADATA_KEY, selectTrialAuthority, sponsorOfferFingerprint,
    stagePublicTrialOpen, type LegacyRegistryState, type TrialAuthorityInput } from './trial-authority';
import { selectTrialOffer } from './trial-campaigns';
import { CAMPAIGNS_ON, STANDARD_PRICE_ID, STANDARD_PRODUCT_ID, standardTrialRead } from './trial-campaigns.test-support';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const KEY = 'k'.repeat(40);
const token = (n: number) => createHash('sha256').update(`token-${n}`).digest('hex');
type Entry = { campaignId: string; partnerId: string; enabled?: boolean; startsAt?: string; expiresAt?: string; version?: number };
const entry = (e: Entry, n: number) => ({ campaignId: e.campaignId, partnerId: e.partnerId, version: e.version ?? 1, enabled: e.enabled ?? true,
    startsAt: e.startsAt ?? '2026-11-01T00:00:00.000Z', expiresAt: e.expiresAt ?? '2026-12-31T00:00:00.000Z', tokenSha256: token(n) });
function registry(entries: Entry[]): LegacyRegistryState {
    const document = JSON.stringify({ v: 1, campaigns: entries.map(entry) });
    return inspectSponsorRegistry({ document, signature: signSponsorRegistry(document, KEY), key: KEY });
}
const ABSENT: LegacyRegistryState = { state: 'absent' };
const LEGACY = registry([{ campaignId: 'camp-acme', partnerId: 'acme' }]);
const campaigns = (o: Record<string, unknown>) => JSON.stringify({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true } }, ...o });
/** Product metadata: `campaigns` value (undefined = no key) and Stage's public control (undefined = no key). */
const read = (campaignsRaw?: string, publicControl?: string) => standardTrialRead(campaignsRaw, {}, publicControl === undefined ? {}
    : { metadata: { ezil_plan: 'standard', ...(campaignsRaw === undefined ? {} : { ezil_standard_trial_campaigns: campaignsRaw }), [PUBLIC_STANDARD_TRIAL_METADATA_KEY]: publicControl } });
const select = (over: Partial<TrialAuthorityInput> = {}) => selectTrialAuthority({ alias: null, pendingLink: null, legacyContext: null, legacy: ABSENT,
    legacyEnabled: true, read: read(CAMPAIGNS_ON), livemodeMatches: true, now: NOW, ...over });
type Provenance = 'opaque' | 'alias' | 'unknown';
const context = (campaignId: string, configSha256: string, provenance: Provenance = 'opaque', alias: string | null = null): SponsorContext & { provenance: Provenance; alias: string | null } => {
    const value = signSponsorContext(KEY, { kind: 'login', campaignId, configSha256, issuedAt: NOW, nonce: 'n'.repeat(24), subject: 'sponsor-billing|test' });
    return { ...verifySponsorContext(KEY, value, 'sponsor-billing|test', NOW)!, provenance, alias };
};
const acme = () => (LEGACY as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-acme')!;

describe('legacy registry inspection keeps none, verified and unverifiable apart', () => {
    it('absent, validly signed (empty or not), and every refusal of the existing parser', () => {
        expect(inspectSponsorRegistry({ document: undefined, signature: undefined, key: KEY })).toEqual({ state: 'absent' });
        expect(registry([]).state).toBe('verified');
        expect(LEGACY.state).toBe('verified');
        const document = JSON.stringify({ v: 1, campaigns: [entry({ campaignId: 'camp-acme', partnerId: 'acme' }, 1)] });
        expect(inspectSponsorRegistry({ document, signature: signSponsorRegistry(document, 'x'.repeat(40)), key: KEY })).toEqual({ state: 'invalid' });
        expect(inspectSponsorRegistry({ document, signature: signSponsorRegistry(document, KEY), key: undefined })).toEqual({ state: 'invalid' });
        expect(inspectSponsorRegistry({ document, signature: undefined, key: KEY })).toEqual({ state: 'invalid' });
        expect(inspectSponsorRegistry({ document: '{"v":1,"campaigns":[{}]}', signature: signSponsorRegistry('{"v":1,"campaigns":[{}]}', KEY), key: KEY })).toEqual({ state: 'invalid' });
        // Duplicate campaign ids or tokens: the existing parser answers EMPTY; inspection says invalid, never "none".
        expect(registry([{ campaignId: 'camp-a', partnerId: 'a1a' }, { campaignId: 'camp-a', partnerId: 'b1b' }])).toEqual({ state: 'invalid' });
    });
    it('alias matches count every entry, retained disabled/expired ones included', () => {
        const state = registry([{ campaignId: 'camp-1', partnerId: 'dup' }, { campaignId: 'camp-2', partnerId: 'dup', enabled: false }, { campaignId: 'camp-3', partnerId: 'old', expiresAt: '2026-11-02T00:00:00.000Z' }]);
        expect(legacyAliasMatch(state, 'dup')).toEqual({ kind: 'ambiguous' });
        expect(legacyAliasMatch(state, 'old')).toMatchObject({ kind: 'exact', campaign: { campaignId: 'camp-3' } });
        expect(legacyAliasMatch(state, 'nobody')).toEqual({ kind: 'none' });
        expect(legacyAliasMatch({ state: 'invalid' }, 'old')).toEqual({ kind: 'registry_invalid' });
        expect(legacyAliasMatch(ABSENT, 'old')).toEqual({ kind: 'none' });
    });
});

describe('public offer: both controls', () => {
    it.each([
        ['both keys absent (current Stage state)', read(undefined), true],
        ['Stage control "true", campaigns absent', read(undefined, 'true'), true],
        ['Stage control "false"', read(undefined, 'false'), false],
        ['Stage control unknown value', read(undefined, 'yes'), false],
        ['campaigns publicEnabled false', read(campaigns({ publicEnabled: false })), false],
        ['campaigns on, Stage control "false"', read(CAMPAIGNS_ON, 'false'), false],
        ['malformed campaigns', read('{'), false],
    ])('%s', (_name, r, open) => {
        const result = select({ read: r });
        expect(result.ok).toBe(open);
        if (result.ok) expect(result.authority).toEqual({ source: 'public', offer: (selectTrialOffer(r, null, NOW) as { ok: true; offer: unknown }).offer });
        else expect(result).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
    it('a live/test mismatch closes the public offer', () => {
        expect(select({ read: read(undefined), livemodeMatches: false })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        expect(stagePublicTrialOpen({}, true)).toBe(true);
        expect(stagePublicTrialOpen({ [PUBLIC_STANDARD_TRIAL_METADATA_KEY]: 'true' }, false)).toBe(false);
    });
    it('bad Standard price terms refuse every source', () => {
        const bad = standardTrialRead(CAMPAIGNS_ON, { unitAmount: 1000 });
        for (const over of [{}, { alias: 'midhun' }, { alias: 'acme', legacy: LEGACY }, { pendingLink: { campaignId: 'camp-acme', configSha256: acme().configSha256, claimed: false }, legacy: LEGACY }]) {
            expect(select({ read: bad, ...over })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        }
    });
});

describe('a selected promoter or legacy campaign overrides both public controls', () => {
    it('Product promoter with both public controls closed', () => {
        const r = read(campaigns({ publicEnabled: false }), 'false');
        expect(select({ read: r, alias: ' MIDHUN ' })).toMatchObject({ ok: true, pending: 'none', authority: { source: 'promoter', offer: { coupon: 'midhun', priceId: STANDARD_PRICE_ID } } });
    });
    it('active legacy alias with both public controls closed, fingerprinted over its frozen terms', () => {
        const result = select({ read: read(campaigns({ publicEnabled: false }), 'false'), alias: 'acme', legacy: LEGACY });
        expect(result).toMatchObject({ ok: true, authority: { source: 'sponsor', via: 'alias', campaign: { campaignId: 'camp-acme' }, offer: { coupon: 'acme' } } });
        if (result.ok) expect(result.authority.offer.fingerprint).toBe(sponsorOfferFingerprint(acme(), STANDARD_PRODUCT_ID, STANDARD_PRICE_ID));
    });
});

describe('a known legacy alias owns its resolution, deny included', () => {
    it.each([
        ['disabled', registry([{ campaignId: 'camp-acme', partnerId: 'acme', enabled: false }])],
        ['expired', registry([{ campaignId: 'camp-acme', partnerId: 'acme', expiresAt: '2026-11-10T00:00:00.000Z' }])],
        ['not started', registry([{ campaignId: 'camp-acme', partnerId: 'acme', startsAt: '2026-11-20T00:00:00.000Z' }])],
    ])('%s legacy alias: unavailable, never the promoter or public offer', (_name, legacy) => {
        expect(select({ alias: 'acme', legacy, read: read(campaigns({ promoters: {} })) })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
    it('legacy runtime off: a known alias is still known, and denied', () => {
        expect(select({ alias: 'acme', legacy: LEGACY, legacyEnabled: false })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
    it('duplicated legacy alias: invalid, not downgraded', () => {
        const legacy = registry([{ campaignId: 'camp-1', partnerId: 'acme' }, { campaignId: 'camp-2', partnerId: 'acme' }]);
        expect(select({ alias: 'acme', legacy })).toEqual({ ok: false, code: 'trial_offer_invalid' });
    });
    it('an unverifiable legacy registry cannot prove any alias unknown', () => {
        expect(select({ alias: 'midhun', legacy: { state: 'invalid' } })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        // The public offer does not depend on the legacy registry.
        expect(select({ legacy: { state: 'invalid' } })).toMatchObject({ ok: true, authority: { source: 'public' } });
    });
    it('malformed Product metadata cannot prove a legacy alias is not also a promoter', () => {
        expect(select({ alias: 'acme', legacy: LEGACY, read: read('{') })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
});

describe('aliases in both authorities, and unknown aliases', () => {
    it('an alias in both registries is ambiguous and refused (no promoter name is special)', () => {
        for (const name of ['acme', 'midhun']) {
            const legacy = registry([{ campaignId: `camp-${name}`, partnerId: name }]);
            expect(select({ alias: name, legacy, read: read(campaigns({ promoters: { [name]: { enabled: true } } })) })).toEqual({ ok: false, code: 'trial_offer_invalid' });
        }
        // Ambiguous even when the legacy entry is disabled or the promoter is disabled.
        const legacy = registry([{ campaignId: 'camp-midhun', partnerId: 'midhun', enabled: false }]);
        expect(select({ alias: 'midhun', legacy, read: read(campaigns({ promoters: { midhun: { enabled: false } } })) })).toEqual({ ok: false, code: 'trial_offer_invalid' });
    });
    it('an alias unknown to a verified (or absent) legacy registry selects fresh Product promoter terms', () => {
        for (const legacy of [LEGACY, ABSENT, registry([])]) {
            expect(select({ alias: 'midhun', legacy })).toMatchObject({ ok: true, authority: { source: 'promoter', offer: { coupon: 'midhun' } } });
        }
        expect(select({ alias: 'someone', legacy: LEGACY })).toEqual({ ok: false, code: 'trial_offer_invalid' });
        expect(select({ alias: 'midhun', read: read(campaigns({ promoters: { midhun: { enabled: false } } })) })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
    it('a two-character Product alias (outside the legacy grammar) reaches the Product promoter; a malformed one is invalid', () => {
        const r = read(campaigns({ promoters: { ab: { enabled: true } } }));
        expect(select({ alias: 'AB', legacy: LEGACY, read: r })).toMatchObject({ ok: true, authority: { source: 'promoter', offer: { coupon: 'ab' } } });
        for (const alias of ['a', 'a!', '-ab']) expect(select({ alias, legacy: LEGACY, read: r })).toEqual({ ok: false, code: 'trial_offer_invalid' });
    });
    it('malformed or legacy-only-grammar unknown aliases are invalid, never public', () => {
        for (const alias of ['', 'a b', 'x', 42, 'has_underscore', 'a'.repeat(40)]) expect(select({ alias, legacy: LEGACY })).toEqual({ ok: false, code: 'trial_offer_invalid' });
        expect(normalizeTrialAlias(' Acme ')).toBe('acme');
    });
});

describe('pending quote-owned link and verified context', () => {
    const link = (over: Partial<{ campaignId: string; configSha256: string; claimed: boolean }> = {}) => ({ campaignId: 'camp-acme', configSha256: acme().configSha256, claimed: false, ...over });
    it('with no new selection the pending link resumes under the frozen rules', () => {
        expect(select({ legacy: LEGACY, pendingLink: link(), read: read(campaigns({ publicEnabled: false }), 'false') }))
            .toMatchObject({ ok: true, pending: 'same', authority: { source: 'sponsor', via: 'pending', campaign: { campaignId: 'camp-acme' }, offer: { coupon: null } } });
        expect(select({ legacy: LEGACY, pendingLink: link({ configSha256: 'f'.repeat(64) }) })).toEqual({ ok: false, code: 'trial_quote_stale' });
        // An absent or unverifiable registry proves nothing: the link stays and refuses, never the public offer.
        expect(select({ legacy: ABSENT, pendingLink: link() })).toEqual({ ok: false, code: 'trial_unavailable' });
        expect(select({ legacy: { state: 'invalid' }, pendingLink: link() })).toEqual({ ok: false, code: 'trial_unavailable' });
    });
    it('a pending link whose exact campaign a verified registry proves disabled/expired/not started may give way to the public offer, released conditionally', () => {
        const disabled = registry([{ campaignId: 'camp-acme', partnerId: 'acme', enabled: false }]);
        for (const legacy of [disabled, registry([{ campaignId: 'camp-acme', partnerId: 'acme', expiresAt: '2026-11-10T00:00:00.000Z' }]),
            registry([{ campaignId: 'camp-acme', partnerId: 'acme', startsAt: '2026-11-20T00:00:00.000Z' }])]) {
            const config = (legacy as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-acme')!.configSha256;
            expect(select({ legacy, pendingLink: link({ configSha256: config }) })).toMatchObject({ ok: true, pending: 'different', releasePending: true, authority: { source: 'public' } });
            // Both public controls still apply; closed means refused, the link left in place.
            expect(select({ legacy, pendingLink: link({ configSha256: config }), read: read(undefined, 'false') })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        }
        const disabledConfig = (disabled as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-acme')!.configSha256;
        // A claimed link is never released: it stays and refuses.
        expect(select({ legacy: disabled, pendingLink: link({ configSha256: disabledConfig, claimed: true }) })).toEqual({ ok: false, code: 'trial_unavailable' });
        // Revocation advances the live config hash (enabled is hashed): a link frozen under the earlier hash is still provably inactive.
        expect(select({ legacy: disabled, pendingLink: link() })).toMatchObject({ ok: true, pending: 'different', releasePending: true, authority: { source: 'public' } });
        // An ACTIVE campaign whose hash changed is stale, never released.
        expect(select({ legacy: LEGACY, pendingLink: link({ configSha256: 'f'.repeat(64) }) })).toEqual({ ok: false, code: 'trial_quote_stale' });
    });
    it('negative: a removed (unknown) campaign, runtime off or an unverifiable registry is NOT proof; the link stays and the quote refuses', () => {
        const removed = registry([{ campaignId: 'camp-other', partnerId: 'other' }]);
        for (const over of [{ legacy: removed }, { legacy: LEGACY, legacyEnabled: false }, { legacy: ABSENT }, { legacy: { state: 'invalid' } as LegacyRegistryState }]) {
            expect(select({ ...over, pendingLink: link() })).toEqual({ ok: false, code: 'trial_unavailable' });
            // Nor does a promoter selection make it releasable.
            const promoter = select({ ...over, pendingLink: link(), alias: 'midhun' });
            if (promoter.ok) expect(promoter).toMatchObject({ pending: 'different', releasePending: false });
        }
    });
    it('a new selection reports how it relates to the pending link; it is never silently retargeted', () => {
        expect(select({ legacy: LEGACY, pendingLink: link(), alias: 'acme' })).toMatchObject({ ok: true, pending: 'same', releasePending: false });
        // An ACTIVE pending link: a promoter selection is 'different' and not releasable (the caller refuses it as stale).
        expect(select({ legacy: LEGACY, pendingLink: link(), alias: 'midhun' })).toMatchObject({ ok: true, pending: 'different', releasePending: false, authority: { source: 'promoter' } });
        // An inactive one (its exact campaign and config, verified): releasable for the promoter quote.
        const off = registry([{ campaignId: 'camp-acme', partnerId: 'acme', enabled: false }]);
        const offConfig = (off as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-acme')!.configSha256;
        expect(select({ legacy: off, pendingLink: link({ configSha256: offConfig }), alias: 'midhun' })).toMatchObject({ ok: true, pending: 'different', releasePending: true });
    });
    it('a verified active context selects its campaign; inactive, changed or off contexts fail closed', () => {
        const ctx = context('camp-acme', acme().configSha256);
        expect(select({ legacy: LEGACY, legacyContext: ctx, read: read(campaigns({ publicEnabled: false }), 'false') }))
            .toMatchObject({ ok: true, authority: { source: 'sponsor', via: 'context', campaign: { campaignId: 'camp-acme' } } });
        expect(select({ legacy: LEGACY, legacyContext: ctx, alias: 'acme' })).toMatchObject({ ok: true, authority: { via: 'context' } });
        expect(select({ legacy: LEGACY, legacyContext: ctx, alias: 'midhun' })).toEqual({ ok: false, code: 'trial_offer_invalid' });
        expect(select({ legacy: LEGACY, legacyContext: context('camp-acme', 'f'.repeat(64)) })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        expect(select({ legacy: LEGACY, legacyEnabled: false, legacyContext: ctx })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        expect(select({ legacy: registry([{ campaignId: 'camp-acme', partnerId: 'acme', expiresAt: '2026-11-10T00:00:00.000Z' }]), legacyContext: ctx })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
    it('carried provenance: an opaque invitation keeps legacy priority over a colliding promoter; alias or unknown provenance fails closed, re-checked fresh', () => {
        const midhunLegacy = registry([{ campaignId: 'camp-midhun', partnerId: 'midhun' }]);
        const cfg = (midhunLegacy as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-midhun')!.configSha256;
        // `midhun` is ALSO a Product promoter in CAMPAIGNS_ON.
        expect(select({ legacy: midhunLegacy, legacyContext: context('camp-midhun', cfg, 'opaque') })).toMatchObject({ ok: true, authority: { source: 'sponsor', via: 'context' } });
        expect(select({ legacy: midhunLegacy, legacyContext: context('camp-midhun', cfg, 'alias', 'midhun') })).toEqual({ ok: false, code: 'trial_offer_invalid' });
        expect(select({ legacy: midhunLegacy, legacyContext: context('camp-midhun', cfg, 'unknown') })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        // Without the collision both work; malformed Product metadata cannot prove "no collision".
        const noPromoter = read(campaigns({ promoters: {} }));
        expect(select({ legacy: midhunLegacy, read: noPromoter, legacyContext: context('camp-midhun', cfg, 'alias', 'midhun') })).toMatchObject({ ok: true });
        expect(select({ legacy: midhunLegacy, read: noPromoter, legacyContext: context('camp-midhun', cfg, 'unknown') })).toMatchObject({ ok: true });
        expect(select({ legacy: midhunLegacy, read: read('{'), legacyContext: context('camp-midhun', cfg, 'unknown') })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        // An opaque invitation never depends on the Product promoters.
        expect(select({ legacy: midhunLegacy, read: read('{'), legacyContext: context('camp-midhun', cfg, 'opaque') })).toMatchObject({ ok: true, authority: { source: 'sponsor' } });
        // An alias provenance must name the campaign's own canonical alias.
        expect(select({ legacy: LEGACY, legacyContext: context('camp-acme', acme().configSha256, 'alias', 'other') })).toEqual({ ok: false, code: 'trial_offer_invalid' });
    });
    it('a pending link has unknown provenance: a colliding Product alias fails closed (never guessed opaque); without a collision it resumes', () => {
        const midhunLegacy = registry([{ campaignId: 'camp-midhun', partnerId: 'midhun' }]);
        const cfg = (midhunLegacy as Extract<LegacyRegistryState, { state: 'verified' }>).registry.get('camp-midhun')!.configSha256;
        const pending = { campaignId: 'camp-midhun', configSha256: cfg, claimed: false };
        expect(select({ legacy: midhunLegacy, pendingLink: pending })).toEqual({ ok: false, code: 'trial_offer_unavailable' });   // midhun is a promoter
        expect(select({ legacy: midhunLegacy, pendingLink: pending, read: read('{') })).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        expect(select({ legacy: midhunLegacy, pendingLink: pending, read: read(campaigns({ promoters: {} })) }))
            .toMatchObject({ ok: true, pending: 'same', authority: { source: 'sponsor', via: 'pending' } });
    });
    it('the input has no attribution-row field: a historical first touch cannot select, gate or retarget', () => {
        const keys = Object.keys({ alias: null, pendingLink: null, legacyContext: null, legacy: ABSENT, legacyEnabled: true, read: read(), livemodeMatches: true, now: NOW } satisfies TrialAuthorityInput);
        expect(keys.some(key => /attribution|firstTouch|row/i.test(key))).toBe(false);
        // An attributed viewer without a carried context or pending link gets exactly the public decision.
        expect(select({ legacy: LEGACY })).toEqual(select({ legacy: ABSENT }));
    });
});
