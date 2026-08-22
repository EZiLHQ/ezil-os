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
 * The wire is pinned by
 * `EZiL-Works: apps/api/src/routes/mcp/browser-sidecar.contract.json`.
 * `worker/src/browser-sidecar-contract.test.ts` reads that file and asserts
 * this map against it, so a rename here goes red in CI rather than in
 * production — which is the specific failure the contract exists to prevent
 * (the legacy Universe MCP shipped a client and a server that agreed on
 * nothing, with a fully green client suite).
 *
 * Every handler returns a plain payload. `server.mjs` owns serialisation, the
 * redaction pass, and the error shape — see its header for why the redaction
 * guard is in exactly one place.
 */

import { createHash } from 'node:crypto';
import { snapshotPage, pageMarkdown, containsText } from './page-scripts.mjs';
import { SIDECAR_WIRE } from './contract.mjs';

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

function fail (code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
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

export const VERBS = {
    'GET /health': async (surface) => ({
        ok: true,
        chromeConnected: surface.isConnected(),
        cdpUrl: surface.cdpUrl,
    }),

    'POST /navigate': async (surface, body) => {
        const raw = typeof body.url === 'string' ? body.url.trim() : '';
        if (!raw) throw fail('bad_request', 'navigate requires a non-empty `url`');
        let parsed;
        try {
            parsed = new URL(raw);
        } catch {
            throw fail('bad_request', `\`url\` is not a URL: ${raw}`);
        }
        if (raw !== 'about:blank' && !ALLOWED_SCHEMES.has(parsed.protocol)) {
            throw fail(
                'bad_request',
                `scheme '${parsed.protocol}' is not navigable from here — http, https and about:blank only`,
            );
        }
        const page = await surface.activePage();
        try {
            await page.goto(raw, { timeout: NAVIGATION_TIMEOUT_MS, waitUntil: 'domcontentloaded' });
        } catch (err) {
            throw fail('navigation_failed', err && err.message ? err.message : String(err));
        }
        return { ok: true, url: page.url(), title: await safeTitle(page) };
    },

    'POST /snapshot': async (surface) => {
        const page = await surface.activePage();
        const result = await withTimeout(
            page.evaluate(snapshotPage, { maxNodes: 1200 }),
            ACTION_TIMEOUT_MS,
            'snapshot',
        );
        surface.registerRefs(result.refs);
        return {
            ok: true,
            snapshot: result.truncated ? `${result.text}\n- [snapshot truncated]` : result.text,
            url: page.url(),
            title: await safeTitle(page),
        };
    },

    'POST /click': async (surface, body) => {
        const page = await surface.activePage();
        const { locator } = await surface.resolveRef(page, body.ref);
        try {
            await locator.click({ timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (/Timeout .*exceeded/i.test(message)) throw fail('timeout', message);
            throw fail('stale_ref', message);
        }
        return { ok: true, url: page.url() };
    },

    'POST /type': async (surface, body) => {
        if (typeof body.text !== 'string') throw fail('bad_request', 'type requires a string `text`');
        const page = await surface.activePage();
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
            const message = err && err.message ? err.message : String(err);
            if (/Timeout .*exceeded/i.test(message)) throw fail('timeout', message);
            throw fail('stale_ref', message);
        }

        // `redacted` tells the caller WHY there is no echo. A silent omission
        // would be a lie to an agent that is trying to confirm what it typed.
        return { ok: true, url: page.url(), redacted: !!meta.isPassword };
    },

    'POST /get_text': async (surface, body) => {
        const page = await surface.activePage();
        let rootRef = null;
        if (body.ref !== undefined && body.ref !== null) {
            await surface.resolveRef(page, body.ref);
            rootRef = body.ref;
        }
        const markdown = await withTimeout(
            page.evaluate(pageMarkdown, { rootRef, maxChars: 40_000 }),
            ACTION_TIMEOUT_MS,
            'get_text',
        );
        return { ok: true, markdown, url: page.url() };
    },

    'POST /screenshot': async (surface, body) => {
        const page = await surface.activePage();
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

        let buffer;
        try {
            if (body.ref !== undefined && body.ref !== null) {
                const { locator } = await surface.resolveRef(page, body.ref);
                buffer = await locator.screenshot(options);
            } else {
                buffer = await page.screenshot({ ...options, fullPage });
            }
        } catch (err) {
            const message = err && err.message ? err.message : String(err);
            if (/Timeout .*exceeded/i.test(message)) throw fail('timeout', message);
            throw fail('chrome_unreachable', message);
        }

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

    'POST /console': async (surface, body) => {
        const level = body.level === undefined || body.level === null ? null : String(body.level).toLowerCase();
        if (level !== null && !['log', 'debug', 'info', 'warning', 'error'].includes(level)) {
            throw fail('bad_request', `unknown console level '${level}' — log, debug, info, warning or error`);
        }
        // Attach to whatever is open so a caller that asks for console output
        // before any other verb still gets a live buffer from here on.
        await surface.activePage().catch(() => null);
        const entries = level ? surface.consoleBuffer.filter((e) => e.level === level) : surface.consoleBuffer;
        return { ok: true, entries: entries.slice() };
    },

    'POST /network': async (surface, body) => {
        const filter = body.filter === undefined || body.filter === null ? null : String(body.filter);
        await surface.activePage().catch(() => null);
        const requests = filter
            ? surface.networkBuffer.filter((r) => r.url.includes(filter))
            : surface.networkBuffer;
        return { ok: true, requests: requests.slice() };
    },

    'POST /wait_for': async (surface, body) => {
        const hasText = typeof body.text === 'string' && body.text.length > 0;
        const hasTime = typeof body.time === 'number' && Number.isFinite(body.time) && body.time > 0;
        if (!hasText && !hasTime) throw fail('bad_request', 'wait_for requires `text` or `time`');

        if (!hasText) {
            const seconds = Math.min(body.time, WAIT_FOR_MAX_SECONDS);
            await new Promise((r) => setTimeout(r, seconds * 1000));
            return { ok: true, matched: true };
        }

        const budgetMs = Math.min(hasTime ? body.time : 10, WAIT_FOR_MAX_SECONDS) * 1000;
        const deadline = Date.now() + budgetMs;
        // Polls rather than using a page predicate so that a navigation
        // mid-wait cannot destroy the wait itself — a page that reloads under
        // us just makes the next poll answer for the new document.
        while (Date.now() < deadline) {
            try {
                const page = await surface.activePage();
                const found = await page.evaluate(containsText, body.text);
                if (found) return { ok: true, matched: true };
            } catch { /* mid-navigation; poll again */ }
            await new Promise((r) => setTimeout(r, 250));
        }
        return { ok: true, matched: false };
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
