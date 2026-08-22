// seam-minimise-browser-test.mjs — EZiL-authored, written at INTEGRATION time
// (merge of W2 `ux/x2-window-chrome` with W3 `ux/x3-app-open`).
//
// Run:  node shell/seam-minimise-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every other `*-browser-test.mjs`.)
//
// Requires playwright, resolvable from here or from $PLAYWRIGHT_REQUIRE_DIR.
// Exits 2 (skip), not 0 (pass), if it is not there.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS FILE EXISTS — THE GAP NEITHER SIBLING COULD COVER
// ═══════════════════════════════════════════════════════════════════════════
// W2 wired the CONSUMER half of the minimise seam, in Puter-derived code:
//
//     // shell/src/UI/UIWindow.js, minimize_window()
//     if ( el_window._ezil_minimise?.() ) { return; }
//
// W3 installed the PROVIDER half, in EZiL code:
//
//     // shell/ezil/apps/desktop-window.js
//     el_window._ezil_minimise = () => { minimise_to_taskbar(el_window); return true; };
//
// Neither branch could test the join, and each proved only its own half:
//   * `shell/window-chrome-browser-test.mjs` (W2) installs its OWN STUB
//     `_ezil_minimise` — its GROUP 2 would stay green even if W3 had named
//     the real property `_ezil_minimize`, `_ezilMinimise`, or nothing at all.
//   * W3 shipped the property and grepped `UIWindow.js` for it, finding zero
//     hits (correctly — the consumer was on the other branch), and could
//     therefore never execute the join either.
//
// A name mismatch across exactly this kind of seam has cost this project two
// rounds. This file is the join, exercised in a real Chromium against the
// real built bundle, with NO stub of `_ezil_minimise` anywhere in it. Search
// this file: it only ever READS that property, never assigns it. The function
// under test is the one `desktop-window.js` installed.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT "STRANDED" MEANS, AND WHY IT IS THE ASSERTION THAT MATTERS
// ═══════════════════════════════════════════════════════════════════════════
// Once the desktop window goes full-bleed, `enter_fullpage_mode` HIDES the
// taskbar and the window head. If a minimise runs the generic Puter path
// (`hideWindow()` + `pop_dashboard_app_url`) instead of EZiL's, the window
// vanishes while the taskbar stays hidden: the desktop is gone, the taskbar
// is gone, and there is no control anywhere on screen to get it back. That is
// the strand. GROUP 3 asserts the user is NOT stranded; GROUP 4 deletes the
// hook and asserts they WOULD be — the both-directions proof this project
// requires (a guard that passes both ways is worse than none).
//
// ═══════════════════════════════════════════════════════════════════════════
// NOTE ON HOW THE HEAD BUTTON IS CLICKED IN GROUP 3/4
// ═══════════════════════════════════════════════════════════════════════════
// While the window is full-bleed the head is `display:none`, so a coordinate
// click cannot hit-test onto it. GROUP 3/4 therefore dispatch the click on
// the REAL `.window-minimize-btn` element via its DOM `.click()`, which runs
// the REAL jQuery handler registered at `UIWindow.js:1889` — the same handler,
// the same `minimize_window(el_window)` call, the same seam. Only the browser's
// hit-testing is bypassed, and only because full-bleed is precisely the state
// that hides the button. GROUP 2 does a genuine coordinate click on the same
// button while the window is still windowed, so the "a real mouse reaches this
// exact button and it goes through minimize_window" half is covered for real
// too. Nothing here reimplements `minimize_window`, `minimise_to_taskbar` or
// `exit_fullpage_mode`.

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
    console.error('playwright is not resolvable. This is a REAL-BROWSER seam test — jsdom cannot stand in. Skipping, not passing.');
    process.exit(2);
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');
const css = fs.readFileSync(`${OS}/bundle.min.css`, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 0 — STATIC: the two halves agree on the identifier, in one bundle
// ═══════════════════════════════════════════════════════════════════════════
// Both halves ship in the SAME bundle, and both occurrences are property
// names (never renamed by the minifier), so a byte comparison here is a real
// check that the consumer reads exactly what the provider writes.
const consumerHits = bundle.match(/_ezil_minimise\?\.\(/g) ?? [];
const providerHits = bundle.match(/_ezil_minimise\s*=/g) ?? [];
push('GROUP 0: the CONSUMER half (`_ezil_minimise?.(`, UIWindow.js) is in the built bundle exactly once',
    consumerHits.length === 1, `count=${consumerHits.length}`);
push('GROUP 0: the PROVIDER half (`_ezil_minimise =`, desktop-window.js) is in the built bundle exactly once',
    providerHits.length === 1, `count=${providerHits.length}`);
push('🔴 GROUP 0 SEAM (static): consumer and provider spell the property IDENTICALLY',
    consumerHits.length === 1 && providerHits.length === 1);
// A near-miss spelling anywhere would mean one side is talking to nobody.
const nearMisses = (bundle.match(/_ezil_minimi[sz]e?\w*/g) ?? []).filter((s) => s !== '_ezil_minimise');
push('GROUP 0: no near-miss spelling (_ezil_minimize / _ezilMinimise / …) anywhere in the bundle',
    nearMisses.length === 0, JSON.stringify([...new Set(nearMisses)]));

const HOST = 'https://ezil-seam-minimise-test.invalid';
const DESKTOP_URL = 'https://8181-guac-x-y-nekodesktop.ezil-seam-minimise-test.invalid/?usr=EZiL&pwd=x&embed=1';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
        endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop' },
    },
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const page_errors = [];
page.on('pageerror', (e) => page_errors.push(String(e)));

await page.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if ( url === `${HOST}/os` ) {
        return route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
    }
    if ( url.includes('/api/shell/desktop') && req.method() === 'POST' ) {
        return json({
            ok: true, guacamoleUrl: DESKTOP_URL, controlMode: 'interactive', mode: 'neko',
            frame: { confirmed: true },
        });
    }
    if ( url.includes('confirm=frame') ) return json({ ok: true, confirmed: true });
    // `display === 'live'` is the ONLY path to `ready` (the pinned contract in
    // computeBootUiState / applyDisplayEvidence). `ready` is what calls
    // `go_fullbleed`, which is the state this whole file is about.
    if ( url.includes('confirm=display') ) return json({ ok: true, display: 'live' });
    if ( url.includes('/api/shell/desktop') ) return json({ ok: true, guacamoleRunning: true });
    if ( url.includes('/api/') ) return json({ ok: true });
    if ( url.startsWith(HOST) ) return route.fulfill({ status: 404, body: '' });
    return route.continue();
});

await page.goto(`${HOST}/os`, { waitUntil: 'load' });
await page.evaluate((p) => { window.__EZIL_BOOT__ = p; }, PAYLOAD);
await page.addScriptTag({ content: icons });
await page.addScriptTag({ content: bundle });
await page.waitForSelector('.taskbar-item', { timeout: 10_000 });
await sleep(200);

const taskbarDisplay = () => page.evaluate(() => {
    const t = document.querySelector('.taskbar');
    return t ? getComputedStyle(t).display : 'MISSING';
});
const desktopState = () => page.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    if ( ! el ) return null;
    const head = el.querySelector('.window-head');
    return {
        fullbleed: el.classList.contains('ezil-fullbleed'),
        is_fullpage: el.getAttribute('data-is_fullpage'),
        minimized: el.getAttribute('data-is_minimized'),
        head_display: head ? getComputedStyle(head).display : 'MISSING',
        hook_type: typeof el._ezil_minimise,
        width: Math.round(el.getBoundingClientRect().width),
        height: Math.round(el.getBoundingClientRect().height),
    };
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — the REAL desktop window, opened the way a real user opens it,
// driven to REAL full-bleed by the real server-confirmed boot
// ═══════════════════════════════════════════════════════════════════════════
// W3: login opens nothing, so the dock click IS the app-open.
const dockRect = await page.evaluate(() => {
    const el = document.querySelector('.taskbar-item[data-app="desktop"]');
    const r = el?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
});
push('GROUP 1: login opened NOTHING — the desktop is reached by a dock click (W3)',
    !! dockRect && (await page.evaluate(() => document.querySelectorAll('.window[data-app="desktop"]').length)) === 0);
await page.mouse.click(dockRect.cx, dockRect.cy);
await page.waitForSelector('.window[data-app="desktop"]', { timeout: 10_000 });

// Wait for the real boot to reach `ready` and call `go_fullbleed`.
await page.waitForFunction(
    () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
    null, { timeout: 30_000 },
).catch(() => {});

const s1 = await desktopState();
push('GROUP 1: the desktop window is REAL and genuinely full-bleed (`ezil-fullbleed`, via go_fullbleed)',
    !! s1 && s1.fullbleed, JSON.stringify(s1));
push('GROUP 1: `data-is_fullpage="1"` — the real enter_fullpage_mode ran',
    s1?.is_fullpage === '1', `data-is_fullpage=${s1?.is_fullpage}`);
push('GROUP 1: the taskbar is HIDDEN by full-bleed (this is what makes a bad minimise a strand)',
    (await taskbarDisplay()) === 'none', `display=${await taskbarDisplay()}`);
push('GROUP 1: the window head is HIDDEN by full-bleed',
    s1?.head_display === 'none', `head display=${s1?.head_display}`);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — the PROVIDER half is real, and this file did not put it there
// ═══════════════════════════════════════════════════════════════════════════
push('🔴 GROUP 2 SEAM (runtime): the real desktop window carries a FUNCTION at the exact '
    + 'property `_ezil_minimise` — installed by desktop-window.js, never by this file',
    s1?.hook_type === 'function', `typeof = ${s1?.hook_type}`);
// Comment lines are stripped first: this file QUOTES W3's installer line in
// its own header, and that quote must not read as an assignment. What is
// forbidden is an actual `<expr>._ezil_minimise = …` in executable code.
const selfSource = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n').filter((l) => ! l.trim().startsWith('//')).join('\n');
push('GROUP 2: this test file never ASSIGNS `_ezil_minimise` (so GROUP 2/3 cannot be testing a stub)',
    ! /\.\s*_ezil_minimise\s*=[^=]/.test(selfSource));

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — THE JOIN: the real head minimise button, on a full-bleed window,
// runs W3's path and leaves the user with a way back
// ═══════════════════════════════════════════════════════════════════════════
const clickHeadMinimise = () => page.evaluate(() => {
    const btn = document.querySelector('.window[data-app="desktop"] .window-head .window-minimize-btn');
    if ( ! btn ) return 'MISSING';
    btn.click();               // real element, real jQuery handler (UIWindow.js:1889)
    return 'clicked';
});
push('GROUP 3 setup: the real `.window-minimize-btn` exists inside the real window head',
    (await clickHeadMinimise()) === 'clicked');
await sleep(600);

const s3 = await desktopState();
const taskbar3 = await taskbarDisplay();
push('🔴 GROUP 3 ACCEPTANCE: head-minimise on a FULL-BLEED window brought the TASKBAR BACK — '
    + 'the user is not stranded (this is minimise_to_taskbar -> exit_fullpage_mode, W3\'s path)',
    taskbar3 !== 'none' && taskbar3 !== 'MISSING', `taskbar display=${taskbar3}`);
push('GROUP 3: full-bleed was torn down (`ezil-fullbleed` removed)', s3 && ! s3.fullbleed, JSON.stringify(s3));
push('GROUP 3: `data-is_fullpage` was cleared by the real exit_fullpage_mode',
    s3?.is_fullpage === null, `data-is_fullpage=${s3?.is_fullpage}`);
push('GROUP 3: the window head is visible again', s3?.head_display !== 'none', `head display=${s3?.head_display}`);
push('GROUP 3: the window is actually minimised', s3?.minimized === '1' || s3?.minimized === 'true',
    `data-is_minimized=${s3?.minimized}`);
push('GROUP 3: there is a taskbar item to click to get back',
    (await page.evaluate(() => !! document.querySelector('.taskbar-item[data-app="desktop"]'))));

// Restore, and confirm the round trip returns to full-bleed (the observer in
// desktop-window.js re-runs go_fullbleed 220ms after showWindow).
await page.evaluate(() => {
    const el = document.querySelector('.taskbar-item[data-app="desktop"]');
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});
await page.waitForFunction(
    () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
    null, { timeout: 10_000 },
).catch(() => {});
const s3b = await desktopState();
push('GROUP 3: restoring from the taskbar returns the window to full-bleed (round trip closes)',
    !! s3b && s3b.fullbleed, JSON.stringify(s3b));

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — THE RESTORE FLICKER: minimise must not poison the restore size
// ═══════════════════════════════════════════════════════════════════════════
// The defect this group exists to catch shipped, was reported by the owner as
// "flickering when I try to minimize it or maximize it", and was invisible to
// every check above — GROUP 3 asserts the `ezil-fullbleed` CLASS comes back
// and never once looks at the window's SIZE.
//
// Mechanism. `$.fn.hideWindow` snapshots `data-orig-width/height` from the
// window's CURRENT on-screen size at the instant it is called, and
// `$.fn.showWindow` animates back to exactly those pixels over 0.2s. So
// anything that resizes the window BEFORE `hideWindow` runs decides what the
// restore animates to. `minimise_to_taskbar` used to call
// `exit_fullpage_mode`, whose second half (`reset_window_size_and_position`)
// does precisely that — it reset the window to its stashed pre-full-bleed box
// first, so the snapshot recorded 960x570 instead of the real 1280x860.
//
// What the user then saw, measured on this bundle at this viewport:
//
//     t=202ms   960x570   fullbleed=false                  <- settled, WRONG size
//     t=243ms   960x570   inline 100%/100%, fullbleed=true <- go_fullbleed's 220ms timer
//     t=263ms  1280x860   transition=none                  <- SNAP, one frame
//
// A smooth 200ms animation to the wrong box, a ~40ms pause, then a jump. The
// jump is instant rather than animated because `showWindow` tears its own
// transition down at 250ms, 7ms after `go_fullbleed` writes `100%`.
//
// The assertion is therefore NOT "it ends up full-bleed" (it always did, one
// frame later). It is: **by the time showWindow's own 0.2s transition has
// finished, the window is ALREADY at its final size** — nothing is left to
// jump to afterwards.
const FLICKER_SETTLE_MS = 210;   // showWindow's transition is 0.2s
const GO_FULLBLEED_MS = 220;     // desktop-window.js's restore timer

/**
 * One real minimise (head button, real hook) + one real restore (taskbar
 * item), sampling the window's box across the restore. Returns the snapshot
 * `hideWindow` recorded and the timeline.
 */
const minimiseRestoreTimeline = async () => {
    await clickHeadMinimise();
    await sleep(600);
    return page.evaluate(async ({ settle_ms }) => {
        const el = document.querySelector('.window[data-app="desktop"]');
        const orig = {
            w: Number(el.getAttribute('data-orig-width')),
            h: Number(el.getAttribute('data-orig-height')),
        };
        const samples = [];
        const t0 = performance.now();
        document.querySelector('.taskbar-item[data-app="desktop"]')
            .dispatchEvent(new MouseEvent('click', { bubbles: true }));
        for ( let i = 0; i < 30; i++ ) {
            const r = el.getBoundingClientRect();
            samples.push({ t: performance.now() - t0, w: Math.round(r.width), h: Math.round(r.height) });
            await new Promise((r2) => setTimeout(r2, 20));
        }
        const final = samples[samples.length - 1];
        // The last sample at or before the transition should have finished.
        const settled = samples.filter((s) => s.t <= settle_ms).pop() ?? samples[0];
        // The largest single-frame growth AFTER the transition is over — the
        // snap. Zero when the restore animated to the right size all along.
        let snap = 0;
        for ( let i = 1; i < samples.length; i++ ) {
            if ( samples[i].t <= settle_ms ) continue;
            snap = Math.max(snap, samples[i].w - samples[i - 1].w);
        }
        return { orig, final, settled, snap, viewport: { w: innerWidth, h: innerHeight } };
    }, { settle_ms: FLICKER_SETTLE_MS });
};

const flick = await minimiseRestoreTimeline();
push('🔴 GROUP 5 ACCEPTANCE (root cause): hideWindow snapshotted the window\'s REAL full-bleed '
    + 'size, not the stashed pre-full-bleed box (THE BUG: exit_fullpage_mode reset geometry '
    + 'BEFORE the snapshot, so the restore animated to 960x570)',
    flick.orig.w === flick.viewport.w && flick.orig.h > 0,
    JSON.stringify({ snapshot: flick.orig, viewport: flick.viewport }));
push(`🔴 GROUP 5 ACCEPTANCE (the flicker): the window is at its FINAL size by ${FLICKER_SETTLE_MS}ms — `
    + `already settled before go_fullbleed's ${GO_FULLBLEED_MS}ms timer, so there is nothing left to snap to`,
    flick.settled.w === flick.final.w,
    JSON.stringify({ settled: flick.settled, final: flick.final }));
push('GROUP 5: no single-frame jump after the restore transition is over (the snap itself)',
    flick.snap === 0, `largest post-transition frame growth = ${flick.snap}px`);
push('GROUP 5: the restore still ends full-bleed (the fix did not trade the flicker for a wrong size)',
    flick.final.w === flick.viewport.w, JSON.stringify(flick.final));

// ── BOTH DIRECTIONS ────────────────────────────────────────────────────────
// Put the defect back from the outside — make the chrome-only exit do what
// `exit_fullpage_mode` did by appending the geometry reset — and run the SAME
// cycle. If this stays green, the four checks above were proving nothing.
await page.evaluate(() => {
    const real_chrome = window.exit_fullpage_chrome;
    window.__ezil_real_chrome = real_chrome;
    window.exit_fullpage_chrome = (el) => {
        real_chrome(el);
        window.reset_window_size_and_position(el);   // the half that poisons the snapshot
    };
});
const flick_mutated = await minimiseRestoreTimeline();
push('🔴 GROUP 5 MUTATION PROOF: restoring the geometry reset on the minimise path brings the '
    + 'flicker straight back — the window settles at the WRONG size and then snaps',
    flick_mutated.settled.w !== flick_mutated.final.w && flick_mutated.snap > 0,
    JSON.stringify({ settled: flick_mutated.settled, final: flick_mutated.final, snap: flick_mutated.snap }));
await page.evaluate(() => { window.exit_fullpage_chrome = window.__ezil_real_chrome; });

// Leave the window full-bleed and restored for GROUP 4, which assumes it.
await page.waitForFunction(
    () => document.querySelector('.window[data-app="desktop"]')?.classList.contains('ezil-fullbleed'),
    null, { timeout: 10_000 },
).catch(() => {});
await sleep(300);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — BOTH DIRECTIONS: delete the hook and the SAME click strands
// ═══════════════════════════════════════════════════════════════════════════
// This is the mutation that a name mismatch across the seam would produce:
// `minimize_window` reads `_ezil_minimise`, finds nothing, and falls through
// to the generic Puter path — which hides the window and never restores the
// taskbar. If GROUP 4 stays green, GROUP 3 was not proving anything.
push('GROUP 4 setup: still full-bleed before the mutation', (await desktopState())?.fullbleed === true);
push('GROUP 4 setup: taskbar hidden again before the mutation',
    (await taskbarDisplay()) === 'none', `display=${await taskbarDisplay()}`);
await page.evaluate(() => { delete document.querySelector('.window[data-app="desktop"]')._ezil_minimise; });
push('GROUP 4 setup: the hook is gone (simulating the name mismatch)',
    (await desktopState())?.hook_type === 'undefined');
await clickHeadMinimise();
await sleep(600);
const s4 = await desktopState();
const taskbar4 = await taskbarDisplay();
push('🔴 GROUP 4 MUTATION PROOF: without the hook the SAME click STRANDS the user — '
    + 'window hidden, taskbar still hidden, no control on screen',
    (s4?.minimized === '1' || s4?.minimized === 'true') && taskbar4 === 'none',
    `minimized=${s4?.minimized} taskbar=${taskbar4}`);
push('GROUP 4 MUTATION PROOF: without the hook full-bleed is NEVER torn down',
    s4?.fullbleed === true && s4?.is_fullpage === '1',
    `fullbleed=${s4?.fullbleed} data-is_fullpage=${s4?.is_fullpage}`);

push('no uncaught page errors during the whole run', page_errors.length === 0, JSON.stringify(page_errors));

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('\nFAILED:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? `  [${f.detail}]` : ''}`);
    process.exit(1);
}
