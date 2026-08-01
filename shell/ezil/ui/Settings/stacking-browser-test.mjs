// stacking-browser-test.mjs — EZiL-authored. REAL-BROWSER, DATA-DRIVEN
// hit-testing for window stacking, taskbar occlusion and click-to-raise.
//
// Run:  node shell/ezil/ui/Settings/stacking-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same as
//       settings-test.mjs and boot-test.mjs)
//
// Requires `playwright` (with a Chromium build) to be resolvable from this
// file's location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR. This
// is NOT a project dependency — it is a real-browser prerequisite for THIS
// test only, the same way a pre-built bundle is a prerequisite for the other
// two `*-test.mjs` files in this directory. If neither resolves, this exits 2
// (skip), not 0 (pass) and not a silent false-negative.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE META-DEFECT THIS FILE EXISTS TO CLOSE
// ═══════════════════════════════════════════════════════════════════════════
// Round 4 shipped a paint-order defect because every harness was jsdom, which
// has no stacking model. The fix (this file, round 5) added real-Chromium
// hit-testing — the right KIND of test. Round 5 then shipped a NEW
// paint-order defect (the Code window occluding the taskbar) because that
// harness's five scenarios were a hardcoded list — desktop/Settings/Preview —
// that never opened the Code window. Verbatim from the verifier:
//
//   "Round 4 omitted paint order; round 5 has paint order covered and omits
//    the new window from the paint-order test."
//
// A hardcoded scenario list guarantees the next new window is invisible to
// it. That is the actual bug, and a sixth hardcoded list (this time including
// "code") would only move the hole to whatever app ships seventh.
//
// THE FIX: this file does not enumerate apps. It reads `window.ezil.registry`
// — the SAME live singleton `boot.js` imports from `apps/registry.js` — at
// runtime, in the browser, from the built bundle. Every app it finds gets the
// exact same generic scenario: opened, hit-tested at its titlebar and at an
// interactive control, checked against the taskbar, and clicked to prove it
// raises. There is no per-app branch that a new AppDescriptor could fall
// through, and no list to forget to update — the loop IS the registry.
// `pushGuard()` below turns "the loop silently skipped one" into a FAIL.
//
// ═══════════════════════════════════════════════════════════════════════════
// TWO TRAPS THE PREVIOUS VERIFIER DOCUMENTED, AND HOW THIS FILE AVOIDS THEM
// ═══════════════════════════════════════════════════════════════════════════
// 1. "It measured mid-transition and got nonsense (drawer 56px, everything
//    'clipped') because a 0.45s morph was still animating." Every geometry
//    read in this file goes through `settle()`, which polls the window's own
//    `getBoundingClientRect()` until two consecutive reads agree (or a
//    generous timeout elapses) BEFORE any hit test or z-index comparison is
//    trusted. State transitions (minimized, full-bleed) are still awaited via
//    `until()` on the attribute/class the app itself writes — settle() runs
//    AFTER that, to let the animation the class change kicked off finish.
//
// 2. "`Emulation.setEmulatedMedia` accepted `pointer:coarse` and Chrome
//    ignored it... It only noticed by asserting `--btn == 36px`." The lesson
//    generalizes: never trust that an emulation call took effect — assert it.
//    This file only emulates VIEWPORT SIZE (no touch/pointer emulation), so
//    the applicable form of the same rule is `assertViewportApplied()` below:
//    every viewport is read back via `page.viewportSize()` after being set,
//    and a mismatch is a FAIL, not a silently-wrong subsequent measurement.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THE TASKBAR-OCCLUSION MECHANISM IS NOT "A CODE.JS BUG"
// ═══════════════════════════════════════════════════════════════════════════
// Read `UIDesktopFullpage.js`'s `enter_fullpage_mode`/`exit_fullpage_mode`
// and `UITaskbar.js`: the real `.taskbar` has `z-index: 99999`, but that
// number is only meaningful WITHIN `.desktop`'s own stacking context, because
// `.desktop` itself establishes none. Every `.window` is a sibling of
// `.desktop` under `<body>`, so ANY window whose on-screen rect overlaps the
// taskbar's screen position paints over it regardless of the window's own
// (much smaller) numeric z-index — the two numbers are never compared in the
// same coordinate system. `preview` (720x480) and `settings` (760x560)
// happen to clear the taskbar by a couple of pixels at the viewports this
// file sweeps; `code` (980x680) does not. This is why `checkTaskbarReachable`
// below hit-tests the ACTUAL SCREEN POSITION of every taskbar item, for
// every app, at every viewport — geometry is the only thing that decides
// this defect, and geometry is exactly what a real browser layout gives you
// and jsdom cannot.
//
// The desktop's own full-bleed mode calls this same `enter_fullpage_mode`,
// which *deliberately* `$('.taskbar').hide()`s — that is not occlusion, it is
// the OS hiding its own taskbar on purpose (the drawer is the documented
// escape hatch). `checkTaskbarReachable` tells the two apart by reading the
// taskbar's own `display`/visibility/rect, not by assuming which app is open.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY CLICK-TO-RAISE USES page.mouse.click(), NEVER .focusWindow()/dispatch
// ═══════════════════════════════════════════════════════════════════════════
// `$.fn.focusWindow` is a real method (`UIWindow.js`), and calling it directly
// always "works" — it is not wired to a browser event at all, so it proves
// nothing about whether a human clicking the screen raises the window. The
// documented defect ("nothing binds focusWindow to a plain mousedown") is
// invisible to any check that calls the method instead of clicking the
// pixel. Every raise assertion below uses `page.mouse.click(x, y)` — a
// trusted OS-level input event dispatched at real on-screen coordinates,
// exactly like `settings-test.mjs`'s own header insists on for hit-testing.
// If that pixel is currently occluded by another window (the taskbar defect
// above), the click goes to the wrong element and the raise correctly fails
// — the two defects share one root cause and this file catches both with the
// same mechanism a user would trigger them with.
//
// `focusApp()` below (a thin `.focusWindow()` wrapper) is kept ONLY to set up
// a known z-order cheaply before a *different* thing is being measured (e.g.
// "does the desktop's counter-based z climb make Settings unreachable" —
// Scenario 3/5's own concern, unrelated to click-binding) — never as the
// PASS/FAIL signal for "can a user raise this window by clicking it".
//
// ═══════════════════════════════════════════════════════════════════════════
// THE VIEWPORT SWEEP
// ═══════════════════════════════════════════════════════════════════════════
// 1280x860, 1366x768, 1440x900, 1280x800 — the desktop/laptop sizes the
// previous verifier reproduced the Code/taskbar overlap at (desktop area
// under ~740-810px tall) — plus 1920x1080, the tall viewport the previous
// verifier explicitly did NOT measure ("UNKNOWN above ~900px tall"). Every
// check in this file runs at every viewport; whether the occlusion checks
// pass or fail is expected to vary by viewport (that is the actual defect,
// not a harness bug) — this file's job is to have a correct, sensitive check
// at each size, not to force one outcome.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
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
        + 'This is a REAL-BROWSER test — jsdom cannot exercise a stacking model (see header). '
        + 'Install playwright (e.g. `bunx playwright@1.62.1 install chromium` in some directory and '
        + 'set PLAYWRIGHT_REQUIRE_DIR to it) and re-run. Skipping, not passing.',
    );
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    const mark = pass ? 'PASS' : 'FAIL';
    console.log(`${mark}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};
/** Informational: a check that does not apply in this state (e.g. the
 * taskbar is deliberately hidden by full-bleed mode) is not a silent pass —
 * it is logged distinctly and does NOT inflate the pass count, so a run full
 * of skips cannot read as a run full of passes. */
const skip = (name, detail = '') => {
    console.log(`SKIP  ${name}${detail ? `  [${detail}]` : ''}`);
};

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [
        { id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' },
    ],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true,
        status: 'idle',
        endpoints: {
            session: '/api/shell/session', desktop: '/api/shell/desktop',
            previewUrl: '/api/shell/preview-url', focus: '/api/shell/focus',
            codePreviewUrl: '/api/shell/code-preview-url',
        },
    },
};

let listRows = [{ id: 'computer-1', name: 'My Computer', slot: 1, createdAt: PAYLOAD.computer.createdAt, lastOpenedAt: null }];

/** Same response shapes as `boot-test.mjs` / `settings-test.mjs` / the
 * original `stacking-browser-test.mjs` — verified against `shell/ezil/session.js`,
 * `shell/ezil/apps/code.js` and `shell/ezil/ui/Settings/trpc.js`. */
function stub (url, method, bodyText) {
    if ( url.includes('/api/shell/desktop') && method === 'POST' ) {
        return { ok: true, guacamoleUrl: 'about:blank?desktop-frame=1', controlMode: 'interactive', mode: 'neko', frame: { confirmed: true } };
    }
    // 🔴 MUST come before the generic `/api/shell/desktop` GET fallback below
    // — `?confirm=frame` requests also `.includes('/api/shell/desktop')`, and
    // the generic branch's `{guacamoleRunning:true}` shape has no `confirmed`
    // field, which `session.confirmFrame()` reads as a hard `false` (not
    // `undefined`) — silently failing frame confirmation for every window.
    if ( url.includes('confirm=frame') ) return { ok: true, confirmed: true };
    if ( url.includes('/api/shell/desktop') ) return { ok: true, guacamoleRunning: true };
    if ( url.includes('/api/shell/preview-url') && method === 'POST' ) {
        return { ok: true, appPreviewUrl: 'about:blank?preview-frame=1' };
    }
    if ( url.includes('/api/shell/code-preview-url') && method === 'POST' ) {
        return { ok: true, codePreviewUrl: 'about:blank?code-frame=1' };
    }
    if ( url.includes('/api/trpc/computer.list') ) return { result: { data: { json: listRows } } };
    if ( url.includes('/api/trpc/computer.delete') ) {
        const id = JSON.parse(bodyText ?? '{}').json?.id;
        listRows = listRows.filter(c => c.id !== id);
        return { result: { data: { json: { id } } } };
    }
    return { ok: true };
}

const HOST = 'https://ezil-stacking-test.invalid';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>
     <body class="min-h-full flex flex-col"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// The viewport sweep. See the file header for why these five.
// ═══════════════════════════════════════════════════════════════════════════
const VIEWPORTS = [
    { name: '1280x860', width: 1280, height: 860 },
    { name: '1366x768', width: 1366, height: 768 },
    { name: '1440x900', width: 1440, height: 900 },
    { name: '1280x800', width: 1280, height: 800 },
    { name: '1920x1080', width: 1920, height: 1080 },
];

// GAP 2's close/reopen intervals — see `runCloseReopenSweep`'s doc block
// (below) for why these five. Declared here (module top-level, `const`, no
// TDZ) because it is read from the top-level execution flow just below,
// before the module reaches `runCloseReopenSweep`'s own textual definition.
const CLOSE_REOPEN_INTERVALS_MS = [20, 50, 112, 250, 500];

const browser = await chromium.launch();
const allPageErrors = [];
let anyHardFailure = false;

for ( const vp of VIEWPORTS ) {
    try {
        await runViewport(vp);
    } catch ( err ) {
        anyHardFailure = true;
        push(`[${vp.name}] harness threw without completing`, false, String(err?.stack ?? err));
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP 2 — close, then reopen, every registered app. See the file's own
// header note (top) and `runCloseReopenSweep`'s doc block for what this
// closes: seven rounds of harnesses covered React, an entry path, a soft
// navigation, paint order, the new window missing from the paint test, what
// a window paints inside itself — and NEVER an app closed and reopened.
// ═══════════════════════════════════════════════════════════════════════════
try {
    await runCloseReopenSweep();
} catch ( err ) {
    anyHardFailure = true;
    push('[close-reopen] harness threw without completing', false, String(err?.stack ?? err));
}

await browser.close();

const failed = checks.filter(c => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed across ${VIEWPORTS.length} viewports`);
if ( failed.length || anyHardFailure ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
    process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════════
// Everything below is scoped to one viewport's run — a fresh page/boot each
// time, so no state (z-index counters, open windows) leaks between sizes.
// ═══════════════════════════════════════════════════════════════════════════
async function runViewport (vp) {
    const VP = `[${vp.name}]`;
    const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });

    // ── Trap #2 from the header: assert the emulation actually took effect ──
    const applied = page.viewportSize();
    push(`${VP} viewport actually applied`,
        !! applied && applied.width === vp.width && applied.height === vp.height,
        `requested=${vp.width}x${vp.height} actual=${applied ? `${applied.width}x${applied.height}` : 'null'}`);

    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
        if ( process.env.DEBUG_CONSOLE ) console.log('CONSOLE:', msg.type(), msg.text());
        if ( msg.type() !== 'error' ) return;
        if ( /Failed to load resource.*404/.test(msg.text()) ) return;
        // The GAP 1 mutation self-test (see near the GUARD, below) is
        // EXPECTED to log console noise for its deliberately-broken dummy
        // ids; it must not register as a spurious "uncaught page error".
        if ( process.env.MUTATION_PROVE_GAP1 && /zz-mutation/.test(msg.text()) ) return;
        page_errors.push(msg.text());
    });

    // 🔴 Same reasoning as the original file: navigate to a REAL (fake, fully
    // intercepted) same-origin URL, never `about:blank` — `session.js`'s
    // relative-path `fetch()` calls need a same-origin document to resolve
    // against, or every scenario silently wedges into "boot failed".
    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if ( url === `${HOST}/os` ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
            return;
        }
        if ( url.includes('/api/') ) {
            const body = stub(url, req.method(), req.postData());
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            return;
        }
        if ( url.startsWith(HOST) ) {
            await route.fulfill({ status: 404, body: '' });
            return;
        }
        await route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });

    // ── per-page helpers, closed over this viewport's `page` ────────────────
    //
    // 🔴 `fn` is serialized (`toString()`) and re-evaluated INSIDE the page —
    // it cannot close over this function's Node-side variables (`bootAppId`,
    // `id`, …). Anything `fn` needs must travel through `arg`, exactly like
    // every other `page.evaluate()` call in this file.
    async function until (fn, arg, ms = 6000, step = 50) {
        const deadline = Date.now() + ms;
        for ( ;; ) {
            const v = await page.evaluate(fn, arg);
            if ( v ) return v;
            if ( Date.now() > deadline ) return null;
            await sleep(step);
        }
    }

    /** Trap #1 from the header: poll the window's own geometry until it stops
     * changing before trusting any hit test or z comparison against it. Not a
     * fixed sleep — a fixed sleep shorter than the real transition still
     * measures mid-morph on a slow CI box, and one long enough to always be
     * safe wastes it on every window that had nothing to animate. */
    async function settle (app, { timeout = 1000, step = 60 } = {}) {
        const read = () => page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return `${r.top.toFixed(1)}|${r.left.toFixed(1)}|${r.width.toFixed(1)}|${r.height.toFixed(1)}`;
        }, app);
        let prev = await read();
        const deadline = Date.now() + timeout;
        while ( Date.now() < deadline ) {
            await sleep(step);
            const cur = await read();
            if ( cur !== null && cur === prev ) return true;
            prev = cur;
        }
        return false;
    }

    async function hitTest (x, y) {
        return page.evaluate(([px, py]) => {
            const el = document.elementFromPoint(px, py);
            if ( ! el ) return { inWindow: null, inTaskbarItem: null, inTaskbar: false, tag: null, cls: null };
            const win = el.closest?.('.window');
            const tbItem = el.closest?.('.taskbar-item');
            const tb = el.closest?.('.taskbar');
            return {
                inWindow: win ? win.getAttribute('data-app') : null,
                inTaskbarItem: tbItem ? tbItem.getAttribute('data-app') : null,
                inTaskbar: !! tb,
                tag: el.tagName,
                cls: el.className,
            };
        }, [x, y]);
    }

    async function zIndexOf (app) {
        return page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"]`);
            return el ? parseInt(window.getComputedStyle(el).zIndex, 10) || 0 : null;
        }, app);
    }

    async function allZIndexes (apps) {
        const out = {};
        for ( const a of apps ) out[a] = await zIndexOf(a);
        return out;
    }

    function topmostOf (zmap) {
        const entries = Object.entries(zmap).filter(([, v]) => v !== null);
        if ( entries.length === 0 ) return null;
        entries.sort((a, b) => b[1] - a[1]);
        return entries[0][0];
    }

    async function rectOf (app) {
        return page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return { top: r.top, left: r.left, width: r.width, height: r.height };
        }, app);
    }

    /**
     * Returns null (not a zero-size point) when the titlebar does not exist,
     * is hidden — e.g. a full-bleed window's own `.window-head` is
     * `display:none` (`enter_fullpage_mode`) — OR when no part of it is
     * currently a pixel THIS window actually owns.
     *
     * 🔴 THE FIX for the defect documented in the file header (round 6's
     * verifier): the previous version always returned the geometric midpoint
     * of `.window-head`'s own rect, with no regard for what is CURRENTLY
     * painted there. Cascaded windows overlap — a later, larger window can
     * sit entirely inside an earlier one's footprint for several launches —
     * so "the midpoint of app's own titlebar rect" and "a pixel app is
     * visibly on top at" are DIFFERENT claims, and only the second one is
     * true 100% of the time a real user could click it. Confirmed
     * unsatisfiable on baseline: preview's titlebar midpoint (e.g. (380,
     * 184.2) at 1280x860) sits inside settings' rect (290..1050 x 149..709)
     * while settings sits at a higher z — so `elementFromPoint` there
     * resolves to settings NO MATTER what z-order dance precedes the click,
     * because the two windows genuinely overlap at that exact pixel. A test
     * that clicks it and asserts "preview raised" can never pass; that is a
     * broken assertion, not a product bug (no user drags a mouse to a pixel
     * their target app does not visibly occupy).
     *
     * The fix: scan the titlebar strip left-to-right at its vertical center
     * for A pixel that `elementFromPoint` currently attributes to `app`
     * itself, and click THAT one. If the entire strip is covered by some
     * other window, return null — the caller's existing `skip()` path is the
     * honest outcome, not a fabricated pass and not a permanent fail.
     */
    async function titlebarPoint (app) {
        return page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"] .window-head`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            if ( r.width === 0 || r.height === 0 ) return null;
            const y = r.top + r.height / 2;
            // 🔴 A titlebar strip is not UNIFORMLY safe to click even where
            // it belongs to `app`: `.window-action-btn` (minimize/close, see
            // `UIWindow.js`) lives INSIDE `.window-head` too, and a scan that
            // does not exclude it can walk straight into the close button —
            // "raising" the window by deleting it, which then reads as z=null
            // (element gone) rather than a raise. Only a plain drag/title
            // pixel counts as a titlebar click for this test.
            const ownsPixel = (x) => {
                const hit = document.elementFromPoint(x, y);
                if ( hit?.closest?.('.window-action-btn') ) return false;
                const win = hit?.closest?.('.window');
                return !! win && win.getAttribute('data-app') === a;
            };
            // Prefer the original midpoint-ish spot (cheapest, and the only
            // point checked before this fix) so unaffected windows keep
            // clicking exactly where they always did.
            const preferred = r.left + Math.min(40, r.width / 2);
            if ( ownsPixel(preferred) ) return [preferred, y];
            const STEP = 6;
            for ( let x = r.left + 3; x <= r.right - 3; x += STEP ) {
                if ( ownsPixel(x) ) return [x, y];
            }
            return null;
        }, app);
    }

    /** The window's own CLOSE button — always rendered and, unlike minimize,
     * not hidden by full-bleed mode (see the original file's header for the
     * full reasoning: `.fullpage-mode .window-minimize-btn` is hidden
     * site-wide, close is not). */
    async function buttonPointInside (app) {
        return page.evaluate((a) => {
            const candidates = Array.from(document.querySelectorAll(
                `.window[data-app="${a}"] .window-close-btn, `
                + `.window[data-app="${a}"] button, `
                + `.window[data-app="${a}"] .window-action-btn`,
            ));
            const el = candidates.find((c) => {
                const r = c.getBoundingClientRect();
                return r.width > 0 && r.height > 0;
            });
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return [r.left + r.width / 2, r.top + r.height / 2];
        }, app);
    }

    async function taskbarItemPoint (app) {
        return page.evaluate((a) => {
            const el = document.querySelector(`.taskbar-item[data-app="${a}"]`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            if ( r.width === 0 || r.height === 0 ) return null;
            return [r.left + r.width / 2, r.top + r.height / 2];
        }, app);
    }

    async function taskbarVisible () {
        return page.evaluate(() => {
            const el = document.querySelector('.taskbar');
            if ( ! el ) return false;
            const cs = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        });
    }

    /** Bring `app`'s window forward via a direct API call — NEVER the
     * PASS/FAIL signal for "click raises a window" (see file header). Used
     * only to arrange a known z-order before a different thing is measured. */
    async function focusApp (app) {
        await page.evaluate((a) => $(`.window[data-app="${a}"]`).focusWindow(), app);
        await sleep(30);
    }

    /**
     * 🔴 A window that is ALREADY topmost when a raise-by-click test starts
     * would trivially "pass" that test no matter what happens next (it was
     * on top before the click; nothing changed). This is why `launch()` —
     * which always makes the freshly-opened window topmost — must NOT be
     * followed directly by a raise-by-click assertion on that SAME window:
     * doing so proves nothing about click-to-focus, only that a window that
     * never lost focus still has it. Bury `app` under a contender FIRST
     * (via the non-click `.focusWindow()` API — arranging state, not the
     * thing being measured) so the click that follows has something real to
     * prove.
     */
    async function ensureNotTopmost (app, contenders) {
        const other = contenders.find((id) => id !== app);
        if ( ! other ) return; // nothing to bury it under
        const before = topmostOf(await allZIndexes(contenders));
        if ( before !== app ) return; // already not on top
        await focusApp(other);
        await sleep(150); // flush showWindow's own delayed re-focus, if any
    }

    async function assertHitTestsIntoSelf (app, label) {
        const tb = await titlebarPoint(app);
        const bp = await buttonPointInside(app);
        const z = await zIndexOf(app);
        const hitTb = tb ? await hitTest(...tb) : { inWindow: null };
        const hitBp = bp ? await hitTest(...bp) : { inWindow: null };
        if ( tb ) {
            push(`${label}: titlebar hit-tests INTO ${app}`, hitTb.inWindow === app,
                `${app} z=${z} titlebar-hit=${JSON.stringify(hitTb)}`);
            // 🔴 GAP 1 FIX: coverage is recorded HERE, at the one real
            // per-app assertion, never by loop membership — see the GUARD's
            // own comment block near the bottom of this file for why that
            // distinction is the entire fix.
            coveredIds.add(app);
        } else {
            skip(`${label}: titlebar hit test for ${app} (no titlebar pixel this window owns — either full-bleed hides it by design, or another window fully occludes it)`);
        }
        if ( bp ) {
            push(`${label}: a button inside ${app} hit-tests INTO ${app}`, hitBp.inWindow === app,
                `button-hit=${JSON.stringify(hitBp)}`);
            coveredIds.add(app);
        } else {
            skip(`${label}: button-inside hit test for ${app} (no visible interactive control found)`);
        }
    }

    /**
     * 🔴 THE OCCLUSION CHECK. For every taskbar item CURRENTLY on screen
     * (Start button included — it carries `data-app="undefined"`, read
     * verbatim rather than assumed, since it is whatever `UITaskbarItem`
     * actually wrote), hit-test its real on-screen center and assert the
     * click lands INSIDE that exact item, not inside some window that
     * happens to geometrically overlap it. Skips (does not fail) when the
     * taskbar itself is legitimately hidden by full-bleed mode — see the
     * file header for why that is not this defect.
     */
    async function checkTaskbarReachable (label) {
        if ( ! await taskbarVisible() ) {
            skip(`${label}: taskbar reachability (taskbar is off-screen — full-bleed hides it by design)`);
            return;
        }
        const items = await page.evaluate(() => Array.from(document.querySelectorAll('.taskbar .taskbar-item')).map((el) => {
            const r = el.getBoundingClientRect();
            return { app: el.getAttribute('data-app'), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        }));
        if ( items.length === 0 ) {
            push(`${label}: taskbar has at least one item to test`, false, 'taskbar visible but empty');
            return;
        }
        for ( const it of items ) {
            if ( it.w === 0 || it.h === 0 ) continue;
            const hit = await hitTest(it.x, it.y);
            const humanLabel = it.app && it.app !== 'undefined' ? `taskbar item "${it.app}"` : 'Start button';
            push(`${label}: ${humanLabel} stays hittable (not occluded by a window)`,
                hit.inTaskbarItem === it.app,
                `point=(${it.x.toFixed(0)},${it.y.toFixed(0)}) hit=${JSON.stringify(hit)}`);
        }
    }

    /**
     * 🔴 THE INSIDE-THE-WINDOW CHECK. Round 4-5's harnesses proved WHERE
     * windows sit (paint order, taskbar occlusion). Round 6 shipped a defect
     * in WHAT a window shows: `hidden = true` next to an inline
     * `display:flex` (inline beats the UA `[hidden]{display:none}`) left
     * `.ezil-code-unavailable` painted over a working iframe, and every app
     * test used `textContent` as its oracle — blind to CSS, under jsdom,
     * which has no cascade. This is that check, generalised, in a real
     * browser, registry-driven — no `if (app === 'code')` anywhere below.
     *
     * The structural contract this leans on is shared by every iframe-backed
     * app in the registry (`desktop-window.js`, `preview.js`, `code.js`, all
     * three grepped): `UIWindow` gives every app a `.window-body`, and each
     * of those three appends its real content (`.window-app-iframe`,
     * created by `UIWindow` itself) and its own loading/error panels
     * (`BootProgress`'s `.ezil-boot`, `.ezil-{code,preview}-unavailable`) as
     * DIRECT CHILDREN of that same `.window-body`, each `position:absolute;
     * inset:0` (verified in `ezil-shell.css`) — i.e. genuinely stacked on
     * top of one another, not just adjacent in the DOM. Nothing here reads
     * an app's class name; it reads the SHAPE every app already commits to.
     *
     * "The app reports success" is read the same structural way, not by
     * app id: `iframe_url: 'about:blank'` at window creation, and `src` is
     * assigned exactly once, to a real (or fake-but-real-shaped) URL, only
     * on the success path (grepped: all three do this). So "src moved off
     * about:blank" IS the app-agnostic success signal — checking it earlier
     * would mean asserting through a boot panel that has every right to be
     * there, which is not this defect.
     *
     * Once ready, this hit-tests the iframe's own on-screen center AND scans
     * every other element inside `.window-body` for one that is (a)
     * genuinely visible per COMPUTED style — not the `hidden` IDL property,
     * which is exactly the property the round-6 bug defeats — and (b)
     * geometrically overlapping the iframe. Either the hit misses the
     * iframe, or an occluder is found: both are the same defect, caught two
     * ways for the same reason `assertHitTestsIntoSelf` checks both a
     * titlebar point and a button point.
     *
     * A window with no `.window-app-iframe` at all (Settings — plain DOM
     * content, no boot phase) gets the weaker but still real form of the
     * same claim: its `.window-body` center must hit-test into ITS OWN
     * window, not something stacked over it.
     */
    async function checkContentPainted (app, label) {
        const res = await page.evaluate((a) => {
            const win = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! win ) return { skip: true, reason: 'window not found' };
            const body = win.querySelector('.window-body');
            if ( ! body ) return { skip: true, reason: 'no .window-body on this window' };
            const bRect = body.getBoundingClientRect();
            if ( bRect.width === 0 || bRect.height === 0 ) {
                return { skip: true, reason: 'window-body has zero size (minimized or hidden)' };
            }

            const iframe = win.querySelector('.window-app-iframe');
            const overlaps = (r1, r2) => r1.left < r2.right && r1.right > r2.left && r1.top < r2.bottom && r1.bottom > r2.top;
            const isVisible = (el) => {
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0
                    && r.width > 0 && r.height > 0;
            };

            if ( iframe ) {
                const src = iframe.getAttribute('src') || '';
                if ( src === '' || src === 'about:blank' ) {
                    return { skip: true, reason: `iframe still on "${src || '(no src yet)'}"  — app has not committed to real content yet (a boot/loading panel legitimately owns the screen here)` };
                }
                const iRect = iframe.getBoundingClientRect();
                const occluders = Array.from(body.querySelectorAll('*'))
                    .filter((el) => el !== iframe && ! iframe.contains(el) && ! el.contains(iframe))
                    .filter((el) => isVisible(el) && overlaps(el.getBoundingClientRect(), iRect))
                    .map((el) => ({ tag: el.tagName, cls: el.className }));
                const cx = iRect.left + iRect.width / 2;
                const cy = iRect.top + iRect.height / 2;
                const hitEl = document.elementFromPoint(cx, cy);
                const hitIsIframe = hitEl === iframe;
                return {
                    skip: false,
                    pass: occluders.length === 0 && hitIsIframe,
                    detail: { src, hitIsIframe, hitTag: hitEl?.tagName ?? null, hitCls: hitEl?.className ?? null, occluders },
                };
            }

            // No iframe: a plain in-DOM content window. Its real content IS
            // whatever `.window-body` paints — assert the center of that
            // region resolves into THIS window, not one stacked over it.
            const cx = bRect.left + bRect.width / 2;
            const cy = bRect.top + bRect.height / 2;
            const hitEl = document.elementFromPoint(cx, cy);
            const hitWin = hitEl?.closest?.('.window');
            return {
                skip: false,
                pass: !! hitWin && hitWin.getAttribute('data-app') === a,
                detail: { hitTag: hitEl?.tagName ?? null, hitCls: hitEl?.className ?? null, hitOwnerApp: hitWin ? hitWin.getAttribute('data-app') : null },
            };
        }, app);

        const name = `${label}: ${app}'s content region shows its own real content, unoccluded`;
        if ( res.skip ) {
            skip(name, res.reason);
            return;
        }
        push(name, res.pass, JSON.stringify(res.detail));
        coveredIds.add(app); // 🔴 GAP 1 FIX — see assertHitTestsIntoSelf's comment.
    }

    /**
     * Poll `checkContentPainted`'s own underlying state until it stops
     * changing (or a timeout elapses) before trusting it — same reasoning as
     * `settle()` for geometry: `confirmFrame`'s round trip and the
     * hide-the-boot-panel it triggers are asynchronous, so the FIRST read
     * after `src` goes live can catch the panel mid-fade-out. Returns
     * whichever state it last observed; a state that never stabilizes is
     * still evaluated (not silently dropped) because "still visibly
     * flapping after 2s" is itself worth knowing, not worth hiding.
     */
    async function settleContentPainted (app, { timeout = 2000, step = 60 } = {}) {
        const read = () => page.evaluate((a) => {
            const win = document.querySelector(`.window[data-app="${a}"]`);
            const iframe = win?.querySelector('.window-app-iframe');
            if ( ! iframe ) return 'no-iframe';
            const src = iframe.getAttribute('src') || '';
            if ( src === '' || src === 'about:blank' ) return `not-ready:${src}`;
            const body = win.querySelector('.window-body');
            const iRect = iframe.getBoundingClientRect();
            const overlaps = (r1, r2) => r1.left < r2.right && r1.right > r2.left && r1.top < r2.bottom && r1.bottom > r2.top;
            const isVisible = (el) => {
                const cs = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0 && r.width > 0 && r.height > 0;
            };
            const occluderCount = Array.from(body.querySelectorAll('*'))
                .filter((el) => el !== iframe && ! iframe.contains(el) && ! el.contains(iframe))
                .filter((el) => isVisible(el) && overlaps(el.getBoundingClientRect(), iRect)).length;
            return `ready:${occluderCount}`;
        }, app);
        let prev = await read();
        const deadline = Date.now() + timeout;
        while ( Date.now() < deadline ) {
            await sleep(step);
            const cur = await read();
            if ( cur === prev ) return true;
            prev = cur;
        }
        return false;
    }

    /** 🔴 THE CLICK-TO-RAISE CHECK, via a real trusted click at the titlebar's
     * actual screen position — see file header for why not `.focusWindow()`. */
    async function raiseByTitlebarClick (app, contenders, label) {
        await ensureNotTopmost(app, contenders);
        const tb = await titlebarPoint(app);
        if ( ! tb ) {
            // 🔴 Justified, not a cop-out: `titlebarPoint` just scanned the
            // ENTIRE titlebar strip and found no pixel currently attributed
            // to `app` — either the titlebar does not exist/is hidden
            // (full-bleed), or `app`'s titlebar is presently, entirely
            // covered by another window's rect. In the second case NO click
            // coordinate could make this assertion pass (see the doc block
            // on `titlebarPoint`), so failing it would be an unsatisfiable
            // gate, not a real signal — `raiseByTaskbarItemClick` still
            // covers "can a user raise this window" via the other real path.
            skip(`${label}: raise ${app} by clicking its titlebar (no titlebar pixel this window owns right now — either hidden by full-bleed, or fully occluded by another window's overlapping rect)`);
            return;
        }
        await page.mouse.click(tb[0], tb[1]);
        await settle(app);
        const z = await allZIndexes(contenders);
        const top = topmostOf(z);
        push(`${label}: a real click on ${app}'s titlebar raises it to the top`,
            top === app, `clicked-at=${JSON.stringify(tb)} z=${JSON.stringify(z)}`);
        coveredIds.add(app); // 🔴 GAP 1 FIX — see assertHitTestsIntoSelf's comment.
    }

    /** Same signal, via the taskbar item — the OTHER real path a user has to
     * raise/restore a window, and the one the taskbar-occlusion defect can
     * independently break by making the item itself unclickable. */
    async function raiseByTaskbarItemClick (app, contenders, label) {
        await ensureNotTopmost(app, contenders);
        const p = await taskbarItemPoint(app);
        if ( ! p ) {
            skip(`${label}: raise ${app} by clicking its taskbar item (no visible item)`);
            return;
        }
        await page.mouse.click(p[0], p[1]);
        await settle(app);
        // 🔴 `$.fn.showWindow` (UIWindow.js) ALWAYS schedules a SECOND,
        // delayed `focusWindow()` 80ms after its own synchronous z-index
        // bump — unconditionally, not only on the minimized-restore path.
        // Reading z-index before that fires would record a value the window
        // manager itself is about to change out from under us a moment
        // later (see the original file's own regression-check comment for
        // the same trap: "the delayed call fires AFTER this test's own
        // focus"). Flush it before trusting this as the final state.
        await sleep(150);
        const z = await allZIndexes(contenders);
        const top = topmostOf(z);
        push(`${label}: a real click on ${app}'s taskbar item raises/restores it to the top`,
            top === app, `clicked-at=${JSON.stringify(p)} z=${JSON.stringify(z)}`);
        coveredIds.add(app); // 🔴 GAP 1 FIX — see assertHitTestsIntoSelf's comment.
    }

    /** Minimize whatever app is passed — tries the ordinary titlebar minimize
     * button first, falls back to the full-bleed control drawer's minimize
     * action (the drawer exists specifically because full-bleed hides the
     * ordinary titlebar controls — see `desktop-window.js`'s own header). */
    async function minimizeApp (app) {
        await page.evaluate((a) => {
            const $win = $(`.window[data-app="${a}"]`);
            const $btn = $win.find('.window-minimize-btn');
            if ( $btn.length && $btn.is(':visible') ) { $btn.trigger('click'); return; }
            const drawer = document.querySelector(`.window[data-app="${a}"] .dashboard-app-drawer`);
            const btn = drawer?.querySelector(
                '.dashboard-app-drawer-btn:not(.dashboard-app-drawer-settings):not(.dashboard-app-drawer-close)',
            );
            btn?.click();
        }, app);
    }

    /**
     * 🔴 GAP 3 FOLLOW-UP (round 8's verifier: "nw and e resize checks: 100%
     * SKIP, every viewport, every run"). Root cause, found by instrumenting
     * jQuery UI's own `resizestart`/`resize`/`resizestop` events on the live
     * target: dragging ANY resize handle — `se`, `nw`, and plain `e` all
     * independently confirmed, on a FRESH window each time — drives the
     * window's `height` to a large NEGATIVE `ui.size.height` (CSS then clamps
     * the rendered box to 0). It reproduces on the very first direction tried
     * and has nothing to do with which direction that is; MEASURED via a
     * `resizestart/resize/resizestop` listener attached before the drag:
     * `{"type":"resize","size":{"w":764,"h":-149},...}` on a window whose
     * `top` was still its DEFAULT cascade value,
     * `calc(15% + Npx)` (`default_window_top`, UIWindow.js ~L86) — never
     * dragged into a plain-pixel position. `-149` is exactly that window's
     * own `top` in px, which is the fingerprint of jQuery reading a CSS
     * `calc()` string back through `.css('top')`/`.position()` where it
     * expects a number.
     *
     * Because the three-direction loop below reuses ONE window instance
     * sequentially, whichever direction runs FIRST corrupts it (collapses to
     * height 0) and every direction after that finds a degenerate window and
     * SKIPs — a skip that reads as "not applicable" when the real story is
     * "already broken by the test's own prior step". `['se','nw','e']` order
     * meant `se` always ran on the one clean window and always looked like a
     * PASS (its own assertion only checked "some dimension changed by
     * >1px", which a collapse to a negative height satisfies), while `nw`
     * and `e` never got a fresh window to test at all.
     *
     * The fix: capture `resizeTarget`'s OWN `style.cssText` once, before any
     * direction runs (it is still pristine and never-resized at that point
     * — the opening loop and the round-robin sweep above only click/focus
     * it, never drag it), then `resetWindowStyle` re-applies that exact
     * string before every direction so each of the three starts from
     * IDENTICAL geometry — same `calc()` `top` (the exact condition that
     * reproduces the defect — see above), same width/height, same screen
     * position. A close+reopen BETWEEN directions was tried first and
     * rejected: `UIWindow.js`'s cascade offset (`default_window_top`)
     * advances on every `open()`, including relaunches, so relaunching
     * before each of 3 directions walked the target across the screen and
     * into occlusion by `preview`/`code` (still sitting at THEIR original,
     * un-advanced cascade position) — `nw` specifically skipped again, but
     * now for a genuinely different reason (real occlusion by a neighbor)
     * than before (self-corruption). A style reset carries no cascade
     * counter and cannot drift the window anywhere.
     */
    /** Re-applies a previously captured `style.cssText` to `app`'s window —
     * see the doc block above for why this, and not a close+reopen, is what
     * runs BETWEEN directions. A pure style write, no relaunch: it cannot
     * advance the cascade counter and cannot change which app is topmost
     * (z-index travels with the captured string, but `ensureNotTopmost`
     * re-evaluates and re-buries live z-order right before every direction
     * regardless, so a stale z-index here is harmless). */
    async function resetWindowStyle (app, cssText) {
        if ( ! cssText ) return;
        await page.evaluate(([a, css]) => {
            const win = document.querySelector(`.window[data-app="${a}"]`);
            if ( win ) win.style.cssText = css;
        }, [app, cssText]);
        await settle(app);
    }

    /**
     * 🔴 GAP 3 REGRESSION TEST. `UIWindow.js` binds `focusWindow()` to
     * `mousedown` on `.ui-resizable-handle` (delegated on `el_window`, since
     * jQuery UI's `.resizable()` appends each handle as a DIRECT CHILD of the
     * window, not of `.window-head`/`.window-body`) so grabbing a BURIED
     * window's resize handle both raises it AND still lets the resize
     * proceed — see that file's own comment block next to the binding.
     * Nothing in any of the eight shell suites asserted this before this
     * test: deleting the binding turns nothing red anywhere. Covers more
     * than one handle direction — the only prior verification of this
     * mechanism ever grabbed "se".
     *
     * Two independent claims, asserted separately so a failure names which
     * one broke: (1) the window is topmost immediately on `mousedown`,
     * before any drag movement — proving raise is bound to the handle
     * itself, not incidentally caused by the resize completing; (2) the
     * window's rect actually changed size after the drag — proving the
     * `.resizable()` mechanism itself still works (no
     * `preventDefault()`/`stopPropagation()` regression on the same handler).
     */
    async function testResizeHandleRaisesAndResizes (app, handleDir, contenders, label) {
        await ensureNotTopmost(app, contenders);
        const before = await rectOf(app);
        // 🔴 Same reasoning as `titlebarPoint` above (see its own doc block):
        // "the geometric midpoint of the handle's own rect" and "a pixel
        // this window is CURRENTLY visibly on top at" are different claims
        // once windows overlap — and burying `app` a moment ago is exactly
        // what can put a contender on top of its resize handle's corner/edge
        // too. Scan the handle's own rect for a pixel `app` actually owns
        // right now; only that pixel is a real click target.
        const handle = await page.evaluate(([a, dir]) => {
            const win = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! win || win.classList.contains('ezil-fullbleed') ) return null;
            const el = win.querySelector(`.ui-resizable-${dir}`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            if ( r.width === 0 || r.height === 0 ) return null;
            const ownsPixel = (x, y) => {
                const hit = document.elementFromPoint(x, y);
                const hitWin = hit?.closest?.('.window');
                return !! hitWin && hitWin.getAttribute('data-app') === a;
            };
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            if ( ownsPixel(cx, cy) ) return { x: cx, y: cy };
            const STEPS = 5;
            for ( let i = 0; i <= STEPS; i++ ) {
                for ( let j = 0; j <= STEPS; j++ ) {
                    const x = r.left + (r.width * i) / STEPS;
                    const y = r.top + (r.height * j) / STEPS;
                    if ( ownsPixel(x, y) ) return { x, y };
                }
            }
            return null; // the whole handle is currently covered by another window
        }, [app, handleDir]);
        if ( ( ! handle || ! before ) && process.env.DEBUG_RESIZE_HANDLE ) {
            // Diagnostic only, same convention as `DEBUG_CONSOLE` above: not
            // asserted, just enough geometry printed to tell "handle genuinely
            // absent/zero-size" apart from "handle exists but every sampled
            // pixel is occluded" without re-instrumenting this by hand again.
            const dbg = await page.evaluate(([a, dir]) => {
                const win = document.querySelector(`.window[data-app="${a}"]`);
                const el = win?.querySelector(`.ui-resizable-${dir}`);
                return { winRect: win?.getBoundingClientRect(), handleRect: el?.getBoundingClientRect() };
            }, [app, handleDir]);
            console.error(`DEBUG_RESIZE_HANDLE ${app} ${handleDir}:`, JSON.stringify(dbg));
        }
        if ( ! handle || ! before ) {
            skip(`${label}: ${app}'s "${handleDir}" resize-handle raise+resize test (no visible resize handle right now — not resizable, or full-bleed hides it by design)`);
            return;
        }

        await page.mouse.move(handle.x, handle.y);
        await page.mouse.down();
        // Raise must happen on mousedown ITSELF, before any drag movement —
        // read z-order now, not after the drag completes.
        await sleep(50);
        const zAfterDown = topmostOf(await allZIndexes(contenders));

        const DELTA = {
            n: [0, -30], s: [0, 30], e: [30, 0], w: [-30, 0],
            ne: [30, -30], nw: [-30, -30], se: [30, 30], sw: [-30, 30],
        }[handleDir] ?? [30, 30];
        await page.mouse.move(handle.x + DELTA[0], handle.y + DELTA[1], { steps: 8 });
        await page.mouse.up();
        await settle(app);
        const after = await rectOf(app);

        push(`${label}: grabbing ${app}'s "${handleDir}" resize handle raises it (buried -> top on mousedown)`,
            zAfterDown === app, `afterDown=${zAfterDown}`);
        coveredIds.add(app);

        // 🔴 GAP 3 FOLLOW-UP, PART 2 — a REAL defect this exact check used to
        // wave through. The old assertion was `Math.abs(width delta) > 1 ||
        // Math.abs(height delta) > 1` — ANY dimension moving by more than a
        // pixel in EITHER direction counted as "actually resizes it". MEASURED
        // on baseline: dragging `se` by (+30,+30) produced
        // `after.height === 0` (the window's height collapsed entirely — see
        // `closeAndReopenFresh`'s doc block for the root cause) while width
        // grew from 760 to 790, and the old OR-check called that a PASS. A
        // window that is 790 wide and 0 tall is not "resized", it is broken,
        // and a check that cannot tell the difference has no discriminating
        // power over the one failure mode this test exists to catch.
        //
        // The fix asserts what a correct resize actually looks like for
        // WHICHEVER axes this specific handle direction touches:
        //   1. the window never collapses to a degenerate size on EITHER
        //      axis, even the axis this handle isn't supposed to touch;
        //   2. the axis (or axes) this handle direction resizes grew by a
        //      substantial, direction-correct amount (every `DELTA` above is
        //      an outward drag, so the resized axis must GROW, not shrink);
        //   3. the axis this handle does NOT touch stays put (proves the
        //      resize is precise to the handle grabbed, not a side effect).
        const AFFECTS = {
            n: { w: false, h: true }, s: { w: false, h: true },
            e: { w: true, h: false }, w: { w: true, h: false },
            ne: { w: true, h: true }, nw: { w: true, h: true },
            se: { w: true, h: true }, sw: { w: true, h: true },
        }[handleDir] ?? { w: true, h: true };
        const MIN_GROWTH = 10; // drag is 30px; generous slack for containment/snapping
        const STABLE = 3; // an untouched axis should not move at all beyond noise
        const notDegenerate = !! after && after.width > 0 && after.height > 0;
        const widthOk = ! after ? false
            : AFFECTS.w ? (after.width - before.width) > MIN_GROWTH
                : Math.abs(after.width - before.width) <= STABLE;
        const heightOk = ! after ? false
            : AFFECTS.h ? (after.height - before.height) > MIN_GROWTH
                : Math.abs(after.height - before.height) <= STABLE;
        const resized = notDegenerate && widthOk && heightOk;
        push(`${label}: dragging ${app}'s "${handleDir}" resize handle actually resizes it (grows the axis it owns, leaves the other alone, never collapses)`,
            resized, `before=${JSON.stringify(before)} after=${JSON.stringify(after)} affects=${JSON.stringify(AFFECTS)}`);
        coveredIds.add(app);
    }

    // ═════════════════════════════════════════════════════════════════════
    // BOOT
    // ═════════════════════════════════════════════════════════════════════
    push(`${VP} bundle exposes window.ezil`, !! (await page.evaluate(() => typeof window.ezil === 'object')));

    // ═════════════════════════════════════════════════════════════════════
    // THE DATA-DRIVEN CORE — read the LIVE registry `boot.js` itself uses.
    // No literal app-id list anywhere in this file from here down.
    // ═════════════════════════════════════════════════════════════════════
    await until(() => {
        const R = window.ezil?.registry;
        return Array.isArray(R?.APPS) && R.APPS.length > 0;
    }, undefined);
    const registryApps = await page.evaluate(() => window.ezil.registry.APPS.map((a) => ({
        id: a.id,
        name: a.name,
        pinned: !! a.pinned,
        single_instance: !! a.single_instance,
        shell_local: !! a.shell_local,
        wants_settings_in_drawer: !! a.wants_settings_in_drawer,
    })));
    push(`${VP} registry exposes a non-empty APPS list`, Array.isArray(registryApps) && registryApps.length > 0,
        `APPS=${JSON.stringify(registryApps?.map((a) => a.id))}`);
    if ( ! registryApps || registryApps.length === 0 ) {
        push(`${VP} cannot continue without a registry`, false, 'aborting this viewport');
        await page.close();
        return;
    }

    const resolvedApps = await page.evaluate(() => window.ezil.registry.resolve(window.__EZIL_BOOT__).map((a) => a.id));
    push(`${VP} registry resolved at least one app for this boot payload`, resolvedApps.length > 0,
        `resolved=${JSON.stringify(resolvedApps)}`);

    const bootAppId = resolvedApps[0];
    const otherAppIds = resolvedApps.slice(1);
    const bootAppDescriptor = registryApps.find((a) => a.id === bootAppId);

    // 🔴 GAP 1 FIX (round 7's verifier: the coverage guard could not fail).
    // `coveredIds` is populated ONLY inside the four real per-app assertion
    // helpers above (`assertHitTestsIntoSelf`, `checkContentPainted`,
    // `raiseByTitlebarClick`, `raiseByTaskbarItemClick`) at the exact moment
    // each one actually `push()`es a real PASS/FAIL for that app — never by
    // this loop merely reaching or opening an id. The old code did
    // `coveredIds.add(id)` unconditionally, over the SAME list the GUARD
    // later compared it against, which made "every resolved app got a
    // scenario" true by construction — it could not have failed no matter
    // what the loop body did or skipped. See the MUTATION SELF-TEST block
    // near the GUARD below for the runnable proof.
    //
    // `openIds` is a SEPARATE, unrelated bookkeeping set: only for building
    // the "contenders" list passed to z-index "topmost" comparisons below
    // (raise-by-click needs `id` itself in that list to ever register as
    // topmost). It has nothing to do with the coverage guard and must never
    // be read by it.
    const coveredIds = new Set();
    const openIds = new Set();

    // ── boot app: opened by boot.js itself (`apps[0]`), not by this harness ──
    const bootWinOk = await until((id) => !! document.querySelector(`.window[data-app="${id}"]`), bootAppId);
    push(`${VP} boot app "${bootAppId}" window opened`, !! bootWinOk);

    if ( bootAppDescriptor?.wants_settings_in_drawer ) {
        await until((id) => document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed'), bootAppId);
        await settle(bootAppId);
        const fullbleed = await page.evaluate((id) =>
            document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed') === true, bootAppId);
        push(`${VP} boot app "${bootAppId}" reached full-bleed`, fullbleed, `z=${await zIndexOf(bootAppId)}`);
        await settleContentPainted(bootAppId);
        await checkContentPainted(bootAppId, `${VP} boot app "${bootAppId}" (full-bleed)`);
    } else {
        await settle(bootAppId);
        await assertHitTestsIntoSelf(bootAppId, `${VP} boot app "${bootAppId}"`);
        await checkTaskbarReachable(`${VP} boot app "${bootAppId}" alone`);
        await settleContentPainted(bootAppId);
        await checkContentPainted(bootAppId, `${VP} boot app "${bootAppId}" alone`);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Feature test: the full-bleed drawer's Settings escape hatch — named,
    // not generic (the drawer is a specific, documented feature, not a
    // per-app mechanism), and gated so it degrades to a SKIP rather than a
    // false FAIL if a future registry ever drops `settings`.
    // ═════════════════════════════════════════════════════════════════════
    if ( bootAppDescriptor?.wants_settings_in_drawer && resolvedApps.includes('settings') ) {
        const drawerBtnExists = await page.evaluate((id) =>
            !! document.querySelector(`.window[data-app="${id}"] .dashboard-app-drawer-settings`), bootAppId);
        if ( push(`${VP} control drawer carries a Settings button`, drawerBtnExists) ) {
            // 🔴 DOM `.click()`, not `page.mouse.click()` — the drawer only
            // REVEALS its buttons on hover/tap (a CSS affordance this
            // feature test is not trying to prove); same reasoning and same
            // mechanism the original file used. Every OTHER click in this
            // file is a real `page.mouse.click()` — see the file header for
            // why that distinction matters for occlusion/raise checks.
            await page.evaluate((id) =>
                document.querySelector(`.window[data-app="${id}"] .dashboard-app-drawer-settings`)?.click(), bootAppId);
            await until(() => !! document.querySelector('.window[data-app="settings"]'), undefined);
            await settle('settings');
            push(`${VP} SCENARIO: Settings opened from the full-bleed drawer`,
                !! (await page.evaluate(() => !! document.querySelector('.window[data-app="settings"]'))));
            await assertHitTestsIntoSelf('settings', `${VP} Settings (full-bleed, opened from drawer)`);
            await settleContentPainted('settings');
            await checkContentPainted('settings', `${VP} Settings (full-bleed, opened from drawer)`);
            // 🔴 no manual `coveredIds.add('settings')` here — the two calls
            // above already recorded it themselves, for real, if and only if
            // they actually asserted something. See the GAP 1 comment block.
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Expose the REAL taskbar (minimize the boot app if it hides it), then
    // open every other registered app one at a time, testing each as it
    // lands — the cascade offset (`default_window_top`, UIWindow.js) grows
    // by 20px per window opened this session, so later apps land LOWER and
    // are MORE likely to reach the taskbar. This is the reproduction shape
    // for the occlusion defect, not an artificial worst case.
    // ═════════════════════════════════════════════════════════════════════
    if ( bootAppDescriptor?.wants_settings_in_drawer ) {
        await minimizeApp(bootAppId);
        await until((id) => document.querySelector(`.window[data-app="${id}"]`)?.getAttribute('data-is_minimized') === 'true', bootAppId);
        await sleep(80); // exit_fullpage_mode's own geometry transition before hideWindow
        push(`${VP} boot app "${bootAppId}" minimized (real taskbar now on screen)`,
            await taskbarVisible());
    }
    await checkTaskbarReachable(`${VP} after exposing the real taskbar, before opening other apps`);

    for ( const id of otherAppIds ) {
        const already = await page.evaluate((a) => !! document.querySelector(`.window[data-app="${a}"]`), id);
        if ( ! already ) {
            await page.evaluate(({ a, ctx }) => window.ezil.registry.launch(a, ctx), {
                a: id,
                ctx: { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState },
            });
            await until((a) => !! document.querySelector(`.window[data-app="${a}"]`), id, 8000, 50);
        }
        await settle(id);

        const opened = await page.evaluate((a) => !! document.querySelector(`.window[data-app="${a}"]`), id);
        push(`${VP} SCENARIO: "${id}" window opened`, opened);
        // 🔴 GAP 1 FIX: `continue` here now genuinely means "not covered" —
        // nothing below adds `id` to `coveredIds` (or even `openIds`) unless
        // this line is passed. The old code added to `coveredIds`
        // unconditionally BEFORE this exact check, which is the tautology
        // round 7's verifier found.
        if ( ! opened ) continue;
        openIds.add(id); // bookkeeping only — see the comment where this Set is declared.

        await assertHitTestsIntoSelf(id, `${VP} "${id}" (just opened)`);
        await checkTaskbarReachable(`${VP} after opening "${id}"`);
        await settleContentPainted(id);
        await checkContentPainted(id, `${VP} "${id}" (just opened)`);

        const soFar = [...openIds];
        await raiseByTitlebarClick(id, soFar, `${VP} "${id}"`);
        await raiseByTaskbarItemClick(id, soFar, `${VP} "${id}"`);
    }

    // ═════════════════════════════════════════════════════════════════════
    // Round-robin, ALL other apps open simultaneously — the deepest cascade
    // this session reaches, and the point at which one window's geometry is
    // most likely to cover both the taskbar AND an earlier window's
    // titlebar. This is the "every pairwise combination that matters" sweep:
    // with every window competing at once, raising each one in turn against
    // ALL the others covers strictly more than any hand-picked pair would.
    // ═════════════════════════════════════════════════════════════════════
    if ( otherAppIds.length > 1 ) {
        for ( const id of [...otherAppIds].reverse() ) {
            await raiseByTitlebarClick(id, otherAppIds, `${VP} round-robin (all windows open)`);
            await checkTaskbarReachable(`${VP} round-robin: after raising "${id}" (all windows open)`);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // GAP 3 REGRESSION — a BURIED window's resize handle must both raise it
    // (UIWindow.js's `$(el_window).on('mousedown', '.ui-resizable-handle', …)`
    // binding) AND still resize it (jQuery UI's own `.resizable()`, wired
    // separately). Deleting that binding turned nothing red anywhere in the
    // eight shell suites before this test existed — see this file's own
    // report for the mutation proof (a scratch copy with the binding
    // removed). Exercised on more than one handle direction: the only prior
    // verification of this binding ever grabbed "se".
    // ═════════════════════════════════════════════════════════════════════
    if ( otherAppIds.length > 0 ) {
        const resizeTarget = otherAppIds[0];
        // 🔴 NOT `[bootAppId, ...otherAppIds]`: the full-bleed boot app is
        // `data-stay_on_top="true"` (`UIWindow.js` ~L122-124, set whenever
        // `window.is_fullpage_mode`), which pins its z-index to a fixed
        // ~99999999 band that NEVER changes on focus (`window_zindex_base`,
        // ~L4111-4114) and is always higher than any ordinary window's
        // small counter-based z-index. Including it here would make
        // "settings/preview/code is topmost" permanently unsatisfiable —
        // the exact "broken assertion, not a product bug" trap this file's
        // own `titlebarPoint` doc block warns about. Every OTHER real
        // per-app raise check in this file (`otherAppIds` loop, round-robin)
        // already excludes it for the same reason.
        const resizeContenders = [...otherAppIds];
        // 🔴 `resizeTarget` is STILL its own pristine, never-resized self
        // here — the "otherAppIds" opening loop and the round-robin sweep
        // above only ever click/focus it, never drag it — so its CURRENT
        // `style.cssText` (captured once, before any direction runs) IS the
        // fresh baseline. `resetWindowStyle` re-applies that captured string
        // before every direction so each of the three starts from IDENTICAL
        // geometry instead of inheriting whatever the previous drag left
        // behind. Without this, only the FIRST direction in the list ever
        // saw an uncorrupted window and the other two SKIPped — exactly what
        // made `nw` and `e` read as "100% SKIP, every viewport, every run"
        // before this fix: they were never actually exercised, not "not
        // applicable". (A per-direction close+reopen was tried first and
        // rejected — see `closeAndReopenFresh`'s doc block for why an extra
        // relaunch, even just once, is already one cascade step too many.)
        const pristineStyle = await page.evaluate(
            (a) => document.querySelector(`.window[data-app="${a}"]`)?.style.cssText, resizeTarget);
        for ( const dir of ['se', 'nw', 'e'] ) {
            await resetWindowStyle(resizeTarget, pristineStyle);
            await testResizeHandleRaisesAndResizes(resizeTarget, dir, resizeContenders, `${VP} resize-handle regression`);
        }
    }

    // ═════════════════════════════════════════════════════════════════════
    // Restore the boot app — regression check: it must still be able to
    // reclaim the screen, and an ordinary window opened earlier must not
    // have made it permanently unreachable. See the original file's
    // Scenario 2/3 comments for why "the most-recently-raised window wins"
    // is correct window-manager behaviour, not the bug being guarded here.
    // ═════════════════════════════════════════════════════════════════════
    if ( bootAppDescriptor?.wants_settings_in_drawer ) {
        await raiseByTaskbarItemClick(bootAppId, resolvedApps, `${VP} restore`);
        await until((id) => document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed'), bootAppId);
        await settle(bootAppId);
        const restored = await page.evaluate((id) => ({
            minimized: document.querySelector(`.window[data-app="${id}"]`)?.getAttribute('data-is_minimized'),
            fullbleed: document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed'),
        }), bootAppId);
        push(`${VP} boot app "${bootAppId}" restored to full-bleed`,
            restored.minimized !== 'true' && restored.fullbleed === true, JSON.stringify(restored));

        if ( otherAppIds.length > 0 ) {
            const otherRect = await rectOf(otherAppIds[0]);
            const covered = otherRect ? await hitTest(otherRect.left + otherRect.width / 2, otherRect.top + otherRect.height / 2) : null;
            push(`${VP} regression: restoring the boot app still raises it above an ordinary window opened earlier`,
                !! otherRect && covered?.inWindow === bootAppId,
                `otherRect=${JSON.stringify(otherRect)} hit=${JSON.stringify(covered)}`);
        }

        push(`${VP} full-bleed still fills the viewport (geometry, independent of z-index)`,
            await page.evaluate((id) => {
                const r = document.querySelector(`.window[data-app="${id}"]`).getBoundingClientRect();
                return r.width >= window.innerWidth - 1 && r.height >= 0;
            }, bootAppId));
    }

    // ═════════════════════════════════════════════════════════════════════
    // 🔴 MUTATION SELF-TEST for the GUARD immediately below. Opt-in
    // (`MUTATION_PROVE_GAP1=1`, first viewport only) so ordinary runs are
    // unaffected — this is a standing, re-runnable proof that the guard can
    // still fail, not a permanent extra scenario. Round 7's verifier found
    // the previous guard could NEVER fail: `coveredIds.add(id)` ran
    // unconditionally, over the very list (`resolvedApps`) it was later
    // compared against, so the two were identical by construction.
    //
    //   (a) "zz-mutation-unexercised" is spliced into `resolvedApps` ONLY —
    //       it is never opened, never asserted, never added to `coveredIds`
    //       by anything. This is the purest form of "a registered app this
    //       run never exercised": if the GUARD still passes with this id
    //       unaccounted for, `coveredIds` is being derived FROM
    //       `resolvedApps` (the exact tautology), not from real assertions.
    //   (b) "zz-mutation-noassert" is a REAL `.window[data-app]` element
    //       (so "opened" is genuinely true) with no titlebar, no button, no
    //       taskbar item and no `.window-body`. It is run through the ACTUAL
    //       shipped assertion helpers (not a stand-in), each of which can
    //       only `skip()` it. This proves "opened but never actually
    //       asserted" does not buy coverage either.
    //
    // Both must appear in `notCovered` and make the GUARD FAIL. If either
    // does not, the guard is tautological again.
    // ═════════════════════════════════════════════════════════════════════
    if ( process.env.MUTATION_PROVE_GAP1 && vp === VIEWPORTS[0] ) {
        resolvedApps.push('zz-mutation-unexercised');

        await page.evaluate(() => {
            const el = document.createElement('div');
            el.className = 'window';
            el.setAttribute('data-app', 'zz-mutation-noassert');
            document.body.appendChild(el);
        });
        resolvedApps.push('zz-mutation-noassert');
        const dummyContenders = [...openIds, 'zz-mutation-noassert'];
        await assertHitTestsIntoSelf('zz-mutation-noassert', `${VP} MUTATION SELF-TEST`);
        await checkContentPainted('zz-mutation-noassert', `${VP} MUTATION SELF-TEST`);
        await raiseByTitlebarClick('zz-mutation-noassert', dummyContenders, `${VP} MUTATION SELF-TEST`);
        await raiseByTaskbarItemClick('zz-mutation-noassert', dummyContenders, `${VP} MUTATION SELF-TEST`);
        push(`${VP} MUTATION SELF-TEST: the unassertable dummy recorded ZERO real assertions`,
            ! coveredIds.has('zz-mutation-noassert'),
            `coveredIds has it = ${coveredIds.has('zz-mutation-noassert')}`);
        await page.evaluate(() => document.querySelector('.window[data-app="zz-mutation-noassert"]')?.remove());
    }

    // ═════════════════════════════════════════════════════════════════════
    // 🔴 THE GUARD. Fails if this harness's own loop skipped a registered,
    // resolved app — the exact shape of bug that let the Code window ship
    // untested. Also fails if `resolve()` itself silently dropped a
    // shell-local app (every shell-local app must resolve regardless of the
    // boot payload's `apps` list — that is the whole point of the flag).
    // ═════════════════════════════════════════════════════════════════════
    const notCovered = resolvedApps.filter((id) => ! coveredIds.has(id));
    push(`${VP} GUARD: every app the registry resolved for this boot got a scenario`,
        notCovered.length === 0 && coveredIds.size >= resolvedApps.length,
        `resolved=${JSON.stringify(resolvedApps)} covered=${JSON.stringify([...coveredIds])} notCovered=${JSON.stringify(notCovered)}`);

    const shellLocalIds = registryApps.filter((a) => a.shell_local).map((a) => a.id);
    const shellLocalMissing = shellLocalIds.filter((id) => ! resolvedApps.includes(id));
    push(`${VP} GUARD: every shell-local app in the full registry resolved for this boot`,
        shellLocalMissing.length === 0,
        `shellLocal=${JSON.stringify(shellLocalIds)} resolved=${JSON.stringify(resolvedApps)} missing=${JSON.stringify(shellLocalMissing)}`);

    push(`${VP} no uncaught page errors during this viewport's run`, page_errors.length === 0, JSON.stringify(page_errors));
    allPageErrors.push(...page_errors);

    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP 2 — THE MISSING SEVENTH OMISSION: close, then reopen, every registered
// app, at several real-time intervals.
// ═══════════════════════════════════════════════════════════════════════════
// Round 7's verifier, verbatim: "React → an entry path → a soft navigation →
// paint order → the new window missing from the paint test → what a window
// paints inside itself → an app closed and reopened." Every earlier round
// (this file, `boot-test.mjs`, `settings-test.mjs`) opens windows and leaves
// them open for the rest of the run. None of them ever closes one and then
// asks the shell to open it again.
//
// The five intervals below straddle a REAL boundary in `$.fn.close`
// (`UIWindow.js`): closing the last window of an app schedules the matching
// `.taskbar-item`'s removal via `window.remove_taskbar_item`, whose own
// `.animate({width:0}, 200, callback)` does not call `$(item).remove()`
// until ~200ms later — regardless of `window.animate_window_closing` (which
// only affects the WINDOW's own removal, not the taskbar item's). A reopen
// inside that window reuses the about-to-be-deleted taskbar item (`launch()`
// only creates a fresh one when `$('.taskbar-item[data-app]').length === 0`);
// a reopen after it has already elapsed gets a clean new one. 20/50/112ms
// sit below that boundary, 250/500ms sit above it — this is not a blind
// sweep, it is the reproduction shape for the exact defect class this task
// was told about (D1: a stale animate callback deletes a taskbar item out
// from under a window that reused it; D2: `close()`'s internal teardown is
// not fully awaited before its promise resolves, so a fast reopen can race
// it; D3: a deferred `focusWindow()` call — `showWindow`'s own 80ms delayed
// re-focus, or a stray one from an earlier click — can fire against an
// iframe that this close/reopen cycle has since detached, hitting the
// unguarded `contentWindow.postMessage` at `UIWindow.js` ~L4176).
//
// This function does not diagnose which one fires when — that is the
// sibling task's job (`UIWindow.js`/`UIDesktopFullpage.js`/`registry.js`,
// none of which this file may touch). Its only job is to make the failure
// visible: exactly 1 window, exactly 1 taskbar item, the window visible,
// minimise-then-restore working, and zero uncaught page errors, after every
// close/reopen pair, for every registered app, at every interval.
// (`CLOSE_REOPEN_INTERVALS_MS` itself is declared near the top of this file,
// module scope, so it is initialized before the top-level execution flow
// calls this function — see that declaration's own comment.)

async function runCloseReopenSweep () {
    const VP = '[close-reopen]';
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
        if ( process.env.DEBUG_CONSOLE ) console.log('CONSOLE:', msg.type(), msg.text());
        if ( msg.type() !== 'error' ) return;
        if ( /Failed to load resource.*404/.test(msg.text()) ) return;
        page_errors.push(msg.text());
    });

    await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if ( url === `${HOST}/os` ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
            return;
        }
        if ( url.includes('/api/') ) {
            const body = stub(url, req.method(), req.postData());
            await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
            return;
        }
        if ( url.startsWith(HOST) ) {
            await route.fulfill({ status: 404, body: '' });
            return;
        }
        await route.continue();
    });

    await page.goto(`${HOST}/os`, { waitUntil: 'load' });
    await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
    await page.addScriptTag({ content: icons });
    await page.addScriptTag({ content: bundle });

    // ── minimal, self-contained per-page helpers (deliberately NOT shared
    // with `runViewport`'s closures — this function owns its own page) ──────
    async function until (fn, arg, ms = 6000, step = 50) {
        const deadline = Date.now() + ms;
        for ( ;; ) {
            const v = await page.evaluate(fn, arg);
            if ( v ) return v;
            if ( Date.now() > deadline ) return null;
            await sleep(step);
        }
    }

    async function settle (app, { timeout = 1000, step = 60 } = {}) {
        const read = () => page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"]`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return `${r.top.toFixed(1)}|${r.left.toFixed(1)}|${r.width.toFixed(1)}|${r.height.toFixed(1)}`;
        }, app);
        let prev = await read();
        const deadline = Date.now() + timeout;
        while ( Date.now() < deadline ) {
            await sleep(step);
            const cur = await read();
            if ( cur !== null && cur === prev ) return true;
            prev = cur;
        }
        return false;
    }

    /** Real close path: the titlebar close button when it exists and is
     * visible, else the full-bleed control drawer's close button (a plain
     * DOM `.click()` — the drawer only REVEALS its buttons on hover, which
     * is not the affordance under test here), else `$.fn.close()` directly
     * as a last resort (never reached by any currently-registered app, kept
     * so this sweep degrades gracefully instead of hanging on a future one
     * that has neither). */
    async function closeApp (a) {
        await page.evaluate((app) => {
            const win = document.querySelector(`.window[data-app="${app}"]`);
            if ( ! win ) return;
            const closeBtn = win.querySelector('.window-close-btn');
            if ( closeBtn && closeBtn.offsetParent !== null ) { closeBtn.click(); return; }
            const drawerClose = win.querySelector('.dashboard-app-drawer-close');
            if ( drawerClose ) { drawerClose.click(); return; }
            $(win).close();
        }, a);
    }

    /** Real reopen path: the SAME registry entry point every other launch in
     * this file goes through — never a direct DOM/constructor call. */
    async function reopenApp (a) {
        await page.evaluate(({ app, ctx }) => window.ezil.registry.launch(app, ctx), {
            app: a, ctx: { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState },
        });
    }

    async function minimizeApp (a) {
        await page.evaluate((app) => {
            const $win = $(`.window[data-app="${app}"]`);
            const $btn = $win.find('.window-minimize-btn');
            if ( $btn.length && $btn.is(':visible') ) { $btn.trigger('click'); return; }
            const drawer = document.querySelector(`.window[data-app="${app}"] .dashboard-app-drawer`);
            const btn = drawer?.querySelector(
                '.dashboard-app-drawer-btn:not(.dashboard-app-drawer-settings):not(.dashboard-app-drawer-close)',
            );
            btn?.click();
        }, a);
    }

    async function taskbarItemPoint (a) {
        return page.evaluate((app) => {
            const el = document.querySelector(`.taskbar-item[data-app="${app}"]`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            if ( r.width === 0 || r.height === 0 ) return null;
            return [r.left + r.width / 2, r.top + r.height / 2];
        }, a);
    }

    await until(() => Array.isArray(window.ezil?.registry?.APPS) && window.ezil.registry.APPS.length > 0, undefined);
    const resolvedApps = await page.evaluate(() => window.ezil.registry.resolve(window.__EZIL_BOOT__).map((a) => a.id));
    push(`${VP} registry resolved at least one app for close/reopen coverage`, resolvedApps.length > 0,
        `resolved=${JSON.stringify(resolvedApps)}`);

    for ( const id of resolvedApps ) {
        // The boot app (apps[0]) is already open from boot.js itself; every
        // other resolved app needs an initial launch before its own sweep.
        const already = await page.evaluate((a) => !! document.querySelector(`.window[data-app="${a}"]`), id);
        if ( ! already ) {
            await reopenApp(id);
            await until((a) => !! document.querySelector(`.window[data-app="${a}"]`), id, 8000, 50);
        }
        await settle(id);

        for ( const interval of CLOSE_REOPEN_INTERVALS_MS ) {
            const label = `${VP} "${id}" close, wait ${interval}ms, reopen`;
            const errorsBefore = page_errors.length;

            await closeApp(id);
            await sleep(interval);
            await reopenApp(id);
            await until((a) => !! document.querySelector(`.window[data-app="${a}"]`), id, 8000, 50);
            await settle(id);

            const state = await page.evaluate((a) => {
                const wins = document.querySelectorAll(`.window[data-app="${a}"]`);
                const items = document.querySelectorAll(`.taskbar-item[data-app="${a}"]`);
                const win = wins[0] ?? null;
                const cs = win ? getComputedStyle(win) : null;
                const r = win ? win.getBoundingClientRect() : null;
                return {
                    windowCount: wins.length,
                    taskbarItemCount: items.length,
                    visible: !! win && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
                };
            }, id);

            push(`${label}: exactly 1 window`, state.windowCount === 1, `windowCount=${state.windowCount}`);
            push(`${label}: exactly 1 taskbar item`, state.taskbarItemCount === 1, `taskbarItemCount=${state.taskbarItemCount}`);
            push(`${label}: the reopened window is visible`, state.visible, JSON.stringify(state));

            // 🔴 `.fullpage-mode .window-minimize-btn { display: none }`
            // (`shell/src/css/style.css`) hides EVERY window's minimize
            // button, site-wide, whenever the boot app is in full-bleed mode
            // — not just the full-bleed window's own button. That is a real,
            // pre-existing, already-documented shell characteristic (see
            // this file's own `buttonPointInside` comment), independent of
            // close/reopen and out of scope for D1/D2/D3 — it is CSS, not
            // `UIWindow.js`/`UIDesktopFullpage.js`/`registry.js`. Ordinary
            // (non-drawer) windows have no other way to minimize, so when
            // neither affordance is currently reachable this is a SKIP, not
            // a FAIL — same reasoning `checkTaskbarReachable` above uses for
            // "the taskbar is legitimately hidden by full-bleed mode".
            const minimizeAffordance = state.windowCount >= 1 ? await page.evaluate((a) => {
                const win = document.querySelector(`.window[data-app="${a}"]`);
                const btn = win?.querySelector('.window-minimize-btn');
                const btnReachable = !! btn && getComputedStyle(btn).display !== 'none'
                    && btn.getBoundingClientRect().width > 0;
                const drawerBtn = win?.querySelector(
                    '.dashboard-app-drawer-btn:not(.dashboard-app-drawer-settings):not(.dashboard-app-drawer-close)',
                );
                return btnReachable || !! drawerBtn;
            }, id) : false;

            let minimized = false;
            if ( minimizeAffordance ) {
                await minimizeApp(id);
                minimized = !! await until(
                    (a) => document.querySelector(`.window[data-app="${a}"]`)?.getAttribute('data-is_minimized') === 'true',
                    id, 2000, 30,
                );
                push(`${label}: minimise works`, minimized);
            } else {
                skip(`${label}: minimise (no reachable minimize affordance right now — full-bleed mode hides ordinary minimize buttons site-wide; a pre-existing shell characteristic, not part of this close/reopen sweep)`);
            }

            if ( minimized ) {
                const p = await taskbarItemPoint(id);
                if ( p ) {
                    await page.mouse.click(p[0], p[1]);
                } else {
                    await page.evaluate((a) => {
                        const w = $(`.window[data-app="${a}"]`);
                        if ( w.length ) w.showWindow();
                    }, id);
                }
                await sleep(200);
                await settle(id);
                const restored = await page.evaluate((a) => {
                    const win = document.querySelector(`.window[data-app="${a}"]`);
                    if ( ! win ) return { exists: false };
                    const cs = getComputedStyle(win);
                    const r = win.getBoundingClientRect();
                    return {
                        exists: true,
                        minimized: win.getAttribute('data-is_minimized'),
                        visible: cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
                    };
                }, id);
                push(`${label}: restore works`,
                    restored.exists && restored.minimized !== 'true' && restored.visible, JSON.stringify(restored));
            } else {
                skip(`${label}: restore (minimise never completed — nothing to restore)`);
            }

            const cycleErrors = page_errors.slice(errorsBefore);
            push(`${label}: zero uncaught page errors during this close/reopen cycle`,
                cycleErrors.length === 0, JSON.stringify(cycleErrors));
        }
    }

    allPageErrors.push(...page_errors);
    await page.close();
}
