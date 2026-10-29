// stop-cancels-opens-test.mjs — EZiL-authored. Hotfix r5 (2026-10-29): Stop must
// not leave an app's wake loop asking the server to start the computer again.
//
// Run:  node shell/ezil/ui/Settings/stop-cancels-opens-test.mjs
//       (after shell/build-shell.sh — it drives the BUILT bundle in jsdom;
//       EZIL_SHELL_OUT_DIR picks another build directory; exit 2 when no bundle)
//
// THE DEFECT (ACCEPT-11865d06 run B, B6): with the Code window open on a running
// AWS computer whose post-switch re-mint was still waiting, Settings → Computer →
// Stop closed the windows and the stop confirmed, then 0.23 s later a lifecycle
// replace started a new m6i.xlarge. Every ask of `/api/shell/code-preview-url`,
// `/api/shell/preview-url` and `POST /api/shell/desktop` runs the server's
// `ensure()`, and on a STOPPED placement that starts the computer. Closing the
// window only set the window's own `disposed` flag; the session wake loop the
// window had started (`withWakeAndOneRetry`, re-asking every 1.5 s for up to
// 215 s) did not read it and kept asking after the stop. The Browser window's
// first open (the paint-time warm via `warm.js#claim`) had the same hole.
//
// The existing Stop check (`settings-test.mjs` 5e) stubs these routes as 500, so
// every loop dies after one retry and it cannot see this. Here they answer the
// AWS "still starting" value forever, as a waking computer does, so a loop that
// is not cancelled keeps asking — and the checks below see it.
//
// What it pins, for Code, Preview and Browser windows on the computer:
//   - positive control: each loop is really asking before Stop;
//   - every window is closed before `POST /api/shell/stop` leaves;
//   - after the stop request, no ask reaches any of the three ensure routes;
//   - the same holds for a Code window whose computer stamp is missing (the
//     unknown-ownership fail-safe closes it, and its loop is cancelled too).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(path.join(OS, f)) ) {
        console.error(`missing ${path.join(OS, f)} — run shell/build-shell.sh first`);
        process.exit(2);
    }
}

const checks = [];
const push = (name, pass, detail = '') => { checks.push({ name, pass: !! pass, detail }); return !! pass; };

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(`window error: ${e.message}`));
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = { getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; } };
}

// ── the stubbed server ──────────────────────────────────────────────────────
/** The three routes whose every ask runs the server's ensure() (start on STOPPED). */
const ENSURE_ROUTES = ['/api/shell/code-preview-url', '/api/shell/preview-url', '/api/shell/desktop'];
const ensureRoute = (c) => c.method === 'POST' && ENSURE_ROUTES.includes(new URL(c.url, 'https://ezil.local').pathname);
const calls = [];
let listRows = [];
let progressState = 'RUNNING';
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const rec = { url: u, method: opts.method ?? 'GET', at: calls.length, domAtCall: {
        desktop: window.document.querySelectorAll('.window[data-app="desktop"]').length,
        preview: window.document.querySelectorAll('.window[data-app="preview"]').length,
        code: window.document.querySelectorAll('.window[data-app="code"]').length,
    } };
    calls.push(rec);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    // AWS "still starting": a fast not-ready VALUE the wake loop re-asks every 1.5 s.
    if ( ensureRoute(rec) ) return json({ ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2', retryable: true });
    if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: listRows } } });
    if ( u.includes('/api/trpc/computer.progress') ) {
        const id = JSON.parse(decodeURIComponent(u.split('input=')[1] ?? '%7B%7D')).json?.computerId;
        return json({ result: { data: { json: { version: 2, computerId: id, operation: 'none', lifecycleState: progressState,
            needsOperator: false, transition: null, milestones: [], hardware: { instanceType: 'm6i.large', source: 'placement' } } } } });
    }
    if ( u.endsWith('/api/shell/stop') ) {
        rec.body = JSON.parse(opts.body ?? '{}');
        progressState = 'STOPPED';
        return json({ ok: true, terminated: true });
    }
    return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
};

const X = { id: 'c-x', name: 'Xenon', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
const PAYLOAD = {
    user: { id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.com', name: 'Ada', provider: 'google', createdAt: '2026-10-01T18:30:00.000Z' },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    computer: { ...X, isNew: false },
    // A configured provider, so each window really starts its open (with `{}` they stop at not_configured).
    desktopState: { configured: true },
};
window.__EZIL_BOOT__ = PAYLOAD;

try {
    window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
    window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
} catch ( e ) {
    console.error(`bundle threw: ${e?.stack ?? e}`);
    process.exit(1);
}
const ezil = window.ezil;
push('bundle exposes window.ezil', typeof ezil === 'object');
ezil.boot();

const $ = window.$;
const doc = window.document;
const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 12, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const q = (sel) => doc.querySelector(sel);
const qa = (sel) => Array.from(doc.querySelectorAll(sel));
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const ctx = { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState };
const asksTo = (route, from = 0) => calls.filter(c => c.at >= from && ensureRoute(c) && new URL(c.url, 'https://ezil.local').pathname === route);

/** Settings → Computer → Stop → the sheet's Stop. Returns the stop call (or undefined). */
async function stopFromSettings () {
    if ( q('.window[data-app="settings"]') ) { $('.window[data-app="settings"]').close(); await settle(6); }
    await ezil.registry.launch('settings', ctx);
    await settle(8);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle(10);
    const before = calls.length;
    click(q('.window[data-app="settings"] [data-action="stop"]'));
    await settle(6);
    click(q('[role="dialog"][data-sheet="confirm-stop"] [data-action="confirm"]'));
    for ( let i = 0; i < 160 && ! calls.slice(before).some(c => c.url.endsWith('/api/shell/stop')); i++ ) await tick(25);
    return calls.slice(before).find(c => c.url.endsWith('/api/shell/stop'));
}

// ═══════════════════════════════════════════════════════════════════════════
// 1. Browser + Preview + Code, all stamped for c-x, all still waking.
// ═══════════════════════════════════════════════════════════════════════════
listRows = [X];
await ezil.registry.launch('desktop', ctx);
await settle(4);
await ezil.registry.launch('preview', ctx);
await settle(4);
await ezil.registry.launch('code', ctx);
// Long enough for every loop to ask at least twice (re-ask every 1.5 s).
await tick(3_600);
push('setup: Browser, Preview and Code are open for c-x',
    q('.window[data-app="desktop"][data-ezil-computer-id="c-x"]') && q('.window[data-app="preview"][data-ezil-computer-id="c-x"]')
    && q('.window[data-app="code"][data-ezil-computer-id="c-x"]'));
for ( const route of ENSURE_ROUTES ) {
    push(`positive control: ${route} is being re-asked before Stop (≥ 2 asks)`, asksTo(route).length >= 2, `${asksTo(route).length} asks`);
}

const stop1 = await stopFromSettings();
push('POST /api/shell/stop went out for c-x', stop1?.method === 'POST' && stop1?.body?.computerId === 'c-x', JSON.stringify(stop1?.body));
push('every app window was closed before the stop request',
    stop1 && stop1.domAtCall.desktop === 0 && stop1.domAtCall.preview === 0 && stop1.domAtCall.code === 0, JSON.stringify(stop1?.domAtCall));
// Wait well past two re-ask intervals: a live loop would ask at least twice more.
await tick(4_000);
for ( const route of ENSURE_ROUTES ) {
    const after = stop1 ? asksTo(route, stop1.at + 1) : [];
    push(`🔴 after Stop, nothing asks ${route} (no ensure → no restart)`, stop1 && after.length === 0, `${after.length} asks after the stop`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Fail-safe: a Code window whose computer stamp is missing still closes,
//    and its wake loop is still cancelled.
// ═══════════════════════════════════════════════════════════════════════════
progressState = 'RUNNING';
await ezil.registry.launch('code', ctx);
await settle(4);
q('.window[data-app="code"]')?.removeAttribute('data-ezil-computer-id');
await tick(3_200);
push('setup: an un-attributable Code window is open and asking',
    q('.window[data-app="code"]') && ! q('.window[data-app="code"]').hasAttribute('data-ezil-computer-id')
    && asksTo('/api/shell/code-preview-url', stop1 ? stop1.at + 1 : 0).length >= 2);
const stop2 = await stopFromSettings();
push('the second stop went out', stop2?.body?.computerId === 'c-x', JSON.stringify(stop2?.body));
push('🔴 the un-attributable Code window was closed before the stop request (fails safe)',
    stop2 && stop2.domAtCall.code === 0 && qa('.window[data-app="code"]').length === 0, JSON.stringify(stop2?.domAtCall));
await tick(4_000);
const after2 = stop2 ? asksTo('/api/shell/code-preview-url', stop2.at + 1) : [];
push('🔴 after Stop, the un-attributable Code window\'s loop asks nothing more', stop2 && after2.length === 0, `${after2.length} asks after the stop`);

push('no uncaught page errors', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
// Explicit exit: on a defective bundle the loops would keep this process alive for ~215 s.
process.exit(failed === 0 ? 0 : 1);
