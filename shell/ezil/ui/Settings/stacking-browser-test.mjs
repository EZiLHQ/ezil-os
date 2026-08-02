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

// 🔴 WAVE F INTEGRATION FIX — HARNESS FIDELITY, NOT AN ASSERTION CHANGE.
// This document copies the REAL `/os` page's element classes from
// `app/src/app/layout.tsx`:
//     <html class="… h-full antialiased">  <body class="min-h-full flex flex-col">
// `h-full` and `min-h-full` are TAILWIND utilities. Tailwind lives in
// `app/src/app/globals.css`, which this harness never loads — it loads only
// the shell's own `bundle.min.css`. So the class names are present and mean
// NOTHING here: MEASURED in this document, `getComputedStyle(html).height`
// and `getComputedStyle(body).height` are both **"0px"** (the real page's
// body is at least viewport-tall), even though `documentElement.clientHeight`
// is a normal 900.
//
// That is not cosmetic. `UIWindow.js` wires `.resizable({ containment:
// 'parent' })`, and a `.window`'s parent here IS `<body>`. jQuery UI clamps a
// resize against the containment box, so with a 0-height container it clamps
// every window's height to `containerHeight - top` — a NEGATIVE number, which
// CSS then renders as 0. MEASURED, via a `resizestart/resize/resizestop`
// listener on the live target (`/tmp/.../scratchpad/probe-resize.mjs`):
//   body height 0px  -> first resize event reports `size:{w:764,h:-155}` on a
//                       window at top=155 (h is exactly `0 - top`), and a
//                       (+30,+30) drag on `se` ends at 790x0.
//   html/body given their REAL height -> the identical drag on the identical
//                       window ends at 790x590, i.e. exactly +30 on both axes.
// Same bundle, same window, same drag; only the container's height differs.
//
// So the 15 resize FAILs this suite reported at integration time were an
// artifact of THIS document, not a defect in `UIWindow.js`. Two earlier
// diagnoses were checked and disproved here: it is NOT `top: calc(15% + Npx)`
// (a window converted to a plain-pixel `top` collapses identically) and it is
// NOT the `resize` handler's toolbar clamp in `UIWindow.js` (`toolbar_height`
// is 0 and `position().top` is 155, so `155 < 0` is false and that branch
// never runs).
//
// The fix is to make the fake document's BOX MODEL match the real one, which
// is what every other geometry assertion in this file has silently assumed all
// along. No assertion is relaxed by this — in particular the direction-aware
// resize check added this wave keeps its full discriminating power: it is the
// very thing that refuses to call a collapse a pass, and it is what goes from
// FAIL to PASS when, and only when, the geometry becomes real.
const DOC_HTML = `<!doctype html><html class="h-full"><head><style>${css}</style>
     <style>html{height:100%}body{min-height:100%}</style></head>
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

// ═══════════════════════════════════════════════════════════════════════════
// GAP 4 (M3a / M5b) — a close that THROWS, and the awaited-teardown
// contract. See `runCloseRobustnessSweep`'s own doc block below.
// ═══════════════════════════════════════════════════════════════════════════
try {
    await runCloseRobustnessSweep();
} catch ( err ) {
    anyHardFailure = true;
    push('[close-robustness] harness threw without completing', false, String(err?.stack ?? err));
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP 5 (M6 / M7 / M8) — the `:not([data-closing="1"])` guards on the
// dashboard-mode popstate handler and its watchdog fallback. See
// `runDashboardPopstateGuardSweep`'s own doc block below.
// ═══════════════════════════════════════════════════════════════════════════
try {
    await runDashboardPopstateGuardSweep();
} catch ( err ) {
    anyHardFailure = true;
    push('[dashboard-popstate] harness threw without completing', false, String(err?.stack ?? err));
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
        // Unconditional (not opt-in) since round 8: the self-test itself is
        // no longer opt-in either — see that block's own comment.
        if ( /zz-mutation/.test(msg.text()) ) return;
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
    // 🔴 D3 INDEPENDENT COVERAGE (round 8's verifier: "Reverting both
    // `?.contentWindow?.` guards changes nothing — 452/456, identical. D3
    // is only visible through D2's race, so if D2 is ever fixed
    // differently, D3 silently loses all coverage.").
    //
    // `$.fn.focusWindow` (`UIWindow.js`) does
    // `$app_iframe.get(0)?.contentWindow?.postMessage({msg:'focus'}, '*')`
    // — guarded per that file's own comment because "a detached iframe (a
    // window mid-close, or one that was reopened while its old iframe
    // hadn't finished teardown) has `contentWindow === null`". The ONLY
    // path the rest of this suite reaches that state through is D2's race
    // (a close/reopen landing in a narrow timing window) — so today, D3's
    // entire coverage is a side effect of D2's, and disappears the moment
    // D2 is fixed by any means that closes the race instead of by keeping
    // this exact guard.
    //
    // This reproduces D3's OWN failure condition directly, with no close,
    // no reopen, no timing window: detach a real window (with a real
    // iframe already loaded) from the live document with a plain
    // `Element.remove()` — the same end state D2's race produces (an
    // iframe whose `contentWindow` the spec sets to `null` the instant its
    // node is disconnected from the document) — then call `.focusWindow()`
    // on it directly, the exact code path the guard lives in. `$(el).find()`
    // and `.hasClass()` both still work on a detached subtree, so this
    // reaches the SAME line D2 does; only the reason `contentWindow` is
    // null differs (direct detachment vs. a race), which is exactly what
    // makes this coverage independent of D2's fix.
    // ═════════════════════════════════════════════════════════════════════
    {
        const d3TargetId = await page.evaluate((ids) => {
            for ( const id of ids ) {
                const win = document.querySelector(`.window[data-app="${id}"]`);
                if ( win && win.querySelector('.window-app-iframe') ) return id;
            }
            return null;
        }, otherAppIds);
        if ( d3TargetId ) {
            // 🔴 The `try`/`catch` is IN the page, not around this
            // `page.evaluate()` call: `.focusWindow()` throws SYNCHRONOUSLY
            // inside the evaluated function when the guard is missing, which
            // Playwright surfaces as a REJECTED `evaluate()` call (not a
            // `pageerror` event — that only fires for exceptions the page's
            // own event loop never catches, e.g. inside a real click
            // handler or a timer, not inside a script this harness is
            // directly awaiting). Left uncaught here, that rejection would
            // abort this ENTIRE viewport's run ("harness threw without
            // completing") — confirmed as an OBSERVED failure mode:
            // reverting the guard while this `try` was still outside the
            // evaluate() call up-front crashed the whole `[1440x900]`
            // (and every later) viewport instead of producing one isolated,
            // readable FAIL, losing every check after it for that viewport.
            // Catching inside the page turns "the mechanism is broken" into
            // exactly one clean, isolated result — same principle as every
            // other risky operation in this file, which never trusts an
            // emulation/DOM effect without reading back a real signal for it.
            const result = await page.evaluate((a) => {
                const win = document.querySelector(`.window[data-app="${a}"]`);
                if ( ! win ) return { targetMissing: true };
                win.remove();
                try {
                    $(win).focusWindow();
                    return { threw: false };
                } catch ( e ) {
                    return { threw: true, message: String(e?.message ?? e) };
                }
            }, d3TargetId);
            push(`${VP} D3 regression: focusWindow() on a window detached directly from the document (no D2 race involved) does not throw`,
                result.threw === false, `target=${d3TargetId} result=${JSON.stringify(result)}`);

            // We bypassed `.close()` entirely (a raw DOM `.remove()`, not
            // real teardown), so this app's taskbar item / bookkeeping never
            // ran its close path. Relaunch it fresh so every check AFTER
            // this one — which assumes every `otherAppIds` entry is a real,
            // on-screen window — still finds one.
            await page.evaluate(({ a, ctx }) => window.ezil.registry.launch(a, ctx), {
                a: d3TargetId,
                ctx: { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState },
            });
            await until((a) => !! document.querySelector(`.window[data-app="${a}"]`), d3TargetId, 6000, 50);
            await settle(d3TargetId);
        } else {
            skip(`${VP} D3 regression: focusWindow() on a detached iframe (no window with a .window-app-iframe found among ${JSON.stringify(otherAppIds)})`);
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
    // 🔴 MUTATION SELF-TEST for the GUARD immediately below — STANDING, runs
    // by default (first viewport only; the guard mechanism itself doesn't
    // vary by viewport, so proving it once per run is enough). Round 7's
    // verifier found the previous guard could NEVER fail: `coveredIds.add(id)`
    // ran unconditionally, over the very list (`resolvedApps`) it was later
    // compared against, so the two were identical by construction.
    //
    // 🔴 ROUND 8 FOLLOW-UP: this used to be opt-in behind
    // `MUTATION_PROVE_GAP1=1`, so an ORDINARY run never executed it and a
    // reintroduced tautology would go uncaught — "the guard against
    // tautologies is itself unenforced". It is a real `push()`ed assertion
    // now, not a side channel a human has to remember to invoke and read by
    // hand. The reason it WAS opt-in: the previous version spliced both
    // dummy ids directly into the SHARED `resolvedApps` array that "THE
    // GUARD" below also reads, with no cleanup — running it unconditionally
    // would have made the REAL guard permanently FAIL on every ordinary
    // run too (both dummies stay uncovered forever), masking any genuine
    // coverage regression behind this self-inflicted one. Fixed by
    // computing the self-test's own predicate over a LOCAL copy of
    // `resolvedApps` and asserting it directly — the shared `resolvedApps`
    // is never mutated, so the real GUARD's own evaluation right after this
    // block is completely unaffected by this one running every time.
    //
    //   (a) "zz-mutation-unexercised" — a plain string, added only to the
    //       LOCAL copy below. Never opened, never asserted, never added to
    //       `coveredIds` by anything. The purest form of "a registered app
    //       this run never exercised": if the GUARD's predicate still
    //       treats a resolved list containing it as fully covered,
    //       `coveredIds` is being derived FROM `resolvedApps` (the exact
    //       tautology), not from real assertions.
    //   (b) "zz-mutation-noassert" is a REAL `.window[data-app]` element
    //       (so "opened" is genuinely true) with no titlebar, no button, no
    //       taskbar item and no `.window-body`. It is run through the ACTUAL
    //       shipped assertion helpers (not a stand-in, and against the REAL,
    //       shared `coveredIds` — proving those helpers genuinely never add
    //       an id they couldn't actually assert anything about), each of
    //       which can only `skip()` it. This proves "opened but never
    //       actually asserted" does not buy coverage either.
    //
    // Both must appear in the LOCAL `notCovered` and make the LOCAL guard
    // predicate false. If either does not, the real GUARD below is
    // tautological again.
    // ═════════════════════════════════════════════════════════════════════
    if ( vp === VIEWPORTS[0] ) {
        await page.evaluate(() => {
            const el = document.createElement('div');
            el.className = 'window';
            el.setAttribute('data-app', 'zz-mutation-noassert');
            document.body.appendChild(el);
        });
        const dummyContenders = [...openIds, 'zz-mutation-noassert'];
        await assertHitTestsIntoSelf('zz-mutation-noassert', `${VP} MUTATION SELF-TEST`);
        await checkContentPainted('zz-mutation-noassert', `${VP} MUTATION SELF-TEST`);
        await raiseByTitlebarClick('zz-mutation-noassert', dummyContenders, `${VP} MUTATION SELF-TEST`);
        await raiseByTaskbarItemClick('zz-mutation-noassert', dummyContenders, `${VP} MUTATION SELF-TEST`);
        push(`${VP} MUTATION SELF-TEST: the unassertable dummy recorded ZERO real assertions`,
            ! coveredIds.has('zz-mutation-noassert'),
            `coveredIds has it = ${coveredIds.has('zz-mutation-noassert')}`);
        await page.evaluate(() => document.querySelector('.window[data-app="zz-mutation-noassert"]')?.remove());

        // The GUARD's own predicate, re-evaluated over a LOCAL copy carrying
        // both dummies — see the block comment above for why this must be a
        // local copy and not the shared `resolvedApps`.
        const selfTestResolvedApps = [...resolvedApps, 'zz-mutation-unexercised', 'zz-mutation-noassert'];
        const selfTestNotCovered = selfTestResolvedApps.filter((id) => ! coveredIds.has(id));
        const selfTestGuardWouldPass = selfTestNotCovered.length === 0
            && coveredIds.size >= selfTestResolvedApps.length;
        push(`${VP} MUTATION SELF-TEST: the coverage GUARD correctly fails when a resolved-but-unexercised app and an assertion-less dummy are injected`,
            selfTestNotCovered.includes('zz-mutation-unexercised')
                && selfTestNotCovered.includes('zz-mutation-noassert')
                && ! selfTestGuardWouldPass,
            `notCovered=${JSON.stringify(selfTestNotCovered)} guardWouldPass=${selfTestGuardWouldPass}`);

        // 🔴 ROUND 9 FOLLOW-UP — H1/H2b: the two checks above simulate THE
        // GUARD's predicate over a LOCAL copy, computed and asserted HERE,
        // BEFORE THE GUARD's own real code runs a few lines down. That
        // ordering is exactly why they are blind to the round-7 tautology
        // reintroduced immediately before THE GUARD's real computation
        // (`resolvedApps.forEach(id => coveredIds.add(id))`): JS runs
        // top-to-bottom, so nothing pasted in AFTER this block can be
        // observed BY this block, no matter how faithfully it simulates the
        // predicate. PROVEN (see wave-g-t20 report): reintroducing that exact
        // line still leaves every check above green — 533/533 exit 0.
        //
        // Fix: inject the canary into the REAL, SHARED `resolvedApps` array
        // (not a local copy) and defer judgment until THE GUARD's own real
        // `notCovered` line, a few statements down, actually runs — so
        // anything pasted in between (the tautology's insertion point,
        // "before THE GUARD") necessarily processes the canary exactly the
        // way it would process a real, silently-dropped app id. The canary
        // can never be legitimately covered — nothing above this line ever
        // opens, hit-tests, or raises an app named this — so if it turns up
        // "covered" by the time THE GUARD reads `coveredIds`, something
        // between here and there added it without a real assertion. Removed
        // again immediately after judgment, before THE GUARD's real
        // pass/fail for the ACTUAL resolved apps is computed, so this
        // self-test can never itself make an ordinary run's real GUARD fail.
        resolvedApps.push('zz-mutation-tautology-canary');
    }

    // ═════════════════════════════════════════════════════════════════════
    // 🔴 THE GUARD. Fails if this harness's own loop skipped a registered,
    // resolved app — the exact shape of bug that let the Code window ship
    // untested. Also fails if `resolve()` itself silently dropped a
    // shell-local app (every shell-local app must resolve regardless of the
    // boot payload's `apps` list — that is the whole point of the flag).
    // ═════════════════════════════════════════════════════════════════════
    // 🔴 ROUND 9 FOLLOW-UP — H1/H2b, part 2. `rawNotCovered` below is THE ONE
    // AND ONLY computation of "which resolved app id has no entry in
    // `coveredIds`" in this whole file — the canary (if the self-test above
    // injected it, first viewport only) rides through this EXACT SAME
    // `.filter()` call, over the EXACT SAME shared `resolvedApps`/
    // `coveredIds`, that a real dropped app would. There is no separate
    // "judge the canary" line positioned somewhere for a mutation to land
    // before: whatever runs between the self-test's injection and THIS line
    // — including a reintroduced round-7 tautology
    // (`resolvedApps.forEach(id => coveredIds.add(id))`), wherever it is
    // pasted — necessarily executes before `rawNotCovered` is computed and
    // therefore necessarily affects the canary's fate identically to a real
    // one's. The canary can never be legitimately covered (nothing above
    // ever opens/asserts an app by this name), so if it is missing from
    // `rawNotCovered` — i.e. something already decided it was "covered" —
    // that is the tautology, caught at the guard's own single point of
    // truth instead of in an early proxy that runs before the mutation does.
    const CANARY = 'zz-mutation-tautology-canary';
    const rawNotCovered = resolvedApps.filter((id) => ! coveredIds.has(id));
    if ( resolvedApps.includes(CANARY) ) {
        const canaryLeaked = ! rawNotCovered.includes(CANARY);
        push(`${VP} MUTATION SELF-TEST: an app injected into the REAL resolvedApps array, with zero real assertions run against it, is still reported not-covered by THE GUARD's own single notCovered computation (catches a reintroduced GAP1 tautology no matter where between the self-test block and here it is pasted)`,
            ! canaryLeaked, `canaryLeaked=${canaryLeaked} rawNotCovered=${JSON.stringify(rawNotCovered)} coveredIds=${JSON.stringify([...coveredIds])}`);
    }
    // Strip the canary before judging the REAL resolved apps — an ordinary
    // run must never be failed by its own canary. `resolvedApps` itself is
    // also cleaned so nothing downstream (the shell-local check just below,
    // or a later viewport) ever sees it.
    const canaryIdx = resolvedApps.indexOf(CANARY);
    if ( canaryIdx !== -1 ) resolvedApps.splice(canaryIdx, 1);
    coveredIds.delete(CANARY);
    const notCovered = rawNotCovered.filter((id) => id !== CANARY);
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
    // 🔴 M2's late-check (below) is meaningless for a PINNED app — its
    // taskbar item "sits in the taskbar whether or not it is open"
    // (registry.js), so `taskbarItemCount === 1` is true regardless of
    // whether `remove_taskbar_item`'s guard did anything at all. Same
    // reasoning as the ROUND 8 FOLLOW-UP comment a few lines below.
    const pinnedIds = await page.evaluate(() => window.ezil.registry.APPS.filter((a) => a.pinned).map((a) => a.id));

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
                const item = items[0] ?? null;
                const cs = win ? getComputedStyle(win) : null;
                const r = win ? win.getBoundingClientRect() : null;
                return {
                    windowCount: wins.length,
                    taskbarItemCount: items.length,
                    openWindowsAttr: item ? parseInt(item.getAttribute('data-open-windows'), 10) : null,
                    visible: !! win && cs.display !== 'none' && cs.visibility !== 'hidden' && r.width > 0 && r.height > 0,
                };
            }, id);

            push(`${label}: exactly 1 window`, state.windowCount === 1, `windowCount=${state.windowCount}`);
            push(`${label}: exactly 1 taskbar item`, state.taskbarItemCount === 1, `taskbarItemCount=${state.taskbarItemCount}`);
            // 🔴 ROUND 8 FOLLOW-UP: "'exactly 1 taskbar item' has no
            // discriminating power for PINNED apps." `desktop` and
            // `settings` are `pinned: true` (registry.js) — their taskbar
            // item "sits in the taskbar whether or not it is open"
            // (registry.js's own doc comment), so `taskbarItemCount === 1`
            // is true BEFORE this close/reopen cycle, DURING it, and AFTER
            // it, regardless of whether the reopen actually worked. T16
            // OBSERVED exactly that: a pinned item stayed at "1 item" while
            // `windowCount` dropped to 0, and this sub-check still passed.
            // For `preview`/`code` (`pinned: false`) the item genuinely
            // disappears when there is no window, so the check has real
            // power there — the gap is pinned apps specifically.
            //
            // The taskbar item itself already carries a SEPARATE, live
            // signal that isn't just "am I pinned": `data-open-windows`
            // (`UIWindow.js` increments it on open, decrements it on
            // close — see that file's own comments next to each). This is
            // the same attribute `boot-test.mjs` already asserts on for the
            // exact same reason. Comparing it against the real DOM window
            // count closes the gap for BOTH pinned and non-pinned apps:
            // a stale "1 item, but the window and the item's own bookkeeping
            // disagree" state now fails here even when mere item PRESENCE
            // cannot tell the difference.
            push(`${label}: taskbar item's own open-window count matches the real window count`,
                state.openWindowsAttr === state.windowCount,
                `data-open-windows=${state.openWindowsAttr} windowCount=${state.windowCount}`);
            push(`${label}: the reopened window is visible`, state.visible, JSON.stringify(state));

            // 🔴 M2 — promoted from throwaway probe `probe-d1a.mjs`.
            // `remove_taskbar_item`'s `still_empty` guard (`UIDesktopFullpage.js`)
            // re-checks LIVE state at the moment its 200ms
            // `.animate({width:0}, 200, callback)` completes, not the state that
            // was true when the removal was scheduled — because a reopen INSIDE
            // that 200ms window reuses the SAME taskbar-item node (`launch()`
            // only creates a fresh one when none exists) rather than getting a
            // new one, bumping `data-open-windows` back up. Without the guard,
            // that stale callback deletes the reused item out from under a
            // window that is still open (MEASURED: reopen at ~112ms ->
            // windows=1, taskbar items=0).
            //
            // The checks just above run right after `settle()`, which typically
            // resolves in well under 200ms — BEFORE the animation's own natural
            // `complete` callback has fired at all, so they cannot see this
            // defect either way (confirmed separately: 456/456 pass whether the
            // guard is present or not). Only true for intervals below the 200ms
            // boundary (reopen must land INSIDE the animation window for the
            // item to be reused rather than recreated) — 250/500ms already sit
            // above it and get a fresh item regardless. Wait a REAL buffer past
            // the 200ms completion before checking again.
            // Pinned apps are silently OMITTED here (not `skip()`ed): for a
            // pinned app, `close_one_window`'s own selector
            // (`.taskbar-item[data-app][data-keep-in-taskbar="false"]`) never
            // matches its item in the first place, so `remove_taskbar_item` is
            // never even called — there is no guard invocation to observe, not
            // an inapplicable one (the SKIP baseline this file's suite is held
            // to is for the latter, not the former).
            if ( interval < 200 && ! pinnedIds.includes(id) ) {
                await sleep(Math.max(0, 400 - interval)); // ~400ms total since close — a real buffer past the 200ms animation
                const late = await page.evaluate((a) => ({
                    windowCount: document.querySelectorAll(`.window[data-app="${a}"]`).length,
                    taskbarItemCount: document.querySelectorAll(`.taskbar-item[data-app="${a}"]`).length,
                }), id);
                push(`${label}: M2 GUARD — the reused taskbar item survives remove_taskbar_item's natural animation-complete callback (~200ms after close) while the reopened window is still open`,
                    late.windowCount === 1 && late.taskbarItemCount === 1, `late=${JSON.stringify(late)}`);
            }

            // 🔴 `.fullpage-mode .window-minimize-btn { display: none }`
            // (`shell/src/css/style.css`) hides EVERY window's minimize
            // button, site-wide, whenever ANY window is full-bleed — not
            // just that window's own. That is a real, pre-existing,
            // already-documented shell characteristic (see this file's own
            // `buttonPointInside` comment), independent of close/reopen and
            // out of scope for D1/D2/D3 — it is CSS, not
            // `UIWindow.js`/`UIDesktopFullpage.js`/`registry.js`.
            //
            // 🔴 ROUND 8 FOLLOW-UP: "30 of 40 are SKIPs. Find why they skip
            // and make them real." Cause: `boot.js` opens the full-bleed app
            // (`desktop`, `wants_settings_in_drawer`) FIRST, and nothing in
            // this sweep ever exits full-bleed mode before iterating the
            // OTHER apps — so `settings`/`preview`/`code` NEVER once see a
            // reachable minimize button (only `desktop`'s own iteration,
            // via its drawer, ever did — the 10 non-skipped checks in the
            // old 40). That is not "no such thing as minimizing Preview" —
            // a real user CAN reach it, the same way this file's own boot
            // flow does (see `runViewport`'s "Expose the REAL taskbar"
            // section): minimize the full-bleed app first. So when `id`
            // itself isn't the full-bleed one and its minimize affordance is
            // unreachable ONLY because something else is full-bleed, this
            // exits full-bleed mode via that SAME real mechanism, tests the
            // REAL affordance, then restores the full-bleed app afterward —
            // so every later interval/app in this loop still starts from
            // the same "desktop full-bleed" baseline as before this detour,
            // and D1/D2/D3's own window/taskbar/visible counts (already
            // captured above, BEFORE this block runs) are never touched by
            // it.
            const isFullbleed = (a) => page.evaluate(
                (app) => !! document.querySelector(`.window[data-app="${app}"]`)?.classList.contains('ezil-fullbleed'), a);
            const currentFullbleedAppId = () => page.evaluate(
                () => document.querySelector('.window.ezil-fullbleed')?.getAttribute('data-app') ?? null);
            const readMinimizeAffordance = () => page.evaluate((a) => {
                const win = document.querySelector(`.window[data-app="${a}"]`);
                const btn = win?.querySelector('.window-minimize-btn');
                const btnReachable = !! btn && getComputedStyle(btn).display !== 'none'
                    && btn.getBoundingClientRect().width > 0;
                const drawerBtn = win?.querySelector(
                    '.dashboard-app-drawer-btn:not(.dashboard-app-drawer-settings):not(.dashboard-app-drawer-close)',
                );
                return btnReachable || !! drawerBtn;
            }, id);

            let minimizeAffordance = state.windowCount >= 1 ? await readMinimizeAffordance() : false;
            let blockerId = null;
            if ( ! minimizeAffordance && state.windowCount >= 1 && ! await isFullbleed(id) ) {
                blockerId = await currentFullbleedAppId();
                if ( blockerId && blockerId !== id ) {
                    await minimizeApp(blockerId);
                    await until(
                        (a) => document.querySelector(`.window[data-app="${a}"]`)?.getAttribute('data-is_minimized') === 'true',
                        blockerId, 2000, 30,
                    );
                    await sleep(80); // exit_fullpage_mode's own geometry transition — same wait `runViewport` uses for the same reason
                    minimizeAffordance = await readMinimizeAffordance();
                } else {
                    blockerId = null; // nothing full-bleed found to blame; leave the SKIP path honest below
                }
            }

            let minimized = false;
            if ( minimizeAffordance ) {
                await minimizeApp(id);
                minimized = !! await until(
                    (a) => document.querySelector(`.window[data-app="${a}"]`)?.getAttribute('data-is_minimized') === 'true',
                    id, 2000, 30,
                );
                push(`${label}: minimise works`, minimized);
            } else {
                skip(`${label}: minimise (no reachable minimize affordance right now — full-bleed mode hides ordinary minimize buttons site-wide, and no full-bleed app was found to minimize out of the way; a pre-existing shell characteristic, not part of this close/reopen sweep)`);
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

            // Put the full-bleed app we minimized to unblock `id` back the
            // way it was, via a REAL taskbar click (the taskbar is visible
            // right now precisely because it's minimized) — so the NEXT
            // interval/app in this loop starts from the same baseline every
            // iteration before this one did.
            if ( blockerId ) {
                const bp = await taskbarItemPoint(blockerId);
                if ( bp ) {
                    await page.mouse.click(bp[0], bp[1]);
                } else {
                    await page.evaluate((a) => {
                        const w = $(`.window[data-app="${a}"]`);
                        if ( w.length ) w.showWindow();
                    }, blockerId);
                }
                await until((a) => document.querySelector(`.window[data-app="${a}"]`)?.classList.contains('ezil-fullbleed'), blockerId, 3000, 50);
                await settle(blockerId);
            }

            const cycleErrors = page_errors.slice(errorsBefore);
            push(`${label}: zero uncaught page errors during this close/reopen cycle`,
                cycleErrors.length === 0, JSON.stringify(cycleErrors));
        }
    }

    allPageErrors.push(...page_errors);
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP 4 — a close that THROWS (M3a), and the awaited-teardown contract (M5b).
// ═══════════════════════════════════════════════════════════════════════════
// M3a: `close_one_window`'s `try/finally` around `data-closing` (`UIWindow.js`
// — see that function's own header comment for the full writeup). Without
// it, an `on_before_exit` that THROWS (a real app can do this; nothing
// sanitizes it) leaves `data-closing="1"` stuck forever on a window that
// never actually closed, making it permanently invisible to every
// `:not([data-closing="1"])` lookup this codebase uses to answer "is app X
// already open" (the single_instance check, `registry.js`'s `launch()`, and
// GAP 5 below's popstate guards).
//
// M5b: `$.fn.close`'s `for` loop does `await close_one_window.call(...)`.
// `closeSandboxWindows` (registry.js) depends on `.close()`'s own returned
// promise not resolving until teardown REALLY finished — that IS the delete
// guarantee (close every window, THEN delete the sandbox). If that `await`
// were ever weakened to a fire-and-forget, `.close()` would resolve before
// an async veto (`on_before_exit`) — or the DOM removal it gates — had
// actually run, and a caller awaiting it would wrongly believe the window
// was gone.
//
// Promoted from throwaway probe `probe-c-throw.mjs` (M3a). M5b is new: it
// measures WALL-CLOCK TIME, not just end state — "resolved suspiciously
// fast" is the one signal a fire-and-forget `void` leaves behind that a
// correct `await` cannot, because the whole point of the mutation is that
// nothing is holding the outer promise open anymore.
async function runCloseRobustnessSweep () {
    const VP = '[close-robustness]';
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
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

    async function until (fn, arg, ms = 6000, step = 50) {
        const deadline = Date.now() + ms;
        for ( ;; ) {
            const v = await page.evaluate(fn, arg);
            if ( v ) return v;
            if ( Date.now() > deadline ) return null;
            await sleep(step);
        }
    }

    await until(() => Array.isArray(window.ezil?.registry?.APPS) && window.ezil.registry.APPS.length > 0, undefined);
    const resolvedApps = await page.evaluate(() => window.ezil.registry.resolve(window.__EZIL_BOOT__).map((a) => a.id));
    push(`${VP} registry resolved at least one app for close-robustness coverage`, resolvedApps.length > 0,
        `resolved=${JSON.stringify(resolvedApps)}`);
    if ( resolvedApps.length === 0 ) {
        await page.close();
        return;
    }
    const id = resolvedApps[0]; // the boot app — already open, no extra launch needed
    await until((a) => !! document.querySelector(`.window[data-app="${a}"]`), id, 8000, 50);

    // ── M3a: on_before_exit THROWS ──────────────────────────────────────────
    const throwResult = await page.evaluate(async (a) => {
        const el = document.querySelector(`.window[data-app="${a}"]`);
        el.on_before_exit = () => { throw new Error('boom: deliberate throw from on_before_exit'); };
        let threw = null;
        try {
            await $(el).close();
        } catch ( e ) {
            threw = String(e?.message ?? e);
        }
        return {
            threw,
            dataClosingAfter: el.getAttribute('data-closing'),
            stillInDom: document.body.contains(el),
        };
    }, id);
    push(`${VP} M3a: a close whose on_before_exit THROWS still propagates the throw (does not swallow it)`,
        !! throwResult.threw && throwResult.threw.includes('boom'), JSON.stringify(throwResult));
    push(`${VP} M3a GUARD: data-closing is cleared by the try/finally even when the close throws (else the window is permanently invisible to every :not([data-closing="1"]) lookup)`,
        throwResult.dataClosingAfter === null, JSON.stringify(throwResult));
    push(`${VP} M3a: the window survives a throw from on_before_exit (not half-deleted)`,
        throwResult.stillInDom, JSON.stringify(throwResult));

    // ── M5b: the awaited-teardown contract ──────────────────────────────────
    // A veto that resolves only after a real delay. If `$.fn.close`'s
    // `await close_one_window.call(...)` were ever weakened to a
    // fire-and-forget, the outer `await $(el).close()` below would resolve
    // almost immediately — long before this delay elapses — because nothing
    // would be holding it open.
    const DELAY_MS = 300;
    const timing = await page.evaluate(async ({ a, delay }) => {
        const el = document.querySelector(`.window[data-app="${a}"]`);
        el.on_before_exit = () => new Promise((resolve) => setTimeout(() => resolve(true), delay));
        const t0 = performance.now();
        await $(el).close();
        const elapsed = performance.now() - t0;
        return {
            elapsed,
            dataClosingAfter: el.getAttribute('data-closing'),
            stillInDom: document.body.contains(el),
        };
    }, { a: id, delay: DELAY_MS });
    push(`${VP} M5b GUARD: $.fn.close's returned promise does not resolve until the awaited veto (on_before_exit) actually finishes`,
        timing.elapsed >= DELAY_MS - 50,
        `elapsed=${timing.elapsed.toFixed(1)}ms delay=${DELAY_MS}ms ${JSON.stringify(timing)}`);
    push(`${VP} M5b: by the time the awaited close() resolves, the window is actually gone and data-closing is cleared`,
        timing.dataClosingAfter === null && ! timing.stillInDom, JSON.stringify(timing));

    push(`${VP} no uncaught page errors during close-robustness sweep`, page_errors.length === 0, JSON.stringify(page_errors));
    allPageErrors.push(...page_errors);
    await page.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// GAP 5 — the three `:not([data-closing="1"])` guards on the dashboard-mode
// popstate handler and its 400ms watchdog fallback (M6 / M7 / M8,
// `UIWindow.js`, `pop_dashboard_app_url` / the `popstate` listener next to
// it).
// ═══════════════════════════════════════════════════════════════════════════
// `window.is_dashboard_mode` is Puter's Dashboard — a surface EZiL does not
// have and will not build (`app-drawer.js`'s own header). Nothing in
// `shell/ezil` ever sets it, and nothing ever passes `update_window_url:
// true` either (the one option that lets a NEWLY OPENED window claim a
// dashboard URL) — this whole subsystem is dead in the shipped app, on
// purpose, TWICE over. That is exactly why round 9's mutation pass found
// zero coverage: nothing anywhere ever runs this code, so no suite could
// have caught a mutation to it.
//
// It is still real, committed, reachable source — `UIWindow.js`'s own
// header treats the whole file as a load-bearing port, not dead weight to
// delete — so a guard inside it regressing silently is still a real defect
// waiting for the day this fork's dashboard mode (or a future one) turns the
// flag back on. This harness exercises the REAL functions through the ONE
// legitimate side door available without a dashboard UI: `$.fn.showWindow`'s
// restore branch reads `data-update_window_url`/`data-minimized_in_place`
// off the LIVE DOM element, not a captured option — setting those two
// attributes directly and calling the real, unmodified `showWindow()`
// reaches the real `push_dashboard_app_url`, which does real
// `history.pushState`. Everything downstream of that (the real `popstate`
// listener already registered by `UIWindow.js` on page load, real
// `history.back()/forward()`, the real 400ms watchdog `setTimeout`) is then
// exercised exactly as a live user's Back button would, no reimplementation
// of any of the three guards under test.
async function runDashboardPopstateGuardSweep () {
    async function newPage () {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
        const page_errors = [];
        page.on('pageerror', (e) => page_errors.push(String(e)));
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
        return { page, page_errors };
    }

    async function until (page, fn, arg, ms = 6000, step = 50) {
        const deadline = Date.now() + ms;
        for ( ;; ) {
            const v = await page.evaluate(fn, arg);
            if ( v ) return v;
            if ( Date.now() > deadline ) return null;
            await sleep(step);
        }
    }

    /** Reach the real `push_dashboard_app_url` through the real
     * `showWindow()` restore branch — see this function's own doc block for
     * why these two attributes are the legitimate side door. */
    async function forcePushDashboardUrl (page, id) {
        await page.evaluate((a) => {
            window.is_dashboard_mode = true;
            const el = document.querySelector(`.window[data-app="${a}"]`);
            el.setAttribute('data-minimized_in_place', '1');
            el.setAttribute('data-update_window_url', 'true');
            $(el).showWindow();
        }, id);
        await until(page, (a) => window.location.pathname === `/app/${a}`, id, 2000, 30);
    }

    /** Fire-and-forget a close whose `on_before_exit` never resolves — the
     * window is stamped `data-closing="1"` synchronously and then stuck
     * there forever, a stable, deterministic stand-in for "mid-teardown"
     * with no race to win. */
    async function startHungClose (page, id) {
        await page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"]`);
            el.on_before_exit = () => new Promise(() => {}); // never resolves
            void $(el).close();
        }, id);
        await until(page, (a) => document.querySelector(`.window[data-app="${a}"]`)?.getAttribute('data-closing') === '1', id, 2000, 30);
    }

    async function pickTwoApps (page) {
        await until(page, () => Array.isArray(window.ezil?.registry?.APPS) && window.ezil.registry.APPS.length > 0, undefined);
        const resolvedApps = await page.evaluate(() => window.ezil.registry.resolve(window.__EZIL_BOOT__).map((a) => a.id));
        return resolvedApps;
    }

    async function launchAndWait (page, id) {
        const already = await page.evaluate((a) => !! document.querySelector(`.window[data-app="${a}"]`), id);
        if ( ! already ) {
            await page.evaluate(({ a, ctx }) => window.ezil.registry.launch(a, ctx), {
                a: id, ctx: { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState },
            });
        }
        await until(page, (a) => !! document.querySelector(`.window[data-app="${a}"]`), id, 8000, 50);
    }

    // ── M7: the popstate handler's `prev_app` guard ─────────────────────────
    // A traversal that leaves an app's URL entry minimizes that app's
    // window — UNLESS it is mid-teardown, in which case minimizing it is
    // exactly the wrong thing to do to a window about to be deleted.
    {
        const VP = '[dashboard-popstate M7]';
        const { page, page_errors } = await newPage();
        const resolvedApps = await pickTwoApps(page);
        push(`${VP} registry resolved at least 2 apps to exercise this guard`, resolvedApps.length >= 2,
            `resolved=${JSON.stringify(resolvedApps)}`);
        if ( resolvedApps.length >= 2 ) {
            const [idA, idB] = resolvedApps;
            await launchAndWait(page, idA);
            await forcePushDashboardUrl(page, idA);
            await launchAndWait(page, idB);
            await forcePushDashboardUrl(page, idB); // dashboard_url_app === idB now, history: [/os, /app/idA, /app/idB]
            await startHungClose(page, idB); // idB is now stuck mid-teardown, data-closing="1", never resolves

            await page.evaluate(() => { window.history.back(); }); // real traversal -> URL becomes /app/idA
            await until(page, (a) => window.location.pathname === `/app/${a}`, idA, 3000, 30);
            await sleep(150); // let the popstate handler's synchronous body finish

            const bMinimized = await page.evaluate((a) => document.querySelector(`.window[data-app="${a}"]`)?.getAttribute('data-is_minimized'), idB);
            push(`${VP} M7 GUARD: a window mid-teardown is NOT minimized by the popstate handler's prev_app branch, even though the traversal left its URL entry`,
                bMinimized !== 'true' && bMinimized !== '1', `data-is_minimized=${bMinimized}`);
        }

        push(`${VP} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
        allPageErrors.push(...page_errors);
        await page.close();
    }

    // ── M8: the popstate handler's `new_app` guard ──────────────────────────
    // Landing on an app's URL entry restores its window, or relaunches it if
    // none is found — UNLESS a window IS found but is mid-teardown, in which
    // case restoring/focusing it is wrong (it is about to be deleted out
    // from under that restore) and the code must treat it as "not found"
    // instead. Detected via `document.title`: the found-window branch is the
    // ONLY place in the whole handler that sets `document.title` to the
    // window's own `data-name` — see this block's own comment for why that
    // makes an unambiguous signal.
    {
        const VP = '[dashboard-popstate M8]';
        const { page, page_errors } = await newPage();
        const resolvedApps = await pickTwoApps(page);
        push(`${VP} registry resolved at least 1 app to exercise this guard`, resolvedApps.length >= 1,
            `resolved=${JSON.stringify(resolvedApps)}`);
        if ( resolvedApps.length >= 1 ) {
            const idA = resolvedApps[0];
            const MARKER = 'M8-MUTATION-SELF-TEST-MARKER';
            await launchAndWait(page, idA);
            await page.evaluate((a) => document.querySelector(`.window[data-app="${a}"]`)?.setAttribute('data-name', a), idA);
            await forcePushDashboardUrl(page, idA); // dashboard_url_app === idA, history: [/os, /app/idA]

            // Leave idA's entry (real Back), which also minimizes it for
            // real (it is healthy at this point) and resets the cached
            // "current app" to null — isolating the scenario so the
            // `prev_app` branch has nothing to act on for the `forward()`
            // below (this test is about `new_app`, not `prev_app`).
            await page.evaluate(() => { window.history.back(); });
            await until(page, () => window.location.pathname === '/os', undefined, 3000, 30);
            await sleep(100);

            // NOW make idA mid-teardown.
            await startHungClose(page, idA);
            await page.evaluate((marker) => { document.title = marker; }, MARKER);

            await page.evaluate(() => { window.history.forward(); }); // real traversal -> URL becomes /app/idA again
            await until(page, (a) => window.location.pathname === `/app/${a}`, idA, 3000, 30);
            await sleep(150);

            const title = await page.evaluate(() => document.title);
            push(`${VP} M8 GUARD: a window mid-teardown is treated as NOT FOUND by the popstate handler's new_app branch (title is untouched, not stamped from the dying window's data-name)`,
                title === MARKER, `title=${JSON.stringify(title)} expectedUnchanged=${JSON.stringify(MARKER)}`);
        }

        push(`${VP} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
        allPageErrors.push(...page_errors);
        await page.close();
    }

    // ── M6: pop_dashboard_app_url's 400ms watchdog fallback ─────────────────
    // If the real popstate a `history.back()` issues never arrives (e.g. the
    // app's iframe consumed the joint history entry instead — see this
    // function's own header comment in `UIWindow.js`), the watchdog repairs
    // the address bar itself after 400ms and, same as the popstate handler,
    // must not act on a window mid-teardown. Reproduced by making
    // `history.back()` a deliberate no-op (so no real popstate ever arrives,
    // forcing the watchdog to fire) and stretching `$.fn.animate`'s duration
    // so the closing window's DOM node is still attached, `data-closing="1"`,
    // when the watchdog's 400ms elapses.
    {
        const VP = '[dashboard-popstate M6]';
        const { page, page_errors } = await newPage();
        const resolvedApps = await pickTwoApps(page);
        push(`${VP} registry resolved at least 1 app to exercise this guard`, resolvedApps.length >= 1,
            `resolved=${JSON.stringify(resolvedApps)}`);
        if ( resolvedApps.length >= 1 ) {
            const idA = resolvedApps[0];
            await launchAndWait(page, idA);
            await forcePushDashboardUrl(page, idA); // dashboard_url_app === idA, history: [/os, /app/idA]

            await page.evaluate(() => {
                // Stretch every animate() call so the shrink-to-target close
                // animation below outlives the 400ms watchdog — the window
                // must still be attached, data-closing="1", when it fires.
                const origAnimate = $.fn.animate;
                $.fn.animate = function (props, duration, ...rest) {
                    const boosted = typeof duration === 'number' ? Math.max(duration, 900) : duration;
                    return origAnimate.call(this, props, boosted, ...rest);
                };
                // Block the real navigation pop_dashboard_app_url issues, so
                // no real popstate ever arrives to clear the pending latch —
                // forcing the watchdog to be the one that acts.
                window.history.back = () => {};
            });

            await page.evaluate((a) => {
                const el = document.querySelector(`.window[data-app="${a}"]`);
                // Fire-and-forget: this close reaches pop_dashboard_app_url
                // (no on_before_exit to block it) and then hangs mid-shrink
                // for ~900ms thanks to the patched animate() above —
                // data-closing="1" stays on an ATTACHED node the whole time.
                void $(el).close({ shrink_to_target: document.body });
            }, idA);

            await sleep(450); // past the watchdog's 400ms, well before the ~900ms shrink completes
            const state = await page.evaluate((a) => {
                const el = document.querySelector(`.window[data-app="${a}"]`);
                return el ? { stillInDom: true, dataClosing: el.getAttribute('data-closing'), isMinimized: el.getAttribute('data-is_minimized') } : { stillInDom: false };
            }, idA);
            push(`${VP} setup sanity: the window is still attached and mid-teardown when the watchdog fires`,
                state.stillInDom && state.dataClosing === '1', JSON.stringify(state));
            push(`${VP} M6 GUARD: the watchdog does NOT minimize a window mid-teardown, even though its own address-bar repair still ran`,
                state.isMinimized !== 'true' && state.isMinimized !== '1', JSON.stringify(state));

            await sleep(600); // let the stretched close finish before tearing the page down
        }

        push(`${VP} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
        allPageErrors.push(...page_errors);
        await page.close();
    }
}
