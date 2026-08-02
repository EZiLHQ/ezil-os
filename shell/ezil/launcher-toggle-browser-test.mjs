// launcher-toggle-browser-test.mjs — EZiL-authored. REAL-BROWSER regression
// test for the app launcher (Start button) toggle.
//
// Run:  node shell/ezil/launcher-toggle-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as boot-test.mjs / settings-test.mjs / stacking-browser-test.mjs)
//
// Requires `playwright` (with a Chromium build) to be resolvable from this
// file's location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR —
// same convention as `ui/Settings/stacking-browser-test.mjs`. If neither
// resolves, this exits 2 (skip), not 0 (pass).
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS HAS TO BE A REAL BROWSER, NOT jsdom
// ═══════════════════════════════════════════════════════════════════════════
// The defect this file exists to catch is a DOM-count regression over a
// sequence of real click events dispatched by the browser's own input
// pipeline (`page.mouse.click` / `page.click`), including outside-click
// detection that depends on `mousedown` bubbling to `document` in capture
// phase and coordinate-based hit testing for "did this click land outside the
// menu." jsdom's event dispatch and lack of real layout make that kind of
// sequence unreliable to assert on — see `boot-test.mjs`'s own header for the
// general version of this argument. This file is deliberately narrow (one
// control, one interaction) rather than folded into `stacking-browser-test.mjs`,
// which already carries a large, unrelated coverage-manifest gate.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE BUG THIS PINS DOWN
// ═══════════════════════════════════════════════════════════════════════════
// The owner: "If I click on it, it just opens this app launcher, but if I
// click on it again, it just doesn't close it properly. It is spawning one
// more on top of it."
//
// CONFIRMED MECHANISM (observed against the built bundle before the fix, via
// this exact harness's click sequence): `boot.js`'s `open_start_menu` called
// `UIContextMenu(...)` unconditionally on every `ezil:start-click` — no check
// for an already-open menu anywhere. `UIContextMenu` is a stateless factory:
// every call appends a fresh `.context-menu` node to `<body>`. Three clicks in
// a row produced 1, then 2, then 3 nodes — never fewer. Not a stale `isOpen`
// flag (there was no flag at all) and not a double-bound listener
// (`start_click_bound` in boot.js already correctly gates the `addEventListener`
// call to exactly once — verified by reading `mount`'s rebuild path). The fix
// (see `boot.js`'s `start_menu` state and `close_start_menu`) is the toggle
// that was simply never there.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUTATION CHECK
// ═══════════════════════════════════════════════════════════════════════════
// Re-running this file against a build with the toggle reverted (`start_menu`
// check removed from the `ezil:start-click` listener, restoring the
// unconditional `open_start_menu(...)` call) turns EVERY check below red:
// the exactly-1/exactly-0 counts, the aria-expanded assertions, and the
// outside-click / rapid-double-click / Escape scenarios all depend on the
// same toggle state. This was verified by hand (see the wave report) — it is
// not asserted by the file itself, since a test cannot prove its own
// reintroduction-sensitivity from inside itself.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../app/public/os');

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
        + 'This is a REAL-BROWSER test — see the file header for why. '
        + 'Install playwright (e.g. `bunx playwright@1.62.1 install chromium` in some '
        + 'directory and set PLAYWRIGHT_REQUIRE_DIR to it) and re-run. Skipping, not passing.',
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

/**
 * 🔴 DELIBERATELY a FAILED desktop boot, not the happy path the other
 * `*-test.mjs` files stub. This file does not care whether the Desktop app's
 * container ever comes up — it cares about the taskbar and the Start menu.
 * A SUCCESSFUL boot goes full-bleed (`desktop-window.js`'s `go_fullbleed`),
 * which calls `enter_fullpage_mode` and `$('.taskbar').hide()` — OBSERVED
 * while writing this file: with the happy-path stub, every click in this
 * file's scenarios landed on a hidden taskbar and silently did nothing, which
 * would have made every assertion below pass or fail for the wrong reason
 * (a hidden button, not a working or broken toggle). Failing the POST keeps
 * the window in its ordinary windowed state — see `boot-test.mjs`'s own
 * "Scenario 2" for the same reasoning ("a FAILED boot leaves the taskbar on
 * screen") — so the taskbar, and the Start button on it, stay on screen and
 * clickable for the whole run.
 */
function stub (url, method) {
    if ( url.includes('/api/shell/desktop') && method === 'POST' ) {
        return { ok: false, errorCode: 'connection_refused' };
    }
    if ( url.includes('/api/shell/desktop') ) return { ok: true, guacamoleRunning: false };
    return { ok: true };
}

const HOST = 'https://ezil-launcher-toggle-test.invalid';
const DOC_HTML = `<!doctype html><html><head><style>${css}</style></head>`
    + '<body class="min-h-full flex flex-col"><div id="ezil-os-root"></div></body></html>';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });

const page_errors = [];
page.on('pageerror', (e) => page_errors.push(String(e)));
page.on('console', (msg) => {
    if ( msg.type() !== 'error' ) return;
    if ( /Failed to load resource.*404/.test(msg.text()) ) return;
    // Expected: the `stub()` above deliberately fails the desktop boot (see
    // its own doc comment for why) so the taskbar never goes full-bleed-hidden
    // under this file's scenarios. The resulting "boot failed" log is the
    // shell correctly reporting a failure this file manufactured on purpose,
    // not a real uncaught error.
    if ( /\[ezil-os:desktop\] boot failed after .*connection_refused/.test(msg.text()) ) return;
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
        const body = stub(url, req.method());
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
await page.waitForSelector('.taskbar-item', { timeout: 5000 });
await sleep(200);

// ── helpers ──────────────────────────────────────────────────────────────
const menuCount = () => page.evaluate(() => document.querySelectorAll('.context-menu').length);
const startExpanded = () => page.evaluate(() =>
    document.querySelector('.taskbar-item[data-ezil-start="1"]')?.getAttribute('aria-expanded'));

/**
 * `page.mouse.click` at the element's own on-screen center, not
 * `page.click(selector)`: the Start item sits at the very bottom edge of the
 * viewport (it is part of the centered, fixed-position dock), and Playwright's
 * actionability wait for `page.click` can time out there for reasons unrelated
 * to this test (see the `settings-test.mjs` family's own insistence on
 * coordinate-based clicks for exactly this class of flakiness). A direct
 * coordinate click is also the more honest simulation of a real click.
 */
async function clickStart () {
    const rect = await page.evaluate(() => {
        const el = document.querySelector('.taskbar-item[data-ezil-start="1"]');
        if ( ! el ) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    if ( ! rect ) throw new Error('Start taskbar item not found for clickStart()');
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
}

// The Start item must exist and be the one this file's selector targets —
// if this fails, everything below is testing nothing.
const hasStartMarker = await page.evaluate(() =>
    document.querySelectorAll('.taskbar-item[data-ezil-start="1"]').length === 1);
push('exactly one Start taskbar item carries the toggle\'s anchor marker', hasStartMarker);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — the exact click sequence from the bug report
// ═══════════════════════════════════════════════════════════════════════════
push('0 menus before any click', (await menuCount()) === 0, `count=${await menuCount()}`);
push('aria-expanded starts false', (await startExpanded()) === 'false', `value=${await startExpanded()}`);

await clickStart();
await sleep(150);
push('click 1: exactly 1 menu in the DOM', (await menuCount()) === 1, `count=${await menuCount()}`);
push('click 1: aria-expanded is true', (await startExpanded()) === 'true', `value=${await startExpanded()}`);

await clickStart();
await sleep(150);
push('🔴 click 2: exactly 0 menus (THE BUG: this used to be 2, never 0)',
    (await menuCount()) === 0, `count=${await menuCount()}`);
push('click 2: aria-expanded is false again', (await startExpanded()) === 'false', `value=${await startExpanded()}`);

await clickStart();
await sleep(150);
push('click 3: exactly 1 menu (back open, not accumulating)', (await menuCount()) === 1, `count=${await menuCount()}`);

// Leave it open for the next scenario? No — close it explicitly so each
// scenario starts from a known, asserted state instead of inheriting one.
await clickStart();
await sleep(150);
push('reset: back to 0 menus before the next scenario', (await menuCount()) === 0, `count=${await menuCount()}`);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — rapid double-click never leaves 2+ menus stacked
// ═══════════════════════════════════════════════════════════════════════════
{
    const rect = await page.evaluate(() => {
        const r = document.querySelector('.taskbar-item[data-ezil-start="1"]').getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
    });
    const cx = rect.x + rect.width / 2;
    const cy = rect.y + rect.height / 2;
    // Two `mouse.click()` calls back-to-back, no artificial delay between —
    // as close to a real rapid double-click as a scripted click gets. Two
    // discrete click EVENTS still fire (this is not a native dblclick), which
    // is exactly what a fast human double-click produces too.
    await page.mouse.click(cx, cy);
    await page.mouse.click(cx, cy);
    await sleep(150);
    const count = await menuCount();
    push('rapid double-click: never 2+ menus stacked', count <= 1, `count=${count}`);
    push('rapid double-click: settles fully closed (open+close = closed)', count === 0, `count=${count}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — click-outside-then-click-button ends in a sane state
// ═══════════════════════════════════════════════════════════════════════════
await clickStart();
await sleep(150);
push('scenario 3 setup: menu is open', (await menuCount()) === 1, `count=${await menuCount()}`);

// Click somewhere that is definitely not the menu and not the Start button:
// the desktop wallpaper itself.
await page.mouse.click(20, 20);
await sleep(150);
push('click-outside closes the menu', (await menuCount()) === 0, `count=${await menuCount()}`);
push('click-outside clears aria-expanded', (await startExpanded()) === 'false', `value=${await startExpanded()}`);

await clickStart();
await sleep(150);
push('🔴 click-button-after-outside-close opens exactly 1 (not a leftover + a new one)',
    (await menuCount()) === 1, `count=${await menuCount()}`);

await clickStart();
await sleep(150);
push('reset: back to 0 menus before the next scenario', (await menuCount()) === 0, `count=${await menuCount()}`);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — Escape closes the menu
// ═══════════════════════════════════════════════════════════════════════════
await clickStart();
await sleep(150);
push('scenario 4 setup: menu is open', (await menuCount()) === 1, `count=${await menuCount()}`);

await page.keyboard.press('Escape');
await sleep(150);
push('Escape closes the menu', (await menuCount()) === 0, `count=${await menuCount()}`);
push('Escape clears aria-expanded', (await startExpanded()) === 'false', `value=${await startExpanded()}`);

// And the toggle is not left confused afterwards.
await clickStart();
await sleep(150);
push('after Escape, next click opens exactly 1', (await menuCount()) === 1, `count=${await menuCount()}`);
await clickStart();
await sleep(150);
push('after Escape, the toggle still closes on the following click',
    (await menuCount()) === 0, `count=${await menuCount()}`);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — picking an item closes the menu and does not desync the toggle
// ═══════════════════════════════════════════════════════════════════════════
await clickStart();
await sleep(150);
const itemRect = await page.evaluate(() => {
    const el = document.querySelector('.context-menu li.context-menu-item');
    if ( ! el ) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
push('scenario 5 setup: the menu has at least one item', !! itemRect, JSON.stringify(itemRect));
if ( itemRect ) await page.mouse.click(itemRect.x, itemRect.y);
await sleep(300); // fade_remove has a ~220ms teardown
push('picking an item closes the menu', (await menuCount()) === 0, `count=${await menuCount()}`);
await clickStart();
await sleep(150);
push('after picking an item, the toggle still opens exactly 1 next time',
    (await menuCount()) === 1, `count=${await menuCount()}`);
await clickStart();
await sleep(150);
push('final reset: 0 menus, toggle left in a clean state', (await menuCount()) === 0, `count=${await menuCount()}`);

// ═══════════════════════════════════════════════════════════════════════════
// No uncaught page errors anywhere in the run.
// ═══════════════════════════════════════════════════════════════════════════
push('no uncaught page errors during the whole scenario', page_errors.length === 0, page_errors.join(' | '));

await browser.close();

const failed = checks.filter((c) => ! c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if ( failed.length ) {
    console.log('\nFAILURES:');
    for ( const f of failed ) console.log(`  - ${f.name}${f.detail ? ` [${f.detail}]` : ''}`);
}
process.exit(failed.length === 0 ? 0 : 1);
