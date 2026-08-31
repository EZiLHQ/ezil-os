// code-test.mjs — EZiL-authored. End-to-end harness for the Code window
// (Wave B / T7): registry entry -> Start menu -> real window -> freshly
// minted `codePreviewUrl` -> frame honesty, both directions.
//
// Run:  node shell/ezil/apps/code-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not source)
//
// ── Why it exists ───────────────────────────────────────────────────────────
// This repository's documented failure mode is right code with wrong
// COVERAGE. `preview-focus-test.mjs` (Wave A) found two textbook instances of
// it: a registry entry pointing at a placeholder, and a window reading a URL
// off a field the server never populated — both invisible to unit tests,
// visible only by actually clicking the icon and looking at what the window
// did. This file is that same harness, applied to Code, because this task's
// entire brief IS the same class of gap: "the Worker already returns
// `codePreviewUrl` … and then nothing opens it."
//
// ── Entry points exercised ───────────────────────────────────────────────────
//   1. `registry.resolve()` for the REAL server payload — is Code even in the
//      list a boot produces?
//   2. The Start menu — the only place a non-pinned app is reachable from.
//   3. `registry.launch('code')` — the programmatic path.
//   4. Close-and-reopen — the TTL case.
//   5. Frame honesty, both directions, against `/api/shell/code-preview-url`.
//   6. The "not available" degrade — never an invented URL.
//   7. Same-origin discipline — the code-preview host is a cross-origin
//      iframe by design and is only ever assigned to `iframe.src`, never
//      fetched by this shell.
//
// jsdom is not a browser: no layout, no real network, no cross-origin frames.
// This proves construction, wiring, ordering and which URL was used. It
// cannot prove pixels, and it cannot prove RUNTIME_SHIM never reaches
// code-server — that is a SERVER-side fact (`worker/src/preview-bridge.ts`),
// proven by `worker`'s own suite (`preview-bridge.test.ts`'s "NEVER injects
// RUNTIME_SHIM…", `route-auth.test.ts`'s equivalent) — see the wave-b-t7
// report for those exact runs.

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
// `apps` is `SHELL_APPS` verbatim, `endpoints` is `SHELL_API_ROUTES` verbatim
// (now including `codePreviewUrl`). 🔴 There is deliberately NO code-preview
// URL anywhere in here: check group 4 asserts the window cannot have got one
// from the payload even if a future change put one there.
const COMPUTER = {
    id: 'c-1', name: 'My computer', slot: 1,
    createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false,
};
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    codePreviewUrl: '/api/shell/code-preview-url',
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
/** What `/api/shell/code-preview-url` should answer next. */
let codePreviewUrlMode = 'ok';

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

    if ( u.startsWith(ENDPOINTS.codePreviewUrl) ) {
        if ( codePreviewUrlMode === 'unavailable' ) {
            return json({ ok: false, errorCode: 'code_preview_unavailable', error: 'no port' });
        }
        mintSeq++;
        // The real shape: a bridge-host bootstrap URL whose token is the
        // credential, on the `-code.` label (never `-app.`).
        const minted = `https://8443-guac-u1-c1-code.ezil.org/preview-bootstrap`
            + `?token=t=${Date.now()},v1=deadbeef&mint=${mintSeq}`;
        mintedUrls.push(minted);
        return json({ ok: true, codePreviewUrl: minted, expiresAt: Date.now() + 300_000 });
    }

    if ( u.startsWith(ENDPOINTS.previewUrl) ) {
        return json({ ok: true, appPreviewUrl: 'https://3002-guac-u1-c1-app.ezil.org/preview-bootstrap?token=t=1,v1=a', expiresAt: Date.now() + 300_000 });
    }

    if ( u.startsWith(ENDPOINTS.focus) ) {
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
 * 🔴 Fire the iframe's `load` event by hand — see `preview-focus-test.mjs`'s
 * identical helper for why this is the honest reproduction of a browser's
 * real behaviour (which fires `load` for a 500 error page exactly as for a
 * working one) rather than a cheat.
 */
const fireLoad = (iframe) => iframe?.dispatchEvent(new window.Event('load'));

await settle(20);
push('the real boot path mounted a desktop', !! q('.desktop'));

// ═══════════════════════════════════════════════════════════════════════════
// 1. REACHABILITY — is Code in the list a REAL boot produces?
// ═══════════════════════════════════════════════════════════════════════════
const resolvedIds = ezil.registry.resolve(PAYLOAD).map(a => a.id);
push('resolve() keeps Code when the server lists only "desktop"',
    resolvedIds.includes('code'), JSON.stringify(resolvedIds));
push('resolve() still opens the desktop first (boot.js uses apps[0])',
    resolvedIds[0] === 'desktop', resolvedIds[0]);

const codeDescriptor = ezil.registry.getApp('code');
push('the Code descriptor exists', !! codeDescriptor);
push('Code has its own icon, distinct from Preview and Settings',
    !! codeDescriptor?.icon
    && codeDescriptor.icon !== ezil.registry.getApp('settings')?.icon
    && codeDescriptor.icon !== ezil.registry.getApp('preview')?.icon);

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE START MENU — the only entry point a non-pinned app has.
// ═══════════════════════════════════════════════════════════════════════════
window.$('.taskbar-item[data-name="Start"]').trigger('click');
await settle(4);
const menuItems = qa('.context-menu .context-menu-item');
const codeItem = menuItems.find(el => (el.textContent ?? '').includes('Code'));
push('the Start menu lists Code', !! codeItem,
    JSON.stringify(menuItems.map(e => (e.textContent ?? '').trim())));

// ═══════════════════════════════════════════════════════════════════════════
// 3. THE WINDOW — opened from the Start menu, as a user reaches it.
// ═══════════════════════════════════════════════════════════════════════════
const callsBeforeOpen = calls.length;
click(codeItem);
await settle(20);

const win = q('.window[data-app="code"]');
push('🔴 clicking Code in the Start menu opens a Code window', !! win);
push('the Code window has an iframe to put code-server in',
    !! win?.querySelector('.window-app-iframe'));
push('exactly one Code window (single_instance)', qa('.window[data-app="code"]').length === 1);

// ═══════════════════════════════════════════════════════════════════════════
// 4. 🔴 THE 5-MINUTE TTL — minted AT WINDOW-OPEN, never stashed.
// ═══════════════════════════════════════════════════════════════════════════
const mintCalls = calls.slice(callsBeforeOpen).filter(c => c.url.startsWith(ENDPOINTS.codePreviewUrl));
push('🔴 opening the window REQUESTS a URL (it did not have one already)',
    mintCalls.length === 1, `${mintCalls.length} mint call(s) after the click`);
push('the mint is a POST carrying the computer id',
    mintCalls[0]?.method === 'POST' && mintCalls[0]?.body?.computerId === COMPUTER.id);
push('🔴 it minted from `/api/shell/code-preview-url`, NOT `/api/shell/preview-url`',
    ! calls.slice(callsBeforeOpen).some(c => c.url.startsWith(ENDPOINTS.previewUrl)));

const iframe = win?.querySelector('.window-app-iframe');
push('🔴 the iframe is showing the URL THAT call minted',
    iframe?.getAttribute('src') === mintedUrls[mintedUrls.length - 1],
    `${iframe?.getAttribute('src')}`);
push('the URL is the CODE bridge (`-code.`), never the app bridge (`-app.`)',
    /-code\.ezil\.org/.test(iframe?.getAttribute('src') ?? '')
    && ! /-app\.ezil\.org/.test(iframe?.getAttribute('src') ?? ''));
push('the URL is a bridge bootstrap URL with its token intact',
    /\/preview-bootstrap\?token=/.test(iframe?.getAttribute('src') ?? ''));

// The boot payload must not be a place a URL could come from.
push('🔴 no code-preview URL is reachable from the boot payload',
    ! JSON.stringify(PAYLOAD).includes('preview-bootstrap'));

// Close and reopen: the second open must mint AGAIN and must NOT reuse the
// first URL — the actual failure mode this TTL rule exists to prevent.
const firstUrl = iframe?.getAttribute('src');
await window.$(win).close();
await settle(6);
push('closing the window removes it', qa('.window[data-app="code"]').length === 0);

const callsBeforeReopen = calls.length;
await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const remintCalls = calls.slice(callsBeforeReopen).filter(c => c.url.startsWith(ENDPOINTS.codePreviewUrl));
const win2 = q('.window[data-app="code"]');
const iframe2 = win2?.querySelector('.window-app-iframe');
push('🔴 re-opening mints a FRESH URL rather than reusing the stale one',
    remintCalls.length === 1 && iframe2?.getAttribute('src') !== firstUrl,
    `${remintCalls.length} mint(s); src changed: ${iframe2?.getAttribute('src') !== firstUrl}`);
push('and the fresh URL is the one the SECOND call returned',
    iframe2?.getAttribute('src') === mintedUrls[mintedUrls.length - 1]);

// ═══════════════════════════════════════════════════════════════════════════
// 5. FRAME HONESTY, BOTH DIRECTIONS, inside the shell.
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 M16 (round 9), RE-INVESTIGATED wave-h/t23 — the previous version of this
// comment claimed jsdom "structurally CANNOT see that class of bug either
// way" and relied solely on `.hidden` — the IDL property, which the round-6
// regression defeats (an inline `style.display` set alongside `hidden = true`
// beats the UA's `[hidden] { display: none }` in a real cascade, so `.hidden`
// keeps reading `true` while the panel still paints). That claim was too
// broad. MEASURED (see wave-h-t23 report): jsdom's `getComputedStyle` DOES
// correctly resolve this exact cascade, inline-style-vs-attribute-selector
// included — a probe against the identical CSS shape (`.foo{display:flex}` +
// `.foo[hidden]{display:none}` + an inline `style.display='flex'` set
// alongside `hidden=true`) returns `flex`, matching a real browser. So
// `getComputedStyle(...).display` (added below, both success paths) is a
// REAL, mutation-proven assertion in jsdom, not a fast smoke test — proven by
// reintroducing `el_unavailable.style.display = 'flex'` in `code.js`, which
// flips these NEW checks red while leaving every pre-existing `.hidden` check
// green (see the wave-h-t23 report for the exact run).
//
// What jsdom genuinely cannot do, and this file does not attempt: `document.
// elementFromPoint` (real hit-testing against actual layout) is simply
// unimplemented in jsdom — `doc.elementFromPoint` is `undefined`, calling it
// throws `TypeError: ... is not a function` (verified). That half of the
// regression class — "is the failure panel ACTUALLY on top, pixel-wise" —
// stays exclusively `overlay-paint-browser-test.mjs`'s job (a real Chromium
// via Playwright), which already asserts exactly that ("a real hit-test at
// the window body's centre lands INSIDE THE IFRAME, not an overlay", 30/30)
// AND `stacking-browser-test.mjs`'s `checkContentPainted` — see the
// wave-g-t20 report for those runs. This file's jsdom checks below are now a
// real (not fake) computed-style assertion PLUS the wiring/ordering smoke
// test; the two browser suites remain the pixel/hit-test oracle, by design.
// Direction A: the browser fires `load`. That must NOT be what reveals the
// frame — only the server's answer may.
const progressA = win2?.querySelector('[data-kind]');
push('the boot panel is still up at the moment `load` fires',
    !! progressA && progressA.hidden === false, `hidden=${progressA?.hidden}`);
// 🔴 THE SIX SECONDS OF DEAD END. Between the mint resolving and the server
// answering `confirm=frame`, this window used to render
// `computeBootUiState({requestStatus:'success', frameConfirmed:false})` — a
// TERMINAL "Your desktop isn't answering" panel with a Retry button, over a
// window that was working. Measured in production: mint resolved 2:41:06,
// frame confirmed 2:41:12. Nobody had asked the origin anything in between.
// It must be a PROGRESS state, still visibly working.
push('\u{1f534} the panel between the mint and the answer is PROGRESS, not a failure',
    progressA?.getAttribute('data-kind') === 'progress',
    `data-kind=${progressA?.getAttribute('data-kind')}`);
// 🔴 MERGE NOTE (A × W3). This check used to read the phase list's
// `data-phase="connecting"`. W3 replaced this window's `BootProgress` with
// `AppSpinner` — Preview/Code deliberately ship NO phase list any more (see
// `boot-phases.ts`'s `BOOT_PHASES` doc comment), so that node cannot exist
// here by design, and asserting on it was testing a surface main removed.
//
// The claim is therefore re-expressed against what this window actually
// draws, and it is the SAME claim with the same mutation-proving force:
// reverting to `frameConfirmed: false` makes `kind` `failed`, which hides the
// ring and swaps the label to the failure copy. Both halves are asserted, so
// this cannot pass on a failure panel. The `connecting`-phase claim itself is
// unit-pinned in `boot-phases.test.ts`.
push('\u{1f534} ...and it is still visibly WORKING — ring up, app copy, not the dead end',
    win2?.querySelector('.ezil-app-spinner-ring')?.hidden === false
    && win2?.querySelector('.ezil-app-spinner-label')?.textContent === 'Opening Code…',
    `ring hidden=${win2?.querySelector('.ezil-app-spinner-ring')?.hidden}`
    + ` label=${win2?.querySelector('.ezil-app-spinner-label')?.textContent}`);
push('\u{1f534} ...and offers no Retry, because there is nothing to retry yet',
    win2?.querySelector('.ezil-boot-actions')?.hidden === true,
    `actions hidden=${win2?.querySelector('.ezil-boot-actions')?.hidden}`);
push('...and is actually painted that way, not just flagged (computed display is NOT none)',
    !! progressA && window.getComputedStyle(progressA).display !== 'none',
    `display=${progressA && window.getComputedStyle(progressA).display}`);
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
push('\u{1f534} DIRECTION A - and it is TRULY down: computed display is none, not just the `hidden` flag',
    !! progressA && window.getComputedStyle(progressA).display === 'none',
    `display=${progressA && window.getComputedStyle(progressA).display}`);

// Direction B: same window, same code, same `load` event — and a frame the
// server refuses. Direction A passing is what makes this a discrimination
// rather than a harness that simply never reveals anything.
confirmAnswer = false;
await window.$(win2).close();
await settle(6);
await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const win3 = q('.window[data-app="code"]');
fireLoad(win3?.querySelector('.window-app-iframe'));
await settle(14);
const progressB = win3?.querySelector('[data-kind]');
push('\u{1f534} DIRECTION B - a REFUSED frame leaves the boot panel up',
    !! progressB && progressB.hidden === false,
    `hidden=${progressB?.hidden}`);
push('\u{1f534} DIRECTION B - and it is TRULY up: computed display is NOT none',
    !! progressB && window.getComputedStyle(progressB).display !== 'none',
    `display=${progressB && window.getComputedStyle(progressB).display}`);
push('...and says the desktop is not answering, never "ready"',
    progressB?.getAttribute('data-kind') === 'failed',
    `data-kind=${progressB?.getAttribute('data-kind')}`);
confirmAnswer = true;

// Direction C: the deployment genuinely cannot serve code-server.
codePreviewUrlMode = 'unavailable';
await window.$(win3).close();
await settle(6);
await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await settle(20);
const win4 = q('.window[data-app="code"]');
push('an unreachable code-server says so, honestly',
    /isn.t reachable right now/i.test(win4?.textContent ?? ''), (win4?.textContent ?? '').slice(0, 90));
// 🔴 THE ASSERTION THAT EXISTS BECAUSE OF A REAL INCIDENT. The panel used to
// read "hasn't been turned on for this deployment" — a claim about
// CONFIGURATION — for an error code whose three producers are all RUNTIME
// conditions (port not exposed, worker says not exposed, origin
// underivable). A user installed an extension, the editor crashed, and the OS
// told them it had never been enabled for their account. They went looking for
// a settings problem that did not exist.
push('🔴 …and never claims this is a DEPLOYMENT or CONFIGURATION problem',
    ! /turned on for this deployment|not configured|isn.t available yet/i.test(win4?.textContent ?? ''),
    (win4?.textContent ?? '').slice(0, 120));
const elRetryC = win4?.querySelector('.ezil-code-unavailable-retry');
push('🔴 …and offers a Retry, because the most common cause is transient',
    !! elRetryC && window.getComputedStyle(elRetryC).display !== 'none',
    elRetryC ? `label="${elRetryC.textContent}"` : 'no retry control');
push('🔴 …and NEVER navigates the frame to an invented URL',
    (win4?.querySelector('.window-app-iframe')?.getAttribute('src') ?? '') === 'about:blank',
    win4?.querySelector('.window-app-iframe')?.getAttribute('src') ?? '(none)');
const elUnavailableC = win4?.querySelector('.ezil-code-unavailable');
push('\u{1f534} the "unavailable" panel is TRULY visible: computed display is NOT none',
    !! elUnavailableC && window.getComputedStyle(elUnavailableC).display !== 'none',
    `display=${elUnavailableC && window.getComputedStyle(elUnavailableC).display}`);
const progressC = win4?.querySelector('[data-kind]');
push('...and the boot panel underneath is TRULY hidden — no double-overlay',
    !! progressC && window.getComputedStyle(progressC).display === 'none',
    `display=${progressC && window.getComputedStyle(progressC).display}`);
codePreviewUrlMode = 'ok';
await window.$(win4).close();
await settle(4);

// ═══════════════════════════════════════════════════════════════════════════
// 6. LOCAL CODE ONLY.
// ═══════════════════════════════════════════════════════════════════════════
// Every request must be same-origin EXCEPT the code-preview frame itself,
// which is a cross-origin iframe by design (the bridge host) and is never
// fetched by this code — it is only ever assigned to `iframe.src`.
const offOrigin = calls.filter(c => /^https?:\/\//.test(c.url) && ! (new URL(c.url).hostname === 'ezil.local'));
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
