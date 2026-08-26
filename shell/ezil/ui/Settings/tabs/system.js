// tabs/system.js — EZiL-authored. Not Puter code.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS TAB EXISTS
// ═══════════════════════════════════════════════════════════════════════════
// Two things were asked for, and they turn out to be one thing:
//
//   "my settings are not properly showing what my current system is actually
//    linked with"
//   "I need to know the performance of the system, maybe within the settings
//    or a monitor app itself"
//
// Settings could already RENAME and DELETE computers, but nothing anywhere in
// the OS told a user which machine the window in front of them was actually
// talking to, what shape that machine's screen currently is, or whether the
// stream was healthy. This tab answers exactly those questions and nothing
// else.
//
// ═══════════════════════════════════════════════════════════════════════════
// 🔴 EVERY FIELD IS MEASURED OR ABSENT
// ═══════════════════════════════════════════════════════════════════════════
// A monitor that invents a number is worse than no monitor, because it is
// believed. So there is no estimation anywhere in this file:
//
//   * the linked computer comes from the boot payload the shell was handed.
//   * the desktop's screen comes from `session.getScreen()` — an OBSERVATION
//     of the live X display, not the last thing this side asked for. That
//     distinction is the whole reason that route exists.
//   * the stream vitals come from `getStats()` inside the streamed client and
//     arrive by `postMessage`. The shell CANNOT read them itself: the desktop
//     is a cross-origin iframe, so its `RTCPeerConnection` and its `<video>`
//     are unreachable from here by construction.
//
// Anything not known right now renders as an em dash, never as a zero. "0 fps"
// and "not measured yet" are different claims and a monitor must not blur
// them.
//
// ═══════════════════════════════════════════════════════════════════════════
// COST
// ═══════════════════════════════════════════════════════════════════════════
// Vitals are ON DEMAND. This tab asks the client to start publishing when it
// becomes visible and to stop when the window closes or another tab is
// selected, so a session with nobody looking pays nothing — which matters on a
// 2-vCPU container whose budget the encoder already dominates.

import session from '../../../session.js';

const PHASE = 'ezil-os:settings/system';

const SYSTEM_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M8 21h8M9 9h6M9 13h4"/></svg>';

/** Not known right now. Deliberately not `0` — see the header. */
const UNKNOWN = '—';

// ── module state ─────────────────────────────────────────────────────────
let vitals = null;          // the last payload the streamed client published
let vitalsAt = 0;           // when it arrived, so staleness can be shown
let screenObserved = null;  // { width, height } from the live read
let screenError = null;
let refreshTimer = null;
let listening = false;

/** The desktop window's iframe, or null when the desktop is not open. */
function desktopFrame () {
    const el = document.querySelector('.window[data-app="desktop"] iframe.window-app-iframe');
    return el && el.contentWindow ? el.contentWindow : null;
}

/**
 * Ask the streamed client to start or stop publishing vitals.
 *
 * Silent when the desktop is not open: that is a normal state, not a failure,
 * and this tab says so in its own body rather than in the console.
 */
function requestVitals (on) {
    const frame = desktopFrame();
    if ( ! frame ) return;
    try {
        frame.postMessage({ source: 'ezil-shell', type: on ? 'vitals_start' : 'vitals_stop' }, '*');
    } catch ( err ) {
        console.warn(`[${PHASE}] could not reach the streamed client`, err);
    }
}

function onMessage (ev) {
    const d = ev && ev.data;
    if ( ! d || d.source !== 'ezil-mobile' || d.type !== 'stream_vitals' ) return;
    vitals = d.vitals || null;
    vitalsAt = Date.now();
    paint();
}

function startListening () {
    if ( listening ) return;
    window.addEventListener('message', onMessage, false);
    listening = true;
}

function stopListening () {
    if ( ! listening ) return;
    window.removeEventListener('message', onMessage, false);
    listening = false;
}

/**
 * The computer this session is bound to.
 *
 * 🔴 From the `ctx` Settings hands every tab, NOT from `session.payload()`.
 * The other tabs already take it from there, and it is the only source that is
 * populated in every path that can open this window — a Settings window opened
 * without a full boot has no module-level payload to read, and this tab would
 * then report "unknown" for the one fact it exists to state.
 */
let tabCtx = null;

function linkedComputer () {
    if ( tabCtx && tabCtx.computer ) return tabCtx.computer;
    const p = typeof session.payload === 'function' ? session.payload() : null;
    return p && p.computer ? p.computer : null;
}

/**
 * Read what the desktop's screen ACTUALLY is.
 *
 * `getScreen` is an observation, not a memory of the last ask — a container
 * restarted out of band reports its real size here, which is precisely the
 * case a cached value would get wrong.
 */
async function refreshScreen () {
    const computer = linkedComputer();
    if ( ! computer || typeof session.getScreen !== 'function' ) {
        screenObserved = null;
        screenError = 'not available in this deployment';
        return;
    }
    try {
        const res = await session.getScreen(computer.id);
        if ( res && res.ok === true ) {
            screenObserved = { width: res.width, height: res.height };
            screenError = null;
        } else {
            screenObserved = null;
            screenError = (res && res.code) ? String(res.code).toLowerCase().replace(/_/g, ' ') : 'unavailable';
        }
    } catch ( err ) {
        screenObserved = null;
        screenError = 'unreachable';
    }
    paint();
}

function row (label, value, hint) {
    return `<div class="ezil-sys-row">
        <div class="ezil-sys-k">${label}</div>
        <div class="ezil-sys-v">${value}</div>
        ${hint ? `<div class="ezil-sys-h">${hint}</div>` : ''}
    </div>`;
}

function esc (s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function paint () {
    const host = document.querySelector('.ezil-settings-system');
    if ( ! host ) return;

    const computer = linkedComputer();
    const desktopOpen = !! desktopFrame();
    // Older than three publish intervals: the client has stopped talking.
    const stale = vitals && (Date.now() - vitalsAt) > 6500;
    const v = (! vitals || stale) ? null : vitals;

    const num = (x, unit) => (typeof x === 'number' && Number.isFinite(x) ? `${x}${unit ?? ''}` : UNKNOWN);

    host.innerHTML = `
        <h3>System</h3>
        <p class="ezil-sys-lead">What this window is connected to, and how that connection is doing.
           Everything here is measured; anything not known right now shows as ${UNKNOWN}.</p>

        <h4>Linked computer</h4>
        ${row('Name', computer ? esc(computer.name) : UNKNOWN)}
        ${row('Slot', computer && computer.slot != null ? esc(computer.slot) : UNKNOWN)}
        ${row('Identifier', computer ? `<code>${esc(String(computer.id).slice(0, 8))}…</code>` : UNKNOWN,
              'The sandbox this session is bound to.')}

        <h4>Desktop screen</h4>
        ${row('Resolution',
              screenObserved ? `${screenObserved.width} × ${screenObserved.height}` : UNKNOWN,
              screenError
                  ? `Could not read it: ${esc(screenError)}.`
                  : 'Read from the running desktop, not from the last size this browser asked for.')}

        <h4>Stream</h4>
        ${! desktopOpen
            ? '<p class="ezil-sys-note">The desktop window is not open, so there is no stream to measure.</p>'
            : (! v
                ? `<p class="ezil-sys-note">${stale
                        ? 'The streamed client has stopped reporting.'
                        : 'Waiting for the first measurement…'}</p>`
                : `
        ${row('Picture', (v.width && v.height) ? `${v.width} × ${v.height}` : UNKNOWN)}
        ${row('Frame rate', num(v.fps, ' fps'))}
        ${row('Bitrate', num(v.kbps, ' kbit/s'), 'Measured between two samples, so it is blank on the first.')}
        ${row('Round trip', num(v.rttMs, ' ms'),
              'Every session is relayed through TURN — Cloudflare Containers have no UDP — so this has a floor that no quality setting can move.')}
        ${row('Jitter', num(v.jitterMs, ' ms'))}
        ${row('Packets lost', num(v.packetsLost))}`)}
    `;
}

export default {
    id: 'system',
    label: 'System',
    icon: SYSTEM_ICON,

    html () {
        return '<div class="ezil-settings-system"></div>';
    },

    init ($win, ctx) {
        tabCtx = ctx ?? tabCtx;
        paint();
    },

    onActivate ($win, ctx) {
        tabCtx = ctx ?? tabCtx;
        startListening();
        requestVitals(true);
        void refreshScreen();
        paint();
        // The screen is re-read on a slow cadence rather than once: a
        // troubleshoot restart or a window resize changes it while this tab is
        // open, and a monitor showing a value from a minute ago is a monitor
        // that lies quietly.
        if ( ! refreshTimer ) refreshTimer = setInterval(() => { void refreshScreen(); }, 10_000);
    },

    onDeactivate () {
        requestVitals(false);
        stopListening();
        if ( refreshTimer ) { clearInterval(refreshTimer); refreshTimer = null; }
    },
};
