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
//
// Review follow-up (2026-10-29), each check killed a mutation the first version let live:
//   - hover-warm: after Stop, moving the pointer over the Browser dock icon must
//     not send `POST /api/shell/desktop` (it ran ensure() and restarted the
//     computer); an explicit open afterwards still does;
//   - a closed Code / Preview window stops its own loop, with no Stop at all;
//   - a request ALREADY ON THE WIRE at Stop: its signal is aborted before the stop
//     leaves, and when the transport ignores the abort the stop waits for it to
//     answer (closeSandboxWindows awaits the cancelled loops);
//   - Open desktop on the current computer keeps a Code window that streams it
//     AND its loop (the `keep` branch).
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
/** One clock for asks AND answers, so "the stop left after that answer" is a plain comparison. */
let seq = 0;
/**
 * How `/api/shell/code-preview-url` answers: 'fast' (at once), or 'held' — the ask stays on
 * the wire until `releaseHeld` is called, then answers; `honourAbort` rejects it on abort instead.
 */
let codeMode = { kind: 'fast', honourAbort: false };
let heldAsks = [];
let releaseHeld = () => {};
let heldGate = new Promise(r => { releaseHeld = r; });
const rearmHeld = () => { heldAsks = []; heldGate = new Promise(r => { releaseHeld = r; }); };
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const rec = { url: u, method: opts.method ?? 'GET', at: seq++, domAtCall: {
        desktop: window.document.querySelectorAll('.window[data-app="desktop"]').length,
        preview: window.document.querySelectorAll('.window[data-app="preview"]').length,
        code: window.document.querySelectorAll('.window[data-app="code"]').length,
    } };
    calls.push(rec);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    // AWS "still starting": a not-ready VALUE the wake loop re-asks every 1.5 s.
    if ( ensureRoute(rec) ) {
        const starting = () => { rec.resolvedAt = seq++; return json({ ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2', retryable: true }); };
        if ( codeMode.kind !== 'held' || ! u.endsWith('/api/shell/code-preview-url') ) return starting();
        rec.signal = opts.signal ?? null;
        heldAsks.push(rec);
        if ( codeMode.honourAbort ) {
            await new Promise((resolve, reject) => {
                heldGate.then(resolve);
                const abort = () => { rec.abortedAt = seq++; reject(new window.DOMException('The operation was aborted.', 'AbortError')); };
                if ( opts.signal?.aborted ) abort(); else opts.signal?.addEventListener('abort', abort, { once: true });
            });
        } else {
            await heldGate; // a transport that ignores the abort: it answers when it answers
        }
        return starting();
    }
    if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: listRows } } });
    if ( u.includes('/api/trpc/computer.progress') ) {
        const id = JSON.parse(decodeURIComponent(u.split('input=')[1] ?? '%7B%7D')).json?.computerId;
        return json({ result: { data: { json: { version: 2, computerId: id, operation: 'none', lifecycleState: progressState,
            needsOperator: false, transition: null, milestones: [], hardware: { instanceType: 'm6i.large', source: 'placement' } } } } });
    }
    if ( u.endsWith('/api/shell/stop') ) {
        rec.body = JSON.parse(opts.body ?? '{}');
        rec.heldAtStop = heldAsks.map(h => ({ answered: h.resolvedAt !== undefined, signalAborted: h.signal?.aborted === true }));
        progressState = 'STOPPED';
        return json({ ok: true, terminated: true });
    }
    return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
};

const X = { id: 'c-x', name: 'Xenon', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
const PAYLOAD = {
    user: { id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.com', name: 'Ada', provider: 'google', createdAt: '2026-10-01T18:30:00.000Z' },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop', pinned: true }],
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

/** Settings → Computer → Stop → the confirm alert's Stop. Returns the stop call (or undefined). */
async function stopFromSettings ({ onConfirm } = {}) {
    if ( q('.window[data-app="settings"]') ) { $('.window[data-app="settings"]').close(); await settle(6); }
    await ezil.registry.launch('settings', ctx);
    await settle(8);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
    await settle(10);
    const before = calls.length;
    click(q('.window[data-app="settings"] [data-action="stop"]'));
    await settle(6);
    // main confirms Stop with a UIAlert (the r5 confirm sheet is not on main).
    click(qa('.window button').find(b => b.textContent.trim() === 'Stop' && b.closest('.window')?.querySelector('.window-alert-message')));
    onConfirm?.();
    for ( let i = 0; i < 240 && ! calls.slice(before).some(c => c.url.endsWith('/api/shell/stop')); i++ ) await tick(25);
    return calls.slice(before).find(c => c.url.endsWith('/api/shell/stop'));
}

listRows = [X];
// ═══════════════════════════════════════════════════════════════════════════
// 0. Hover-warm (runs first: a hover only warms a computer no Stop holds yet).
//    After Stop, pointing at the Browser dock icon must not start
//    the computer again (it POSTed /api/shell/desktop → ensure()). An explicit
//    open afterwards still does.
// ═══════════════════════════════════════════════════════════════════════════
progressState = 'RUNNING';
const dock = () => q('.taskbar-item[data-app="desktop"]');
const hover = () => dock()?.dispatchEvent(new window.PointerEvent('pointerenter', { bubbles: false }));
for ( let i = 0; i < 80 && ! dock(); i++ ) await tick(25);
push('setup: the Browser dock icon exists', !! dock());
const preHover = seq;
hover();
await tick(300);
push('positive control: a hover before Stop warms the computer (POST /api/shell/desktop)',
    asksTo('/api/shell/desktop', preHover).length >= 1, `${asksTo('/api/shell/desktop', preHover).length} asks`);
const stop3 = await stopFromSettings();
push('the hover-section stop went out', stop3?.body?.computerId === 'c-x', JSON.stringify(stop3?.body));
hover();
await tick(300);
hover();
await tick(3_600);
const hoverAfter = stop3 ? asksTo('/api/shell/desktop', stop3.at + 1) : [];
push('🔴 after Stop, a hover over the Browser dock icon asks nothing (no warm → no restart)',
    stop3 && hoverAfter.length === 0, `${hoverAfter.length} desktop asks after the stop`);
const preOpen = seq;
await ezil.registry.launch('desktop', ctx);
await tick(600);
push('an explicit Browser open after Stop still starts the computer',
    asksTo('/api/shell/desktop', preOpen).length >= 1, `${asksTo('/api/shell/desktop', preOpen).length} asks`);
progressState = 'RUNNING';
const stop3b = await stopFromSettings();
push('cleanup stop went out', stop3b?.body?.computerId === 'c-x');
await tick(1_600);

// ═══════════════════════════════════════════════════════════════════════════
// 1. Browser + Preview + Code, all stamped for c-x, all still waking.
// ═══════════════════════════════════════════════════════════════════════════
progressState = 'RUNNING';
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

// ═══════════════════════════════════════════════════════════════════════════
// 4. Closing a Code or Preview window by hand (no Stop) ends its own loop.
// ═══════════════════════════════════════════════════════════════════════════
progressState = 'RUNNING';
for ( const [app, route] of [['code', '/api/shell/code-preview-url'], ['preview', '/api/shell/preview-url']] ) {
    const from = seq;
    await ezil.registry.launch(app, ctx);
    await tick(3_200);
    push(`setup: the ${app} window is open and asking`, q(`.window[data-app="${app}"]`) && asksTo(route, from).length >= 2,
        `${asksTo(route, from).length} asks`);
    $(q(`.window[data-app="${app}"]`)).close();
    await tick(200);
    const closedAt = seq;
    await tick(3_600);
    const after = asksTo(route, closedAt);
    push(`🔴 a ${app} window closed by hand asks ${route} nothing more`, qa(`.window[data-app="${app}"]`).length === 0 && after.length === 0,
        `${after.length} asks after the close`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. A Code ask ALREADY ON THE WIRE when Stop is confirmed.
// ═══════════════════════════════════════════════════════════════════════════
for ( const honourAbort of [false, true] ) {
    const label = honourAbort ? 'a transport that honours the abort' : 'a transport that IGNORES the abort';
    progressState = 'RUNNING';
    rearmHeld();
    codeMode = { kind: 'held', honourAbort };
    await ezil.registry.launch('code', ctx);
    for ( let i = 0; i < 80 && heldAsks.length === 0; i++ ) await tick(25);
    push(`setup (${label}): a code-preview-url ask is on the wire`, heldAsks.length === 1 && heldAsks[0].resolvedAt === undefined);
    // The transport answers 800 ms after the user confirms Stop.
    const stop5 = await stopFromSettings({ onConfirm: () => { window.setTimeout(() => releaseHeld(), 800); } });
    push(`(${label}) the stop went out`, stop5?.body?.computerId === 'c-x');
    push(`🔴 (${label}) the ask on the wire had its signal aborted before the stop request left`,
        stop5?.heldAtStop?.length === 1 && stop5.heldAtStop[0].signalAborted === true, JSON.stringify(stop5?.heldAtStop));
    if ( ! honourAbort ) {
        push('🔴 (abort ignored) the stop request waited until that ask had answered (closeSandboxWindows awaits the loop)',
            stop5 && heldAsks[0]?.resolvedAt !== undefined && heldAsks[0].resolvedAt < stop5.at,
            `answered at ${heldAsks[0]?.resolvedAt}, stop at ${stop5?.at}`);
    } else {
        push('(abort honoured) the ask was aborted, not answered, before the stop request',
            stop5 && heldAsks[0]?.abortedAt !== undefined && heldAsks[0].abortedAt < stop5.at && heldAsks[0].resolvedAt === undefined,
            `aborted at ${heldAsks[0]?.abortedAt}, stop at ${stop5?.at}`);
    }
    await tick(3_600);
    const after = stop5 ? asksTo('/api/shell/code-preview-url', stop5.at + 1) : [];
    push(`🔴 (${label}) after Stop, nothing asks /api/shell/code-preview-url`, stop5 && after.length === 0, `${after.length} asks after the stop`);
    codeMode = { kind: 'fast', honourAbort: false };
    releaseHeld();
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Open desktop on the CURRENT computer keeps a Code window streaming it,
//    and keeps its loop asking (closeSandboxWindows(undefined, keepId)).
// ═══════════════════════════════════════════════════════════════════════════
progressState = 'RUNNING';
await ezil.registry.launch('code', ctx);
await tick(400);
const codeWin6 = q('.window[data-app="code"][data-ezil-computer-id="c-x"]');
push('setup: a Code window streams c-x', !! codeWin6);
if ( q('.window[data-app="settings"]') ) { $('.window[data-app="settings"]').close(); await settle(6); }
await ezil.registry.launch('settings', ctx);
await settle(8);
click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
await settle(10);
const openBtn = q('.window[data-app="settings"] [data-role="computer-actions"] [data-action="open"]')
    ?? q('.window[data-app="settings"] [data-action="open"]');
push('setup: Settings offers Open desktop', !! openBtn);
click(openBtn);
await tick(800);
const keptFrom = seq;
await tick(3_200);
push('🔴 Open desktop on the current computer keeps its Code window', q('.window[data-app="code"]') === codeWin6 && codeWin6?.isConnected === true);
push('🔴 … and that window keeps asking (its loop was not cancelled)', asksTo('/api/shell/code-preview-url', keptFrom).length >= 1,
    `${asksTo('/api/shell/code-preview-url', keptFrom).length} asks`);

push('no uncaught page errors', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
// Explicit exit: on a defective bundle the loops would keep this process alive for ~215 s.
process.exit(failed === 0 ? 0 : 1);
