// resize-test.mjs — EZiL-authored. REAL-BROWSER, ALL-EIGHT-HANDLES resize
// geometry test for `UIWindow.js`'s `.resizable()` wiring.
//
// Run:  node shell/ezil/apps/resize-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every other `*-test.mjs` in this tree)
//
// Requires `playwright` (with a Chromium build) to be resolvable from this
// file's location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR —
// same convention as `stacking-browser-test.mjs` and
// `overlay-paint-browser-test.mjs`. Not a project dependency. If neither
// resolves, this exits 2 (skip), never 0.
//
// ═══════════════════════════════════════════════════════════════════════════
// 2026-08-19 — THE 16/18 IS SETTLED. IT WAS THIS FILE, NOT `UIWindow.js`.
// ═══════════════════════════════════════════════════════════════════════════
// This file shipped failing 2 of its 18 checks — the `se` handle, in both
// sweeps — and the header below claimed all eight passed. Both candidate
// explanations on the table (a genuine `se` regression in the committed
// bundle, or an artifact of the playwright build in use) were tested. The
// answer is NEITHER of those exactly: it is a defect in THIS FILE's drag
// emulation, present since it was written and independent of playwright
// version. `UIWindow.js` is clean; nothing was changed outside this file.
//
// The version hypothesis is not merely argued away, it is MEASURED away. Two
// playwright installs were reachable in the development environment when this
// was investigated — 1.61.1 and 1.59.1. Against the same committed bundle:
//   pre-fix file, playwright 1.61.1 -> 16/18, `se` red in both sweeps
//   pre-fix file, playwright 1.59.1 -> 16/18, `se` red in both sweeps,
//                                     byte-identical geometry (700x380 ->
//                                     700x460: height grew, width did not)
//   this file,    playwright 1.61.1 -> 20/20
//   this file,    playwright 1.59.1 -> 20/20
// Identical red under both versions and identical green under both: the
// variable that mattered was never the playwright build.
//
// One-line cause: jQuery UI picks the resize axis from the last handle the
// pointer was seen OVER, not from the one you pressed, and this file's
// ten-step drag teleported the pointer off the 15x15 `se` handle before
// jQuery UI had latched the axis. Full derivation, with the library source
// and the measured coordinates, is at `dragHandle` below. The fix is a
// three-pixel first movement inside the handle — what a human hand does
// anyway — and it leaves every distance, threshold and assertion untouched.
// MEASURED after the fix: 20/20 (18 originals + 2 new stray-start guards),
// and `RESIZE_TEST_BREAK_BOX_MODEL=1` still turns all sixteen ALL-HANDLES
// checks red, so the file's discriminating power is intact.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE GAP THIS FILE CLOSES, AND WHY IT IS A NEW FILE
// ═══════════════════════════════════════════════════════════════════════════
// T18/T13 reported "dragging any resize handle collapses a window's height",
// diagnosed (never traced to ground) as jQuery UI mis-parsing a CSS `calc()`
// `top` string. `stacking-browser-test.mjs` (commit 02b06fa, NOT this file —
// that file is owned by a sibling task and is deliberately not duplicated
// here) already added a direction-aware resize check with real discriminating
// power, but only exercises THREE of the eight handles (`se`, `nw`, `e`), on
// one window, once. This file's whole job is the other five (`n`, `s`, `w`,
// `ne`, `sw`) PLUS an explicit, per-handle re-test of the `calc()`-top theory
// itself, across all eight directions — the thing nobody had actually traced
// to ground for more than the `se` handle.
//
// ═══════════════════════════════════════════════════════════════════════════
// ROOT CAUSE, TRACED TO GROUND (not inferred) — the `calc()` theory is WRONG
// ═══════════════════════════════════════════════════════════════════════════
// Read against jQuery UI 1.13.2's actual source (`jquery-ui.js`, the
// unminified sibling of this project's vendored `jquery-ui.min.js`, found
// checked into `_reference/puter/src/gui/src/lib/jquery-ui-1.13.2/`):
//
//   resizable._mouseStart(): `curtop = this._num(this.helper.css("top"))`.
//   jQuery's `.css("top")` resolves via `getComputedStyle`, which a real
//   browser ALWAYS resolves to a pixel string, calc() or not — MEASURED
//   below: a window opened with `top: calc(15% + 20px)` reports
//   `getComputedStyle(el).top === "155px"` and resizes IDENTICALLY (down to
//   the same-viewport pixel) whether `top` is left as that `calc()` string or
//   rewritten to the equivalent plain `155px` first. `calc()` is a non-factor
//   for every one of the eight handles — see the CALC-TOP-EQUIVALENCE checks
//   below, run for all eight, not just `se`.
//
// The REAL mechanism (jQuery UI's own `containment: 'parent'` plugin,
// `jquery-ui.js` ~L11930-11960): `.resizable({ containment: 'parent' })`
// resolves "parent" to `el.parent()` — for a `.window`, that is `<body>`
// (`UIWindow.js` line 51: `const el_body = document.getElementsByTagName
// ('body')[0]`, and every window is appended there). The containment plugin
// computes `that.parentData.height = containerElement.innerHeight() - padding`
// and then, on every `resize` tick, clamps:
//     hoset = Math.abs(sizeDiff.height + (offset.top - containerOffset.top))
//     if (hoset + size.height >= parentData.height)
//         size.height = parentData.height - hoset;
// If the container's computed height is 0 (an under-specified page — see
// below), `size.height` becomes `0 - hoset`, i.e. essentially `-top`, a
// NEGATIVE number that CSS renders as 0 — REGARDLESS of drag direction,
// distance, or whether `top` is `calc()` or plain px. This matches the
// `-149`/`-155`-equals-`top` fingerprint exactly, and explains why it fired
// on every handle, not just the ones that move `top`.
//
// So: is the container ever actually 0-height in the shipped product? NO.
// `app/src/app/layout.tsx` puts `h-full` (height:100%) on `<html>` and
// `min-h-full` (min-height:100%) on `<body>` — a real, non-zero chain rooted
// at the viewport. The zero-height container only happens in a fake test
// document that writes those SAME class names without ever loading Tailwind
// (the class names are then inert). `stacking-browser-test.mjs` was exactly
// that fake document, diagnosed and fixed in commit 02b06fa ("give the
// stacking harness's fake document the real page's box model"), whose commit
// message independently reaches the same conclusion this file's investigation
// reached from the jQuery UI source: NOT `calc()`, NOT `UIWindow.js`'s own
// toolbar-clamp branch (checked and excluded there too — `toolbar_height` is
// 0 in the harness and `position().top` is 155, so `155 < 0` never fires) —
// a test-harness box-model gap, already closed.
//
// CONCLUSION: `UIWindow.js` has NO defect here. `.resizable({containment:
// 'parent', minWidth:200, minHeight:200})` (UIWindow.js ~L2264-2314) is
// correct as written; a correctly-sized container never lets jQuery UI's
// containment plugin see a negative clamp target. This file therefore makes
// NO changes to `UIWindow.js` (its diff is empty on that file) and instead
// (a) builds the harness's DOM with the SAME real box model
// `stacking-browser-test.mjs` now uses (never the broken one — see the
// MUTATION PROOF below for what happens if that fidelity regresses), and
// (b) is the actual eight-direction regression test nobody had written yet.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUTATION PROOF — both directions
// ═══════════════════════════════════════════════════════════════════════════
// RED direction (harness-fidelity regression, the ACTUAL bug class here):
//   set RESIZE_TEST_BREAK_BOX_MODEL=1. This file then boots the SAME
//   under-specified `<html><body class="min-h-full …">` document the
//   pre-02b06fa harness used (no `h-full` on `<html>`, no real-height CSS).
//   MEASURED: every one of the eight ALL-HANDLES checks below goes red — the
//   collapse reproduces on every handle, not just `se`/`nw`/`e`, confirming
//   this file has power stacking-browser-test.mjs's own three-handle sweep
//   does not independently demonstrate (n/s/w/ne/sw were never exercised
//   there). Unset the env var (the default) and the same run is green — the
//   ONLY thing that changed is the fake document's box model, nothing in
//   `UIWindow.js` or this file's assertions.
// GREEN direction (this file's default config, the shipped state):
//   real box model (this file's default DOC_HTML, matching
//   `stacking-browser-test.mjs` post-02b06fa) -> all eight handles, both
//   calc()-top and plain-px-top variants, PASS.
// A SECOND, independent mutation (proves this file also catches an actual
// `UIWindow.js` resize-code regression, not just harness fidelity): apply
// `shell/ezil/apps/resize-test.mutation.patch` (see the report) to a SCRATCH
// copy of `UIWindow.js`'s `resizable({ ... stop: function () { ... } })` so
// `stop` forces `height` to `20px` on every resize, rebuild into a scratch
// `app/public/os`, point `EZIL_OS_DIR` at it. MEASURED: all eight ALL-HANDLES
// checks go red (this file, independently of `stacking-browser-test.mjs`,
// which the WATCH OUT note says already catches this exact `stop:` mutation
// on its own three handles — this file additionally red-flags it on the
// five handles that file never drags). Reverting `EZIL_OS_DIR` is green
// again.
//
// ═══════════════════════════════════════════════════════════════════════════
// OVERLAP WITH `stacking-browser-test.mjs` (T20's file — not duplicated here)
// ═══════════════════════════════════════════════════════════════════════════
// That file's `testResizeHandleRaisesAndResizes()` already has real
// discriminating power for `se`, `nw`, `e` — grow-the-owned-axis,
// leave-the-other-alone, never-collapse, on a window buried under
// contenders, PLUS the raise-on-mousedown click-binding check this file does
// NOT attempt (this file never buries the window under contenders and never
// asserts z-order). Where the two overlap (`se`, `nw`, `e`, on a single
// window, one drag distance) is intentionally redundant — the mutation proof
// above shows this file adds five more DIRECTIONS worth of power that file's
// call site does not exercise (`for (const dir of ['se','nw','e'])`, see its
// own GAP 3 REGRESSION section), and adds the calc()-vs-plain-px-top
// equivalence check that file does not attempt at all.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// 🔴 Overridable for the mutation-proof (see header) — never used to point
// at anything other than a scratch, deliberately-mutated build. The real run
// (default) always tests `app/public/os`, the same real built bundle every
// other `*-test.mjs` in this tree tests.
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
        + 'This is a REAL-BROWSER test — jsdom has no layout/containment model '
        + '(see header). Install playwright (e.g. `bunx playwright@1.62.1 install '
        + 'chromium` in some directory and set PLAYWRIGHT_REQUIRE_DIR to it) and '
        + 're-run. Skipping, not passing.',
    );
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
    return !! pass;
};
const skip = (name, detail = '') => {
    console.log(`SKIP  ${name}${detail ? `  [${detail}]` : ''}`);
};

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

// 🔴 RESIZE_TEST_BREAK_BOX_MODEL — mutation-proof knob (see header). Default
// (unset) is the REAL page's box model, matching `app/src/app/layout.tsx`
// (`<html class="… h-full …">`, `<body class="min-h-full …">`) via the SAME
// fix `stacking-browser-test.mjs` carries post-02b06fa: Tailwind is never
// loaded here, so the `h-full`/`min-h-full` class NAMES are cosmetic
// documentation only — the actual, load-bearing CSS is the explicit
// `html{height:100%} body{min-height:100%}` rule alongside them.
const BREAK_BOX_MODEL = process.env.RESIZE_TEST_BREAK_BOX_MODEL === '1';
const HOST = 'https://ezil-resize-test.invalid';
const DOC_HTML = BREAK_BOX_MODEL
    ? `<!doctype html><html><head><style>${css}</style></head>
       <body class="min-h-full flex flex-col"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`
    : `<!doctype html><html class="h-full"><head><style>${css}</style>
       <style>html{height:100%}body{min-height:100%}</style></head>
       <body class="min-h-full flex flex-col"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: {
            session: '/api/shell/session', desktop: '/api/shell/desktop',
            previewUrl: '/api/shell/preview-url', focus: '/api/shell/focus',
            codePreviewUrl: '/api/shell/code-preview-url',
        },
    },
};
const listRows = [{
    id: 'computer-1', name: 'My Computer', slot: 1,
    createdAt: PAYLOAD.computer.createdAt, lastOpenedAt: null,
}];
function stub (url, method) {
    if ( url.includes('/api/shell/desktop') && method === 'POST' ) {
        return { ok: true, guacamoleUrl: 'about:blank?desktop-frame=1', controlMode: 'interactive', mode: 'neko', frame: { confirmed: true } };
    }
    if ( url.includes('confirm=frame') ) return { ok: true, confirmed: true };
    if ( url.includes('/api/shell/desktop') ) return { ok: true, guacamoleRunning: true };
    if ( url.includes('/api/trpc/computer.list') ) return { result: { data: { json: listRows } } };
    return { ok: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════════════
// The eight handles. `DELTA` mirrors jQuery UI's own `_change` table read
// from source (see header): an outward drag on each handle's owned axis/axes
// must GROW that axis. `AFFECTS` says which axis (or both) each handle owns.
// `DRAG` is generous (80px) with a pristine geometry chosen to leave >=150px
// of room on every side so no drag legitimately hits `containment: 'parent'`
// itself (that would be a correct clamp, not a bug, and would corrupt this
// test's signal).
// ═══════════════════════════════════════════════════════════════════════════
const DRAG = 80;
const MIN_GROWTH = 30; // generous slack under an 80px drag
const STABLE = 4;      // the axis NOT owned by this handle should barely move
const DELTA = {
    n: [0, -DRAG], s: [0, DRAG], e: [DRAG, 0], w: [-DRAG, 0],
    ne: [DRAG, -DRAG], nw: [-DRAG, -DRAG], se: [DRAG, DRAG], sw: [-DRAG, DRAG],
};
const AFFECTS = {
    n: { w: false, h: true }, s: { w: false, h: true },
    e: { w: true, h: false }, w: { w: true, h: false },
    ne: { w: true, h: true }, nw: { w: true, h: true },
    se: { w: true, h: true }, sw: { w: true, h: true },
};
const HANDLES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

// Pristine geometry, viewport 1440x900: 300px top margin, 220px bottom
// margin, 400px left margin, 340px right margin — every handle has >=220px
// of room to drag DRAG=80px without touching `containment: 'parent'`.
const PRISTINE = { width: 700, height: 380, top: 300, left: 400 };
// Same geometry, `top` expressed as a `calc()` the browser must resolve
// itself (300/900 = 33.333%): re-tests T18's specific theory on every one of
// the eight handles, not just `se` (the only handle the original probe used).
const PRISTINE_CALC_TOP = 'calc(33.333% + 0px)';

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if ( url === `${HOST}/os` ) return route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
    if ( url.includes('/api/') ) {
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(stub(url, req.method())) });
    }
    if ( url.startsWith(HOST) ) return route.fulfill({ status: 404, body: '' });
    return route.continue();
});

const page_errors = [];
page.on('pageerror', (e) => page_errors.push(String(e)));

await page.goto(`${HOST}/os`, { waitUntil: 'load' });
await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
await page.addScriptTag({ content: icons });
await page.addScriptTag({ content: bundle });

const until = async (fn, arg, ms = 8000) => {
    const deadline = Date.now() + ms;
    for ( ;; ) {
        const v = await page.evaluate(fn, arg);
        if ( v ) return v;
        if ( Date.now() > deadline ) return null;
        await sleep(50);
    }
};

await until((id) => !! document.querySelector(`.window[data-app="${id}"]`), 'desktop');
await sleep(300);
// Minimize the full-bleed desktop window so it does not sit over everything.
await page.evaluate(() => {
    const d = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer');
    d?.querySelector('.dashboard-app-drawer-btn:not(.dashboard-app-drawer-settings):not(.dashboard-app-drawer-close)')?.click();
});
await sleep(300);
await page.evaluate((ctx) => window.ezil.registry.launch('settings', ctx),
    { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState });
const opened = await until((id) => !! document.querySelector(`.window[data-app="${id}"]`), 'settings');

if ( ! opened ) {
    push('settings window opens at all', false, 'timed out waiting for .window[data-app="settings"]');
} else {
    push('settings window opens at all', true);

    async function setGeometry (topValue) {
        await page.evaluate(([g, top]) => {
            const w = document.querySelector('.window[data-app="settings"]');
            w.style.width = `${g.width}px`;
            w.style.height = `${g.height}px`;
            w.style.left = `${g.left}px`;
            w.style.top = top;
        }, [PRISTINE, topValue]);
        await sleep(150);
    }

    async function rectOf () {
        return page.evaluate(() => {
            const w = document.querySelector('.window[data-app="settings"]');
            const r = w.getBoundingClientRect();
            return { top: r.top, left: r.left, width: r.width, height: r.height };
        });
    }

    // 🔴 INCIDENTAL FINDING, TRACED TO GROUND, OUT OF THIS TASK'S FILE SCOPE —
    // a handle's raw geometric center is NOT a safe click target. jQuery UI's
    // own vendored theme (`jquery-ui.min.css`) offsets each straight-edge
    // handle mostly OUTSIDE the window's border box (e.g.
    // `.ui-resizable-n{top:-5px;height:7px}` — 5px above the border, only 2px
    // inside it), which is normal upstream behaviour: without any paint
    // containment on the target, that whole 7px strip is one hit-testable
    // element. But `.window{contain:paint}` (`shell/src/css/style.css`, NOT
    // this task's file) clips a window's descendants — the resize handles
    // ARE the window's own direct children (see UIWindow.js's own comment at
    // ~L1395-1399) — to the window's own border box. MEASURED via an
    // `elementFromPoint` sweep at 1px steps across a window's top edge (top
    // === 300): y=295..299 (the handle's outer, upstream-intended two-thirds)
    // all hit-test to whatever sits BEHIND the window (here, the desktop
    // wallpaper `.desktop.ezil-desktop`); only y=300..301 (2 of the handle's
    // 7px) actually resolves to `.ui-resizable-n`. Corner handles (15x15,
    // also offset -5/-5) are proportionally less affected — their clickable
    // intersection with the window's box is still a real 10x10 px target —
    // which is why an EARLIER version of this file's tests, using raw
    // geometric centers, passed on `se/ne/sw/nw` by coincidence (the center
    // happened to fall inside the surviving intersection) and FAILED with a
    // false "handle doesn't work" on every straight edge (`n/s/e/w`) — a
    // finding about `elementFromPoint`/hit-testing, not about resize/collapse
    // behavior, and not evidence of any `UIWindow.js` defect (the mousedown
    // that DOES land still starts a completely normal, non-collapsing
    // resize — see the ALL-HANDLES results below once this is corrected).
    // This is real and reproducible in a genuine Chromium paint/hit-test
    // engine (not a jsdom artifact), but `style.css` is not a file this task
    // owns, so it is reported here and in this task's write-up, not "fixed"
    // by silently loosening `contain: paint` on the side.
    //
    // The fix for THIS file: target the actual clickable intersection of the
    // handle's rect and the window's own box, not the handle's raw center.
    async function handleCenter (dir) {
        return page.evaluate((d) => {
            const w = document.querySelector('.window[data-app="settings"]');
            const el = w?.querySelector(`.ui-resizable-${d}`);
            if ( ! el ) return null;
            const hr = el.getBoundingClientRect();
            const wr = w.getBoundingClientRect();
            const ix1 = Math.max(hr.left, wr.left);
            const iy1 = Math.max(hr.top, wr.top);
            const ix2 = Math.min(hr.left + hr.width, wr.left + wr.width);
            const iy2 = Math.min(hr.top + hr.height, wr.top + wr.height);
            if ( ix2 <= ix1 || iy2 <= iy1 ) return null;
            // The intersection box travels with the centre: `dragHandle` needs
            // it to keep its first nudge INSIDE the handle (see there). A
            // straight-edge handle is only 7px thick, so "centre + 3px" is
            // not automatically still on it.
            return { c: [(ix1 + ix2) / 2, (iy1 + iy2) / 2], box: [ix1, iy1, ix2, iy2] };
        }, dir);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // 🔴 THE FIRST MOVEMENT OF A DRAG MUST STAY ON THE HANDLE IT STARTED ON.
    // ═══════════════════════════════════════════════════════════════════════
    // This is the fix for the `se` failure this file carried (16/18) from the
    // day it was committed. It was a HARNESS defect, not a `UIWindow.js` one.
    // Traced to ground, in the vendored library's own source and reproduced
    // both ways:
    //
    // jQuery UI 1.13.2 does NOT decide which axis you are resizing from the
    // element you pressed. `_create` ends with (unminified from this repo's
    // own `src/lib/jquery-ui-1.13.2/jquery-ui.min.js`):
    //
    //     this._handles.on("mouseover", function () {
    //         if (!that.resizing) {
    //             if (this.className) {
    //                 n = this.className.match(/ui-resizable-(se|sw|ne|nw|n|e|s|w)/i);
    //             }
    //             that.axis = n && n[1] ? n[1] : "se";
    //         }
    //     });
    //
    // — i.e. `axis` is whatever handle the pointer was last seen OVER, and it
    // keeps being rewritten until `resizing` becomes true. `resizing` becomes
    // true in `_mouseStart`, which the jQuery UI mouse widget only calls on
    // the FIRST mousemove after mousedown that clears `distance` (default 1px).
    //
    // So there is a window of exactly one mousemove in which a stray
    // `mouseover` can silently change which axis is about to be dragged. A
    // real human drag never hits it, because a human's first mousemove after
    // pressing is a pixel or two and stays on the handle. `page.mouse.move(x,
    // y, { steps: 10 })` is not a human: for an 80px diagonal it TELEPORTS the
    // pointer 8px on its first step.
    //
    // MEASURED on the committed bundle, viewport 1440x900, window at
    // left=400 top=300 700x380:
    //   `.ui-resizable-se` is 15x15 at (1084,664)-(1099,679).
    //   `.ui-resizable-e`  is  7x380 at (1093,300)-(1100,680).
    //   `.ui-resizable-s`  is 700x7  at (400,673)-(1100,680).
    //   handleCenter('se') = (1091.5, 671.5); the first of ten steps toward
    //   (+80,+80) lands at (1099.5, 679.5) — STILL INSIDE THE WINDOW but 0.5px
    //   outside `se`'s own box, i.e. on top of `s`/`e`. Chromium delivers the
    //   `mouseover` on that handle before `_mouseStart` runs, so `axis` is
    //   rewritten to `s` and an `s` resize begins. (Deduced, not assumed: the
    //   mouseover handler quoted above is the ONLY writer of `axis`, and
    //   `_mouseStart` is observed reading `s`.)
    //   Instrumenting `_mouseStart` prints `axis=s` for exactly this drag, and
    //   `axis=se` for the identical drag issued as a single un-stepped move —
    //   which grows BOTH axes, 700x380 -> 780x460, on the same unmodified
    //   bundle. `UIWindow.js` is not involved.
    //
    // WHY ONLY `se`, AND WHY `stacking-browser-test.mjs` PASSES 578/578 ON THE
    // SAME HANDLE: `se` is the only one of the eight whose first 8px step
    // lands on ANOTHER HANDLE. Every other handle's first step leaves the
    // window's box altogether and lands on the wallpaper, which is not a
    // handle, so no `mouseover` fires on one and `axis` survives — `ne` steps
    // to (1100.5, 299.5), `sw` to (399.5, 680.5), `e` to (1104.5, 490), and so
    // on, all outside a window that spans 400..1100 by 300..680. Only `se`,
    // sitting in the corner where the `s` and `e` strips overlap its own 15x15
    // box by a pixel, steps from one handle straight onto another. It is a
    // one-handle geometric coincidence, not a resize defect — which is also why
    // `stacking-browser-test.mjs`'s `se` drag, which uses different geometry
    // and a different step count, never reproduced it.
    //
    // THE FIX, and why it makes the test MORE faithful rather than weaker: nudge
    // the pointer a few px WITHIN the handle first, so `_mouseStart` runs while
    // `axis` is still correct and `resizing` then locks it, exactly as a real
    // drag does. The pointer still ends at (h + dx, h + dy), so the total drag
    // distance, the ten-step travel and every growth threshold below are
    // unchanged. `startedOn` is returned so the caller can assert the nudge
    // really did stay on the intended handle — if a future CSS change shrinks a
    // handle below NUDGE px, this goes red with a legible reason instead of
    // silently mis-dragging some other axis.
    const NUDGE = 3;

    async function dragHandle (dir, dx, dy) {
        const found = await handleCenter(dir);
        if ( ! found ) return null;
        const h = found.c;
        const [ix1, iy1, ix2, iy2] = found.box;
        // Clamp 1px inside the handle's clickable box, so the nudge cannot
        // itself walk off a 7px edge handle and hand the axis to a neighbour —
        // which is the very failure this nudge exists to prevent.
        const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
        const nx = clamp(h[0] + Math.sign(dx) * NUDGE, ix1 + 1, ix2 - 1);
        const ny = clamp(h[1] + Math.sign(dy) * NUDGE, iy1 + 1, iy2 - 1);
        // Read the hit target BEFORE pressing: `resizable`'s own `start`
        // callback sets `pointer-events: none` on every `.window`, so an
        // `elementFromPoint` taken mid-drag would answer about the wallpaper.
        const startedOn = await page.evaluate(([x, y]) => {
            const el = document.elementFromPoint(Math.round(x), Math.round(y));
            return /ui-resizable-(se|sw|ne|nw|n|e|s|w)\b/.exec(el?.className ?? '')?.[1] ?? null;
        }, [nx, ny]);
        await page.mouse.move(h[0], h[1]);
        await page.mouse.down();
        await page.mouse.move(nx, ny);
        await page.mouse.move(h[0] + dx, h[1] + dy, { steps: 10 });
        await page.mouse.up();
        await sleep(200);
        // 🔴 `nudgePx` matters as much as `startedOn`. If the clamp above
        // squeezed the nudge to zero (a handle only 2px thick in the drag's
        // axis), the pointer never moved before the ten-step travel and
        // jQuery UI's `_mouseStart` fires on a step that may already be over a
        // different handle — the original defect, back again and invisible.
        // jQuery UI's mouse `distance` default is 1px, so <1 is "no nudge".
        return {
            startedOn,
            nudgePx: Math.max(Math.abs(nx - h[0]), Math.abs(ny - h[1])),
        };
    }

    /** Directions whose drag did not start on their own handle, per sweep. */
    let strayStarts = [];

    async function runDirection (dir, topValue, label) {
        await setGeometry(topValue);
        const before = await rectOf();
        const [dx, dy] = DELTA[dir];
        const dragged = await dragHandle(dir, dx, dy);
        if ( ! dragged ) {
            skip(`${label}: "${dir}" resize handle not found/zero-size (not resizable in this state)`);
            return;
        }
        if ( dragged.startedOn !== dir ) strayStarts.push(`${dir}: first move landed on "${dragged.startedOn}"`);
        else if ( dragged.nudgePx < 1 ) strayStarts.push(`${dir}: no room to nudge (${dragged.nudgePx}px)`);
        const after = await rectOf();
        const affects = AFFECTS[dir];

        const notDegenerate = !! after && after.width > 0 && after.height > 0;
        const widthOk = ! after ? false
            : affects.w ? (after.width - before.width) > MIN_GROWTH
                : Math.abs(after.width - before.width) <= STABLE;
        const heightOk = ! after ? false
            : affects.h ? (after.height - before.height) > MIN_GROWTH
                : Math.abs(after.height - before.height) <= STABLE;

        push(
            `${label}: dragging "${dir}" grows the axis it owns, leaves the other alone, never collapses`,
            notDegenerate && widthOk && heightOk,
            `before=${JSON.stringify(before)} after=${JSON.stringify(after)} `
            + `affects=${JSON.stringify(affects)} startedOn=${dragged.startedOn}`,
        );
    }

    // 🔴 The guard for the defect that made this file 16/18. jQuery UI picks
    // the axis from the last handle the pointer was seen OVER (see dragHandle),
    // so a drag can silently resize a DIFFERENT axis than the one under test
    // and report it as "the handle doesn't grow width". This check names that
    // condition instead of leaving it to be re-diagnosed from a geometry dump.
    const strayCheck = (label) => {
        push(`${label}: every drag started on the handle it was aimed at`,
            strayStarts.length === 0,
            strayStarts.length
                ? `stray starts: ${strayStarts.join('; ')} — the pointer was not on the intended `
                  + 'handle when jQuery UI latched the axis, so these drags resized something else'
                : `all ${HANDLES.length} handles`);
        strayStarts = [];
    };

    for ( const dir of HANDLES ) {
        await runDirection(dir, `${PRISTINE.top}px`, 'ALL-HANDLES (plain-px top)');
    }
    strayCheck('ALL-HANDLES (plain-px top)');
    // Re-run every handle with `top` as a `calc()` string the browser must
    // resolve itself — T18's specific theory, re-tested per-handle (the
    // original probe only ever tried `se`). If `calc()` mattered, this sweep
    // would diverge from the plain-px sweep above; MEASURED: it does not.
    for ( const dir of HANDLES ) {
        await runDirection(dir, PRISTINE_CALC_TOP, 'CALC-TOP-EQUIVALENCE');
    }
    strayCheck('CALC-TOP-EQUIVALENCE');

    push('no uncaught page errors during the whole resize sweep', page_errors.length === 0, page_errors.join(' | '));
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
    process.exit(1);
}
process.exit(0);
