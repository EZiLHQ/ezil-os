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

// The real Settings -> session -> Code path with a deferred restart response.
// The app tests supply the runtime transition; here the built shell must wait for
// that HTTP completion before minting, and must ignore it if Code closed meanwhile.
{
    ENDPOINTS.restart = '/api/shell/restart';
    const originalFetch = window.fetch;
    let finishRestart;
    let restartRequests = 0;
    window.fetch = async (url, opts) => {
        if (String(url) !== ENDPOINTS.restart) return originalFetch(url, opts);
        restartRequests++;
        return new Promise(resolve => { finishRestart = resolve; });
    };
    await ezil.registry.launch('desktop', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(6);
    await ezil.registry.launch('settings');
    await settle(6);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="troubleshoot"]'));
    await settle(4);
    const startRestart = async () => {
        click(q('.window[data-app="settings"] [data-action="restart"]'));
        await settle(2);
        click(qa('button').find(b => b.textContent.trim() === 'Restart'));
        await settle(4);
    };
    const completeRestart = () => finishRestart?.({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(20);
    let before = mintedUrls.length;
    const oldSrc = q('.window[data-app="code"] .window-app-iframe')?.getAttribute('src');
    await startRestart();
    push('Settings dispatched one restart while Code is open', restartRequests === 1);
    push('Code does not re-mint while the AWS restart response is pending', mintedUrls.length === before);
    push('the pending restart has not assigned another Code frame URL',
        q('.window[data-app="code"] .window-app-iframe')?.getAttribute('src') === oldSrc);
    completeRestart();
    await settle(20);
    push('HTTP restart completion re-mints Code exactly once through the real Settings handler', mintedUrls.length === before + 1);

    await startRestart();
    push('a second restart is pending before Code closes', restartRequests === 2);
    await window.$(q('.window[data-app="code"]')).close();
    await settle(4);
    before = mintedUrls.length;
    completeRestart();
    await settle(10);
    push('closing Code during the restart prevents any late re-mint', mintedUrls.length === before && !q('.window[data-app="code"]'));
    await window.$(q('.window[data-app="settings"]')).close();
    window.fetch = originalFetch;
    delete ENDPOINTS.restart;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5c. 🔴 ROUND 6 (R3-1/R3-2/R3-4, live 10-30 05:42-05:44Z). Code opened on a
//     RUNNING AWS computer read "Almost there — waiting for Code to connect ·
//     usually about 4 min" with the bar parked at 85 %, its mint was answered
//     "starting" for two minutes, and the wake deadline would have ended it in
//     "This is taking too long — Starting your computer…" over a running computer.
//     Now it is a connect, and the same give-up (the existing bound) says Code
//     is not reachable, with Try again. The clock is skewed, not waited.
// ═══════════════════════════════════════════════════════════════════════════
{
    const originalFetch = window.fetch, realNow = window.Date.now;
    let skew = 0, progressAnswer = null, mintAsks = 0, progressFail = false, progressAsks = 0;
    window.Date.now = () => realNow.call(window.Date) + skew;
    window.fetch = async (url, opts) => {
        const u = String(url);
        if ( u.includes('/api/trpc/computer.progress') ) progressAsks++;
        if ( u.includes('/api/trpc/computer.progress') && progressFail ) throw new Error('network');
        if ( u.includes('/api/trpc/computer.progress') && progressAnswer ) {
            return { ok: true, status: 200, json: async () => ({ result: { data: { json: progressAnswer } } }) };
        }
        if ( u.startsWith(ENDPOINTS.codePreviewUrl) ) {
            mintAsks++;
            return { ok: true, status: 200, json: async () => ({ ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting',
                provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' }) };
        }
        return originalFetch(url, opts);
    };
    const waitFor = async (cond, ms) => { for ( let t = 0; t < ms && ! cond(); t += 50 ) await tick(50); return cond(); };
    /** The tab hidden or shown: the progress observer drops its answer on hide and asks at once on show. */
    const setHidden = hidden => {
        Object.defineProperty(doc, 'hidden', { configurable: true, get: () => hidden });
        doc.dispatchEvent(new window.Event('visibilitychange'));
    };
    const RUNNING = { version: 2, computerId: COMPUTER.id, operation: 'none', stage: 'running', recordedStage: 'running', active: false,
        durable: false, openingStartedAt: null, path: null, milestones: [], expectedSeconds: 30 };
    const open = async (progress) => {
        progressAnswer = progress; skew = 0; mintAsks = 0;
        await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
        const w = q('.window[data-app="code"]');
        const spinner = w?.querySelector('.ezil-app-spinner');
        const text = sel => spinner?.querySelector(sel)?.textContent ?? '';
        return { w, spinner, status: () => text('.ezil-opening-status'), meta: () => text('.ezil-opening-meta'),
            title: () => text('.ezil-opening-title'), kind: () => spinner?.getAttribute('data-kind'),
            percent: () => Number(spinner?.querySelector('.ezil-opening-bar')?.dataset.percent) };
    };

    const r = await open(RUNNING);
    await waitFor(() => r.status() === 'Connecting to Code…', 3000);
    push('🔴 R3-1: Code on a running computer says "Connecting to Code…", never "Almost there"',
        r.status() === 'Connecting to Code…' && ! /Almost there/.test(r.spinner?.textContent ?? ''), r.status());
    skew = 5_000;
    await waitFor(() => r.meta().startsWith('0:05'), 2000);
    push('🔴 R3-4: "0:05 · usually under a minute", never "usually about 4 min"',
        r.meta() === '0:05 · usually under a minute' && ! /about 4 min/.test(r.spinner?.textContent ?? ''), r.meta());
    push('🔴 R3-4: the bar is not parked at the 85% open floor', r.percent() > 85 && r.percent() < 100, String(r.percent()));
    push('the mint is still asking (sandbox_starting is a wait, not a failure)', mintAsks >= 1 && r.kind() === 'progress', `${mintAsks} ${r.kind()}`);
    // The wake loop's existing deadline (WAKE_DEADLINE_MS) passes on its next ask.
    skew = 216_000;
    await waitFor(() => r.kind() === 'failed', 6000);
    const retry = r.spinner?.querySelector('.ezil-boot-retry');
    push('🔴 R3-2: the give-up on a running computer reads "Code isn\'t reachable right now", with Try again',
        r.kind() === 'failed' && r.title() === "Code isn't reachable right now" && !! retry && retry.hidden === false,
        `${r.kind()} "${r.title()}" retry=${retry && ! retry.hidden}`);
    push('🔴 ...and never the "Starting your computer" timeout copy over a running computer',
        ! /This is taking too long|Starting your computer/.test(r.spinner?.textContent ?? ''), r.status());
    push('...its body names Code and the running computer', /Code/.test(r.status()) && /running/.test(r.status()), r.status());
    await window.$(r.w).close();
    await settle(4);

    // Not observed running (no AWS observation): the existing timeout copy is unchanged.
    const n = await open(null);
    await waitFor(() => mintAsks >= 1, 3000);
    skew = 216_000;
    await waitFor(() => n.kind() === 'failed', 6000);
    push('without a running observation the give-up keeps the existing timeout copy',
        n.kind() === 'failed' && n.title() === 'This is taking too long', `${n.kind()} "${n.title()}"`);
    // A running answer that arrives only after that give-up (the tab was hidden, the polls failed) corrects it:
    // the computer is running now, so the failure is Code's. Showing the tab again asks at once.
    progressAnswer = RUNNING;
    const asked = progressAsks;
    setHidden(true); setHidden(false);
    await waitFor(() => progressAsks > asked && n.title() === "Code isn't reachable right now", 2000);
    push('🔴 R3-2: a running answer after a generic give-up turns it into "Code isn\'t reachable right now", with Try again',
        n.kind() === 'failed' && n.title() === "Code isn't reachable right now"
        && n.spinner?.querySelector('.ezil-boot-retry')?.hidden === false, `${n.kind()} "${n.title()}" asks=${progressAsks - asked}`);
    await window.$(n.w).close();
    await settle(4);

    // 🔴 The give-up decides from this attempt's last answer, not the live one. A hidden tab (and a failed or
    // slow poll) clears the live answer; the tab shown again repaints the state that was decided then.
    // (Round 6 review probe: hidden across the give-up read "This is taking too long", and kept it.)
    const h = await open(RUNNING);
    await waitFor(() => h.status() === 'Connecting to Code…', 3000);
    setHidden(true);
    await waitFor(() => h.spinner?.dataset.progress === 'unavailable', 1000);
    skew = 216_000;
    await waitFor(() => h.kind() === 'failed', 6000);
    push('🔴 R3-2: hidden across the give-up (no live answer) still reads "Code isn\'t reachable right now"',
        h.kind() === 'failed' && h.title() === "Code isn't reachable right now" && h.spinner?.dataset.progress === 'unavailable',
        `${h.kind()} "${h.title()}" progress=${h.spinner?.dataset.progress}`);
    setHidden(false);
    await waitFor(() => h.spinner?.dataset.progress === 'observed', 2000);
    await settle(4);
    push('🔴 ...and the tab shown again keeps it',
        h.spinner?.dataset.progress === 'observed' && h.title() === "Code isn't reachable right now"
        && ! /This is taking too long|Starting your computer/.test(h.spinner?.textContent ?? ''), `"${h.title()}" ${h.status()}`);
    await window.$(h.w).close();
    await settle(4);

    // A progress poll that fails just before the give-up (network, its 15 s timeout): the same decision.
    const f = await open(RUNNING);
    await waitFor(() => f.status() === 'Connecting to Code…', 3000);
    progressFail = true;
    const before = progressAsks;
    setHidden(true); setHidden(false);
    await waitFor(() => progressAsks > before && f.spinner?.dataset.progress === 'unavailable', 2000);
    await settle(2);
    skew = 216_000;
    await waitFor(() => f.kind() === 'failed', 6000);
    push('🔴 R3-2: a failed progress poll before the give-up still reads "Code isn\'t reachable right now"',
        f.kind() === 'failed' && f.title() === "Code isn't reachable right now" && f.spinner?.dataset.progress === 'unavailable',
        `${f.kind()} "${f.title()}" progress=${f.spinner?.dataset.progress} asks=${progressAsks - before}`);
    progressFail = false;
    await window.$(f.w).close();
    await settle(4);
    delete doc.hidden;
    window.fetch = originalFetch;
    window.Date.now = realNow;
}

// ═══════════════════════════════════════════════════════════════════════════
// 5d. 🔴 ROUND 6a (seam C wiring + C2), through the BUILT bundle. The Code
//     window hands its spinner `isPreparing: () => session.isComputePreparing(
//     computer.id)` (code.js). Without that one line the spinner never learns
//     the computer is taking its config and reads "Connecting to Code…" over
//     the whole bounded wait. And the wait itself: preparing first seen at
//     ~70 s, the container restarting, then the Worker's answer at ~222 s,
//     past the old 215 s give-up (session.js PREPARE_DEADLINE_MS). The clock
//     is skewed, not waited.
// ═══════════════════════════════════════════════════════════════════════════
{
    const originalFetch = window.fetch, realNow = window.Date.now;
    let skew = 0, mintAsks = 0, mintAnswer = null;
    window.Date.now = () => realNow.call(window.Date) + skew;
    const RUNNING = { version: 2, computerId: COMPUTER.id, operation: 'none', stage: 'running', recordedStage: 'running', active: false,
        durable: false, openingStartedAt: null, path: null, milestones: [], expectedSeconds: 30 };
    const starting = { ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting', provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' };
    const preparing = { ...starting, computePreparing: true };
    window.fetch = async (url, opts) => {
        const u = String(url);
        if ( u.includes('/api/trpc/computer.progress') ) {
            return { ok: true, status: 200, json: async () => ({ result: { data: { json: RUNNING } } }) };
        }
        if ( u.startsWith(ENDPOINTS.codePreviewUrl) && mintAnswer ) {
            mintAsks++;
            const answer = mintAnswer;
            return { ok: true, status: 200, json: async () => answer };
        }
        return originalFetch(url, opts);
    };
    const waitFor = async (cond, ms) => { for ( let t = 0; t < ms && ! cond(); t += 50 ) await tick(50); return cond(); };
    const PREPARING = 'Preparing Code — the first open after your computer starts takes a minute or two.';

    // (a) The wiring: a preparing answer for THIS computer shows the preparing wait, not a connect.
    mintAnswer = preparing; mintAsks = 0;
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    let w = q('.window[data-app="code"]');
    let spinner = w?.querySelector('.ezil-app-spinner');
    const status = () => spinner?.querySelector('.ezil-opening-status')?.textContent ?? '';
    await waitFor(() => mintAsks >= 1 && status() === PREPARING, 8000);
    push('🔴 seam C wiring: Code opened while its computer prepares shows the preparing wait, never "Connecting to Code…"',
        mintAsks >= 1 && status() === PREPARING && ! /Connecting to Code|under a minute/.test(spinner?.textContent ?? ''),
        `${mintAsks} ask(s): "${status()}"`);
    await window.$(w).close();
    await settle(4);

    // (b) C2: plain starting answers until ~70 s, preparing, the container restarting (unflagged starting
    //     answers), then the Worker's answer at ~222 s. The loop is still asking there, and Code opens.
    mintAnswer = starting; mintAsks = 0; skew = 0;
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    w = q('.window[data-app="code"]');
    spinner = w?.querySelector('.ezil-app-spinner');
    const kind = () => spinner?.getAttribute('data-kind');
    await waitFor(() => mintAsks >= 1, 8000);
    skew = 70_000;
    mintAnswer = preparing;
    let asked = mintAsks;
    await waitFor(() => mintAsks > asked && status() === PREPARING, 8000);
    const preparingSeen = status() === PREPARING;
    mintAnswer = starting;
    skew = 222_000;
    asked = mintAsks;
    // Two asks past 215 s: the old deadline would have ended the loop at the first of them.
    await waitFor(() => mintAsks >= asked + 2, 10_000);
    push('🔴 C2: preparing first seen at ~70 s keeps Code waiting past 215 s (the Worker answers at ~222 s)',
        preparingSeen && mintAsks >= asked + 2 && kind() === 'progress' && status() === PREPARING
        && ! /isn't reachable|taking too long/.test(spinner?.textContent ?? ''),
        `seen=${preparingSeen} asks=${mintAsks - asked} kind=${kind()} "${status()}"`);
    const mintsBefore = mintedUrls.length;
    mintAnswer = null; // the stub's own ok mint
    await waitFor(() => mintedUrls.length > mintsBefore && w?.querySelector('.window-app-iframe')?.getAttribute('src') === mintedUrls[mintedUrls.length - 1], 8000);
    push('🔴 C2: the answer at ~222 s opens Code (its frame gets that URL), never "Code isn\'t reachable right now"',
        mintedUrls.length > mintsBefore && w?.querySelector('.window-app-iframe')?.getAttribute('src') === mintedUrls[mintedUrls.length - 1]
        && ! /isn't reachable/.test(spinner?.textContent ?? ''),
        `${mintedUrls.length - mintsBefore} mint(s) kind=${kind()}`);
    await window.$(w).close();
    await settle(4);
    window.fetch = originalFetch;
    window.Date.now = realNow;
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
