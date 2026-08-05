// overlay-paint-browser-test.mjs — EZiL-authored. REAL-BROWSER paint-order
// test for the Code and Preview windows' overlay panels, both directions.
//
// Run:  node shell/ezil/apps/overlay-paint-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle)
//
// Requires `playwright` (with a Chromium build) to be resolvable from this
// file's location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR —
// same convention as `shell/ezil/ui/Settings/stacking-browser-test.mjs`. Not
// a project dependency. If neither resolves, this exits 2 (skip), never 0.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE GAP THIS FILE CLOSES
// ═══════════════════════════════════════════════════════════════════════════
// Commit 88ba01f fixed a real defect: `code.js` and `preview.js` built their
// "isn't available yet" panel with `el.hidden = true` immediately followed by
// an inline `Object.assign(style, {display:'flex', background:'#fff', ...})`.
// An inline `display` beats the UA's `[hidden] { display: none }`, so
// `hidden = true` hid nothing — the panel painted opaque white over the whole
// window body PERMANENTLY, masked during boot only because `.ezil-boot`
// (z-index 2) sat on top of it, and revealed the moment the boot panel
// retired ON SUCCESS — a working iframe, permanently covered by a failure
// page, on every successful open. That commit's own message says exactly
// what was still missing:
//
//   "The success-path assertion (getComputedStyle(overlay).display === 'none')
//    is still owed."
//
// `code-test.mjs` (this task's sibling file, line 324) and
// `preview-focus-test.mjs` (line 343) both assert ONLY the unavailable
// direction, and both use `textContent` as the oracle — which is blind to
// CSS — under jsdom, which has no cascade for `[hidden]` vs. an inline
// `style.display` the way a real UA does. Both files were green THROUGHOUT
// the six rounds this defect survived. This file is the missing assertion,
// in a real browser, both directions:
//
//   SUCCESS   — `getComputedStyle(overlay).display === 'none'` for BOTH
//               overlays (`.ezil-boot` and `.ezil-{code,preview}-unavailable`),
//               AND `document.elementFromPoint()` at the window body's centre
//               returns the IFRAME, not an overlay.
//   FAILURE   — (refused frame, and "not available") the relevant overlay is
//               NOT `display: none`, hit-tests as ON TOP at that same point,
//               and is actually readable (non-empty rendered text, non-zero
//               rect) — an honest failure state must keep working. Fixing the
//               success direction by making failure silently invisible too
//               would be the exact inversion this project has already made
//               once (a frame-honesty pin that turned a healthy frame into a
//               permanent false negative — see `preview.js`'s own header).
//
// Deliberately NOT jsdom: `getComputedStyle` cascade resolution for `[hidden]`
// vs. an author `display` declaration, AND `elementFromPoint` hit-testing,
// both depend on a real layout/paint engine that jsdom does not have (jsdom's
// `elementFromPoint` is unimplemented and its style cascade does not reliably
// reflect specificity the way a UA does). This is why `stacking-browser-test.
// mjs` exists for z-order and why this file exists for `[hidden]` vs. inline
// `display` — same root cause (jsdom has no cascade/paint model), two
// different symptoms.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUTATION-PROVEN — see the wave-d2-t14-overlay-test report for the actual
// runs. Reintroducing 88ba01f's exact inline `Object.assign(el_unavailable.
// style, {display:'flex', ...})` in a SCRATCH copy of `code.js`/`preview.js`
// (never the real files — this task may not edit them), rebuilt into a
// scratch `app/public/os`-shaped directory and pointed at via
// `EZIL_OS_DIR=<scratch>/app/public/os`, turns the SUCCESS-direction checks
// in this file red (the "not available" panel stays visibly painted over the
// confirmed iframe) while every other check (including the FAILURE-direction
// ones) stays green — proving this harness actually discriminates the bug
// rather than merely running. Restoring `EZIL_OS_DIR` to the real build turns
// it green again.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY registry.launch(), not the Start menu, is enough here
// ═══════════════════════════════════════════════════════════════════════════
// Reachability (Start menu, single-instance, TTL-remint, frame-honesty
// wiring) is already covered end-to-end by `code-test.mjs` and
// `preview-focus-test.mjs`. This file's entire job is the one thing neither
// of those harnesses CAN see — what is actually PAINTED, pixel-for-pixel, in
// a real browser — so it drives the window open via the same programmatic
// path they already proved is equivalent to a real click, and spends its
// entire budget on the paint assertion itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// 🔴 Overridable for the mutation-proof (see header): point this at a scratch
// `app/public/os`-shaped directory built from a deliberately-reverted
// code.js/preview.js WITHOUT ever touching the real committed bundle or the
// real source files this task may not edit.
const OS = process.env.EZIL_OS_DIR
    ? path.resolve(process.env.EZIL_OS_DIR)
    : path.resolve(here, '../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first (or check EZIL_OS_DIR)`);
        process.exit(2);
    }
}

// ── resolve playwright without making it a project dependency ──────────────
let chromium;
try {
    ({ chromium } = await import('playwright'));
} catch {
    const dir = process.env.PLAYWRIGHT_REQUIRE_DIR;
    if ( dir ) {
        try {
            const req = createRequire(path.join(path.resolve(dir), 'noop.js'));
            ({ chromium } = req('playwright'));
        } catch ( e2 ) {
            console.error(`playwright not found via PLAYWRIGHT_REQUIRE_DIR=${dir}: ${e2?.message ?? e2}`);
        }
    }
}
if ( ! chromium ) {
    console.error(
        'playwright is not resolvable from this file or $PLAYWRIGHT_REQUIRE_DIR. '
        + 'This is a REAL-BROWSER test — jsdom cannot resolve the [hidden]-vs-inline-style '
        + 'cascade or hit-test paint order (see header). Install playwright (e.g. '
        + '`bunx playwright@1.62.1 install chromium` in some directory and set '
        + 'PLAYWRIGHT_REQUIRE_DIR to it) and re-run. Skipping, not passing.',
    );
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const HOST = 'https://ezil-overlay-paint-test.invalid';
const HOST_HOSTNAME = new URL(HOST).hostname;
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>
     <body class="min-h-full flex flex-col"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;

const COMPUTER = {
    id: 'c-1', name: 'My computer', slot: 1,
    createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    codePreviewUrl: '/api/shell/code-preview-url',
    focus: '/api/shell/focus',
};
const PAYLOAD = {
    user: { id: 'u-1', email: 'someone@example.com' },
    computer: COMPUTER,
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true,
        status: 'idle', endpoints: ENDPOINTS,
    },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// The two apps under test. Structurally identical windows (code.js and
// preview.js mirror each other byte-for-byte in this area — confirmed by
// reading both files), differing only in endpoint, field name, iframe class
// and the mint URL. No literal per-app branching below this table.
// ═══════════════════════════════════════════════════════════════════════════
const APPS = [
    {
        id: 'code',
        mintPath: ENDPOINTS.codePreviewUrl,
        urlField: 'codePreviewUrl',
        unavailableErrorCode: 'code_preview_unavailable',
        unavailableClass: 'ezil-code-unavailable',
        mintedUrl: 'about:blank?code-frame=1',
        unavailableText: /isn.t available yet/i,
    },
    {
        id: 'preview',
        mintPath: ENDPOINTS.previewUrl,
        urlField: 'appPreviewUrl',
        unavailableErrorCode: 'app_preview_unavailable',
        unavailableClass: 'ezil-preview-unavailable',
        mintedUrl: 'about:blank?preview-frame=1',
        unavailableText: /isn.t available yet/i,
    },
];

const browser = await chromium.launch();
let anyHardFailure = false;

for ( const app of APPS ) {
    try {
        await testApp(app);
    } catch ( err ) {
        anyHardFailure = true;
        push(`[${app.id}] harness threw without completing`, false, String(err?.stack ?? err));
    }
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length || anyHardFailure ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
    process.exit(1);
}
process.exit(0);

// ═══════════════════════════════════════════════════════════════════════════
// Everything below is scoped to one app's run.
// ═══════════════════════════════════════════════════════════════════════════
async function testApp (app) {
    const L = `[${app.id}]`;
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
        if ( msg.type() !== 'error' ) return;
        if ( /Failed to load resource.*404/.test(msg.text()) ) return;
        // 🔴 NOT a bug: this is `code.js`/`preview.js`'s own honest
        // `console.error` when Direction B (this file) deliberately makes
        // the server refuse the frame — the exact log line the file header
        // of both source files documents as the CORRECT reaction. Filtering
        // it is not "ignoring an error" — Direction B's own assertions above
        // already require the refusal to be visibly, honestly surfaced in
        // the UI; this just stops that same expected message from also
        // failing the "no uncaught errors" guard meant for GENUINE bugs.
        if ( /the (code|preview) frame is not answering \(confirmFrame -> false\)/.test(msg.text()) ) return;
        page_errors.push(msg.text());
    });

    // ── mutable stub state, driven per-scenario ─────────────────────────────
    let mintMode = 'ok';      // 'ok' | 'unavailable'
    let confirmAnswer = true; // what `confirm=frame` answers next

    const stub = (url, method) => {
        if ( url.includes(app.mintPath) && method === 'POST' ) {
            if ( mintMode === 'unavailable' ) {
                return { ok: false, errorCode: app.unavailableErrorCode, error: 'no port' };
            }
            return { ok: true, [app.urlField]: app.mintedUrl, expiresAt: Date.now() + 300_000 };
        }
        if ( url.includes('confirm=frame') ) {
            return { ok: true, confirmed: confirmAnswer, status: confirmAnswer ? 200 : 500 };
        }
        if ( url.includes(ENDPOINTS.desktop) ) {
            if ( method === 'POST' ) return { ok: true, guacamoleUrl: 'about:blank?desktop-frame=1', frame: { confirmed: true } };
            return { ok: true, guacamoleRunning: true };
        }
        if ( url.includes(ENDPOINTS.focus) ) return { ok: true };
        return { ok: true };
    };

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if ( url === `${HOST}/os` ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
            return;
        }
        if ( url.includes('/api/') ) {
            const body = stub(url, req.method());
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            return;
        }
        if ( new URL(url).hostname === HOST_HOSTNAME ) {
            await route.fulfill({ status: 404, body: '' });
            return;
        }
        await route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });

    push(`${L} bundle exposes window.ezil`, !! (await page.evaluate(() => typeof window.ezil === 'object')));
    // 🔴 Block body, no implicit return: `boot()`'s return value (`shell`)
    // carries references the removed-backend `puter` compatibility shim
    // intercepts on property access, which Playwright's structured-clone
    // serializer cannot handle. Nothing here needs that return value.
    await page.evaluate(() => { window.ezil.boot(); });
    await until(() => !! document.querySelector('.desktop'));

    /** Poll a page-side predicate until true or timeout. `fn` is serialized
     * into the page, so (like `stacking-browser-test.mjs`) it cannot close
     * over Node-side variables — everything it needs travels through `arg`. */
    async function until (fn, arg, ms = 6000, step = 40) {
        const deadline = Date.now() + ms;
        for ( ;; ) {
            const v = await page.evaluate(fn, arg);
            if ( v ) return v;
            if ( Date.now() > deadline ) return null;
            await sleep(step);
        }
    }

    /**
     * The single measurement this whole file exists for. Runs entirely
     * inside the page in one round trip (no stale coordinates from a
     * layout shift between reads): finds the window, computes the ACTUAL
     * on-screen centre of its `.window-body`, and asks the browser's own
     * paint engine — `document.elementFromPoint` — what is really on top
     * there, alongside `getComputedStyle` for both overlays.
     */
    async function measure (a) {
        return page.evaluate((appId) => {
            const win = document.querySelector(`.window[data-app="${appId}"]`);
            if ( ! win ) return { windowFound: false };
            const body = win.querySelector('.window-body');
            const iframe = win.querySelector('.window-app-iframe');
            const progress = win.querySelector('.ezil-boot');
            const unavailable = win.querySelector(`.ezil-${appId}-unavailable`);
            const r = body.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const hit = document.elementFromPoint(cx, cy);
            const csProgress = progress ? getComputedStyle(progress) : null;
            const csUnavailable = unavailable ? getComputedStyle(unavailable) : null;
            const textOf = (el) => (el ? (el.innerText ?? el.textContent ?? '').trim() : '');
            return {
                windowFound: true,
                iframeSrc: iframe ? iframe.getAttribute('src') : null,
                point: [cx, cy],
                hitTag: hit ? hit.tagName : null,
                hitClass: hit ? hit.className : null,
                hitInIframe: !! hit?.closest?.('.window-app-iframe'),
                hitInProgress: !! hit?.closest?.('.ezil-boot'),
                hitInUnavailable: !! hit?.closest?.(`.ezil-${appId}-unavailable`),
                progress: progress ? {
                    hiddenAttr: progress.hidden,
                    display: csProgress.display,
                    rectW: progress.getBoundingClientRect().width,
                    dataKind: progress.getAttribute('data-kind'),
                    text: textOf(progress),
                } : null,
                unavailable: unavailable ? {
                    hiddenAttr: unavailable.hidden,
                    display: csUnavailable.display,
                    rectW: unavailable.getBoundingClientRect().width,
                    text: textOf(unavailable),
                } : null,
            };
        }, a);
    }

    async function openFresh () {
        // Close any prior instance, then open a fresh one — the same
        // single-instance-safe reopen pattern `code-test.mjs`/
        // `preview-focus-test.mjs` use.
        // 🔴 No `return` here either, for the same reason as `boot()` above:
        // `$(w).close()`'s resolved value is not needed and is not safely
        // serializable back to Node.
        await page.evaluate((appId) => {
            const w = document.querySelector(`.window[data-app="${appId}"]`);
            if ( w ) $(w).close();
        }, app.id);
        // 🔴 Do NOT proceed on a fixed sleep. `$.fn.close` (UIWindow.js) runs
        // its body inside `$(this).each(async function () {...})`, which
        // jQuery does NOT await — `close()` resolves as soon as that async
        // callback is SCHEDULED, not once the element is actually removed.
        // Launching again before removal lands hits `registry.launch`'s
        // single-instance path ("X is already open; restoring it") instead
        // of a fresh open, and a RESTORED window keeps its prior boot state
        // and never re-mints. That silently turned "Direction B" into a
        // rerun of stale "Direction A" state while this file was being
        // built (caught by the mutation-proof cross-check — see the report).
        // Wait for the DOM to actually confirm removal instead of guessing a
        // duration.
        const closed = await until(
            (appId) => document.querySelectorAll(`.window[data-app="${appId}"]`).length === 0,
            app.id, 4000,
        );
        if ( closed === null ) {
            console.error(`${L} WARNING: window did not close within 4s before reopening — the next scenario may reuse stale state`);
        }
        await page.evaluate(({ appId, payload, computer, desktopState }) => {
            window.ezil.registry.launch(appId, { payload, computer, desktopState });
        }, { appId: app.id, payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
        await until((appId) => !! document.querySelector(`.window[data-app="${appId}"]`), app.id);
    }

    // ═════════════════════════════════════════════════════════════════════
    // DIRECTION A — SUCCESS. Confirmed frame. The overlay that shipped the
    // real bug (`.ezil-{app}-unavailable`) must be TRULY hidden (computed
    // display: none, not merely `hidden=true`), and the point a user would
    // actually look at must hit-test into the iframe.
    // ═════════════════════════════════════════════════════════════════════
    mintMode = 'ok';
    confirmAnswer = true;
    await openFresh();
    // Real navigation (about:blank) fires a genuine `load` event on its own —
    // unlike jsdom, nothing here needs to be dispatched by hand.
    await until((appId) => {
        const el = document.querySelector(`.window[data-app="${appId}"] .ezil-boot`);
        return el ? el.hidden === true : false;
    }, app.id, 8000);

    const success = await measure(app.id);
    push(`${L} DIRECTION A (success): window opened and iframe carries the minted URL`,
        success.windowFound && success.iframeSrc === app.mintedUrl, JSON.stringify(success.iframeSrc));
    push(`\u{1f534} ${L} DIRECTION A (success): the boot panel is TRULY hidden (computed display: none, not just the attribute)`,
        success.progress?.hiddenAttr === true && success.progress?.display === 'none',
        `hiddenAttr=${success.progress?.hiddenAttr} display=${success.progress?.display}`);
    push(`\u{1f534} ${L} DIRECTION A (success): the "unavailable" panel is TRULY hidden (computed display: none) — THE REGRESSION THIS FILE EXISTS TO CATCH`,
        success.unavailable?.hiddenAttr === true && success.unavailable?.display === 'none',
        `hiddenAttr=${success.unavailable?.hiddenAttr} display=${success.unavailable?.display} rectW=${success.unavailable?.rectW}`);
    push(`\u{1f534} ${L} DIRECTION A (success): a real hit-test at the window body's centre lands INSIDE THE IFRAME, not an overlay`,
        success.hitInIframe === true && success.hitInProgress === false && success.hitInUnavailable === false,
        `point=${JSON.stringify(success.point)} hit=${success.hitTag}.${success.hitClass}`);

    // ═════════════════════════════════════════════════════════════════════
    // DIRECTION B — REFUSED FRAME. `load` fires exactly as it does for a
    // healthy frame; only the server's refusal must reveal this. The boot
    // panel must be genuinely ON SCREEN (not accidentally also display:none
    // — the failure-direction inversion the brief warns about) and hit-test
    // as occluding the iframe, with real readable text.
    // ═════════════════════════════════════════════════════════════════════
    mintMode = 'ok';
    confirmAnswer = false;
    await openFresh();
    await until((appId) => {
        const el = document.querySelector(`.window[data-app="${appId}"] .ezil-boot`);
        return el?.getAttribute('data-kind') === 'failed';
    }, app.id, 8000);

    const refused = await measure(app.id);
    push(`${L} DIRECTION B (refused frame): reaches the "failed" boot state`,
        refused.progress?.dataKind === 'failed', `dataKind=${refused.progress?.dataKind}`);
    push(`\u{1f534} ${L} DIRECTION B (refused frame): the boot panel is VISIBLE (computed display is NOT none)`,
        refused.progress?.hiddenAttr === false && refused.progress?.display !== 'none' && refused.progress?.rectW > 0,
        `hiddenAttr=${refused.progress?.hiddenAttr} display=${refused.progress?.display} rectW=${refused.progress?.rectW}`);
    push(`\u{1f534} ${L} DIRECTION B (refused frame): a real hit-test at the window body's centre lands in the boot panel (the honest failure actually occludes)`,
        refused.hitInProgress === true && refused.hitInIframe === false,
        `point=${JSON.stringify(refused.point)} hit=${refused.hitTag}.${refused.hitClass}`);
    push(`${L} DIRECTION B (refused frame): the panel is READABLE, not just present (non-empty rendered text)`,
        typeof refused.progress?.text === 'string' && refused.progress.text.length > 0,
        JSON.stringify(refused.progress?.text?.slice(0, 60)));
    push(`${L} DIRECTION B (refused frame): the "unavailable" panel stays hidden — this is a REFUSAL, not an unsupported deployment`,
        refused.unavailable?.hiddenAttr === true && refused.unavailable?.display === 'none');
    confirmAnswer = true;

    // ═════════════════════════════════════════════════════════════════════
    // DIRECTION C — UNAVAILABLE. The deployment cannot serve this at all.
    // The `.ezil-{app}-unavailable` panel — the one that shipped the bug —
    // must be genuinely visible, occluding, and readable here, or "fixing"
    // direction A by hiding it unconditionally would pass unnoticed.
    // ═════════════════════════════════════════════════════════════════════
    mintMode = 'unavailable';
    await openFresh();
    await until((appId) => {
        const el = document.querySelector(`.window[data-app="${appId}"] .ezil-${appId}-unavailable`);
        return el ? el.hidden === false : false;
    }, app.id, 8000);

    const unavail = await measure(app.id);
    push(`\u{1f534} ${L} DIRECTION C (unavailable): the "unavailable" panel is VISIBLE (computed display is NOT none)`,
        unavail.unavailable?.hiddenAttr === false && unavail.unavailable?.display !== 'none' && unavail.unavailable?.rectW > 0,
        `hiddenAttr=${unavail.unavailable?.hiddenAttr} display=${unavail.unavailable?.display} rectW=${unavail.unavailable?.rectW}`);
    push(`\u{1f534} ${L} DIRECTION C (unavailable): a real hit-test at the window body's centre lands in the "unavailable" panel, not the iframe`,
        unavail.hitInUnavailable === true && unavail.hitInIframe === false,
        `point=${JSON.stringify(unavail.point)} hit=${unavail.hitTag}.${unavail.hitClass}`);
    push(`${L} DIRECTION C (unavailable): the panel is READABLE and says the honest thing (non-empty text, matches copy)`,
        typeof unavail.unavailable?.text === 'string' && app.unavailableText.test(unavail.unavailable.text),
        JSON.stringify(unavail.unavailable?.text?.slice(0, 60)));
    push(`${L} DIRECTION C (unavailable): the boot panel itself stays truly hidden underneath (no double-overlay)`,
        unavail.progress?.hiddenAttr === true && unavail.progress?.display === 'none');
    mintMode = 'ok';

    push(`${L} no uncaught page errors during this app's run`, page_errors.length === 0, JSON.stringify(page_errors));

    await page.close();
}
