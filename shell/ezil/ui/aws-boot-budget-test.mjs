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
test('pure: a computer that stopped opening ends the wait; one that is ready does not', () => {
    for (const stage of ['stopped', 'queued', 'operations_paused', 'retired', 'purge_eligible']) {
        assert.equal(awsBootWaitVerdict({ observation: opening({ stage, activeAws: false, active: false }), bootElapsedMs: 220_000 }), 'fail', stage);
    }
    // `activeAws` is also false at the ready step: never abandon a reopen that is about to succeed.
    assert.equal(awsBootWaitVerdict({ observation: opening({ stage: 'running', activeAws: false }), bootElapsedMs: 220_000 }), 'wait');
    assert.equal(awsBootWaitVerdict({ observation: opening({ stage: 'ready', activeAws: false }), bootElapsedMs: 220_000 }), 'wait');
});
test('pure: without the clock (first request) only the stage can stop the wait', () => {
    assert.equal(awsBootWaitVerdict({ observation: opening(), bootElapsedMs: 900_000, clock: false }), 'wait');
    assert.equal(awsBootWaitVerdict({ observation: opening({ elapsed: 900 }), bootElapsedMs: 1, clock: false }), 'wait');
    assert.equal(awsBootWaitVerdict({ observation: opening({ stage: 'needs_operator', activeAws: false }), bootElapsedMs: 1, clock: false }), 'fail');
});
test('pure: no observation or a non-timeout failure is unchanged', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: null, bootElapsedMs: 215_000 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'desktop_unreachable', observation: opening(), bootElapsedMs: 215_000 }), 'fail');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening({ activeAws: false, stage: 'running' }), bootElapsedMs: 215_000 }), 'fail');
});
test('pure: a failure from a spent launch/migration loop is never re-opened', () => {
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 300_000, sessionClockSpent: true }), 'budget_spent');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 300_000, sessionClockSpent: false }), 'reopen');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: null, bootElapsedMs: 300_000, sessionClockSpent: true }), 'fail');
});
test('pure: the reopen cap is a structural backstop', () => {
    // A literal, so lowering the cap below what a 600 s budget needs fails here.
    assert.equal(AWS_BOOT_MAX_REOPENS, 6);
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 1, reopens: AWS_BOOT_MAX_REOPENS - 1 }), 'reopen');
    assert.equal(awsBootTimeoutVerdict({ reason: 'timeout', observation: opening(), bootElapsedMs: 1, reopens: AWS_BOOT_MAX_REOPENS }), 'budget_spent');
});
test('pure: still-starting copy never promises a time (round 3: no countdowns)', () => {
    for (const countdown of ['About 2 min left', 'Less than a minute left', '', undefined]) {
        assert.equal(awsStillStartingCopy(countdown), 'Your computer is still starting');
    }
});
test('pure: BootProgress is the one opening surface: status line and bar, no rows or checkmarks', () => {
    const plain = BootProgress({ appName: 'Linux Desktop' }); const aws = BootProgress({ appName: 'Linux Desktop' });
    const state = { kind: 'progress', currentPhase: 'connecting', confirmed: false, isRunningLong: true };
    plain.render(state, null, { elapsedMs: 40_000 }); aws.render(state, {}, { elapsedMs: 40_000 });
    assert.equal(aws.el.querySelector('.ezil-boot-title').textContent, 'Your computer is still starting');
    assert.equal(plain.el.querySelector('.ezil-boot-title').textContent, 'Opening the window');
    assert.equal(plain.el.querySelector('.ezil-opening-name').textContent, 'Linux Desktop');
    assert.equal(plain.el.querySelectorAll('.ezil-boot-phase, ol, li').length, 0, 'no step list');
    assert.equal(plain.el.querySelector('.ezil-opening-meta').textContent, 'Taking a little longer than usual · 0:40');
    const bar = Number(plain.el.querySelector('.ezil-opening-bar').getAttribute('aria-valuenow'));
    assert.ok(bar > 0 && bar <= 90, `a running-long estimate stays below 90% (${bar})`);
    assert.equal(aws.el.querySelector('.ezil-opening-bar').dataset.indeterminate, 'true', 'a reopen without an observation has no basis');
    assert.doesNotMatch(plain.el.textContent, /\d+%|seconds|min left/);
    aws.render({ kind: 'failed', reason: 'timeout' }, null);
    assert.equal(aws.el.querySelector('.ezil-boot-title').textContent, 'This is taking too long');
    assert.equal(aws.el.querySelector('.ezil-boot-actions').hidden, false);
    assert.equal(aws.el.querySelector('.ezil-opening-bar').hidden, true);
});

// ── Part 2: the built desktop window ─────────────────────────────────────
// EZIL_SHELL_OUT_DIR: a bundle built from this tree (`build-shell.sh` honours the same variable).
const assets = process.env.EZIL_SHELL_OUT_DIR;
const bundle = readFileSync(assets ? `${assets}/bundle.min.js` : new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(assets ? `${assets}/icons.js` : new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, what = 'condition') {
    for (let i = 0; i < 400; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail(`desktop window did not settle: ${what}`);
}
const timeoutError = () => Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' });

const abortError = () => Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' });
const launchingBody = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2', computeLaunching: true };

/**
 * @param {string} progressMode 'opening' | 'attention' | 'stopped' | 'unavailable' | 'broken'
 * @param {{ post?: (n: number) => 'hang' | object, frame?: object, probes?: boolean[], running?: boolean }} [opts]
 *   `post` answers the nth desktop POST (default: hang until the test settles it);
 *   `frame` is the ready answer's frame field; `probes` are successive
 *   `confirm=frame` verdicts (the last repeats); `running` is `guacamoleRunning`.
 */
async function open(t, progressMode, opts = {}) {
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
    let post = opts.post ?? (() => 'hang');
    const probes = [...(opts.probes ?? [true])];
    let running = opts.running ?? false;
    const pending = [];
    const signals = [];
    const asks = () => posts;
    let posts = 0;
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if (path.includes('/api/trpc/computer.progress')) {
            if (mode === 'broken') return { ok: false, status: 500, json: async () => ({ error: { code: 'INTERNAL_SERVER_ERROR' } }) };
            if (mode === 'unavailable') body = { result: { data: { json: { version: 2, computerId: 'computer-1', stage: 'unavailable', active: false, operation: 'none' } } } };
            else body = { result: { data: { json: {
                version: 2, computerId: 'computer-1', operation: mode === 'stopped' ? 'none' : 'opening', active: mode === 'opening',
                stage: mode === 'attention' ? 'needs_operator' : mode === 'stopped' ? 'stopped' : 'starting',
                recordedStage: mode === 'attention' ? 'unconfirmed' : mode === 'stopped' ? 'stopped' : 'starting',
            } } } };
        } else if (path === '/api/shell/desktop' && init.method === 'POST') {
            posts++;
            signals.push(init.signal ?? null);
            if (ready) return { ok: true, status: 200, json: async () => ({ ok: true, guacamoleUrl: 'https://viewer.example/?embed=1', frame: opts.frame ?? { confirmed: true } }) };
            const answer = post(posts);
            if (answer !== 'hang') return { ok: true, status: 200, json: async () => answer };
            return new Promise((resolve, reject) => {
                const entry = { resolve, reject };
                pending.push(entry);
                init.signal?.addEventListener('abort', () => {
                    const i = pending.indexOf(entry);
                    if (i >= 0) pending.splice(i, 1);
                    reject(abortError());
                }, { once: true });
            });
        } else if (path.includes('confirm=frame')) {
            const confirmed = probes.length > 1 ? probes.shift() : probes[0];
            body = confirmed ? { ok: true, confirmed: true, status: 200 } : { ok: true, confirmed: false, reason: 'http_error', status: 502 };
        } else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: running };
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
    const tryAgainVisible = () => visible().some(el => el.querySelector('.ezil-boot-actions')?.hidden === false && el.querySelector('.ezil-boot-retry')?.hidden === false);
    if (mode === 'opening' || mode === 'attention') await until(() => spinner.querySelector('.ezil-app-spinner-label').textContent === (mode === 'attention' ? 'Your computer needs attention' : 'Starting your computer'), 'observation painted');
    else if (mode === 'unavailable') await until(() => spinner.dataset.progress === 'unavailable', 'no observation');
    return {
        w, win, spinner, panel, visible, tryAgainVisible, logs, asks, timeOutOne, pending, signals,
        setMode: m => { mode = m; }, setNow: ms => { now = ms; }, setPerf: ms => { perf = ms; }, setReady: () => { ready = true; },
        setPost: fn => { post = fn; }, setRunning: v => { running = v; },
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
    assert.equal(h.panel.querySelector('.ezil-boot-title').textContent, 'Your computer is still starting');
    // What the user actually sees during the re-open is the spinner's live observation.
    assert.equal(h.spinner.hidden, false);
    assert.equal(h.spinner.querySelector('.ezil-app-spinner-label').textContent, 'Starting your computer');
    assert.ok(!/taking (too long|longer than usual)|needs attention/i.test(h.spinner.textContent), h.spinner.textContent);
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
    const reopenSignal = h.signals.at(-1);
    await until(() => h.panel.dataset.kind === 'failed', 'hard stop with the re-open still in flight');
    // The abandoned re-open is CANCELLED, not orphaned: its request is aborted and,
    // even if the hung request still answers, the wake loop never asks again.
    assert.ok(reopenSignal?.aborted === true, 'the abandoned re-open request was aborted');
    const atStop = h.asks();
    for (const p of h.pending.splice(0)) p.reject(timeoutError());
    await wait(40);
    assert.equal(h.asks(), atStop, 'no ask after the hard stop');
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
    const reopenSignal = h.signals.at(-1);
    h.setMode('attention');
    await until(() => h.panel.dataset.kind === 'failed', 'failure on needs_operator');
    // Did not wait for the hung request, and cancelled it rather than orphaning it.
    assert.ok(reopenSignal?.aborted === true, 'the re-open request was aborted');
    assert.equal(h.pending.length, 0);
    await until(() => h.tryAgainVisible(), 'Try again');
    assert.equal(h.spinner.querySelector('.ezil-app-spinner-label').textContent, 'Your computer needs attention');
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

test('desktop: real AWS protocol, warm joined late: a launch that spent its own 10 min is not re-opened', async t => {
    // The warm's launch answer arrives before the window's first observation, so
    // its 600 s launch deadline lands at window time 555 s. Re-opening there would
    // keep asking past the server's ~660 s UNCONFIRMED flip, where an ask replaces
    // the host. The session's own launch clock ran out: that is the budget.
    const h = await open(t, 'unavailable', { post: () => launchingBody });
    await until(() => h.asks() >= 2, 'launching answers');
    h.setPost(() => 'hang');
    h.setNow(45_000); h.setMode('opening');
    await until(() => h.spinner.querySelector('.ezil-app-spinner-label').textContent === 'Starting your computer', 'observation painted');
    await until(() => h.pending.length === 1, 'the wake loop asking');
    h.setPerf(555_000); h.setNow(600_000);
    h.pending.shift().resolve({ ok: true, status: 200, json: async () => launchingBody });
    await until(() => h.tryAgainVisible(), 'Try again when the launch clock is spent');
    const atStop = h.asks();
    await wait(60);
    assert.equal(h.asks(), atStop, 'no ask after the launch budget is spent');
    assert.ok(!h.logs.some(l => l.includes('re-opening')), h.logs.join('\n'));
    assert.match(h.spinner.textContent, /taking longer than usual/);
});

test('desktop: real AWS protocol: a launching re-open is cancelled at the hard stop, never orphaned', async t => {
    const plainStarting = { ok: false, errorCode: 'sandbox_starting', computeProvider: 'aws-ec2' };
    const h = await open(t, 'opening', { post: () => plainStarting });
    await until(() => h.asks() >= 2, 'wake answers');
    // The first request's ordinary 215 s wake deadline passes.
    h.setNow(215_000); h.setPerf(215_000);
    await until(() => h.logs.some(l => l.includes('re-opening (#1)')), 're-open #1');
    // The re-open's answers say a replacement launch is under way (10 min loop).
    h.setPost(() => launchingBody);
    const atReopen = h.asks();
    await until(() => h.asks() >= atReopen + 3, 'the re-open wake loop asking');
    assert.equal(h.tryAgainVisible(), false);
    h.setPerf(600_000);
    await until(() => h.tryAgainVisible(), 'Try again at the hard stop');
    const atStop = h.asks();
    await wait(60);
    assert.equal(h.asks(), atStop, 'the abandoned re-open never asks again (no orphaned replace launch)');
});

test('desktop: two consecutive client TIMEOUTs both re-open and stay on progress', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.logs.some(l => l.includes('re-opening (#1)')), 're-open #1');
    h.setNow(430_000); h.setPerf(430_000);
    await h.timeOutOne();
    await until(() => h.logs.some(l => l.includes('re-opening (#2)')), 're-open #2');
    await wait(30);
    assert.equal(h.panel.dataset.kind, 'progress');
    assert.equal(h.spinner.dataset.kind, 'progress');
    assert.equal(h.tryAgainVisible(), false);
});

test('desktop: closing the window during a re-open cancels it', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await h.timeOutOne();
    await until(() => h.asks() === 3 && h.pending.length === 1, 'a re-open POST');
    const reopenSignal = h.signals.at(-1);
    void h.w.$(h.win).close();
    await until(() => reopenSignal?.aborted === true, 'the re-open request aborted on close');
    const atClose = h.asks();
    await wait(40);
    assert.equal(h.asks(), atClose, 'no ask after close');
});

test('desktop: needs_operator after the first request saw it opening shows Try again at once', async t => {
    const h = await open(t, 'opening');
    await until(() => h.pending.length === 1, 'the first desktop POST');
    const firstSignal = h.signals.at(-1);
    h.setNow(60_000); h.setPerf(60_000);
    h.setMode('attention');
    await until(() => h.tryAgainVisible(), 'Try again before any timeout');
    assert.ok(firstSignal?.aborted === true, 'the first request (the warm) is cancelled');
    const atStop = h.asks();
    await wait(40);
    assert.equal(h.asks(), atStop, 'no ask after needs_operator');
    assert.equal(h.spinner.querySelector('.ezil-app-spinner-label').textContent, 'Your computer needs attention');
});

test('desktop: a computer already needing attention when the window opens is still opened (the open is the recovery)', async t => {
    const h = await open(t, 'attention');
    await until(() => h.pending.length === 1, 'the first desktop POST');
    h.setNow(60_000); h.setPerf(60_000);
    await wait(40);
    assert.equal(h.pending.length, 1, 'the first request is not cancelled by a needs_operator it never saw arise');
    assert.equal(h.tryAgainVisible(), false);
});

test('desktop: a late success (past t0 + 215 s, no re-open) still gets the origin-probe grace', async t => {
    const h = await open(t, 'opening', { frame: undefined, probes: [false, true], running: true });
    await until(() => h.pending.length === 1, 'the first desktop POST');
    h.setNow(245_000); h.setPerf(245_000);
    h.setReady();
    h.pending.shift().resolve({ ok: true, status: 200, json: async () => ({ ok: true, guacamoleUrl: 'https://viewer.example/?embed=1' }) });
    await until(() => h.win.querySelector('.window-app-iframe')?.src?.startsWith('https://viewer.example/'), 'desktop frame');
    await wait(80);
    assert.ok(!h.logs.some(l => l.includes('not a desktop')), h.logs.join('\n'));
    assert.notEqual(h.panel.dataset.kind, 'failed');
    assert.notEqual(h.spinner.dataset.kind, 'failed');
});

test('desktop: a failed poll at the TIMEOUT keeps the last observation, and the panel says only "still starting"', async t => {
    const h = await open(t, 'opening');
    h.setNow(215_000); h.setPerf(215_000);
    await wait(30); // at least one poll at 215 s
    h.setMode('broken');
    await until(() => h.spinner.querySelector('.ezil-app-spinner-sub')?.textContent !== undefined && !h.panel.hidden, 'the poll failed and the phase panel shows');
    await h.timeOutOne();
    await until(() => h.logs.some(l => l.includes('re-opening (#1)')), 're-open on the kept observation');
    await wait(30);
    assert.equal(h.panel.dataset.kind, 'progress');
    assert.equal(h.panel.querySelector('.ezil-boot-title').textContent, 'Your computer is still starting');
});
