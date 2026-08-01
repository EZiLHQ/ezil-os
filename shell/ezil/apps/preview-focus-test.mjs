// preview-focus-test.mjs — EZiL-authored. End-to-end harness for the two
// shell-side seams closed in the wave-a seam pass: the Preview window
// (registry entry -> real window -> freshly minted URL -> frame honesty) and
// the in-stream app-focus control (feature detection -> real transport ->
// honest enum).
//
// Run:  node shell/ezil/apps/preview-focus-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not source)
//
// ── Why it exists ───────────────────────────────────────────────────────────
// This repository's documented failure mode is right code with wrong
// COVERAGE — three verification rounds in a row passed and were wrong, each
// time because the harness omitted the thing that broke. Wave A produced two
// textbook instances of it inside one feature:
//
//   * `registry.js` registered `preview` against a PLACEHOLDER window
//     ("Preview is not built yet in this deployment") because the real file
//     was being written in a sibling worktree. Both landed. Nothing noticed
//     that the icon still opened the stub. Every test stayed green.
//   * `preview.js` read `res.appPreviewUrl` off `session.openDesktop()`. The
//     URL landed behind a different route entirely, so the field was
//     permanently `undefined` and the window ALWAYS took its "not available"
//     branch. That branch is honest, so nothing looked broken — it just never
//     worked. Every test stayed green.
//
// Both are invisible to unit tests and to the diff. They are only visible if
// something clicks the icon and looks at what the window actually did. That is
// this file.
//
// ── Entry points exercised (the doctrine's "enumerate them" rule) ───────────
//   1. `registry.resolve()` for the REAL server payload — is Preview even in
//      the list a boot produces?
//   2. The Start menu — the only place a non-pinned app is reachable from.
//      Clicked for real, through `boot.js`'s own listener.
//   3. `registry.launch('preview')` — the programmatic path.
//   4. Close-and-reopen — the TTL case, and the one that has bitten this
//      project before (module-scoped state surviving a window).
//   5. The desktop window's control drawer — the focus button.
//
// jsdom is not a browser: no layout, no real network, no cross-origin frames.
// This proves construction, wiring, ORDERING and which URL was used. It cannot
// prove pixels.

import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = path.resolve(here, '../../../app/public/os');

for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    return !! pass;
};

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div id="ezil-os-root"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(`window error: ${e.message}`));
window.onerror = (m) => uncaught.push(`onerror: ${m}`);
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = {
        getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; },
    };
}

// ── the boot payload, copied from the server's own shape ────────────────────
// `apps` is `SHELL_APPS` verbatim (an explicit, one-element, non-empty array —
// the input that silently deleted Settings from every boot once already), and
// `endpoints` is `SHELL_API_ROUTES` verbatim. 🔴 There is deliberately NO
// preview URL anywhere in here: check group 4 asserts that the window cannot
// have got one from the payload even if a future change put one there.
const COMPUTER = {
    id: 'c-1', name: 'My computer', slot: 1,
    createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    focus: '/api/shell/focus',
};
const PAYLOAD = {
    user: { id: 'u-1', email: 'someone@example.com' },
    computer: COMPUTER,
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: {
        provider: 'cloudflare-guacamole',
        configured: true,
        hasHmacSecret: true,
        status: 'idle',
        endpoints: ENDPOINTS,
    },
};

// ── the stubbed server ──────────────────────────────────────────────────────
const calls = [];
/** Bumped per mint so each minted URL is distinguishable from every other. */
let mintSeq = 0;
/** What `confirmFrame` should answer next. Flipped to drive BOTH directions. */
let confirmAnswer = true;
/** What `/api/shell/preview-url` should answer next. */
let previewUrlMode = 'ok';
/** What `/api/shell/focus` should answer next. */
let focusMode = 'ok';

const mintedUrls = [];

window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method ?? 'GET', body });

    const json = (payload, status = 200) => ({
        ok: status < 400, status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    });

    if ( u.startsWith(ENDPOINTS.previewUrl) ) {
        if ( previewUrlMode === 'unavailable' ) {
            return json({ ok: false, errorCode: 'app_preview_unavailable', error: 'no port' });
        }
        mintSeq++;
        // The real shape: a bridge-host bootstrap URL whose token is the
        // credential. `mint=` makes each one identifiable.
        const minted = `https://3002-guac-u1-c1-app.ezil.org/preview-bootstrap`
            + `?token=t=${Date.now()},v1=deadbeef&mint=${mintSeq}`;
        mintedUrls.push(minted);
        return json({ ok: true, appPreviewUrl: minted, expiresAt: Date.now() + 300_000 });
    }

    if ( u.startsWith(ENDPOINTS.focus) ) {
        if ( focusMode === 'refused' ) return json({ ok: false, error: 'focus_switch_failed' }, 500);
        return json({ ok: true, app: body?.app });
    }

    if ( u.startsWith(ENDPOINTS.desktop) ) {
        if ( u.includes('confirm=frame') ) {
            return json({ ok: true, confirmed: confirmAnswer, status: confirmAnswer ? 200 : 500 });
        }
        if ( (opts.method ?? 'GET') === 'GET' ) return json({ ok: true, guacamoleRunning: true });
        return json({ ok: true, guacamoleUrl: 'https://8181-guac-u1-c1-nekodesktop.ezil.org/', frame: { confirmed: true } });
    }

    return json({ error: { code: 'STUB', message: 'not stubbed' } }, 500);
};

function evalOrDie (label, code) {
    try {
        window.eval(code);
    } catch ( e ) {
        console.error(`${label} threw: ${e?.stack ?? e}`);
        process.exit(1);
    }
}
window.__EZIL_BOOT__ = PAYLOAD;
evalOrDie('icons.js', fs.readFileSync(`${OS}/icons.js`, 'utf8'));
evalOrDie('bundle.min.js', fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));

const ezil = window.ezil;
push('bundle exposes window.ezil', typeof ezil === 'object');
ezil.boot();

const doc = window.document;
const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 14, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const q = (sel) => doc.querySelector(sel);
const qa = (sel) => Array.from(doc.querySelectorAll(sel));
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

/**
 * 🔴 Fire the iframe's `load` event by hand, and understand why that is the
 * honest thing to do rather than a cheat.
 *
 * jsdom will not fetch a cross-origin `src`, so it never fires `load` on its
 * own. A real browser DOES — and it fires it identically for a working page
 * and for an HTTP 500 error page, which is the entire reason the frame-honesty
 * contract exists. Dispatching it here reproduces exactly the signal the
 * browser gives and exactly the signal the shell must refuse to trust: what
 * happens next has to come from `session.confirmFrame`, not from this event.
 *
 * `settle_frame` also has a 4s fallback timer, so the window is not DEPENDENT
 * on this — it just makes the test take 4s less per case.
 */
const fireLoad = (iframe) => iframe?.dispatchEvent(new window.Event('load'));

/** Longer wait, for the paths with real measured delays in them (the ~1.7s encoder floor). */
const waitMs = (ms) => new Promise(r => window.setTimeout(r, ms));

await settle(20);
push('the real boot path mounted a desktop', !! q('.desktop'));

// ═══════════════════════════════════════════════════════════════════════════
// 1. REACHABILITY — is Preview in the list a REAL boot produces?
// ═══════════════════════════════════════════════════════════════════════════
const resolvedIds = ezil.registry.resolve(PAYLOAD).map(a => a.id);
push('resolve() keeps Preview when the server lists only "desktop"',
    resolvedIds.includes('preview'), JSON.stringify(resolvedIds));
push('resolve() still opens the desktop first (boot.js uses apps[0])',
    resolvedIds[0] === 'desktop', resolvedIds[0]);

const previewDescriptor = ezil.registry.getApp('preview');
push('the Preview descriptor exists', !! previewDescriptor);
// NB: identifying the placeholder by `open.name` does not work — esbuild
// minifies it to two letters. The real discrimination is behavioural and
// happens in group 3: the placeholder rendered static `body_content` saying
// "Preview is not built yet in this deployment" and had NO iframe; the real
// window has an iframe and mints a URL. Both are asserted there.
push('Preview has its own icon, not a duplicate of Settings',
    !! previewDescriptor?.icon && previewDescriptor.icon !== ezil.registry.getApp('settings')?.icon);

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE START MENU — the only entry point a non-pinned app has.
// ═══════════════════════════════════════════════════════════════════════════
// Driven through boot.js's own `ezil:start-click` listener, not by calling
// `open_start_menu` (which is not exported and is not what a user touches).
window.$('.taskbar-item[data-name="Start"]').trigger('click');
await settle(4);
const menuItems = qa('.context-menu .context-menu-item');
const previewItem = menuItems.find(el => (el.textContent ?? '').includes('Preview'));
push('the Start menu lists Preview', !! previewItem,
    JSON.stringify(menuItems.map(e => (e.textContent ?? '').trim())));

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE WINDOW — opened from the Start menu, as a user reaches it.
// ═══════════════════════════════════════════════════════════════════════════
const callsBeforeOpen = calls.length;
click(previewItem);
await settle(20);

const win = q('.window[data-app="preview"]');
push('🔴 clicking Preview in the Start menu opens a Preview window', !! win);
push('it is the real window, not the placeholder',
    ! /not built yet/i.test(win?.textContent ?? ''), (win?.textContent ?? '').slice(0, 60));
push('the Preview window has an iframe to put the app in',
    !! win?.querySelector('.window-app-iframe'));
push('exactly one Preview window (single_instance)', qa('.window[data-app="preview"]').length === 1);

// ═══════════════════════════════════════════════════════════════════════════
// 4. 🔴 THE 5-MINUTE TTL — minted AT WINDOW-OPEN, never stashed.
// ═══════════════════════════════════════════════════════════════════════════
const mintCalls = calls.slice(callsBeforeOpen).filter(c => c.url.startsWith(ENDPOINTS.previewUrl));
push('🔴 opening the window REQUESTS a URL (it did not have one already)',
    mintCalls.length === 1, `${mintCalls.length} mint call(s) after the click`);
push('the mint is a POST carrying the computer id',
    mintCalls[0]?.method === 'POST' && mintCalls[0]?.body?.computerId === COMPUTER.id);

const iframe = win?.querySelector('.window-app-iframe');
push('🔴 the iframe is showing the URL THAT call minted',
    iframe?.getAttribute('src') === mintedUrls[mintedUrls.length - 1],
    `${iframe?.getAttribute('src')}`);
push('the URL is a bridge bootstrap URL with its token intact',
    /\/preview-bootstrap\?token=/.test(iframe?.getAttribute('src') ?? ''));

// The boot payload must not be a place a URL could come from.
push('🔴 no preview URL is reachable from the boot payload',
    ! JSON.stringify(PAYLOAD).includes('preview-bootstrap'));

// Close and reopen: the second open must mint AGAIN and must NOT reuse the
// first URL. This is the actual failure mode — a URL cached in module state
// works perfectly for five minutes and then produces a blank window forever.
const firstUrl = iframe?.getAttribute('src');
await window.$(win).close();
await settle(6);
push('closing the window removes it', qa('.window[data-app="preview"]').length === 0);

const callsBeforeReopen = calls.length;
await ezil.registry.launch('preview', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const remintCalls = calls.slice(callsBeforeReopen).filter(c => c.url.startsWith(ENDPOINTS.previewUrl));
const win2 = q('.window[data-app="preview"]');
const iframe2 = win2?.querySelector('.window-app-iframe');
push('🔴 re-opening mints a FRESH URL rather than reusing the stale one',
    remintCalls.length === 1 && iframe2?.getAttribute('src') !== firstUrl,
    `${remintCalls.length} mint(s); src changed: ${iframe2?.getAttribute('src') !== firstUrl}`);
push('and the fresh URL is the one the SECOND call returned',
    iframe2?.getAttribute('src') === mintedUrls[mintedUrls.length - 1]);

// ═══════════════════════════════════════════════════════════════════════════
// 5. FRAME HONESTY, BOTH DIRECTIONS, inside the shell.
// ═══════════════════════════════════════════════════════════════════════════
// Direction A: the browser fires `load`. That must NOT be what reveals the
// frame -- only the server's answer may.
const progressA = win2?.querySelector('[data-kind]');
push('the boot panel is still up at the moment `load` fires',
    !! progressA && progressA.hidden === false, `hidden=${progressA?.hidden}`);
push('nothing asked the server before `load`',
    ! calls.some(c => c.url.includes('confirm=frame')));

fireLoad(iframe2);
await settle(14);

push('the server WAS asked (load alone never reveals the frame)',
    calls.some(c => c.url.includes('confirm=frame')));
const confirmCall = calls.filter(c => c.url.includes('confirm=frame')).pop();
push('confirmFrame was asked about the URL the iframe is actually showing',
    decodeURIComponent(confirmCall?.url ?? '').includes(iframe2?.getAttribute('src') ?? ' '));
push('\u{1f534} DIRECTION A - a CONFIRMED frame brings the boot panel down',
    !! progressA && progressA.hidden === true,
    `hidden=${progressA?.hidden}`);

// Direction B: same window, same code, same `load` event -- and a frame the
// server refuses. Direction A passing is what makes this a discrimination
// rather than a harness that simply never reveals anything.
confirmAnswer = false;
await window.$(win2).close();
await settle(6);
await ezil.registry.launch('preview', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const win3 = q('.window[data-app="preview"]');
fireLoad(win3?.querySelector('.window-app-iframe'));
await settle(14);
const progressB = win3?.querySelector('[data-kind]');
push('\u{1f534} DIRECTION B - a REFUSED frame leaves the boot panel up',
    !! progressB && progressB.hidden === false,
    `hidden=${progressB?.hidden}`);
push('...and says the desktop is not answering, never "ready"',
    progressB?.getAttribute('data-kind') === 'failed',
    `data-kind=${progressB?.getAttribute('data-kind')}`);
confirmAnswer = true;

// Direction C: the deployment genuinely cannot serve a preview.
previewUrlMode = 'unavailable';
await window.$(win3).close();
await settle(6);
await ezil.registry.launch('preview', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const win4 = q('.window[data-app="preview"]');
push('an unavailable preview says so, honestly',
    /isn.t available yet/i.test(win4?.textContent ?? ''), (win4?.textContent ?? '').slice(0, 80));
push('🔴 …and NEVER navigates the frame to an invented URL',
    (win4?.querySelector('.window-app-iframe')?.getAttribute('src') ?? '') === 'about:blank',
    win4?.querySelector('.window-app-iframe')?.getAttribute('src') ?? '(none)');
previewUrlMode = 'ok';
await window.$(win4).close();
await settle(4);

// ═══════════════════════════════════════════════════════════════════════════
// 6. THE FOCUS CONTROL — transport, enum, and the tray geometry.
// ═══════════════════════════════════════════════════════════════════════════
const dctx = { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState };
await ezil.registry.launch('desktop', dctx);
await settle(8);
const drawer = q('.window[data-app="desktop"] .dashboard-app-drawer');
push('the desktop window has a control drawer', !! drawer);

const drawerBtns = Array.from(drawer?.querySelectorAll('.dashboard-app-drawer-btn') ?? []);
const focusBtn = drawer?.querySelector('.dashboard-app-drawer-focus-chromium');
push('🔴 the focus control IS drawn now that endpoints.focus exists', !! focusBtn);
push('🔴 there is NO "VS Code" control — code-server has no X window',
    ! drawerBtns.some(b => /vs ?code/i.test(b.getAttribute('aria-label') ?? '')),
    JSON.stringify(drawerBtns.map(b => b.getAttribute('aria-label'))));
push('nothing in the drawer targets the focus id `vscode`',
    ! drawer?.querySelector('[class*="focus-vscode"]'));

// 🔴 The geometry trap. `dashboard.css` sizes the tray for exactly two
// buttons and clips the rest; a button outside the clip is present in the DOM
// and invisible on screen, so a DOM-level check like the one above passes
// while the user sees nothing. `--btn-count` is what the width is derived
// from, so it must equal the real count.
const declaredCount = Number(drawer?.style.getPropertyValue('--btn-count'));
push('🔴 the tray width tracks the REAL button count (nothing is clipped)',
    declaredCount === drawerBtns.length && drawerBtns.length >= 4,
    `--btn-count=${declaredCount} vs ${drawerBtns.length} buttons`);
push('the Settings button is still in there too (guarantee #1 survives)',
    !! drawer?.querySelector('.dashboard-app-drawer-settings'));

// Click it for real.
const focusCallsBefore = calls.length;
click(focusBtn);
// 🔴 Wait out the REAL encoder-legibility floor (FOCUS_LEGIBLE_ESTIMATE_MS,
// 1.7s). Not padding: `switchApp` deliberately holds `switch_in_flight` for
// the whole of it so a second click cannot race the first, and a shorter wait
// here silently tests nothing but the guard. The first version of this file
// used 400ms and the "refused switch" check below passed for that reason
// rather than for the right one.
await waitMs(2_100);
await settle(8);
const focusCalls = calls.slice(focusCallsBefore).filter(c => c.url.startsWith(ENDPOINTS.focus));
push('🔴 clicking it POSTs to the REAL transport', focusCalls.length === 1,
    `${focusCalls.length} call(s) to ${ENDPOINTS.focus}`);
push('…with the computer id and the honest app id',
    focusCalls[0]?.method === 'POST'
    && focusCalls[0]?.body?.computerId === COMPUTER.id
    && focusCalls[0]?.body?.app === 'chromium',
    JSON.stringify(focusCalls[0]?.body));

// A refusal must be shown as a refusal, not swallowed into a success.
focusMode = 'refused';
const refuseBefore = calls.length;
click(drawer?.querySelector('.dashboard-app-drawer-focus-chromium'));
await settle(12);
push('a refused switch still reached the server',
    calls.slice(refuseBefore).some(c => c.url.startsWith(ENDPOINTS.focus)));
push('🔴 a refused switch does not claim success',
    ! /in front now/i.test(drawer?.querySelector('.dashboard-app-drawer-title')?.textContent ?? ''),
    drawer?.querySelector('.dashboard-app-drawer-title')?.textContent ?? '');
focusMode = 'ok';

// The other direction of the feature detection: no endpoint, no control.
const noFocusPayload = {
    ...PAYLOAD,
    desktopState: { ...PAYLOAD.desktopState, endpoints: { session: ENDPOINTS.session, desktop: ENDPOINTS.desktop } },
};
window.__EZIL_BOOT__ = noFocusPayload;
await window.$(q('.window[data-app="desktop"]')).close();
await settle(6);
await ezil.registry.launch('desktop', { ...dctx, desktopState: noFocusPayload.desktopState });
await settle(8);
const drawer2 = q('.window[data-app="desktop"] .dashboard-app-drawer');
push('🔴 no endpoints.focus -> no focus control at all (never a guessed URL)',
    !! drawer2 && ! drawer2.querySelector('.dashboard-app-drawer-focus-chromium'));
const count2 = Number(drawer2?.style.getPropertyValue('--btn-count'));
push('…and the tray narrows back to match',
    count2 === (drawer2?.querySelectorAll('.dashboard-app-drawer-btn').length ?? -1),
    `--btn-count=${count2}`);
window.__EZIL_BOOT__ = PAYLOAD;

// ═══════════════════════════════════════════════════════════════════════════
// 7. LOCAL CODE ONLY.
// ═══════════════════════════════════════════════════════════════════════════
// Every request must be same-origin EXCEPT the preview frame itself, which is
// a cross-origin iframe by design (the bridge host) and is never fetched by
// this code — it is only ever assigned to `iframe.src`.
const offOrigin = calls.filter(c => /^https?:\/\//.test(c.url) && ! c.url.startsWith('https://ezil.local'));
push('🔴 every request this shell MADE was same-origin', offOrigin.length === 0,
    JSON.stringify(offOrigin.map(c => c.url)));
push('no puter.* or socket.io traffic', ! calls.some(c => /puter\.com|socket\.io/.test(c.url)));
push('no uncaught page errors during the whole run', uncaught.length === 0,
    uncaught.slice(0, 2).join(' | '));

// ── report ──────────────────────────────────────────────────────────────────
let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
