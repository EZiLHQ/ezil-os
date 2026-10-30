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
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../app/public/os');

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
let confirmAnswer; // Unknown until Direction A supplies an authenticated verdict.
/** What `/api/shell/code-preview-url` should answer next. */
let codePreviewUrlMode = 'ok';
/**
 * Scripted `confirm=frame` answers, consumed one per ask before `confirmAnswer`
 * applies: `{ status, body }` is the APP ROUTE's HTTP status and its JSON body
 * (whose own `status` is the ORIGIN's, as the server reports it).
 */
const confirmScript = [];

const mintedUrls = [];
/** What the cheap status probe (`GET /api/shell/desktop?computerId=`) answers. Section 7k flips it. */
let guacRunning = true;
/** `computer.progress` (tRPC) for the transition watch, only while section 7j sets it; otherwise unstubbed (500), as before. */
let progressAnswer = null;

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
            const scripted = confirmScript.shift();
            if ( scripted ) return json(scripted.body, scripted.status ?? 200);
            if ( confirmAnswer === undefined ) return json({ ok: false });
            return json({ ok: true, confirmed: confirmAnswer, status: confirmAnswer ? 200 : 500 });
        }
        if ( (opts.method ?? 'GET') === 'GET' ) return json({ ok: true, guacamoleRunning: guacRunning });
        return json({ ok: true, guacamoleUrl: 'https://8181-guac-u1-c1-nekodesktop.ezil.org/', frame: { confirmed: true } });
    }

    if ( progressAnswer && u.startsWith('/api/trpc/computer.progress') ) {
        return json({ result: { data: { json: progressAnswer } } });
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

push('Code is pinned in the dock, right after Browser',
    !! q('.taskbar-item[data-app="code"]')
    && (() => {
        const order = qa('.taskbar-item[data-app]').map(el => el.getAttribute('data-app')).filter(Boolean);
        return order.indexOf('code') === order.indexOf('desktop') + 1;
    })(),
    JSON.stringify(qa('.taskbar-item[data-app]').map(el => el.getAttribute('data-app'))));

// ═══════════════════════════════════════════════════════════════════════════
// 2. THE START MENU — Code is listed there too, like every resolved app.
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
// Round 3: the ring became the one opening surface's thin bar (plan §6.5).
push('\u{1f534} ...and it is still visibly WORKING — bar up, app copy, not the dead end',
    win2?.querySelector('.ezil-opening-bar')?.hidden === false
    && win2?.querySelector('.ezil-app-spinner-label')?.textContent === 'Opening Code…',
    `bar hidden=${win2?.querySelector('.ezil-opening-bar')?.hidden}`
    + ` label=${win2?.querySelector('.ezil-app-spinner-label')?.textContent}`);
push('\u{1f534} ...and offers no Retry, because there is nothing to retry yet',
    win2?.querySelector('.ezil-boot-actions')?.hidden === true,
    `actions hidden=${win2?.querySelector('.ezil-boot-actions')?.hidden}`);
push('...and is actually painted that way, not just flagged (computed display is NOT none)',
    !! progressA && window.getComputedStyle(progressA).display !== 'none',
    `display=${progressA && window.getComputedStyle(progressA).display}`);
push('the server was probed before `load`, without hiding an unconfirmed frame',
    calls.some(c => c.url.includes('confirm=frame')) && progressA?.hidden === false);

confirmAnswer = true;
fireLoad(iframe2);
await settle(30);

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
// 5a. 🔴 FOLLOW-UP r5 (ACCEPT-9a755827 e2e-standard A3). Code failed with "Your
//     desktop isn't answering" 0.8 s after the mint resolved: the first
//     `confirm=frame` answered an ORIGIN-side http_error (an auth/edge/tunnel hop
//     answering fast and wrong during the boot transition), and Code treated it
//     as terminal with ~44 s of its 45 s budget unused. Any origin http_error is
//     now recovered inside the budget; OUR refusals (the app route's own 401/403,
//     not_own_origin, provider_not_configured, bad_url) stay terminal, asked once.
// ═══════════════════════════════════════════════════════════════════════════
{
    const infos = [], errors = [];
    const realInfo = window.console.info.bind(window.console), realError = window.console.error.bind(window.console);
    window.console.info = (...a) => { infos.push(a.join(' ')); realInfo(...a); };
    window.console.error = (...a) => { errors.push(a.join(' ')); realError(...a); };
    const confirmAsks = (from) => calls.slice(from).filter(c => c.url.includes('confirm=frame')).length;
    const waitFor = async (cond, ms) => { for ( let t = 0; t < ms && ! cond(); t += 50 ) await tick(50); return cond(); };
    /** Open Code with a scripted confirmation sequence; every navigation loads at once, as a browser's does. */
    const openScripted = async (script) => {
        confirmScript.splice(0, confirmScript.length, ...script);
        const from = calls.length, infoFrom = infos.length, errorFrom = errors.length;
        const mintsBefore = mintedUrls.length;
        await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
        const w = q('.window[data-app="code"]');
        const frame = w?.querySelector('.window-app-iframe');
        await waitFor(() => mintedUrls.length > mintsBefore && frame?.getAttribute('src') === mintedUrls.at(-1), 3000);
        let navigations = 0;
        const mo = new window.MutationObserver(records => {
            const n = records.filter(r => r.attributeName === 'src').length;
            if ( n ) { navigations += n; window.setTimeout(() => fireLoad(frame), 0); }
        });
        mo.observe(frame, { attributes: true });
        fireLoad(frame); // the first (error) document loads
        return { w, frame, from, get navigations () { return navigations; }, stop: () => mo.disconnect(),
            confirmed: () => infos.slice(infoFrom).some(l => /code frame confirmed/.test(l)),
            notAnswering: () => errors.slice(errorFrom).filter(l => /code frame is not answering/.test(l)) };
    };
    const ORIGIN = status => ({ body: { ok: true, confirmed: false, reason: 'http_error', status } });
    const HEALTHY = { body: { ok: true, confirmed: true, status: 200 } };

    for ( const status of [401, 530, 404] ) {
        const h = await openScripted([ORIGIN(status), HEALTHY, HEALTHY]);
        const ok = await waitFor(h.confirmed, 8000);
        await settle(6);
        const panel = h.w?.querySelector('[data-kind]');
        push(`🔴 A3: origin http_error ${status} on the first ask, then healthy -> 'code frame confirmed'`,
            ok, `asks=${confirmAsks(h.from)} errors=${JSON.stringify(h.notAnswering())}`);
        push(`🔴 A3 (${status}): the iframe is re-navigated exactly once and the replacement reconfirmed`,
            h.navigations === 1 && confirmAsks(h.from) === 3, `navigations=${h.navigations} asks=${confirmAsks(h.from)}`);
        push(`🔴 A3 (${status}): no failed panel and no frame_not_answering`,
            !! panel && panel.hidden === true && panel.getAttribute('data-kind') !== 'failed' && h.notAnswering().length === 0,
            `hidden=${panel?.hidden} kind=${panel?.getAttribute('data-kind')} errors=${h.notAnswering().length}`);
        h.stop();
        confirmScript.length = 0;
        await window.$(h.w).close();
        await settle(4);
    }

    // Terminal, asked exactly once: our own app route refused (401/403), or the server's own refusals.
    const terminal = [
        ['app-route 401', { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in' } } }],
        ['app-route 403', { status: 403, body: { error: { code: 'FORBIDDEN', message: 'No' } } }],
        ['not_own_origin', { body: { ok: true, confirmed: false, reason: 'not_own_origin' } }],
        ['provider_not_configured', { body: { ok: true, confirmed: false, reason: 'provider_not_configured' } }],
        ['bad_url', { body: { ok: true, confirmed: false, reason: 'bad_url' } }],
    ];
    for ( const [name, answer] of terminal ) {
        const h = await openScripted([answer, HEALTHY, HEALTHY]);
        await waitFor(() => h.notAnswering().length > 0, 3000);
        await tick(2500); // longer than the first recovery backoffs: a retry would have asked by now
        const panel = h.w?.querySelector('[data-kind]');
        push(`${name} on /api/shell/desktop?confirm=frame stays terminal: "isn't answering", asked exactly once`,
            panel?.getAttribute('data-kind') === 'failed' && panel.hidden === false
            && confirmAsks(h.from) === 1 && h.navigations === 0 && ! h.confirmed(),
            `kind=${panel?.getAttribute('data-kind')} asks=${confirmAsks(h.from)} navigations=${h.navigations}`);
        h.stop();
        confirmScript.length = 0;
        await window.$(h.w).close();
        await settle(4);
    }
    window.console.info = realInfo;
    window.console.error = realError;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5b. 🔴 THE CODE WINDOW KEEPS ITS COMPUTER AWAKE WHILE SOMEONE IS WORKING IN IT.
//     Until 2026-10-04 only the desktop window reported presence, so a user
//     working only in Code was idle-stopped after 10 minutes and the editor
//     fell onto 410 STALE_PREVIEW_URL. Same presence rule as the desktop.
// ═══════════════════════════════════════════════════════════════════════════
{
    const HEARTBEAT_MS = 60_000; // shell/ezil/activity-heartbeat.js HEARTBEAT_INTERVAL_MS
    ENDPOINTS.activity = '/api/shell/activity';
    const ticks = [];
    const realSetInterval = window.setInterval;
    window.setInterval = (fn, ms, ...rest) => {
        if ( ms === HEARTBEAT_MS ) ticks.push(fn);
        return realSetInterval.call(window, fn, ms, ...rest);
    };
    let focused = true;
    Object.defineProperty(window.document, 'hasFocus', { value: () => focused, configurable: true, writable: true });
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(20);
    window.setInterval = realSetInterval;
    const hbWin = q('.window[data-app="code"]');
    push('the Code window registers exactly one presence heartbeat at 60s', ticks.length === 1, `${ticks.length} interval(s)`);
    const activity = () => calls.filter(c => c.url.startsWith(ENDPOINTS.activity));
    const before = activity().length;
    ticks[0]?.();
    await settle(4);
    const beats = activity().slice(before);
    push('🔴 visible + focused Code window -> a heartbeat for THIS computer with a small presence age',
        beats.length === 1 && beats[0].body?.computerId === COMPUTER.id
        && typeof beats[0].body?.lastInputAgoMs === 'number' && beats[0].body.lastInputAgoMs < 5_000,
        JSON.stringify(beats.map(b => b.body)));
    Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    ticks[0]?.();
    await settle(4);
    push('🔴 a hidden tab sends no heartbeat (it can never keep an abandoned computer alive)',
        activity().length === before + 1, `${activity().length - before} beat(s)`);
    Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
    window.document.dispatchEvent(new window.Event('visibilitychange'));
    await window.$(hbWin).close();
    await settle(4);
    ticks[0]?.();
    await settle(4);
    push('after the Code window closes, its heartbeat sends nothing',
        activity().length === before + 1, `${activity().length - before} beat(s)`);
    delete ENDPOINTS.activity;
    focused = true;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5b. A DESKTOP RESTART RE-MINTS THE CODE WINDOW OF THAT COMPUTER ONLY.
// ═══════════════════════════════════════════════════════════════════════════
{
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(20);
    const frame = () => q('.window[data-app="code"] .window-app-iframe');
    const before = mintedUrls.length, src = frame()?.getAttribute('src');
    push('a Code window is open before the restart', !! frame() && !! src);
    window.dispatchEvent(new window.CustomEvent('ezil:desktop-restarted', { detail: { computerId: 'some-other-computer' } }));
    await settle(10);
    push('a restart of ANOTHER computer does not re-mint Code', mintedUrls.length === before, `${mintedUrls.length - before}`);
    window.dispatchEvent(new window.CustomEvent('ezil:desktop-restarted', { detail: { computerId: COMPUTER.id } }));
    await settle(20);
    push('🔴 a restart of THIS computer re-mints Code exactly once', mintedUrls.length === before + 1, `${mintedUrls.length - before}`);
    push('the Code frame now shows the freshly minted URL',
        !! frame() && frame().getAttribute('src') === mintedUrls[mintedUrls.length - 1] && frame().getAttribute('src') !== src);
    await window.$(q('.window[data-app="code"]')).close();
    await settle(6);
    const closedMints = mintedUrls.length;
    window.dispatchEvent(new window.CustomEvent('ezil:desktop-restarted', { detail: { computerId: COMPUTER.id } }));
    await settle(10);
    push('a CLOSED Code window no longer listens for restarts', mintedUrls.length === closedMints, `${mintedUrls.length - closedMints}`);
}

// App-code lane A2 (2026-10-30): Settings → Troubleshoot no longer offers
// "Restart desktop", so the Settings -> session -> Code restart path this block
// used to drive no longer exists. What stays is the Code window's
// `ezil:desktop-restarted` listener (5b above proves it still re-mints on a
// direct dispatch). Here: with Code open, Troubleshoot renders no Restart
// desktop control (negative), still renders Restart computer (positive), and
// merely opening the pane re-mints nothing.
{
    ENDPOINTS.restart = '/api/shell/restart';
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(20);
    await ezil.registry.launch('settings');
    await settle(6);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="troubleshoot"]'));
    await settle(4);
    const pane = q('.window[data-app="settings"] .ezil-settings-pane[data-pane="troubleshoot"]');
    const before = mintedUrls.length;
    push('🔴 with Code open, Troubleshoot offers no Restart desktop control',
        !! pane && ! pane.querySelector('[data-action="restart"]') && ! /Restart desktop/i.test(pane.textContent ?? ''));
    push('…positive control: the same pane offers Restart computer',
        !! pane?.querySelector('[data-action="restart-computer"]') && /Restart computer/.test(pane?.textContent ?? ''));
    await settle(6);
    push('opening Troubleshoot re-mints nothing in the open Code window', mintedUrls.length === before, `${mintedUrls.length - before}`);
    await window.$(q('.window[data-app="settings"]')).close();
    await window.$(q('.window[data-app="code"]')).close();
    await settle(6);
    delete ENDPOINTS.restart;
}

// ═══════════════════════════════════════════════════════════════════════════
// 7. FULL VIEW, THE TOP BAR, RELAUNCH, AND "RECONNECTING…" / "COMPUTER
//    STOPPED" (app-code lane A2, 2026-10-30; docs/APP-CODE-FULL-VIEW.md).
//    jsdom: classes, attributes, inline geometry (what "restore the previous
//    bounds" restores), computed `display` from the built CSS, events and
//    storage. Pixels and hit-testing are os-chrome / feedback-browser's job.
// ═══════════════════════════════════════════════════════════════════════════
{
    const VIEW_KEY = 'ezil-os:view.code';
    const store = window.sessionStorage;
    const views = [];
    const on_view = (e) => views.push(e.detail);
    window.addEventListener('ezil:app-view-changed', on_view);
    let fullscreen_calls = 0;
    window.Element.prototype.requestFullscreen = function () { fullscreen_calls++; return Promise.resolve(); };
    const codeWin = () => q('.window[data-app="code"]');
    const shown = (el) => !! el && window.getComputedStyle(el).display !== 'none';
    const taskbarShown = () => shown(q('.taskbar'));
    const geom = (el) => JSON.stringify({ width: el?.style.width, height: el?.style.height, top: el?.style.top, left: el?.style.left });
    const isFull = (el) => !! el?.classList.contains('ezil-fullbleed') && el.getAttribute('data-is_fullpage') === '1'
        && ! taskbarShown() && ! shown(el.querySelector(':scope > .window-head')) && shown(el.querySelector(':scope > .ezil-full-view-bar'));
    const isWindowed = (el) => !! el && ! el.classList.contains('ezil-fullbleed') && el.getAttribute('data-is_fullpage') !== '1'
        && taskbarShown() && shown(el.querySelector(':scope > .window-head')) && ! shown(el.querySelector(':scope > .ezil-full-view-bar'));
    const dblclick = (el) => el?.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    const barBtn = (el, action) => el?.querySelector(`:scope > .ezil-full-view-bar [data-action="${action}"]`);
    const closeCode = async () => { if ( codeWin() ) { await window.$(codeWin()).close(); await settle(8); } };
    const launchCode = async (extra = {}) => {
        await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState, ...extra });
        await settle(20);
        return codeWin();
    };

    await closeCode();
    // The Browser opened by an earlier section is set aside, so the taskbar
    // checks below are about Code alone (two-window full view: full-view-test).
    for ( const el of qa('.window[data-app="desktop"]') ) { await window.$(el).close(); }
    await settle(8);
    store.removeItem(VIEW_KEY);

    // 7a. A launch with no view and nothing remembered (the dock) -> windowed.
    const w = await launchCode();
    push('7a 🔴 a launch with no view and nothing remembered opens WINDOWED (taskbar, head, no top bar)', isWindowed(w),
        JSON.stringify({ cls: w?.className, fp: w?.getAttribute('data-is_fullpage'), taskbar: taskbarShown() }));
    push('7a …at the windowed size, 980x680', w?.style.width === '980px' && w?.style.height === '680px', geom(w));
    push('7a the window is a full-view host; its top bar and drawer exist and are hidden while windowed',
        w?.classList.contains('ezil-full-view-host') && !! w.querySelector(':scope > .ezil-full-view-bar')
        && !! w.querySelector(':scope > .ezil-app-drawer') && ! shown(w.querySelector(':scope > .ezil-app-drawer')));
    push('7a nothing is announced or remembered by an open', views.length === 0 && store.getItem(VIEW_KEY) === null, JSON.stringify(views));
    const windowed = geom(w);

    // 7b. The green button -> full view.
    click(w.querySelector(':scope > .window-head .window-scale-btn'));
    await settle(4);
    push('7b 🔴 the green button enters full view (class, data-is_fullpage, no taskbar, no head, top bar shown)', isFull(w),
        JSON.stringify({ cls: w.className, taskbar: taskbarShown() }));
    push('7b the window takes the viewport', w.style.width === '100%' && w.style.height === '100%', geom(w));
    push('7b the top bar carries the title and minimise / restore / close, in that order',
        w.querySelector('.ezil-full-view-title')?.textContent === 'Code'
        && [...w.querySelectorAll(':scope > .ezil-full-view-bar button')].map(b => b.dataset.action).join() === 'minimize,restore,close'
        && [...w.querySelectorAll(':scope > .ezil-full-view-bar button')].every(b => b.type === 'button' && b.getAttribute('aria-label')));
    push('7b the drawer is shown in full view and sits before the bar in tab order',
        shown(w.querySelector(':scope > .ezil-app-drawer'))
        && w.querySelector(':scope > .ezil-app-drawer').nextElementSibling === w.querySelector(':scope > .ezil-full-view-bar')
        && w.querySelector(':scope > .ezil-full-view-bar').nextElementSibling === w.querySelector(':scope > .window-body'));
    push('7b …announced once as {appId:"code", view:"full"} and remembered as the user\'s choice',
        views.length === 1 && views[0].appId === 'code' && views[0].view === 'full' && store.getItem(VIEW_KEY) === 'full', JSON.stringify(views));
    push('7b 🔴 never the browser Fullscreen API (and full view DID engage)', fullscreen_calls === 0 && isFull(w));
    push('7b upstream maximise did not also run', w.getAttribute('data-is_maximized') !== '1');

    // 7c. The same control again -> the window, at its previous bounds.
    window.scale_window(w);
    await settle(4);
    push('7c 🔴 the green button toggles back to the window at the EXACT previous bounds', isWindowed(w) && geom(w) === windowed, `${geom(w)} vs ${windowed}`);
    push('7c …announced {view:"window"} and remembered', views.length === 2 && views[1].view === 'window' && store.getItem(VIEW_KEY) === 'window');

    // 7d. Title double-click -> full; a double-click on the top bar -> window.
    dblclick(w.querySelector(':scope > .window-head'));
    await settle(4);
    push('7d a title double-click enters full view', isFull(w));
    dblclick(w.querySelector('.ezil-full-view-title'));
    await settle(4);
    push('7d a double-click on the top bar returns to the window, previous bounds', isWindowed(w) && geom(w) === windowed);
    dblclick(w.querySelector(':scope > .window-head'));
    await settle(4);
    dblclick(barBtn(w, 'minimize'));
    await settle(4);
    push('7d a double-click ON a bar button is not a bar double-click', isFull(w));

    // 7e. The bar's restore and minimise; back from the taskbar; the drawer's restore.
    click(barBtn(w, 'restore'));
    await settle(4);
    push('7e the top bar\'s restore returns to the window at the previous bounds', isWindowed(w) && geom(w) === windowed);
    window.scale_window(w);
    await settle(4);
    click(barBtn(w, 'minimize'));
    await settle(8);
    push('7e the top bar\'s minimise hides the window and gives the taskbar back',
        ['true', '1'].includes(w.getAttribute('data-is_minimized')) && taskbarShown() && ! w.classList.contains('ezil-fullbleed'));
    window.$(w).showWindow();
    await settle(24);
    push('7e 🔴 back from the taskbar it is in full view again (the desire outlived the minimise)', isFull(w));
    click(w.querySelector('.ezil-app-drawer .dashboard-app-drawer-restore'));
    await settle(4);
    push('7e the drawer\'s "Restore window" returns to the window too', isWindowed(w) && geom(w) === windowed);
    window.scale_window(w);
    await settle(4);
    click(w.querySelector('.ezil-app-drawer .dashboard-app-drawer-minimize'));
    await settle(8);
    push('7e the drawer\'s "Show desktop" minimises with the taskbar back', ['true', '1'].includes(w.getAttribute('data-is_minimized')) && taskbarShown());
    window.$(w).showWindow();
    await settle(24);
    window.scale_window(w);
    await settle(4);
    push('setup: windowed again before the relaunch checks', isWindowed(w) && geom(w) === windowed);

    // 7f. The single-instance relaunch hook (contract item 4).
    views.length = 0;
    // A value no relaunch could write, so "nothing remembered" holds whichever
    // view a relaunch applies (7b/7c are the positive control: gestures write it).
    const remembered = 'sentinel';
    store.setItem(VIEW_KEY, remembered);
    push('7f the window exposes _ezil_relaunch', typeof w._ezil_relaunch === 'function');
    w._ezil_relaunch({ view: 'full', project: '00000000-0000-4000-8000-000000000000', repo: 'r', anything: 1 });
    await settle(2);
    push('7f 🔴 relaunch with view "full" enters full view; the other keys are ignored', isFull(w) && views.map(v => v.view).join() === 'full');
    push('7f 🔴 …and a relaunch to "full" is not remembered', store.getItem(VIEW_KEY) === remembered, String(store.getItem(VIEW_KEY)));
    let threw = null;
    try {
        w._ezil_relaunch({ view: 'bogus' }); w._ezil_relaunch({}); w._ezil_relaunch(undefined);
        w._ezil_relaunch({ project: 'p' }); w._ezil_relaunch({ view: 'FULL' });
    } catch ( e ) { threw = e; }
    await settle(2);
    push('7f relaunch with no view or an unknown one changes nothing and never throws', ! threw && isFull(w) && views.length === 1, String(threw));
    w._ezil_relaunch({ view: 'window' });
    await settle(2);
    push('7f relaunch with view "window" restores the window at its previous bounds',
        isWindowed(w) && geom(w) === windowed && views.map(v => v.view).join() === 'full,window');
    w._ezil_relaunch({ view: 'window' });
    push('7f a relaunch to the view it already has announces nothing', views.length === 2);
    // The same unknown values again, now WINDOWED: none of them may read as "full".
    threw = null;
    try {
        for ( const c of [{ view: 'bogus' }, { view: 'FULL' }, { view: 'Full' }, { view: true }, { view: 1 }, {}, undefined, { project: 'p' }] ) {
            w._ezil_relaunch(c);
        }
    } catch ( e ) { threw = e; }
    await settle(2);
    push('7f 🔴 while windowed, no view or an unknown one changes nothing and never throws',
        ! threw && isWindowed(w) && geom(w) === windowed && views.length === 2, `${String(threw)} ${geom(w)} ${JSON.stringify(views)}`);
    push('7f a relaunch is not the user\'s explicit choice: nothing remembered', store.getItem(VIEW_KEY) === remembered);
    w._ezil_relaunch({ view: 'full' });
    await settle(2);
    push('7f positive control: the same windowed state still enters full view on view "full"',
        isFull(w) && views.map(v => v.view).join() === 'full,window,full');
    w._ezil_relaunch({ view: 'window' });
    await settle(2);
    push('setup: windowed again after the relaunch checks', isWindowed(w) && geom(w) === windowed);

    // 7g. The title setter writes TEXT.
    const evil = '<img src=x onerror="window.__ezilTitleInjected=1">';
    w._ezil_set_title(evil);
    await settle(2);
    push('7g 🔴 _ezil_set_title writes text: bar, head and drawer show the string verbatim and contain no element',
        w.querySelector('.ezil-full-view-title').textContent === evil
        && w.querySelector(':scope > .window-head .window-head-title').textContent === evil
        && w.querySelector('.dashboard-app-drawer-title').textContent === evil
        && ! w.querySelector('.ezil-full-view-title *, .window-head-title *, .dashboard-app-drawer-title *')
        && ! window.__ezilTitleInjected);
    w._ezil_set_title('  ');
    push('7g an empty title falls back to the app\'s name', w.querySelector('.ezil-full-view-title').textContent === 'Code'
        && w.querySelector(':scope > .window-head .window-head-title').textContent === 'Code');

    // 7h. A launch with view "full" (the /app/code route).
    await closeCode();
    store.removeItem(VIEW_KEY);
    views.length = 0;
    const r = await launchCode({ view: 'full' });
    push('7h 🔴 a launch with view "full" opens IN full view', isFull(r));
    push('7h …without announcing it (the router pushes its entry after the launch) or remembering it',
        views.length === 0 && store.getItem(VIEW_KEY) === null, JSON.stringify(views));
    window.scale_window(r);
    await settle(4);
    push('7h leaving it lands on the 980x680 window the Code window was created as',
        isWindowed(r) && r.style.width === '980px' && r.style.height === '680px', geom(r));
    window.scale_window(r);
    await settle(4);
    await closeCode();
    push('7h closing a Code window in full view gives the taskbar back', ! codeWin() && taskbarShown());

    // 7i. The dock, after an explicit choice.
    push('setup: the user\'s last explicit choice was full', store.getItem(VIEW_KEY) === 'full');
    const d = await launchCode();
    push('7i 🔴 a launch with no view opens in full view when the user\'s last explicit choice in this tab was full', isFull(d));
    window.scale_window(d);
    await settle(4);
    await closeCode();
    const d2 = await launchCode();
    push('7i …and windowed once their last explicit choice was the window', isWindowed(d2) && store.getItem(VIEW_KEY) === 'window');
    const d3 = await launchCode({ view: 'window' });
    push('7i a relaunch through the registry keeps the single window', d3 === d2 && qa('.window[data-app="code"]').length === 1);
    await closeCode();
    store.setItem(VIEW_KEY, 'full');
    const d4 = await launchCode({ view: 'window' });
    push('7i an explicit view "window" wins over a remembered "full"', isWindowed(d4));

    // 7j. "Reconnecting…" while a restart/switch transition is in flight.
    {
        const realTimeout = window.setTimeout;
        // `observeComputerProgress` polls every 5s; the watch is the real one, only faster.
        window.setTimeout = (fn, ms, ...a) => realTimeout.call(window, fn, ms === 5000 ? 20 : ms, ...a);
        const state = () => d4.querySelector('.ezil-code-state');
        push('7j the state cover exists and is hidden while the editor is up', !! state() && ! shown(state()) && state().hidden);
        const before = mintedUrls.length;
        window.dispatchEvent(new window.CustomEvent('ezil:computer-transition', { detail: { computerId: 'some-other-computer', transitionId: 't-x' } }));
        await settle(4);
        push('7j a transition of ANOTHER computer shows nothing', ! shown(state()));
        progressAnswer = { version: 2, computerId: COMPUTER.id, operation: 'opening', stage: 'switching', active: true,
            transition: { transitionId: 't-1', kind: 'switch', phase: 'stopping', current: 'std-2', target: 'cmp-4' } };
        window.dispatchEvent(new window.CustomEvent('ezil:computer-transition', { detail: { computerId: COMPUTER.id, transitionId: 't-1' } }));
        await settle(6);
        push('7j 🔴 a transition of THIS computer covers the editor with "Reconnecting…"',
            shown(state()) && state().dataset.state === 'reconnecting' && /Reconnecting…/.test(state().textContent)
            && state().getAttribute('role') === 'status', state()?.textContent);
        push('7j …with no Start button (nothing to start: the server is doing it)', ! shown(state().querySelector('.ezil-code-state-start')));
        push('7j nothing is re-minted while the transition is in flight', mintedUrls.length === before, `${mintedUrls.length - before}`);
        progressAnswer = { version: 2, computerId: COMPUTER.id, operation: 'none', stage: 'running', active: false,
            transition: { transitionId: 't-1', kind: 'switch', phase: 'done', current: 'std-2', target: 'cmp-4' } };
        for ( let i = 0; i < 40 && mintedUrls.length === before; i++ ) await tick(25);
        await settle(10);
        push('7j 🔴 when the server settles it, the same Code window re-mints exactly once and the cover goes',
            mintedUrls.length === before + 1 && ! shown(state())
            && d4.querySelector('.window-app-iframe').getAttribute('src') === mintedUrls[mintedUrls.length - 1], `${mintedUrls.length - before}`);
        // A watch that never settles (the server keeps reporting the transition
        // in flight) gives up after its poll budget without calling back. The
        // cover must not then stay up forever with nothing to press.
        const realInterval = window.setInterval;
        window.setInterval = (fn, ms, ...a) => realInterval.call(window, fn, ms === 5000 ? 20 : ms, ...a);
        progressAnswer = { version: 2, computerId: COMPUTER.id, operation: 'opening', stage: 'switching', active: true,
            transition: { transitionId: 't-2', kind: 'restart', phase: 'stopping', current: 'std-2', target: 'std-2' } };
        const before2 = mintedUrls.length;
        window.dispatchEvent(new window.CustomEvent('ezil:computer-transition', { detail: { computerId: COMPUTER.id, transitionId: 't-2' } }));
        await settle(4);
        push('setup: a second transition shows "Reconnecting…"', shown(state()) && state().dataset.state === 'reconnecting');
        for ( let i = 0; i < 600 && state().dataset.state === 'reconnecting'; i++ ) await tick(25);
        push('7j 🔴 a transition watch that gives up without settling turns the cover into "Computer stopped" with Start (never a dead end)',
            shown(state()) && state().dataset.state === 'stopped' && shown(state().querySelector('.ezil-code-state-start')),
            state()?.dataset.state);
        push('7j …and nothing was started or re-minted on its own', mintedUrls.length === before2, `${mintedUrls.length - before2}`);
        window.setInterval = realInterval;
        click(state().querySelector('.ezil-code-state-start'));
        for ( let i = 0; i < 40 && mintedUrls.length === before2; i++ ) await tick(25);
        await settle(10);
        push('setup: Start re-minted and the cover is gone before 7k', mintedUrls.length === before2 + 1 && ! shown(state()));
        progressAnswer = null;
        window.setTimeout = realTimeout;
    }

    // 7k. "Computer stopped" when the return-from-away check finds it stopped.
    {
        const state = () => d4.querySelector('.ezil-code-state');
        const realNow = window.Date.now;
        let skew = 0;
        window.Date.now = () => realNow.call(window.Date) + skew;
        const realInterval = window.setInterval;
        // The stopped state's own probe runs every 10s; faster here, same code.
        window.setInterval = (fn, ms, ...a) => realInterval.call(window, fn, ms === 10_000 ? 30 : ms, ...a);
        const away = async (minutes) => {
            Object.defineProperty(window.document, 'visibilityState', { value: 'hidden', configurable: true });
            window.document.dispatchEvent(new window.Event('visibilitychange'));
            skew += minutes * 60_000;
            Object.defineProperty(window.document, 'visibilityState', { value: 'visible', configurable: true });
            window.document.dispatchEvent(new window.Event('visibilitychange'));
            await settle(8);
        };
        guacRunning = true;
        const before = mintedUrls.length;
        await away(6);
        push('7k positive control: back after 6 min to a RUNNING computer shows no cover and re-mints nothing',
            ! shown(state()) && mintedUrls.length === before);
        guacRunning = false;
        await away(6);
        push('7k 🔴 back after 6 min to a STOPPED computer: "Computer stopped" covers the editor',
            shown(state()) && state().dataset.state === 'stopped' && /Computer stopped/.test(state().textContent), state()?.textContent);
        push('7k …with a Start button, and nothing started on its own (no mint, no wake)',
            shown(state().querySelector('.ezil-code-state-start')) && state().querySelector('.ezil-code-state-start').textContent === 'Start computer'
            && mintedUrls.length === before, `${mintedUrls.length - before}`);
        const probes = () => calls.filter(c => c.method === 'GET' && c.url.startsWith(`${ENDPOINTS.desktop}?computerId=`)).length;
        const probed = probes();
        await settle(6);
        push('7k while it stays stopped the cheap probe keeps asking and still starts nothing',
            shown(state()) && probes() > probed && mintedUrls.length === before, `${probes() - probed} probe(s)`);
        click(state().querySelector('.ezil-code-state-start'));
        for ( let i = 0; i < 40 && mintedUrls.length === before; i++ ) await tick(25);
        await settle(10);
        push('7k 🔴 Start re-mints the same Code window once (the existing mint path) and the cover goes',
            mintedUrls.length === before + 1 && ! shown(state())
            && d4.querySelector('.window-app-iframe').getAttribute('src') === mintedUrls[mintedUrls.length - 1], `${mintedUrls.length - before}`);
        const before2 = mintedUrls.length;
        await away(6);
        push('setup: stopped again', shown(state()) && state().dataset.state === 'stopped' && mintedUrls.length === before2);
        guacRunning = true;
        for ( let i = 0; i < 40 && mintedUrls.length === before2; i++ ) await tick(25);
        await settle(10);
        push('7k 🔴 when the computer is running again (started elsewhere), it re-mints by itself, once',
            mintedUrls.length === before2 + 1 && ! shown(state()), `${mintedUrls.length - before2}`);
        push('7k no request in this section ever asked to stop, restart or start a computer by any other route',
            ! calls.some(c => /\/api\/shell\/(stop|restart|start)/.test(c.url)));
        window.Date.now = realNow;
        window.setInterval = realInterval;
    }

    window.removeEventListener('ezil:app-view-changed', on_view);
    await closeCode();
}

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
