/**
 * `origin-policy.mjs`: the tier env parse, `tierOf`, `routeAllowedOnTier`,
 * `sanitizeUrl` and `sanitizeText` — the pure half of browser verbs v2 §2.
 *
 * Every refusal below is paired with an acceptance of the nearest valid input,
 * so a parser that refused everything would go red too.
 */

import { describe, expect, it } from 'bun:test';
import {
    IDP_TRANSIT_ROUTES, ORIGIN_TIER_ENV, ORIGIN_TIERS, SENSITIVE_URL_PARAMS, SIDECAR_WIRE,
} from './contract.mjs';
import {
    ORIGIN_TIER_MAX_ENTRIES, isOriginPolicy, loadOriginPolicy, originPolicyBootLines, routeAllowedOnTier,
    sanitizeText, sanitizeUrl, tierOf,
} from './origin-policy.mjs';

const OWNER = 'https://universe-staging.ezil.work';
const IDP = 'https://id.ezil.work';
const STAGING_ENV = { [ORIGIN_TIER_ENV.owner_app]: OWNER, [ORIGIN_TIER_ENV.idp_transit]: IDP };
const STAGING = loadOriginPolicy(STAGING_ENV);

const CALLBACK_URL = 'https://universe-staging.ezil.work/creator/social-login/callback/auth0?code=X&state=Y';
const AUTHORIZE_URL = 'https://id.ezil.work/authorize?state=Y&nonce=Z';

describe('loadOriginPolicy: where tiers come from', () => {
    it('reads the staging values into the two tiers', () => {
        expect(STAGING.owner_app).toEqual([OWNER]);
        expect(STAGING.idp_transit).toEqual([IDP]);
        expect(STAGING.invalid).toEqual([]);
        expect(STAGING.overlap).toEqual([]);
        expect(isOriginPolicy(STAGING)).toBe(true);
    });

    it('reads ONLY the two ORIGIN_TIER_ENV names', () => {
        const read = [];
        const env = new Proxy({ ...STAGING_ENV, EZIL_BROWSER_TEST_ALLOWED_ORIGINS: IDP }, {
            get (target, key) { read.push(key); return target[key]; },
        });
        loadOriginPolicy(env);
        expect([...new Set(read)].sort()).toEqual(Object.values(ORIGIN_TIER_ENV).sort());
    });

    it('EZIL_BROWSER_TEST_ALLOWED_ORIGINS is never a tier source', () => {
        const policy = loadOriginPolicy({ EZIL_BROWSER_TEST_ALLOWED_ORIGINS: `${OWNER},${IDP}` });
        expect(policy.owner_app).toEqual([]);
        expect(policy.idp_transit).toEqual([]);
        expect(tierOf(`${IDP}/authorize`, policy)).toBe('other');
        expect(tierOf(`${OWNER}/builder`, policy)).toBe('other');
    });

    it('unset, empty and blank variables mean an empty tier and no complaint', () => {
        for (const value of [undefined, null, '', '   ', ',', ' , ']) {
            const policy = loadOriginPolicy({ [ORIGIN_TIER_ENV.idp_transit]: value });
            expect({ value, idp: policy.idp_transit, invalid: policy.invalid }).toEqual({ value, idp: [], invalid: [] });
        }
        expect(loadOriginPolicy(undefined).owner_app).toEqual([]);
    });

    it('accepts a comma list with blanks around the commas, and an explicit non-default port', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: ` ${OWNER} , https://app.example.com:8443 ,`,
        });
        expect(policy.owner_app).toEqual([OWNER, 'https://app.example.com:8443']);
        expect(policy.invalid).toEqual([]);
    });

    // 🔴 Fail closed: a malformed entry empties THAT tier, never widens it.
    const MALFORMED = {
        'a trailing slash': 'https://id.ezil.work/',
        'a path': 'https://id.ezil.work/authorize',
        'a query': 'https://id.ezil.work?x=1',
        'a fragment': 'https://id.ezil.work#f',
        'plain http': 'http://id.ezil.work',
        'no scheme': 'id.ezil.work',
        'a wildcard': 'https://*.ezil.work',
        'the default port spelled out': 'https://id.ezil.work:443',
        'upper case (not canonical)': 'https://ID.EZIL.WORK',
        'an IPv4 literal': 'https://127.0.0.1',
        'an IPv6 literal': 'https://[::1]',
        'localhost': 'https://localhost',
        'a .localhost name': 'https://id.localhost',
        'userinfo': 'https://user:hunter2pw@id.ezil.work',
        'a trailing dot': 'https://id.ezil.work.',
        'a space inside the list item': 'https://id.ezil.work https://other.ezil.work',
        'a control character': 'https://id.ezil.work\u0007',
    };
    for (const [what, entry] of Object.entries(MALFORMED)) {
        it(`an entry with ${what} empties that tier and leaves the other alone`, () => {
            const policy = loadOriginPolicy({
                [ORIGIN_TIER_ENV.owner_app]: OWNER,
                [ORIGIN_TIER_ENV.idp_transit]: `https://good.ezil.work,${entry}`,
            });
            expect(policy.idp_transit).toEqual([]);
            expect(tierOf('https://good.ezil.work/x', policy)).toBe('other');
            expect(policy.owner_app).toEqual([OWNER]);
            expect(policy.invalid).toEqual([{
                tier: 'idp_transit', variable: ORIGIN_TIER_ENV.idp_transit, entry: 2, reason: 'not_a_bare_https_origin',
            }]);
        });
    }

    it(`more than ${ORIGIN_TIER_MAX_ENTRIES} entries empties the tier; exactly ${ORIGIN_TIER_MAX_ENTRIES} is fine`, () => {
        const list = (n) => Array.from({ length: n }, (_, i) => `https://h${i}.example.com`).join(',');
        const ok = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: list(ORIGIN_TIER_MAX_ENTRIES) });
        expect(ok.owner_app).toHaveLength(ORIGIN_TIER_MAX_ENTRIES);
        const tooMany = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: list(ORIGIN_TIER_MAX_ENTRIES + 1) });
        expect(tooMany.owner_app).toEqual([]);
        expect(tooMany.invalid.map((p) => p.reason)).toEqual(['too_many_entries']);
    });

    it('a non-string value empties the tier', () => {
        const policy = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: 42 });
        expect(policy.owner_app).toEqual([]);
        expect(policy.invalid.map((p) => p.reason)).toEqual(['not_a_string']);
    });

    it('an origin in BOTH lists is idp_transit, never owner_app', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`,
            [ORIGIN_TIER_ENV.idp_transit]: IDP,
        });
        expect(tierOf(`${IDP}/u/login`, policy)).toBe('idp_transit');
        expect(policy.owner_app).toEqual([OWNER]);
        expect(policy.overlap).toEqual([IDP]);
    });

    it('…even when the IdP list is otherwise malformed (a typo cannot promote the IdP)', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`,
            [ORIGIN_TIER_ENV.idp_transit]: `${IDP},https://broken.example.com/`,
        });
        expect(tierOf(`${IDP}/u/login`, policy)).toBe('idp_transit');
        expect(tierOf(`${OWNER}/builder`, policy)).toBe('owner_app');
        expect(policy.invalid).toHaveLength(1);
    });

    it('the policy is frozen and cannot be widened after the parse', () => {
        expect(Object.isFrozen(STAGING)).toBe(true);
        expect(() => { STAGING.owner_app.push('https://evil.example.com'); }).toThrow(TypeError);
        expect(tierOf('https://evil.example.com/', STAGING)).toBe('other');
    });

    it('a hand-built policy object is refused; one from loadOriginPolicy is accepted', () => {
        const forged = { owner_app: [OWNER], idp_transit: [], invalid: [], overlap: [] };
        expect(isOriginPolicy(forged)).toBe(false);
        expect(() => tierOf(`${OWNER}/`, forged)).toThrow(/loadOriginPolicy/);
        expect(() => sanitizeUrl(CALLBACK_URL, forged)).toThrow(/loadOriginPolicy/);
        expect(() => sanitizeText('x', forged)).toThrow(/loadOriginPolicy/);
        expect(() => tierOf(`${OWNER}/`, undefined)).toThrow(/loadOriginPolicy/);
        expect(tierOf(`${OWNER}/`, STAGING)).toBe('owner_app');
    });

    it('boot lines name the variable and position, never the raw value', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`,
            [ORIGIN_TIER_ENV.idp_transit]: `${IDP},https://user:hunter2pw@id.ezil.work`,
        });
        const lines = originPolicyBootLines(policy);
        expect(lines).toHaveLength(2);
        expect(lines[0]).toContain(ORIGIN_TIER_ENV.idp_transit);
        expect(lines[0]).toContain('entry #2');
        expect(lines[1]).toContain(`${IDP} is in both`);
        expect(JSON.stringify(lines)).not.toContain('hunter2pw');
        expect(JSON.stringify(policy)).not.toContain('hunter2pw');
        expect(originPolicyBootLines(STAGING)).toEqual([]);
    });
});

describe('tierOf', () => {
    const cases = [
        [`${OWNER}/builder/profile-builder`, 'owner_app'],
        [CALLBACK_URL, 'owner_app'],
        [AUTHORIZE_URL, 'idp_transit'],
        ['https://ID.EZIL.WORK/u/login', 'idp_transit'],
        ['https://id.ezil.work:443/u/login', 'idp_transit'],
        ['https://id.ezil.work./u/login', 'idp_transit'],
        ['blob:https://id.ezil.work/4f2c', 'idp_transit'],
        ['http://id.ezil.work/u/login', 'other'],
        ['https://id.ezil.work:8443/u/login', 'other'],
        ['https://sub.id.ezil.work/', 'other'],
        ['https://example.com/', 'other'],
        ['about:blank', 'other'],
        ['data:text/html,hi', 'other'],
        ['not a url', 'other'],
        ['', 'other'],
    ];
    for (const [url, tier] of cases) {
        it(`${JSON.stringify(url)} -> ${tier}`, () => {
            expect(tierOf(url, STAGING)).toBe(tier);
        });
    }

    it('answers exactly one of ORIGIN_TIERS', () => {
        for (const [url] of cases) expect(ORIGIN_TIERS).toContain(tierOf(url, STAGING));
    });
});

describe('routeAllowedOnTier', () => {
    const ROUTES = Object.keys(SIDECAR_WIRE);

    it('owner_app and other allow every declared route', () => {
        for (const tier of ['owner_app', 'other']) {
            for (const route of ROUTES) expect({ tier, route, ok: routeAllowedOnTier(route, tier, { text: 'x', time: 1 }) }).toEqual({ tier, route, ok: true });
        }
    });

    it('idp_transit allows health, navigate and wait_for{time} — and nothing else', () => {
        for (const route of ROUTES) {
            const body = route === 'POST /wait_for' ? { time: 1 } : {};
            expect({ route, ok: routeAllowedOnTier(route, 'idp_transit', body) })
                .toEqual({ route, ok: IDP_TRANSIT_ROUTES.includes(route) });
        }
    });

    it('wait_for on idp_transit: time alone only; any text at all refuses', () => {
        const idpWait = (body) => routeAllowedOnTier('POST /wait_for', 'idp_transit', body);
        expect(idpWait({ time: 2 })).toBe(true);
        expect(idpWait({ time: 2, text: null })).toBe(true);
        expect(idpWait({ text: 'Sign in' })).toBe(false);
        expect(idpWait({ time: 2, text: 'Sign in' })).toBe(false);
        expect(idpWait({ time: 2, text: '' })).toBe(false);
        expect(idpWait({ time: 2, text: 7 })).toBe(false);
        expect(idpWait({})).toBe(false);
        expect(idpWait(undefined)).toBe(false);
    });

    it('an undeclared route or an unknown tier is refused', () => {
        expect(routeAllowedOnTier('POST /evaluate', 'other', {})).toBe(false);
        expect(routeAllowedOnTier('POST /upload', 'owner_app', {})).toBe(false);
        expect(routeAllowedOnTier('POST /click', 'public', {})).toBe(false);
        expect(routeAllowedOnTier('POST /click', undefined, {})).toBe(false);
        expect(routeAllowedOnTier('POST /click', 'other', {})).toBe(true);
    });
});

describe('sanitizeUrl', () => {
    it('reduces an idp_transit URL to origin + path', () => {
        expect(sanitizeUrl(AUTHORIZE_URL, STAGING)).toBe('https://id.ezil.work/authorize');
        expect(sanitizeUrl('https://id.ezil.work/u/login/identifier?prompt=x#frag', STAGING)).toBe('https://id.ezil.work/u/login/identifier');
        expect(sanitizeUrl('blob:https://id.ezil.work/4f2c', STAGING)).toBe('https://id.ezil.work');
    });

    it('strips query AND fragment from the owner-app callback (code, state)', () => {
        expect(sanitizeUrl(CALLBACK_URL, STAGING)).toBe('https://universe-staging.ezil.work/creator/social-login/callback/auth0');
    });

    for (const name of SENSITIVE_URL_PARAMS) {
        it(`\`${name}\` in the query or the fragment strips both, on any origin`, () => {
            expect(sanitizeUrl(`https://example.com/cb?a=1&${name}=v1#keep`, STAGING)).toBe('https://example.com/cb');
            expect(sanitizeUrl(`https://example.com/cb?a=1#${name}=v1&b=2`, STAGING)).toBe('https://example.com/cb');
        });
    }

    it('catches the names however they are spelled or placed', () => {
        const stripped = 'https://example.com/cb';
        for (const url of [
            'https://example.com/cb?Code=1',
            'https://example.com/cb?%63ode=1',
            'https://example.com/cb?+state=1',
            'https://example.com/cb?state',
            'https://example.com/cb#/callback?code=1',
            'https://example.com/cb?x=1?code=2',
            'https://example.com/cb?x=1;code=2',
            'https://example.com/cb#access_token=a&token_type=bearer',
        ]) {
            expect({ url, out: sanitizeUrl(url, STAGING) }).toEqual({ url, out: stripped });
        }
    });

    it('leaves every other URL as the SAME string (no re-serialisation)', () => {
        for (const url of [
            'https://example.com/a?b=1#c',
            'HTTPS://Example.COM/a?response_type=code&scope=openid',
            'https://example.com/a?codes=1&xstate=2&code_challenge=3',
            'https://universe-staging.ezil.work/builder/profile-builder?tab=rates',
            'http://127.0.0.1:3000/?page=2',
            'about:blank',
        ]) {
            expect(sanitizeUrl(url, STAGING)).toBe(url);
        }
    });

    it('returns non-URL strings and non-strings unchanged', () => {
        expect(sanitizeUrl('not a url ?code=1', STAGING)).toBe('not a url ?code=1');
        expect(sanitizeUrl('', STAGING)).toBe('');
        expect(sanitizeUrl(null, STAGING)).toBe(null);
        expect(sanitizeUrl(42, STAGING)).toBe(42);
        const obj = { url: CALLBACK_URL };
        expect(sanitizeUrl(obj, STAGING)).toBe(obj);
    });

    it('without tiers configured, sensitive parameters are still stripped (v1 pages too)', () => {
        const none = loadOriginPolicy({});
        expect(sanitizeUrl(CALLBACK_URL, none)).toBe('https://universe-staging.ezil.work/creator/social-login/callback/auth0');
        expect(sanitizeUrl(AUTHORIZE_URL, none)).toBe('https://id.ezil.work/authorize');
        expect(sanitizeUrl('https://id.ezil.work/u/login?screen=1', none)).toBe('https://id.ezil.work/u/login?screen=1');
    });
});

describe('sanitizeText', () => {
    it('sanitises every http(s) URL inside free text and keeps the rest', () => {
        const text = `redirecting to ${AUTHORIZE_URL} then "${CALLBACK_URL}" (see https://example.com/help?topic=1)`;
        expect(sanitizeText(text, STAGING)).toBe(
            'redirecting to https://id.ezil.work/authorize then '
            + '"https://universe-staging.ezil.work/creator/social-login/callback/auth0" '
            + '(see https://example.com/help?topic=1)',
        );
    });

    it('catches the JSON-escaped form a PHP backend prints by default', () => {
        const text = '{"next":"https:\\/\\/universe-staging.ezil.work\\/cb?code=X&state=Y"}';
        const out = sanitizeText(text, STAGING);
        expect(out).toBe('{"next":"https:\\/\\/universe-staging.ezil.work\\/cb"}');
        expect(out).not.toContain('code=');
    });

    it('returns text without a sensitive URL unchanged, and non-strings as they are', () => {
        const text = 'nothing to see at https://example.com/a?b=1 here';
        expect(sanitizeText(text, STAGING)).toBe(text);
        expect(sanitizeText('', STAGING)).toBe('');
        expect(sanitizeText(undefined, STAGING)).toBe(undefined);
    });
});
