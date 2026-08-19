// phone-stacking-browser-test.mjs — EZiL-authored. REAL-BROWSER, REAL-TOUCH
// regression test for WINDOW STACKING at the touch device classes.
//
// Run:  PLAYWRIGHT_REQUIRE_DIR=… node shell/phone-stacking-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as every sibling `*-browser-test.mjs`.)
//
// Exits 2 (SKIPPED) — never 0 — if playwright or the built bundle cannot be
// resolved.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE HOLE THIS FILE EXISTS TO CLOSE
// ═══════════════════════════════════════════════════════════════════════════
// `ezil/ui/Settings/stacking-browser-test.mjs` is this repository's stacking
// authority — 578 checks — and it sweeps FIVE viewports, all of them desktop
// (1280x860, 1366x768, 1440x900, 1280x800, 1920x1080), with no touch and no
// pointer emulation. So `device-phone` and `device-tablet` have never had
// their stacking exercised by anything, anywhere in this repo.
//
// That did not matter while `device-phone` required a phone UA. §7.3 (W7)
// widened device detection to include coarse pointer and viewport size, so an
// ordinary narrow or touch-first DESKTOP session now reaches those classes —
// and with them a rule that had never executed under test:
//
//     .device-phone .window, .device-tablet .window { z-index: 9999999 !important }
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THAT RULE DID, MEASURED
// ═══════════════════════════════════════════════════════════════════════════
// `$.fn.focusWindow` (`src/UI/UIWindow.js:4428`) raises a window by writing an
// INLINE `z-index: ++window.last_window_zindex` at :4439. A stylesheet `!important`
// beats a non-important inline declaration, so every window computed to the
// same 9999999 no matter what the counter said, and paint order fell through
// to DOM order — which `focusWindow` never changes. MEASURED on the built
// bundle, two app windows, at all three classes below: after focusing the
// buried window it carried `.window-active`, its iframe carried
// `pointer-events: all`, and `document.elementFromPoint` at its centre STILL
// returned the other window's `.window-body`. The focused window was behind
// its own rival, its live iframe unreachable, and the next tap went to the
// covering window and focused it straight back.
//
// On a phone that is a lock-out rather than a cosmetic fault: W7's layout
// makes app-bearing windows full-bleed, so two of them are exactly
// co-extensive and there is no pixel of the buried one left to tap.
//
// The fix is in `src/css/style.css` (the `.device-*` band, see the long
// comment there): the flat band is split in two along `.window-active`, the
// class `focusWindow` puts on exactly one window — focused stays at the
// historical 9999999, everything else drops to 9999998.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE ASSERTS, AND HOW IT AVOIDS PASSING FOR THE WRONG REASON
// ═══════════════════════════════════════════════════════════════════════════
//   - Every scenario first asserts WHICH device class the shell actually
//     resolved. A stacking check run at `device-desktop` would pass without
//     ever touching the rule under test, so a wrong class is a FAIL here, not
//     a silently-vacuous measurement.
//   - Every scenario first asserts the two windows really OVERLAP. "The right
//     window is in front" is meaningless if they do not.
//   - The raise is proved with `document.elementFromPoint` — real paint order
//     — and not only by comparing z-index numbers. Numbers were exactly what
//     the defect made look fine.
//   - SCENARIO A raises the buried window with a REAL TOUCH TAP on a pixel it
//     exclusively owns, which is the user gesture the claim is about.
//     SCENARIO B (the full-bleed, co-extensive case) has no such pixel by
//     construction — that IS the defect — so it uses `.focusWindow()`, the
//     mechanism `UITaskbarItem`'s own click handler calls. Both are stated
//     where they are used.
//   - The band invariant is asserted too: the focused window must still paint
//     above `.taskbar` and `.toolbar`. A "fix" that simply deleted the
//     9999999 would restore ordering and quietly put a phone's dock on top of
//     its full-bleed app; that would go red here.
//
// MEASURED, by reverting `src/css/style.css` to the pre-fix sheet, rebuilding
// the bundle and re-running: **25/38, exit 1**, with 13 red — every one of the
// three classes failing "focusing a buried full-bleed app window brings it to
// the front" (`owner=app-b`, `a.z=b.z=9999999` in both cases), both
// `device-phone` and `device-tablet` failing the real-tap raise, and every
// z-index-ordering companion red. On the post-fix sheet: **38/38, exit 0**.
//
// One pre-fix result is worth naming because it is the trap this file has to
// avoid being fooled by: the "and back again" check PASSES on the broken
// sheet — stack-b was in front already and simply never moved. That is why
// the first raise, in the other direction, is the acceptance and the return
// trip is only its companion.

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
    console.error(
        'playwright is not resolvable from this file or $PLAYWRIGHT_REQUIRE_DIR. '
        + 'This is a REAL-BROWSER, REAL-TOUCH test — jsdom has no stacking model and no '
        + 'elementFromPoint, so there is nothing honest to fall back to. Skipping, not passing.',
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

const HOST = 'https://ezil-phone-stacking-test.invalid';

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

const PROBE_HTML = '<!doctype html><html><head>'
    + '<style>html,body{margin:0;height:100%;background:#0af}</style></head><body></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A real iPhone UA, so one scenario reaches `device-phone` the way a real
// phone does (`isMobile.phone`) rather than only by viewport size — the two
// arms of THE DEVICE RULE are different code paths and both now carry the
// rule under test.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) '
    + 'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const SCENARIOS = [
    {
        label: 'device-phone / real phone UA / 390x844',
        why: 'the ordinary phone — `isMobile.phone` is true, so this arm of the rule '
            + 'was reachable before W7 too, and has still never been tested',
        viewport: { width: 390, height: 844 }, userAgent: IPHONE_UA, expect: 'device-phone',
    },
    {
        label: 'device-phone / DESKTOP UA / 390x844 (newly reachable)',
        why: 'the population W7 added: a narrow, coarse-pointer DESKTOP session. Before '
            + '§7.3 this was `device-desktop` and never executed the rule at all',
        viewport: { width: 390, height: 844 }, userAgent: undefined, expect: 'device-phone',
    },
    {
        label: 'device-tablet / desktop UA / 900x700 (newly reachable)',
        why: 'the same pre-existing rule names `.device-tablet` as well, and a tablet '
            + 'keeps its windowed layout — so overlapping windows are the NORMAL case there',
        viewport: { width: 900, height: 700 }, userAgent: undefined, expect: 'device-tablet',
    },
];

const browser = await chromium.launch();

for ( const sc of SCENARIOS ) {
    console.log(`\n───────────────────────────────────────────────────────────────`);
    console.log(`SCENARIO  ${sc.label}`);
    console.log(`          ${sc.why}`);
    console.log(`───────────────────────────────────────────────────────────────`);

    const context = await browser.newContext({
        viewport: sc.viewport,
        userAgent: sc.userAgent,
        hasTouch: true,
        deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    const page_errors = [];
    page.on('pageerror', (e) => page_errors.push(String(e)));
    page.on('console', (msg) => {
        if ( msg.type() !== 'error' ) return;
        if ( /Failed to load resource.*404/.test(msg.text()) ) return;
        if ( /\[ezil-os:desktop\]/.test(msg.text()) ) return;
        page_errors.push(msg.text());
    });

    await page.route('**/*', async (route) => {
        const url = route.request().url();
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
    await sleep(250);

    // ── the guard. Everything below measures a `.device-*` rule; at the wrong
    // class it would measure nothing and pass. ──────────────────────────────
    const cls = await page.evaluate(() => ['device-desktop', 'device-tablet', 'device-phone']
        .filter((c) => document.body.classList.contains(c)).join(',') || 'NONE');
    push(`${sc.label} — GUARD: the shell resolved this context to \`${sc.expect}\`, `
        + 'so the rule under test is actually in play',
    cls === sc.expect, `got=${cls}`);

    // ── a window with no iframe: full-WIDTH on a phone but NOT full-bleed, so
    // two of them can overlap partially and each still owns pixels of its own.
    // That is what makes SCENARIO A's real touch tap possible at all.
    const openPlain = async (app, geom) => {
        await page.evaluate(([a, g]) => {
            globalThis.ezil.UIWindow({
                title: a, app: a, width: g.w, height: g.h, left: g.x, top: g.y,
                center: false, is_resizable: true, has_head: true, is_droppable: false,
                body_content: `<div style="height:100%;background:#123">${a}</div>`,
            });
        }, [app, geom]);
        await page.waitForSelector(`.window[data-app="${app}"]`, { timeout: 5000 });
        await sleep(250);
    };

    const openApp = async (app) => {
        await page.evaluate(([h, a]) => {
            globalThis.ezil.UIWindow({
                title: a, app: a, iframe_url: `${h}/probe?${a}`,
                width: 320, height: 260, left: 10, top: 120,
                center: false, is_resizable: true, has_head: true, is_droppable: false,
            });
        }, [HOST, app]);
        await page.waitForSelector(`.window[data-app="${app}"] .window-app-iframe`, { timeout: 5000 });
        await sleep(250);
    };

    const geomOf = (app) => page.evaluate((a) => {
        const w = document.querySelector(`.window[data-app="${a}"]`);
        if ( ! w ) return null;
        const r = w.getBoundingClientRect();
        return {
            x: r.left, y: r.top, w: r.width, h: r.height,
            z: parseInt(getComputedStyle(w).zIndex, 10),
            active: w.classList.contains('window-active'),
        };
    }, app);

    // Real paint order, at a real screen pixel: whose window is on top HERE?
    const ownerAt = (x, y) => page.evaluate(([px, py]) => {
        const hit = document.elementFromPoint(px, py);
        const win = hit && hit.closest ? hit.closest('.window') : null;
        return win ? win.getAttribute('data-app') : (hit ? `NON-WINDOW:${hit.tagName}` : 'NOTHING');
    }, [x, y]);

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO A — the user gesture. Two partly-overlapping windows; a REAL
    // TOUCH TAP on a pixel the buried one exclusively owns must put it in
    // front in the region they share.
    // ═══════════════════════════════════════════════════════════════════════
    {
        await openPlain('stack-a', { x: 12, y: 90, w: 300, h: 220 });
        await openPlain('stack-b', { x: 12, y: 240, w: 300, h: 220 });

        const ga = await geomOf('stack-a');
        const gb = await geomOf('stack-b');

        // 🔴 On a REAL phone UA the shell does not leave these where they were
        // asked for: `UIWindow.js:202`'s own `isMobile.phone` branch writes
        // full-bleed geometry INLINE at creation, so two windows come out
        // pixel-identical and neither has an exclusive pixel to tap. That is
        // product behaviour, not a harness failure — and it is exactly what
        // makes SCENARIO B (below) the applicable test on a real phone rather
        // than an easier substitute for this one. Detected, asserted and
        // reported; never assumed either way.
        const same = (u, v) => Math.abs(u - v) <= 1;
        const coextensive = same(ga.x, gb.x) && same(ga.y, gb.y)
            && same(ga.w, gb.w) && same(ga.h, gb.h);

        const ovTop = Math.max(ga.y, gb.y);
        const ovBot = Math.min(ga.y + ga.h, gb.y + gb.h);
        const ovLeft = Math.max(ga.x, gb.x);
        const ovRight = Math.min(ga.x + ga.w, gb.x + gb.w);
        push(`${sc.label} — A setup: the two windows really overlap `
            + '(without that, "which is in front" is not a question)',
        ovBot - ovTop > 20 && ovRight - ovLeft > 20,
        `a=${JSON.stringify(ga)} b=${JSON.stringify(gb)}`);

        const ovX = (ovLeft + ovRight) / 2;
        const ovY = (ovTop + ovBot) / 2;

        if ( coextensive ) {
            push(`${sc.label} — A: NOT APPLICABLE, and provably so — the shell laid both `
                + 'windows out full-bleed and pixel-identical, so no tap can address the '
                + 'buried one and the raise has to be proved by SCENARIO B instead',
            ga.w > 0 && ga.h > 0, `a=${JSON.stringify(ga)} b=${JSON.stringify(gb)}`);
        } else {
            // A pixel stack-a exclusively owns: above stack-b's top edge, below
            // stack-a's head so the tap lands on its body, not on a control.
            const soloY = Math.min(ga.y + ga.h / 2, gb.y - 12);
            const soloX = ga.x + ga.w / 2;
            const exclusive = soloY > ga.y + 40 && soloY < gb.y;
            push(`${sc.label} — A setup: stack-a owns a pixel of its own to tap`,
                exclusive && (await ownerAt(soloX, soloY)) === 'stack-a',
                `pt=(${Math.round(soloX)},${Math.round(soloY)}) owner=${await ownerAt(soloX, soloY)}`);

            const before = await ownerAt(ovX, ovY);
            push(`${sc.label} — A setup: stack-b, opened last, starts in front in the shared band`,
                before === 'stack-b', `owner=${before}`);

            // 🔴 A REAL TOUCH TAP, at a real screen coordinate — the gesture the
            // claim is actually about, not `.focusWindow()`.
            await page.touchscreen.tap(soloX, soloY);
            await sleep(350);

            const after = await ownerAt(ovX, ovY);
            const ga2 = await geomOf('stack-a');
            const gb2 = await geomOf('stack-b');

            push(`${sc.label} — 🔴 ACCEPTANCE: one real tap on a buried window puts it IN FRONT `
                + 'at a pixel the two windows share (elementFromPoint, i.e. real paint order)',
            after === 'stack-a', `owner=${after} (was ${before})`);
            push(`${sc.label} — A: and the computed z-index actually ordered them, `
                + 'rather than both staying on one flat value',
            Number.isFinite(ga2.z) && Number.isFinite(gb2.z) && ga2.z > gb2.z,
            `a.z=${ga2.z} b.z=${gb2.z}`);

            // Not a one-shot: raising must work in the other direction too, or
            // "raise" is really "whichever window got there first wins forever".
            const soloBY = Math.max(gb2.y + gb2.h / 2, ga2.y + ga2.h + 12);
            const soloBX = gb2.x + gb2.w / 2;
            const bSolo = soloBY < gb2.y + gb2.h && (await ownerAt(soloBX, soloBY)) === 'stack-b';
            if ( bSolo ) {
                await page.touchscreen.tap(soloBX, soloBY);
                await sleep(350);
                push(`${sc.label} — 🔴 ACCEPTANCE: and back again — tapping stack-b re-raises it, `
                    + 'so raising is a repeatable operation and not a one-way latch',
                (await ownerAt(ovX, ovY)) === 'stack-b', `owner=${await ownerAt(ovX, ovY)}`);
            } else {
                push(`${sc.label} — A: stack-b owns a pixel of its own for the return trip`, false,
                    `pt=(${Math.round(soloBX)},${Math.round(soloBY)}) `
                    + `owner=${await ownerAt(soloBX, soloBY)}`);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // SCENARIO B — the co-extensive case, which is the one the phone layout
    // actually produces. Two app (iframe) windows: on `device-phone` W7's
    // rule makes both full-bleed, so they are pixel-identical and the buried
    // one has NO exclusive pixel — that is precisely why this could not be
    // driven by a tap and why the taskbar/`.focusWindow()` is the only way
    // out. `$.fn.focusWindow` is what `UITaskbarItem`'s own click handler
    // reaches, so this is still the product path, not a test-only shortcut;
    // the click-binding claim itself is SCENARIO A's job and is proved there.
    // ═══════════════════════════════════════════════════════════════════════
    {
        await openApp('app-a');
        await openApp('app-b');

        const ga = await geomOf('app-a');
        const gb = await geomOf('app-b');
        const cx = Math.max(ga.x, gb.x) + Math.min(ga.w, gb.w) / 2;
        const cy = Math.max(ga.y, gb.y) + Math.min(ga.h, gb.h) / 2;

        push(`${sc.label} — B setup: two app windows are laid out on top of each other`,
            ga.w > 0 && gb.w > 0
            && Math.max(ga.x, gb.x) < Math.min(ga.x + ga.w, gb.x + gb.w)
            && Math.max(ga.y, gb.y) < Math.min(ga.y + ga.h, gb.y + gb.h),
            `a=${JSON.stringify(ga)} b=${JSON.stringify(gb)}`);

        push(`${sc.label} — B setup: app-b, opened last, starts in front`,
            (await ownerAt(cx, cy)) === 'app-b', `owner=${await ownerAt(cx, cy)}`);

        await page.evaluate(() => { $('.window[data-app="app-a"]').focusWindow(); });
        await sleep(250);

        const after = await ownerAt(cx, cy);
        const ga2 = await geomOf('app-a');
        const gb2 = await geomOf('app-b');
        const pe = await page.evaluate(() => {
            const q = (a) => getComputedStyle(
                document.querySelector(`.window[data-app="${a}"] .window-app-iframe`)).pointerEvents;
            return { a: q('app-a'), b: q('app-b') };
        });

        push(`${sc.label} — 🔴 ACCEPTANCE: focusing a buried FULL-BLEED app window actually `
            + 'brings it to the front (this is the lock-out: co-extensive windows, no pixel '
            + 'of the buried one left to tap)',
        after === 'app-a', `owner=${after} a.z=${ga2.z} b.z=${gb2.z}`);
        push(`${sc.label} — B: computed z-index ordered them`,
            ga2.z > gb2.z, `a.z=${ga2.z} b.z=${gb2.z}`);
        push(`${sc.label} — B: and the window that is in front is the one whose iframe is live `
            + '(a focused window with pointer-events:all sitting BEHIND an opaque rival is the '
            + 'exact shape of the defect)',
        pe.a === 'all' && pe.b === 'none' && after === 'app-a', JSON.stringify(pe));

        // ── the band invariant. The pre-existing point of the 9999999 rule is
        // that a phone's window clears `.toolbar` (999999) and `.taskbar`
        // (99999), which are in the SAME root stacking context. A fix that
        // restored ordering by dropping windows into the counter band would
        // put the dock on top of a full-bleed app; that must go red here.
        const band = await page.evaluate(() => {
            const z = (sel) => {
                const el = document.querySelector(sel);
                if ( ! el ) return null;
                const v = parseInt(getComputedStyle(el).zIndex, 10);
                return Number.isFinite(v) ? v : null;
            };
            return { taskbar: z('.taskbar'), toolbar: z('.toolbar'),
                front: z('.window[data-app="app-a"]') };
        });
        push(`${sc.label} — 🔴 ACCEPTANCE: the focused window still outranks the taskbar and the `
            + 'toolbar — restoring stacking must not cost the band the rule was there to buy',
        band.front !== null
            && (band.taskbar === null || band.front > band.taskbar)
            && (band.toolbar === null || band.front > band.toolbar),
        JSON.stringify(band));
    }

    push(`${sc.label} — no uncaught page errors`,
        page_errors.length === 0, page_errors.join(' | ').slice(0, 300));

    await context.close();
}

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('FAILED:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? `  [${f.detail}]` : ''}`);
    process.exit(1);
}
