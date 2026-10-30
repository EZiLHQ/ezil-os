// window-chrome-browser-test.mjs — EZiL-authored. REAL-BROWSER regression
// test for W2 (converging the head-minimise/close control paths with
// full-bleed teardown).
//
// Run:  node shell/window-chrome-browser-test.mjs
//       (after shell/build-shell.sh — same convention as the other
//       `*-browser-test.mjs` files under `shell/ezil/`.)
//
// Requires `playwright` (with a Chromium build) resolvable from this file's
// location, OR from a directory named by $PLAYWRIGHT_REQUIRE_DIR. If neither
// resolves, this exits 2 (skip), not 0 (pass) and not a silent false
// negative — same convention as every sibling `*-browser-test.mjs`.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS PINS DOWN, AND WHY IT REACHES THE REAL FUNCTIONS DIRECTLY
// ═══════════════════════════════════════════════════════════════════════════
// The real full-bleed entry path (`go_fullbleed`, `ezil/apps/desktop-window.js`)
// is a different workstream's file and is gated behind a multi-step
// server-confirmed boot this file has no business re-simulating. What IS
// this file's job is `UIWindow.js` / `UIDesktopFullpage.js` / `style.css`:
// the three real, exported functions (`enter_fullpage_mode`,
// `exit_fullpage_mode`, the new `exit_fullpage_chrome`) and the two real
// event handlers (`minimize_window`, `$.fn.close`) they feed. This file
// drives an ordinary windowed window into "as if full-bleed" state the same
// legitimate-side-door way `stacking-browser-test.mjs`'s
// `runDashboardPopstateGuardSweep` reaches `push_dashboard_app_url` — by
// calling the REAL, unmodified functions with the REAL attributes
// (`data-is_fullpage`) a real `go_fullbleed` would have set, then clicking
// the REAL head buttons. Nothing here reimplements `minimize_window`,
// `exit_fullpage_mode`, or `$.fn.close`.
//
// ═══════════════════════════════════════════════════════════════════════════
// FOUR DEFECTS, FOUR GROUPS BELOW
// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 (style.css): a full-bleed window used to hide `.window-minimize-btn`
//   on EVERY window via a body-scoped `.fullpage-mode` rule. Revert
//   `style.css`'s `.window[data-is_fullpage="1"] .window-minimize-btn` back
//   to `.fullpage-mode .window-minimize-btn` and GROUP 1's "settings stays
//   visible" check goes red.
// GROUP 2 (UIWindow.js `minimize_window`): head-minimise never called into
//   fullpage exit at all. Revert the `el_window._ezil_minimise?.()` early
//   return and GROUP 2's "taskbar became visible" check goes red (the
//   installed stub hook would simply never run).
// GROUP 3 (UIDesktopFullpage.js `enter_fullpage_mode`/
//   `reset_window_size_and_position`): revert the geometry-stash pair back
//   to the hard-coded 680x380 box and GROUP 3's exact-geometry-restored
//   check goes red.
// GROUP 4 (UIWindow.js close call site + UIDesktopFullpage.js `data-closing`
//   guard): revert `window.exit_fullpage_mode(this)` back to the
//   no-argument call and GROUP 4's "chrome actually restored mid-shrink"
//   checks go red (the guard never runs at all without the argument, so
//   `data-is_fullpage` and `.window-head` never clear during the shrink).
//   Separately, remove the `data-closing` guard from `exit_fullpage_mode`
//   and GROUP 4's "geometry did not jump before the shrink started" check
//   goes red.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
// Same override as the sibling suites: point at a build without touching the
// committed `app/public/os`.
const OS = process.env.EZIL_SHELL_OUT_DIR || process.env.EZIL_OS_DIR || path.resolve(here, '../app/public/os');

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

// 🔴 DELIBERATELY a FAILED desktop boot, same reasoning as every sibling
// browser test that needs the "desktop" window to stay WINDOWED (ordinary
// head, taskbar present) instead of racing the real go_fullbleed flow this
// file is not testing.
function stub (url, method) {
    // GROUP 6's Code window: a real minted URL and a confirmed frame, so the
    // window settles quietly (the desktop's own boot still fails, below).
    if ( url.includes('/api/shell/code-preview-url') ) {
        return { ok: true, codePreviewUrl: `${HOST}/frame?code=1`, expiresAt: Date.now() + 300_000 };
    }
    if ( url.includes('confirm=frame') ) return { ok: true, confirmed: true, status: 200 };
    if ( url.includes('/api/shell/desktop') && method === 'POST' ) {
        return { ok: false, errorCode: 'connection_refused' };
    }
    if ( url.includes('/api/shell/desktop') ) return { ok: true, guacamoleRunning: false };
    return { ok: true };
}

const HOST = 'https://ezil-window-chrome-test.invalid';
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
    if ( url.startsWith(`${HOST}/frame?`) ) {
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><body style="margin:0;background:#1e1e1e"></body>' });
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

// ── get the two real windows this file needs ────────────────────────────
// 🔴 MODIFIED BY EZIL 2026-08-04 (integration of W2 with W3): "desktop" USED
// TO auto-open at boot from `PAYLOAD.apps[0]`, and this setup inherited it
// for free. W3 ("login opens nothing" — see `boot.js`'s header) removed that
// auto-launch, so the window must now be earned with the same explicit dock
// click a real user makes. This is the identical one-click fix W3 applied to
// `context-menu-stack-browser-test.mjs`, `display-notice-browser-test.mjs`,
// `overlay-paint-browser-test.mjs` and `stacking-browser-test.mjs`; this file
// only missed it because it did not exist on the W3 branch. It still stays
// windowed (not full-bleed) because the stub above fails its confirm POST.
// "settings" is `pinned: true` in the registry regardless of PAYLOAD.apps,
// same technique `context-menu-stack-browser-test.mjs` uses for its second
// window.
const desktopItemRect = await page.evaluate(() => {
    const el = document.querySelector('.taskbar-item[data-app="desktop"]');
    const r = el?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
});
push('setup: desktop taskbar item exists', !! desktopItemRect);
await page.mouse.click(desktopItemRect.cx, desktopItemRect.cy);
await page.waitForSelector('.window[data-app="desktop"]', { timeout: 5000 });

const settingsItemRect = await page.evaluate(() => {
    const el = document.querySelector('.taskbar-item[data-app="settings"]');
    const r = el?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
});
push('setup: Settings taskbar item exists', !! settingsItemRect);
await page.mouse.click(settingsItemRect.cx, settingsItemRect.cy);
await sleep(300);

const setupWindows = await page.evaluate(() => [...document.querySelectorAll('.window')].map((w) => w.getAttribute('data-app')));
push('setup: desktop + settings are both real, open windows',
    setupWindows.includes('desktop') && setupWindows.includes('settings'), JSON.stringify(setupWindows));

const taskbarDisplay = () => page.evaluate(() => getComputedStyle(document.querySelector('.taskbar')).display);
const minimizeBtnDisplay = (app) => page.evaluate((a) => {
    const btn = document.querySelector(`.window[data-app="${a}"] .window-minimize-btn`);
    return btn ? getComputedStyle(btn).display : 'MISSING';
}, app);
const rectOf = (sel) => page.evaluate((s) => {
    const el = document.querySelector(s);
    if ( ! el ) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, left: r.left, width: r.width, height: r.height };
}, sel);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — style.css scope (acceptance b): one full-bleed window must not
// hide minimise on every other window
// ═══════════════════════════════════════════════════════════════════════════
// Simulate `go_fullbleed` on "desktop" via the real, unmodified
// `enter_fullpage_mode` plus the real attribute it writes.
await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    window.enter_fullpage_mode(el);
    el.setAttribute('data-is_fullpage', '1');
});
await sleep(80);

push('GROUP 1 setup: taskbar is hidden once "desktop" is full-bleed',
    (await taskbarDisplay()) === 'none', `display=${await taskbarDisplay()}`);
push('GROUP 1: "desktop" (the full-bleed window itself) hides its own minimize button',
    (await minimizeBtnDisplay('desktop')) === 'none', `display=${await minimizeBtnDisplay('desktop')}`);
push('🔴 GROUP 1 ACCEPTANCE (b): "settings" (an ORDINARY window) keeps its minimize button visible '
    + 'while "desktop" is full-bleed (THE BUG: a body-scoped rule used to hide it here too)',
    (await minimizeBtnDisplay('settings')) !== 'none', `display=${await minimizeBtnDisplay('settings')}`);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — minimize_window's `_ezil_minimise` hook (acceptance a)
// ═══════════════════════════════════════════════════════════════════════════
const desktopRectBeforeMinimize = await rectOf('.window[data-app="desktop"]');

await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    // Stand-in for the hook `ezil/apps/desktop-window.js` installs (SEAM:
    // exact property name `_ezil_minimise`, no arguments, truthy return
    // means "handled"). Calls only the CHROME half on purpose — see GROUP 3.
    el._ezil_minimise = () => {
        window.exit_fullpage_chrome(el);
        $(el).hideWindow();
        return true;
    };
});
// A real `page.click()` needs Playwright's actionability check ("visible"),
// but the head — including its minimize button — is exactly what
// `enter_fullpage_mode` hid a few lines up (correct, by design: a full-bleed
// window's own head is not the way out; that is the drawer's job, a
// different workstream's file). `trigger('click')` fires the SAME real,
// already-bound jQuery handler (`.window-minimize-btn`'s `click()` at
// `UIWindow.js` → `minimize_window(el_window)`) without Playwright's
// visibility gate rejecting the click on an intentionally-hidden control —
// exactly the unit under test either way.
await page.evaluate(() => $('.window[data-app="desktop"] > .window-head > .window-minimize-btn').trigger('click'));
await sleep(150);

const desktopMinimizedAttr = await page.evaluate(() =>
    document.querySelector('.window[data-app="desktop"]')?.getAttribute('data-is_minimized'));
push('🔴 GROUP 2 ACCEPTANCE (a): head-minimise from full-bleed leaves a VISIBLE taskbar '
    + '(THE BUG: minimize_window never called into fullpage exit, so the taskbar stayed hidden)',
    (await taskbarDisplay()) !== 'none', `display=${await taskbarDisplay()}`);
push('GROUP 2: the window is actually minimized (the hook did not just eat the click)',
    desktopMinimizedAttr === 'true' || desktopMinimizedAttr === '1', `data-is_minimized=${desktopMinimizedAttr}`);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — geometry never touched by a chrome-only minimise (acceptance c,
// direct half of the fix); then restore-from-taskbar measures no flash
// ═══════════════════════════════════════════════════════════════════════════
// `$.fn.hideWindow` (Puter-derived, untouched by this change) snapshots
// `data-orig-width/height` from the window's CURRENT on-screen size the
// instant it is called, and `$.fn.showWindow` restores EXACTLY those pixel
// values ~200ms later. THIS is the real mechanism the 680x380 flash rode:
// if something reset the window to a hard-coded small box BEFORE
// `hideWindow` ran, that wrong box is what got snapshotted and later
// restored to. A chrome-only minimise (this file's stand-in `_ezil_minimise`
// calls `exit_fullpage_chrome`, never geometry) means `hideWindow` snapshots
// the window's REAL full-bleed size instead.
const desktopOrigSnapshot = await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="desktop"]');
    return { width: el.getAttribute('data-orig-width'), height: el.getAttribute('data-orig-height') };
});
push('🔴 GROUP 3 ACCEPTANCE (c), root cause: hideWindow snapshotted the window\'s REAL full-bleed '
    + 'size for restore, not a hard-coded 680x380 box (THE BUG: an unsplit exit_fullpage_mode would '
    + 'have reset geometry to a small box BEFORE this snapshot, poisoning it)',
    Number(desktopOrigSnapshot.width) > 1000 && Number(desktopOrigSnapshot.height) > 700,
    JSON.stringify({ before: desktopRectBeforeMinimize, snapshot: desktopOrigSnapshot }));

// Restore from the taskbar (real showWindow()) and let its own 0.2s
// geometry transition finish, then measure the SETTLED size.
const desktopTaskbarItemRect = await rectOf('.taskbar-item[data-app="desktop"]');
push('GROUP 3 setup: a taskbar item exists to restore from', !! desktopTaskbarItemRect);
await page.mouse.click(desktopTaskbarItemRect.left + desktopTaskbarItemRect.width / 2,
    desktopTaskbarItemRect.top + desktopTaskbarItemRect.height / 2);
await sleep(300); // past showWindow's own 0.2s width/height transition
const desktopRectJustRestored = await rectOf('.window[data-app="desktop"]');
push('🔴 GROUP 3 ACCEPTANCE (c): restore-from-taskbar settles at the real full-bleed size, '
    + 'never at 680x380',
    desktopRectJustRestored.width !== 680 && desktopRectJustRestored.width > 1000,
    `width=${desktopRectJustRestored.width}`);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — geometry stash + restore (acceptance c, defends the UNSPLIT
// `exit_fullpage_mode` path too — e.g. a caller that has not yet switched to
// `exit_fullpage_chrome`), and the `data-closing` guard against a mid-close
// jump
// ═══════════════════════════════════════════════════════════════════════════
await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    $(el).css({ width: '842px', height: '417px', top: '53px', left: '71px' });
});
await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    window.enter_fullpage_mode(el); // stashes 842/417/53/71 on el.dataset
    el.setAttribute('data-is_fullpage', '1');
});
const restored = await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    window.exit_fullpage_mode(el); // unsplit call — no data-closing set
    return { width: el.style.width, height: el.style.height, top: el.style.top, left: el.style.left };
});
push('🔴 GROUP 4 ACCEPTANCE (c), unsplit path: exit_fullpage_mode restores the window\'s REAL '
    + 'pre-fullpage geometry, not the hard-coded 680x380 box',
    restored.width === '842px' && restored.height === '417px' && restored.top === '53px' && restored.left === '71px',
    JSON.stringify(restored));

// Now the `data-closing` guard: re-enter full-bleed, stamp data-closing as
// $.fn.close does synchronously, and confirm geometry is SKIPPED even
// though the chrome half still runs — this is the exact risk the plan
// calls out ("geometry reset would jump a window mid-close-animation").
await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    window.enter_fullpage_mode(el); // re-stashes 842/417/53/71
    el.setAttribute('data-is_fullpage', '1');
    el.setAttribute('data-closing', '1'); // what $.fn.close stamps synchronously
});
const guarded = await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    window.exit_fullpage_mode(el);
    return {
        width: el.style.width, height: el.style.height,
        headDisplay: getComputedStyle(el.querySelector('.window-head')).display,
        hasFullpageAttr: el.hasAttribute('data-is_fullpage'),
    };
});
push('🔴 GROUP 4 GUARD: exit_fullpage_mode on a window stamped data-closing="1" does NOT reset '
    + 'geometry (no jump right before a close-shrink animation would start)',
    guarded.width === '100%' && guarded.height === '100%', JSON.stringify(guarded));
push('GROUP 4: the CHROME half still ran even though geometry was skipped '
    + '(head shown again, data-is_fullpage cleared)',
    guarded.headDisplay !== 'none' && guarded.hasFullpageAttr === false, JSON.stringify(guarded));
await page.evaluate(() => document.querySelector('.window[data-app="settings"]')?.removeAttribute('data-closing'));
await sleep(50);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — a REAL close, through the REAL close button, from full-bleed
// (acceptance d, end-to-end)
// ═══════════════════════════════════════════════════════════════════════════
// `shrink_to_target` (mirroring stacking-browser-test.mjs's own M6
// technique) keeps the window in the DOM for ~300ms so this file can
// observe the moment the close call restores chrome, not just the
// after-the-fact state once the element is already gone.
await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    window.enter_fullpage_mode(el);
    el.setAttribute('data-is_fullpage', '1');
});
await sleep(80);
push('GROUP 5 setup: taskbar hidden again with "settings" full-bleed once more',
    (await taskbarDisplay()) === 'none', `display=${await taskbarDisplay()}`);

await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    void $(el).close({ shrink_to_target: document.body });
});
await sleep(60); // well inside the 300ms shrink -- the element is still attached
const midShrink = await page.evaluate(() => {
    const el = document.querySelector('.window[data-app="settings"]');
    if ( ! el ) return null;
    return {
        stillAttached: true,
        dataClosing: el.getAttribute('data-closing'),
        hasFullpageAttr: el.hasAttribute('data-is_fullpage'),
        headDisplay: getComputedStyle(el.querySelector('.window-head')).display,
    };
});
push('GROUP 5 setup: the window is genuinely mid-shrink (still attached, data-closing="1")',
    !! midShrink?.stillAttached && midShrink?.dataClosing === '1', JSON.stringify(midShrink));
push('🔴 GROUP 5 ACCEPTANCE (d), part 1: close from full-bleed reaches the real restore MID-SHRINK '
    + '(data-is_fullpage cleared, head shown) — THE BUG: the old no-argument call skipped this '
    + 'entirely, so it never ran even once before the window was removed',
    midShrink?.hasFullpageAttr === false && midShrink?.headDisplay !== 'none', JSON.stringify(midShrink));
push('GROUP 5 ACCEPTANCE (d), part 2: the taskbar is back too, mid-shrink, not only after removal',
    (await taskbarDisplay()) !== 'none', `display=${await taskbarDisplay()}`);

await sleep(400); // let the shrink finish
const afterClose = await page.evaluate(() => ({
    stillInDom: !! document.querySelector('.window[data-app="settings"]'),
    taskbarDisplay: getComputedStyle(document.querySelector('.taskbar')).display,
}));
push('GROUP 5: the window is actually gone once the shrink completes', ! afterClose.stillInDom, JSON.stringify(afterClose));
push('GROUP 5 ACCEPTANCE (d), part 3: taskbar remains visible after the close fully completes',
    afterClose.taskbarDisplay !== 'none', `display=${afterClose.taskbarDisplay}`);

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — the Code window's full view (app-code lane A2, 2026-10-30)
// ═══════════════════════════════════════════════════════════════════════════
// The same seams GROUP 2 pins for minimise (`_ezil_minimise`) and the expand
// hook (`_ezil_maximise`, `scale_window`), now driven by REAL clicks on the
// Code window's own head, its context menu and its full-view top bar
// (`../ezil/ui/full-view.js` + `../ezil/apps/code.js`). Restoring must land on
// the window's exact previous box, measured by the browser.
const codeItem = await page.evaluate(() => {
    const r = document.querySelector('.taskbar-item[data-app="code"]')?.getBoundingClientRect();
    return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2 } : null;
});
push('GROUP 6 setup: Code is in the dock', !! codeItem);
await page.mouse.click(codeItem.cx, codeItem.cy);
await page.waitForSelector('.window[data-app="code"]', { timeout: 5000 });
await sleep(400);
const CODE = '.window[data-app="code"]';
const codeState = () => page.evaluate((sel) => {
    const el = document.querySelector(sel);
    const r = el.getBoundingClientRect();
    const bar = el.querySelector(':scope > .ezil-full-view-bar');
    return {
        rect: [r.left, r.top, r.width, r.height].map(Math.round),
        full: el.classList.contains('ezil-fullbleed'),
        head: getComputedStyle(el.querySelector(':scope > .window-head')).display,
        bar: bar ? getComputedStyle(bar).display : 'MISSING',
        taskbar: getComputedStyle(document.querySelector('.taskbar')).display,
        minimized: el.getAttribute('data-is_minimized'),
    };
}, CODE);
const centre = async (sel) => {
    const r = await rectOf(sel);
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
};
const vp = page.viewportSize();
const isFullView = (s) => s.full && s.head === 'none' && s.bar === 'flex' && s.taskbar === 'none'
    && s.rect[0] === 0 && s.rect[1] === 0 && s.rect[2] === vp.width && s.rect[3] === vp.height;
const windowedBox = await codeState();
push('GROUP 6 setup: a dock click opens Code WINDOWED (head, taskbar, no top bar)',
    ! windowedBox.full && windowedBox.head !== 'none' && windowedBox.bar === 'none' && windowedBox.taskbar !== 'none', JSON.stringify(windowedBox));

let at = await centre(`${CODE} > .window-head .window-scale-btn`);
await page.mouse.click(at.x, at.y);
await sleep(300);
push('🔴 GROUP 6: a real click on the green button takes the whole viewport (no head, no taskbar, top bar shown)',
    isFullView(await codeState()), JSON.stringify(await codeState()));
const restoreHit = await page.evaluate((sel) => {
    const b = document.querySelector(`${sel} > .ezil-full-view-bar [data-action="restore"]`).getBoundingClientRect();
    return document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest('button')?.dataset.action ?? null;
}, CODE);
push('GROUP 6: the top bar\'s restore button is what a click at its centre hits', restoreHit === 'restore', String(restoreHit));
at = await centre(`${CODE} > .ezil-full-view-bar [data-action="restore"]`);
await page.mouse.click(at.x, at.y);
await sleep(300);
let now = await codeState();
push('🔴 GROUP 6: restore lands on the EXACT previous box, with head and taskbar back',
    ! now.full && JSON.stringify(now.rect) === JSON.stringify(windowedBox.rect) && now.head !== 'none' && now.taskbar !== 'none',
    JSON.stringify({ now, before: windowedBox }));

at = await centre(`${CODE} > .window-head .window-head-title`);
await page.mouse.dblclick(at.x, at.y);
await sleep(300);
push('GROUP 6: a real double-click on the title enters full view', isFullView(await codeState()), JSON.stringify(await codeState()));
at = await centre(`${CODE} .ezil-full-view-title`);
await page.mouse.dblclick(at.x, at.y);
await sleep(300);
now = await codeState();
push('GROUP 6: a real double-click on the top bar returns to the previous box',
    ! now.full && JSON.stringify(now.rect) === JSON.stringify(windowedBox.rect), JSON.stringify(now));

at = await centre(`${CODE} > .window-head .window-head-title`);
await page.mouse.click(at.x, at.y, { button: 'right' });
await sleep(250);
const maximiseItem = await page.evaluate(() => {
    const el = [...document.querySelectorAll('.context-menu .context-menu-item')]
        .find((i) => i.querySelector('.contextmenu-label')?.textContent.trim() === 'Maximize');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
});
push('GROUP 6 setup: the head\'s context menu offers Maximize', !! maximiseItem);
if ( maximiseItem ) await page.mouse.click(maximiseItem.x, maximiseItem.y);
await sleep(300);
push('GROUP 6: the context menu\'s Maximize reaches the same hook (full view)', isFullView(await codeState()), JSON.stringify(await codeState()));

at = await centre(`${CODE} > .ezil-full-view-bar [data-action="minimize"]`);
await page.mouse.click(at.x, at.y);
await sleep(400);
now = await codeState();
push('🔴 GROUP 6: the top bar\'s minimise gives the taskbar back before the window goes',
    ['true', '1'].includes(now.minimized) && now.taskbar !== 'none' && ! now.full, JSON.stringify(now));
await page.mouse.click(codeItem.cx, codeItem.cy);
await sleep(700);
push('GROUP 6: back from the dock it is in full view again', isFullView(await codeState()), JSON.stringify(await codeState()));

// ── GROUP 6 geometry: full view keeps FILLING the viewport (2026-10-30) ─────
// No fixed sleeps below: each read waits until nothing is moving the window
// (no jQuery animation, no CSS transition), then reads twice, two frames apart.
const settledGeometry = async () => {
    await page.waitForFunction((s) => {
        const w = document.querySelector(s);
        return !! w && ! $(w).is(':animated') && w.getAnimations().length === 0;
    }, CODE, { timeout: 5000 });
    const read = () => page.evaluate(async (s) => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const w = document.querySelector(s);
        const r = w.getBoundingClientRect();
        const b = w.querySelector(':scope > .window-body').getBoundingClientRect();
        const hit = (x, y) => document.elementFromPoint(x, y)?.closest('.window') === w;
        return {
            rect: [r.x, r.y, r.width, r.height], body: [b.x, b.y, b.width, b.height], vp: [innerWidth, innerHeight],
            strip: Number.parseFloat(getComputedStyle(w).getPropertyValue('--ezil-control-strip-height')),
            opacity: getComputedStyle(w).opacity, full: w.classList.contains('ezil-fullbleed'),
            hits: hit(innerWidth / 2, innerHeight / 2) && hit(1, innerHeight - 1) && hit(innerWidth - 1, innerHeight - 1),
        };
    }, CODE);
    const first = await read();
    const second = await read();
    return { ...second, stable: JSON.stringify(first) === JSON.stringify(second) };
};
const fills = (g) => g.stable && g.full && g.strip > 0 && g.opacity === '1' && g.hits
    && JSON.stringify(g.rect) === JSON.stringify([0, 0, g.vp[0], g.vp[1]])
    && JSON.stringify(g.body) === JSON.stringify([0, g.strip, g.vp[0], g.vp[1] - g.strip]);
const resizeTo = async (width, height) => {
    await page.setViewportSize({ width, height });
    await page.waitForFunction(([w, h]) => innerWidth === w && innerHeight === h, [width, height]);
};
let g = await settledGeometry();
push('🔴 GROUP 6 geometry: back from the dock it FILLS the viewport (window = viewport, body below the strip, on top)', fills(g), JSON.stringify(g));
await resizeTo(1100, 720);
g = await settledGeometry();
push('🔴 GROUP 6 geometry: a viewport resize while full keeps filling (1100x720)', fills(g) && g.vp[0] === 1100, JSON.stringify(g));
// A relaunch onto the open window: what a dock click or Back/Forward onto
// `/app/code` does (registry.js: `showWindow()`, then `_ezil_relaunch` with
// no view). `showWindow` used to write back the box the last minimise
// recorded (here the 1280x860 viewport), and the window kept its class.
const origBeforeRelaunch = await page.evaluate((s) => document.querySelector(s).getAttribute('data-orig-width'), CODE);
push('GROUP 6 geometry setup: the last minimise left its snapshot (the old viewport width) on the window',
    Number(origBeforeRelaunch) === vp.width, String(origBeforeRelaunch));
await page.evaluate(async () => {
    const p = window.__EZIL_BOOT__;
    await window.ezil.registry.launch('code', { payload: p, computer: p.computer, desktopState: p.desktopState });
});
g = await settledGeometry();
push('🔴 GROUP 6 geometry: a relaunch onto the open full Code (dock / Back-Forward) leaves it filling the RESIZED viewport, '
    + 'not the box its last minimise recorded', fills(g) && g.vp[0] === 1100, JSON.stringify(g));
// Minimised from full view, the viewport changes, then back from the dock.
await page.locator(`${CODE} > .ezil-full-view-bar [data-action="minimize"]`).click();
await page.waitForFunction((s) => ['true', '1'].includes(document.querySelector(s).getAttribute('data-is_minimized')), CODE);
await resizeTo(1180, 780);
await page.locator('.taskbar-item[data-app="code"]').click();
await page.waitForSelector(`${CODE}.ezil-fullbleed`, { timeout: 5000 });
g = await settledGeometry();
push('🔴 GROUP 6 geometry: restored from minimised-in-full after a resize, it fills the NEW viewport (1180x780)',
    fills(g) && g.vp[0] === 1180, JSON.stringify(g));
await resizeTo(vp.width, vp.height);
g = await settledGeometry();
push('GROUP 6 geometry: and back at the original viewport it still fills', fills(g) && g.vp[0] === vp.width, JSON.stringify(g));

// Keyboard modality, so `:focus-visible` applies: Tab from minimise to restore.
await page.focus(`${CODE} > .ezil-full-view-bar [data-action="minimize"]`);
await page.keyboard.press('Tab');
const ring = await page.evaluate(() => {
    const el = document.activeElement;
    return el?.dataset.action === 'restore' ? getComputedStyle(el).outlineStyle : `focus on ${el?.dataset.action ?? el?.tagName}`;
});
await page.keyboard.press('Enter');
await sleep(300);
now = await codeState();
push('GROUP 6: the restore button works from the keyboard (Enter) and shows a focus ring',
    ! now.full && JSON.stringify(now.rect) === JSON.stringify(windowedBox.rect) && ring !== 'none', JSON.stringify({ now, ring }));
push('GROUP 6: no Fullscreen API element at any point', await page.evaluate(() => document.fullscreenElement === null));

push('no uncaught page errors during the whole run', page_errors.length === 0, JSON.stringify(page_errors));

await browser.close();

const passed = checks.filter((c) => c.pass).length;
console.log(`\n${passed}/${checks.length} checks passed`);
process.exit(passed === checks.length ? 0 : 1);
