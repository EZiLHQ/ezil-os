// desktop-close-test.mjs — EZiL-authored. End-to-end harness for the ONE
// thing closing a desktop window has to do besides disappearing: release the
// container.
//
// Run:  node shell/ezil/apps/desktop-close-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not source)
//
// ── Why it exists ───────────────────────────────────────────────────────────
// `dispose()` cleared two timers, removed four listeners, disconnected two
// observers and ended the trace. It called NO server endpoint at all, so
// closing a desktop window released nothing: the container then sat until the
// Worker's own `IDLE_STOP_MS` (10 minutes) plus an alarm tick noticed the
// heartbeats had stopped. The user's report was "when the browser window is
// getting closed, it is closing inside and then keeping a particular window
// alive on the browser itself".
//
// The fix is one request, and every property that matters about it is a
// property of the CLOSE PATH, not of the request:
//
//   * it happens on close                      (group 1)
//   * it does NOT happen on minimise           (group 2) — a minimised desktop
//                                               is still open, and releasing it
//                                               would stop a container the user
//                                               is walking back to
//   * it cannot delay or fail the close        (group 3) — asserted against a
//                                               server that never answers and a
//                                               server that answers 500
//   * it is not sent to a server that never    (group 4)
//     published the endpoint
//   * a failed release is REPORTED             (group 5)
//
// None of those are visible in a unit test of the request function, because
// none of them are about the request function. This drives the real bundle:
// the real boot, the real window, the real close button, and observes the real
// `fetch` boundary.
//
// jsdom is not a browser: no layout, no real network, no cross-origin frames.
// It cannot prove the container actually stopped — that is a Worker-side
// property of `EzilSandboxDO`'s idle path and belongs to a container check.
// What it proves is exactly what the shell is responsible for: which request
// left, when, carrying what, and that nothing waited for it.

import { JSDOM } from 'jsdom';
// The shell's own definition of "long enough ago to count as absent", which is
// what `session.releaseDesktop` puts on the wire. Imported rather than
// restated: `worker/src/desktop-release.test.ts` pins the SAME constant
// against the Worker's `IDLE_STOP_MS`, so between the two files the whole
// chain — shell number -> wire -> idle rule — is nailed down.
import { ACTIVITY_FRESH_MS } from '../activity-heartbeat.js';
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

const COMPUTER = {
    id: 'c-1', name: 'My computer', slot: 1,
    createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false,
};
// `SHELL_API_ROUTES` verbatim, plus the two feature-detected keys this file is
// about: `activity` (the transport a release reuses) and `telemetry` (so a
// failed release is observable here at all).
const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    focus: '/api/shell/focus',
    activity: '/api/shell/activity',
    telemetry: '/api/shell/telemetry',
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
/** 'ok' | 'error' | 'hang' — what `/api/shell/activity` should do next. */
let activityMode = 'ok';
/** Resolvers for every hung activity request, so the run can end cleanly. */
const hungRequests = [];

window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method: opts.method ?? 'GET', body, at: Date.now() });

    const json = (payload, status = 200) => ({
        ok: status < 400, status,
        json: async () => payload,
        text: async () => JSON.stringify(payload),
    });

    if ( u.startsWith(ENDPOINTS.activity) ) {
        if ( activityMode === 'hang' ) {
            // Never resolves on its own. This is the case the "must never block
            // the close" contract is actually about — a timeout is a resolution.
            return new Promise((resolve) => { hungRequests.push(() => resolve(json({ ok: true }))); });
        }
        if ( activityMode === 'error' ) return json({ ok: false, error: 'nope' }, 500);
        return json({ ok: true, sandboxId: 'guac-u1-c1' });
    }
    if ( u.startsWith(ENDPOINTS.telemetry) ) return json({ ok: true });

    if ( u.startsWith(ENDPOINTS.desktop) ) {
        if ( u.includes('confirm=frame') ) return json({ ok: true, confirmed: true, status: 200 });
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

const DCTX = { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState };
const activityCalls = (from = 0) => calls.slice(from).filter(c => c.url.startsWith(ENDPOINTS.activity));
const telemetryEvents = (from = 0) => calls.slice(from)
    .filter(c => c.url.startsWith(ENDPOINTS.telemetry))
    .flatMap(c => c.body?.events ?? []);
/** telemetry.js batches on a 10s timer; `pagehide` is its own flush trigger. */
const flushTelemetry = async () => {
    window.dispatchEvent(new window.Event('pagehide'));
    await settle(4);
};
const openDesktop = async (ctx = DCTX) => {
    await ezil.registry.launch('desktop', ctx);
    await settle(20);
    return q('.window[data-app="desktop"]');
};

await settle(80, 25);
// Login deliberately opens nothing (see `boot.js`: "LOGIN OPENS NOTHING"), so
// every group below opens the desktop for itself. Asserted rather than assumed
// — if that ever changes, the close assertions must not silently start running
// against a second, older window.
push('login opens no window on its own', qa('.window[data-app="desktop"]').length === 0);

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE CLOSE RELEASES.
// ═══════════════════════════════════════════════════════════════════════════
// The 10-minute idle window on the Worker is `IDLE_STOP_MS`; a release has to
// report a presence age comfortably past it or the next flush alarm will not
// consider the sandbox idle. This is the number, not the mechanism, so it is
// asserted as a bound rather than as an exact constant.
const IDLE_STOP_MS = 10 * 60_000;

let win = await openDesktop();
push('opening the desktop gives a window to close', !! win);
let before = calls.length;
await window.$(win).close();
await settle(8);

const closeReleases = activityCalls(before);
push('🔴 closing the desktop window sends exactly one activity request',
    closeReleases.length === 1, `${closeReleases.length} activity call(s)`);
push('…as a POST to the EXISTING activity route (no new lifecycle verb)',
    closeReleases[0]?.method === 'POST' && closeReleases[0]?.url === ENDPOINTS.activity,
    `${closeReleases[0]?.method} ${closeReleases[0]?.url}`);
push('…carrying this computer id',
    closeReleases[0]?.body?.computerId === COMPUTER.id);
push('🔴 …and a presence age past the server\'s 10-minute idle window',
    Number(closeReleases[0]?.body?.lastInputAgoMs) >= IDLE_STOP_MS,
    `lastInputAgoMs=${closeReleases[0]?.body?.lastInputAgoMs}`);
push('…and that age is exactly the shell\'s own ACTIVITY_FRESH_MS',
    Number(closeReleases[0]?.body?.lastInputAgoMs) === ACTIVITY_FRESH_MS,
    `${closeReleases[0]?.body?.lastInputAgoMs} vs ${ACTIVITY_FRESH_MS}`);
push('the release body is ONLY the activity shape — no destroy/terminate field',
    JSON.stringify(closeReleases[0]?.body ?? {}) === JSON.stringify({
        computerId: COMPUTER.id, lastInputAgoMs: closeReleases[0]?.body?.lastInputAgoMs,
    }),
    JSON.stringify(closeReleases[0]?.body));
push('the window is actually gone', qa('.window[data-app="desktop"]').length === 0);

// The drawer's close button is how a full-bleed desktop is closed — the same
// path, reached the way a user reaches it.
win = await openDesktop();
before = calls.length;
click(win?.querySelector('.dashboard-app-drawer-close'));
await settle(10);
push('🔴 the control drawer\'s Close button releases too',
    activityCalls(before).length === 1 && qa('.window[data-app="desktop"]').length === 0,
    `${activityCalls(before).length} activity call(s), ${qa('.window[data-app="desktop"]').length} window(s)`);

// ═══════════════════════════════════════════════════════════════════════════
// 2. 🔴 MINIMISE IS NOT A RELEASE.
// ═══════════════════════════════════════════════════════════════════════════
// A minimised desktop is still open, still heartbeating, and the user is
// coming back to it. This is the assertion that a future "tidy up the close
// path" change has to fail.
win = await openDesktop();
before = calls.length;
click(win?.querySelector('.dashboard-app-drawer-minimize'));
await settle(10);
push('🔴 minimising sends NO activity request',
    activityCalls(before).length === 0, JSON.stringify(activityCalls(before).map(c => c.body)));
push('…and the window is still there, merely hidden',
    qa('.window[data-app="desktop"]').length === 1);

// The titlebar/context-menu route into minimise is a different function
// (`_ezil_minimise`, read by UIWindow.js) and must behave the same.
window.$(win).showWindow();
await settle(4);
before = calls.length;
win._ezil_minimise();
await settle(10);
push('🔴 the titlebar minimise hook sends NO activity request either',
    activityCalls(before).length === 0);
push('…and still leaves the window alive',
    qa('.window[data-app="desktop"]').length === 1);

window.$(win).showWindow();
await settle(4);
await window.$(win).close();
await settle(8);

// ═══════════════════════════════════════════════════════════════════════════
// 3. 🔴 THE RELEASE CANNOT DELAY OR FAIL THE CLOSE.
// ═══════════════════════════════════════════════════════════════════════════
// Against a server that NEVER answers. If the close awaited the release in any
// way, `close()` would not resolve and the window would still be on screen.
activityMode = 'hang';
win = await openDesktop();
before = calls.length;
const closeStarted = Date.now();
const closed = await Promise.race([
    window.$(win).close().then(() => 'closed'),
    new Promise(r => window.setTimeout(() => r('still waiting'), 3_000)),
]);
await settle(8);
push('🔴 a release that never answers still closes the window',
    closed === 'closed' && qa('.window[data-app="desktop"]').length === 0,
    `${closed}, ${qa('.window[data-app="desktop"]').length} window(s) left`);
push('…without waiting on it', Date.now() - closeStarted < 2_000,
    `${Date.now() - closeStarted}ms`);
push('…having genuinely tried', activityCalls(before).length === 1);
for ( const resolve of hungRequests.splice(0) ) resolve();
await settle(4);

// Against a server that answers, but refuses.
activityMode = 'error';
win = await openDesktop();
before = calls.length;
await window.$(win).close();
await settle(10);
push('🔴 a release the server REFUSES still closes the window',
    qa('.window[data-app="desktop"]').length === 0);

// ═══════════════════════════════════════════════════════════════════════════
// 5. A FAILED RELEASE IS REPORTED, with the contract's own names.
// ═══════════════════════════════════════════════════════════════════════════
await flushTelemetry();
const releaseErrors = telemetryEvents().filter(e => e.site === 'ezil-os:apps/desktop#close');
push('🔴 a failed release emits telemetry at ezil-os:apps/desktop#close',
    releaseErrors.length >= 1, `${releaseErrors.length} event(s)`);
push('…in the EXISTING window_error class (no new eventClass)',
    releaseErrors.every(e => e.eventClass === 'window_error'),
    JSON.stringify(releaseErrors.map(e => e.eventClass)));
// 🔴 The call site writes the contract's `release-failed`; `telemetry.js`'s
// `normalizeCode` forces every code to `[a-z0-9_]`, so the hyphen lands as an
// underscore. Asserted as what actually goes on the wire, not as what was
// typed — see this task's report for the contract §8 / normalizer drift.
push('…with a short stable code', releaseErrors.every(e => e.code === 'release_failed'),
    JSON.stringify(releaseErrors.map(e => e.code)));
const successTelemetry = telemetryEvents().filter(
    e => e.site === 'ezil-os:apps/desktop#close' && e.code !== 'release_failed');
push('a SUCCESSFUL release reports nothing', successTelemetry.length === 0,
    JSON.stringify(successTelemetry));
activityMode = 'ok';

// ═══════════════════════════════════════════════════════════════════════════
// 4. AN OLDER SERVER IS NOT A FAILURE.
// ═══════════════════════════════════════════════════════════════════════════
// A deployment that never published `endpoints.activity` must get NO request
// at all — never a 404 sprayed at a path this bundle invented. Same feature
// detection the heartbeat already uses.
const noActivityPayload = {
    ...PAYLOAD,
    desktopState: {
        ...PAYLOAD.desktopState,
        endpoints: {
            session: ENDPOINTS.session, desktop: ENDPOINTS.desktop, telemetry: ENDPOINTS.telemetry,
        },
    },
};
window.__EZIL_BOOT__ = noActivityPayload;
win = await openDesktop({ ...DCTX, desktopState: noActivityPayload.desktopState });
before = calls.length;
await window.$(win).close();
await settle(10);
push('🔴 no endpoints.activity -> no release request at all',
    activityCalls(before).length === 0,
    JSON.stringify(calls.slice(before).map(c => c.url)));
push('…and nothing was invented at another path',
    ! calls.slice(before).some(c => /release|terminate|destroy|stop/i.test(c.url)),
    JSON.stringify(calls.slice(before).map(c => c.url)));
await flushTelemetry();
const errorsAfterOldServer = telemetryEvents()
    .filter(e => e.site === 'ezil-os:apps/desktop#close').length;
push('…and an older server is not reported as an error',
    errorsAfterOldServer === releaseErrors.length,
    `${errorsAfterOldServer} vs ${releaseErrors.length}`);
window.__EZIL_BOOT__ = PAYLOAD;

// ═══════════════════════════════════════════════════════════════════════════
// 6. HYGIENE.
// ═══════════════════════════════════════════════════════════════════════════
const offOrigin = calls.filter(c => /^https?:\/\//.test(c.url) && ! c.url.startsWith('https://ezil.local'));
push('every request this shell MADE was same-origin', offOrigin.length === 0,
    JSON.stringify(offOrigin.map(c => c.url)));
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
