// Execute production state/return wiring in a DOM; no bundle, server, mint or network.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { watchRuntimeOnReturn, RECHECK_AFTER_AWAY_MS } from '../runtime-recheck.js';

const source = readFileSync(new URL('./code.js', import.meta.url), 'utf8');
function slice(start, end) {
    const a = source.indexOf(start), b = source.indexOf(end, a);
    assert.ok(a >= 0 && b > a, 'production source boundaries exist');
    return source.slice(a, b);
}
const stateSource = slice("    const el_state = document.createElement('div');", '    async function start_boot () {');
const watcherSource = slice('    const stop_runtime_recheck = heartbeat_timer === null', '\n\n    // A completed desktop restart');
// Real attempt++ and show_panel, ending before provider checks or any mint.
const bootPreflight = slice('    async function start_boot () {', '        if ( desktop_state.configured !== true ) {') + '\n}';
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

function fixture(answers = []) {
    const dom = new JSDOM('<main><iframe src="https://synthetic.invalid/old-runtime"></iframe></main>');
    const { document } = dom.window;
    let visible = 'visible', connected = true, clock = 1000, seq = 0;
    Object.defineProperty(document, 'visibilityState', { get: () => visible });
    document.hasFocus = () => true;
    const win = new dom.window.EventTarget(), timers = new Map(), intervals = new Map(), probes = [];
    const context = vm.createContext({
        document, el_body: document.querySelector('main'), el_iframe: document.querySelector('iframe'),
        computer: { id: 'synthetic-computer' }, STOPPED_POLL_MS: 10000, heartbeat_timer: 1,
        progress: { el: document.createElement('div') }, el_unavailable: document.createElement('div'),
        session: { payload: () => ({ user: { id: 'synthetic-user' } }), desktopRunning: async id => {
            probes.push(id); return answers.shift();
        } },
        setInterval: fn => { const id = ++seq; intervals.set(id, fn); return id; },
        clearInterval: id => intervals.delete(id), stop_timers: () => {},
        watchRuntimeOnReturn: opts => watchRuntimeOnReturn({ ...opts, doc: document, win,
            now: () => clock, online: () => connected,
            schedule: (fn, delay) => { const id = ++seq; timers.set(id, { fn, delay }); return id; },
            cancel: id => timers.delete(id) }),
    });
    vm.runInContext('let disposed=false, attempt=1, last_failure, last_progress, generic_timeout, running_signal;', context);
    vm.runInContext(stateSource + bootPreflight + watcherSource
        + '\nglobalThis.api={state:el_state, button:el_state_start, frame:el_iframe, boot:start_boot, bootAttempts:()=>attempt-1, reconnecting:()=>show_state(\'reconnecting\'), stop:stop_runtime_recheck, close:()=>{disposed=true;stop_runtime_recheck();}};', context);
    const api = context.api;
    return { ...api, probes, timers, intervals,
        away: async () => { visible = 'hidden'; document.dispatchEvent(new dom.window.Event('visibilitychange'));
            clock += RECHECK_AFTER_AWAY_MS + 1; visible = 'visible';
            document.dispatchEvent(new dom.window.Event('visibilitychange')); await flush(); },
        hide: () => { visible = 'hidden'; document.dispatchEvent(new dom.window.Event('visibilitychange')); },
        show: () => { visible = 'visible'; document.dispatchEvent(new dom.window.Event('visibilitychange')); },
        offline: () => { connected = false; win.dispatchEvent(new dom.window.Event('offline')); },
        online: () => { connected = true; },
        runRetry: async () => { const [id, timer] = [...timers][0] ?? []; assert.ok(timer); timers.delete(id); timer.fn(); await flush(); },
        done: () => { api.close(); dom.window.close(); },
    };
}

test('pending check covers and makes old iframe inert; true restores only that frame', async () => {
    let resolve; const h = fixture([new Promise(r => { resolve = r; })]);
    try {
        const src = h.frame.src;
        await h.away();
        assert.equal(h.state.dataset.state, 'checking');
        assert.equal(h.state.hidden, false);
        assert.equal(h.state.getAttribute('role'), 'status');
        assert.equal(h.frame.inert, true);
        assert.equal(h.frame.getAttribute('aria-hidden'), 'true');
        assert.equal(h.button.hidden, true);
        h.button.click(); // Even a programmatic click cannot invoke Start while checking.
        assert.equal(h.probes.length, 1);
        assert.equal(h.state.dataset.state, 'checking');
        assert.equal(h.bootAttempts(), 0);
        resolve(true); await flush();
        assert.equal(h.state.hidden, true);
        assert.equal(h.frame.inert, false);
        assert.equal(h.frame.hasAttribute('aria-hidden'), false);
        assert.equal(h.frame.src, src);
        assert.equal(h.bootAttempts(), 0);
        assert.equal(h.probes.length, 1);
    } finally { h.done(); }
});

test('unknown then false shows existing stopped cover; only explicit Start boots', async () => {
    const h = fixture([undefined, false]);
    try {
        await h.away(); await h.runRetry();
        assert.equal(h.state.dataset.state, 'stopped');
        assert.equal(h.button.textContent, 'Start computer');
        assert.equal(h.frame.inert, true);
        assert.equal(h.probes.length, 2);
        assert.equal(h.intervals.size, 1, 'existing read-only stopped poll retained');
        assert.equal(h.bootAttempts(), 0);
        h.button.click();
        assert.equal(h.state.hidden, true, 'explicit Start enters actual boot preflight');
    } finally { h.done(); }
});

test('unknown offers GET-only Retry; hidden/offline retries never become Start', async () => {
    const h = fixture([undefined, undefined, true]);
    try {
        await h.away(); await h.runRetry();
        assert.equal(h.state.dataset.state, 'unknown');
        assert.equal(h.button.textContent, 'Retry');
        assert.equal(h.intervals.size, 0);
        assert.equal(h.timers.size, 0);
        h.hide(); h.button.click(); await flush();
        assert.equal(h.probes.length, 2);
        assert.equal(h.state.dataset.state, 'unknown');
        h.show(); h.offline(); h.button.click(); await flush();
        assert.equal(h.probes.length, 2);
        assert.equal(h.state.dataset.state, 'unknown');
        h.online(); h.button.click(); await flush();
        assert.equal(h.probes.length, 3);
        assert.equal(h.state.hidden, true);
        assert.equal(h.intervals.size, 0);
        assert.equal(h.bootAttempts(), 0);
    } finally { h.done(); }
});

for (const queued of [false, true]) {
    test(`new boot clears Checking and rejects old ${queued ? 'queued retry' : 'pending GET'}`, async () => {
        let resolve;
        const h = fixture(queued ? [undefined, false] : [new Promise(r => { resolve = r; })]);
        try {
            await h.away();
            assert.equal(h.state.dataset.state, 'checking');
            await h.boot(); // Real attempt++ -> show_panel -> hide_state before any boot await.
            assert.equal(h.state.hidden, true);
            assert.equal(h.frame.inert, false);
            if (queued) await h.runRetry(); else { resolve(false); await flush(); }
            assert.equal(h.state.hidden, true, 'old result cannot cover new boot');
            assert.equal(h.probes.length, 1);
            assert.equal(h.timers.size, 0);
        } finally { h.done(); }
    });
}

test('close/hide during pending read discards false and future retry', async () => {
    for (const action of ['close', 'hide']) {
        let resolve; const h = fixture([new Promise(r => { resolve = r; })]);
        try {
            await h.away(); h[action](); resolve(false); await flush();
            assert.notEqual(h.state.dataset.state, 'stopped');
            assert.equal(h.probes.length, 1);
            assert.equal(h.timers.size, 0);
            assert.equal(h.intervals.size, 0);
        } finally { h.done(); }
    }
});

for (const answer of [true, undefined]) {
    test(`return ${answer === true ? 'true' : 'exhausted unknown'} preserves an existing transition cover`, async () => {
        const h = fixture(answer === true ? [true] : [undefined, undefined]);
        try {
            h.reconnecting();
            await h.away();
            assert.equal(h.state.dataset.state, 'reconnecting', 'checking cannot replace transition');
            if (answer === undefined) await h.runRetry();
            assert.equal(h.state.dataset.state, 'reconnecting', 'result cannot retire transition');
            assert.equal(h.state.hidden, false);
            assert.equal(h.button.hidden, true);
            assert.equal(h.frame.inert, true);
            assert.equal(h.frame.getAttribute('aria-hidden'), 'true');
            assert.equal(h.bootAttempts(), 0);
            assert.equal(h.probes.length, answer === true ? 1 : 2);
            assert.equal(h.timers.size, 0);
        } finally { h.done(); }
    });
}

test('a transition arriving during a pending true check keeps its cover', async () => {
    let resolve; const h = fixture([new Promise(r => { resolve = r; })]);
    try {
        await h.away();
        assert.equal(h.state.dataset.state, 'checking');
        h.reconnecting(); resolve(true); await flush();
        assert.equal(h.state.dataset.state, 'reconnecting');
        assert.equal(h.state.hidden, false);
        assert.equal(h.frame.inert, true);
        assert.equal(h.bootAttempts(), 0);
        assert.equal(h.probes.length, 1);
    } finally { h.done(); }
});
