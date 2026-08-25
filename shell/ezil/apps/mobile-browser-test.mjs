// mobile-browser-test.mjs — EZiL-authored. REAL-BROWSER, REAL-PHONE-VIEWPORT
// test for the shell on a touch device: which device class the body actually
// gets, what shape the streamed desktop is given inside a phone-shaped window,
// and whether ONE tap reaches the stream.
//
// Run:  node shell/ezil/apps/mobile-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every other `*-test.mjs` in this tree)
//
// Requires `playwright` (with a Chromium build) resolvable from this file, OR
// from a directory named by $PLAYWRIGHT_REQUIRE_DIR — same convention as
// `os-chrome-browser-test.mjs`. Not a project dependency. If neither resolves
// this exits 2 (skip), never 0.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE GAP THIS FILE CLOSES
// ═══════════════════════════════════════════════════════════════════════════
// Before this file, NO test in this repository had ever run at a phone
// viewport and none had ever enabled touch. Verified exhaustively across the
// tree, at the point this file was written:
//
//   - every playwright launch was a bare `chromium.launch()` + `newPage()`;
//     no `webkit`, no `firefox`, no `playwright.devices`;
//   - no `hasTouch`, no `isMobile`, no `deviceScaleFactor`, no `userAgent`
//     override anywhere;
//   - the smallest viewport in the repository was 820x1180, labelled "tablet"
//     (`shell/ezil/display-notice-browser-test.mjs`); everything else was
//     1024x768 or larger — all of them with a mouse and a desktop UA.
//
// `boot.js`'s `set_device_class` keys off `isMobile.phone`/`isMobile.tablet`,
// which are pure `navigator.userAgent` regexes (see `src/lib/isMobile.min.js`).
// So with no UA override, not one of the ~40 `.device-phone`/`.device-tablet`
// rules in `style.css`, and neither of the `isMobile.phone` branches in
// `UITaskbar.js`/`UITaskbarItem.js`, had ever been executed by a test. The
// mobile half of this OS was, in test terms, dead code.
//
// 🔴 THE UA IS LOAD-BEARING, NOT DECORATION. A context with `hasTouch: true`
// and a 390x844 viewport but a desktop UA produces `device-desktop` and
// exercises exactly none of the above. Every phone context below therefore
// sets a real iPhone UA, and `scenarioNarrowUA` exists precisely to pin the
// case where the UA is a desktop one and the device is not.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT IS STUBBED, AND WHY IT IS NOT THE THING UNDER TEST
// ═══════════════════════════════════════════════════════════════════════════
// The only stub is the cross-origin neko SPA, replaced by a same-origin page
// that renders its picture at 16:9 in its own black and records the input
// events it receives — the same stand-in `os-chrome-browser-test.mjs` uses,
// for the same reason (there is no container in a unit run). It is a stand-in
// for the ENVIRONMENT, never for the behaviour being measured: nothing here
// stubs focus, pointer-events, device detection, or the fit of the stream box,
// which are the four things this file exists to ask about. The tap check in
// particular reads the events that actually arrived inside the frame, not a
// class the shell wrote on itself.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 ASSERTIONS THAT ARE RED ON `main` BY DESIGN, AND WHOSE FIX THEY AWAIT
// ═══════════════════════════════════════════════════════════════════════════
// This file was written against the Browser-fix contract's INTENDED behaviour
// while the fixes were still in flight, so some checks are red until they
// land. Each is tagged `[awaits Wn]` in its own name so a run is readable
// without this header. MEASURED on the unmodified bundle of 2026-08-19:
//
//   [awaits W5] "ONE tap reaches the stream" — RED.
//       Every click-to-focus binding in `UIWindow.js` is `mousedown`-only and
//       `.window-app-iframe` is `pointer-events: none` until `.window-active`
//       (`style.css`), which `focusWindow` also writes INLINE. MEASURED, via
//       a fully real gesture sequence (tap the drawer's Settings, tap
//       Settings' close, tap the stream): the stream frame receives
//       [] — nothing at all. The tap is entirely consumed by focusing the
//       window; the user must tap a second time. MEASURED with a W5-shaped
//       `pointerdown` binding added alongside the existing `mousedown` ones:
//       the SAME single tap delivers ["mousedown","click"] into the frame.
//       So this check is satisfiable, and `pointerdown` is what satisfies it.
//
//   [awaits W2] "the stream's box is not a letterboxed strip" — RED on
//       portrait phone and on tablet, GREEN on landscape phone. `fit_stream`
//       (`apps/desktop-window.js`, W2's file per contract §4.3) letterboxes to
//       a hardcoded 16:9. MEASURED: on a 390x844 portrait phone the window is
//       correctly full-bleed at 390x844 and the stream inside it is 390x219 —
//       26% of the window body, a strip across the middle of a phone screen.
//       On a 820x1180 tablet it is 820x461, 40%. In landscape (844x390) it is
//       693x390, 82%, and this check passes — which is how you can tell the
//       threshold discriminates on shape rather than simply always failing.
//
//   [awaits W7] "a narrow COARSE-pointer viewport is device-phone" — RED.
//       Detection is pure UA sniffing, so a phone-shaped, touch-only viewport
//       with a desktop UA gets `device-desktop`. Contract §7.3.
//
//   [awaits W7] "the visual viewport shrinking resizes the desktop" — RED.
//       Contract §7.3 wants a `visualViewport` listener so a raised keyboard
//       resizes the desktop instead of covering it. Playwright cannot raise a
//       soft keyboard, so this drives the API's own signal directly (shadow
//       the `height` getter, dispatch `resize` on `visualViewport`) and asks
//       whether the full-bleed window followed. That is emulating the SIGNAL,
//       not the behaviour: nothing here tells the shell what to do about it.
//
// That is 5 red of 39 on the unmodified bundle: 2x[awaits W2], 1x[awaits W5],
// 2x[awaits W7]. Everything else is green on `main` and is a regression guard —
// in particular `scenarioWideDesktop`, which is the "add, do not replace" half
// of contract §7.1/§7.3: a mouse-driven desktop must keep `device-desktop` and
// must keep its eight resize handles.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHERE THIS FILE'S OWN CHECKS GET THEIR DISCRIMINATING POWER
// ═══════════════════════════════════════════════════════════════════════════
// Contract §10.2: a test that mocks the thing it tests proves nothing. Each of
// the load-bearing checks here has a paired opposite IN THIS FILE, so its
// power is demonstrated by the run itself rather than asserted in a comment:
//
//   device-phone      phone UA -> device-phone (green) vs the SAME 390x844
//                     coarse viewport with a desktop UA -> device-desktop
//                     (red). Same geometry, one input different.
//   letterbox         portrait 26% (red) vs landscape 82% (green), same code,
//                     same threshold — so the threshold reads the window's
//                     shape, not the code's version.
//   resize handles    phone windowed 0/8 (green) vs desktop windowed 8/8
//                     (green). Either one alone is satisfied by a bug: the
//                     full-bleed rule hides handles on EVERY device, which is
//                     what an earlier draft of this file measured by mistake.
//   the tap           first tap [] (red) vs second tap
//                     ["pointerdown","touchstart","mousedown","click"] (green)
//                     — the control proves the harness can see taps at all, so
//                     the red one is about focus and not about plumbing.
//   hitBox            measured, not read off the box: with the walk wrongly
//                     accepting ANCESTORS a 36px drawer button reported 79x42.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY NONE OF THIS IS jsdom-ABLE
// ═══════════════════════════════════════════════════════════════════════════
// jsdom has no layout (so no `getBoundingClientRect` on the fitted stream box,
// which is the whole letterbox claim), no `elementFromPoint` (so no honest
// answer to "is this 36px control actually tappable"), no hit testing for
// `pointer-events`, no touch input, no compatibility-mouse-event synthesis
// after a tap — which is the exact mechanism the W5 check turns on — and no
// `visualViewport`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_OS_DIR
    ? path.resolve(process.env.EZIL_OS_DIR)
    : path.resolve(here, '../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first (or check EZIL_OS_DIR)`);
        process.exit(2);
    }
}

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
        'playwright is not resolvable from this file or $PLAYWRIGHT_REQUIRE_DIR. This is a '
        + 'REAL-BROWSER, REAL-TOUCH test — jsdom has no layout, no elementFromPoint, no hit '
        + 'testing, no touch input and no visualViewport, so it cannot answer a single '
        + 'question this file asks (see header). Install playwright (e.g. `bunx '
        + 'playwright@1.62.1 install chromium` in some directory and set '
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

const HOST = 'https://ezil-mobile-test.invalid';
// 🔴 The `<meta name="viewport">` is not cosmetic. Chromium's `isMobile: true`
// emulation applies a mobile layout viewport, and without this tag it would
// lay the page out at a 980px default and then scale it down — so every
// measurement below would be of a shrunken desktop page, not of a phone.
// `app/src/app/layout.tsx` ships this same tag via Next's viewport export.
const DOC_HTML = `<!doctype html><html class="h-full"><head>
 <meta name="viewport" content="width=device-width, initial-scale=1">
 <style>${css}</style>
 <style>html{height:100%}body{min-height:100%;margin:0}</style></head>
 <body class="min-h-full"><div id="ezil-os-root"><div id="ezil-os-root-inner"></div></div></body></html>`;

// The stand-in for the cross-origin neko SPA. Same 16:9-in-its-own-black shape
// `os-chrome-browser-test.mjs` uses, plus a recorder: `window.__hits` is the
// list of input events that ACTUALLY arrived inside the frame. That list, read
// back out of the frame, is the entire evidence for the tap check — not
// anything the shell says about itself.
const FAKE_STREAM = `<!doctype html><html><head><style>
 html,body{margin:0;height:100%;background:#000;display:flex;align-items:center;justify-content:center}
 .scr{width:min(100vw,calc(100vh * 16 / 9));height:min(100vh,calc(100vw * 9 / 16));background:#14484c}
</style></head><body><div class="scr"></div>
<script>
 window.__hits = [];
 for ( const t of ['pointerdown', 'touchstart', 'mousedown', 'click'] ) {
   window.addEventListener(t, () => { window.__hits.push(t); }, true);
 }
</script></body></html>`;

const COMPUTER = {
    id: 'c-1', name: 'Computer', slot: 1,
    createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    codePreviewUrl: '/api/shell/code-preview-url',
    focus: '/api/shell/focus',
};

/**
 * The §3 mode table, verbatim from `docs/BROWSER-FIX-CONTRACT.md`. Duplicated
 * here ON PURPOSE: this file is a harness standing in for the app layer, and a
 * harness that imported the shell's own idea of the table would agree with the
 * shell by construction and prove nothing about the wire between them.
 */
const SCREEN_MODES = [
    [1920, 1080], [1600, 900], [1280, 720], [1440, 900], [1280, 800], [1024, 768],
    [1280, 1024], [1200, 1600], [1080, 1920], [896, 1600], [720, 1280], [768, 1024],
];

/** The POST body, or null. Playwright hands it over as a string. */
function readBody (req) {
    try { return JSON.parse(req.postData() ?? 'null'); } catch { return null; }
}

/**
 * Snap `{width,height}` to the §3 table — by aspect ratio first, then by area,
 * exactly as §3 specifies. Returns `null` for an absent or unusable ask, which
 * is what makes the "old bundle against a new server" path testable.
 */
function snapScreen (asked) {
    const w = asked?.width, h = asked?.height;
    if ( ! Number.isFinite(w) || ! Number.isFinite(h) || w <= 0 || h <= 0 ) return null;
    const want = w / h;
    let best = null, bestAspect = Infinity, bestArea = Infinity;
    for ( const [mw, mh] of SCREEN_MODES ) {
        const da = Math.abs((mw / mh) - want);
        const dz = Math.abs((mw * mh) - (w * h));
        if ( da < bestAspect - 1e-9 || (Math.abs(da - bestAspect) <= 1e-9 && dz < bestArea) ) {
            best = { width: mw, height: mh }; bestAspect = da; bestArea = dz;
        }
    }
    if ( ! best ) return null;
    const exact = best.width === w && best.height === h;
    return { ...best, source: exact ? 'requested' : 'snapped' };
}
const PAYLOAD = {
    user: { id: 'u-1', email: 'someone@example.com' },
    computer: COMPUTER,
    apps: [{ id: 'desktop', name: 'Browser', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true,
        status: 'idle', endpoints: ENDPOINTS,
    },
};

// Real shipped UA strings. `isMobile` matches `/iPhone/i` and `/iPad/i`
// literally, so anything invented would either miss or match for the wrong
// reason. The desktop one is here to be the CONTROL, not a fallback.
const UA = {
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    ipad: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    desktop: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
};

// iPhone 14/15-class portrait, at its real device pixel ratio. 3 is not
// decoration: `deviceScaleFactor` is what makes a CSS pixel a third of a
// device pixel, which is the regime every "is this control big enough"
// question below is actually about.
const PHONE = {
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
    isMobile: true, hasTouch: true, userAgent: UA.iphone,
};
const PHONE_LANDSCAPE = { ...PHONE, viewport: { width: 844, height: 390 } };
const TABLET = {
    viewport: { width: 820, height: 1180 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true, userAgent: UA.ipad,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WCAG 2.2 SC 2.5.8 "Target Size (Minimum)", AA. A published floor, not a
 *  number chosen to make today's numbers pass. Apple HIG and WCAG 2.5.5 (AAA)
 *  both want 44; where a control is between the two this file says so in the
 *  detail rather than silently accepting or silently failing it. */
const MIN_TARGET = 24;
const RECOMMENDED_TARGET = 44;

const browser = await chromium.launch();
let anyHardFailure = false;

for ( const scenario of [
    scenarioPhonePortrait,
    scenarioPhoneLandscape,
    scenarioTablet,
    scenarioNarrowUA,
    scenarioWideDesktop,
] ) {
    try {
        await scenario();
    } catch ( err ) {
        anyHardFailure = true;
        push(`${scenario.name}: harness threw without completing`, false, String(err?.stack ?? err));
    }
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length || anyHardFailure ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
    const awaiting = failed.filter((f) => /\[awaits W\d+\]/.test(f.name));
    if ( awaiting.length ) {
        console.log(
            `\n${awaiting.length} of the ${failed.length} failure(s) are tagged [awaits Wn]: they assert the\n`
            + 'Browser-fix contract\'s intended behaviour and are expected to be red until that\n'
            + 'agent\'s change lands. See this file\'s header for the measured `main` values.');
    }
    process.exit(1);
}
process.exit(0);

// ═══════════════════════════════════════════════════════════════════════════
// harness
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A booted shell in its own CONTEXT — `isMobile`, `hasTouch`,
 * `deviceScaleFactor` and `userAgent` are context options in playwright, not
 * page options, which is why this cannot use `browser.newPage({viewport})`
 * the way the other browser suites in this tree do.
 */
async function boot (contextOpts) {
    const ctx = await browser.newContext(contextOpts);
    const page = await ctx.newPage();
    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
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
        // Matched on the PATH: the `confirm=frame` probe carries the frame's
        // own URL in a query parameter, so a substring match on the frame
        // token would answer the JSON probe with HTML.
        if ( url.startsWith(`${HOST}/frame?`) ) {
            await route.fulfill({ status: 200, contentType: 'text/html', body: FAKE_STREAM });
            return;
        }
        if ( url.includes('/api/') ) {
            let body = { ok: true };
            if ( url.includes('confirm=frame') ) body = { ok: true, confirmed: true, status: 200 };
            else if ( url.includes('confirm=display') ) body = { ok: true, display: 'live' };
            else if ( url.includes(ENDPOINTS.desktop) ) {
                if ( req.method() === 'POST' ) {
                    // 🔴 THIS MOCK SPEAKS CONTRACT §4.1 — ADDED BY INTEGRATION,
                    // 2026-08-19. It used to answer with no `screen` field at
                    // all, and the two `[awaits W2]` checks below stayed red
                    // even after W2 landed. That was the HARNESS being wrong,
                    // not the shell: per §4.1 an ABSENT `screen` means "server
                    // behaves exactly as today", so the shell correctly kept
                    // `stream` at 1920x1080 and correctly letterboxed a phone to
                    // a 16:9 strip. A mock that cannot express the fix can only
                    // ever measure the defect.
                    //
                    // So it now does what the real app layer does: read the
                    // OPTIONAL `screen` the shell measured, snap it to the §3
                    // table, and report back what was applied plus a `source`.
                    // The shell is still free to send nothing — `snapScreen`
                    // answers null and the response omits the field, which is
                    // the backward-compatibility path §4.1 requires and which
                    // the `[desktop-control]` scenarios still exercise.
                    const asked = readBody(req)?.screen;
                    const applied = snapScreen(asked);
                    body = {
                        ok: true,
                        guacamoleUrl: `${HOST}/frame?desktop=1`,
                        frame: { confirmed: true },
                        ...(applied ? { screen: applied } : {}),
                    };
                } else {
                    body = { ok: true, guacamoleRunning: true };
                }
            } else if ( url.includes(ENDPOINTS.codePreviewUrl) ) {
                body = { ok: true, codePreviewUrl: `${HOST}/frame?code=1`, expiresAt: Date.now() + 300_000 };
            } else if ( url.includes(ENDPOINTS.previewUrl) ) {
                body = { ok: true, appPreviewUrl: `${HOST}/frame?preview=1`, expiresAt: Date.now() + 300_000 };
            }
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
    await page.evaluate(async () => { await window.ezil.boot(); });
    // Login opens nothing (see `boot.js`); the Browser is opened by the same
    // dock activation a real user performs.
    await page.evaluate(() => { $('.taskbar-item[data-app="desktop"]').trigger('click'); });
    await sleep(1800);
    return { ctx, page, page_errors };
}

/** Everything worth knowing about the phone-shaped shell, in one round trip. */
function readState (page) {
    return page.evaluate(() => {
        const rect = (el) => {
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
        };
        const w = document.querySelector('.window[data-app="desktop"]');
        const body = w?.querySelector('.window-body');
        const frame = w?.querySelector('.window-app-iframe');
        return {
            deviceClass: ['device-phone', 'device-tablet', 'device-desktop']
                .find((c) => document.body.classList.contains(c)) ?? null,
            bodyClass: document.body.className,
            hoverHover: matchMedia('(hover: hover)').matches,
            pointerCoarse: matchMedia('(pointer: coarse)').matches,
            dpr: window.devicePixelRatio,
            viewport: { w: window.innerWidth, h: window.innerHeight },
            visual: window.visualViewport
                ? { w: Math.round(visualViewport.width), h: Math.round(visualViewport.height) } : null,
            exists: !! w,
            fullbleed: !! w?.classList.contains('ezil-fullbleed'),
            active: !! w?.classList.contains('window-active'),
            fullpageMode: document.body.classList.contains('fullpage-mode'),
            win: rect(w), wbody: rect(body), frame: rect(frame),
            framePointerEvents: frame ? getComputedStyle(frame).pointerEvents : null,
        };
    });
}

/**
 * The EFFECTIVE tappable size of a control, measured by hit testing rather
 * than by reading its box.
 *
 * 🔴 Reading `getBoundingClientRect()` answers "how big is this element",
 * which is not the question. A control can be a 12px disc inside a 24px pad,
 * or a 36px box with something invisible over half of it. This walks outward
 * from the control's centre in 1px steps in all four directions and stops
 * where `document.elementFromPoint` stops resolving to the control — i.e. it
 * measures the area a thumb can actually land on, which is what a target-size
 * standard is about.
 */
function hitBox (page, selector) {
    return page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if ( ! el ) return null;
        const r = el.getBoundingClientRect();
        if ( r.width <= 0 || r.height <= 0 ) return { w: 0, h: 0, box: null, reason: 'zero-size box' };
        const cx = Math.round(r.left + r.width / 2);
        const cy = Math.round(r.top + r.height / 2);
        // 🔴 `el.contains(hit)` only — NEVER `hit.contains(el)`. Accepting an
        // ANCESTOR as "still this control" makes the walk run all the way
        // across the container: measured that way a 36px drawer button
        // reported 79x42, because the drawer itself owns the gap either side
        // of it. The question is how much of the screen belongs to THIS
        // control, and its container's area is precisely what does not.
        const owns = (x, y) => {
            const hit = document.elementFromPoint(x, y);
            return !! hit && (hit === el || el.contains(hit));
        };
        if ( ! owns(cx, cy) ) {
            const hit = document.elementFromPoint(cx, cy);
            return { w: 0, h: 0, box: { x: cx, y: cy }, reason: `centre is covered by ${hit?.className || hit?.tagName || 'nothing'}` };
        }
        const walk = (dx, dy) => { let n = 0; while ( n < 80 && owns(cx + dx * (n + 1), cy + dy * (n + 1)) ) n++; return n; };
        const l = walk(-1, 0), rr = walk(1, 0), u = walk(0, -1), d = walk(0, 1);
        return { w: l + rr + 1, h: u + d + 1, box: { x: cx, y: cy }, reason: null };
    }, selector);
}

/**
 * Take the Browser out of full-bleed and report its resize handles.
 *
 * 🔴 THE EXIT IS NOT OPTIONAL, AND LEAVING IT OUT MADE THIS CHECK LIE. A
 * first draft asked about the handles while the window was still full-bleed
 * and read 0/8 live on a PHONE — which looked like proof that
 * `style.css:735`'s `.device-phone .window .ui-resizable-handle {display:none}`
 * had executed. It had not: `ezil-shell.css`'s
 * `.ezil-desktop-window.ezil-fullbleed > .ui-resizable-handle` hides them on
 * every device, so the same draft also read 0/8 on a 1440x900 DESKTOP, where
 * eight handles are required. Two rules, one observable, and the full-bleed
 * one wins first — so the device rule can only be measured on a windowed
 * window, which is what this does.
 */
async function windowedHandles (page) {
    await page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        if ( w?.classList.contains('ezil-fullbleed') ) {
            w.classList.remove('ezil-fullbleed');
            window.exit_fullpage_mode(w);
        }
    });
    await sleep(400);
    return page.evaluate(() => {
        const w = document.querySelector('.window[data-app="desktop"]');
        return [...w.querySelectorAll(':scope > .ui-resizable-handle')].map((h) => {
            const r = h.getBoundingClientRect();
            return {
                cls: h.className.replace('ui-resizable-handle ', ''),
                display: getComputedStyle(h).display,
                live: getComputedStyle(h).display !== 'none' && r.width > 0 && r.height > 0,
            };
        });
    });
}

/**
 * Put the desktop window OUT of focus using nothing but real taps, so that the
 * tap check below starts from the state a phone user is actually in.
 *
 * 🔴 No synthetic blur, no `removeClass('window-active')`. The state under
 * test is "some other window took focus and the stream's iframe therefore has
 * `pointer-events: none`", and `focusWindow` writes that INLINE on every other
 * window's iframe — so faking the class would leave the inline style behind
 * and the check would pass against the bug. The route here is the one the
 * full-bleed drawer offers: tap Settings, then tap Settings' close.
 * MEASURED to leave `.window[data-app="desktop"]` without `window-active` and
 * its iframe at a computed `pointer-events: none`, which the caller asserts
 * before it taps.
 */
async function defocusDesktopByTapping (page) {
    const at = async (sel) => page.evaluate((s) => {
        const el = document.querySelector(s);
        if ( ! el ) return null;
        const r = el.getBoundingClientRect();
        if ( r.width <= 0 || r.height <= 0 ) return null;
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    }, sel);

    const settings = await at('.window[data-app="desktop"] .dashboard-app-drawer-settings');
    if ( ! settings ) return 'no Settings button in the drawer';
    await page.touchscreen.tap(settings[0], settings[1]);
    // 🔴 WAIT FOR THE WINDOW, do not sleep at it. This used to be
    // `sleep(1200)` / `sleep(900)`, and the pair made this whole scenario
    // FLAKY: measured over three runs each, the fixed sleeps produced 2/3 on
    // `main` and 1/3 on a branch that had not touched focus at all. When the
    // close animation had not settled inside 900ms the desktop was still
    // `window-active`, the very next check — "the iframe is
    // pointer-events:none while unfocused" — failed, and the failure looked
    // exactly like a real focus regression. A precondition that fails at
    // random is worse than no precondition: it spends the reader's trust on
    // noise and hides the run where something genuinely broke.
    if ( ! await waitFor(page, () => !! document.querySelector('.window[data-app="settings"]'), 4000) ) {
        return 'Settings never opened';
    }
    // 🔴 WAIT FOR IT TO STOP MOVING before measuring where to tap. Settings
    // opens with a launch morph, so its close button is still travelling for
    // a few hundred ms; a rect sampled during that lands the tap on empty
    // space and the window never closes. That was the residue of this flake
    // after the fixed sleeps were removed — the failure had simply moved from
    // "still focused" to "Settings never closed".
    const closeSel = '.window[data-app="settings"] .window-head > .window-close-btn';
    if ( ! await waitForTappable(page, closeSel) ) return 'the Settings close control never became tappable';
    const close = await at(closeSel);
    if ( ! close ) return 'Settings did not open, or has no close control';
    await page.touchscreen.tap(close[0], close[1]);
    if ( ! await waitFor(page, () => ! document.querySelector('.window[data-app="settings"]'), 4000) ) {
        const diag = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if ( ! el ) return { gone: true };
            const r = el.getBoundingClientRect();
            const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
            const hit = document.elementFromPoint(x, y);
            return { rect: [r.left, r.top, r.width, r.height].map(Math.round),
                     topmost: hit ? (hit.className || hit.tagName) : null,
                     pe: getComputedStyle(el).pointerEvents,
                     vis: getComputedStyle(el).visibility,
                     op: getComputedStyle(el).opacity };
        }, closeSel);
        console.log('  DIAG after failed tap: ' + JSON.stringify(diag));
        const viaClick = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if ( ! el ) return 'gone';
            el.click();
            return 'clicked';
        }, closeSel);
        const closedNow = await waitFor(page, () => ! document.querySelector('.window[data-app="settings"]'), 3000);
        console.log(`  DIAG fallback el.click() -> ${viaClick}, closed=${closedNow}`);
        return 'Settings never closed';
    }
    // The condition the caller actually depends on, waited for explicitly and
    // reported as a NAMED failure if it never arrives — so "the tap round trip
    // did not defocus" can never again be read as "focus is broken".
    if ( ! await waitFor(page, () => {
        const el = document.querySelector('.window[data-app="desktop"]');
        return !! el && ! el.classList.contains('window-active');
    }, 4000) ) {
        return 'the Browser was still focused after closing Settings';
    }
    return null;
}

/**
 * Wait until an element is genuinely TAPPABLE at its own centre.
 *
 * 🔴 Not "does it exist", and not "has its box stopped moving" — both were
 * tried and both still flaked. Tapping is a COORDINATE operation:
 * `touchscreen.tap` goes to a point, and whatever is topmost at that point
 * receives it. Measured on failing runs of this very file, `elementFromPoint`
 * at the Settings close button's centre returned
 * `window-body window-body-app ui-droppable` — the window BODY was over the
 * head — while passing runs returned `window-action-btn window-close-btn`.
 * The rect was correct every time; the point was occluded.
 *
 * So the condition is hit-testing, which is the only thing that actually
 * predicts whether the tap will land. Roughly 2 runs in 5 of this scenario
 * failed before this existed, and the failure surfaced two checks later as
 * "the Browser is still focused" — indistinguishable from a real focus
 * regression, which is exactly what makes an unstable harness expensive.
 */
async function waitForTappable (page, selector, timeoutMs = 5000, stepMs = 60) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const ok = await page.evaluate((sel) => {
            const el = document.querySelector(sel);
            if ( ! el ) return false;
            const r = el.getBoundingClientRect();
            if ( r.width <= 0 || r.height <= 0 ) return false;
            const x = Math.round(r.left + r.width / 2);
            const y = Math.round(r.top + r.height / 2);
            if ( x < 0 || y < 0 || x > innerWidth || y > innerHeight ) return false;
            const hit = document.elementFromPoint(x, y);
            return !! hit && (hit === el || el.contains(hit) || hit.contains(el));
        }, selector);
        if ( ok ) return true;
        if ( Date.now() >= deadline ) return false;
        await sleep(stepMs);
    }
}

/**
 * Poll a predicate IN THE PAGE until it holds or the budget runs out.
 *
 * `page.waitForFunction` would do this, but it is not available on every
 * Playwright surface this file runs against and it throws on timeout, where
 * every caller here wants a boolean it can turn into a named failure string.
 */
async function waitFor (page, fn, timeoutMs = 4000, stepMs = 50) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if ( await page.evaluate(fn) ) return true;
        if ( Date.now() >= deadline ) return false;
        await sleep(stepMs);
    }
}

/** Tap the centre of the stream and report what arrived INSIDE the frame. */
async function tapStream (page) {
    const point = await page.evaluate(() => {
        const f = document.querySelector('.window[data-app="desktop"] .window-app-iframe');
        if ( ! f ) return null;
        const r = f.getBoundingClientRect();
        return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)];
    });
    if ( ! point ) return { point: null, hits: null };
    const frame = page.frames().find((f) => f.url().includes('/frame?'));
    if ( ! frame ) return { point, hits: null };
    await frame.evaluate(() => { window.__hits = []; });
    await page.touchscreen.tap(point[0], point[1]);
    await sleep(400);
    return { point, hits: await frame.evaluate(() => window.__hits.slice()) };
}

/** Shared full-bleed geometry claims, used by all three touch scenarios. */
async function assertFullbleedFit (L, s, label) {
    push(`${L} the Browser is full-bleed on a ${label}`, s.fullbleed === true && s.fullpageMode === true,
        JSON.stringify({ fullbleed: s.fullbleed, fullpageMode: s.fullpageMode }));

    // 🔴 MEASURED from `getBoundingClientRect`, never from CSS. `100dvh` and
    // `width: 100%` are strings; whether they produced a box the size of the
    // screen is a different question, and it is the only one that matters.
    push(`${L} ...and full-bleed really means the whole screen (measured, not CSS)`,
        !! s.win && Math.abs(s.win.w - s.viewport.w) <= 1 && Math.abs(s.win.h - s.viewport.h) <= 1
        && Math.abs(s.win.x) <= 1 && Math.abs(s.win.y) <= 1,
        `window=${JSON.stringify(s.win)} viewport=${JSON.stringify(s.viewport)}`);

    // 🔴 THE LETTERBOX CLAIM, contract §1 and §4.3 (W2's `fit_stream`).
    // Expressed as a fraction of the window body's AREA rather than as an
    // aspect ratio, deliberately: "the box is 16:9" is satisfied by a 16:9
    // strip 26% of the way up a phone screen, which is the defect. What a user
    // reports is "my desktop is a letterbox", and area is what that means.
    const bodyArea = (s.wbody?.w ?? 0) * (s.wbody?.h ?? 0);
    const frameArea = (s.frame?.w ?? 0) * (s.frame?.h ?? 0);
    const cover = bodyArea > 0 ? frameArea / bodyArea : 0;
    const MIN_COVER = 0.6;
    push(`${L} 🔴 [awaits W2] the stream fills the window, not a letterboxed strip (>=${MIN_COVER * 100}% of the body)`,
        cover >= MIN_COVER,
        `stream=${s.frame?.w}x${s.frame?.h} in body=${s.wbody?.w}x${s.wbody?.h} = ${(cover * 100).toFixed(0)}% of it`);
    return cover;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — a portrait phone: device class, fit, targets, and ONE tap
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioPhonePortrait () {
    const L = '[phone-portrait]';
    const { ctx, page, page_errors } = await boot(PHONE);
    const s = await readState(page);

    // ── setup guards: this really is a phone ────────────────────────────────
    // 🔴 First, because every claim after it is meaningless otherwise, and
    // because the whole point of this file is that no previous test ever got
    // here. If these three go red the rest of the scenario's failures are
    // noise, and the run should say so rather than making someone re-derive it.
    push(`${L} setup: the emulated device is touch-only and coarse-pointered`,
        s.pointerCoarse === true && s.hoverHover === false && s.dpr === 3,
        JSON.stringify({ coarse: s.pointerCoarse, hover: s.hoverHover, dpr: s.dpr }));
    push(`${L} setup: the layout viewport is the phone's, not a scaled-down 980px desktop`,
        s.viewport.w === 390 && s.viewport.h === 844, JSON.stringify(s.viewport));

    // 🔴 THE ONE THAT UNLOCKS ~40 CSS RULES. `set_device_class` writes this on
    // <body>, and every `.device-phone .window*` rule in `style.css` hangs off
    // it. No test in this repository had ever produced it.
    push(`${L} 🔴 <body> actually carries device-phone on a phone`,
        s.deviceClass === 'device-phone', `deviceClass=${s.deviceClass} bodyClass="${s.bodyClass}"`);

    await assertFullbleedFit(L, s, 'portrait phone');

    // ── the drawer: the only chrome a full-bleed phone has ──────────────────
    // In full-bleed the window head and the taskbar are both hidden (by
    // design — the drawer replaces them), so the drawer IS the exit. If it is
    // not tappable, the user is trapped in the stream.
    const drawerBtns = await page.evaluate(() =>
        [...document.querySelectorAll('.window[data-app="desktop"] .dashboard-app-drawer-btn')]
            .map((b) => ({
                cls: [...b.classList].find((c) => c.startsWith('dashboard-app-drawer-') && c !== 'dashboard-app-drawer-btn') ?? b.className,
                label: b.getAttribute('aria-label') ?? '',
            })));
    push(`${L} the full-bleed drawer offers a real set of controls`,
        drawerBtns.length >= 3 && drawerBtns.every((b) => !! b.label),
        JSON.stringify(drawerBtns.map((b) => b.label)));

    const targets = [];
    for ( const b of drawerBtns ) {
        const hb = await hitBox(page, `.window[data-app="desktop"] .${b.cls}`);
        targets.push({ label: b.label, ...hb });
    }
    // 🔴 The measured HIT area, not the CSS box — see `hitBox`. WCAG 2.2
    // SC 2.5.8 (AA) is the floor being asserted; the detail reports how each
    // control sits against the 44px Apple HIG / WCAG 2.5.5 recommendation, so
    // a control that clears the floor but not the guidance is visible rather
    // than silently accepted.
    push(`${L} every drawer control is tappable and clears WCAG 2.5.8's ${MIN_TARGET}x${MIN_TARGET}px floor`,
        targets.length > 0 && targets.every((t) => t.w >= MIN_TARGET && t.h >= MIN_TARGET),
        targets.map((t) => `${t.label}=${t.w}x${t.h}${t.reason ? ` (${t.reason})` : ''}`).join(' ')
        + ` | below the ${RECOMMENDED_TARGET}px recommendation: `
        + (targets.filter((t) => t.w < RECOMMENDED_TARGET || t.h < RECOMMENDED_TARGET).map((t) => t.label).join(', ') || 'none'));

    // ═══════════════════════════════════════════════════════════════════════
    // ── THE TAP ────────────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════════
    const why = await defocusDesktopByTapping(page);
    push(`${L} setup: a real tap-Settings/tap-close round trip leaves the Browser unfocused`,
        why === null, why ?? 'ok');

    const pre = await readState(page);
    // The precondition, asserted rather than assumed: if this is not `none`
    // the tap check below proves nothing, because there was never anything in
    // the way of the tap.
    push(`${L} setup: the stream's iframe is pointer-events:none while unfocused`,
        pre.active === false && pre.framePointerEvents === 'none',
        `active=${pre.active} pointerEvents=${pre.framePointerEvents}`);

    const { point, hits } = await tapStream(page);
    const post = await readState(page);

    // Half one — GREEN today, and a regression guard for W5's "add, do not
    // replace": whatever else changes, a tap must still focus the window.
    push(`${L} a tap on the stream focuses the Browser window`,
        post.active === true && post.framePointerEvents === 'all',
        `active=${post.active} pointerEvents=${post.framePointerEvents} at ${JSON.stringify(point)}`);

    // 🔴 Half two — RED on `main`, contract §7.1. This reads the events that
    // arrived INSIDE the stream frame. On `main` the list is empty: the whole
    // tap is spent focusing the window and the user must tap again, which on a
    // remote desktop means every first interaction after switching windows is
    // silently dropped. MEASURED green with a `pointerdown` binding added
    // alongside the existing `mousedown` ones — see this file's header.
    push(`${L} 🔴 [awaits W5] ONE tap reaches the streamed desktop, not just the shell`,
        Array.isArray(hits) && (hits.includes('mousedown') || hits.includes('click')),
        `events delivered into the stream frame: ${JSON.stringify(hits)}`
        + (Array.isArray(hits) && hits.length === 0
            ? ' — nothing arrived; the tap was consumed by focus and the user must tap a second time' : ''));

    // The second tap is what a user is forced into today. Asserting it
    // separately keeps the failure above unambiguous: if THIS one were also
    // red, the problem would be the harness, not the focus wiring.
    const second = await tapStream(page);
    push(`${L} control: a SECOND tap does reach the stream (so the harness can see taps at all)`,
        Array.isArray(second.hits) && second.hits.length > 0,
        JSON.stringify(second.hits));

    // ── the raised keyboard, contract §7.3 ─────────────────────────────────
    // 🔴 Playwright cannot raise a soft keyboard, so this drives the signal a
    // real one produces: shadow `visualViewport.height` and dispatch the
    // `resize` the platform would. That emulates the INPUT only — nothing here
    // implements or hints at the response, which is the whole question.
    const kb = await page.evaluate(async () => {
        const w = document.querySelector('.window[data-app="desktop"]');
        const before = Math.round(w.getBoundingClientRect().height);
        const shrunk = window.innerHeight - 336;   // a typical iOS keyboard
        Object.defineProperty(window.visualViewport, 'height', { configurable: true, get: () => shrunk });
        window.visualViewport.dispatchEvent(new Event('resize'));
        await new Promise((r) => setTimeout(r, 400));
        return { before, shrunk, after: Math.round(w.getBoundingClientRect().height) };
    });
    push(`${L} 🔴 [awaits W7] a shrinking visual viewport resizes the desktop instead of covering it`,
        kb.after <= kb.shrunk + 2,
        `window height ${kb.before} -> ${kb.after}, visual viewport ${kb.shrunk}`);

    // ── the phone-only CSS really executed ─────────────────────────────────
    // 🔴 `style.css:735` — `.device-phone .window .ui-resizable-handle
    // {display:none}`. A phone has no cursor to show a resize affordance to,
    // and an eight-handle drag ring around the edge of a full-screen window
    // means a swipe in from the screen edge resizes the OS. This is one of the
    // ~40 rules that had never executed. Measured WINDOWED — see
    // `windowedHandles` for why measuring it full-bleed proves nothing.
    // Last in this scenario because leaving full-bleed is a one-way door for
    // everything above it.
    const phoneHandles = await windowedHandles(page);
    const liveOnPhone = phoneHandles.filter((h) => h.live);
    push(`${L} 🔴 a WINDOWED phone window has no live resize handles — the screen edge is not a drag target`,
        phoneHandles.length === 8 && liveOnPhone.length === 0,
        `${phoneHandles.length} handles, ${liveOnPhone.length} live: ${JSON.stringify(phoneHandles.map((h) => [h.cls, h.display]))}`);

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — the same phone, turned sideways
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 Not redundant with scenario 1, and it is the check that keeps scenario
// 1's letterbox threshold honest. A 844x390 body is 2.16:1, so a 16:9 stream
// fits it at 82% and the SAME assertion passes — which is the evidence that
// the threshold discriminates on the window's shape rather than simply being
// set below whatever the code currently does.
async function scenarioPhoneLandscape () {
    const L = '[phone-landscape]';
    const { ctx, page, page_errors } = await boot(PHONE_LANDSCAPE);
    const s = await readState(page);

    push(`${L} setup: a landscape phone is still a phone`,
        s.deviceClass === 'device-phone' && s.viewport.w === 844 && s.viewport.h === 390,
        `${s.deviceClass} ${JSON.stringify(s.viewport)}`);
    await assertFullbleedFit(L, s, 'landscape phone');

    // The exit has to survive rotation. A drawer that is off-screen or under
    // the notch in landscape is a trapped user just as surely as no drawer.
    const hb = await hitBox(page, '.window[data-app="desktop"] .dashboard-app-drawer-minimize');
    push(`${L} the drawer's minimise is still on screen and tappable in landscape`,
        !! hb && hb.w >= MIN_TARGET && hb.h >= MIN_TARGET,
        JSON.stringify(hb));
    push(`${L} ...and the drawer is inside the viewport, not cropped off an edge`,
        !! s.win && (await page.evaluate(() => {
            const d = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer');
            if ( ! d ) return false;
            const r = d.getBoundingClientRect();
            return r.left >= -1 && r.top >= -1 && r.right <= window.innerWidth + 1 && r.bottom <= window.innerHeight + 1;
        })));

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — a tablet
// ═══════════════════════════════════════════════════════════════════════════
async function scenarioTablet () {
    const L = '[tablet]';
    const { ctx, page, page_errors } = await boot(TABLET);
    const s = await readState(page);

    // 🔴 `device-tablet`, not `device-phone` and not `device-desktop`.
    // `set_device_class` gives a tablet the desktop UI when it has a real
    // pointer and the mobile UI when it does not — this context is touch-only,
    // so the tablet branch must resolve the mobile way. That second branch had
    // also never been executed by any test.
    push(`${L} 🔴 a touch-only tablet resolves to device-tablet, not desktop`,
        s.deviceClass === 'device-tablet',
        `deviceClass=${s.deviceClass} hover:hover=${s.hoverHover} bodyClass="${s.bodyClass}"`);
    push(`${L} setup: 820x1180 at dpr 2`,
        s.viewport.w === 820 && s.viewport.h === 1180 && s.dpr === 2,
        JSON.stringify({ ...s.viewport, dpr: s.dpr }));

    await assertFullbleedFit(L, s, 'tablet');

    // `style.css:733` hides the expand control on a tablet as well as a phone,
    // but NOT the resize handles (that rule is `.device-phone` only). Pinning
    // the difference so a future edit that collapses the two classes into one
    // has to do it deliberately.
    const scaleBtn = await page.evaluate(() => {
        const b = document.querySelector('.window[data-app="desktop"] .window-head > .window-scale-btn');
        return b ? getComputedStyle(b).display : null;
    });
    push(`${L} the expand control is hidden on a tablet (a full-screen window has nothing to expand to)`,
        scaleBtn === 'none', `display=${scaleBtn}`);

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — a phone-shaped, touch-only viewport with a DESKTOP UA
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 Contract §7.3. This is the case UA sniffing gets wrong and the reason the
// contract asks for the signal to widen: an Android tablet in desktop-site
// mode, a Chrome device-toolbar session, a narrow window on a touchscreen
// laptop, and a phone browser with "request desktop site" all land here. The
// device is unambiguously a touch device at a phone size; only the UA string
// says otherwise, and the UA string is the one input that is a claim rather
// than a measurement.
async function scenarioNarrowUA () {
    const L = '[narrow-coarse-desktop-UA]';
    const { ctx, page, page_errors } = await boot({
        viewport: { width: 390, height: 844 }, deviceScaleFactor: 3,
        isMobile: true, hasTouch: true, userAgent: UA.desktop,
    });
    const s = await readState(page);

    push(`${L} setup: coarse pointer, no hover, 390px wide, desktop UA`,
        s.pointerCoarse === true && s.hoverHover === false && s.viewport.w === 390,
        JSON.stringify({ coarse: s.pointerCoarse, hover: s.hoverHover, vp: s.viewport }));

    push(`${L} 🔴 [awaits W7] a coarse-pointer 390px viewport is device-phone even with a desktop UA`,
        s.deviceClass === 'device-phone',
        `deviceClass=${s.deviceClass} — detection is UA-only today, so this is the `
        + 'case contract §7.3 asks to widen the signal for');

    // Whatever the class ends up being, the window must not be unusable.
    // Stated separately so the failure above cannot be "fixed" by something
    // that breaks the layout.
    push(`${L} ...and the Browser window still fills the screen either way`,
        !! s.win && Math.abs(s.win.w - s.viewport.w) <= 1 && Math.abs(s.win.h - s.viewport.h) <= 1,
        `window=${JSON.stringify(s.win)} viewport=${JSON.stringify(s.viewport)}`);

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await ctx.close();
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — the desktop, unchanged. The "add, do not replace" guard.
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 Contract §7.1: "Removing `mousedown` risks regressing desktop behaviour
// that ~45 CSS rules and several suites depend on." Same for §7.3's widened
// device signal — a detection that says `device-phone` on a laptop would take
// the resize handles and the expand control away from every desktop user, and
// none of the existing suites would notice, because none of them assert the
// device class at all. This scenario is the counterweight: it is GREEN today
// and its job is to stay green through W5's and W7's changes.
async function scenarioWideDesktop () {
    const L = '[desktop-control]';
    const { ctx, page, page_errors } = await boot({
        viewport: { width: 1440, height: 900 }, userAgent: UA.desktop,
    });
    const s = await readState(page);

    push(`${L} setup: a fine pointer that can hover`,
        s.hoverHover === true && s.pointerCoarse === false,
        JSON.stringify({ hover: s.hoverHover, coarse: s.pointerCoarse }));
    push(`${L} 🔴 a 1440x900 mouse-driven session is still device-desktop`,
        s.deviceClass === 'device-desktop', `deviceClass=${s.deviceClass} bodyClass="${s.bodyClass}"`);

    // The handles are the cheapest observable proof that no `.device-phone`
    // rule leaked onto a desktop: `style.css:735` hides them for phones only.
    // Windowed, for the reason in `windowedHandles` — full-bleed hides them on
    // every device and would make this check green no matter what W7 does.
    const desktopHandles = await windowedHandles(page);
    const liveHandles = desktopHandles.filter((h) => h.live);
    push(`${L} 🔴 a windowed desktop window keeps all eight resize handles`,
        liveHandles.length === 8,
        `${liveHandles.length}/8 live: ${JSON.stringify(desktopHandles.map((h) => [h.cls, h.display]))}`);

    // And a desktop CLICK still reaches the stream on the second interaction
    // exactly as it does today — the behaviour W5 must add to, not replace.
    await page.evaluate(() => { $('.window[data-app="desktop"]').focusWindow(); });
    await sleep(200);
    const clicked = await page.evaluate(async () => {
        const f = document.querySelector('.window[data-app="desktop"] .window-app-iframe');
        return getComputedStyle(f).pointerEvents;
    });
    push(`${L} a focused desktop window's stream accepts the pointer`,
        clicked === 'all', `pointerEvents=${clicked}`);

    push(`${L} no uncaught page errors`, page_errors.length === 0, JSON.stringify(page_errors));
    await ctx.close();
}
