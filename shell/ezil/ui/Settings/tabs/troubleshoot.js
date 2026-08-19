// tabs/troubleshoot.js — EZiL-authored. Not Puter code.
//
// A way out when the desktop is stuck: restart the desktop stack inside the
// container without losing the computer, the container, or its workspace. Per
// the owner's brief:
//
//   - Reachable while the desktop is full-bleed. That is exactly the moment a
//     user is stuck — `enter_fullpage_mode` hides the taskbar, and Settings'
//     own two reachability paths (the pinned taskbar icon, and the
//     control-drawer button `../drawer-action.js` injects into a full-bleed
//     window) already solve this for the WHOLE Settings window, this tab
//     included. Nothing new was needed here — see `../index.js`'s header for
//     "Guarantee #1".
//   - Honest states: restarting / restarted / failed-with-reason. Never claim
//     success this tab did not observe.
//   - Confirm before acting, and say what it does and does not destroy.
//   - Feature-detect the restart route and degrade honestly if it is absent.
//
// 🔴 FEATURE-DETECTED, not assumed. The chain behind this button is three
// independently-deployed pieces: `SHELL_API_ROUTES.restart` ->
// `app/src/app/api/shell/restart/route.ts` -> the Worker's
// `POST /sandbox/:name/restart`. This tab checks only the FIRST link, because
// that is the only one it can see, and `render()`'s `! supported` branch draws
// a disabled button with the honest reason INSTEAD OF throwing or guessing a
// URL. The check reads the live boot payload every render, not a value cached
// at import time, so a deployment that has the key picks the control up with
// no code change here and one that does not degrades quietly.
//
// 🔴 WHAT IT ACTUALLY DOES, stated where the copy is written. The Worker
// SIGTERMs the desktop launcher inside the ALREADY-RUNNING container (reusing
// `start-neko.sh`'s own `terminate_stack` trap) and boots the stack again in
// place. The container is not recreated, so files written to the container's
// own disk survive too — but nothing in this shell can verify that, so the
// copy below promises only what the design guarantees: the workspace in
// storage and the computer row.
//
// 🔴 HONESTY CONTRACT. A restart is reported "restarted" ONLY on a 2xx with
// `data.ok === true` (`session.restartDesktop`'s own contract). Everything
// else — including "the request never landed" — renders as `failed`, with
// the real reason, mirroring the rule `session.openDesktop`/`boot-phases.js`
// already hold the rest of this shell to.
//
// ── SECOND CONTROL: the diagnostic log ──────────────────────────────────────
// `shell/ezil/log.js` has kept a 200-entry ring of every `debug`/`info`/
// `warn`/`error` call since the day it was written, for exactly one stated
// reason — "so a support conversation does not depend on the user having had
// devtools open at the time" — and its own header ends "this module's value
// is the RING BUFFER, which nothing yet reads". Nothing did. This tab is the
// reader.
//
// 🔴 WHAT MAY BE COPIED, and why it is not simply the raw ring. The ring holds
// RAW CONSOLE ARGUMENTS: whatever a call site happened to pass, which can
// include a full URL with a query string, an absolute workspace path, or an
// error object carrying either. That is NOT the sanitized closed-vocabulary
// wire format `docs/telemetry.md` describes, and a "copy this and send it to
// support" button turns a local debugging convenience into an export path.
// So every console line is put through the SAME `redact()` the telemetry
// sender uses before it reaches the clipboard — links, absolute paths,
// addresses, uuids and token-shaped strings are replaced. The consequence is
// stated in the UI copy, not buried here, and it is real: `redact()` also
// caps each line at 200 characters, so a very long console line arrives
// shortened.
//
// The second half of the report — `telemetry.recentEvents()` — needs no
// redaction pass of its own: those fields ARE the wire form (hand-written
// low-cardinality `site`/`code`, and a `detail` already through `redact()`).
// It is included because the console ring alone would tell half the story:
// exactly one module writes to `log.js` today, while ~30 call sites across
// this shell report through `telemetry.capture()`.
import UIAlert from '../../../../src/UI/UIAlert.js';
import log from '../../../log.js';
import session from '../../../session.js';
import telemetry from '../../../telemetry.js';
import { ambientCorrelationId } from '../../../trace.js';

const PHASE = 'ezil-os:settings/troubleshoot';

const TROUBLESHOOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'
    + '<circle cx="12" cy="12" r="4"/></svg>';

/** Same construction/reasoning as `tabs/computers.js`'s `ALERT_WARNING_ICON`
 * — neither `UIAlert` icon key this fork kept resolves without one. */
const ALERT_WARNING_ICON = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e0a030" stroke-width="2">'
    + '<path d="M12 3 2 20h20L12 3Z" stroke-linejoin="round"/><path d="M12 10v4M12 17h.01" stroke-linecap="round"/></svg>',
);

const DESKTOP_SELECTOR = '.window[data-app="desktop"]';

/**
 * The computer id the open desktop window streams, or `null` if none is
 * open. Same technique as `tabs/computers.js`'s `openDesktopComputerId()`
 * (read the DOM, not remembered module state — a window is created and
 * destroyed with the thing it describes and cannot go stale behind a
 * rebuild), kept local here rather than imported: importing a sibling tab's
 * private helper across files for four lines was not worth the coupling.
 */
function openDesktopComputerId () {
    const el = document.querySelector(DESKTOP_SELECTOR);
    return el ? el.getAttribute('data-ezil-computer-id') : null;
}

// ── module state ─────────────────────────────────────────────────────────
// A fresh Settings window re-runs `init` from scratch (single_instance means
// there is only ever one) — see `tabs/computers.js`'s header for why module
// state is safe under that lifetime.
let status = 'idle'; // 'idle' | 'restarting' | 'restarted' | 'failed'
let failReason = '';
// 'idle' | 'copied' | 'manual' — 'manual' means the clipboard was unavailable
// (no `navigator.clipboard`, a denied permission, a non-secure origin) and the
// report is shown in a textarea for the user to select and copy by hand.
let copyState = 'idle';
let copyText = '';

// ── the diagnostic report ────────────────────────────────────────────────

/** ISO-8601 UTC. Deliberately not a locale/timezone-formatted string: a
 * timezone is a fingerprinting signal `docs/telemetry.md` lists as never
 * collected, and there is no reason for this report to be the exception. */
function stamp (ms) {
    try { return new Date(ms).toISOString(); } catch { return '(bad timestamp)'; }
}

/**
 * Build the copyable report. Pure apart from reading the two ring buffers and
 * the clock, so what the button copies is exactly what a test can inspect.
 *
 * See this file's header for what is and is not allowed in here.
 */
function buildDiagnosticReport () {
    const console_entries = log.ringBuffer();
    const events = telemetry.recentEvents();
    const trace = ambientCorrelationId();

    const lines = [
        'EZiL OS diagnostic log',
        `generated ${stamp(Date.now())}`,
        `trace ${trace ?? '(none open)'}`,
        `console entries ${console_entries.length}, recorded events ${events.length}`,
        'redacted: links, file paths, addresses, ids and token-like values are replaced;'
            + ' long lines are shortened',
        '',
        `-- console (${console_entries.length}) --`,
    ];
    if ( console_entries.length === 0 ) lines.push('(nothing recorded)');
    for ( const e of console_entries ) {
        // 🔴 The redaction pass. Raw `e.msg` must never reach `lines`.
        lines.push(`${stamp(e.t)} ${e.level} ${telemetry.redact(e.msg) ?? ''}`.trim());
    }

    lines.push('', `-- events (${events.length}) --`);
    if ( events.length === 0 ) lines.push('(nothing recorded)');
    for ( const e of events ) {
        lines.push([stamp(e.t), e.eventClass, e.site, e.code, e.outcome, e.detail ?? '']
            .join(' ').trim());
    }
    return lines.join('\n');
}

/**
 * Best-effort clipboard write. Resolves to `true` only when the write is
 * OBSERVED to succeed — the same honesty rule the restart path above holds
 * itself to. `navigator.clipboard` is absent on a non-secure origin and its
 * promise rejects on a denied permission, and the legacy `execCommand` path
 * does not exist everywhere either, so "we could not copy it for you" is a
 * real state and gets a real UI (the textarea), not a false "Copied".
 */
async function copyToClipboard (text) {
    try {
        if ( typeof navigator !== 'undefined' && navigator.clipboard
            && typeof navigator.clipboard.writeText === 'function' ) {
            await navigator.clipboard.writeText(text);
            return true;
        }
    } catch { /* fall through to the legacy path */ }
    try {
        if ( typeof document.execCommand !== 'function' ) return false;
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', 'readonly');
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok === true;
    } catch {
        return false;
    }
}

/**
 * Two families of code arrive here and both must read as an honest sentence.
 *
 *   - Transport verdicts `session.restartDesktop()` produces itself:
 *     `unsupported` / `timeout` / `fetch_failed` / `unauthorized` /
 *     `bad_request` / `unknown`.
 *   - The Worker's own `RestartReport.outcome`, passed through verbatim by
 *     `app/src/server/api/routers/cloudflare-guacamole.ts`'s `restartDesktop`
 *     as `errorCode` (see `worker/src/sandbox-control.ts`'s
 *     `buildRestartReport`). These are the interesting ones: `stop_timed_out`
 *     in particular is the Worker REFUSING to boot a second stack on top of
 *     one that would not die, which is a materially different situation for
 *     the user than "something went wrong" and must not be flattened into it.
 *
 * Anything unrecognised still lands on the honest default rather than echoing
 * a server string into the DOM.
 */
function reasonCopy (errorCode) {
    switch ( errorCode ) {
        case 'unsupported': return "This deployment hasn't turned on desktop restarts yet.";
        case 'timeout': return 'The request took too long. Your desktop may still be fine — check back in a moment.';
        case 'fetch_failed': return 'Could not reach the server. Check your connection and try again.';
        case 'unauthorized': return 'Your session expired — sign in again.';
        case 'bad_request': return 'Open a desktop first, then come back here.';
        // ── the Worker's own outcomes ──
        case 'stop_timed_out': return 'The desktop would not shut down, so it was left alone rather than '
            + 'started twice. Close the desktop window and open it again; if that does not help, delete '
            + 'the computer and make a new one.';
        case 'boot_failed': return 'The desktop stopped, but did not come back up. Try again in a moment.';
        case 'unsupported_mode': return 'This desktop runs on an older stack that cannot be restarted in place.';
        case 'restart_in_progress': return 'A restart is already running. Give it a few seconds.';
        case 'provider_not_configured': return "This deployment hasn't turned on desktop restarts yet.";
        default: return 'Something went wrong. Please try again.';
    }
}

function render ($win) {
    const $body = $win.find('[data-role="troubleshoot-body"]');
    if ( $body.length === 0 ) return; // pane not mounted (wrong tab active) — nothing to draw yet

    const computerId = openDesktopComputerId();
    const supported = session.restartEndpoint() !== null;

    let statusHtml = '';
    if ( status === 'restarting' ) {
        // ~45s, not ~22s: the Worker waits up to 20s for the old stack to
        // confirm it is gone (`RESTART_STOP_DEADLINE_MS`) BEFORE it starts the
        // ~22s boot. Quoting only the boot half would make a normal restart
        // look overdue while it is still going fine.
        statusHtml = '<p class="ezil-settings-muted">Restarting… this can take up to about 45 seconds.</p>';
    } else if ( status === 'restarted' ) {
        statusHtml = '<p class="ezil-settings-muted">Restart requested. Give it a few seconds, then reopen the '
            + 'desktop from the taskbar or Start menu if it does not reconnect on its own.</p>';
    } else if ( status === 'failed' ) {
        statusHtml = `<p class="ezil-settings-error">${html_encode(failReason)}</p>`;
    } else if ( ! supported ) {
        statusHtml = '<p class="ezil-settings-muted">Not available in this deployment yet.</p>';
    } else if ( ! computerId ) {
        statusHtml = '<p class="ezil-settings-muted">Open a desktop first, then come back here.</p>';
    }

    const disabled = status === 'restarting' || ! supported || ! computerId;
    const label = status === 'restarting' ? 'Restarting…' : 'Restart desktop';

    // ── the diagnostic-log section ───────────────────────────────────────
    // Counts are read at render time, so re-opening the tab shows what has
    // accumulated since — same "read the live state every render" rule the
    // restart control above follows for `restartEndpoint()`.
    const consoleCount = log.ringBuffer().length;
    const eventCount = telemetry.recentEvents().length;
    const nothingRecorded = consoleCount + eventCount === 0;

    let copyHtml = '';
    if ( copyState === 'copied' ) {
        copyHtml = '<p class="ezil-settings-muted">Copied. Paste it into your message to support.</p>';
    } else if ( copyState === 'manual' ) {
        copyHtml = '<p class="ezil-settings-muted">This browser would not let the page write to your '
            + 'clipboard, so here it is to select and copy yourself.</p>'
            + `<textarea class="ezil-settings-diagnostic" data-role="diagnostic-text" readonly rows="10"
                >${html_encode(copyText)}</textarea>`;
    } else if ( nothingRecorded ) {
        copyHtml = '<p class="ezil-settings-muted">Nothing has been recorded yet on this page.</p>';
    }

    $body.html(`
        <p class="ezil-settings-lead">
            If the desktop is frozen or not responding, restarting it can help. This shuts the
            desktop down and starts it again inside the SAME container — your files in
            storage are not touched, and the computer itself is not deleted.
        </p>
        <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="restart"
            ${disabled ? 'disabled' : ''}>${html_encode(label)}</button>
        ${statusHtml}
        <hr class="ezil-settings-rule">
        <p class="ezil-settings-lead">
            EZiL OS keeps a short record of what this page did — ${consoleCount} console
            ${consoleCount === 1 ? 'entry' : 'entries'} and ${eventCount} recorded
            ${eventCount === 1 ? 'event' : 'events'} — so you can send it to support without
            having had developer tools open. It stays in this browser tab until you copy it,
            and it is cleared when you reload. Links, file paths, addresses and anything that
            looks like a password or token are replaced before it is copied, and long lines
            are shortened, so it will not carry your files or your sign-in.
        </p>
        <button type="button" class="ezil-settings-btn" data-action="copy-diagnostics"
            ${nothingRecorded ? 'disabled' : ''}>Copy diagnostic log</button>
        ${copyHtml}
    `);
}

async function confirmRestart () {
    const value = await UIAlert({
        message: '<strong>Restart this desktop?</strong>'
            + '<p>The desktop will shut down and start again inside the same container. Anything '
            + 'unsaved in an open application inside it will be lost. Your workspace in storage, and the '
            + 'computer itself, are not touched.</p>',
        type: 'warning',
        body_icon: ALERT_WARNING_ICON,
        buttons: [
            { label: 'Restart', value: 'confirm', type: 'danger' },
            { label: 'Cancel', value: 'cancel', type: 'secondary' },
        ],
    });
    return value === 'confirm';
}

async function handleRestart ($win) {
    if ( status === 'restarting' ) return;
    const computerId = openDesktopComputerId();
    if ( ! computerId ) return;

    const confirmed = await confirmRestart();
    if ( ! confirmed ) return;

    status = 'restarting';
    render($win);

    const res = await session.restartDesktop(computerId);

    if ( res.ok ) {
        status = 'restarted';
    } else {
        status = 'failed';
        failReason = reasonCopy(res.errorCode);
        console.error(`[${PHASE}] restart failed: ${res.errorCode}`);
        // `unsupported` is a feature-detection result, not an operational
        // failure — nothing went wrong, the route just is not there yet, so
        // it is not worth a telemetry row (see `session.restartEndpoint()`'s
        // header). Everything else is a real `api_failure`, same convention
        // `code.js`/`preview.js`/`desktop-window.js` use for their own mints.
        if ( res.errorCode !== 'unsupported' ) {
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:settings/troubleshoot#restart', code: res.errorCode,
            });
        }
    }
    render($win);
}

async function handleCopyDiagnostics ($win) {
    copyText = buildDiagnosticReport();
    copyState = (await copyToClipboard(copyText)) ? 'copied' : 'manual';
    render($win);
    if ( copyState === 'manual' ) {
        // Put the caret in the box so "select all, copy" is one keystroke.
        const ta = $win.find('[data-role="diagnostic-text"]')[0];
        if ( ta && typeof ta.select === 'function' ) {
            try { ta.focus(); ta.select(); } catch { /* focus is a nicety, never a failure */ }
        }
    }
}

function bind ($win) {
    $win.find('[data-role="troubleshoot-body"]')
        .on('click', '[data-action="restart"]', () => { void handleRestart($win); })
        .on('click', '[data-action="copy-diagnostics"]', () => { void handleCopyDiagnostics($win); });
}

export default {
    id: 'troubleshoot',
    label: 'Troubleshoot',
    icon: TROUBLESHOOT_ICON,

    html () {
        return '<div class="ezil-settings-pane-body" data-role="troubleshoot-body"></div>';
    },

    init ($win) {
        status = 'idle';
        failReason = '';
        copyState = 'idle';
        copyText = '';
        bind($win);
        render($win);
    },

    onActivate ($win) {
        // Re-render on activation: whether a desktop is open and whether
        // restarting is supported can both have changed since this pane last
        // drew (a window opened/closed, a rehydrate refreshed the payload).
        render($win);
    },
};
