// stale-chip-reopen-test.mjs — EZiL-authored. Follow-up r5 (ACCEPT-9a755827 FINDING 2):
// Settings → Computer must never paint a lifecycle chip from a previous pane life.
//
// Run:  node shell/ezil/ui/Settings/stale-chip-reopen-test.mjs
//       (after shell/build-shell.sh — it drives the BUILT bundle in jsdom;
//       EZIL_SHELL_OUT_DIR picks another build directory; exit 2 when no bundle)
//
// THE DEFECT. `tabs/computers.js` kept the last `computer.progress` in module scope and
// never cleared it when a Settings window or the Computer tab went away. `load()` painted
// synchronously from that stale value, then read `computer.progress` only after
// `computer.list` AND the slow `billing.summary`, one after the other. Every reopen first
// showed the chip and the Stop control as they were when Settings was last open: "Stopped"
// with no Stop while the instance ran (e2e-standard, 01:19Z), or the reverse. A runner that
// took that first paint as settled skipped its cleanup Stop.
//
// What it pins (every chip text painted from mount is recorded by a MutationObserver):
//   1. positive control: STOPPED reads Stopped, no Stop control; on the session's first open
//      with billing.summary held, the summary's late answer repaints the pane (disk shown);
//   2. reopen over a now-RUNNING computer with progress held: never "Stopped"; then Running + Stop;
//   3. tab switch back over a now-STOPPED computer with progress held: never "Running", no Stop;
//   4. ordering: progress is asked alongside billing.summary — with the summary held, the chip
//      reads Running with Stop before the summary answers;
//   5. Stop truth: Stopping… at the confirm; reopened during the stop the chip is Stopping…
//      (never Stopped/Running) until the server says STOPPED, then Stopped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { summaryV3 } from './billing-v3-fixtures.mjs';

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
const dom = new JSDOM(`<!doctype html><html><head><style>${fs.readFileSync(`${OS}/bundle.min.css`, 'utf8')}</style></head><body><div class="desktop"></div></body></html>`,
    { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://ezil.local/os' });
const { window } = dom;
const uncaught = [];
window.addEventListener('error', e => uncaught.push(e.message));
if ( ! window.crypto?.getRandomValues ) window.crypto = { getRandomValues: a => { for ( let i = 0; i < a.length; i++ ) a[i] = (Math.random() * 256) | 0; return a; } };

// ── the stubbed server ──────────────────────────────────────────────────────
/** A held route: `hold()` parks every ask until `release()`. */
const gate = () => {
    let held = false, open = () => {}, wait = Promise.resolve();
    return { hold () { held = true; wait = new Promise(r => { open = r; }); }, release () { held = false; open(); },
        pass () { return held ? wait : undefined; } };
};
const progressGate = gate(), summaryGate = gate(), stopGate = gate();
/** What `computer.progress` answers: the server's lifecycle and operation (STOPPING → operation 'stopping'). */
let lifecycle = 'STOPPED';
const operationOf = state => ['STOPPING', 'DRAINING'].includes(state) ? 'stopping' : 'none';
const calls = [];
const X = { id: 'c-x', name: 'Xenon', slot: 1, createdAt: new Date().toISOString(), lastOpenedAt: null };
const SUMMARY = { ...summaryV3('premium'), computer: { ...summaryV3('premium').computer, disk: { provisionedGiB: 50, usedBytes: null } } };
let summaryAnswered = 0;
window.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push({ url: u, method: opts.method ?? 'GET', at: Date.now() });
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if ( u.includes('/api/trpc/computer.list') ) return json({ result: { data: { json: [X] } } });
    if ( u.includes('/api/trpc/billing.summary') ) {
        await summaryGate.pass();
        summaryAnswered++;
        return json({ result: { data: { json: SUMMARY } } });
    }
    if ( u.includes('/api/trpc/billing.history') ) return json({ result: { data: { json: [] } } });
    if ( u.includes('/api/trpc/computer.progress') ) {
        await progressGate.pass();
        return json({ result: { data: { json: { version: 2, computerId: 'c-x', operation: operationOf(lifecycle), lifecycleState: lifecycle,
            needsOperator: false, transition: null, milestones: [], hardware: { instanceType: 'm6i.large', source: 'placement' } } } } });
    }
    if ( u.endsWith('/api/shell/stop') ) {
        await stopGate.pass();
        return json({ ok: true });
    }
    return json({ error: { json: { message: 'stub', data: { code: 'INTERNAL_SERVER_ERROR' } } } }, 500);
};
const PAYLOAD = {
    user: { id: '11111111-2222-3333-4444-555555555555', email: 'ada@example.com', name: 'Ada', provider: 'google', createdAt: '2026-10-01T18:30:00.000Z' },
    apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop', pinned: true }],
    computer: { ...X, isNew: false }, desktopState: { configured: true }, features: { billing: true },
};
window.__EZIL_BOOT__ = PAYLOAD;
window.eval(fs.readFileSync(`${OS}/icons.js`, 'utf8'));
window.eval(fs.readFileSync(`${OS}/bundle.min.js`, 'utf8'));
const ezil = window.ezil;
ezil.boot();
const $ = window.$;
const doc = window.document;
const tick = (ms = 0) => new Promise(r => window.setTimeout(r, ms));
const settle = async (n = 12, ms = 25) => { for ( let i = 0; i < n; i++ ) await tick(ms); };
const waitFor = async (cond, ms = 3000) => { for ( let t = 0; t < ms && ! cond(); t += 25 ) await tick(25); return cond(); };
const q = (sel) => doc.querySelector(sel);
const click = (el) => el?.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
const ctx = { payload: PAYLOAD, computer: PAYLOAD.computer, desktopState: PAYLOAD.desktopState };
const pane = () => q('.window[data-app="settings"] [data-pane="computers"]');
const chip = () => pane()?.querySelector('[data-role="computer-chip"]')?.textContent.trim() ?? null;
const stopBtn = () => !! pane()?.querySelector('[data-action="stop"]');

async function openComputers () {
    await ezil.registry.launch('settings', ctx);
    await settle(4);
    click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
}
async function closeSettings () {
    $('.window[data-app="settings"]').close();
    await settle(10);
}
/** Every (chip, Stop present) pair painted from now on, the first paint included. */
function recordChips () {
    const seen = [];
    const note = () => {
        const c = chip(), s = stopBtn(), last = seen.at(-1);
        if ( ! last || last.chip !== c || last.stop !== s ) seen.push({ chip: c, stop: s });
    };
    const mo = new window.MutationObserver(note);
    mo.observe(doc.body, { childList: true, subtree: true, characterData: true });
    note();
    return { seen, chips: () => seen.map(e => e.chip), stop: () => mo.disconnect() };
}
const progressAsks = () => calls.filter(c => c.url.includes('/api/trpc/computer.progress')).length;

// 1. Settings opened while the computer is STOPPED (true): the chip says Stopped.
//    The FIRST open of the session, with billing.summary held: progress answers first (the
//    normal order now they are asked together), so the summary's own answer must repaint the
//    pane — no module-scope summary from an earlier window exists yet to paint the disk, and a
//    STOPPED pane's next poll is 20 s away.
lifecycle = 'STOPPED';
summaryGate.hold();
const firstSummaryBefore = summaryAnswered;
await openComputers();
await waitFor(() => chip() === 'Stopped');
push('positive control: a STOPPED computer reads Stopped, no Stop control', chip() === 'Stopped' && ! stopBtn(), `${chip()} stop=${stopBtn()}`);
const paneText = () => (pane()?.textContent ?? '').replace(/\s+/g, ' ').trim();
push('first open, summary held: the disk is not painted before billing.summary answers',
    ! paneText().includes('50 GB disk') && summaryAnswered === firstSummaryBefore, paneText().slice(0, 160));
summaryGate.release();
await waitFor(() => summaryAnswered > firstSummaryBefore);
const diskShown = await waitFor(() => paneText().includes('50 GB disk'), 2000);
push('🔴 first open: billing.summary answering after progress repaints the pane (disk shown well before the 20 s poll)',
    diskShown && chip() === 'Stopped' && ! stopBtn(), `chip=${chip()} stop=${stopBtn()} pane=${paneText().slice(0, 160)}`);

// 2. Close Settings; the computer starts (Code adopted a pool host); reopen while progress is on the wire.
await closeSettings();
lifecycle = 'RUNNING';
progressGate.hold();
const rec = recordChips();
await openComputers();
await settle(20);
push('🔴 reopened over a RUNNING computer, before progress answers: never "Stopped"',
    ! rec.chips().includes('Stopped'), JSON.stringify(rec.seen));
push('🔴 ...and never a missing Stop beside a "Stopped" chip',
    ! rec.seen.some(e => e.chip === 'Stopped' && ! e.stop), JSON.stringify(rec.seen));
progressGate.release();
await waitFor(() => chip() === 'Running');
rec.stop();
push('after progress answers: Running with a Stop control', chip() === 'Running' && stopBtn(), `${chip()} stop=${stopBtn()} trail=${JSON.stringify(rec.seen)}`);

// 3. Tab switch: Computer (RUNNING) → another tab → server STOPPED → back, progress held.
const other = [...doc.querySelectorAll('.window[data-app="settings"] .ezil-settings-tab')].find(el => el.dataset.tab !== 'computers');
click(other); await settle(6);
lifecycle = 'STOPPED';
progressGate.hold();
// Recorded from the switch on: until then the Computer pane is hidden behind the other tab.
click(q('.window[data-app="settings"] .ezil-settings-tab[data-tab="computers"]'));
const rec2 = recordChips();
await settle(20);
push('🔴 back to Computer over a now-STOPPED computer, before progress answers: never "Running" nor a Stop control',
    ! rec2.chips().includes('Running') && ! rec2.seen.some(e => e.stop), JSON.stringify(rec2.seen));
progressGate.release();
await waitFor(() => chip() === 'Stopped');
rec2.stop();
push('after progress answers: Stopped, no Stop', chip() === 'Stopped' && ! stopBtn(), `${chip()} stop=${stopBtn()}`);

// 4. Ordering: lifecycle is asked alongside the (slow) billing summary, not after it.
await closeSettings();
lifecycle = 'RUNNING';
summaryGate.hold();
const answeredBefore = summaryAnswered;
const asksBefore = progressAsks();
await openComputers();
const ranFirst = await waitFor(() => chip() === 'Running' && stopBtn(), 2000);
push('🔴 with billing.summary held, computer.progress is asked and the chip reads Running with Stop',
    ranFirst && progressAsks() > asksBefore && summaryAnswered === answeredBefore,
    `chip=${chip()} stop=${stopBtn()} progressAsks=+${progressAsks() - asksBefore} summaryAnswered=+${summaryAnswered - answeredBefore}`);
summaryGate.release();
await waitFor(() => summaryAnswered > answeredBefore);
await settle(6);
push('after the summary answers: still Running with Stop', chip() === 'Running' && stopBtn(), `${chip()} stop=${stopBtn()}`);

// 5. Stop truth: confirm Stop (Stopping… at once), close and reopen during the stop.
stopGate.hold();
click(pane()?.querySelector('[data-action="stop"]'));
await settle(4);
click(q('[role="dialog"][data-sheet="confirm-stop"] [data-action="confirm"]'));
await settle(2);
push('Stop confirmed: the chip says Stopping… at once', chip() === 'Stopping…', `${chip()}`);
await waitFor(() => calls.some(c => c.url.endsWith('/api/shell/stop')));
lifecycle = 'STOPPING';
await closeSettings();
const rec3 = recordChips();
await openComputers();
const stoppingShown = await waitFor(() => chip() === 'Stopping…');
await settle(10);
push('🔴 reopened during the stop: Stopping…, never Stopped or Running, before the server says STOPPED',
    stoppingShown && ! rec3.chips().includes('Stopped') && ! rec3.chips().includes('Running'), JSON.stringify(rec3.seen));
lifecycle = 'STOPPED';
stopGate.release(); // the closed window's Stop handler answers now; it must not cancel this pane's poll
const settled = await waitFor(() => chip() === 'Stopped', 8000);
rec3.stop();
push('🔴 ...then Stopped (no Stop control) once the server answers STOPPED',
    settled && ! stopBtn(), `${chip()} stop=${stopBtn()} trail=${JSON.stringify(rec3.seen)}`);
push('no uncaught page errors', uncaught.length === 0, uncaught.slice(0, 2).join(' | '));

let failed = 0;
for ( const c of checks ) { if ( ! c.pass ) failed++; console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`); }
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
