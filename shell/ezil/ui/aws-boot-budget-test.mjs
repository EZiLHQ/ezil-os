// aws-boot-budget-test.mjs — EZiL-authored.
//
// Run: node --test shell/ezil/ui/aws-boot-budget-test.mjs
//
// A cold AWS replace measures 210-250 s against the desktop window's 215 s
// boot budget. While `computer.progress` reports the AWS computer actively
// opening, a TIMEOUT must re-open (never replay the warm result) and keep the
// panel on progress; ten minutes or `needs_operator` end it with Try again;
// with no observation (Cloudflare/native) nothing changes.
//
// Part 1 pins the pure verdicts and copy in `boot-progress.js`. Part 2 drives
// the COMMITTED bundle (`app/public/os`, rebuilt by `shell/build-shell.sh`)
// with fake HTTP and fake clocks, because "a re-open was issued" is a property
// of `apps/desktop-window.js`, not of the pure helpers.

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

// ── Part 1: pure verdicts ────────────────────────────────────────────────
const unitDom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.document = unitDom.window.document;
const {
    AWS_BOOT_HARD_STOP_MS, AWS_BOOT_MAX_REOPENS, BootProgress,
    awsBootTimeoutVerdict, awsBootWaitVerdict, awsStillStartingCopy,
} = await import('./boot-progress.js');

const opening = (extra = {}) => ({ stage: 'starting', activeAws: true, active: true, elapsed: 215, countdown: 'Less than a minute left', ...extra });

test('pure: 215 s timeout while activeAws re-opens', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 215_000 }), 'reopen');
});
test('pure: 600 s on either clock spends the budget', () => {
    assert.equal(AWS_BOOT_HARD_STOP_MS, 600_000);
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 599_999 }), 'reopen');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 600_000 }), 'budget_spent');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening({ elapsed: 600 }), bootElapsedMs: 300_000 }), 'budget_spent');
    assert.equal(awsBootWaitVerdict({ observation: opening(), bootElapsedMs: 599_999 }), 'wait');
    assert.equal(awsBootWaitVerdict({ observation: opening(), bootElapsedMs: 600_000 }), 'budget_spent');
    assert.equal(awsBootWaitVerdict({ observation: null, bootElapsedMs: 600_000 }), 'budget_spent');
    assert.equal(awsBootWaitVerdict({ observation: null, bootElapsedMs: 300_000 }), 'wait', 'a hidden-tab null is not a stop');
});
test('pure: needs_operator / failed_reopened fail immediately', () => {
    const attention = opening({ stage: 'needs_operator', activeAws: false, active: false });
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: attention, bootElapsedMs: 215_000 }), 'fail');
    assert.equal(awsBootWaitVerdict({ observation: attention, bootElapsedMs: 220_000 }), 'fail');
    assert.equal(awsBootWaitVerdict({ observation: opening({ stage: 'failed_reopened', activeAws: false }), bootElapsedMs: 1 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening({ stage: 'operations_paused', activeAws: false }), bootElapsedMs: 215_000 }), 'fail');
});
test('pure: no observation or a non-timeout failure is unchanged', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: null, bootElapsedMs: 215_000 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'desktop_unreachable', observation: opening(), bootElapsedMs: 215_000 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening({ activeAws: false, stage: 'running' }), bootElapsedMs: 215_000 }), 'fail');
});
test('pure: the reopen cap is a structural backstop', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 1, reopens: AWS_BOOT_MAX_REOPENS - 1 }), 'reopen');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 1, reopens: AWS_BOOT_MAX_REOPENS }), 'budget_spent');
});
test('pure: still-starting copy follows the observation countdown, else "still working"', () => {
    assert.equal(awsStillStartingCopy('About 2 min left'), 'Your AWS computer is still starting — about 2 min left.');
    assert.equal(awsStillStartingCopy('Less than a minute left'), 'Your AWS computer is still starting — less than a minute left.');
    assert.equal(awsStillStartingCopy('Almost there — finishing up'), 'Your AWS computer is still starting — still working.');
    assert.equal(awsStillStartingCopy(''), 'Your AWS computer is still starting — still working.');
    assert.equal(awsStillStartingCopy(undefined), 'Your AWS computer is still starting — still working.');
});
test('pure: BootProgress subtext changes, phase rows (checkmarks) do not', () => {
    const plain = BootProgress(); const aws = BootProgress();
    const state = { kind: 'progress', currentPhase: 'connecting', confirmed: false, isRunningLong: true };
    plain.render(state); aws.render(state, { countdown: 'About 3 min left' });
    assert.equal(aws.el.querySelector('.ezil-boot-sub').textContent, 'Your AWS computer is still starting — about 3 min left.');
    assert.notEqual(plain.el.querySelector('.ezil-boot-sub').textContent, aws.el.querySelector('.ezil-boot-sub').textContent);
    const rows = el => [...el.querySelectorAll('.ezil-boot-phase')].map(r => r.dataset.state).join();
    assert.equal(rows(aws.el), rows(plain.el));
    assert.ok(!rows(aws.el).includes('confirmed'), 'no checkmark from a timer');
    aws.render({ kind: 'failed', reason: 'timeout' }, null);
    assert.equal(aws.el.querySelector('.ezil-boot-title').textContent, 'This is taking too long');
    assert.equal(aws.el.querySelector('.ezil-boot-actions').hidden, false);
});

// ── Part 2: the built desktop window ─────────────────────────────────────
const bundle = readFileSync(new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, what = 'condition') {
    for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail(`desktop window did not settle: ${what}`);
}
const timeoutError = () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

async function open(t, progressMode) {
    const dom = new JSDOM('<!doctype html><div id="ezil-os-root"></div>', {
        url: 'https://app.example/os', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
    });
    const { window: w } = dom;
    t.after(() => w.close());
    const errors = [];
    w.addEventListener('error', e => errors.push(e.message));
    t.after(() => assert.deepEqual(errors, []));
    const logs = [];
    w.console.info = (...a) => logs.push(a.join(' '));
    const timeout = w.setTimeout.bind(w), interval = w.setInterval.bind(w);
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 5000 ? 5 : ms === 1500 ? 5 : ms === 4000 ? 15 : ms, ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, ms === 250 ? 5 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    let mode = progressMode, now = 0, perf = 0;
    w.Date.now = () => now;
    Object.defineProperty(w.performance, 'now', { configurable: true, value: () => perf });
    let ready = false;
    const pending = [];
    const asks = () => posts;
    let posts = 0;
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if (path.includes('/api/trpc/computer.progress')) {
            if (mode === 'unavailable') body = { result: { data: { json: { version: 2, computerId: 'computer-1', stage: 'unavailable', active: false, operation: 'none' } } } };
            else body = { result: { data: { json: {
                version: 2, computerId: 'computer-1', operation: 'opening', active: mode !== 'attention',
                stage: mode === 'attention' ? 'needs_operator' : 'starting', recordedStage: mode === 'attention' ? 'unconfirmed' : 'starting',
            } } } };
        } else if (path === '/api/shell/desktop' && init.method === 'POST') {
            posts++;
            if (ready) return { ok: true, status: 200, json: async () => ({ ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', frame: { confirmed: true } }) };
            return new Promise((resolve, reject) => pending.push({ resolve, reject }));
        } else if (path.includes('confirm=frame')) body = { ok: true, confirmed: true, status: 200 };
        else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: false };
        return { ok: true, status: 200, json: async () => body };
    };
    // Each client TIMEOUT costs two POSTs: `withWakeAndOneRetry` re-asks once.
    const timeOutOne = async () => {
        const before = posts;
        await until(() => pending.length > 0, 'a desktop POST in flight');
        pending.shift().reject(timeoutError());
        await until(() => posts > before && pending.length > 0, 'the silent re-ask');
        pending.shift().reject(timeoutError());
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: 'computer-1', name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop' } },
    };
    w.eval(icons); w.eval(bundle);
    await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'), 'taskbar');
    await w.ezil.registry.launch('desktop', { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState });
    const win = await until(() => w.document.querySelector('.window[data-app="desktop"]'), 'window');
    const spinner = win.querySelector('.ezil-app-spinner');
    const panel = win.querySelector('.ezil-boot');
    const visible = () => [spinner, panel].filter(el => !el.hidden);
    const tryAgainVisible = () => visible().some(el => el.querySelector('.ezil-boot-actions')?.hidden === false);
    if (mode !== 'unavailable') await until(() => spinner.querySelector('.ezil-app-spinner-label').textContent === (mode === 'attention' ? 'Computer needs attention' : 'Starting your desktop'), 'observation painted');
    else await until(() => spinner.querySelector('.ezil-app-spinner-sub').textContent === 'Detailed computer progress is unavailable.', 'no observation');
    return {
        w, win, spinner, panel, visible, tryAgainVisible, logs, asks, timeOutOne, pending,
        setMode: m => { mode = m; }, setNow: ms => { now = ms; }, setPerf: ms => { perf = ms; }, setReady: () => { ready = true; },
    };
}

test('desktop: 215 s TIMEOUT while activeAws re-opens and the panel stays on progress', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.asks() === 3 && h.pending.length === 1, 'a re-open POST');
    await wait(30);
    assert.equal(h.spinner.dataset.kind, 'progress');
    assert.equal(h.panel.dataset.kind, 'progress');
    assert.equal(h.tryAgainVisible(), false);
    assert.ok(h.visible().every(el => !el.textContent.includes('This is taking too long')));
    assert.match(h.panel.querySelector('.ezil-boot-sub').textContent, /^Your AWS computer is still starting — /);
    assert.ok(h.logs.some(l => l.includes('re-opening (#1)')), h.logs.join('\n'));
    // The re-open is a real ask, and its success opens the desktop.
    h.setReady();
    h.pending.shift().resolve({ ok: true, status: 200, json: async () => ({ ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', frame: { confirmed: true } }) });
    await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://viewer.example/'), 'desktop frame');
});

test('desktop: 600 s total ends the re-open with the failure and Try again', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.asks() === 3 && h.pending.length === 1, 'a re-open POST');
    h.setPerf(599_000); h.setNow(400_000);
    await wait(30);
    assert.equal(h.panel.dataset.kind, 'progress', 'not before ten minutes');
    h.setPerf(600_000); // The window's clock; the observation's own elapsed is still 400 s.
    await until(() => h.panel.dataset.kind === 'failed', 'hard stop with the re-open still in flight');
    assert.equal(h.pending.length, 1, 'stopped without waiting for the hung request');
    assert.equal(h.panel.querySelector('.ezil-boot-title').textContent, 'This is taking too long');
    await until(() => h.tryAgainVisible(), 'Try again');
    assert.ok(h.logs.some(l => l.includes('budget_spent')), h.logs.join('\n'));
    const before = h.asks();
    h.setReady();
    h.visible().find(el => el.querySelector('.ezil-boot-actions')?.hidden === false).querySelector('.ezil-boot-retry').click();
    await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://viewer.example/'), 'retry opens the desktop');
    assert.ok(h.asks() > before, 'Try again asks the network again');
});

test('desktop: needs_operator at the TIMEOUT fails immediately, no re-open', async t => {
    const h = await open(t, 'attention');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.panel.dataset.kind === 'failed', 'failure');
    await wait(30);
    assert.equal(h.asks(), 2, 'no re-open');
    assert.ok(h.tryAgainVisible());
});

test('desktop: needs_operator during a re-open stops waiting immediately', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.asks() === 3 && h.pending.length === 1, 'a re-open POST');
    h.setMode('attention');
    await until(() => h.panel.dataset.kind === 'failed', 'failure on needs_operator');
    assert.equal(h.pending.length, 1, 'did not wait for the hung request');
    await until(() => h.tryAgainVisible(), 'Try again');
    assert.equal(h.spinner.querySelector('.ezil-app-spinner-label').textContent, 'Computer needs attention');
});

test('desktop: no observation keeps the unchanged 215 s failure', async t => {
    const h = await open(t, 'unavailable');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.spinner.dataset.kind === 'failed', 'failure');
    await wait(30);
    assert.equal(h.asks(), 2, 'no re-open without an observation');
    assert.match(h.spinner.textContent, /This is taking too long/);
    assert.ok(h.tryAgainVisible());
    assert.ok(!h.logs.some(l => l.includes('re-opening')));
});
