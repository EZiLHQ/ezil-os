import { isNative, NATIVE_CAPABILITIES, selectRuntimeAdapter } from '../../../native-runtime.js';
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
//   * the linked computer comes from the session's current selection.
//   * the desktop's screen comes from `session.getScreen()` — an OBSERVATION
//     of the live X display, not the last thing this side asked for. That
//     distinction is the whole reason that route exists.
//   * the machine comes from `session.getSystemInfo()`: the RECORDED placement
//     provider and the CONFIGURED size of that machine (instance type or
//     container class) — labelled as configured, never as a measurement. CPU
//     and memory USE are not reported by any computer yet, and the tab says so.
//     Its image comes from the signed, non-waking sandbox system endpoint; if absent,
//     the row says "Not reported yet". Wording lives in `./system-describe.js`.
//   * the connection route (relayed through TURN or direct) comes from the
//     selected candidate pair the streamed client measured — never from a
//     provider-wide assumption.
//   * the stream vitals come from `getStats()` inside the streamed client and
//     arrive by `postMessage`. The shell CANNOT read them itself: the desktop
//     is a cross-origin iframe, so its `RTCPeerConnection` and its `<video>`
//     are unreachable from here by construction.
//
// Unknown values are labelled or render as an em dash, never as a zero. "0 fps"
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
import { describeImage, describeMachine, describeProvider, describeScreenError, describeTransport, describeUsage, VITALS_STALE_MS } from './system-describe.js';

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
let systemInfo = null;      // `computer.systemInfo`: recorded provider + reported image + configured size
let systemInfoReason = null; // why it is null, when it is
let refreshTimer = null;
let systemInfoTimer = null;
let computerId = null;
let viewGeneration = 0;     // discard reads completed after a switch or tab close
const SYSTEM_INFO_REFRESH_MS = 15_000;
const SYSTEM_INFO_KNOWN_REFRESH_MS = 60_000;
let nativeProvider = { configured: false, pending: false, error: '' };
let nativeTools = null;
let nativePreview = { message: '', pending: false, workspaceId: null, draft: '3000' };
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
 * Follow switches made after Settings opened. The context also supports
 * windows opened without a full boot/session payload.
 */
let tabCtx = null;

function linkedComputer () {
    const current = typeof session.currentComputer === 'function' ? session.currentComputer() : null;
    if ( current ) return current;
    if ( tabCtx && tabCtx.computer ) return tabCtx.computer;
    const p = typeof session.payload === 'function' ? session.payload() : null;
    return p && p.computer ? p.computer : null;
}

function syncComputer () {
    const id = linkedComputer()?.id ?? null;
    if ( id === computerId ) return false;
    computerId = id;
    viewGeneration++;
    clearTimeout(systemInfoTimer);
    systemInfoTimer = null;
    systemInfo = systemInfoReason = screenObserved = screenError = vitals = null;
    vitalsAt = 0;
    paint();
    return true;
}

function isCurrentRead (generation, id) {
    return listening && generation === viewGeneration && id === linkedComputer()?.id;
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
    const generation = viewGeneration;
    if (isNative(tabCtx)) { screenObserved = null; screenError = null; paint(); return; }
    if ( ! computer || typeof session.getScreen !== 'function' ) {
        screenObserved = null;
        screenError = 'not available in this deployment';
        paint();
        return;
    }
    try {
        const res = await session.getScreen(computer.id);
        if ( ! isCurrentRead(generation, computer.id) ) return;
        if ( res && res.ok === true ) {
            screenObserved = { width: res.width, height: res.height };
            screenError = null;
        } else {
            screenObserved = null;
            screenError = describeScreenError(res && res.code, res && res.message);
        }
    } catch ( err ) {
        if ( ! isCurrentRead(generation, computer.id) ) return;
        screenObserved = null;
        screenError = 'unreachable';
    }
    paint();
}

/**
 * Read where this computer runs and the configured size of that machine. A
 * READ: the server never assigns a provider for this call.
 */
async function refreshSystemInfo () {
    syncComputer();
    clearTimeout(systemInfoTimer);
    systemInfoTimer = null;
    const computer = linkedComputer();
    const generation = viewGeneration;
    if ( isNative(tabCtx) ) return;
    if ( ! computer || typeof session.getSystemInfo !== 'function' ) {
        systemInfo = null;
        systemInfoReason = 'UNSUPPORTED';
        paint();
        return;
    }
    try {
        const res = await session.getSystemInfo(computer.id);
        if ( ! isCurrentRead(generation, computer.id) ) return;
        systemInfo = res && res.ok === true ? res.info : null;
        systemInfoReason = res && res.ok === true ? null : (res && res.code) || 'UPSTREAM';
    } catch ( err ) {
        if ( ! isCurrentRead(generation, computer.id) ) return;
        systemInfo = null;
        systemInfoReason = 'UPSTREAM';
    }
    paint();
    const providerKnown = ['aws-ec2', 'cloudflare'].includes(systemInfo?.provider);
    const delay = providerKnown && describeImage(systemInfo).title
        ? SYSTEM_INFO_KNOWN_REFRESH_MS : SYSTEM_INFO_REFRESH_MS;
    systemInfoTimer = setTimeout(() => { void refreshSystemInfo(); }, delay);
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
    const vitalsAge = vitals ? Date.now() - vitalsAt : Infinity;
    const stale = vitals && vitalsAge > VITALS_STALE_MS;
    const v = (! vitals || stale) ? null : vitals;

    const num = (x, unit) => (typeof x === 'number' && Number.isFinite(x) ? `${x}${unit ?? ''}` : UNKNOWN);

    if (isNative(tabCtx)) {
        const previousInput = host.querySelector('#ezil-preview-port');
        const restoreFocus = previousInput && document.activeElement === previousInput;
        if (nativePreview.workspaceId !== computer?.id) {
            nativePreview = { message: '', pending: false, workspaceId: computer?.id,
                draft: localStorage.getItem(`ezil:preview-port:${computer?.id}`) || '3000' };
        } else if (previousInput) nativePreview.draft = previousInput.value;
        host.innerHTML = `<h3>System</h3><h4>On this Mac</h4>
            ${row('Name', esc(computer?.name ?? UNKNOWN))}
            ${row('Programs', 'Run on this Mac', 'Programs run with your Mac account’s permissions.')}
            ${row('Editor', 'Code, with a native terminal')}
            ${row('Microsoft VS Code', nativeTools ? nativeTools.vscodeAvailable ? 'Installed' : 'Not installed' : 'Checking…')}
            ${row('Xcode', nativeTools ? nativeTools.xcodeAvailable ? esc(nativeTools.xcodeVersion || 'Installed') : 'Not installed — install Xcode to build Mac applications' : 'Checking…')}
            ${row('Browser', 'Chromium')}
            ${row('Cloud sync', 'Disabled', 'Your workspace is stored on this Mac.')}
            <h4 style="margin-top:20px">Project preview</h4>
            <p class="ezil-settings-lead">Start your development server in Code, then enter its local port. Open Preview to see your app.</p>
            <form data-native-preview-form style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
              <label for="ezil-preview-port">Port</label><input id="ezil-preview-port" name="port" class="ezil-settings-input" type="number" min="1024" max="65535" value="${esc(nativePreview.draft)}" required style="width:100px">
              <button class="ezil-settings-btn" type="submit" ${nativePreview.pending ? 'disabled' : ''}>Register preview</button>
            </form><p role="status">${esc(nativePreview.message)}</p>
            <h4 style="margin-top:20px">AI provider</h4>
            <p class="ezil-settings-lead">${nativeProvider.error ? esc(nativeProvider.error) : (nativeProvider.configured ? 'A provider is stored in macOS Keychain.' : 'No provider is connected. The desktop and editor work without one.')}</p>
            <div style="display:flex;gap:8px;flex-wrap:wrap">
              <button class="ezil-settings-btn" data-native-provider="azure" ${nativeProvider.pending ? 'disabled' : ''}>Connect Azure</button>
              <button class="ezil-settings-btn" data-native-provider="bedrock" ${nativeProvider.pending ? 'disabled' : ''}>Connect Bedrock</button>
              <button class="ezil-settings-btn" data-native-provider="remove" ${nativeProvider.pending || !nativeProvider.configured ? 'disabled' : ''}>Remove provider</button>
            </div>`;
        if (restoreFocus) host.querySelector('#ezil-preview-port')?.focus();
        return;
    }
    host.innerHTML = `
        <h3>System</h3>
        <p class="ezil-sys-lead">What this window is connected to, and how that connection is doing.
           Each value says whether it is recorded, configured or measured; anything not known right now is labelled or shows as ${UNKNOWN}.</p>

        <h4>Linked computer</h4>
        ${row('Name', computer ? esc(computer.name) : UNKNOWN)}
        ${row('Slot', computer && computer.slot != null ? esc(computer.slot) : UNKNOWN)}
        ${row('Identifier', computer ? `<code>${esc(String(computer.id).slice(0, 8))}…</code>` : UNKNOWN,
              'The sandbox this session is bound to.')}

        <h4>Machine</h4>
        ${(() => { const p = describeProvider(systemInfo, systemInfoReason); return row('Provider', esc(p.value), esc(p.hint)); })()}
        ${(() => { const i = describeImage(systemInfo); return row('Image', i.title ? `<code title="${esc(i.title)}">${esc(i.value)}</code>` : esc(i.value)); })()}
        ${(() => { const m = describeMachine(systemInfo); return row('Size', esc(m.value), esc(m.hint)); })()}
        ${(() => { const u = describeUsage(); return row('CPU and memory use', esc(u.value), esc(u.hint)); })()}

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
        ${(() => { const t = describeTransport(v, vitalsAge, systemInfo ? systemInfo.provider : null); return row('Route', esc(t.value), esc(t.hint)); })()}
        ${row('Round trip', num(v.rttMs, ' ms'), 'Measured on the selected connection route.')}
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
        syncComputer();
        $win.off('submit.ezil-native-preview').on('submit.ezil-native-preview', '[data-native-preview-form]', async function (event) {
            event.preventDefault();
            if (!isNative(tabCtx) || nativePreview.pending) return;
            const port = Number(this.elements.port.value), workspaceId = linkedComputer()?.id;
            nativePreview = { ...nativePreview, pending: true, message: 'Checking the local server…' }; paint();
            const result = await selectRuntimeAdapter(tabCtx).operation({ op: 'preview.register', workspaceId, port });
            if (result.ok) {
                localStorage.setItem(`ezil:preview-port:${workspaceId}`, String(port));
                window.dispatchEvent(new CustomEvent('ezil:preferences-changed'));
            }
            if (nativePreview.workspaceId !== workspaceId) return;
            nativePreview = { ...nativePreview, pending: false, message: result.ok ? `Port ${port} is ready. Open Preview from the dock.` : 'Start Code and its development server, then try again.' }; paint();
        });
        if (isNative(tabCtx)) void selectRuntimeAdapter(tabCtx).operation({ op: 'toolchain.status', workspaceId: linkedComputer()?.id }).then(result => { nativeTools = result.ok ? result.tools : null; paint(); });
        $win.off('click.ezil-native-provider').on('click.ezil-native-provider', '[data-native-provider]', async function () {
            if (!isNative(tabCtx) || nativeProvider.pending) return;
            nativeProvider = { ...nativeProvider, pending: true, error: '' }; paint();
            const action = this.getAttribute('data-native-provider');
            try {
                const runtime = selectRuntimeAdapter(tabCtx);
                const result = await runtime.operation(action === 'remove' ? { op: 'provider.remove' } : { op: 'provider.configure', action });
                if (result?.ok !== true) throw Error('Provider setup did not complete.');
                nativeProvider = { configured: action !== 'remove', pending: false, error: '' };
            } catch { nativeProvider = { ...nativeProvider, pending: false, error: 'Provider setup did not complete.' }; }
            paint();
        });
        if (isNative(tabCtx)) void selectRuntimeAdapter(tabCtx).operation({ op: 'provider.status' }).then(result => {
            nativeProvider = { configured: result?.ok === true && result.configured === true, pending: false, error: '' }; paint();
        });
        paint();
    },

    onActivate ($win, ctx) {
        tabCtx = ctx ?? tabCtx;
        startListening();
        syncComputer();
        requestVitals(true);
        void refreshScreen();
        void refreshSystemInfo();
        paint();
        // The screen is re-read on a slow cadence rather than once: a
        // troubleshoot restart or a window resize changes it while this tab is
        // open, and a monitor showing a value from a minute ago is a monitor
        // that lies quietly.
        if ( ! refreshTimer ) refreshTimer = setInterval(() => {
            if ( syncComputer() ) void refreshSystemInfo();
            void refreshScreen();
        }, 10_000);
    },

    onDeactivate () {
        requestVitals(false);
        stopListening();
        viewGeneration++;
        clearTimeout(systemInfoTimer);
        systemInfoTimer = null;
        if ( refreshTimer ) { clearInterval(refreshTimer); refreshTimer = null; }
    },
};
