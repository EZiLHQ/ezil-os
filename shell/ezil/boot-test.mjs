// boot-test.mjs — EZiL-authored. Headless test of the SHELL LAYER's boot path.
//
// Run: cd shell && node ezil/boot-test.mjs   (after build-shell.sh)
//
// `../load-test.mjs` proves the ported window manager evaluates and can
// construct a window. It deliberately runs with NO `window.__EZIL_BOOT__`, so
// it never reaches `mount()` — it cannot tell you whether the OS actually
// assembles. This does: it hands the bundle a real boot payload and a stubbed
// `fetch`, then asserts what a user would see.
//
// It lives in `shell/ezil/` because that is the tree it tests. Nothing here is
// bundled: `build-shell.sh`'s esbuild entry only follows imports from
// `boot.js`, and its `css_inputs()` only globs `*.css`.
//
// jsdom is not a browser — no layout, no compositing. This proves ASSEMBLY and
// WIRING (which elements exist, what the iframe is pointed at, when), not that
// anything is positioned correctly on screen. The browser check is a real page
// load against `next dev`.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../app/public/os');
const icons = fs.readFileSync(`${OS}/icons.js`, 'utf8');
const bundle = fs.readFileSync(`${OS}/bundle.min.js`, 'utf8');

const PAYLOAD = {
    user: { id: 'user-1', email: 'someone@ezil.work' },
    computer: {
        id: 'computer-1', name: 'My Computer', slot: 1,
        createdAt: '2026-07-31T00:00:00.000Z', lastOpenedAt: null, isNew: false,
    },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true,
        status: 'idle',
        endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop' },
    },
};

const checks = [];
const errors = [];
const push = (name, pass, detail = '') => checks.push({ name, pass, detail });
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wait for `fn()` to be truthy, or give up. Never a bare sleep in an assert. */
async function until (fn, ms = 4000, step = 25) {
    const deadline = Date.now() + ms;
    for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > deadline) return null;
        await sleep(step);
    }
}

/**
 * Boot a fresh shell in a fresh DOM.
 * @param {(url: string, init: object) => object} handler returns the JSON body
 *   for a given request, or throws to simulate a transport failure.
 * @param {object} payload `window.__EZIL_BOOT__`.
 * @param {string} body the host page's markup. Defaults to a BARE host (no
 *   React); scenario 5 passes what `/os` actually renders.
 */
function boot_shell (handler, payload = PAYLOAD, body = '<div id="ezil-os-root"></div>') {
    const dom = new JSDOM(
        `<!doctype html><html><head></head><body class="min-h-full flex flex-col">${body}</body></html>`,
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
    );
    const { window } = dom;
    window.addEventListener('error', e => errors.push(`window error: ${e.message}`));

    if (!window.crypto?.getRandomValues) {
        window.crypto = { getRandomValues: (a) => { for (let i = 0; i < a.length; i++) a[i] = (Math.random() * 256) | 0; return a; } };
    }
    // jsdom ships neither of these; `session.js` uses both on every request.
    if (!window.AbortSignal?.timeout) {
        window.AbortSignal = { timeout: () => undefined };
    }
    const seen = [];
    window.fetch = async (url, init = {}) => {
        seen.push({ url, method: init.method ?? 'GET' });
        const body = await handler(url, init);
        return { ok: body.__status === undefined || body.__status < 400, status: body.__status ?? 200, json: async () => body };
    };
    window.__EZIL_BOOT__ = payload;

    try {
        window.eval(icons);
        window.eval(bundle);   // self-boots
    } catch (e) {
        errors.push(`eval: ${e?.stack?.split('\n').slice(0, 5).join(' | ') ?? e}`);
    }
    return { window, seen };
}

const $$ = (w, sel) => w.document.querySelectorAll(sel);
const $1 = (w, sel) => w.document.querySelector(sel);

// ───────────────────────────────────────────────────────────────────────────
// Scenario 1 — a happy boot
// ───────────────────────────────────────────────────────────────────────────
const URL_OK = 'https://preview.example.invalid/guac/abc';
let release_preview;
const preview_gate = new Promise((r) => { release_preview = r; });

let guac_running = false;   // flipped mid-test to prove the confirmed path
{
    const { window, seen } = boot_shell(async (url, init) => {
        if (url.startsWith('/api/shell/desktop') && init.method === 'POST') {
            // Held open so the PENDING state is observable — the whole point
            // of the panel is what it shows during the ~22s wait.
            await preview_gate;
            return {
                ok: true, guacamoleUrl: URL_OK, controlMode: 'interactive', mode: 'neko',
                // The server says it reached the desktop origin before handing
                // the URL over. Never defaulted: `session.openDesktop` reads
                // `data.frame?.confirmed === true`, so a stub that omits this
                // is a server that did not check, and the shell must not take
                // the viewport for it.
                frame: { confirmed: true },
            };
        }
        // 🔴 The post-handoff question, and it MUST be matched before the
        // generic status poll below — they share a path and differ only by
        // `confirm=frame`. Answering it with the poll's body means
        // `confirmFrame` sees no `confirmed` field, reads it as "no answer",
        // and the shell correctly refuses to hand over the viewport.
        if (url.includes('confirm=frame')) return { ok: true, confirmed: true };
        if (url.startsWith('/api/shell/desktop')) return { ok: true, guacamoleRunning: guac_running };
        return { ok: true };
    });

    push('device class added, Tailwind classes kept',
        window.document.body.classList.contains('device-desktop')
        && window.document.body.classList.contains('flex'),
        window.document.body.className);

    push('desktop root mounted inside #ezil-os-root',
        $$(window, '#ezil-os-root > .desktop.ezil-desktop').length === 1,
        `${$$(window, '.desktop').length} .desktop nodes`);

    const taskbar = await until(() => $1(window, '.taskbar'));
    push('taskbar painted', !!taskbar);
    push('taskbar has the pinned Desktop item',
        $$(window, '.taskbar-item[data-app="desktop"]').length === 1,
        `${$$(window, '.taskbar-item[data-app="desktop"]').length} items`);
    push('pinned item is kept in the taskbar (survives a close)',
        $1(window, '.taskbar-item[data-app="desktop"]')?.getAttribute('data-keep-in-taskbar') === 'true');

    const win = await until(() => $1(window, '.window[data-app="desktop"]'));
    push('desktop window opened', !!win);
    push('🔴 EXACTLY ONE window',
        $$(window, '.window').length === 1, `${$$(window, '.window').length} windows`);
    // 🔴 THE STACKING CONTRACT. This window used to be created with
    // `stay_on_top: true`, which put it in UIWindow's hardcoded 99999999+ z band
    // (`window_zindex_base`, UIWindow.js:4066) that no ordinary window can ever
    // out-rank — and `focusWindow()` skips re-raising stay_on_top windows
    // (UIWindow.js:4089) while the minimise/restore path grows the band further.
    // Settings and Preview (both `stay_on_top: false`) became permanently
    // unreachable behind the desktop. The desktop now lives in the ordinary
    // band: last-focused wins. Pin the ABSENCE of the runaway band, not a
    // boolean — the guarantee is reachability.
    const winZ = Number(win?.style?.zIndex ?? 0);
    push('window is NOT stay_on_top (no unreachable z band)',
        win?.getAttribute('data-stay_on_top') === 'false', win?.getAttribute('data-stay_on_top'));
    push('🔴 desktop z-index is an ordinary counter, not the 99999999+ band',
        Number.isFinite(winZ) && winZ < 99999999, `z-index=${win?.style?.zIndex || '(unset)'}`);

    // 🔴 THE BOOT-TIME CHROME CONTRACT. This window used to be created with
    // `is_fullpage: true`, so UIWindow called `enter_fullpage_mode` 50ms later
    // and `$('.taskbar').hide()` took the dock away from the first frame — for
    // the whole ~26s container boot the user had a full-bleed boot panel and a
    // 54x15px drawer tongue. Full-bleed is now earned, not assumed.
    push('🔴 the window opens WINDOWED, not full-bleed',
        win?.getAttribute('data-is_fullpage') === '0'
        && !win?.classList.contains('ezil-fullbleed'),
        `fullpage=${win?.getAttribute('data-is_fullpage')} class="${win?.className}"`);
    push('🔴 the TASKBAR IS ON SCREEN while the container boots',
        window.$('.taskbar').css('display') !== 'none', window.$('.taskbar').css('display'));
    push('the window keeps its own head, so there is an ordinary way out',
        window.$(win).find('.window-head').css('display') !== 'none',
        window.$(win).find('.window-head').css('display'));
    // 🔴 UIWindow.js:346 renders this ONLY for a resizable window. OBSERVED in
    // Chromium: with `is_resizable: false` the head came out with a close
    // button and nothing else, so "put my computer aside while it boots" would
    // have meant closing it. `is_resizable: true` is carried for this button.
    push('🔴 ...and that head has a MINIMISE button, not just a close',
        win?.querySelectorAll('.window-head .window-minimize-btn').length === 1
        && win?.querySelectorAll('.window-head .window-close-btn').length === 1,
        `min=${win?.querySelectorAll('.window-head .window-minimize-btn').length}`
        + ` close=${win?.querySelectorAll('.window-head .window-close-btn').length}`);
    push('UIWindow did NOT create a second taskbar item',
        $$(window, '.taskbar-item[data-app="desktop"]').length === 1);
    push('pinned item counts the open window',
        $1(window, '.taskbar-item[data-app="desktop"]')?.getAttribute('data-open-windows') === '1',
        $1(window, '.taskbar-item[data-app="desktop"]')?.getAttribute('data-open-windows'));

    // 🔴 The rule the whole wave turns on.
    const iframe = $1(window, '.window[data-app="desktop"] .window-app-iframe');
    push('iframe exists but is NOT pointed at a desktop yet',
        !!iframe && iframe.getAttribute('src') === 'about:blank', iframe?.getAttribute('src'));
    push('no preview URL was composed client-side',
        !window.document.documentElement.outerHTML.includes(URL_OK));

    const panel = $1(window, '.ezil-boot');
    push('boot panel is in the window body, not an iframe',
        !!panel && panel.closest('.window-body') !== null);
    push('panel shows the progress state', panel?.getAttribute('data-kind') === 'progress',
        panel?.getAttribute('data-kind'));
    push('four phase rows rendered', $$(window, '.ezil-boot-phase').length === 4,
        `${$$(window, '.ezil-boot-phase').length} rows`);
    push('boot headline is the honest one',
        $1(window, '.ezil-boot-title')?.textContent === 'Starting your computer',
        $1(window, '.ezil-boot-title')?.textContent);

    // 🔴 HONESTY: no checkmark may be drawn from elapsed time alone. The stub
    // reports guacamoleRunning:false, so nothing is `confirmed` no matter how
    // long the clock runs.
    await sleep(400);
    push('🔴 no phase claims "confirmed" without a real signal',
        $$(window, '.ezil-boot-phase[data-state="confirmed"]').length === 0,
        [...$$(window, '.ezil-boot-phase')].map(r => r.getAttribute('data-state')).join(','));
    push('a phase IS highlighted as current (an estimate, drawn as one)',
        $$(window, '.ezil-boot-phase[data-state="current"]').length === 1);

    // The cheap status probe runs on a 2s interval WHILE the long POST is
    // still in flight — the one genuine mid-boot signal the browser has.
    const polled = await until(() => seen.some(r => r.method === 'GET' && r.url.includes('computerId=computer-1')), 4000);
    push('the status probe is polled while the boot is in flight', !!polled,
        JSON.stringify(seen.map(r => `${r.method} ${r.url}`)));
    push('the preview request went through /api/shell/desktop (POST)',
        seen.some(r => r.method === 'POST' && r.url === '/api/shell/desktop'));
    push('the probe is a GET, so it cannot wake a sleeping container',
        seen.filter(r => r.url.includes('computerId=')).every(r => r.method === 'GET'));

    // 🔴 The ONLY way a checkmark is allowed to appear: a real
    // `guacamoleRunning: true` off that probe. Flip it and watch.
    guac_running = true;
    const confirmed = await until(() => $1(window, '.ezil-boot-phase[data-state="confirmed"]'), 4000);
    push('🔴 a REAL running signal is what draws the checkmark', !!confirmed,
        [...$$(window, '.ezil-boot-phase')].map(r => r.getAttribute('data-state')).join(','));
    push('and it confirms "connecting", the phase the signal actually means',
        confirmed?.getAttribute('data-phase') === 'connecting', confirmed?.getAttribute('data-phase'));

    // The drawer — the only chrome once the taskbar is hidden. It is attached
    // up front (so `go_fullbleed` cannot fire without an exit existing) but it
    // must NOT have played its intro: while the window has a head and a
    // taskbar, the tongue is a worse duplicate of controls already on screen.
    const drawer = $1(window, '.window[data-app="desktop"] .ezil-app-drawer');
    push('control drawer attached to the window', !!drawer);
    push('drawer carries Minimise and Close',
        !!drawer?.querySelector('.dashboard-app-drawer-minimize')
        && !!drawer?.querySelector('.dashboard-app-drawer-close'));
    push('🔴 the drawer does NOT introduce itself while the window is windowed',
        drawer?.classList.contains('collapsed') === true, drawer?.className);

    // Let the preview land.
    release_preview();
    const swapped = await until(() => iframe.getAttribute('src') === URL_OK);
    push('🔴 iframe is navigated only after previewUrl RESOLVED', !!swapped, iframe.getAttribute('src'));
    push('panel reports ready', $1(window, '.ezil-boot')?.getAttribute('data-kind') === 'ready');
    push('and the taskbar is STILL there — the frame has not loaded yet',
        window.$('.taskbar').css('display') !== 'none', window.$('.taskbar').css('display'));

    // ── the handoff: the desktop earns the viewport ────────────────────────
    // jsdom never loads an external iframe (VERIFIED: no `load` event ever
    // fires for a cross-origin src), so the browser's own signal is raised
    // here by hand. The 4s belt-and-braces timer in `desktop-window.js` would
    // otherwise be what this test measured.
    iframe.dispatchEvent(new window.Event('load'));
    const asked = await until(() => seen.some(r => r.url.includes('confirm=frame')), 2000);
    push('🔴 `load` only triggers the QUESTION — the server is asked first', !!asked,
        JSON.stringify(seen.filter(r => r.url.includes('confirm=')).map(r => `${r.method} ${r.url}`)));
    const fullbled = await until(() => win.classList.contains('ezil-fullbleed'), 2000);
    push('🔴 full-bleed happens when the DESKTOP FRAME lands, not before', !!fullbled,
        win.className);
    push('...and only then is the taskbar hidden (the reason the drawer exists)',
        window.$('.taskbar').css('display') === 'none', window.$('.taskbar').css('display'));
    push('the panel is retired in the same beat, so chrome is never traded for nothing',
        $1(window, '.ezil-boot')?.hidden === true);
    push('close() now knows it owes the user a taskbar back',
        win.getAttribute('data-is_fullpage') === '1', win.getAttribute('data-is_fullpage'));

    window.$(drawer.querySelector('.dashboard-app-drawer-minimize')).trigger('click');
    const taskbar_back = await until(() => window.$('.taskbar').css('display') !== 'none');
    push('🔴 minimise brings the taskbar back BEFORE hiding the window', !!taskbar_back,
        window.$('.taskbar').css('display'));
    push('window is marked minimised',
        ['1', 'true'].includes(win.getAttribute('data-is_minimized')),
        win.getAttribute('data-is_minimized'));
    push('the desktop kept running behind the minimise', iframe.getAttribute('src') === URL_OK);

    // ── restore from the taskbar, then close ───────────────────────────────
    window.$('.taskbar-item[data-app="desktop"]').trigger('click');
    const restored = await until(() => !['1', 'true'].includes(win.getAttribute('data-is_minimized')));
    push('taskbar click restores the window', !!restored);
    const refullpaged = await until(
        () => win.getAttribute('data-is_fullpage') === '1' && win.classList.contains('ezil-fullbleed'), 2000);
    push('restore returns to full-bleed (not a 680x380 box)', !!refullpaged,
        `fullpage=${win.getAttribute('data-is_fullpage')} class="${win.className}"`);

    // 🔴 Regression guard for the missing `remove_taskbar_item`: before it was
    // restored, this threw INSIDE $.fn.close, leaving an unclosable window.
    const before = errors.length;
    await window.$(win).close();
    await sleep(300);
    push('🔴 closing an app window does not throw (remove_taskbar_item)',
        errors.length === before, errors.slice(before).join(' | '));
    push('window is gone', $$(window, '.window[data-app="desktop"]').length === 0);
    push('the pinned taskbar item survived the close',
        $$(window, '.taskbar-item[data-app="desktop"]').length === 1);
}

// ───────────────────────────────────────────────────────────────────────────
// Scenario 2 — the worker is unreachable
// ───────────────────────────────────────────────────────────────────────────
{
    let attempts = 0;
    const { window } = boot_shell(async (url, init) => {
        if (url.startsWith('/api/shell/desktop') && init.method === 'POST') {
            attempts++;
            return { ok: false, errorCode: 'connection_refused' };
        }
        return { ok: true, guacamoleRunning: false };
    });

    const failed = await until(() => $1(window, '.ezil-boot[data-kind="failed"]'));
    push('a failed boot says so', !!failed);
    push('failure copy is the specific one, not a generic spinner',
        $1(window, '.ezil-boot-title')?.textContent === "Can't reach your computer",
        $1(window, '.ezil-boot-title')?.textContent);
    push('phase list is hidden on failure', $1(window, '.ezil-boot-phases')?.hidden === true);
    const retry = $1(window, '.ezil-boot-retry');
    push('Retry is offered', !!retry && $1(window, '.ezil-boot-actions')?.hidden === false);

    // 🔴 A boot that never succeeded must never have cost the user their OS.
    // Under the old `is_fullpage: true` this failure panel was full-bleed with
    // the taskbar hidden behind it.
    const failed_win = $1(window, '.window[data-app="desktop"]');
    push('🔴 a FAILED boot leaves the taskbar on screen',
        window.$('.taskbar').css('display') !== 'none', window.$('.taskbar').css('display'));
    push('...and the failure panel sits in a window, not over the whole viewport',
        failed_win?.classList.contains('ezil-fullbleed') === false
        && failed_win?.getAttribute('data-is_fullpage') === '0',
        `class="${failed_win?.className}" fullpage=${failed_win?.getAttribute('data-is_fullpage')}`);

    window.$(retry).trigger('click');
    const retried = await until(() => attempts >= 2);
    push('Retry re-runs the boot', !!retried, `attempts=${attempts}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scenario 3 — no provider configured
// ───────────────────────────────────────────────────────────────────────────
{
    let requests = 0;
    const { window } = boot_shell(async () => { requests++; return { ok: true }; }, {
        ...PAYLOAD,
        desktopState: { ...PAYLOAD.desktopState, configured: false },
    });

    const nc = await until(() => $1(window, '.ezil-boot[data-kind="not_configured"]'));
    push('unconfigured provider renders its own honest state', !!nc);
    push('no Retry button for a state retrying cannot fix',
        $1(window, '.ezil-boot-actions')?.hidden === true);
    await sleep(200);
    push('and no pointless request was sent', requests === 0, `${requests} requests`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scenario 4 — a payload the shell must refuse to draw for
// ───────────────────────────────────────────────────────────────────────────
{
    const dom = new JSDOM('<!doctype html><html><body><div id="ezil-os-root"></div></body></html>',
        { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' });
    // No `__EZIL_BOOT__` is set, and no fetch is provided: a shell that drew
    // anything here would be drawing a desktop for nobody.
    dom.window.eval(icons);
    dom.window.eval(bundle);
    await sleep(150);
    push('no payload -> globals installed but NOTHING drawn',
        dom.window.ezil?.booted === true
        && dom.window.ezil?.mounted === false
        && dom.window.document.querySelectorAll('.desktop, .window, .taskbar').length === 0,
        `booted=${dom.window.ezil?.booted} mounted=${dom.window.ezil?.mounted}`);
}

// ───────────────────────────────────────────────────────────────────────────
// Scenario 5 — a REACT host (what `/os` really is)
//
// The defect this locks down: the shell used to write to <body> and
// #ezil-os-root the moment it evaluated. On a React document that happens
// before hydration, React finds a tree it did not render, and REGENERATES the
// whole page — deleting the desktop. Measured on the production build with
// 900ms of latency on React's chunks: 4 of 5 loads ended blank, permanently,
// because `mounted` stayed true and nothing could re-boot.
//
// Two properties are asserted here, and both have to hold:
//   1. with `data-awaits-hydration="react"` on the mount point, the shell
//      touches NOTHING until the page says it has hydrated;
//   2. if the desktop is destroyed anyway, the shell REBUILDS it.
// ───────────────────────────────────────────────────────────────────────────
{
    const OS_BODY = '<div id="ezil-os-root" data-awaits-hydration="react">'
        + '<div class="desktop ezil-desktop"></div></div>';
    const { window } = boot_shell(async (url, init) => {
        if (url.startsWith('/api/shell/desktop') && init.method === 'POST') {
            return {
                ok: true, guacamoleUrl: URL_OK, controlMode: 'interactive', mode: 'neko',
                frame: { confirmed: true },
            };
        }
        if (url.includes('confirm=frame')) return { ok: true, confirmed: true };
        if (url.startsWith('/api/shell/desktop')) return { ok: true, guacamoleRunning: true };
        return { ok: true };
    }, PAYLOAD, OS_BODY);

    await sleep(250);
    push('🔴 React host: the shell mutates NOTHING before hydration',
        window.ezil.booted === true && window.ezil.mounted === false
        && $$(window, '.taskbar, .window').length === 0
        && !window.document.body.classList.contains('device-desktop'),
        `mounted=${window.ezil.mounted} body="${window.document.body.className}"`
        + ` nodes=${$$(window, '.taskbar, .window').length}`);
    push('the server-rendered wallpaper is already there, untouched',
        $$(window, '#ezil-os-root > .desktop.ezil-desktop').length === 1);

    window.dispatchEvent(new window.Event('ezil:hydrated'));
    const tb = await until(() => $1(window, '.taskbar'));
    push('...and mounts as soon as the page says it has hydrated',
        !!tb && window.document.body.classList.contains('device-desktop'),
        window.document.body.className);
    push('it adopted the server-rendered desktop instead of adding a second',
        $$(window, '.desktop').length === 1, `${$$(window, '.desktop').length} .desktop nodes`);
    const win = await until(() => $1(window, '.window[data-app="desktop"]'));
    push('the desktop window opened on the React host', !!win);

    // Now do exactly what React does when it regenerates the tree: replace the
    // mount point with a fresh copy of the server markup, drop the windows,
    // and put <body>'s class list back to what the server sent.
    const fresh = window.document.createElement('div');
    fresh.id = 'ezil-os-root';
    fresh.setAttribute('data-awaits-hydration', 'react');
    fresh.innerHTML = '<div class="desktop ezil-desktop"></div>';
    $1(window, '#ezil-os-root').replaceWith(fresh);
    for (const el of $$(window, '.window')) el.remove();
    window.document.body.className = 'min-h-full flex flex-col';
    push('the simulated regeneration really did destroy the desktop',
        $$(window, '.taskbar, .window').length === 0);

    const rebuilt = await until(() => $1(window, '.taskbar'));
    push('🔴 a destroyed desktop rebuilds itself — `mounted` is not a latch',
        !!rebuilt, `attempts=${window.ezil.mountAttempts}`);
    push('the rebuild is not a duplicate',
        $$(window, '.taskbar').length === 1 && $$(window, '.desktop').length === 1,
        `${$$(window, '.taskbar').length} taskbars, ${$$(window, '.desktop').length} desktops`);
    push('the device class is back on <body>',
        window.document.body.classList.contains('device-desktop'), window.document.body.className);
    const rewin = await until(() => $1(window, '.window[data-app="desktop"]'));
    push('the desktop window is back too', !!rewin);
    push('and exactly one of them is open', $$(window, '.window[data-app="desktop"]').length === 1);
}

// ───────────────────────────────────────────────────────────────────────────
const failed = checks.filter(c => !c.pass);
for (const c of checks) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
if (errors.length) {
    console.log('\nUncaught errors:');
    for (const e of errors) console.log(`  ${e}`);
}
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
