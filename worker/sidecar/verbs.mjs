/**
 * The verb set. This IS the surface.
 *
 * 🔴 THERE IS NO PASSTHROUGH VERB, AND NONE MAY BE ADDED.
 * Not `evaluate`, not `raw`, not `send`, not "just this one CDP command".
 * CDP is unauthenticated and total: whoever can send it arbitrary commands
 * reads every page, exfiltrates the profile's cookies, and runs arbitrary JS
 * in any origin the browser has ever been logged into. The entire value of
 * this process is that what is reachable from outside the container is the map
 * below and nothing else. A passthrough verb does not extend the sidecar — it
 * deletes its reason to exist, and the CDP port might as well have been bound
 * to 0.0.0.0 in the first place.
 *
 * The v1 wire is pinned by
 * `EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`; v2 is
 * additive and its authority is `contract.mjs` plus
 * `docs/contracts/browser-verbs-v2.md`. `worker/src/browser-sidecar-contract.test.ts`
 * asserts the pinned v1 JSON is contained in `contract.mjs`, and the load-time
 * check at the bottom of this file asserts this map serves exactly that
 * declaration, so a rename here goes red in CI rather than in production.
 *
 * Every handler returns a plain payload. `server.mjs` owns serialisation, the
 * redaction pass, and the error shape — see its header for why the redaction
 * guard is in exactly one place.
 *
 * ── v2: the tier gate ───────────────────────────────────────────────────────
 * Handlers are `(surface, body, opts = {})`. Before a handler touches a page it
 * reads that page's origin tier (`origin-policy.mjs`) and refuses with
 * `origin_read_only` when the tier does not allow the route, or when the
 * caller's `opts.denyTiers` (a Set of tier names) contains it. `GET /health`
 * acts on no page and is never gated. The Code loopback passes
 * `{ denyTiers: new Set(['owner_app', 'idp_transit']) }`; the Worker path
 * passes nothing.
 *
 * Reads (`snapshot`, `get_text`, `screenshot`, `wait_for{text}`) check AGAIN
 * after reading: a page that navigated onto the IdP while it was being read
 * yields `origin_read_only`, not the IdP's content. Actions (`click`, `type`,
 * `fill_form`, `select`, `scroll`, `press`) may land on any tier; what they
 * return is the sanitised `url`.
 *
 * Every `url` member leaves through `sanitizeUrl`.
 */

import { createHash } from 'node:crypto';
import {
    containsText, fieldState, pageMarkdown, scrollWindowBy, selectState, snapshotPage, windowScrollY,
} from './page-scripts.mjs';
import {
    FIELD_VALUE_MAX_CHARS, FILL_FORM_MAX_FIELDS, ORIGIN_TIERS, PRESS_KEYS, SCROLL_MAX_DY, SELECT_MAX_VALUES,
    SIDECAR_WIRE,
} from './contract.mjs';
import { routeAllowedOnTier, sanitizeUrl, tierOf } from './origin-policy.mjs';

/** Default per-verb budget. Deliberately short: an agent waiting on a hung
 *  page is worse than an agent told to try again. */
const ACTION_TIMEOUT_MS = 15_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
/** Ceiling for `/wait_for`'s `time`, in seconds. */
const WAIT_FOR_MAX_SECONDS = 30;

/**
 * URL schemes `/navigate` accepts.
 *
 * 🔴 `javascript:` is arbitrary script execution — it is the passthrough verb
 * wearing a different hat, and allowing it would undo everything above.
 * `data:` can carry a whole HTML document with inline script, so it is the
 * same hole. `file:` would turn the browser into a filesystem read primitive
 * for the container (the desktop's own landing page is a file:// URL, which is
 * exactly why this is worth stating: the browser CAN load them, we decline to
 * be the thing that asks it to). `chrome:`/`devtools:` reach privileged UI.
 * What is left is the web, plus `about:blank` for "put this tab back".
 */
const ALLOWED_SCHEMES = new Set(['http:', 'https:']);

const NO_DENIED_TIERS = new Set();

function fail (code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
}

function messageOf (err) {
    return err && err.message ? err.message : String(err);
}

function isTimeout (err) {
    return /Timeout .*exceeded/i.test(messageOf(err));
}

/** v1's mapping for an action on a ref'd element: timeout, else stale_ref. */
function refActionFailure (err) {
    return fail(isTimeout(err) ? 'timeout' : 'stale_ref', messageOf(err));
}

/** Wrap any promise in a budget, reported as the contract's `timeout` code. */
async function withTimeout (promise, ms, what) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(fail('timeout', `${what} did not finish within ${ms}ms`)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/** PNG dimensions straight out of the IHDR chunk — no image library needed. */
export function pngDimensions (buffer) {
    if (!buffer || buffer.length < 24) return { width: 0, height: 0 };
    if (buffer.readUInt32BE(0) !== 0x89504e47) return { width: 0, height: 0 };
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/** Every password field on the page, as one locator, for screenshot masking. */
function passwordMask (page) {
    return [page.locator('input[type=password]')];
}

/**
 * `opts.denyTiers`: absent means none. Anything present must be a Set of real
 * tier names — a typo such as `'owner-app'` would otherwise deny nothing, so
 * it throws (no contract code: the server answers `chrome_unreachable` and
 * nothing is touched).
 */
function deniedTiers (opts) {
    const deny = opts ? opts.denyTiers : undefined;
    if (deny === undefined || deny === null) return NO_DENIED_TIERS;
    if (!(deny instanceof Set) || [...deny].some((t) => !ORIGIN_TIERS.includes(t))) {
        throw new TypeError(`opts.denyTiers must be a Set of: ${ORIGIN_TIERS.join(', ')}`);
    }
    return deny;
}

/**
 * 🔴 THE TIER GATE. Throws `origin_read_only` unless `route` may act on `page`
 * as it is right now. No URL goes into the message: messages reach the log.
 */
function assertTierAllows (surface, page, route, body, opts) {
    const deny = deniedTiers(opts);
    const tier = tierOf(page.url(), surface.originPolicy);
    if (!routeAllowedOnTier(route, tier, body) || deny.has(tier)) {
        throw fail('origin_read_only', `${route} is not available while the active page is ${tier}`);
    }
    return tier;
}

/** The page a verb acts on, after the tier gate has let it through. */
async function actingPage (surface, route, body, opts) {
    const page = await surface.activePage();
    assertTierAllows(surface, page, route, body, opts);
    return page;
}

/** A page's URL as it may leave this process. */
function urlOf (surface, page) {
    return sanitizeUrl(page.url(), surface.originPolicy);
}

function present (value) {
    return value !== undefined && value !== null;
}

/** `/fill_form`'s `fields`: 1..FILL_FORM_MAX_FIELDS of `{ref, value}`. */
function fillFormFields (fields) {
    if (!Array.isArray(fields) || fields.length < 1 || fields.length > FILL_FORM_MAX_FIELDS) {
        throw fail('bad_request', `fill_form requires \`fields\`: 1 to ${FILL_FORM_MAX_FIELDS} of {ref, value}`);
    }
    return fields.map((field) => {
        if (field === null || typeof field !== 'object' || Array.isArray(field)) {
            throw fail('bad_request', 'every fill_form field is an object {ref, value}');
        }
        if (typeof field.value !== 'string' || field.value.length > FIELD_VALUE_MAX_CHARS) {
            throw fail('bad_request', `every fill_form \`value\` is a string of at most ${FIELD_VALUE_MAX_CHARS} characters`);
        }
        return { ref: field.ref, value: field.value };
    });
}

/** `/select`'s `values`: 1..SELECT_MAX_VALUES strings. */
function selectValues (values) {
    if (!Array.isArray(values) || values.length < 1 || values.length > SELECT_MAX_VALUES
        || !values.every((v) => typeof v === 'string')) {
        throw fail('bad_request', `select requires \`values\`: 1 to ${SELECT_MAX_VALUES} option labels or values`);
    }
    return values.slice();
}

export const VERBS = {
    'GET /health': async (surface) => ({
        ok: true,
        chromeConnected: surface.isConnected(),
        cdpUrl: surface.cdpUrl,
    }),

    'POST /navigate': async (surface, body = {}, opts = {}) => {
        const raw = typeof body.url === 'string' ? body.url.trim() : '';
        if (!raw) throw fail('bad_request', 'navigate requires a non-empty `url`');
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            throw fail('bad_request', '`url` is not a URL');
        }
        if (raw !== 'about:blank' && !ALLOWED_SCHEMES.has(parsed.protocol)) {
            throw fail(
                'bad_request',
                `scheme '${parsed.protocol}' is not navigable from here — http, https and about:blank only`,
            );
        }
        const page = await actingPage(surface, 'POST /navigate', body, opts);
        try {
            await page.goto(raw, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        } catch (err) {
            throw fail('navigation_failed', messageOf(err));
        }
        return { ok: true, url: urlOf(surface, page), title: await safeTitle(page) };
    },

    'POST /snapshot': async (surface, body = {}, opts = {}) => {
        const page = await actingPage(surface, 'POST /snapshot', body, opts);
        const result = await withTimeout(
            page.evaluate(snapshotPage, { maxNodes: 1200 }),
            ACTION_TIMEOUT_MS,
            'snapshot',
        );
        // Read again BEFORE any ref is registered: a tree read off a page that
        // has just navigated onto the IdP is the IdP's tree.
        assertTierAllows(surface, page, 'POST /snapshot', body, opts);
        surface.registerRefs(result.refs, page);
        return {
            ok: true,
            snapshot: result.truncated ? `${result.text}\n- [snapshot truncated]` : result.text,
            url: urlOf(surface, page),
            title: await safeTitle(page),
        };
    },

    'POST /click': async (surface, body = {}, opts = {}) => {
        const page = await actingPage(surface, 'POST /click', body, opts);
        const { locator } = await surface.resolveRef(page, body.ref);
        try {
            await locator.click({ timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            throw refActionFailure(err);
        }
        return { ok: true, url: urlOf(surface, page) };
    },

    'POST /type': async (surface, body = {}, opts = {}) => {
        if (typeof body.text !== 'string') throw fail('bad_request', 'type requires a string `text`');
        const page = await actingPage(surface, 'POST /type', body, opts);
        const { locator, meta } = await surface.resolveRef(page, body.ref);

        // Remembered BEFORE the keystrokes land, so that even a failure
        // partway through leaves the value inside the redaction set. The
        // secret is never in the response either way; this is what keeps it
        // out of the ERROR detail too.
        if (meta.isPassword) surface.rememberSecret(body.text);

        try {
            await locator.fill(body.text, { timeout: ACTION_TIMEOUT_MS });
            if (body.submit === true) {
                await locator.press('Enter', { timeout: ACTION_TIMEOUT_MS });
                await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS })
                    .catch(() => { /* a submit that does not navigate is normal */ });
            }
        } catch (err) {
            throw refActionFailure(err);
        }

        // `redacted` tells the caller WHY there is no echo. A silent omission
        // would be a lie to an agent that is trying to confirm what it typed.
        return { ok: true, url: urlOf(surface, page), redacted: !!meta.isPassword };
    },

    'POST /get_text': async (surface, body = {}, opts = {}) => {
        const page = await actingPage(surface, 'POST /get_text', body, opts);
        let rootRef = null;
        if (present(body.ref)) {
            await surface.resolveRef(page, body.ref);
            rootRef = body.ref;
        }
        const markdown = await withTimeout(
            page.evaluate(pageMarkdown, { rootRef, maxChars: 40_000 }),
            ACTION_TIMEOUT_MS,
            'get_text',
        );
        assertTierAllows(surface, page, 'POST /get_text', body, opts);
        return { ok: true, markdown, url: urlOf(surface, page) };
    },

    'POST /screenshot': async (surface, body = {}, opts = {}) => {
        const page = await actingPage(surface, 'POST /screenshot', body, opts);
        const fullPage = body.fullPage === true;

        // 🔴 The screenshot half of the redaction rule. A password field is
        // masked in EVERY capture, not only when it happens to hold focus:
        // "focused" is a property of the moment the shutter opens and nothing
        // here can promise which moment that is. Masking all of them is the
        // superset, and it is what makes the proof possible — a 4-character
        // password and a 20-character one must produce BYTE-IDENTICAL PNGs,
        // because a masked box is the same box while unmasked dots are not.
        const options = {
            type: 'png',
            timeout: ACTION_TIMEOUT_MS,
            mask: passwordMask(page),
            maskColor: '#000000',
            // `animations: 'disabled'` keeps repeated captures comparable; it
            // does not change layout.
            animations: 'disabled',
        };

        // Resolved OUTSIDE the capture's try: a bad or stale ref keeps its own
        // code instead of being reported as an unreachable browser.
        const target = present(body.ref) ? (await surface.resolveRef(page, body.ref)).locator : null;

        let buffer;
        try {
            buffer = target ? await target.screenshot(options) : await page.screenshot({ ...options, fullPage });
        } catch (err) {
            throw fail(isTimeout(err) ? 'timeout' : 'chrome_unreachable', messageOf(err));
        }
        assertTierAllows(surface, page, 'POST /screenshot', body, opts);

        // 🔴 The digest is computed HERE, over the bytes as produced, and
        // travels with them. It becomes `evidence_artifacts.content_sha256`
        // unchanged. A digest supplied by the caller is the caller's word for
        // what it captured, which is precisely the property that separates an
        // artefact that is evidence from a file that is merely attached.
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        const { width, height } = pngDimensions(buffer);
        return {
            ok: true,
            pngBase64: buffer.toString('base64'),
            sha256,
            byteSize: buffer.length,
            width,
            height,
        };
    },

    'POST /console': async (surface, body = {}, opts = {}) => {
        const level = present(body.level) ? String(body.level).toLowerCase() : null;
        if (level !== null && !['log', 'debug', 'info', 'warning', 'error'].includes(level)) {
            throw fail('bad_request', 'unknown console level — log, debug, info, warning or error');
        }
        // Only what the ACTIVE page logged: other tabs and contexts are never
        // reported (`BrowserSurface.consoleEntries`).
        const page = await actingPage(surface, 'POST /console', body, opts);
        const entries = surface.consoleEntries(page);
        return { ok: true, entries: level ? entries.filter((e) => e.level === level) : entries };
    },

    'POST /network': async (surface, body = {}, opts = {}) => {
        const filter = present(body.filter) ? String(body.filter) : null;
        const page = await actingPage(surface, 'POST /network', body, opts);
        const requests = surface.networkEntries(page);
        return { ok: true, requests: filter ? requests.filter((r) => r.url.includes(filter)) : requests };
    },

    'POST /wait_for': async (surface, body = {}, opts = {}) => {
        const hasText = typeof body.text === 'string' && body.text.length > 0;
        const hasTime = typeof body.time === 'number' && Number.isFinite(body.time) && body.time > 0;
        if (!hasText && !hasTime) throw fail('bad_request', 'wait_for requires `text` or `time`');
        await actingPage(surface, 'POST /wait_for', body, opts);

        if (!hasText) {
            const seconds = Math.min(body.time, WAIT_FOR_MAX_SECONDS);
            await new Promise((r) => setTimeout(r, seconds * 1000));
            return { ok: true, matched: true };
        }

        const budgetMs = Math.min(hasTime ? body.time : 10, WAIT_FOR_MAX_SECONDS) * 1000;
        const deadline = Date.now() + budgetMs;
        // Polls rather than using a page predicate so that a navigation
        // mid-wait cannot destroy the wait itself — a page that reloads under
        // us just makes the next poll answer for the new document. Every poll
        // reads the page, so every poll passes the tier gate first, and a
        // match is re-checked against the page it came from: "is this text on
        // the IdP page" is a question this verb does not answer.
        while (Date.now() < deadline) {
            let page = null;
            try {
                page = await surface.activePage();
            } catch { /* a reconnect in progress; poll again */ }
            if (page) {
                assertTierAllows(surface, page, 'POST /wait_for', body, opts);
                let found = false;
                try {
                    found = await page.evaluate(containsText, body.text);
                } catch { /* mid-navigation; poll again */ }
                if (found === true) {
                    assertTierAllows(surface, page, 'POST /wait_for', body, opts);
                    return { ok: true, matched: true };
                }
            }
            await new Promise((r) => setTimeout(r, 250));
        }
        return { ok: true, matched: false };
    },

    // ── v2 (additive) ───────────────────────────────────────────────────────

    'POST /fill_form': async (surface, body = {}, opts = {}) => {
        const fields = fillFormFields(body.fields);
        const page = await actingPage(surface, 'POST /fill_form', body, opts);

        // 1. EVERY ref resolves before any field is touched: one bad or stale
        //    ref fills nothing.
        const targets = [];
        for (const field of fields) {
            const { locator, meta } = await surface.resolveRef(page, field.ref);
            targets.push({ locator, meta, value: field.value, isPassword: !!meta.isPassword });
        }
        // 2. …and every element can take a value right now. A button,
        //    checkbox, `<select>`, disabled or readonly control is `bad_ref`
        //    here, still before anything is filled.
        for (const target of targets) {
            let state;
            try {
                state = await target.locator.evaluate(fieldState, undefined, { timeout: ACTION_TIMEOUT_MS });
            } catch (err) {
                throw refActionFailure(err);
            }
            if (!state || state.fillable !== true) {
                throw fail('bad_ref', 'fill_form: a ref names an element that cannot be filled — use /select or /click');
            }
            if (state.isPassword === true) target.isPassword = true;
        }
        // 3. Every password value joins the redaction set BEFORE the first
        //    keystroke, exactly like `/type`, so a failure partway through
        //    cannot carry one out in an error.
        let redacted = 0;
        for (const target of targets) {
            if (!target.isPassword) continue;
            surface.rememberSecret(target.value);
            redacted += 1;
        }
        // 4. Fill.
        let filled = 0;
        for (const target of targets) {
            try {
                await target.locator.fill(target.value, { timeout: ACTION_TIMEOUT_MS });
            } catch (err) {
                throw refActionFailure(err);
            }
            filled += 1;
        }
        return { ok: true, url: urlOf(surface, page), filled, redacted };
    },

    'POST /select': async (surface, body = {}, opts = {}) => {
        const values = selectValues(body.values);
        const page = await actingPage(surface, 'POST /select', body, opts);
        const { locator, meta } = await surface.resolveRef(page, body.ref);
        if (meta.role !== 'combobox' && meta.role !== 'listbox') {
            throw fail('bad_ref', 'select needs a combobox or listbox ref');
        }
        let state;
        try {
            state = await locator.evaluate(selectState, values, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            throw refActionFailure(err);
        }
        if (!state || state.isSelect !== true) throw fail('bad_ref', 'select needs a <select> element');
        if (state.unmatched !== 0) throw fail('bad_request', 'select: a value matches no option label or value');
        let selected;
        try {
            selected = await locator.selectOption(values, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            throw refActionFailure(err);
        }
        return { ok: true, url: urlOf(surface, page), selected: Array.isArray(selected) ? selected.map(String) : [] };
    },

    'POST /scroll': async (surface, body = {}, opts = {}) => {
        const hasRef = present(body.ref);
        const hasDy = present(body.dy);
        if (hasRef === hasDy) throw fail('bad_request', 'scroll takes exactly one of `ref` or `dy`');
        if (hasDy && (!Number.isInteger(body.dy) || Math.abs(body.dy) > SCROLL_MAX_DY)) {
            throw fail('bad_request', `\`dy\` is an integer between -${SCROLL_MAX_DY} and ${SCROLL_MAX_DY}`);
        }
        const dy = hasDy ? body.dy : 0;
        const page = await actingPage(surface, 'POST /scroll', body, opts);
        let scrollY;
        if (hasRef) {
            const { locator } = await surface.resolveRef(page, body.ref);
            try {
                await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
            } catch (err) {
                throw refActionFailure(err);
            }
            scrollY = await withTimeout(page.evaluate(windowScrollY), ACTION_TIMEOUT_MS, 'scroll');
        } else {
            scrollY = await withTimeout(page.evaluate(scrollWindowBy, dy), ACTION_TIMEOUT_MS, 'scroll');
        }
        return { ok: true, url: urlOf(surface, page), scrollY: Number.isFinite(scrollY) ? scrollY : 0 };
    },

    'POST /press': async (surface, body = {}, opts = {}) => {
        // The key that reaches Playwright is the CONSTANT from the list, never
        // the request's string — an exact match or nothing.
        const key = PRESS_KEYS.find((k) => k === body.key);
        if (key === undefined) throw fail('bad_request', `press takes exactly one key of: ${PRESS_KEYS.join(', ')}`);
        const page = await actingPage(surface, 'POST /press', body, opts);
        if (present(body.ref)) {
            const { locator } = await surface.resolveRef(page, body.ref);
            try {
                await locator.press(key, { timeout: ACTION_TIMEOUT_MS });
            } catch (err) {
                throw refActionFailure(err);
            }
        } else {
            try {
                await page.keyboard.press(key);
            } catch (err) {
                throw fail(isTimeout(err) ? 'timeout' : 'chrome_unreachable', messageOf(err));
            }
        }
        if (key === 'Enter') {
            await page.waitForLoadState('domcontentloaded', { timeout: NAVIGATION_TIMEOUT_MS })
                .catch(() => { /* an Enter that does not navigate is normal */ });
        }
        return { ok: true, url: urlOf(surface, page) };
    },
};

async function safeTitle (page) {
    try {
        return await page.title();
    } catch {
        return '';
    }
}

/**
 * Load-time conformance: the routes this file serves and the routes this side
 * declares must be the SAME SET, or the process refuses to start.
 *
 * A server that has drifted from its own declaration is worse than one that is
 * down, because it answers — with the wrong wire, to a consumer in another
 * repository that cannot see this code. Failing at import is the cheapest
 * possible place to find that out; `worker/src/browser-sidecar-contract.test.ts`
 * then closes the loop by checking the declaration against the pinned JSON.
 */
{
    const served = Object.keys(VERBS).sort();
    const declared = Object.keys(SIDECAR_WIRE).sort();
    const missing = declared.filter((r) => !served.includes(r));
    const extra = served.filter((r) => !declared.includes(r));
    if (missing.length > 0 || extra.length > 0) {
        throw new Error(
            '[ezil-sidecar] route set does not match contract.mjs — '
            + `missing: [${missing.join(', ')}], undeclared: [${extra.join(', ')}]`,
        );
    }
}
