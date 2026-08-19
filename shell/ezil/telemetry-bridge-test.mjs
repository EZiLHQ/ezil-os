// telemetry-bridge-test.mjs — EZiL-authored.
//
// The `postMessage` bridge in `telemetry.js` is the one place this shell
// accepts input from ANOTHER ORIGIN. `worker/assets/neko-branding/www/
// ezil-mobile.js` runs inside the neko document and cannot reach the telemetry
// endpoint itself, so it posts `{source:'ezil-mobile', type, site, code}` to
// the parent and the shell forwards it into `capture()`.
//
// 🔴 A message handler that trusts its payload is a real attack surface, so the
// checks below are mostly NEGATIVE: a message with the right `data` shape but
// the wrong `event.source`, the wrong `event.origin`, an unlisted site, an
// unlisted class, or extra fields must all be DROPPED. The happy path is one
// check; the refusals are the rest.
//
// Run:  node shell/ezil/telemetry-bridge-test.mjs
//
// Uses jsdom + a direct import of `telemetry.js` (not the bundle): the module
// self-installs its `message` listener at import time, and `recentEvents()`
// (its local diagnostic mirror) records a capture even when telemetry is not
// armed — so this file can assert what the bridge accepted with no network,
// no boot payload and no ingest route at all.

import { JSDOM } from 'jsdom';

const checks = [];
const push = (name, pass, detail = '') => {
    checks.push({ name, pass: !! pass, detail });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  [${detail}]` : ''}`);
};

const DESKTOP_ORIGIN = 'https://8181-guac-abc-def-nekodesktop.ezil.org';
const KEYBOARD_SITE = 'ezil-os:apps/desktop#keyboard';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://os.ezil.work/os',
    pretendToBeVisual: true,
});
const { window } = dom;
const { document } = window;

// The globals `telemetry.js` reads. It is a leaf module — no bundle needed.
globalThis.window = window;
globalThis.document = document;
globalThis.location = window.location;
// `navigator` is a getter-only global on modern Node; `telemetry.js` only
// feature-detects `navigator.sendBeacon`, and Node's own `navigator` has none,
// so the fetch path is what would be exercised if this test ever armed. It
// never does — nothing here publishes a telemetry endpoint.
globalThis.MessageEvent = window.MessageEvent;
globalThis.URL = window.URL;

// The desktop window as the shell builds it: a `.window[data-app="desktop"]`
// holding the stream iframe. Same DOM contract `tabs/troubleshoot.js` reads.
document.body.innerHTML = `
  <div class="window" data-app="desktop"><iframe class="window-app-iframe"></iframe></div>
  <div class="window" data-app="preview"><iframe class="window-app-iframe"></iframe></div>
`;
const desktopFrame = document.querySelector('.window[data-app="desktop"] iframe');
const previewFrame = document.querySelector('.window[data-app="preview"] iframe');
// jsdom will not fetch a cross-origin src, but `.src`/`.contentWindow` are
// both real — which is exactly the pair the trust check compares.
desktopFrame.src = `${DESKTOP_ORIGIN}/`;
previewFrame.src = 'https://preview.example/';

const telemetry = await import('./telemetry.js');

let baseline = telemetry.recentEvents().length;
/** Dispatch one message and report how many NEW captures it produced. */
function post({ data, source = desktopFrame.contentWindow, origin = DESKTOP_ORIGIN }) {
    baseline = telemetry.recentEvents().length;
    window.dispatchEvent(new window.MessageEvent('message', { data, origin, source }));
    const after = telemetry.recentEvents();
    return after.slice(baseline);
}

const GOOD = { source: 'ezil-mobile', type: 'window_error', site: KEYBOARD_SITE, code: 'xtest_dead' };

// ── the one accepted shape ──────────────────────────────────────────────────
{
    const got = post({ data: { ...GOOD } });
    push('a well-formed message from the desktop iframe becomes exactly one event',
        got.length === 1, `${got.length} event(s)`);
    push('…recorded under the contract site and class',
        got[0]?.site === KEYBOARD_SITE && got[0]?.eventClass === 'window_error',
        `${got[0]?.eventClass}/${got[0]?.site}`);
    push('…with the code normalised, not forwarded raw',
        got[0]?.code === 'xtest_dead', String(got[0]?.code));
}

{
    const got = post({ data: { ...GOOD, code: 'XTest-Dead!!' } });
    push('🔴 a hostile/odd `code` is normalised to [a-z0-9_], never stored verbatim',
        got[0]?.code === 'xtest_dead', String(got[0]?.code));
}

// ── the refusals ────────────────────────────────────────────────────────────
{
    const got = post({ data: { ...GOOD }, origin: 'https://evil.example' });
    push('🔴 REJECTS a message whose origin is not the iframe\'s own origin', got.length === 0);
}
{
    const got = post({ data: { ...GOOD }, source: window });
    push('🔴 REJECTS a message posted by the top window itself', got.length === 0);
}
{
    const got = post({ data: { ...GOOD }, source: previewFrame.contentWindow, origin: 'https://preview.example' });
    push('🔴 REJECTS a self-consistent message from a DIFFERENT app\'s iframe', got.length === 0);
}
{
    const got = post({ data: { ...GOOD }, source: null });
    push('🔴 REJECTS a message with no source at all', got.length === 0);
}
{
    const got = post({ data: { ...GOOD, site: 'ezil-os:apps/desktop#screen' } });
    push('🔴 REJECTS a site outside the bridge\'s closed set, even from the real frame',
        got.length === 0);
}
{
    const got = post({ data: { ...GOOD, type: 'crash' } });
    push('🔴 REJECTS an eventClass outside the bridge\'s closed set', got.length === 0);
}
{
    const got = post({ data: { ...GOOD, source: 'not-ezil-mobile' } });
    push('REJECTS a message that does not claim to be the mobile script', got.length === 0);
}
{
    const got = post({ data: 'ezil-mobile' });
    push('REJECTS a non-object payload without throwing', got.length === 0);
}

// ── what a hostile page cannot smuggle THROUGH an accepted message ──────────
{
    const got = post({
        data: {
            ...GOOD,
            detail: 'https://evil.example/exfil?cookie=SECRET and /home/user1/workspace/proj',
            attrs: { stack_head: 'attacker@evil.js', app_id: 'not-desktop' },
            correlationId: 'attacker-controlled',
            computerId: '00000000-0000-4000-8000-000000000000',
        },
    });
    push('an accepted message still yields exactly one event', got.length === 1);
    push('🔴 `detail` is NEVER read off a cross-origin message',
        got[0]?.detail === undefined, JSON.stringify(got[0]?.detail));
    const serialized = JSON.stringify(got[0] ?? {});
    push('🔴 nothing attacker-supplied survives anywhere in the event',
        ! serialized.includes('evil.example')
        && ! serialized.includes('SECRET')
        && ! serialized.includes('user1')
        && ! serialized.includes('attacker'),
        serialized);
}

// ── bounded ─────────────────────────────────────────────────────────────────
{
    // Flood it with messages that would otherwise all be accepted. The cap
    // must stop it well before the telemetry buffer (50) could be filled by a
    // cross-origin page alone.
    let refusedAfter = null;
    for ( let i = 0; i < 40; i++ ) {
        if ( post({ data: { ...GOOD } }).length === 0 ) { refusedAfter = i; break; }
    }
    const accepted = telemetry.recentEvents().filter((e) => e.site === KEYBOARD_SITE).length;
    push('🔴 the bridge is bounded per page load — a flood cannot fill the buffer',
        refusedAfter !== null && accepted <= 5,
        `refused after ${refusedAfter} more; ${accepted} accepted in total`);
}

console.log(`\n${checks.filter((c) => c.pass).length}/${checks.length} checks passed`);
if ( checks.some((c) => ! c.pass) ) process.exit(1);
