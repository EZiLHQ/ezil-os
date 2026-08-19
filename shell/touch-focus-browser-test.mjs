// touch-focus-browser-test.mjs — EZiL-authored. REAL-BROWSER, REAL-TOUCH
// regression test for W5 (§7.1 of docs/BROWSER-FIX-CONTRACT.md: focus
// activation on `pointerdown`, not `mousedown` alone).
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=… node shell/touch-focus-browser-test.mjs
//       (after shell/build-shell.sh — same convention as every sibling
//       `*-browser-test.mjs`.)
//
// Requires `playwright` (with a Chromium build) resolvable from this file's
// location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR. If neither
// resolves this exits 2 (SKIPPED), never 0.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS AND WHY IT USES A REAL TOUCHSCREEN
// ═══════════════════════════════════════════════════════════════════════════
// Before this file, NO test in this repo had ever run with `hasTouch: true`
// or at a phone viewport. That is precisely why the defect below survived:
// every existing suite drives `page.mouse`, and with a mouse the defect is
// invisible.
//
// THE DEFECT. `style.css` gives `.window-app-iframe` `pointer-events: none`
// and returns them only under `.window-active`. The only thing that adds
// `.window-active` on a click was a `mousedown` binding. A mobile browser
// synthesizes `mousedown` only AFTER `touchend` — so on a defocused window
// the tap landed on `.window-body` (the iframe not being a hit target),
// restored the iframe's pointer-events, and was already over. The gesture
// never reached the iframe at all. The user taps a text field inside the
// streamed desktop, nothing happens, no keyboard appears, and they conclude
// the desktop is dead. It takes two taps.
//
// MEASURED, with this exact scenario, `page.touchscreen.tap()` into the
// iframe area of a window that has lost focus:
//
//   before the fix   tap 1 -> iframe saw []
//                    tap 2 -> iframe saw [pointerdown touchstart pointerup
//                                         touchend mousedown click]
//   after the fix    tap 1 -> iframe saw [mousedown click]
//                    tap 2 -> iframe saw [pointerdown touchstart pointerup
//                                         touchend mousedown click]
//
// Tap 1 delivering `mousedown`+`click` is the whole fix: `pointerdown` on the
// window body restores the iframe's pointer-events BEFORE the browser
// hit-tests the compatibility mouse events it dispatches at `touchend`, so
// those land inside the iframe. `click` inside the iframe is what focuses a
// text field, and a focused text field is what raises the keyboard. The
// `pointerdown`/`touchstart` pair still belongs to the parent on tap 1
// (the iframe was not a hit target when the gesture began) — that is
// expected and is stated here so nobody later reads its absence as a bug.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT GOES RED IF THE FIX IS REVERTED — both reverts were actually RUN, and
// these are the results they produced, not a prediction.
// ═══════════════════════════════════════════════════════════════════════════
// REVERT A — drop `pointerdown` from every binding (i.e. the pre-fix file).
//   MEASURED 23/26, red on exactly three checks, all of them `hits=[]`:
//     GROUP 1  one tap on a defocused window reaches the iframe
//     GROUP 1  that tap delivers a `click` inside the iframe
//     GROUP 4  one tap after a context menu revives the iframe
//   GROUPS 3 and 5 stay GREEN under this revert, and that is correct and
//   deliberate: a titlebar, a resize handle and the drawer tongue are all
//   ordinary hit targets, so the synthesized `mousedown` after `touchend`
//   still raises the window — just one whole gesture late, which z-order
//   cannot observe. Those two groups are non-regression cover for ADDING
//   `pointerdown`, not proof of the original defect. Only an element that is
//   `pointer-events: none` at the start of the gesture — the iframe — can
//   show the defect at all, which is why GROUPS 1 and 4 are the acceptance.
//
// REVERT B — keep `pointerdown` but delete the `focus_on_press` latch in
//   `UIWindow.js` (bind both events to a bare `() => …focusWindow()`).
//   MEASURED 23/26, red on exactly three checks, all `delta=2`:
//     GROUP 2  one tap on a titlebar = one focus
//     GROUP 2  one mouse click on a titlebar = one focus
//     GROUP 3  the resize-handle tap focused it exactly once
//   `window.last_window_zindex` advancing by 2 per press is `focusWindow`
//   running twice for one gesture. GROUP 5 stays green under this revert
//   because the drawer carries its own latch in `ezil/ui/app-drawer.js`.
//
// Nothing here stubs, patches or re-implements any part of the mechanism
// under test: the windows come from the real `UIWindow`, the taps come from
// Chromium's real touch input pipeline, and the iframe is a real, separate
// same-origin document that records what it actually received.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../app/public/os');

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
        + 'This is a REAL-BROWSER, REAL-TOUCH test — see the file header for why. '
        + 'Skipping, not passing.',
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

const HOST = 'https://ezil-touch-focus-test.invalid';

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    // GROUPS 1-4 open their own windows through the real `UIWindow` so they
    // can give them a real, inspectable iframe. GROUP 5 needs the REAL
    // desktop window, because `attach_app_drawer` is called from
    // `ezil/apps/desktop-window.js` and is not on the shell's public surface.
    apps: [
        { id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' },
    ],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: {
            session: '/api/shell/session', desktop: '/api/shell/desktop',
            previewUrl: '/api/shell/preview-url', focus: '/api/shell/focus',
            codePreviewUrl: '/api/shell/code-preview-url',
        },
    },
};

const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';

// The stand-in for the streamed desktop: a real, separate, same-origin
// document that records every input event it actually receives. It asserts
// nothing itself — this file reads `__hits` out of the live frame.
const PROBE_HTML = `<!doctype html><html><head>
<style>html,body{margin:0;height:100%;background:#0af}</style></head><body>
<script>
window.__hits = [];
for ( const t of ['pointerdown','touchstart','mousedown','click','pointerup','touchend'] ) {
    document.addEventListener(t, () => window.__hits.push(t), true);
}
window.__reset = () => { window.__hits = []; };
<\/script></body></html>`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
// 🔴 The one thing this file has that no other suite in the repo has.
// `hasTouch` makes Chromium expose `ontouchstart`/`maxTouchPoints` AND makes
// `page.touchscreen` dispatch real raw touch input, from which the browser
// derives pointer events and the synthesized compatibility mouse events in
// the real order and at the real times. A phone viewport, because that is
// where the defect was reported.
const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    deviceScaleFactor: 2,
});
const page = await context.newPage();

const page_errors = [];
page.on('pageerror', (e) => page_errors.push(String(e)));
page.on('console', (msg) => {
    if ( msg.type() !== 'error' ) return;
    if ( /Failed to load resource.*404/.test(msg.text()) ) return;
    // GROUP 5 opens the real desktop app against a deliberately-failing
    // `/api/shell/desktop` stub so the window stays WINDOWED rather than
    // racing the real full-bleed boot. Its own failure log is expected.
    if ( /\[ezil-os:desktop\]/.test(msg.text()) ) return;
    page_errors.push(msg.text());
});

await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if ( url === `${HOST}/os` ) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
        return;
    }
    if ( url.startsWith(`${HOST}/probe`) ) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: PROBE_HTML });
        return;
    }
    if ( url.includes('/api/') ) {
        await route.fulfill({
            status: 200, contentType: 'application/json',
            body: JSON.stringify({ ok: false, errorCode: 'connection_refused' }),
        });
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
await page.waitForFunction(() => typeof globalThis.ezil?.UIWindow === 'function', { timeout: 5000 });
await sleep(200);

push('setup: the touchscreen is real (the page reports touch support)',
    await page.evaluate(() => ('ontouchstart' in window) && navigator.maxTouchPoints > 0),
    `maxTouchPoints=${await page.evaluate(() => navigator.maxTouchPoints)}`);

// ── two real windows, each with a real iframe ──────────────────────────────
// Two, because "the window lost focus" has to happen the way it happens to a
// user — another window taking focus — not by a test reaching in and
// stripping `.window-active`.
async function openProbeWindow (app, geom) {
    await page.evaluate(([h, a, g]) => {
        globalThis.ezil.UIWindow({
            title: a, app: a, iframe_url: `${h}/probe?${a}`,
            width: g.w, height: g.h, left: g.x, top: g.y, center: false,
            is_resizable: true, has_head: true, is_droppable: false,
        });
    }, [HOST, app, geom]);
    await page.waitForSelector(`.window[data-app="${app}"] .window-app-iframe`, { timeout: 5000 });
    await sleep(300);
}

await openProbeWindow('probe-a', { x: 10, y: 120, w: 320, h: 260 });
await openProbeWindow('probe-b', { x: 40, y: 430, w: 320, h: 260 });

const frameOf = (app) => page.frames().find((f) => f.url().includes(`/probe?${app}`));
const resetHits = async (app) => { await frameOf(app)?.evaluate(() => window.__reset()); };
const hitsOf = async (app) => (await frameOf(app)?.evaluate(() => window.__hits.slice())) ?? null;

push('setup: both windows have a live, loaded probe iframe',
    !! frameOf('probe-a') && !! frameOf('probe-b'));

const stateOf = (app) => page.evaluate((a) => {
    const w = document.querySelector(`.window[data-app="${a}"]`);
    const f = w?.querySelector('.window-app-iframe');
    return {
        active: !! w?.classList.contains('window-active'),
        pointerEvents: f ? getComputedStyle(f).pointerEvents : 'MISSING',
        z: w ? parseInt(getComputedStyle(w).zIndex, 10) : null,
    };
}, app);

const rectOf = (app, sel) => page.evaluate(([a, s]) => {
    const el = document.querySelector(`.window[data-app="${a}"] ${s}`);
    if ( ! el ) return null;
    const r = el.getBoundingClientRect();
    if ( r.width === 0 || r.height === 0 ) return null;
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height };
}, [app, sel]);

const zCounter = () => page.evaluate(() => window.last_window_zindex);

// `probe-b` opened last, so it holds focus. `probe-a` is the defocused
// window whose iframe is dead — the exact state a user is in after touching
// anything else on the desktop.
push('setup: opening probe-b defocused probe-a (its iframe is pointer-events:none)',
    (await stateOf('probe-a')).pointerEvents === 'none' && (await stateOf('probe-a')).active === false,
    JSON.stringify(await stateOf('probe-a')));

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — THE DEFECT. One tap, on a defocused window, must reach the iframe.
// ═══════════════════════════════════════════════════════════════════════════
{
    const box = await rectOf('probe-a', '.window-app-iframe');
    push('GROUP 1 setup: probe-a has a visible iframe box to tap', !! box, JSON.stringify(box));

    await resetHits('probe-a');
    await page.touchscreen.tap(box.cx, box.cy);
    await sleep(350);

    const hits = await hitsOf('probe-a');
    const st = await stateOf('probe-a');

    push('🔴 GROUP 1 ACCEPTANCE: ONE touch tap on a defocused window reaches the iframe '
        + '(baseline before the fix: the iframe received NOTHING on tap 1)',
        Array.isArray(hits) && hits.length > 0, `hits=${JSON.stringify(hits)}`);
    push('🔴 GROUP 1 ACCEPTANCE: that one tap delivers a real `click` INSIDE the iframe — '
        + 'the event that focuses a text field and therefore raises the keyboard',
        Array.isArray(hits) && hits.includes('click'), `hits=${JSON.stringify(hits)}`);
    push('GROUP 1: the same tap also activated the window and revived its iframe',
        st.active === true && st.pointerEvents === 'all', JSON.stringify(st));

    // And the second tap behaves as it always has — the fix did not cost the
    // full gesture on an already-focused window.
    await resetHits('probe-a');
    await page.touchscreen.tap(box.cx, box.cy);
    await sleep(300);
    const hits2 = await hitsOf('probe-a');
    push('GROUP 1: a second tap on the now-focused window delivers the FULL gesture '
        + '(pointerdown + touchstart) to the iframe, as before',
        hits2.includes('pointerdown') && hits2.includes('touchstart') && hits2.includes('click'),
        `hits=${JSON.stringify(hits2)}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — IDEMPOTENCE. `pointerdown` and `mousedown` are both bound; one
// press must still be one focus.
// ═══════════════════════════════════════════════════════════════════════════
// `window.last_window_zindex` is the real, unmocked side effect of
// `$.fn.focusWindow` — it does `++window.last_window_zindex` on every call
// for a non-stay-on-top window. Counting it is how "focusing twice must be a
// no-op, not two focus events" (§7.1) is measured rather than asserted.
{
    // Titlebar, not the body: the compat `mousedown` after a tap on the
    // iframe area lands INSIDE the iframe (that is GROUP 1's whole point) and
    // so never reaches the latch. The titlebar is where a single press really
    // does deliver both events to the same handler.
    const headA = await rectOf('probe-a', '.window-head');
    const headB = await rectOf('probe-b', '.window-head');
    push('GROUP 2 setup: both windows expose a titlebar', !! headA && !! headB);

    // Give focus away first, so each press below is a real focus change.
    await page.touchscreen.tap(headB.cx, headB.cy);
    await sleep(250);

    const z0 = await zCounter();
    await page.touchscreen.tap(headA.cx, headA.cy);
    await sleep(300);
    const z1 = await zCounter();
    push('🔴 GROUP 2 ACCEPTANCE (touch): ONE tap on a titlebar advances the z-index counter '
        + 'by exactly 1 — pointerdown focused it, the synthesized mousedown did not focus it again',
        z1 - z0 === 1, `delta=${z1 - z0} (${z0} -> ${z1})`);

    // The same claim for a mouse, which is where "add, do not replace" could
    // regress: a mouse press now fires BOTH bound events on the same handler.
    await page.mouse.click(headB.cx, headB.cy);
    await sleep(250);
    const z2 = await zCounter();
    await page.mouse.click(headA.cx, headA.cy);
    await sleep(250);
    const z3 = await zCounter();
    push('🔴 GROUP 2 ACCEPTANCE (mouse): ONE mouse click on a titlebar advances the z-index '
        + 'counter by exactly 1 — adding pointerdown did not double-fire the mouse path',
        z3 - z2 === 1, `delta=${z3 - z2} (${z2} -> ${z3})`);

    push('GROUP 2: the mouse click still actually raised probe-a',
        (await stateOf('probe-a')).active === true, JSON.stringify(await stateOf('probe-a')));
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — the other two bindings: titlebar and resize handle, by touch.
// ═══════════════════════════════════════════════════════════════════════════
{
    const headA = await rectOf('probe-a', '.window-head');
    const headB = await rectOf('probe-b', '.window-head');

    await page.touchscreen.tap(headB.cx, headB.cy);
    await sleep(250);
    push('GROUP 3 setup: tapping probe-b\'s titlebar focused probe-b',
        (await stateOf('probe-b')).active === true);

    await page.touchscreen.tap(headA.cx, headA.cy);
    await sleep(250);
    const za = (await stateOf('probe-a')).z;
    const zb = (await stateOf('probe-b')).z;
    push('🔴 GROUP 3 ACCEPTANCE: a single TAP on a buried window\'s titlebar raises it',
        (await stateOf('probe-a')).active === true && za > zb, `probe-a z=${za} probe-b z=${zb}`);

    // Resize handle. `.resizable()` appends these as direct children of the
    // window, which is why `UIWindow.js` delegates that binding on
    // `el_window` — see its comment block.
    const handle = await rectOf('probe-b', '.ui-resizable-se');
    if ( ! handle ) {
        push('GROUP 3: probe-b exposes a "se" resize handle', false, 'handle missing or zero-size');
    } else {
        const zBefore = await zCounter();
        await page.touchscreen.tap(handle.cx, handle.cy);
        await sleep(250);
        const zAfter = await zCounter();
        push('🔴 GROUP 3 ACCEPTANCE: a single TAP on a buried window\'s resize handle raises it',
            (await stateOf('probe-b')).active === true,
            `probe-b=${JSON.stringify(await stateOf('probe-b'))}`);
        push('GROUP 3: and that tap focused it exactly once',
            zAfter - zBefore === 1, `delta=${zAfter - zBefore}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — the mid-session pointer-events strip. `UIContextMenu` and
// `UIPopover` both kill the ACTIVE window's iframe pointer-events and nothing
// restores them but a focus. On touch that used to be another dead desktop.
// ═══════════════════════════════════════════════════════════════════════════
{
    // Focus probe-a, then open a real context menu — the real function, no stub.
    const headA = await rectOf('probe-a', '.window-head');
    await page.touchscreen.tap(headA.cx, headA.cy);
    await sleep(250);
    push('GROUP 4 setup: probe-a is focused and its iframe is live',
        (await stateOf('probe-a')).pointerEvents === 'all');

    await page.evaluate(() => {
        globalThis.ezil.UIContextMenu({
            items: [{ html: 'Nothing', onClick: () => {} }],
            position: { top: 40, left: 40 },
        });
    });
    await sleep(200);
    const stripped = await stateOf('probe-a');
    push('GROUP 4 setup: opening a context menu stripped the focused iframe\'s pointer-events '
        + '(this is the real UIContextMenu behaviour, not a stub)',
        stripped.pointerEvents === 'none' && stripped.active === true, JSON.stringify(stripped));

    await page.evaluate(() => { $('.context-menu').remove(); $('.context-menu-sheet-backdrop').remove(); });
    await sleep(150);

    const box = await rectOf('probe-a', '.window-app-iframe');
    await resetHits('probe-a');
    await page.touchscreen.tap(box.cx, box.cy);
    await sleep(350);
    const hits = await hitsOf('probe-a');
    push('🔴 GROUP 4 ACCEPTANCE: after a context menu killed the iframe mid-session, ONE tap '
        + 'brings it back AND lands inside it',
        Array.isArray(hits) && hits.includes('click'), `hits=${JSON.stringify(hits)}`);
    push('GROUP 4: pointer-events are restored on the iframe',
        (await stateOf('probe-a')).pointerEvents === 'all',
        JSON.stringify(await stateOf('probe-a')));
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — the app drawer's own focus binding (`ezil/ui/app-drawer.js`).
// It is the only chrome a full-bleed desktop window has, so its
// press-to-focus is on the same critical path.
// ═══════════════════════════════════════════════════════════════════════════
// `attach_app_drawer` is not on `globalThis.ezil`; the only real caller is
// `ezil/apps/desktop-window.js`, so the real desktop window is how this is
// reached. Its `/api/shell/desktop` POST is stubbed to fail, so it stays
// windowed instead of racing the real full-bleed boot — the same technique
// `window-chrome-browser-test.mjs` uses, and for the same reason.
{
    const dockRect = await page.evaluate(() => {
        const el = document.querySelector('.taskbar-item[data-app="desktop"]');
        const r = el?.getBoundingClientRect();
        return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
    });
    push('GROUP 5 setup: the desktop app has a dock item to open', !! dockRect);
    await page.touchscreen.tap(dockRect.cx, dockRect.cy);
    await page.waitForSelector('.window[data-app="desktop"]', { timeout: 5000 });
    await sleep(600);

    const hasDrawer = await page.evaluate(
        () => !! document.querySelector('.window[data-app="desktop"] .ezil-app-drawer'));
    push('GROUP 5 setup: the real desktop window attached a real app drawer', hasDrawer);

    // `ezil-shell.css` hides the drawer while the desktop window is still
    // windowed (`:not(.ezil-fullbleed)`), because a windowed desktop still has
    // its own head. `go_fullbleed` is what writes that class, and it is behind
    // a server-confirmed boot this file has no business re-simulating — so
    // write the one real class it writes, exactly as
    // `window-chrome-browser-test.mjs` writes the real `data-is_fullpage`. The
    // drawer's press binding, which is the thing under test, is untouched.
    await page.evaluate(() => {
        document.querySelector('.window[data-app="desktop"]')?.classList.add('ezil-fullbleed');
    });
    await sleep(200);

    // Take focus away the way a user does — another window. probe-b, not
    // probe-a: probe-a's rect overlaps the drawer's tongue, and raising it
    // would put its own (pointer-events-enabled) iframe over the one pixel
    // this group has to tap.
    await page.evaluate(() => { $('.window[data-app="probe-b"]').focusWindow(); });
    await sleep(200);
    push('GROUP 5 setup: the desktop window has lost focus',
        (await stateOf('desktop')).active === false, JSON.stringify(await stateOf('desktop')));

    // Only a pixel the tongue actually owns right now is a real tap target —
    // same reasoning as `stacking-browser-test.mjs`'s `titlebarPoint`.
    const grab = await page.evaluate(() => {
        const el = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-toggle');
        const r = el?.getBoundingClientRect();
        if ( ! r || r.width === 0 || r.height === 0 ) return null;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const hit = document.elementFromPoint(cx, cy);
        return hit && el.contains(hit) ? { cx, cy } : null;
    });
    if ( ! grab ) {
        const dbg = await page.evaluate(() => {
            const el = document.querySelector('.window[data-app="desktop"] .dashboard-app-drawer-toggle');
            const dr = document.querySelector('.window[data-app="desktop"] .ezil-app-drawer');
            const r = el?.getBoundingClientRect();
            const cs = el && getComputedStyle(el);
            const hit = r ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
            return {
                rect: r && { x: r.left, y: r.top, w: r.width, h: r.height },
                display: cs?.display, visibility: cs?.visibility,
                drawerDisplay: dr && getComputedStyle(dr).display,
                winClasses: document.querySelector('.window[data-app="desktop"]')?.className,
                hit: hit && `${hit.tagName}.${hit.className}`,
            };
        });
        push('GROUP 5: the drawer tongue is visible and unoccluded', false, JSON.stringify(dbg));
    } else {
        const z0 = await zCounter();
        await page.touchscreen.tap(grab.cx, grab.cy);
        // The drawer's handler defers a tick on purpose (see its comment).
        await sleep(350);
        const z1 = await zCounter();
        push('🔴 GROUP 5 ACCEPTANCE: a single TAP on the app drawer focuses its window '
            + '(the drawer is the ONLY chrome a full-bleed desktop has)',
            (await stateOf('desktop')).active === true, JSON.stringify(await stateOf('desktop')));
        push('GROUP 5: and focuses it exactly once (pointerdown + synthesized mousedown = one focus)',
            z1 - z0 === 1, `delta=${z1 - z0}`);
    }
}

// ═══════════════════════════════════════════════════════════════════════════
push('no uncaught page errors', page_errors.length === 0, page_errors.join(' | ').slice(0, 400));

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('FAILED:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? `  [${f.detail}]` : ''}`);
    process.exit(1);
}
