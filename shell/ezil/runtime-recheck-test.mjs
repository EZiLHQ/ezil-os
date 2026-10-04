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

let failed = 0;
for ( const c of checks ) {
    if ( ! c.pass ) failed++;
    console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
