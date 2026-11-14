// runtime-recheck-test.mjs — the "came back after the computer idle-stopped"
// rule (`runtime-recheck.js`), driven with a fake clock and fake document /
// window, so the 5-minute rule is exhaustive and instant.
//
// Production 2026-10-04: a frame whose computer had stopped kept its old URL
// and showed raw `410 STALE_PREVIEW_URL`. The window must re-check on return
// and boot again — and must NEVER wake an abandoned computer or loop during a
// boot.
import { watchRuntimeOnReturn, RECHECK_AFTER_AWAY_MS } from './runtime-recheck.js';

const checks = [];
const push = (name, pass, detail = '') => checks.push({ name, pass: !! pass, detail });
const flush = () => new Promise(r => setTimeout(r, 0));

function harness (opts = {}) {
    const running = 'running' in opts ? opts.running : false;
    const live = 'live' in opts ? opts.live : true;
    let t = 1_000_000;
    const doc = new EventTarget();
    doc.visibilityState = 'visible';
    let focused = true;
    doc.hasFocus = () => focused;
    const win = new EventTarget();
    const probes = [];
    let reboots = 0;
    const state = { running, live };
    const stop = watchRuntimeOnReturn({
        computerId: 'c-1',
        isLive: () => state.live,
        reboot: () => { reboots++; },
        desktopRunning: async (id) => { probes.push(id); return state.running; },
        doc, win, now: () => t,
    });
    return {
        state, stop,
        get probes () { return probes; },
        get reboots () { return reboots; },
        hide () { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); },
        show () { doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); },
        blurAway () { focused = false; win.dispatchEvent(new Event('blur')); },
        blurIntoFrame () { win.dispatchEvent(new Event('blur')); },   // hasFocus() stays true
        focusBack () { focused = true; win.dispatchEvent(new Event('focus')); },
        wait (ms) { t += ms; },
    };
}

{
    const h = harness({ running: false });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.show(); await flush();
    push('🔴 back after an absence that could have ended in an idle-stop, computer NOT running -> boot again, once',
        h.probes.length === 1 && h.reboots === 1, `probes=${h.probes.length} reboots=${h.reboots}`);
    h.show(); await flush();
    push('…and a second visibility event with no new absence does nothing (no loop during the reboot)',
        h.probes.length === 1 && h.reboots === 1);
}
{
    const h = harness({ running: true });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.show(); await flush();
    push('back after a long absence, computer still running -> probe only, no reboot', h.probes.length === 1 && h.reboots === 0);
}
{
    const h = harness({ running: undefined });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.show(); await flush();
    push('🔴 no answer from the probe is not an observation -> no reboot', h.reboots === 0);
}
{
    const h = harness({ running: false });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS - 1); h.show(); await flush();
    push('a short absence (shorter than any idle-stop) asks nothing', h.probes.length === 0 && h.reboots === 0);
}
{
    const h = harness({ running: false, live: false });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.show(); await flush();
    push('a window with no live frame (still booting / failed) is left to its own boot path', h.probes.length === 0 && h.reboots === 0);
}
{
    const h = harness({ running: false });
    h.blurAway(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.focusBack(); await flush();
    push('focus returning to a visible-but-unattended window after a long absence also re-checks', h.reboots === 1);
}
{
    const h = harness({ running: false });
    h.blurIntoFrame(); h.wait(RECHECK_AFTER_AWAY_MS + 1); h.focusBack(); await flush();
    push('🔴 clicking into the desktop iframe (window blur, hasFocus() still true) is NOT absence', h.probes.length === 0);
}
{
    const h = harness({ running: false });
    h.hide(); h.wait(RECHECK_AFTER_AWAY_MS + 1);
    push('🔴 while hidden nothing is asked — an abandoned tab never wakes anything', h.probes.length === 0);
    h.stop(); h.show(); await flush();
    push('after the window closes (stop) nothing is asked', h.probes.length === 0 && h.reboots === 0);
}

// Code's opt-in uses a fake scheduler: no real retry delays, GETs, mints or lifecycle calls.
function boundedHarness (answers = []) {
    let t = 1_000_000, scope = 'account:attempt-1', live = true, connected = true, focused = true;
    const doc = new EventTarget(); doc.visibilityState = 'visible'; doc.hasFocus = () => focused;
    const win = new EventTarget(), timers = new Map(), states = [], probes = [];
    let timerId = 0, covers = 0, retry;
    const stop = watchRuntimeOnReturn({ computerId: 'code-1', isLive: () => live, generation: () => scope,
        desktopRunning: async id => { probes.push(id); const value = answers.shift(); if (value instanceof Error) throw value; return value; },
        reboot: () => { covers++; }, retryUnknownMs: 1000, onCheckState: (state, action) => { states.push(state); retry = action; },
        doc, win, now: () => t, online: () => connected,
        schedule: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; }, cancel: id => timers.delete(id),
    });
    return { stop, probes, states, timers, get covers () { return covers; },
        away: async () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); t += RECHECK_AFTER_AWAY_MS + 1;
            doc.visibilityState = 'visible'; doc.dispatchEvent(new Event('visibilitychange')); await flush(); },
        runRetry: async () => { const [id, timer] = [...timers][0] ?? []; if (!timer) return; timers.delete(id); timer.fn(); await flush(); },
        retry: () => retry?.(), changeGeneration: () => { scope = 'account:attempt-2'; },
        hide: () => { doc.visibilityState = 'hidden'; doc.dispatchEvent(new Event('visibilitychange')); },
        offline: () => { connected = false; win.dispatchEvent(new Event('offline')); },
        noFrame: () => { live = false; }, unfocus: () => { focused = false; win.dispatchEvent(new Event('blur')); },
    };
}
{
    const h = boundedHarness([undefined, false]); await h.away();
    push('Code unknown keeps checking and schedules exactly one bounded retry', h.probes.length === 1 && h.covers === 0
        && h.states.join(',') === 'checking' && h.timers.size === 1 && [...h.timers.values()][0].delay === 1000);
    await h.runRetry();
    push('Code retry gets actual false and covers once, never guessing stopped from unknown', h.probes.length === 2 && h.covers === 1 && h.timers.size === 0); h.stop();
}
{
    const h = boundedHarness([undefined, true]); await h.away(); await h.runRetry();
    push('Code retry true clears checking without a stopped cover', h.probes.length === 2 && h.covers === 0 && h.states.at(-1) === 'running'); h.stop();
}
{
    const h = boundedHarness([undefined, undefined, true]); await h.away(); await h.runRetry();
    push('two unknown answers stop automatically with recoverable unknown, no false stopped', h.probes.length === 2 && h.covers === 0
        && h.states.at(-1) === 'unknown' && h.timers.size === 0);
    h.retry(); await flush();
    push('only explicit unknown Retry starts another cheap check', h.probes.length === 3 && h.states.at(-1) === 'running' && h.covers === 0); h.stop();
}
{
    const h = boundedHarness([new Error('synthetic network failure'), false]); await h.away(); await h.runRetry();
    push('a thrown status read is unknown and gets only the one retry', h.probes.length === 2 && h.covers === 1); h.stop();
}
for (const cancel of ['hide', 'offline', 'unfocus', 'changeGeneration', 'noFrame', 'stop']) {
    const h = boundedHarness([undefined, false]); await h.away(); h[cancel](); await h.runRetry();
    push('Code cancels its pending retry on ' + cancel, h.probes.length === 1 && h.covers === 0 && h.timers.size === 0); h.stop();
}
{
    let answer; const pending = new Promise(resolve => { answer = resolve; });
    const h = boundedHarness([pending]); await h.away(); h.stop(); answer(false); await flush();
    push('an already-started bounded GET cannot update UI or retry after close', h.probes.length === 1 && h.covers === 0
        && h.states.join(',') === 'checking' && h.timers.size === 0);
}
{
    let answer; const pending = new Promise(resolve => { answer = resolve; });
    const h = boundedHarness([pending]); await h.away(); h.changeGeneration(); answer(false); await flush();
    push('a late answer from another account/boot generation is discarded', h.probes.length === 1 && h.covers === 0
        && h.states.join(',') === 'checking' && h.timers.size === 0); h.stop();
}
{
    let answer; const pending = new Promise(resolve => { answer = resolve; });
    const h = boundedHarness([pending, true]); await h.away(); await h.away();
    push('a newer return waits for an old in-flight GET instead of overlapping it', h.probes.length === 1);
    answer(false); await flush();
    push('retired false cannot cover a newer return; the queued current check runs once', h.probes.length === 2
        && h.covers === 0 && h.states.at(-1) === 'running'); h.stop();
}

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
