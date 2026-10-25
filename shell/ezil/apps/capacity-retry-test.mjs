// capacity-retry-test.mjs — EZiL-authored (RETRY-118). The ACTUAL UI Retry handlers.
//
// Run:  node shell/ezil/apps/capacity-retry-test.mjs
//       (after shell/build-shell.sh — it tests the BUILT bundle, not source)
//
// A paid first-ever open whose capacity attempt expired answers
// `capacity_attempt_expired` with the attempt id. Before RETRY-118 every visible
// "Try again" only re-asked and got the same terminal answer forever. Here the real
// Desktop, Code and Preview windows are opened against a stubbed server, and:
//   - their own polling/boot never calls the reset, however long they sit failed;
//   - clicking their real "Try again" sends exactly ONE reset with the stored id
//     (double clicks join), and only then reopens through the normal boot, which
//     the stub now admits.
import { JSDOM } from 'jsdom';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OS = process.env.EZIL_SHELL_OUT_DIR || path.resolve(here, '../../../app/public/os');
for ( const f of ['icons.js', 'bundle.min.js', 'bundle.min.css'] ) {
    if ( ! fs.existsSync(`${OS}/${f}`) ) { console.error(`SKIP: built bundle missing (${f}); run shell/build-shell.sh`); process.exit(2); }
}

const checks = [];
const push = (name, pass, detail = '') => { checks.push({ name, pass: !! pass, detail }); return !! pass; };

const dom = new JSDOM(
    `<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head>
     <body><div id="ezil-os-root"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' },
);
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(`window error: ${e.message}`));
if ( ! window.crypto?.getRandomValues ) {
    window.crypto = { getRandomValues: (a) => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; } };
}

const COMPUTER = { id: 'c-1', name: 'My computer', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null, isNew: false };
const ENDPOINTS = {
    session: '/api/shell/session', desktop: '/api/shell/desktop', previewUrl: '/api/shell/preview-url',
    codePreviewUrl: '/api/shell/code-preview-url', focus: '/api/shell/focus', capacityRetry: '/api/shell/capacity-retry',
};
const PAYLOAD = {
    user: { id: 'u-1', email: 'someone@example.com' }, computer: COMPUTER,
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
    desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle', endpoints: ENDPOINTS },
};

// Each surface's open answers `capacity_attempt_expired` until ITS attempt is reset.
const ATTEMPTS = { desktop: '11111111-1111-4111-8111-111111111111', code: '22222222-2222-4222-8222-222222222222',
    preview: '33333333-3333-4333-8333-333333333333' };
const expired = new Set(Object.keys(ATTEMPTS));
const calls = [];
let holdReset = null;
const expiredAnswer = (surface) => ({ ok: false, errorCode: 'capacity_attempt_expired', error: 'capacity_attempt_expired',
    retryable: false, computeProvider: 'aws-ec2', capacityAttemptId: ATTEMPTS[surface] });

window.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = opts.method ?? 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: u, method, body });
    const json = (payload, status = 200) => ({ ok: status < 400, status, json: async () => payload, text: async () => JSON.stringify(payload) });
    if ( u.startsWith(ENDPOINTS.capacityRetry) ) {
        if ( holdReset ) await holdReset;
        const surface = Object.keys(ATTEMPTS).find(s => ATTEMPTS[s] === body?.attemptId);
        if ( ! surface || body?.computerId !== COMPUTER.id ) return json({ ok: false, outcome: 'not_found' });
        const was = expired.delete(surface);
        return json({ ok: true, outcome: was ? 'reset' : 'already_reset' });
    }
    if ( u.startsWith(ENDPOINTS.codePreviewUrl) ) {
        return json(expired.has('code') ? expiredAnswer('code')
            : { ok: true, codePreviewUrl: 'https://8443-guac-u1-c1-code.ezil.org/preview-bootstrap?token=t=1,v1=a', expiresAt: Date.now() + 300_000 });
    }
    if ( u.startsWith(ENDPOINTS.previewUrl) ) {
        return json(expired.has('preview') ? expiredAnswer('preview')
            : { ok: true, appPreviewUrl: 'https://3002-guac-u1-c1-app.ezil.org/preview-bootstrap?token=t=1,v1=a', expiresAt: Date.now() + 300_000 });
    }
    if ( u.startsWith(ENDPOINTS.focus) ) return json({ ok: true, app: body?.app });
    if ( u.startsWith(ENDPOINTS.desktop) ) {
        if ( u.includes('confirm=frame') ) return json({ ok: true, confirmed: true, status: 200 });
        if ( method === 'GET' ) return json({ ok: true, guacamoleRunning: false });
        return json(expired.has('desktop') ? expiredAnswer('desktop')
            : { ok: true, guacamoleUrl: 'https://8181-guac-u1-c1-nekodesktop.ezil.org/', frame: { confirmed: true } });
    }
    return json({ error: { code: 'STUB', message: 'not stubbed' } }, 500);
};

const evalOrDie = (label, code) => { try { window.eval(code); } catch ( e ) { console.error(`${label} threw: ${e?.stack ?? e}`); process.exit(1); } };
window.__EZIL_BOOT__ = PAYLOAD;
evalOrDie('icons.js', fs.readFileSync(`${OS}/icons.js`, 'utf8'));
evalOrDie('bundle.min.js', fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
const ezil = window.ezil;
ezil.boot();

const doc = window.document;
const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 14, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const q = (sel) => doc.querySelector(sel);
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const resets = (surface) => calls.filter(c => c.url.startsWith(ENDPOINTS.capacityRetry) && c.body?.attemptId === ATTEMPTS[surface]);
const opens = (surface) => calls.filter(c => surface === 'desktop'
    ? c.url.startsWith(ENDPOINTS.desktop) && c.method === 'POST' && ! c.url.includes('confirm=')
    : c.url.startsWith(surface === 'code' ? ENDPOINTS.codePreviewUrl : ENDPOINTS.previewUrl));
/** The failure state's visible "Try again" inside one window (spinner or phase panel). */
const visibleRetry = (win) => Array.from(win?.querySelectorAll('.ezil-boot-retry') ?? [])
    .find(b => ! b.hidden && ! b.closest('[hidden]'));

async function exercise (surface) {
    const win = q(`.window[data-app="${surface}"]`);
    push(`${surface}: window opened`, !! win);
    await settle(20);
    // Sitting in the failed state: polling/boot must never reset on its own.
    await settle(20, 50);
    push(`${surface}: shows the capacity failure with an enabled Try again`, !! visibleRetry(win),
        win?.querySelector('[data-kind]')?.getAttribute('data-kind') ?? 'no state');
    push(`${surface}: no automatic reset while failed`, resets(surface).length === 0, String(resets(surface).length));
    const opensBefore = opens(surface).length;
    let release;
    holdReset = new Promise(r => { release = r; });
    const button = visibleRetry(win);
    click(button); click(button); // a double click
    await settle(4);
    push(`${surface}: one reset request with the stored attempt id (double click joined)`, resets(surface).length === 1
        && resets(surface)[0].method === 'POST' && resets(surface)[0].body?.computerId === COMPUTER.id, JSON.stringify(resets(surface)));
    push(`${surface}: no reopen before the reset settled`, opens(surface).length === opensBefore,
        `${opensBefore} -> ${opens(surface).length}`);
    holdReset = null; release();
    await settle(30);
    push(`${surface}: then reopened through the normal boot exactly once`, opens(surface).length === opensBefore + 1,
        `${opensBefore} -> ${opens(surface).length}`);
    push(`${surface}: the reopen was admitted (no failure state)`, ! visibleRetry(win),
        win?.querySelector('[data-kind]')?.getAttribute('data-kind') ?? 'no state');
}

await settle(20);
if ( ! q('.window[data-app="desktop"]') ) await ezil.registry.launch('desktop', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await exercise('desktop');
await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await exercise('code');
await ezil.registry.launch('preview', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
await exercise('preview');
// ═══ Root P2 (RETRY-118 review): two windows, one attempt. Retry in Code, then in Desktop, then close Code
// while the reset is pending → ONE reset, and Desktop (still open) reopens exactly once.
{
    const SHARED = '44444444-4444-4444-8444-444444444444';
    ATTEMPTS.desktop = SHARED; ATTEMPTS.code = SHARED; expired.add('desktop'); expired.add('code');
    for ( const app of ['desktop', 'code'] ) {
        const w = q(`.window[data-app="${app}"]`);
        if ( w ) await window.$(w).close();
    }
    await settle(10);
    await ezil.registry.launch('desktop', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await ezil.registry.launch('code', { payload: PAYLOAD, computer: COMPUTER, desktopState: PAYLOAD.desktopState });
    await settle(40, 25);
    const desk = q('.window[data-app="desktop"]'), code = q('.window[data-app="code"]');
    const shared = () => calls.filter(c => c.url.startsWith(ENDPOINTS.capacityRetry) && c.body?.attemptId === SHARED);
    push('two windows: both show the expired attempt with Try again', !! visibleRetry(desk) && !! visibleRetry(code));
    const deskOpens = opens('desktop').length, codeOpens = opens('code').length;
    let release; holdReset = new Promise(r => { release = r; });
    click(visibleRetry(code));
    click(visibleRetry(desk)); click(visibleRetry(desk)); // and a double click in Desktop
    await settle(4);
    await window.$(code).close(); // Code closes while the reset is pending
    await settle(4);
    push('two windows: exactly one shared reset for the attempt', shared().length === 1, String(shared().length));
    holdReset = null; release();
    await settle(30);
    push('two windows: the still-open Desktop reopened exactly once', opens('desktop').length === deskOpens + 1,
        `${deskOpens} -> ${opens('desktop').length}`);
    push('two windows: the closed Code window did not re-mint', opens('code').length === codeOpens, `${codeOpens} -> ${opens('code').length}`);
    push('two windows: Desktop admitted (no failure state)', ! visibleRetry(q('.window[data-app="desktop"]')));
}
push('no uncaught page errors', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
