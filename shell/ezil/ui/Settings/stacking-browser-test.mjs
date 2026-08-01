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

    /** Returns null (not a zero-size point) when the titlebar does not exist
     * or is hidden — e.g. a full-bleed window's own `.window-head` is
     * `display:none` (`enter_fullpage_mode`). Clicking (0,0) of a hidden
     * element would silently hit whatever's actually there instead. */
    async function titlebarPoint (app) {
        return page.evaluate((a) => {
            const el = document.querySelector(`.window[data-app="${a}"] .window-head`);
            if ( ! el ) return null;
            const r = el.getBoundingClientRect();
            if ( r.width === 0 || r.height === 0 ) return null;
            return [r.left + Math.min(40, r.width / 2), r.top + r.height / 2];
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
        } else {
            skip(`${label}: titlebar hit test for ${app} (no visible titlebar — full-bleed hides it by design)`);
        }
        if ( bp ) {
            push(`${label}: a button inside ${app} hit-tests INTO ${app}`, hitBp.inWindow === app,
                `button-hit=${JSON.stringify(hitBp)}`);
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

    /** 🔴 THE CLICK-TO-RAISE CHECK, via a real trusted click at the titlebar's
     * actual screen position — see file header for why not `.focusWindow()`. */
    async function raiseByTitlebarClick (app, contenders, label) {
        await ensureNotTopmost(app, contenders);
        const tb = await titlebarPoint(app);
        if ( ! tb ) {
            skip(`${label}: raise ${app} by clicking its titlebar (no visible titlebar)`);
            return;
        }
        await page.mouse.click(tb[0], tb[1]);
        await settle(app);
        const z = await allZIndexes(contenders);
        const top = topmostOf(z);
        push(`${label}: a real click on ${app}'s titlebar raises it to the top`,
            top === app, `clicked-at=${JSON.stringify(tb)} z=${JSON.stringify(z)}`);
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

    const coveredIds = new Set();

    // ── boot app: opened by boot.js itself (`apps[0]`), not by this harness ──
    const bootWinOk = await until((id) => !! document.querySelector(`.window[data-app="${id}"]`), bootAppId);
    push(`${VP} boot app "${bootAppId}" window opened`, !! bootWinOk);
    coveredIds.add(bootAppId);

    if ( bootAppDescriptor?.wants_settings_in_drawer ) {
        await until((id) => document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed'), bootAppId);
        await settle(bootAppId);
        const fullbleed = await page.evaluate((id) =>
            document.querySelector(`.window[data-app="${id}"]`)?.classList.contains('ezil-fullbleed') === true, bootAppId);
        push(`${VP} boot app "${bootAppId}" reached full-bleed`, fullbleed, `z=${await zIndexOf(bootAppId)}`);
    } else {
        await settle(bootAppId);
        await assertHitTestsIntoSelf(bootAppId, `${VP} boot app "${bootAppId}"`);
        await checkTaskbarReachable(`${VP} boot app "${bootAppId}" alone`);
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
            coveredIds.add('settings');
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
        coveredIds.add(id);

        const opened = await page.evaluate((a) => !! document.querySelector(`.window[data-app="${a}"]`), id);
        push(`${VP} SCENARIO: "${id}" window opened`, opened);
        if ( ! opened ) continue;

        await assertHitTestsIntoSelf(id, `${VP} "${id}" (just opened)`);
        await checkTaskbarReachable(`${VP} after opening "${id}"`);

        const soFar = [...coveredIds];
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
