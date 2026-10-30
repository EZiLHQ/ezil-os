import { isNative, selectRuntimeAdapter, sanitizeNativeEvents } from '../../../native-runtime.js';
// tabs/troubleshoot.js — EZiL-authored. Not Puter code.
//
// A way out when the computer is stuck: restart it without losing the
// computer or its workspace. Per the owner's brief:
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
// ── "Restart desktop" is gone (2026-10-30, app-code lane A2) ────────────────
// This tab used to offer TWO restarts. "Restart desktop" posted
// `scope: 'desktop'` (`session.restartDesktop`), which runs
// `systemctl restart ezil-desktop.service` on the computer: Neko and
// code-server restart, files stay, terminals and runtime state are lost. Users
// read it as "refresh the page", which it never was, and it sat next to the
// real recovery action with a near-identical name. Only "Restart computer" is
// offered now. Deliberately KEPT, because other code still relies on them:
// `/api/shell/restart` (Restart computer posts `scope: 'computer'` to it),
// `session.restartDesktop` (unused here; `session.js` is not this lane's), and
// the `ezil:desktop-restarted` listeners in the Code and Browser windows.
//
// 🔴 FEATURE-DETECTED, not assumed. The chain behind this button is three
// independently-deployed pieces: `SHELL_API_ROUTES.restart` ->
// `app/src/app/api/shell/restart/route.ts` -> the Worker. This tab checks only
// the FIRST link, because that is the only one it can see, and `render()`'s
// `! supported` branch draws a disabled button with the honest reason INSTEAD
// OF throwing or guessing a URL. The check reads the live boot payload every
// render, not a value cached at import time, so a deployment that has the key
// picks the control up with no code change here and one that does not
// degrades quietly.
//
// 🔴 HONESTY CONTRACT. A restart is reported "restarted" ONLY when the
// server's own transition (`computer.progress`) says `done`. Everything else —
// including "the request never landed" — renders as `failed`, with the real
// reason, mirroring the rule `session.openDesktop`/`boot-phases.js` already
// hold the rest of this shell to.
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
import { openConfirmSheet } from '../sheet-frame.js';
import log from '../../../log.js';
import session from '../../../session.js';
import trpc from '../trpc.js';
import telemetry from '../../../telemetry.js';
import { ambientCorrelationId } from '../../../trace.js';
import { feedback_enabled, open_feedback_dialog, list_my_reports, delete_my_report } from '../../feedback/feedback.js';
import { TRANSITION_EVENT } from '../../computer-progress.js';

const PHASE = 'ezil-os:settings/troubleshoot';

const TROUBLESHOOT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>'
    + '<circle cx="12" cy="12" r="4"/></svg>';

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
// Round 3 (plan §6.6): "Restart computer" — a confirmed stop, then a start on the
// same configuration, tracked as a server transition (`computer.progress`).
let computerStatus = 'idle'; // 'idle' | 'restarting' | 'restarted' | 'failed'
let computerReason = '';
let computerTransition = null;
let computerTimer = null;
const RESTART_KEY = 'ezil-os:restart.';
/** D11: the AWS ledger cap, distinct from plan time ("Paused until <date>"). */
const AWS_CAP_COPY = "You've used this month's AWS computer time. It resets on the 1st — or contact us.";
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
export function buildDiagnosticReport (nativeEvents = []) {
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
    const native = sanitizeNativeEvents(nativeEvents);
    if (isNative() || native.length) {
        lines.push('', `-- native events (${native.length}) --`);
        for (const e of native) lines.push(telemetry.redact(`${stamp(e.t)} ${e.event}${e.durationMs === undefined ? '' : ` ${e.durationMs}ms`}`));
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
 *   - Transport verdicts: `fetch_failed` / `unauthorized` / `unknown` from
 *     Restart computer's own request below, and `unsupported` / `timeout` /
 *     `bad_request`, which `session.restartDesktop()` (no caller left in this
 *     tab — see the header) still produces and are kept so the copy stays
 *     honest for any future caller.
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
export function reasonCopy (errorCode) {
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
        case 'restart_unavailable': return 'The desktop restart could not be confirmed. Try again in a moment.';
        // ── round 3: the server's distinct restart codes (SWITCH-CONTRACT §2) ──
        case 'restart_not_running': return "Your computer isn't running. Open the desktop to start it.";
        case 'restart_busy': return 'Your computer is starting, stopping or switching. Try again in a minute.';
        case 'restart_budget_exhausted': return 'The desktop was restarted several times in the last few minutes. Wait about 10 minutes, or use Restart computer.';
        case 'restart_host_unreachable': return "We couldn't reach your computer. Try Restart computer.";
        case 'restart_timeout': return "The restart was sent, but the desktop didn't come back within 3 minutes. Try Restart computer.";
        case 'restart_switch_in_progress': return 'A configuration switch is in progress. Try again when it finishes.';
        case 'restart_foreign_computer': return "This computer can't be restarted from here.";
        case 'restart_not_entitled': return "Your plan can't start this computer right now.";
        case 'user_hours_cap': case 'aws_monthly_cap': case 'billing_user_hours_cap': case 'billing_aws_monthly_cap': return AWS_CAP_COPY;
        case 'provider_not_configured': return "This deployment hasn't turned on desktop restarts yet.";
        default: return 'Something went wrong. Please try again.';
    }
}

function render ($win) {
    const $body = $win.find('[data-role="troubleshoot-body"]');
    if ( $body.length === 0 ) return; // pane not mounted (wrong tab active) — nothing to draw yet

    const supported = session.restartEndpoint() !== null;
    const machineId = session.currentComputer()?.id ?? openDesktopComputerId();
    const computerDisabled = computerStatus === 'restarting' || ! supported || ! machineId;
    let computerHtml = '';
    if ( computerStatus === 'restarting' ) {
        computerHtml = '<p class="ezil-settings-muted" data-role="restart-computer-status">Restarting your computer… this usually takes 1–4 minutes. Your files stay.</p>';
    } else if ( computerStatus === 'restarted' ) {
        computerHtml = '<p class="ezil-settings-muted" data-role="restart-computer-status">Your computer restarted. Open the desktop to continue.</p>';
    } else if ( computerStatus === 'failed' ) {
        computerHtml = `<p class="ezil-settings-error" data-role="restart-computer-status">${html_encode(computerReason)}</p>`;
    } else if ( ! supported ) {
        // The honest "route not shipped" state the removed Restart desktop
        // control used to carry for both restarts; it now belongs here.
        computerHtml = '<p class="ezil-settings-muted" data-role="restart-computer-status">Not available in this deployment yet.</p>';
    } else if ( ! machineId ) {
        computerHtml = '<p class="ezil-settings-muted" data-role="restart-computer-status">Open a desktop first, then come back here.</p>';
    }

    // ── the diagnostic-log section ───────────────────────────────────────
    // Counts are read at render time, so re-opening the tab shows what has
    // accumulated since — same "read the live state every render" rule the
    // restart control above follows for `restartEndpoint()`.
    const consoleCount = log.ringBuffer().length;
    const eventCount = telemetry.recentEvents().length;
    const nothingRecorded = !isNative() && consoleCount + eventCount === 0;

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
            ${isNative() ? 'Close and reopen an app to retry its local connection. Cloud sync is disabled. Diagnostics include allowlisted native runtime events.' : `If your computer is frozen or not responding, restart it. Your files are not touched
            by a restart, and the computer itself is not deleted.`}
        </p>
        ${isNative() ? '' : `<h3>Restart computer</h3><p class="ezil-settings-muted">Stops your computer and starts it again. Files stay. 1–4 minutes.</p>
        <button type="button" class="ezil-settings-btn ezil-settings-btn-danger" data-action="restart-computer" ${computerDisabled ? 'disabled' : ''}>${computerStatus === 'restarting' ? 'Restarting…' : 'Restart computer'}</button>
        ${computerHtml}`}
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
        ${feedback_enabled() ? '<button type="button" class="ezil-settings-btn" data-action="report-problem">Report a problem</button>' : ''}
        ${copyHtml}
        ${feedback_enabled() ? `<section aria-label="Your reports">
            <h3>Your reports</h3>
            <button type="button" class="ezil-settings-btn" data-action="load-reports">Load your reports</button>
            <div data-role="feedback-reports" aria-live="polite"></div>
            <p class="ezil-settings-muted">Deleted reports are removed immediately; database backups expire on their own schedule.</p>
        </section>` : ''}
    `);
}

/** The window body the confirm sheet belongs to (it closes with the window). */
const sheetContainer = $win => $win?.find?.('.window-body')?.get?.(0) ?? $win?.get?.(0) ?? document.body;

/**
 * Round 5 (D6): Restart computer confirms through the same dark sheet frame as
 * Switch and Stop (`openConfirmSheet`), never the legacy alert dialog. `begin`
 * runs from the sheet's primary, so the pane shows Restarting… the moment the
 * user confirms; the restart itself runs after the sheet closes. Resolves true
 * only when `begin` took the restart.
 */
async function confirmRestartComputer ($win, begin) {
    let took = false;
    await openConfirmSheet({ container: sheetContainer($win), sheet: 'confirm-restart-computer', title: 'Restart your computer?',
        lines: [
            'Your computer stops and starts again on the same configuration. Open apps close; save your work first.',
            'Your files stay.',
            'This usually takes 1-4 minutes.',
        ],
        confirmLabel: 'Restart computer', busyLabel: 'Restarting…', onConfirm: () => { took = begin(); } });
    return took;
}

function restartRequestId (computerId) {
    const key = RESTART_KEY + computerId;
    let store = null;
    try { store = typeof sessionStorage === 'undefined' ? null : sessionStorage; } catch { store = null; }
    try { const kept = store?.getItem(key); if ( kept && /^[A-Za-z0-9_-]{8,64}$/.test(kept) ) return kept; } catch { /* mint below */ }
    let id = '';
    try { id = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : ''; } catch { id = ''; }
    if ( ! id ) id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    id = id.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64).padEnd(8, '0');
    try { store?.setItem(key, id); } catch { /* the id still works for this click */ }
    return id;
}
function clearRestartRequestId (computerId) {
    try { sessionStorage.removeItem(RESTART_KEY + computerId); } catch { /* nothing kept */ }
}

/** Follow the restart transition the server reported until it is done or failed. */
function watchComputerRestart ($win, computerId) {
    clearTimeout(computerTimer);
    computerTimer = setTimeout(async () => {
        if ( computerStatus !== 'restarting' || ! $win.get(0)?.isConnected ) return;
        const res = await trpc.query('computer.progress', { computerId }).catch(() => ({ ok: false }));
        const t = res?.ok ? res.data?.transition : null;
        if ( t && t.kind === 'restart' && (! computerTransition || t.transitionId === computerTransition) && ['done', 'failed'].includes(t.phase) ) {
            clearRestartRequestId(computerId);
            computerStatus = t.phase === 'done' ? 'restarted' : 'failed';
            computerReason = t.phase === 'done' ? '' : reasonCopy(t.reason) === 'Something went wrong. Please try again.'
                ? "We couldn't restart your computer. Your files are safe. Try again in a moment." : reasonCopy(t.reason);
            if ( t.phase === 'done' ) window.dispatchEvent(new CustomEvent('ezil:computer-restarted', { detail: { computerId } }));
            render($win);
            return;
        }
        watchComputerRestart($win, computerId);
    }, 3000);
}

async function handleRestartComputer ($win) {
    if ( computerStatus === 'restarting' ) return;
    const computerId = session.currentComputer()?.id ?? openDesktopComputerId();
    const url = session.restartEndpoint();
    if ( ! computerId || ! url ) return;
    const confirmed = await confirmRestartComputer($win, () => {
        if ( computerStatus === 'restarting' ) return false;
        computerStatus = 'restarting';
        computerReason = '';
        computerTransition = null;
        render($win);
        return true;
    });
    if ( ! confirmed ) return;
    let answer = null;
    try {
        const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId, scope: 'computer', requestId: restartRequestId(computerId) }) });
        answer = res.status === 401 ? { ok: false, errorCode: 'unauthorized' } : await res.json().catch(() => null);
        if ( ! res.ok && answer?.ok !== false ) answer = { ok: false, errorCode: 'unknown' };
    } catch {
        answer = { ok: false, errorCode: 'fetch_failed' };
    }
    if ( answer?.ok === true ) {
        computerTransition = typeof answer.transitionId === 'string' ? answer.transitionId : null;
        if ( computerTransition ) window.dispatchEvent(new CustomEvent(TRANSITION_EVENT, { detail: { computerId, transitionId: computerTransition } }));
        render($win);
        watchComputerRestart($win, computerId);
        return;
    }
    clearRestartRequestId(computerId);
    computerStatus = 'failed';
    computerReason = reasonCopy(answer?.errorCode);
    telemetry.capture({ eventClass: 'api_failure', site: 'ezil-os:settings/troubleshoot#restart-computer', code: String(answer?.errorCode ?? 'unknown') });
    render($win);
}

async function handleCopyDiagnostics ($win) {
    const nativeEvents = await selectRuntimeAdapter()?.diagnostics() ?? [];
    copyText = buildDiagnosticReport(nativeEvents);
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

// Loading is explicit: opening the feedback form must not cause a request.
// Refresh only this list, so a response cannot replace a newly opened form.
async function loadReports ($win) {
    if ( ! feedback_enabled() ) return;
    const host = $win.find('[data-role="feedback-reports"]')[0];
    if ( ! host ) return;
    host.textContent = 'Loading your reports…';
    host.dataset.loaded = '1';
    try {
        const reports = await list_my_reports();
        if ( ! host.isConnected || ! feedback_enabled() ) return;
        host.textContent = '';
        if ( reports.length === 0 ) { host.textContent = 'You have no reports yet.'; return; }
        const list = document.createElement('ul');
        list.className = 'ezil-feedback-reports';
        for ( const report of reports ) {
            const row = document.createElement('li');
            const heading = document.createElement('strong');
            const date = new Date(report.createdAt);
            const category = { bug: 'Bug', idea: 'Idea', other: 'Other' }[report.category] || 'Report';
            heading.textContent = `${category} · ${Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleDateString()}`;
            const preview = document.createElement('p');
            preview.textContent = String(report.descriptionPreview ?? '').slice(0, 140);
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'ezil-settings-btn';
            remove.textContent = 'Delete';
            remove.addEventListener('click', async () => {
                if ( ! feedback_enabled() || ! window.confirm('Delete this report and its screenshot?') ) return;
                remove.disabled = true;
                const message = document.createElement('p');
                message.className = 'ezil-settings-error';
                try {
                    if ( ! await delete_my_report(report.id) ) throw new Error('delete_failed');
                    row.remove();
                    if ( ! list.children.length ) host.textContent = 'You have no reports yet.';
                } catch {
                    message.textContent = 'Could not delete this report. Try again.';
                    row.append(message);
                    remove.disabled = false;
                }
            });
            row.append(heading, preview, remove);
            list.append(row);
        }
        host.append(list);
    } catch {
        if ( host.isConnected ) host.textContent = 'Could not load your reports. Try again.';
    }
}

function bind ($win) {
    $win.find('[data-role="troubleshoot-body"]')
        .on('click', '[data-action="restart-computer"]', () => { void handleRestartComputer($win); })
        .on('click', '[data-action="copy-diagnostics"]', () => { void handleCopyDiagnostics($win); })
        .on('click', '[data-action="report-problem"]', function () {
            this.focus();
            if ( feedback_enabled() ) open_feedback_dialog({ source: 'troubleshoot' });
        })
        .on('click', '[data-action="load-reports"]', () => { void loadReports($win); });
    // A report sent from anywhere (chip, this pane, or a queued resend on
    // reconnect) shows up in an already-loaded "Your reports" list. Loading
    // stays explicit: an unloaded list is left alone.
    const body = $win.find('[data-role="troubleshoot-body"]')[0];
    const onSent = () => {
        if ( ! body?.isConnected ) { window.removeEventListener('ezil:feedback-sent', onSent); return; }
        if ( $win.find('[data-role="feedback-reports"]')[0]?.dataset.loaded ) void loadReports($win);
    };
    window.addEventListener('ezil:feedback-sent', onSent);
}

export default {
    id: 'troubleshoot',
    label: 'Troubleshoot',
    icon: TROUBLESHOOT_ICON,

    html () {
        return '<div class="ezil-settings-pane-body" data-role="troubleshoot-body"></div>';
    },

    init ($win) {
        computerStatus = 'idle';
        computerReason = '';
        computerTransition = null;
        clearTimeout(computerTimer);
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
