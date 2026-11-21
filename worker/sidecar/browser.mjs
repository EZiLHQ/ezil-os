/**
 * The CDP attachment, and everything that has to be remembered between verbs.
 *
 * ── connectOverCDP adopts, it does not create ───────────────────────────────
 * `chromium.connectOverCDP` attaches to the browser that is ALREADY running on
 * the EZiL OS desktop and adopts its existing context and tabs. It does not
 * launch a browser, does not create a fresh context, and does not open a tab.
 * That is the whole reason it is the right primitive here: the page an agent
 * drives is the page the user is watching in the neko stream, not a parallel
 * invisible one.
 *
 * It also means the sidecar is a GUEST. It must not resize the window, must
 * not change the viewport, and must not close pages it did not open — the
 * desktop's pinned 1920x1080 window geometry is maintained by a boot gate and
 * a validator that this process has no business fighting.
 *
 * ── Reconnection ────────────────────────────────────────────────────────────
 * Chrome is supervised (`supervise_app chromium …` in start-neko.sh) and does
 * restart. The connection is therefore lazy and re-established on demand, and
 * every verb reports `chrome_unreachable` rather than throwing when it cannot
 * be made. A Chrome restart is also what invalidates every outstanding ref,
 * so the ref generation is bumped when the connection is rebuilt.
 *
 * ── v2: origin tiers, page-bound refs, page-scoped buffers ──────────────────
 * The origin policy (`origin-policy.mjs`) is loaded from `process.env` ONCE,
 * when the surface is created, and malformed tier entries are logged then.
 * Tests inject a policy instead.
 *
 * Every page (tab) gets a key the first time this process sees it. A ref
 * remembers the key and the origin of the page whose snapshot minted it, so a
 * ref used on another tab, or after the tab's origin changed, is `stale_ref`
 * even when a leftover `data-ezil-ref` attribute there happens to match.
 *
 * Console and network entries are tagged with their page's key and SANITISED
 * AS THEY ARE RECORDED (`sanitizeUrl` / `sanitizeText`), so an OAuth `code`
 * or `state` never sits in a buffer waiting for a response to carry it out.
 * `consoleEntries(page)` / `networkEntries(page)` return only that page's
 * entries, in the public v1 shape; the tag never leaves.
 */

import { chromium } from 'playwright-core';
import { passwordValues } from './page-scripts.mjs';
import {
    isOriginPolicy, loadOriginPolicy, originPolicyBootLines, sanitizeText, sanitizeUrl, tierOf,
} from './origin-policy.mjs';

/** How many console lines / network records are retained. */
export const CONSOLE_BUFFER_MAX = 300;
export const NETWORK_BUFFER_MAX = 300;

/** How many issued refs are remembered, so `stale_ref` stays distinguishable
 *  from `bad_ref` for a while after the snapshot that minted them. */
const REF_HISTORY_MAX = 4000;

export class BrowserSurface {
    /**
     * @param {string} cdpUrl
     * @param {{ originPolicy?: object }} [options] `originPolicy` must come from
     *   `loadOriginPolicy`; omitted, it is loaded from `process.env` here.
     */
    constructor (cdpUrl, { originPolicy } = {}) {
        this.cdpUrl = cdpUrl;
        this.browser = null;
        this.connecting = null;
        /** Bumped by every snapshot AND by every main-frame navigation. A ref
         *  whose generation is not the current one is STALE, not unknown. */
        this.refGeneration = 0;
        /** ref -> { generation, role, name, isPassword, pageKey, origin } */
        this.refs = new Map();
        /** Internal records `{ pageKey, tier, entry }`; `entry` is the public
         *  shape, already sanitised. Read through `consoleEntries(page)` /
         *  `networkEntries(page)`, never directly into a response. */
        this.consoleBuffer = [];
        this.networkBuffer = [];
        /** Values this process has typed into password fields. Kept because a
         *  field can be cleared, navigated away from, or re-rendered between
         *  the type and the response that must not contain it. */
        this.typedSecrets = new Set();
        this.attached = new WeakSet();
        /** page -> 'p<n>'. A WeakMap so a closed tab's key goes with it. */
        this.pageKeys = new WeakMap();
        this.pageCounter = 0;

        if (originPolicy === undefined) {
            this.originPolicy = loadOriginPolicy(process.env);
            // "Logged once at boot": the surface is built once, by startServer.
            for (const line of originPolicyBootLines(this.originPolicy)) console.warn(line);
        } else if (isOriginPolicy(originPolicy)) {
            this.originPolicy = originPolicy;
        } else {
            throw new TypeError('BrowserSurface: originPolicy must come from loadOriginPolicy(env)');
        }
    }

    /** This process's key for a page, minted the first time it is seen. */
    pageKeyOf (page) {
        if (page === null || typeof page !== 'object') return null;
        let key = this.pageKeys.get(page);
        if (key === undefined) {
            this.pageCounter += 1;
            key = `p${this.pageCounter}`;
            this.pageKeys.set(page, key);
        }
        return key;
    }

    /** True when a live CDP connection exists. Never throws. */
    isConnected () {
        return !!(this.browser && this.browser.isConnected());
    }

    /**
     * Get (or build) the CDP connection. Throws `chrome_unreachable` as a
     * tagged error the router turns into the contract's error shape.
     */
    async connect () {
        if (this.isConnected()) return this.browser;
        if (!this.connecting) {
            this.connecting = (async () => {
                const browser = await chromium.connectOverCDP(this.cdpUrl, { timeout: 10_000 });
                this.browser = browser;
                this.refGeneration += 1;
                this.refs.clear();
                browser.on('disconnected', () => {
                    if (this.browser === browser) this.browser = null;
                });
                return browser;
            })().finally(() => { this.connecting = null; });
        }
        try {
            return await this.connecting;
        } catch (err) {
            const tagged = new Error(err && err.message ? err.message : String(err));
            tagged.code = 'chrome_unreachable';
            throw tagged;
        }
    }

    /**
     * The page a verb acts on: the tab the user is actually looking at.
     *
     * Chrome marks exactly one tab per window `document.visibilityState ===
     * 'visible'`, which is a far better answer than "the first page" — the
     * desktop boots with the EZiL landing page and an agent may well have
     * opened others. Falls back to the last page (Chrome's own ordering puts
     * the most recently created tab last) when nothing reports visible, which
     * happens if the window is somehow unmapped.
     */
    async activePage () {
        const browser = await this.connect();
        const contexts = browser.contexts();
        const pages = [];
        for (const ctx of contexts) for (const p of ctx.pages()) if (!p.isClosed()) pages.push(p);
        if (pages.length === 0) {
            const err = new Error('the browser has no open page');
            err.code = 'chrome_unreachable';
            throw err;
        }
        for (const page of pages) this.attach(page);
        for (const page of pages) {
            try {
                if (await page.evaluate(() => document.visibilityState) === 'visible') return page;
            } catch { /* a page mid-navigation cannot answer; try the next */ }
        }
        return pages[pages.length - 1];
    }

    /** Wire console/network/navigation listeners onto a page exactly once. */
    attach (page) {
        if (this.attached.has(page)) return;
        this.attached.add(page);
        const pageKey = this.pageKeyOf(page);

        page.on('console', (msg) => {
            this.record(this.consoleBuffer, CONSOLE_BUFFER_MAX, page, pageKey, () => {
                let text = '';
                try { text = msg.text(); } catch { text = ''; }
                let location = null;
                try {
                    const l = msg.location();
                    location = l && l.url ? `${sanitizeUrl(l.url, this.originPolicy)}:${l.lineNumber ?? 0}` : null;
                } catch { /* location is best effort */ }
                return {
                    level: normaliseLevel(msg.type()),
                    text: sanitizeText(text, this.originPolicy),
                    location,
                    at: new Date().toISOString(),
                };
            });
        });

        page.on('pageerror', (err) => {
            this.record(this.consoleBuffer, CONSOLE_BUFFER_MAX, page, pageKey, () => ({
                level: 'error',
                text: sanitizeText(err && err.message ? err.message : String(err), this.originPolicy),
                location: null,
                at: new Date().toISOString(),
            }));
        });

        page.on('requestfinished', (request) => {
            void this.recordRequest(page, pageKey, request);
        });
        page.on('requestfailed', (request) => {
            this.record(this.networkBuffer, NETWORK_BUFFER_MAX, page, pageKey, () => ({
                method: request.method(),
                url: sanitizeUrl(request.url(), this.originPolicy),
                status: null,
                resourceType: request.resourceType(),
                failure: (request.failure() || {}).errorText || 'failed',
                at: new Date().toISOString(),
            }));
        });

        // Refs are valid only within the snapshot that produced them, and a
        // navigation is the clearest possible invalidation: the elements they
        // named no longer exist. Bumping the generation is what turns a
        // post-navigation ref into `stale_ref` instead of a mystery.
        page.on('framenavigated', (frame) => {
            if (frame === page.mainFrame()) this.refGeneration += 1;
        });
    }

    async recordRequest (page, pageKey, request) {
        let status = null;
        try {
            const response = await request.response();
            status = response ? response.status() : null;
        } catch { /* response may be gone */ }
        this.record(this.networkBuffer, NETWORK_BUFFER_MAX, page, pageKey, () => ({
            method: request.method(),
            url: sanitizeUrl(request.url(), this.originPolicy),
            status,
            resourceType: request.resourceType(),
            failure: null,
            at: new Date().toISOString(),
        }));
    }

    /**
     * Append one entry, built (and sanitised) by `build`, tagged with its
     * page's key and the tier the page was in when it was recorded.
     *
     * Built inside a try because this runs in a Playwright event listener:
     * a throw here must cost this ONE entry, never the listener or the
     * process — and an entry that could not be built is dropped rather than
     * stored half-sanitised.
     */
    record (buffer, max, page, pageKey, build) {
        let entry;
        let tier;
        try {
            entry = Object.freeze(build());
            tier = tierOf(page.url(), this.originPolicy);
        } catch {
            return;
        }
        push(buffer, max, { pageKey, tier, entry });
    }

    /**
     * The console entries recorded from `page`, public shape only.
     *
     * Entries recorded while that tab was ON an `idp_transit` origin are left
     * out too. `/console` already answers `origin_read_only` while the page is
     * on the IdP; without this, the same text would simply come out on the
     * first call after the redirect back. The IdP's own page text never
     * leaves; the URLs it visited still do, sanitised, through `/network`.
     */
    consoleEntries (page) {
        return this.entriesFor(this.consoleBuffer, page, (r) => r.tier !== 'idp_transit');
    }

    /** The network entries recorded from `page`, public shape only. */
    networkEntries (page) {
        return this.entriesFor(this.networkBuffer, page, () => true);
    }

    entriesFor (buffer, page, keep) {
        const key = page !== null && typeof page === 'object' ? this.pageKeys.get(page) : undefined;
        if (key === undefined) return [];
        return buffer.filter((r) => r.pageKey === key && keep(r)).map((r) => ({ ...r.entry }));
    }

    /**
     * Register the refs a fresh snapshot of `page` minted, under a new
     * generation, bound to that page and to the origin it had when read.
     */
    registerRefs (entries, page) {
        this.refGeneration += 1;
        const pageKey = this.pageKeyOf(page);
        const origin = pageOrigin(page);
        for (const entry of entries) {
            this.refs.set(entry.ref, {
                generation: this.refGeneration,
                role: entry.role,
                name: entry.name,
                isPassword: !!entry.isPassword,
                pageKey,
                origin,
            });
        }
        // Bound the history so a long session cannot grow this without limit,
        // while still remembering enough to answer `stale_ref` honestly.
        while (this.refs.size > REF_HISTORY_MAX) {
            const oldest = this.refs.keys().next();
            if (oldest.done) break;
            this.refs.delete(oldest.value);
        }
        return this.refGeneration;
    }

    /**
     * Resolve a ref to a locator, or throw the RIGHT error.
     *
     *   never issued                 -> bad_ref   ("you guessed")
     *   issued, older snapshot       -> stale_ref ("re-snapshot")
     *   issued on ANOTHER tab        -> stale_ref ("re-snapshot this one")
     *   issued, page's origin changed-> stale_ref ("re-snapshot")
     *   issued, current, gone        -> stale_ref ("the page moved under you")
     *
     * Collapsing the stale cases into the first is what makes a recoverable
     * state look like a mistake, which is why the contract names them
     * separately. The tab and origin checks run BEFORE the DOM is queried, so
     * a leftover `data-ezil-ref` on another tab is never even looked up.
     */
    async resolveRef (page, ref) {
        if (typeof ref !== 'string' || !/^e[0-9]+$/.test(ref)) {
            const err = new Error(`ref must look like 'e12', got ${JSON.stringify(ref)}`);
            err.code = 'bad_ref';
            throw err;
        }
        const known = this.refs.get(ref);
        if (!known) {
            const err = new Error(`no snapshot ever issued ref '${ref}' — call /snapshot and use a ref from it`);
            err.code = 'bad_ref';
            throw err;
        }
        if (known.generation !== this.refGeneration) {
            const err = new Error(`ref '${ref}' came from an earlier snapshot — call /snapshot again`);
            err.code = 'stale_ref';
            throw err;
        }
        const pageKey = page !== null && typeof page === 'object' ? this.pageKeys.get(page) : undefined;
        if (!known.pageKey || known.pageKey !== pageKey) {
            const err = new Error(`ref '${ref}' was minted on another tab — call /snapshot on this one`);
            err.code = 'stale_ref';
            throw err;
        }
        const origin = pageOrigin(page);
        if (known.origin === null || origin === null || known.origin !== origin) {
            const err = new Error(`ref '${ref}' predates this page's current origin — call /snapshot again`);
            err.code = 'stale_ref';
            throw err;
        }
        const locator = page.locator(`[data-ezil-ref="${ref}"]`);
        let count = 0;
        try { count = await locator.count(); } catch { count = 0; }
        if (count === 0) {
            const err = new Error(`ref '${ref}' is no longer in the page — call /snapshot again`);
            err.code = 'stale_ref';
            throw err;
        }
        return { locator: locator.first(), meta: known };
    }

    /**
     * Every value this process must never let out: what is currently in a
     * password field anywhere in the page, plus everything it has ever typed
     * into one. Read across all frames, because a login form in an iframe is
     * still a login form.
     */
    async secrets (page) {
        const found = new Set(this.typedSecrets);
        try {
            for (const frame of page.frames()) {
                try {
                    const values = await frame.evaluate(passwordValues);
                    for (const v of values) found.add(v);
                } catch { /* cross-origin or detached frame — the typed set still covers it */ }
            }
        } catch { /* a page that cannot be read contributes nothing */ }
        return [...found];
    }

    rememberSecret (value) {
        if (typeof value === 'string' && value.length > 0) this.typedSecrets.add(value);
    }

    /**
     * The secret set for the response boundary, gathered WITHOUT ever forcing
     * a connection.
     *
     * That restraint is load-bearing rather than tidy: `respond()` calls this
     * on every response, `/health` included, and a `connect()` here would make
     * a health check on a container whose Chrome is down block for the full
     * CDP connect timeout before answering "Chrome is down". When there is no
     * live connection the answer is the values this process typed, which is
     * the set that matters most anyway — it is the one a caller handed us.
     */
    async allSecrets () {
        if (!this.isConnected()) return [...this.typedSecrets];
        try {
            const page = await this.activePage();
            return await this.secrets(page);
        } catch {
            return [...this.typedSecrets];
        }
    }
}

function push (buffer, max, entry) {
    buffer.push(entry);
    while (buffer.length > max) buffer.shift();
}

/** The origin of the page's current URL, or null when it cannot be read. */
function pageOrigin (page) {
    try {
        return new URL(page.url()).origin;
    } catch {
        return null;
    }
}

function normaliseLevel (type) {
    if (type === 'warning' || type === 'warn') return 'warning';
    if (type === 'error' || type === 'assert') return 'error';
    if (type === 'info') return 'info';
    if (type === 'debug' || type === 'trace') return 'debug';
    return 'log';
}
