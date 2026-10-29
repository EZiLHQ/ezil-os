// desktop-reconnect-test.mjs — EZiL-authored.
//
// Run: EZIL_SHELL_OUT_DIR=<build> node --test shell/ezil/apps/desktop-reconnect-test.mjs
//
// Round 3 (plan §6.5, F6/F7). Drives the built bundle with fake HTTP:
//   - the client milestones: url_received, first_frame (the `[desktop] tti=` line)
//     and first_input (focus moving into the stream, or the viewer's report);
//   - the open desktop window re-opens (same window, same computer) on
//     `ezil:desktop-restarted`, on a relay `relay_runtime_changed`, and when a
//     watched switch settles, instead of ending in "Your desktop isn't answering".

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const assets = process.env.EZIL_SHELL_OUT_DIR;
const bundle = readFileSync(assets ? `${assets}/bundle.min.js` : new URL('../../../app/public/os/bundle.min.js', import.meta.url), 'utf8');
const icons = readFileSync(assets ? `${assets}/icons.js` : new URL('../../../app/public/os/icons.js', import.meta.url), 'utf8');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, what = 'condition') {
    for (let i = 0; i < 600; i++) { const value = fn(); if (value) return value; await wait(5); }
    assert.fail(`desktop window did not settle: ${what}`);
}
const RUNTIME = 'a'.repeat(32);
const VIEWER = 'https://viewer.example';
const atViewer = src => { try { return new URL(src).origin === new URL(VIEWER).origin; } catch { return false; } };

async function open(t, { relay = 'ok' } = {}) {
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
    w.setTimeout = (fn, ms, ...args) => timeout(fn, ms === 5000 ? 5 : ms === 1500 ? 5 : ms === 4000 ? 15 : ms > 1000 && ms <= 60_000 ? 20 : ms, ...args);
    w.setInterval = (fn, ms, ...args) => interval(fn, ms === 250 ? 5 : ms, ...args);
    w.AbortSignal = { timeout: () => undefined };
    let progress = { stage: 'running', operation: 'none', active: false, transition: null };
    let relayAnswer = relay;
    const counts = { desktop: 0, relay: 0 };
    w.fetch = async (raw, init = {}) => {
        const path = String(raw);
        let body = { ok: true };
        if (path.includes('/api/trpc/computer.progress')) {
            body = { result: { data: { json: { version: 2, computerId: 'computer-1', recordedStage: progress.stage, ...progress } } } };
        } else if (path === '/api/shell/desktop' && init.method === 'POST') {
            counts.desktop++;
            body = { ok: true, guacamoleUrl: `${VIEWER}/?embed=1`, frame: { confirmed: true },
                relay: { runtimeId: RUNTIME, expiresAt: Date.now() + 3_600_000 } };
        } else if (path === '/api/shell/relay-refresh') {
            counts.relay++;
            body = relayAnswer === 'changed' ? { ok: false, error: 'relay_runtime_changed' }
                : relayAnswer === 'fail' ? { ok: false, error: 'relay_unavailable' } : { ok: true, runtimeId: RUNTIME, expiresAt: Date.now() + 7_200_000 };
        } else if (path.includes('confirm=frame')) body = { ok: true, confirmed: true, status: 200 };
        else if (path.startsWith('/api/shell/desktop')) body = { ok: true, guacamoleRunning: true };
        return { ok: true, status: 200, json: async () => body };
    };
    w.__EZIL_BOOT__ = {
        user: { id: 'user-1', email: 'test@example.invalid' },
        computer: { id: 'computer-1', name: 'My Computer', slot: 1, isNew: false },
        apps: [{ id: 'desktop', name: 'Linux Desktop', icon: 'desktop', kind: 'desktop' }],
        desktopState: { provider: 'cloudflare-guacamole', configured: true, hasHmacSecret: true, status: 'idle',
            endpoints: { session: '/api/shell/session', desktop: '/api/shell/desktop', relayRefresh: '/api/shell/relay-refresh' } },
    };
    w.eval(icons); w.eval(bundle);
    await until(() => w.document.querySelector('.taskbar-item[data-app="desktop"]'), 'taskbar');
    await w.ezil.registry.launch('desktop', { payload: w.__EZIL_BOOT__, computer: w.__EZIL_BOOT__.computer, desktopState: w.__EZIL_BOOT__.desktopState });
    const win = await until(() => w.document.querySelector('.window[data-app="desktop"]'), 'window');
    const frame = win.querySelector('.window-app-iframe');
    let frames = 0;
    /** The viewer reports decoded frames for its current navigation. */
    const vitals = () => {
        const attempt = new URL(frame.src).searchParams.get('ezilAttempt');
        frames += 10;
        w.dispatchEvent(new w.MessageEvent('message', { origin: VIEWER, source: frame.contentWindow,
            data: { source: 'ezil-mobile', type: 'stream_vitals', attempt,
                vitals: { connectionState: 'connected', bytesReceived: frames * 1000, framesDecoded: frames, width: 1280, height: 720 } } }));
    };
    const live = async () => {
        await until(() => atViewer(frame.src), 'viewer navigated');
        await until(() => { vitals(); return logs.some(l => l.includes('[desktop] tti=')); }, 'first frame');
    };
    /** Close the window and let its in-flight work drain before jsdom goes away. */
    const close = async () => { await until(() => atViewer(frame.src), 'settled'); void w.$(win).close(); await wait(80); };
    return { w, win, frame, logs, counts, live, vitals, close,
        setProgress: p => { progress = { ...progress, ...p }; }, setRelay: a => { relayAnswer = a; } };
}

test('milestones: url_received, then first_frame with the tti line, then first_input on focus into the stream', async t => {
    const h = await open(t);
    await h.live();
    const url = h.logs.find(l => l.startsWith('[desktop] url_received='));
    const tti = h.logs.find(l => l.startsWith('[desktop] tti='));
    assert.ok(url && tti, h.logs.join('\n'));
    assert.match(tti, /^\[desktop\] tti=\d+ path=cloudflare$/);
    assert.ok(h.logs.indexOf(url) < h.logs.indexOf(tti), 'url_received precedes first_frame');
    assert.ok(!h.logs.some(l => l.includes('first_input=')), 'no input yet');
    // The stream is cross-origin: input shows up as focus leaving the shell for the frame.
    Object.defineProperty(h.w.document, 'activeElement', { configurable: true, get: () => h.frame });
    h.w.dispatchEvent(new h.w.Event('blur'));
    h.w.dispatchEvent(new h.w.Event('blur'));
    const inputs = h.logs.filter(l => l.startsWith('[desktop] first_input='));
    assert.equal(inputs.length, 1, 'first_input is stamped once');
    assert.match(inputs[0], /^\[desktop\] first_input=\d+ path=cloudflare$/);
});

test('milestones: the viewer\'s own input report also stamps first_input', async t => {
    const h = await open(t);
    await h.live();
    const attempt = new URL(h.frame.src).searchParams.get('ezilAttempt');
    h.w.dispatchEvent(new h.w.MessageEvent('message', { origin: VIEWER, source: h.frame.contentWindow,
        data: { source: 'ezil-mobile', type: 'input_accepted', attempt } }));
    assert.equal(h.logs.filter(l => l.startsWith('[desktop] first_input=')).length, 1);
});

test('reconnect: ezil:desktop-restarted re-opens the same window', async t => {
    const h = await open(t);
    await h.live();
    const before = h.counts.desktop;
    h.w.dispatchEvent(new h.w.CustomEvent('ezil:desktop-restarted', { detail: { computerId: 'another' } }));
    await wait(30);
    assert.equal(h.counts.desktop, before, 'another computer\'s restart is ignored');
    h.w.dispatchEvent(new h.w.CustomEvent('ezil:desktop-restarted', { detail: { computerId: 'computer-1' } }));
    await until(() => h.counts.desktop > before, 'a re-open POST');
    assert.ok(h.logs.some(l => l.includes('new runtime (desktop_restarted)')), h.logs.join('\n'));
    assert.equal(h.w.document.querySelectorAll('.window[data-app="desktop"]').length, 1, 'same window');
    await h.close();
});

test('reconnect: relay_runtime_changed re-opens instead of counting failures; a second within 20 s fails', async t => {
    const h = await open(t, { relay: 'changed' });
    await h.live();
    const before = h.counts.desktop;
    h.w.dispatchEvent(new h.w.Event('online')); // renewal asks now
    await until(() => h.counts.desktop > before, 'a re-open POST');
    assert.equal(h.counts.relay, 1, 'one refresh, no retry loop');
    assert.notEqual(h.win.dataset.relayState, 'error');
    assert.ok(!h.win.querySelector('.ezil-boot[data-kind="failed"]'), 'no failure panel');
    await until(() => atViewer(h.frame.src), 'viewer re-navigated');
    const again = h.counts.desktop;
    h.w.dispatchEvent(new h.w.Event('online'));
    await until(() => [...h.win.querySelectorAll('[data-kind="failed"]')].length > 0, 'bounded: the second change fails');
    assert.equal(h.counts.desktop, again, 'no second automatic re-open');
});

test('reconnect: a watched switch re-opens the desktop when the server says done', async t => {
    const h = await open(t);
    await h.live();
    const before = h.counts.desktop;
    // An old, settled switch must not trigger anything.
    h.setProgress({ transition: { transitionId: 'old', kind: 'switch', phase: 'done', current: 'std-2', target: 'cmp-4' } });
    h.w.dispatchEvent(new h.w.CustomEvent('ezil:computer-transition', { detail: { computerId: 'computer-1', transitionId: 't-1' } }));
    await wait(60);
    assert.equal(h.counts.desktop, before, 'a different (older) transition is ignored');
    h.setProgress({ stage: 'switching', operation: 'opening', active: true,
        transition: { transitionId: 't-1', kind: 'switch', phase: 'stopping', current: 'std-2', target: 'cmp-4' } });
    await wait(60);
    assert.equal(h.counts.desktop, before, 'nothing re-opens while the switch is in flight');
    h.setProgress({ stage: 'running', operation: 'none', active: false,
        transition: { transitionId: 't-1', kind: 'switch', phase: 'done', current: 'std-2', target: 'cmp-4' } });
    await until(() => h.counts.desktop > before, 'the re-open after done');
    assert.ok(h.logs.some(l => l.includes('switch done; re-opening')), h.logs.join('\n'));
    await wait(60);
    assert.equal(h.counts.desktop, before + 1, 'exactly one re-open');
    await h.close();
});

// The old machine stops about a minute before `done`: the relay then fails for a
// reason other than a runtime change. That must not become "Your desktop isn't answering".
const switching = { stage: 'switching', operation: 'opening', active: true,
    transition: { transitionId: 't-2', kind: 'switch', phase: 'stopping', current: 'std-2', target: 'cmp-8' } };
const switched = { stage: 'running', operation: 'none', active: false,
    transition: { transitionId: 't-2', kind: 'switch', phase: 'done', current: 'std-2', target: 'cmp-8' } };
const failedVisible = h => [...h.win.querySelectorAll('.ezil-app-spinner, .ezil-boot')].some(el => !el.hidden && el.dataset.kind === 'failed');

test('reconnect: relay failures during an announced switch wait in the opening surface, then re-open on done', async t => {
    const h = await open(t);
    await h.live();
    h.setProgress(switching);
    h.w.dispatchEvent(new h.w.CustomEvent('ezil:computer-transition', { detail: { computerId: 'computer-1', transitionId: 't-2' } }));
    const before = h.counts.desktop;
    h.setRelay('fail');
    h.w.dispatchEvent(new h.w.Event('online'));
    await until(() => h.counts.desktop > before, 'a re-open instead of the failure');
    assert.ok(h.counts.relay >= 3, `three refreshes before giving up (${h.counts.relay})`);
    assert.equal(failedVisible(h), false, 'no failure panel');
    assert.ok(h.logs.some(l => l.includes('new runtime (transition_in_flight)')), h.logs.join('\n'));
    const reopened = h.counts.desktop;
    h.setRelay('ok'); h.setProgress(switched);
    await until(() => h.counts.desktop > reopened, 'the re-open after done');
    await h.close();
});

test('reconnect: without the event, a failure caused by an in-flight switch becomes one re-open', async t => {
    const h = await open(t);
    await h.live();
    h.setProgress(switching);
    const before = h.counts.desktop;
    h.setRelay('fail');
    h.w.dispatchEvent(new h.w.Event('online'));
    await until(() => h.counts.desktop > before, 'the in-flight transition turns the failure into a re-open');
    assert.ok(h.logs.some(l => l.includes('new runtime (transition_in_flight)')), h.logs.join('\n'));
    await until(() => !failedVisible(h), 'the opening surface replaces the failure');
    const reopened = h.counts.desktop;
    h.setRelay('ok'); h.setProgress(switched);
    await until(() => h.counts.desktop > reopened, 'the re-open after done');
    await h.close();
});
