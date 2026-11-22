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
        expect(STAGING.broken).toBe(false);
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

    const BLANKS = [undefined, null, '', '   ', ',', ' , '];

    it('unset or blank variables are NOT malformed: an unset owner list, an unset IdP list, or both', () => {
        for (const value of BLANKS) {
            const noOwner = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: value, [ORIGIN_TIER_ENV.idp_transit]: IDP });
            expect({ value, broken: noOwner.broken, invalid: noOwner.invalid }).toEqual({ value, broken: false, invalid: [] });
            expect(tierOf('https://example.com/', noOwner)).toBe('other');
            expect(tierOf(`${IDP}/authorize`, noOwner)).toBe('idp_transit');
            const neither = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: value, [ORIGIN_TIER_ENV.idp_transit]: value });
            expect({ value, broken: neither.broken, invalid: neither.invalid }).toEqual({ value, broken: false, invalid: [] });
            expect(tierOf('https://example.com/', neither)).toBe('other');
        }
        expect(loadOriginPolicy(undefined).broken).toBe(false);
        expect(tierOf('https://example.com/', loadOriginPolicy({}))).toBe('other');
    });

    // 🔴 Amended 2026-11-22: an owner app is only safe when its IdP is known.
    it('…EXCEPT a non-empty owner list with an empty or unset IdP list: that policy is broken', () => {
        for (const value of BLANKS) {
            const policy = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: OWNER, [ORIGIN_TIER_ENV.idp_transit]: value });
            expect({ value, broken: policy.broken }).toEqual({ value, broken: true });
            for (const url of [`${OWNER}/builder`, `${IDP}/authorize`, 'https://example.com/', 'about:blank']) {
                expect({ value, url, tier: tierOf(url, policy) }).toEqual({ value, url, tier: 'idp_transit' });
            }
            expect(policy.invalid).toEqual([{
                tier: 'idp_transit', variable: ORIGIN_TIER_ENV.idp_transit, entry: 0, reason: 'empty_with_owner_list',
            }]);
            const [line] = originPolicyBootLines(policy);
            expect(line).toContain(`${ORIGIN_TIER_ENV.idp_transit} is empty while ${ORIGIN_TIER_ENV.owner_app} is set`);
        }
        // Positive control: the same owner list WITH its IdP list is sound.
        const sound = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: OWNER, [ORIGIN_TIER_ENV.idp_transit]: IDP });
        expect(sound.broken).toBe(false);
        expect(tierOf(`${OWNER}/builder`, sound)).toBe('owner_app');
    });

    it('accepts a comma list with blanks around the commas, and an explicit non-default port', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: ` ${OWNER} , https://app.example.com:8443 ,`,
            [ORIGIN_TIER_ENV.idp_transit]: IDP,
        });
        expect(policy.broken).toBe(false);
        expect(policy.owner_app).toEqual([OWNER, 'https://app.example.com:8443']);
        expect(policy.invalid).toEqual([]);
    });

    /** Under a broken policy EVERYTHING is idp_transit: these must all say so. */
    const PROBES = [`${OWNER}/builder`, `${IDP}/authorize`, 'https://example.com/', 'http://127.0.0.1:3000/', 'about:blank', 'not a url', ''];

    // 🔴 Fail closed (amended): a malformed entry in EITHER variable breaks
    // the whole policy, never just empties its own tier.
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
        for (const tier of ['idp_transit', 'owner_app']) {
            const variable = ORIGIN_TIER_ENV[tier];
            it(`${variable} with ${what} breaks the whole policy: every URL is idp_transit`, () => {
                const env = { [ORIGIN_TIER_ENV.owner_app]: OWNER, [ORIGIN_TIER_ENV.idp_transit]: IDP };
                env[variable] = `https://good.ezil.work,${entry}`;
                const policy = loadOriginPolicy(env);
                expect(policy.broken).toBe(true);
                for (const url of PROBES) expect({ url, tier: tierOf(url, policy) }).toEqual({ url, tier: 'idp_transit' });
                // No list is trusted, so neither is reported as a tier.
                expect(policy.owner_app).toEqual([]);
                expect(policy.idp_transit).toEqual([]);
                expect(policy.invalid).toEqual([{ tier, variable, entry: 2, reason: 'not_a_bare_https_origin' }]);
            });
        }
    }

    it('positive control: the same lists without the bad entry behave exactly as before', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `https://good.ezil.work,${OWNER}`,
            [ORIGIN_TIER_ENV.idp_transit]: IDP,
        });
        expect(policy.broken).toBe(false);
        expect(tierOf('https://good.ezil.work/x', policy)).toBe('owner_app');
        expect(tierOf(`${OWNER}/builder`, policy)).toBe('owner_app');
        expect(tierOf(`${IDP}/authorize`, policy)).toBe('idp_transit');
        expect(tierOf('https://example.com/', policy)).toBe('other');
        expect(tierOf('about:blank', policy)).toBe('other');
        expect(tierOf('not a url', policy)).toBe('other');
    });

    it(`more than ${ORIGIN_TIER_MAX_ENTRIES} entries breaks the policy; exactly ${ORIGIN_TIER_MAX_ENTRIES} is fine`, () => {
        const list = (n) => Array.from({ length: n }, (_, i) => `https://h${i}.example.com`).join(',');
        const ok = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: list(ORIGIN_TIER_MAX_ENTRIES), [ORIGIN_TIER_ENV.idp_transit]: IDP });
        expect(ok.broken).toBe(false);
        expect(ok.owner_app).toHaveLength(ORIGIN_TIER_MAX_ENTRIES);
        const tooMany = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: list(ORIGIN_TIER_MAX_ENTRIES + 1), [ORIGIN_TIER_ENV.idp_transit]: IDP });
        expect(tooMany.broken).toBe(true);
        expect(tooMany.invalid.map((p) => p.reason)).toEqual(['too_many_entries']);
        expect(tierOf('https://h0.example.com/', tooMany)).toBe('idp_transit');
    });

    it('a non-string value breaks the policy', () => {
        const policy = loadOriginPolicy({ [ORIGIN_TIER_ENV.idp_transit]: 42 });
        expect(policy.broken).toBe(true);
        expect(policy.invalid.map((p) => p.reason)).toEqual(['not_a_string']);
        expect(tierOf('https://example.com/', policy)).toBe('idp_transit');
    });

    it('an origin in BOTH (well-formed) lists is idp_transit, never owner_app', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`,
            [ORIGIN_TIER_ENV.idp_transit]: IDP,
        });
        expect(policy.broken).toBe(false);
        expect(tierOf(`${IDP}/u/login`, policy)).toBe('idp_transit');
        expect(policy.owner_app).toEqual([OWNER]);
        expect(policy.overlap).toEqual([IDP]);
    });

    it('a malformed IdP list can never leave the IdP promoted or ordinary', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`,
            [ORIGIN_TIER_ENV.idp_transit]: `${IDP},https://broken.example.com/`,
        });
        expect(policy.broken).toBe(true);
        expect(tierOf(`${IDP}/u/login`, policy)).toBe('idp_transit');
        expect(tierOf(`${OWNER}/builder`, policy)).toBe('idp_transit');
        expect(policy.invalid).toHaveLength(1);
    });

    it('the policy is frozen and cannot be widened after the parse', () => {
        expect(Object.isFrozen(STAGING)).toBe(true);
        expect(() => { STAGING.owner_app.push('https://evil.example.com'); }).toThrow(TypeError);
        expect(tierOf('https://evil.example.com/', STAGING)).toBe('other');
    });

    it('a hand-built policy object is refused; one from loadOriginPolicy is accepted', () => {
        const forged = { broken: false, owner_app: [OWNER], idp_transit: [], invalid: [], overlap: [] };
        expect(isOriginPolicy(forged)).toBe(false);
        expect(() => tierOf(`${OWNER}/`, forged)).toThrow(/loadOriginPolicy/);
        expect(() => sanitizeUrl(CALLBACK_URL, forged)).toThrow(/loadOriginPolicy/);
        expect(() => sanitizeText('x', forged)).toThrow(/loadOriginPolicy/);
        expect(() => tierOf(`${OWNER}/`, undefined)).toThrow(/loadOriginPolicy/);
        expect(tierOf(`${OWNER}/`, STAGING)).toBe('owner_app');
    });

    it('a broken policy is ONE boot line naming every fault by variable and position, never by value', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},https://user:hunter2pw@universe-staging.ezil.work`,
            [ORIGIN_TIER_ENV.idp_transit]: `${IDP},https://user:hunter2pw@id.ezil.work`,
        });
        const lines = originPolicyBootLines(policy);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('origin policy BROKEN');
        expect(lines[0]).toContain(`${ORIGIN_TIER_ENV.owner_app} entry #2`);
        expect(lines[0]).toContain(`${ORIGIN_TIER_ENV.idp_transit} entry #2`);
        expect(lines[0]).toContain('every page is idp_transit');
        expect(JSON.stringify(lines)).not.toContain('hunter2pw');
        expect(JSON.stringify(policy)).not.toContain('hunter2pw');
    });

    it('a sound policy logs only its overlaps, and a clean one logs nothing', () => {
        const overlapping = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: `${OWNER},${IDP}`, [ORIGIN_TIER_ENV.idp_transit]: IDP });
        expect(originPolicyBootLines(overlapping)).toEqual([
            `[ezil-sidecar] ${IDP} is in both ${ORIGIN_TIER_ENV.owner_app} and ${ORIGIN_TIER_ENV.idp_transit}: it is idp_transit`,
        ]);
        expect(originPolicyBootLines(STAGING)).toEqual([]);
        expect(originPolicyBootLines(loadOriginPolicy({}))).toEqual([]);
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
        // The IdP matches by HOST whatever the scheme or port (amended 2026-11-22).
        ['http://id.ezil.work/u/login', 'idp_transit'],
        ['HTTP://ID.EZIL.WORK./u/login', 'idp_transit'],
        ['https://id.ezil.work:8443/u/login', 'idp_transit'],
        ['http://id.ezil.work:8080/', 'idp_transit'],
        ['wss://id.ezil.work/socket', 'idp_transit'],
        ['ftp://id.ezil.work/x', 'idp_transit'],
        ['ezil://id.ezil.work/cb', 'idp_transit'],
        ['blob:http://id.ezil.work/4f2c', 'idp_transit'],
        // …and by that host only: positive controls.
        ['https://sub.id.ezil.work/', 'other'],
        ['https://id.ezil.work.evil.example/', 'other'],
        ['http://example.com/id.ezil.work', 'other'],
        ['http://universe-staging.ezil.work/builder', 'other'],
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

    it('an owner origin on an IdP HOST (another port) is an overlap: idp_transit, logged', () => {
        const policy = loadOriginPolicy({
            [ORIGIN_TIER_ENV.owner_app]: `${OWNER},https://id.ezil.work:8443`,
            [ORIGIN_TIER_ENV.idp_transit]: IDP,
        });
        expect(policy.broken).toBe(false);
        expect(policy.owner_app).toEqual([OWNER]);
        expect(policy.overlap).toEqual(['https://id.ezil.work:8443']);
        expect(tierOf('https://id.ezil.work:8443/app', policy)).toBe('idp_transit');
        expect(tierOf(`${OWNER}/builder`, policy)).toBe('owner_app');
    });

    it('an http IdP URL is sanitised to its transit form like an https one', () => {
        expect(sanitizeUrl('http://id.ezil.work/authorize?state=Y&nonce=Z', STAGING)).toBe('http://id.ezil.work/authorize');
        expect(sanitizeUrl('wss://id.ezil.work/socket?ticket=t', STAGING)).toBe('wss://id.ezil.work/socket');
        expect(sanitizeUrl('http://example.com/a?b=1', STAGING)).toBe('http://example.com/a?b=1');
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

    it('under a BROKEN policy every URL takes the transit form; a sound policy leaves the same URLs alone', () => {
        const broken = loadOriginPolicy({ [ORIGIN_TIER_ENV.idp_transit]: 'https://id.ezil.work/' });
        expect(broken.broken).toBe(true);
        const cases = [
            ['https://example.com/a?b=1#c', 'https://example.com/a'],
            ['https://user:pw@example.com/a?b=1', 'https://example.com/a'],
            ['https://universe-staging.ezil.work/builder/profile-builder?tab=rates', 'https://universe-staging.ezil.work/builder/profile-builder'],
            ['http://127.0.0.1:3000/x?y=1', 'http://127.0.0.1:3000/x'],
            ['wss://example.com/socket?ticket=t', 'wss://example.com/socket'],
            ['about:blank', 'about:blank'],
            ['about:blank?x=1#y', 'about:blank'],
            ['blob:https://example.com/4f2c', 'https://example.com'],
            ['data:text/plain,hello?state=1', 'data:text/plain,hello'],
        ];
        for (const [url, out] of cases) {
            expect({ url, out: sanitizeUrl(url, broken) }).toEqual({ url, out });
        }
        const sound = loadOriginPolicy({});
        for (const url of ['https://example.com/a?b=1#c', 'https://universe-staging.ezil.work/builder/profile-builder?tab=rates',
            'http://127.0.0.1:3000/x?y=1', 'about:blank']) {
            expect(sanitizeUrl(url, sound)).toBe(url);
        }
        expect(sanitizeText('see https://example.com/a?b=1 now', broken)).toBe('see https://example.com/a now');
        expect(sanitizeText('see https://example.com/a?b=1 now', sound)).toBe('see https://example.com/a?b=1 now');
    });

    it('without tiers configured, sensitive parameters are still stripped (v1 pages too)', () => {
        const none = loadOriginPolicy({});
        expect(sanitizeUrl(CALLBACK_URL, none)).toBe('https://universe-staging.ezil.work/creator/social-login/callback/auth0');
        expect(sanitizeUrl(AUTHORIZE_URL, none)).toBe('https://id.ezil.work/authorize');
        expect(sanitizeUrl('https://id.ezil.work/u/login?screen=1', none)).toBe('https://id.ezil.work/u/login?screen=1');
    });
});

describe('sanitizeUrl: the decoded remainder after the origin (amended 2026-11-22)', () => {
    const STRIPPED = [
        // The independent review's cases.
        ['https://u.example/?redirect=https%3A%2F%2Fu.example%2Fcb%3Fcode%3DSECRET', 'https://u.example/'],
        ['https://u.example/cb;code=a/x', 'https://u.example/cb/x'],
        ['https://u.example/#!code=a', 'https://u.example/'],
        ['https://u.example/?code[]=a', 'https://u.example/'],
        ['https://u.example/?x=code=a', 'https://u.example/'],
        ['https://u.example/?auth_code=a', 'https://u.example/'],
        ['https://u.example/?%E2%80%8Bcode=a', 'https://u.example/'],
        // …and the shapes around them.
        ['https://u.example/?code%5B%5D=a', 'https://u.example/'],
        ['https://u.example/?co%E2%80%8Bde=a', 'https://u.example/'],
        ['https://u.example/?x=%E0&%E2%80%8Bcode=a', 'https://u.example/'],
        ['https://u.example/?code =a', 'https://u.example/'],
        ['https://u.example/?JWT=e30.e30.sig', 'https://u.example/'],
        ['https://u.example/?accessToken=abc', 'https://u.example/'],
        ['https://u.example/?next=%2Fcb%3Fstate%3D1', 'https://u.example/'],
        ['https://u.example/cb;jsessionid=1;code=a/x?y=1', 'https://u.example/cb/x'],
        ['https://code=a@u.example/x', 'https://u.example/x'],
        ['https://id.ezil.work/cb;code=a', 'https://id.ezil.work/cb'],
        ['ezil://cb?code=SECRET', 'ezil://cb'],
        // The name in the path proper (or behind an encoded `;`): only the origin leaves.
        ['https://u.example/oauth/code=abc/next', 'https://u.example/'],
        ['https://u.example/cb%3Bcode=a', 'https://u.example/'],
        ['data:text/plain,code=abc', 'data:'],
    ];
    for (const [url, out] of STRIPPED) {
        it(`${url} -> ${out}`, () => {
            expect(sanitizeUrl(url, STAGING)).toBe(out);
        });
    }

    it('positive controls: look-alikes and harmless nesting come back as the SAME string', () => {
        for (const url of [
            'https://u.example/?redirect=https%3A%2F%2Fu.example%2Fcb%3Fpage%3D2',
            'https://u.example/cb;jsessionid=abc/x',
            'https://u.example/?xcode=1&decode=2&barcode=3&statement=4&tokens=5&encoded=6',
            'https://u.example/?mode=code&type=state',
            'https://u.example/codes/state/token',
            'https://u.example/?q=%E2%80%8B&lang=%E0',
        ]) {
            expect(sanitizeUrl(url, STAGING)).toBe(url);
        }
    });

    it('nothing that leaves still reads as a sensitive assignment', () => {
        const NAME_EQ = /(?<![A-Za-z0-9])(code|state|id_token|access_token|refresh_token|token|session_transfer_token|nonce|ticket|code_verifier|jwt|accesstoken)(\[\])?\s*=/i;
        for (const [url] of STRIPPED) {
            const out = sanitizeUrl(url, STAGING);
            let decoded = out;
            try { decoded = decodeURIComponent(out); } catch { /* keep */ }
            expect({ url, leaks: NAME_EQ.test(decoded) }).toEqual({ url, leaks: false });
            expect(out).not.toContain('SECRET');
        }
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

    it('relative references (markdown hrefs) lose query and fragment when either names a sensitive parameter', () => {
        const cases = [
            ['[back](/creator/social-login/callback/auth0?code=X&state=Y)', '[back](/creator/social-login/callback/auth0)'],
            ['go to ./cb?state=1 now', 'go to ./cb now'],
            ['go to ../cb#access_token=a now', 'go to ../cb now'],
            ['href=/cb?x=1&code=2', 'href=/cb'],
            ['"?code=abc"', '""'],
            ['see #access_token=abc', 'see '],
            ['[idp](//id.ezil.work/authorize?state=1)', '[idp](//id.ezil.work/authorize)'],
            ['[cdn](//cdn.example.com/a.js?token=t)', '[cdn](//cdn.example.com/a.js)'],
            ['{"next":"\\/cb?code=1"}', '{"next":"\\/cb"}'],
        ];
        for (const [text, out] of cases) {
            expect({ text, out: sanitizeText(text, STAGING) }).toEqual({ text, out });
        }
    });

    it('leaves relative references without sensitive parameters, and look-alikes, untouched', () => {
        for (const text of [
            '[next](/builder/jobs?page=2)', '[top](#overview)', '# Heading', '## Sub', '- link "Docs" [ref=e3]',
            '- heading "Rates" [ref=e9] [level=2]', '//example.com/a?b=1', '/etc/passwd?', 'ratio 3/4', 'and/or',
        ]) {
            expect(sanitizeText(text, STAGING)).toBe(text);
        }
    });

    it('the limit, stated: a `?code=` glued mid-word is not a reference and stays', () => {
        // Not a URL and not a reference (no boundary before the `/`), so
        // neither pass can tell it from prose. Recorded so it is a decision.
        expect(sanitizeText('a/b?code=1', STAGING)).toBe('a/b?code=1');
    });

    it('trailing punctuation and closing brackets stay outside the URL', () => {
        const cases = [
            ['Go to https://a.example.com/cb?code=1.', 'Go to https://a.example.com/cb.'],
            ['https://a.example.com/cb?code=1, then', 'https://a.example.com/cb, then'],
            ['[x](https://a.example.com/cb?code=1)', '[x](https://a.example.com/cb)'],
            ['(https://a.example.com/w_(x)?code=1)', '(https://a.example.com/w_(x))'],
            ['[https://a.example.com/cb?state=2]', '[https://a.example.com/cb]'],
            ['(see /cb?code=1).', '(see /cb).'],
        ];
        for (const [text, out] of cases) {
            expect({ text, out: sanitizeText(text, STAGING) }).toEqual({ text, out });
        }
    });

    it('under a broken policy a relative reference with a path loses every query and fragment', () => {
        const broken = loadOriginPolicy({ [ORIGIN_TIER_ENV.owner_app]: 'https://universe-staging.ezil.work/' });
        expect(sanitizeText('[next](/builder/jobs?page=2) [top](#overview)', broken)).toBe('[next](/builder/jobs) [top](#overview)');
        expect(sanitizeText('## Rates #1', broken)).toBe('## Rates #1');
        expect(sanitizeText('[x](?code=1)', broken)).toBe('[x]()');
        expect(sanitizeText('[next](/builder/jobs?page=2) [top](#overview)', STAGING)).toBe('[next](/builder/jobs?page=2) [top](#overview)');
    });
});
