// context-menu-stack-browser-test.mjs — EZiL-authored. REAL-BROWSER regression
// test for UIContextMenu's factory-level stack guard.
//
// Run:  node shell/ezil/context-menu-stack-browser-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, same
//       convention as boot-test.mjs / launcher-toggle-browser-test.mjs /
//       ui/Settings/stacking-browser-test.mjs)
//
// Requires `playwright` (with a Chromium build) to be resolvable from this
// file's location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR —
// same convention as the other `*-browser-test.mjs` files. If neither
// resolves, this exits 2 (skip), not 0 (pass).
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS HAS TO BE A REAL BROWSER, NOT jsdom
// ═══════════════════════════════════════════════════════════════════════════
// Same argument as `launcher-toggle-browser-test.mjs`'s own header: the
// defect is a DOM-count regression over a sequence of real click/move events
// dispatched by the browser's own input pipeline, including menu-aim's
// submenu-open timing (a 300ms delay keyed off real `mousemove` history) and
// coordinate-based hit testing. jsdom's event dispatch and lack of real
// layout make that unreliable to assert on.
//
// ═══════════════════════════════════════════════════════════════════════════
// THE BUG THIS PINS DOWN
// ═══════════════════════════════════════════════════════════════════════════
// `UIContextMenu` was a stateless factory: every call appended a fresh
// `.context-menu` node to `<body>` and nothing ever closed a previous one.
// The Start menu got a per-call-site fix (`shell/ezil/boot.js`, commit
// ff1dff1) — correct, but scoped to ONE of six call sites. CONFIRMED live on
// the one this file targets, `UIWindow.js`'s titlebar handler (~line 2416,
// no guard of its own): 3 rapid right-clicks produced 3 stacked
// `.context-menu` elements. `UITaskbarItem.js`'s own contextmenu handler
// (~line 163) guards re-opening on the SAME anchor, but nothing there closed
// a DIFFERENT anchor's menu first either — right-click taskbar item A, then
// B, and A's menu just sat there next to a new one for B.
//
// The fix (`UIContextMenu.js`, top of the factory function): before building
// any DOM, `if (!options.is_submenu) $('.context-menu').remove()`. At most
// one ROOT context menu may exist at a time, enforced once for every current
// and future caller — not left to each call site to remember. That is also
// why the scenarios below never explicitly "close" a window-titlebar menu
// between each other: the very thing being tested is that opening the NEXT
// one does that automatically.
//
// ═══════════════════════════════════════════════════════════════════════════
// MUTATION CHECK
// ═══════════════════════════════════════════════════════════════════════════
// Re-running this file against a build with the guard disabled (change
// `UIContextMenu.js`'s `if (!options.is_submenu)` to
// `if (!options.is_submenu && false)`, the exact line this was verified
// against) turns EVERY count-based check below red: 3 rapid right-clicks on
// a window head produced 3 `.context-menu` nodes (not 1), window-A-then-B
// and taskbar-item-A-then-B both left 2 stacked menus (not 1, and NOT
// "belongs to the second one" — both anchors showed has-open-contextmenu
// simultaneously). This was verified by hand (see the wave report) — it is
// not asserted by the file itself, since a test cannot prove its own
// reintroduction-sensitivity from inside itself (same reasoning as
// `launcher-toggle-browser-test.mjs`'s own header).
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS FILE DELIBERATELY DOES NOT CLAIM, AND WHY SOME MENU ITEMS ARE
// NEVER CLICKED
// ═══════════════════════════════════════════════════════════════════════════
// Outside-click and Escape do NOT dismiss a window-titlebar or taskbar-item
// context menu, before or after this fix — OBSERVED: there is no
// document-level mousedown/keydown listener anywhere in this codebase for
// those menus (only `boot.js`'s Start menu wires that, and its own test,
// `launcher-toggle-browser-test.mjs`, covers it). This file asserts that
// EXACT pre-existing behaviour (scenario 5 below) so a future change cannot
// silently flip it in either direction unnoticed. Adding outside-click/
// Escape dismissal where none existed is not this task's job.
//
// The window-titlebar menu's own "Maximize" item is never clicked here: it
// calls `window.scale_window`, which calls `window.hide_toolbar()` as a
// function — but `ezil-globals.js` installs `window.hide_toolbar` as a
// BOOLEAN flag, not a function. OBSERVED: clicking "Maximize" throws
// `TypeError: window.hide_toolbar is not a function` inside the menu item's
// own onClick, which aborts the click handler before it ever reaches
// `fade_remove` — the menu does not even close. This is a real, pre-existing
// defect (unrelated to context-menu stacking) found while writing this file;
// it is reported in the wave output but deliberately NOT fixed here, to keep
// this change scoped to the assigned defect. Every menu item this file DOES
// click (a window's "Minimize", a submenu's aspect-ratio items, a taskbar
// item's trailing entry) was verified not to touch that path.

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
 * 🔴 DELIBERATELY a FAILED desktop boot — same reasoning as
 * `launcher-toggle-browser-test.mjs`'s own doc comment: a SUCCESSFUL boot
 * goes full-bleed and hides the taskbar/window head this file needs to
 * right-click. Failing the POST keeps the "Linux Desktop" window windowed,
 * with an ordinary head, for the whole run.
 */
function stub (url, method) {
    if ( url.includes('/api/shell/desktop') && method === 'POST' ) {
        return { ok: false, errorCode: 'connection_refused' };
    }
    if ( url.includes('/api/shell/desktop') ) return { ok: true, guacamoleRunning: false };
    return { ok: true };
}

const HOST = 'https://ezil-context-menu-stack-test.invalid';
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
    // Expected: same manufactured failure as launcher-toggle-browser-test.mjs.
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
const rootMenuCount = () => page.evaluate(() =>
    document.querySelectorAll('.context-menu[data-is-submenu="false"]').length);
const allMenuCount = () => page.evaluate(() => document.querySelectorAll('.context-menu').length);

const rectOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if ( ! el ) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, left: r.left, top: r.top, width: r.width, height: r.height };
}, sel);

const hasOpenClass = (sel) => page.evaluate((s) => document.querySelector(s)?.classList.contains('has-open-contextmenu'), sel);

/**
 * `page.mouse.click(x, y, { button: 'right' })` at a fixed point, not
 * `page.click(selector, { button: 'right' })`: same coordinate-based-click
 * reasoning `launcher-toggle-browser-test.mjs` documents for the Start
 * button — a more honest simulation of a real click, and avoids
 * Playwright's actionability wait on a chrome element.
 */
async function rightClickAt (rect) {
    await page.mouse.click(rect.cx, rect.cy, { button: 'right' });
}

// ── get a SECOND real window on screen ──────────────────────────────────
// `registry.js`'s 'settings' app is `shell_local: true` AND `pinned: true`,
// so its taskbar item is present regardless of `PAYLOAD.apps` — the one way
// to get a second real, windowed (`has_head: true`) window without going
// through `launch_app`, which is a rejecting stub in this fork
// (`ezil-stubs.js`) precisely because upstream's version needs the cloud
// backend this fork removes.
const settingsItemRect = await rectOf('.taskbar-item[data-app="settings"]');
push('setup: Settings taskbar item exists (source of the 2nd window)', !! settingsItemRect);
await page.mouse.click(settingsItemRect.cx, settingsItemRect.cy);
await sleep(300);

const windows = await page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => w.getAttribute('data-app')));
push('setup: two real windows are open (desktop + settings)',
    windows.includes('desktop') && windows.includes('settings'), JSON.stringify(windows));

const headA = await rectOf('.window[data-app="desktop"] > .window-head');
const headB = await rectOf('.window[data-app="settings"] > .window-head');
push('setup: both windows have a clickable titlebar', !! headA && !! headB);

// A point on the head that is not over a button (close/minimize sit at the
// right edge) — fixed for the whole file. Nothing below resizes, maximizes,
// or minimizes either window, so these stay valid throughout.
const ptA = { cx: headA.left + 20, cy: headA.top + headA.height / 2 };
const ptB = { cx: headB.left + 20, cy: headB.top + headB.height / 2 };

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 1 — 3 rapid right-clicks on ONE window's titlebar never stack
// ═══════════════════════════════════════════════════════════════════════════
push('0 menus before any click', (await allMenuCount()) === 0, `count=${await allMenuCount()}`);

await rightClickAt(ptA);
await sleep(150);
push('right-click 1 on window A: exactly 1 root menu', (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);

await rightClickAt(ptA);
await sleep(150);
push('🔴 right-click 2 on window A: STILL exactly 1 (THE BUG: this used to be 2)',
    (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);

await rightClickAt(ptA);
await sleep(150);
push('🔴 right-click 3 on window A: STILL exactly 1 (THE BUG: this used to be 3)',
    (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);
push('...and it is a fresh menu owned by A, not a stray survivor',
    (await hasOpenClass('.window[data-app="desktop"] > .window-head')) === true);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 2 — window A's menu, then window B's: exactly 1, and it's B's
// ═══════════════════════════════════════════════════════════════════════════
// Window A's menu from scenario 1 is still open — deliberately not closed
// first. Opening B's is the thing under test.
push('scenario 2 setup: window A menu still open from scenario 1', (await rootMenuCount()) === 1);

await rightClickAt(ptB);
await sleep(150);
push('🔴 right-click window B WITHOUT closing A first: exactly 1 root menu (THE BUG: this used to be 2)',
    (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);
push('🔴 ...and it BELONGS TO B, not the stale one from A',
    (await hasOpenClass('.window[data-app="settings"] > .window-head')) === true
    && (await hasOpenClass('.window[data-app="desktop"] > .window-head')) === false,
    JSON.stringify({
        a: await hasOpenClass('.window[data-app="desktop"] > .window-head'),
        b: await hasOpenClass('.window[data-app="settings"] > .window-head'),
    }));

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 3 — the reverse order also resolves to exactly 1, belonging to A
// ═══════════════════════════════════════════════════════════════════════════
// B's menu (from scenario 2) is still open. Right-click A now.
await rightClickAt(ptA);
await sleep(150);
push('B-then-A: exactly 1 root menu', (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);
push('...and it belongs to A this time',
    (await hasOpenClass('.window[data-app="desktop"] > .window-head')) === true
    && (await hasOpenClass('.window[data-app="settings"] > .window-head')) === false);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 4 — taskbar item A's menu, then taskbar item B's: exactly 1, B's
// ═══════════════════════════════════════════════════════════════════════════
// A's window-head menu (scenario 3) is still open — a DIFFERENT call site
// (UITaskbarItem.js, not UIWindow.js) is what gets exercised next, proving
// the guard is not scoped to "the same kind of anchor".
const desktopItemRect = await rectOf('.taskbar-item[data-app="desktop"]');
const settingsItemRect2 = await rectOf('.taskbar-item[data-app="settings"]');

await rightClickAt(desktopItemRect);
await sleep(150);
push('right-click the desktop taskbar-item while window A\'s head menu is open: exactly 1 root menu',
    (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);
push('...belonging to the taskbar item, not the window head',
    (await hasOpenClass('.taskbar-item[data-app="desktop"]')) === true);

await rightClickAt(settingsItemRect2);
await sleep(150);
push('🔴 right-click settings taskbar-item WITHOUT closing desktop\'s first: exactly 1 (THE BUG: this used to be 2)',
    (await rootMenuCount()) === 1, `count=${await rootMenuCount()}`);
push('🔴 ...and it BELONGS TO the settings item, not the stale one',
    (await hasOpenClass('.taskbar-item[data-app="settings"]')) === true
    && (await hasOpenClass('.taskbar-item[data-app="desktop"]')) === false,
    JSON.stringify({
        desktop: await hasOpenClass('.taskbar-item[data-app="desktop"]'),
        settings: await hasOpenClass('.taskbar-item[data-app="settings"]'),
    }));

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 5 — documented (not "fixed") pre-existing behaviour: outside-click
// and Escape do NOT dismiss a window-titlebar menu. See the file header.
// ═══════════════════════════════════════════════════════════════════════════
await rightClickAt(ptA);
await sleep(150);
push('scenario 5 setup: window A menu open (replacing the taskbar item\'s)',
    (await allMenuCount()) === 1, `count=${await allMenuCount()}`);

await page.mouse.click(20, 20); // the desktop wallpaper — not the menu, not any anchor
await sleep(150);
push('DOCUMENTED (not required by this fix): clicking outside a window-titlebar '
    + 'menu does not close it — no such handler exists for this menu type',
    (await allMenuCount()) === 1, `count=${await allMenuCount()}`);

await page.keyboard.press('Escape');
await sleep(150);
push('DOCUMENTED (not required by this fix): Escape does not close it either',
    (await allMenuCount()) === 1, `count=${await allMenuCount()}`);

// ═══════════════════════════════════════════════════════════════════════════
// SCENARIO 6 — a submenu opened from a parent leaves the PARENT OPEN
// ═══════════════════════════════════════════════════════════════════════════
// Window A's menu from scenario 5 is still open. Approach with several
// intermediate mouse positions before landing on the row, then on the
// submenu row: menu-aim's own activation logic (and the window.mouseX/
// mouseY tracking in boot.js) needs real mousemove history to activate a
// row at all, and Playwright's default single-step `mouse.move` can win the
// race against that with only one point recorded.
await page.mouse.move(ptA.cx - 100, ptA.cy, { steps: 5 });
await page.mouse.move(ptA.cx, ptA.cy, { steps: 5 });
await sleep(50);

const advancedRow = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.context-menu[data-is-submenu="false"] > li.context-menu-item-submenu')];
    const el = items.find((li) => li.querySelector('.contextmenu-label')?.textContent === 'Advanced');
    if ( ! el ) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
push('setup: the "Advanced" submenu row exists on window A\'s menu', !! advancedRow, JSON.stringify(advancedRow));

if ( advancedRow ) await page.mouse.move(advancedRow.x, advancedRow.y, { steps: 25 });
await sleep(500); // menu-aim's own submenu-open delay is 300ms

push('hovering into a submenu leaves the PARENT root menu present',
    (await rootMenuCount()) === 1, `root count=${await rootMenuCount()}`);
push('...AND opens exactly one submenu alongside it',
    (await page.evaluate(() => document.querySelectorAll('.context-menu[data-is-submenu="true"]').length)) === 1);
push('...for a total of 2 .context-menu nodes, both present at once (submenus are NOT swept by the stack guard)',
    (await allMenuCount()) === 2, `count=${await allMenuCount()}`);

// Sanity check (not this task's defect, but a real regression risk of the
// guard if it were ever mis-scoped to also fire for submenus): picking a
// leaf item in the SUBMENU still closes the whole stack via the existing
// `fade_remove` mechanism. "16:9" only changes CSS geometry — verified not
// to touch the `window.hide_toolbar` path the file header describes. This
// is the LAST scenario specifically so a resized window A cannot invalidate
// any earlier scenario's coordinates.
const subLeaf = await page.evaluate(() => {
    const li = [...document.querySelectorAll('.context-menu[data-is-submenu="true"] > li.context-menu-item:not(.context-menu-item-disabled)')]
        .find((el) => el.querySelector('.contextmenu-label')?.textContent === '16:9');
    if ( ! li ) return null;
    const r = li.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
push('setup: the submenu has a safe ("16:9") leaf item', !! subLeaf, JSON.stringify(subLeaf));
if ( subLeaf ) await page.mouse.click(subLeaf.x, subLeaf.y);
await sleep(300);
push('picking a submenu leaf item closes the whole stack (parent + submenu)',
    (await allMenuCount()) === 0, `count=${await allMenuCount()}`);

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
