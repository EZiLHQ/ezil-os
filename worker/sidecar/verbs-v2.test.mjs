/**
 * Browser verbs v2 against the REAL `BrowserSurface`, over a fake browser.
 *
 * `wire.test.mjs` fakes the whole surface, which is right for "which keys
 * leave the process" and useless for the questions here: whether the tier gate
 * refuses, whether a ref minted on one tab resolves on another, whether
 * another tab's console lines come out, whether an OAuth `code` survives into
 * a buffer. Those live in `browser.mjs` and `verbs.mjs`, so only the browser
 * under them is faked — pages are EventEmitters that answer the page-script
 * functions by identity and record every action taken on them, so "nothing
 * was touched" is an assertion rather than an assumption.
 *
 * Not proved here (it needs a real Chrome): that Playwright's `mask` really
 * blanks the field in the pixels. That is `browser-sidecar.container.test.ts`.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, spyOn } from 'bun:test';
import { BrowserSurface } from './browser.mjs';
import {
    FIELD_VALUE_MAX_CHARS, FILL_FORM_MAX_FIELDS, ORIGIN_TIER_ENV, PRESS_KEYS, SCROLL_MAX_DY, SELECT_MAX_VALUES,
    SIDECAR_WIRE,
} from './contract.mjs';
import { loadOriginPolicy } from './origin-policy.mjs';
import {
    containsText, fieldState, pageMarkdown, passwordValues, scrollWindowBy, selectState, snapshotPage, windowScrollY,
} from './page-scripts.mjs';
import { redactDeep } from './redact.mjs';
import { VERBS } from './verbs.mjs';

const STAGING = loadOriginPolicy({
    [ORIGIN_TIER_ENV.owner_app]: 'https://universe-staging.ezil.work',
    [ORIGIN_TIER_ENV.idp_transit]: 'https://id.ezil.work',
});

const OWNER_PAGE = 'https://universe-staging.ezil.work/builder/profile-builder';
const OTHER_PAGE = 'https://example.com/form';
/** The two URLs the brief names, verbatim… */
const CALLBACK_URL = 'https://universe-staging.ezil.work/creator/social-login/callback/auth0?code=X&state=Y';
const AUTHORIZE_URL = 'https://id.ezil.work/authorize?state=Y&nonce=Z';
/** …and the same shapes with values distinctive enough to search for. */
const CALLBACK_URL_2 = 'https://universe-staging.ezil.work/creator/social-login/callback/auth0?code=AUTHCODEq7Rk&state=STATEw3Lp';
const AUTHORIZE_URL_2 = 'https://id.ezil.work/authorize?client_id=c1&state=STATEw3Lp&nonce=NONCEz9Vt&redirect_uri=x';
const LEAK_MARKERS = ['code=', 'state=', 'nonce=', 'AUTHCODEq7Rk', 'STATEw3Lp', 'NONCEz9Vt'];

const CODE_DENY = new Set(['owner_app', 'idp_transit']);

// ── the fake browser ─────────────────────────────────────────────────────────

/** A form the way `snapshotPage` would describe it, plus what `fill` accepts. */
function formElements () {
    return [
        { ref: 'e1', role: 'textbox', name: 'Tagline', tag: 'input', type: 'text', fillable: true },
        { ref: 'e2', role: 'textbox', name: 'Password', tag: 'input', type: 'password', fillable: true, isPassword: true },
        { ref: 'e3', role: 'combobox', name: 'Rate unit', tag: 'select', options: ['hour', 'day'] },
        { ref: 'e4', role: 'button', name: 'Save', tag: 'button', fillable: false },
        { ref: 'e5', role: 'listbox', name: 'Skills', tag: 'div' },
        { ref: 'e6', role: 'textbox', name: 'About', tag: 'textarea', type: 'textarea', fillable: true },
    ];
}

/** Bytes a fake capture "renders": the mask hides the dots, nothing else does. */
function render (label, passwordValue, masked) {
    const field = masked ? '[########]' : '•'.repeat(passwordValue.length);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from(`|${label}|${field}|`)]);
}

class FakeLocator {
    constructor (page, ref) { this.page = page; this.ref = ref; }
    first () { return this; }
    get el () { return this.page.elements.get(this.ref); }
    async count () { return this.page.elements.has(this.ref) ? 1 : 0; }
    async click () {
        this.page.actions.push(['click', this.ref]);
        if (this.el.navigatesTo) await this.page.goto(this.el.navigatesTo);
    }
    async fill (value) {
        if (this.el.failFill) throw new Error('locator.fill: element is not attached to the DOM');
        this.page.actions.push(['fill', this.ref]);
        this.page.filled.push({ ref: this.ref, value });
        this.el.value = value;
        if (this.el.type === 'password') this.page.passwordValue = value;
        if (this.el.fillNavigatesTo) await this.page.goto(this.el.fillNavigatesTo);
    }
    async press (key) {
        this.page.actions.push(['press', this.ref, key]);
        if (key === 'Enter' && this.el.submitNavigatesTo) await this.page.goto(this.el.submitNavigatesTo);
    }
    async screenshot (opts) { return render(`element ${this.ref}`, this.page.passwordValue, !!opts?.mask?.length); }
    async scrollIntoViewIfNeeded () {
        this.page.actions.push(['scrollIntoView', this.ref]);
        this.page.scrollY = 900;
        if (this.el.scrollNavigatesTo) await this.page.goto(this.el.scrollNavigatesTo);
    }
    async selectOption (values) {
        this.page.actions.push(['selectOption', this.ref, values]);
        if (this.el.selectNavigatesTo) await this.page.goto(this.el.selectNavigatesTo);
        return (this.el.optionValues ?? this.el.options).filter((o, i) => values.includes(this.el.options[i]));
    }
    async evaluate (fn, arg) {
        if (fn === fieldState) return { fillable: !!this.el.fillable, isPassword: this.el.type === 'password' };
        if (fn === selectState) {
            if (this.el.tag !== 'select') return { isSelect: false, unmatched: 0 };
            return { isSelect: true, unmatched: arg.filter((v) => !this.el.options.includes(v)).length };
        }
        throw new Error('unexpected element function');
    }
}

class FakePage extends EventEmitter {
    constructor (url, { visible = true, elements = formElements() } = {}) {
        super();
        this.currentUrl = url;
        this.visible = visible;
        this.elements = new Map(elements.map((e) => [e.ref, { ...e }]));
        this.actions = [];
        this.filled = [];
        this.passwordValue = '';
        this.scrollY = 0;
        this.text = 'Builder profile';
        this.titleText = 'Page title';
        this.onRead = null;
        /** goto target -> where the server redirects it. */
        this.redirects = {};
        this.gotoCalls = [];
        this.enterNavigatesTo = null;
        this.scrollNavigatesTo = null;
        this.frame = { evaluate: async (fn) => (fn === passwordValues && this.passwordValue ? [this.passwordValue] : []) };
        this.keyboard = {
            press: async (key) => {
                this.actions.push(['keyboard', key]);
                if (key === 'Enter' && this.enterNavigatesTo) await this.goto(this.enterNavigatesTo);
            },
        };
    }
    url () { return this.currentUrl; }
    isClosed () { return false; }
    mainFrame () { return this.frame; }
    frames () { return [this.frame]; }
    async title () { return this.titleText; }
    async goto (url) {
        this.gotoCalls.push(url);
        this.currentUrl = this.redirects[url] ?? url;
        this.emit('framenavigated', this.frame);
    }
    async waitForLoadState () {}
    locator (selector) {
        const ref = /^\[data-ezil-ref="(e[0-9]+)"\]$/.exec(selector);
        if (ref) return new FakeLocator(this, ref[1]);
        if (selector === 'input[type=password]') return { mask: 'password' };
        throw new Error(`unexpected selector ${selector}`);
    }
    snapshotResult () {
        const els = [...this.elements.values()];
        return {
            text: els.map((e) => `- ${e.role} "${e.name}" [ref=${e.ref}]`).join('\n'),
            refs: els.map((e) => ({ ref: e.ref, role: e.role, name: e.name, isPassword: !!e.isPassword })),
            truncated: false,
        };
    }
    async read (value) {
        if (this.onRead) await this.onRead();
        return value;
    }
    async evaluate (fn, arg) {
        if (fn === snapshotPage) return this.read(this.snapshotResult());
        if (fn === pageMarkdown) return this.read(`# ${this.text}`);
        if (fn === containsText) return this.read(this.text.includes(arg));
        if (fn === scrollWindowBy) {
            this.scrollY += arg;
            if (this.scrollNavigatesTo) await this.goto(this.scrollNavigatesTo);
            return this.scrollY;
        }
        if (fn === windowScrollY) return this.scrollY;
        if (typeof fn === 'function' && String(fn).includes('visibilityState')) return this.visible ? 'visible' : 'hidden';
        throw new Error('unexpected page function');
    }
    async screenshot (opts) {
        const out = render('page', this.passwordValue, !!opts?.mask?.length);
        if (this.onRead) await this.onRead();
        return out;
    }
    // Events a real page emits, in the shapes `browser.mjs` reads.
    log (text, url = null, type = 'log') {
        this.emit('console', { type: () => type, text: () => text, location: () => (url ? { url, lineNumber: 7 } : {}) });
    }
    request (url, { status = 200, failed = false, method = 'GET' } = {}) {
        const req = {
            method: () => method,
            url: () => url,
            resourceType: () => 'document',
            response: async () => ({ status: () => status }),
            failure: () => ({ errorText: 'net::ERR_ABORTED' }),
        };
        this.emit(failed ? 'requestfailed' : 'requestfinished', req);
    }
}

function fakeBrowser (...contexts) {
    return { isConnected: () => true, contexts: () => contexts.map((pages) => ({ pages: () => pages })), on () {} };
}

function surfaceOver (pages, { policy = STAGING, contexts } = {}) {
    const surface = new BrowserSurface('http://127.0.0.1:9222', { originPolicy: policy });
    surface.browser = contexts ? fakeBrowser(...contexts) : fakeBrowser(pages);
    return surface;
}

/** Mint refs for `page` directly, exactly as a snapshot of it would have. */
function mintRefs (surface, page) {
    surface.registerRefs(page.snapshotResult().refs, page);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

async function codeOf (promise) {
    try {
        await promise;
        return 'ok';
    } catch (err) {
        return err && err.code ? err.code : `uncoded:${err && err.message}`;
    }
}

/** A valid body for every route, using the refs `formElements()` mints. */
const BODY = {
    'GET /health': {},
    'POST /navigate': { url: 'https://universe-staging.ezil.work/builder/profile-builder' },
    'POST /snapshot': {},
    'POST /click': { ref: 'e4' },
    'POST /type': { ref: 'e1', text: 'Ships things' },
    'POST /get_text': {},
    'POST /screenshot': {},
    'POST /console': {},
    'POST /network': {},
    'POST /wait_for': { text: 'Builder', time: 0.2 },
    'POST /fill_form': { fields: [{ ref: 'e1', value: 'Ships things' }, { ref: 'e6', value: 'About me' }] },
    'POST /select': { ref: 'e3', values: ['day'] },
    'POST /scroll': { dy: 300 },
    'POST /press': { key: 'Tab' },
};

// ── A2: idp_transit is transit only ──────────────────────────────────────────

describe('idp_transit: transit only', () => {
    const REFUSED = [
        ['POST /snapshot', {}],
        ['POST /click', { ref: 'e4' }],
        ['POST /type', { ref: 'e1', text: 'someone@example.com' }],
        ['POST /type', { ref: 'e2', text: 'hunter2-pass', submit: true }],
        ['POST /get_text', {}],
        ['POST /get_text', { ref: 'e1' }],
        ['POST /screenshot', {}],
        ['POST /screenshot', { ref: 'e1' }],
        ['POST /console', {}],
        ['POST /network', {}],
        ['POST /wait_for', { text: 'Builder' }],
        ['POST /wait_for', { text: 'Builder', time: 0.2 }],
        ['POST /fill_form', { fields: [{ ref: 'e1', value: 'someone@example.com' }] }],
        ['POST /select', { ref: 'e3', values: ['day'] }],
        ['POST /scroll', { dy: 200 }],
        ['POST /scroll', { ref: 'e1' }],
        ['POST /press', { key: 'Enter' }],
        ['POST /press', { ref: 'e1', key: 'Enter' }],
    ];

    for (const [route, body] of REFUSED) {
        it(`${route} ${JSON.stringify(body)} on the IdP answers origin_read_only and touches nothing`, async () => {
            const idp = new FakePage(AUTHORIZE_URL);
            const surface = surfaceOver([idp]);
            // Refs minted ON this page, so with the gate gone every one of
            // these would succeed — the gate is the only thing in the way.
            mintRefs(surface, idp);
            const generation = surface.refGeneration;
            expect(await codeOf(VERBS[route](surface, body))).toBe('origin_read_only');
            expect(idp.actions).toEqual([]);
            expect(idp.filled).toEqual([]);
            expect(surface.refGeneration).toBe(generation);
            expect(surface.typedSecrets.size).toBe(0);
        });

        it(`${route} ${JSON.stringify(body)} works on an owner_app page (positive control)`, async () => {
            const owner = new FakePage(OWNER_PAGE);
            const surface = surfaceOver([owner]);
            mintRefs(surface, owner);
            expect(await codeOf(VERBS[route](surface, body))).toBe('ok');
        });
    }

    it('navigate, health and wait_for{time} still work on the IdP (positive controls)', async () => {
        const idp = new FakePage(AUTHORIZE_URL);
        const surface = surfaceOver([idp]);
        expect(await VERBS['GET /health'](surface, {})).toEqual({ ok: true, chromeConnected: true, cdpUrl: 'http://127.0.0.1:9222' });
        expect(await VERBS['POST /wait_for'](surface, { time: 0.05 })).toEqual({ ok: true, matched: true });
        expect(await VERBS['POST /navigate'](surface, { url: 'https://id.ezil.work/u/login?state=abc' }))
            .toEqual({ ok: true, url: 'https://id.ezil.work/u/login', title: 'Page title' });
        expect(idp.currentUrl).toBe('https://id.ezil.work/u/login?state=abc');
    });

    it('the tier is read immediately before acting: a page that moved ONTO the IdP is refused', async () => {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('ok');
        page.currentUrl = AUTHORIZE_URL;
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('origin_read_only');
        expect(page.actions).toEqual([['click', 'e4']]);
    });

    it('reads are checked AGAIN after reading: an IdP page that arrived mid-read yields nothing', async () => {
        for (const [route, body] of [['POST /snapshot', {}], ['POST /get_text', {}], ['POST /screenshot', {}], ['POST /wait_for', { text: 'Builder', time: 0.5 }]]) {
            const page = new FakePage(OWNER_PAGE);
            const surface = surfaceOver([page]);
            page.onRead = async () => { page.currentUrl = AUTHORIZE_URL; };
            expect({ route, code: await codeOf(VERBS[route](surface, body)) }).toEqual({ route, code: 'origin_read_only' });
            // …and a snapshot read off the IdP registered no ref.
            if (route === 'POST /snapshot') expect(surface.refs.size).toBe(0);

            const control = new FakePage(OWNER_PAGE);
            expect({ route, code: await codeOf(VERBS[route](surfaceOver([control]), body)) }).toEqual({ route, code: 'ok' });
        }
    });

    it('a verb that NAVIGATES may land on the IdP; its url comes back sanitised', async () => {
        const page = new FakePage(OWNER_PAGE);
        page.elements.get('e4').navigatesTo = AUTHORIZE_URL_2;
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        expect(await VERBS['POST /click'](surface, { ref: 'e4' })).toEqual({ ok: true, url: 'https://id.ezil.work/authorize' });
    });
});

// ── a broken policy: every page is transit-only, for every caller ───────────

describe('a broken origin policy (a malformed tier entry) makes EVERY page idp_transit', () => {
    const BROKEN = loadOriginPolicy({
        [ORIGIN_TIER_ENV.owner_app]: 'https://universe-staging.ezil.work',
        [ORIGIN_TIER_ENV.idp_transit]: 'https://id.ezil.work/', // trailing slash: malformed
    });
    const REFUSED = Object.keys(SIDECAR_WIRE).filter((r) => !['GET /health', 'POST /navigate', 'POST /wait_for'].includes(r));

    for (const url of [OTHER_PAGE, OWNER_PAGE, 'http://127.0.0.1:3000/preview', 'about:blank']) {
        it(`a page at ${url}: every non-transit route is origin_read_only and nothing is touched`, async () => {
            expect(BROKEN.broken).toBe(true);
            const page = new FakePage(url);
            const surface = surfaceOver([page], { policy: BROKEN });
            mintRefs(surface, page);
            for (const route of REFUSED) {
                expect({ route, code: await codeOf(VERBS[route](surface, BODY[route])) }).toEqual({ route, code: 'origin_read_only' });
            }
            expect(await codeOf(VERBS['POST /wait_for'](surface, { text: 'Builder' }))).toBe('origin_read_only');
            expect(page.actions).toEqual([]);
            expect(page.filled).toEqual([]);
            // Transit still works, and what it returns is the transit form.
            expect(await codeOf(VERBS['GET /health'](surface, {}))).toBe('ok');
            expect(await codeOf(VERBS['POST /wait_for'](surface, { time: 0.05 }))).toBe('ok');
            const nav = await VERBS['POST /navigate'](surface, { url: 'https://example.com/next?page=2#top' });
            expect(nav.url).toBe('https://example.com/next');
        });
    }

    it('positive control: the same page under the well-formed policy is `other` and fully usable', async () => {
        const page = new FakePage(OTHER_PAGE);
        const surface = surfaceOver([page], { policy: STAGING });
        mintRefs(surface, page);
        for (const route of REFUSED) {
            expect({ route, code: await codeOf(VERBS[route](surface, BODY[route])) }).toEqual({ route, code: 'ok' });
        }
    });
});

// ── the Code loopback: opts.denyTiers ───────────────────────────────────────

describe('opts.denyTiers (the Code loopback passes owner_app + idp_transit)', () => {
    const GATED = Object.keys(SIDECAR_WIRE).filter((r) => r !== 'GET /health');

    for (const route of GATED) {
        it(`${route}: owner_app is origin_read_only for Code, ok for the Worker path and on other pages`, async () => {
            const owner = new FakePage(OWNER_PAGE);
            const surface = surfaceOver([owner]);
            mintRefs(surface, owner);
            expect(await codeOf(VERBS[route](surface, BODY[route], { denyTiers: CODE_DENY }))).toBe('origin_read_only');
            expect(owner.actions).toEqual([]);
            expect(owner.filled).toEqual([]);

            // Positive controls: same page without denyTiers, and an `other`
            // page WITH it (navigating somewhere `other`: a Code navigate to
            // the owner app is refused before it loads, tested below).
            expect(await codeOf(VERBS[route](surface, BODY[route]))).toBe('ok');
            const other = new FakePage(OTHER_PAGE);
            const otherSurface = surfaceOver([other]);
            mintRefs(otherSurface, other);
            const codeBody = route === 'POST /navigate' ? { url: 'https://example.org/next' } : BODY[route];
            expect(await codeOf(VERBS[route](otherSurface, codeBody, { denyTiers: CODE_DENY }))).toBe('ok');
        });
    }

    it('health is never gated', async () => {
        const surface = surfaceOver([new FakePage(OWNER_PAGE)]);
        expect((await VERBS['GET /health'](surface, {}, { denyTiers: CODE_DENY })).ok).toBe(true);
    });

    it('a malformed denyTiers is refused before anything is touched (a typo must not deny nothing)', async () => {
        for (const denyTiers of [['owner_app', 'idp_transit'], new Set(['owner-app']), 'owner_app']) {
            const owner = new FakePage(OWNER_PAGE);
            const surface = surfaceOver([owner]);
            mintRefs(surface, owner);
            await expect(VERBS['POST /click'](surface, { ref: 'e4' }, { denyTiers })).rejects.toThrow(/denyTiers must be a Set/);
            expect(owner.actions).toEqual([]);
        }
    });
});

// ── the Code loopback: landing on a denied tier returns NOTHING from it ─────

describe('Code loopback: a verb that LANDS on a denied tier answers origin_read_only, no url, no title', () => {
    const PRIVATE_TITLE = 'Universe — Ada Lovelace, builder profile';
    /** [route, body, how the page gets taken onto the target] */
    const LANDINGS = [
        ['POST /navigate', { url: 'https://go.example.com/next' }, (p, to) => { p.redirects['https://go.example.com/next'] = to; }],
        ['POST /click', { ref: 'e4' }, (p, to) => { p.elements.get('e4').navigatesTo = to; }],
        ['POST /type', { ref: 'e1', text: 'q', submit: true }, (p, to) => { p.elements.get('e1').submitNavigatesTo = to; }],
        ['POST /press', { key: 'Enter' }, (p, to) => { p.enterNavigatesTo = to; }],
        ['POST /press', { ref: 'e1', key: 'Enter' }, (p, to) => { p.elements.get('e1').submitNavigatesTo = to; }],
        ['POST /fill_form', { fields: [{ ref: 'e1', value: 'x' }] }, (p, to) => { p.elements.get('e1').fillNavigatesTo = to; }],
        ['POST /select', { ref: 'e3', values: ['day'] }, (p, to) => { p.elements.get('e3').selectNavigatesTo = to; }],
        ['POST /scroll', { dy: 100 }, (p, to) => { p.scrollNavigatesTo = to; }],
        ['POST /scroll', { ref: 'e6' }, (p, to) => { p.elements.get('e6').scrollNavigatesTo = to; }],
    ];

    async function land (route, body, arrange, to, opts) {
        const page = new FakePage(OTHER_PAGE);
        page.titleText = PRIVATE_TITLE;
        arrange(page, to);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        try {
            return { page, out: await VERBS[route](surface, body, opts) };
        } catch (err) {
            return { page, err };
        }
    }

    for (const [route, body, arrange] of LANDINGS) {
        for (const [tierName, to] of [['owner_app', OWNER_PAGE], ['idp_transit', 'https://id.ezil.work/u/login']]) {
            it(`${route} ${JSON.stringify(body)} landing on ${tierName}: refused, and nothing about it comes back`, async () => {
                const { page, out, err } = await land(route, body, arrange, to, { denyTiers: CODE_DENY });
                expect(out).toBeUndefined();
                expect(err.code).toBe('origin_read_only');
                for (const secret of ['universe-staging', 'id.ezil.work', 'Ada Lovelace', PRIVATE_TITLE]) {
                    expect(err.message).not.toContain(secret);
                }
                // It DID land — the refusal is about what is answered.
                expect(page.currentUrl).toBe(to);
            });
        }

        it(`${route} ${JSON.stringify(body)}: positive controls — landing on other is fine for Code, anything is for the Worker`, async () => {
            const toOther = await land(route, body, arrange, 'https://elsewhere.example.org/ok', { denyTiers: CODE_DENY });
            expect(toOther.err).toBeUndefined();
            expect(toOther.out.url).toBe('https://elsewhere.example.org/ok');
            const worker = await land(route, body, arrange, OWNER_PAGE, {});
            expect(worker.err).toBeUndefined();
            expect(worker.out.url).toBe(OWNER_PAGE);
            if (route === 'POST /navigate') expect(worker.out.title).toBe(PRIVATE_TITLE);
        });
    }

    it('navigate straight to a denied target is refused BEFORE anything loads', async () => {
        for (const target of [OWNER_PAGE, CALLBACK_URL, AUTHORIZE_URL, 'https://id.ezil.work/u/login']) {
            const page = new FakePage(OTHER_PAGE);
            const surface = surfaceOver([page]);
            expect({ target, code: await codeOf(VERBS['POST /navigate'](surface, { url: target }, { denyTiers: CODE_DENY })) })
                .toEqual({ target, code: 'origin_read_only' });
            expect(page.gotoCalls).toEqual([]);
            expect(page.currentUrl).toBe(OTHER_PAGE);
        }
        // Positive controls: an `other` target loads for Code; the Worker path loads anything.
        const page = new FakePage(OTHER_PAGE);
        const surface = surfaceOver([page]);
        expect(await codeOf(VERBS['POST /navigate'](surface, { url: 'https://example.org/' }, { denyTiers: CODE_DENY }))).toBe('ok');
        expect(await codeOf(VERBS['POST /navigate'](surface, { url: OWNER_PAGE }))).toBe('ok');
        expect(page.gotoCalls).toEqual(['https://example.org/', OWNER_PAGE]);
    });

    it('nothing the tab recorded while on a denied tier comes back to Code from console or network', async () => {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        await surface.activePage();
        page.log('universe says: welcome back Ada');
        page.request('https://universe-staging.ezil.work/builder/profile-builder-save', { method: 'POST' });
        await tick();
        await page.goto(OTHER_PAGE); // the USER moved the tab on
        page.log('preview loaded');
        page.request('https://example.com/app.js');
        await tick();
        const logs = await VERBS['POST /console'](surface, {}, { denyTiers: CODE_DENY });
        expect(logs.entries.map((e) => e.text)).toEqual(['preview loaded']);
        const net = await VERBS['POST /network'](surface, {}, { denyTiers: CODE_DENY });
        expect(net.requests.map((r) => r.url)).toEqual(['https://example.com/app.js']);
        // Positive control: the Worker path still sees the tab's whole (sanitised) history.
        expect((await VERBS['POST /console'](surface, {})).entries.map((e) => e.text))
            .toEqual(['universe says: welcome back Ada', 'preview loaded']);
        expect((await VERBS['POST /network'](surface, {})).requests).toHaveLength(2);
    });
});

// ── A2: no code= or state= in ANY output ─────────────────────────────────────

describe('no OAuth parameter leaves in any handler output', () => {
    for (const pageUrl of [CALLBACK_URL, AUTHORIZE_URL, CALLBACK_URL_2, AUTHORIZE_URL_2]) {
        it(`page at ${pageUrl}: every route, every response, scanned`, async () => {
            const page = new FakePage(pageUrl);
            const surface = surfaceOver([page]);
            await surface.activePage(); // attach listeners

            // Everything the buffers can hold, carrying the URLs.
            for (const url of [pageUrl, CALLBACK_URL_2, AUTHORIZE_URL_2]) {
                page.log(`redirect to ${url}`, url);
                page.log(`escaped ${JSON.stringify(url).replace(/\//g, '\\/')}`, null, 'error');
                page.emit('pageerror', new Error(`failed at ${url}`));
                page.request(url, { status: 302 });
                page.request(url, { failed: true });
            }
            await tick();

            const outputs = [];
            for (const route of Object.keys(SIDECAR_WIRE)) {
                mintRefs(surface, page);
                const body = route === 'POST /navigate' ? { url: pageUrl } : BODY[route];
                try {
                    outputs.push({ route, out: await VERBS[route](surface, body) });
                } catch (err) {
                    outputs.push({ route, error: err.code, message: err.message });
                }
                page.currentUrl = pageUrl;
            }
            const json = JSON.stringify(outputs);
            for (const marker of LEAK_MARKERS) expect({ marker, leaked: json.includes(marker) }).toEqual({ marker, leaked: false });

            // Positive control: this scan saw real URLs, not an empty room.
            const isOwner = pageUrl.startsWith('https://universe-staging.ezil.work/');
            const sanitized = isOwner
                ? 'https://universe-staging.ezil.work/creator/social-login/callback/auth0'
                : 'https://id.ezil.work/authorize';
            const navigate = outputs.find((o) => o.route === 'POST /navigate').out;
            expect(navigate.url).toBe(sanitized);
            if (isOwner) {
                const { entries } = outputs.find((o) => o.route === 'POST /console').out;
                const { requests } = outputs.find((o) => o.route === 'POST /network').out;
                expect(entries.length).toBe(9);
                expect(requests.length).toBe(6);
                expect(entries[0].text).toBe(`redirect to ${sanitized}`);
                expect(entries[0].location).toBe(`${sanitized}:7`);
                expect(requests.map((r) => r.url)).toContain('https://id.ezil.work/authorize');
            } else {
                // Everything but health and navigate: wait_for here asks for text.
                expect(outputs.filter((o) => o.error === 'origin_read_only').length).toBe(12);
            }
        });
    }

    it('the buffers never even HOLD the parameters (sanitised when recorded)', async () => {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        await surface.activePage();
        page.log(`go ${CALLBACK_URL_2}`, AUTHORIZE_URL_2);
        page.request(CALLBACK_URL_2);
        page.request(AUTHORIZE_URL_2, { failed: true });
        await tick();
        const held = JSON.stringify([surface.consoleBuffer, surface.networkBuffer]);
        for (const marker of LEAK_MARKERS) expect(held).not.toContain(marker);
        expect(surface.consoleBuffer).toHaveLength(1);
        expect(surface.networkBuffer).toHaveLength(2);
    });
});

// ── console / network: the active page only ─────────────────────────────────

describe('console and network report the active page only', () => {
    async function twoTabs () {
        const a = new FakePage('https://example.com/a', { visible: true });
        const b = new FakePage('https://example.org/b', { visible: false });
        const c = new FakePage('https://example.net/c', { visible: false });
        // c lives in ANOTHER context (the browser-open canary's, say).
        const surface = surfaceOver(null, { contexts: [[a, b], [c]] });
        await surface.activePage();
        a.log('from A');
        b.log('from B');
        c.log('from C');
        a.request('https://example.com/a.js');
        b.request('https://example.org/b.js');
        c.request('https://example.net/c.js', { failed: true });
        await tick();
        return { a, b, c, surface };
    }

    it('returns the active tab\'s entries and nothing from other tabs or contexts', async () => {
        const { surface } = await twoTabs();
        const logs = await VERBS['POST /console'](surface, {});
        const network = await VERBS['POST /network'](surface, {});
        expect(logs.entries.map((e) => e.text)).toEqual(['from A']);
        expect(network.requests.map((r) => r.url)).toEqual(['https://example.com/a.js']);
    });

    it('follows the active tab when the user switches', async () => {
        const { a, b, surface } = await twoTabs();
        a.visible = false;
        b.visible = true;
        expect((await VERBS['POST /console'](surface, {})).entries.map((e) => e.text)).toEqual(['from B']);
        expect((await VERBS['POST /network'](surface, {})).requests.map((r) => r.url)).toEqual(['https://example.org/b.js']);
    });

    it('keeps the public v1 entry shape: the page tag never leaves', async () => {
        const { surface } = await twoTabs();
        const [entry] = (await VERBS['POST /console'](surface, {})).entries;
        const [request] = (await VERBS['POST /network'](surface, {})).requests;
        expect(Object.keys(entry).sort()).toEqual(['at', 'level', 'location', 'text']);
        expect(Object.keys(request).sort()).toEqual(['at', 'failure', 'method', 'resourceType', 'status', 'url']);
        expect(JSON.stringify([entry, request])).not.toMatch(/pageKey|tier|"p[0-9]+"/);
    });

    it('level and filter still narrow within the active page', async () => {
        const { a, surface } = await twoTabs();
        a.log('bad thing', null, 'error');
        expect((await VERBS['POST /console'](surface, { level: 'error' })).entries.map((e) => e.text)).toEqual(['bad thing']);
        expect((await VERBS['POST /network'](surface, { filter: 'a.js' })).requests).toHaveLength(1);
        expect((await VERBS['POST /network'](surface, { filter: 'b.js' })).requests).toHaveLength(0);
    });

    it('IdP-era console text stays behind after the redirect back; the hop itself is still in network', async () => {
        const page = new FakePage(AUTHORIZE_URL);
        const surface = surfaceOver([page]);
        await surface.activePage();
        page.log('idp page says: welcome back someone@example.com');
        page.request('https://id.ezil.work/u/login?state=abc', { method: 'POST', status: 302 });
        await tick();
        await page.goto(OWNER_PAGE);
        page.log('owner page loaded');
        await tick();
        const logs = await VERBS['POST /console'](surface, {});
        expect(logs.entries.map((e) => e.text)).toEqual(['owner page loaded']);
        const network = await VERBS['POST /network'](surface, {});
        expect(network.requests.map((r) => [r.method, r.url, r.status])).toEqual([['POST', 'https://id.ezil.work/u/login', 302]]);
    });
});

// ── refs are page-bound ─────────────────────────────────────────────────────

describe('refs are bound to the page and origin that minted them', () => {
    it('a ref minted on tab A is stale_ref on tab B, even though B carries a matching attribute', async () => {
        const a = new FakePage('https://example.com/a', { visible: true });
        const b = new FakePage('https://example.com/b', { visible: false }); // same origin, leftover e4
        const surface = surfaceOver([a, b]);
        await VERBS['POST /snapshot'](surface, {});
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('ok');
        expect(a.actions).toEqual([['click', 'e4']]);

        a.visible = false;
        b.visible = true;
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('stale_ref');
        expect(await codeOf(VERBS['POST /type'](surface, { ref: 'e1', text: 'x' }))).toBe('stale_ref');
        expect(b.actions).toEqual([]);

        // Back on A, the same ref is good again: nothing else changed.
        a.visible = true;
        b.visible = false;
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('ok');
    });

    it('a ref is stale_ref once its page\'s origin changed, even with no navigation event', async () => {
        const a = new FakePage('https://example.com/a');
        const surface = surfaceOver([a]);
        await VERBS['POST /snapshot'](surface, {});
        a.currentUrl = 'https://example.com/a#section'; // same origin: still good
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('ok');
        a.currentUrl = 'https://attacker.example/a'; // origin changed under the ref
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('stale_ref');
        expect(a.actions).toEqual([['click', 'e4']]);
    });

    it('a ref registered without a page resolves nowhere (fail closed)', async () => {
        const a = new FakePage('https://example.com/a');
        const surface = surfaceOver([a]);
        surface.registerRefs(a.snapshotResult().refs, undefined);
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('stale_ref');
    });

    it('v1 distinctions survive: never issued is bad_ref, an older snapshot is stale_ref', async () => {
        const a = new FakePage('https://example.com/a');
        const surface = surfaceOver([a]);
        await VERBS['POST /snapshot'](surface, {});
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e99' }))).toBe('bad_ref');
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'button' }))).toBe('bad_ref');
        await a.goto('https://example.com/next');
        expect(await codeOf(VERBS['POST /click'](surface, { ref: 'e4' }))).toBe('stale_ref');
    });

    it('/screenshot{ref} keeps the ref\'s own code instead of reporting chrome_unreachable', async () => {
        const a = new FakePage('https://example.com/a');
        const surface = surfaceOver([a]);
        expect(await codeOf(VERBS['POST /screenshot'](surface, { ref: 'e1' }))).toBe('bad_ref');
        await VERBS['POST /snapshot'](surface, {});
        expect(await codeOf(VERBS['POST /screenshot'](surface, { ref: 'e1' }))).toBe('ok');
    });
});

// ── /fill_form ───────────────────────────────────────────────────────────────

describe('/fill_form', () => {
    function owner () {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        return { page, surface };
    }

    it('fills every field and counts them (positive control)', async () => {
        const { page, surface } = owner();
        const out = await VERBS['POST /fill_form'](surface, BODY['POST /fill_form']);
        expect(out).toEqual({ ok: true, url: OWNER_PAGE, filled: 2, redacted: 0 });
        expect(page.filled).toEqual([{ ref: 'e1', value: 'Ships things' }, { ref: 'e6', value: 'About me' }]);
    });

    it('all or nothing: a stale ref among the fields fills NOTHING', async () => {
        const { page, surface } = owner();
        // A newer snapshot that no longer lists e6: e6 is from the older one.
        surface.registerRefs(page.snapshotResult().refs.filter((r) => r.ref !== 'e6'), page);
        const code = await codeOf(VERBS['POST /fill_form'](surface, {
            fields: [{ ref: 'e1', value: 'first' }, { ref: 'e6', value: 'second' }],
        }));
        expect(code).toBe('stale_ref');
        expect(page.filled).toEqual([]);
    });

    it('all or nothing: a never-issued, gone, other-tab or unfillable ref fills NOTHING', async () => {
        const cases = [
            ['bad_ref', (page) => [{ ref: 'e1', value: 'x' }, { ref: 'e77', value: 'y' }]],
            ['stale_ref', (page) => { page.elements.delete('e6'); return [{ ref: 'e1', value: 'x' }, { ref: 'e6', value: 'y' }]; }],
            ['bad_ref', () => [{ ref: 'e1', value: 'x' }, { ref: 'e4', value: 'y' }]],
            ['bad_ref', () => [{ ref: 'e1', value: 'x' }, { ref: 'e3', value: 'day' }]],
        ];
        for (const [expected, fieldsFor] of cases) {
            const { page, surface } = owner();
            const fields = fieldsFor(page);
            expect({ fields, code: await codeOf(VERBS['POST /fill_form'](surface, { fields })) }).toEqual({ fields, code: expected });
            expect(page.filled).toEqual([]);
        }

        const a = new FakePage(OWNER_PAGE, { visible: true });
        const b = new FakePage(OWNER_PAGE, { visible: false });
        const surface = surfaceOver([a, b]);
        await VERBS['POST /snapshot'](surface, {});
        a.visible = false;
        b.visible = true;
        expect(await codeOf(VERBS['POST /fill_form'](surface, { fields: [{ ref: 'e1', value: 'x' }] }))).toBe('stale_ref');
        expect([...a.filled, ...b.filled]).toEqual([]);
    });

    it('a password value never comes back, is counted in `redacted`, and is a secret BEFORE the first fill', async () => {
        const { page, surface } = owner();
        const secret = 'correct-horse-battery-staple';
        const filledAtRemember = [];
        const remember = surface.rememberSecret.bind(surface);
        surface.rememberSecret = (v) => { filledAtRemember.push(page.filled.length); remember(v); };

        const out = await VERBS['POST /fill_form'](surface, {
            fields: [{ ref: 'e1', value: 'Ada' }, { ref: 'e2', value: secret }],
        });
        expect(out).toEqual({ ok: true, url: OWNER_PAGE, filled: 2, redacted: 1 });
        expect(JSON.stringify(out)).not.toContain(secret);
        expect(filledAtRemember).toEqual([0]);
        expect(await surface.allSecrets()).toContain(secret);
        // …and the one response guard (server.mjs) has it to act on.
        expect(JSON.stringify(redactDeep({ echo: `typed ${secret}` }, await surface.allSecrets()))).not.toContain(secret);
    });

    it('a fill that fails partway still leaves every password value in the secret set', async () => {
        const { page, surface } = owner();
        page.elements.get('e1').failFill = true;
        const secret = 'tr0ub4dor-and-3';
        let caught = null;
        try {
            await VERBS['POST /fill_form'](surface, { fields: [{ ref: 'e1', value: 'Ada' }, { ref: 'e2', value: secret }] });
        } catch (err) {
            caught = err;
        }
        expect(caught.code).toBe('stale_ref');
        expect(caught.message).not.toContain(secret);
        expect([...surface.typedSecrets]).toEqual([secret]);
    });

    it('a field that is a password NOW counts, even if the snapshot saw it revealed', async () => {
        const { page, surface } = owner();
        surface.registerRefs(page.snapshotResult().refs.map((r) => ({ ...r, isPassword: false })), page);
        const out = await VERBS['POST /fill_form'](surface, { fields: [{ ref: 'e2', value: 'revealed-then-hidden' }] });
        expect(out.redacted).toBe(1);
        expect([...surface.typedSecrets]).toEqual(['revealed-then-hidden']);
    });

    it(`bounds: 1..${FILL_FORM_MAX_FIELDS} fields, values ≤ ${FIELD_VALUE_MAX_CHARS} chars, strings only`, async () => {
        const many = (n) => Array.from({ length: n }, (_, i) => ({ ref: `e${i + 1}`, value: 'v' }));
        const wide = Array.from({ length: FILL_FORM_MAX_FIELDS }, (_, i) => ({
            ref: `e${i + 1}`, role: 'textbox', name: `F${i + 1}`, tag: 'input', type: 'text', fillable: true,
        }));
        const page = new FakePage(OWNER_PAGE, { elements: wide });
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        for (const fields of [undefined, [], many(FILL_FORM_MAX_FIELDS + 1), 'e1', [null], [['e1', 'v']],
            [{ ref: 'e1', value: 'x'.repeat(FIELD_VALUE_MAX_CHARS + 1) }], [{ ref: 'e1', value: 7 }], [{ ref: 'e1' }]]) {
            expect({ fields: JSON.stringify(fields)?.slice(0, 40), code: await codeOf(VERBS['POST /fill_form'](surface, { fields })) })
                .toEqual({ fields: JSON.stringify(fields)?.slice(0, 40), code: 'bad_request' });
        }
        expect(page.filled).toEqual([]);
        expect((await VERBS['POST /fill_form'](surface, { fields: many(FILL_FORM_MAX_FIELDS) })).filled).toBe(FILL_FORM_MAX_FIELDS);
        expect((await VERBS['POST /fill_form'](surface, { fields: [{ ref: 'e1', value: 'x'.repeat(FIELD_VALUE_MAX_CHARS) }] })).filled).toBe(1);
        expect((await VERBS['POST /fill_form'](surface, { fields: [{ ref: 'e1', value: '' }] })).filled).toBe(1);
    });
});

// ── /select, /scroll, /press ────────────────────────────────────────────────

describe('/select', () => {
    function owner () {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        return { page, surface };
    }

    it('selects by label or value and returns what is now selected', async () => {
        const { page, surface } = owner();
        expect(await VERBS['POST /select'](surface, { ref: 'e3', values: ['day'] })).toEqual({ ok: true, url: OWNER_PAGE, selected: ['day'] });
        expect(page.actions).toEqual([['selectOption', 'e3', ['day']]]);
    });

    it('a ref that is not a combobox/listbox, or not a real <select>, is bad_ref', async () => {
        const { page, surface } = owner();
        expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e4', values: ['day'] }))).toBe('bad_ref'); // button
        expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e1', values: ['day'] }))).toBe('bad_ref'); // textbox
        expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e5', values: ['day'] }))).toBe('bad_ref'); // ARIA listbox
        expect(page.actions).toEqual([]);
    });

    it('a value no option has is bad_request at once, not a timeout', async () => {
        const { page, surface } = owner();
        expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e3', values: ['fortnight'] }))).toBe('bad_request');
        expect(page.actions).toEqual([]);
    });

    it(`values: 1..${SELECT_MAX_VALUES} strings`, async () => {
        const { surface } = owner();
        for (const values of [undefined, [], 'day', [1], [null], Array(SELECT_MAX_VALUES + 1).fill('day')]) {
            expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e3', values }))).toBe('bad_request');
        }
        expect(await codeOf(VERBS['POST /select'](surface, { ref: 'e3', values: Array(SELECT_MAX_VALUES).fill('day') }))).toBe('ok');
    });
});

describe('/scroll', () => {
    function owner () {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        return { page, surface };
    }

    it('exactly one of ref or dy', async () => {
        const { surface } = owner();
        expect(await codeOf(VERBS['POST /scroll'](surface, {}))).toBe('bad_request');
        expect(await codeOf(VERBS['POST /scroll'](surface, { ref: 'e1', dy: 10 }))).toBe('bad_request');
        expect(await codeOf(VERBS['POST /scroll'](surface, { ref: null, dy: null }))).toBe('bad_request');
    });

    it(`dy is an integer with |dy| ≤ ${SCROLL_MAX_DY}`, async () => {
        const { surface } = owner();
        for (const dy of [1.5, '100', Number.NaN, Infinity, SCROLL_MAX_DY + 1, -SCROLL_MAX_DY - 1, true]) {
            expect({ dy, code: await codeOf(VERBS['POST /scroll'](surface, { dy })) }).toEqual({ dy, code: 'bad_request' });
        }
        for (const dy of [SCROLL_MAX_DY, -SCROLL_MAX_DY, 0, 1]) {
            expect({ dy, code: await codeOf(VERBS['POST /scroll'](surface, { dy })) }).toEqual({ dy, code: 'ok' });
        }
    });

    it('dy scrolls the window and reports scrollY; ref scrolls that element into view', async () => {
        const { page, surface } = owner();
        expect(await VERBS['POST /scroll'](surface, { dy: 300 })).toEqual({ ok: true, url: OWNER_PAGE, scrollY: 300 });
        expect(await VERBS['POST /scroll'](surface, { ref: 'e6' })).toEqual({ ok: true, url: OWNER_PAGE, scrollY: 900 });
        expect(page.actions).toEqual([['scrollIntoView', 'e6']]);
    });
});

describe('/press', () => {
    function owner () {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        mintRefs(surface, page);
        return { page, surface };
    }

    it('every PRESS_KEYS key is accepted, and the constant is what reaches the keyboard', async () => {
        const { page, surface } = owner();
        for (const key of PRESS_KEYS) expect(await VERBS['POST /press'](surface, { key })).toEqual({ ok: true, url: OWNER_PAGE });
        expect(page.actions).toEqual(PRESS_KEYS.map((key) => ['keyboard', key]));
    });

    it('anything else is bad_request: exact match, Shift+Tab is the only chord', async () => {
        const { page, surface } = owner();
        for (const key of ['enter', 'ENTER', ' Enter', 'Enter ', 'Control+a', 'Shift+Enter', 'Meta+Tab', 'Alt+F4',
            'shift+tab', 'Shift+Tab+Tab', 'a', ' ', 'F5', '', 13, null, undefined, ['Enter']]) {
            expect({ key, code: await codeOf(VERBS['POST /press'](surface, { key })) }).toEqual({ key, code: 'bad_request' });
        }
        expect(page.actions).toEqual([]);
    });

    it('with a ref the key goes to that element', async () => {
        const { page, surface } = owner();
        expect(await VERBS['POST /press'](surface, { ref: 'e1', key: 'Shift+Tab' })).toEqual({ ok: true, url: OWNER_PAGE });
        expect(page.actions).toEqual([['press', 'e1', 'Shift+Tab']]);
        expect(await codeOf(VERBS['POST /press'](surface, { ref: 'e99', key: 'Enter' }))).toBe('bad_ref');
    });
});

// ── screenshots: masked bytes do not depend on the password ─────────────────

describe('/screenshot masks password fields', () => {
    it('masked PNG bytes are identical whatever the password value', async () => {
        const page = new FakePage(OWNER_PAGE);
        const surface = surfaceOver([page]);
        page.passwordValue = 'abcd';
        const short = await VERBS['POST /screenshot'](surface, {});
        page.passwordValue = 'a-much-longer-password-than-that!';
        const long = await VERBS['POST /screenshot'](surface, {});
        expect(long.pngBase64).toBe(short.pngBase64);
        expect(long.sha256).toBe(short.sha256);
        expect(long.byteSize).toBe(short.byteSize);
        // Positive control: this fake DOES render the dots when not masked,
        // so the identity above is the mask's doing, not the fake's.
        page.passwordValue = 'abcd';
        const unmaskedShort = await page.screenshot({});
        page.passwordValue = 'a-much-longer-password-than-that!';
        const unmaskedLong = await page.screenshot({});
        expect(unmaskedShort.equals(unmaskedLong)).toBe(false);
    });
});

// ── the surface's own policy wiring ─────────────────────────────────────────

describe('BrowserSurface loads its policy once, at creation', () => {
    it('reads process.env when none is injected, and logs a broken policy ONCE then', () => {
        const saved = { ...process.env };
        const warn = spyOn(console, 'warn').mockImplementation(() => {});
        try {
            process.env[ORIGIN_TIER_ENV.owner_app] = 'https://universe-staging.ezil.work';
            process.env[ORIGIN_TIER_ENV.idp_transit] = 'https://id.ezil.work/';
            const surface = new BrowserSurface('http://127.0.0.1:9222');
            expect(surface.originPolicy.broken).toBe(true);
            expect(surface.originPolicy.owner_app).toEqual([]);
            expect(surface.originPolicy.idp_transit).toEqual([]);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(String(warn.mock.calls[0][0])).toContain('origin policy BROKEN');
            expect(String(warn.mock.calls[0][0])).toContain(`${ORIGIN_TIER_ENV.idp_transit} entry #1`);
            // …and well-formed values are read as tiers, logging nothing.
            warn.mockClear();
            process.env[ORIGIN_TIER_ENV.idp_transit] = 'https://id.ezil.work';
            const sound = new BrowserSurface('http://127.0.0.1:9222');
            expect(sound.originPolicy.broken).toBe(false);
            expect(sound.originPolicy.owner_app).toEqual(['https://universe-staging.ezil.work']);
            expect(sound.originPolicy.idp_transit).toEqual(['https://id.ezil.work']);
            expect(warn).toHaveBeenCalledTimes(0);
            // An injected policy is used as given, and logs nothing.
            warn.mockClear();
            expect(new BrowserSurface('x', { originPolicy: STAGING }).originPolicy).toBe(STAGING);
            expect(warn).toHaveBeenCalledTimes(0);
        } finally {
            warn.mockRestore();
            for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
            Object.assign(process.env, saved);
        }
    });

    it('refuses a policy that did not come from loadOriginPolicy', () => {
        expect(() => new BrowserSurface('x', { originPolicy: { owner_app: [], idp_transit: [] } })).toThrow(TypeError);
    });
});
