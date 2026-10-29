// boot-progress.js — EZiL-authored. Not Puter code.
//
// The inside of the Desktop window while there is no desktop yet.
//
// It renders `boot-phases.js`'s pure state into DOM and NOTHING else: no
// timers, no fetches, no knowledge of what a container is. The caller
// (`apps/desktop-window.js`) owns the clock and the two requests and pushes
// state (and, as an argument, its elapsed time) in.
//
// Round 3: it renders through the one opening surface (`computer-progress.js`
// `OpeningSurface`), the same one `AppSpinner` uses. There is no step list and
// no checkmark: an estimated phase only lifts the bar's floor, the real
// `guacamoleRunning` signal lifts it further, and only the caller's ready event
// (which hides this panel) completes it.

import {
    BOOT_PHASES,
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
    BOOT_PROGRESS_HEADLINE,
    BOOT_UNVERIFIED_COPY,
    TYPICAL_BOOT_MS,
} from '../boot-phases.js';
import { OpeningSurface, OPENING_COPY, formatElapsed, openingFraction, prefersReducedMotion } from './computer-progress.js';

// ── the AWS boot budget ─────────────────────────────────────────────────────
// A cold AWS replace measures 210-250 s, so a TIMEOUT at `DESKTOP_BOOT_TIMEOUT_MS`
// (215 s) is not evidence of failure while `computer.progress` still reports the
// computer actively opening. These two verdicts are pure: the desktop window owns
// the clock and the observation and asks; this file is still never told the time
// except as an argument. Ten minutes matches `app-spinner.js`'s calm Retry.
export const AWS_BOOT_HARD_STOP_MS = 600_000;
/** Structural backstop: a server answering `timeout` instantly cannot loop. */
export const AWS_BOOT_MAX_REOPENS = 6;
const AWS_STOP_STAGES = ['needs_operator', 'failed_reopened'];
// While waiting, also every stage at which the computer is no longer opening
// (computer-progress.js's `activeAws` exclusions). Not `activeAws !== true`:
// that is false at the ready step too, moments before the open succeeds.
const AWS_WAIT_STOP_STAGES = [...AWS_STOP_STAGES, 'stopped', 'queued', 'operations_paused', 'retired', 'purge_eligible'];
const awsBudgetSpent = (observation, bootElapsedMs) => bootElapsedMs >= AWS_BOOT_HARD_STOP_MS
    || (Number.isFinite(observation?.elapsed) && observation.elapsed * 1000 >= AWS_BOOT_HARD_STOP_MS);

/**
 * What a boot attempt that just FAILED should do next.
 *
 *   'reopen'       — a `timeout` while the observation reports `activeAws`:
 *                    ask again (`session.openDesktop`, never a warm replay).
 *   'budget_spent' — the same, but ten minutes (either clock), the reopen cap,
 *                    or the session's own launch/migration clock (the failure
 *                    carried `computeLaunching`/`computeMigrating`: its ten-minute
 *                    loop already ran out) has been reached: failure + Try again.
 *   'fail'         — anything else, including no observation at all: exactly
 *                    the failure the window rendered before this existed.
 *
 * 🔴 A spent launch clock is never re-opened. A warm joined late starts the
 * window's clock after the launch's, and a reopen would keep asking past the
 * server's enrollment expiry, where an ask replaces the host.
 *
 * @param {{reason?: string, observation?: any, bootElapsedMs: number, reopens?: number, sessionClockSpent?: boolean}} input
 * @returns {'reopen' | 'budget_spent' | 'fail'}
 */
export function awsBootTimeoutVerdict ({ reason, observation, bootElapsedMs, reopens = 0, sessionClockSpent = false }) {
    if ( reason !== 'timeout' || ! observation || observation.activeAws !== true ) return 'fail';
    if ( AWS_STOP_STAGES.includes(observation.stage) ) return 'fail';
    return sessionClockSpent || awsBudgetSpent(observation, bootElapsedMs) || reopens >= AWS_BOOT_MAX_REOPENS
        ? 'budget_spent' : 'reopen';
}

/**
 * While a desktop request is in flight: keep waiting, or stop now. A missing
 * observation (hidden tab, failed poll) is not a reason to stop; the clock
 * still bounds it. `clock: false` (the first request, whose own wake loop owns
 * the deadline) lets only the observed stage stop it.
 *
 * @param {{observation?: any, bootElapsedMs: number, clock?: boolean}} input
 * @returns {'wait' | 'budget_spent' | 'fail'}
 */
export function awsBootWaitVerdict ({ observation, bootElapsedMs, clock = true }) {
    if ( observation && AWS_WAIT_STOP_STAGES.includes(observation.stage) ) return 'fail';
    return clock && awsBudgetSpent(observation, bootElapsedMs) ? 'budget_spent' : 'wait';
}

/**
 * The status line while a reopen is in flight and the spinner has no live
 * observation (failed poll, hidden tab). Round 3 dropped countdowns: any
 * argument is ignored, and the line never promises a time.
 */
export function awsStillStartingCopy () {
    return 'Your computer is still starting';
}

// Cloudflare boots have no server milestones; the window's own clock and the
// estimated phase drive the same bar. A phase is an ESTIMATE, so it only lifts
// the floor; `confirmed` (the real `guacamoleRunning` signal) lifts it further.
const PHASE_FLOOR = { waking: 0, mounting: 0.25, starting: 0.45, connecting: 0.6 };
const CONFIRMED_FLOOR = 0.78;

/**
 * Build the panel once. Returns a controller the caller drives; the DOM is
 * created here and only ever UPDATED afterwards, so nothing flashes between
 * ticks. Renders through the same `OpeningSurface` as `AppSpinner`.
 *
 * 🔴 No checkmarks and no step list: the honesty rule now lives in the bar,
 * which reaches 100% only on the caller's ready event and otherwise stays
 * below 90% whatever the clock says.
 *
 * @param {object} opts
 * @param {() => void} opts.onRetry Called by the failure state's Retry button.
 * @param {string} [opts.appName]
 * @param {string} [opts.icon]
 */
export function BootProgress ({ onRetry, appName, icon } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-boot';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');
    let failureCode;
    const surface = OpeningSurface({ appName, icon, onRetry, feedbackCode: () => failureCode });
    surface.el.classList.add('ezil-boot-panel');
    root.appendChild(surface.el);
    let opening = 0, last_elapsed = Infinity;

    /**
     * @param {import('../boot-phases.js').BootUiState} state
     * @param {object | null} [aws] Set only while the window is re-asking because
     *   the AWS observation says the computer is still opening. Changes the
     *   status line only.
     * @param {{elapsedMs?: number}} [extra] The window's boot clock.
     */
    function render (state, aws = null, extra = {}) {
        root.setAttribute('data-kind', state.kind);
        // Round 4: the raw server code (e.g. `billing_files_on_aws`), not the classified reason.
        failureCode = state.kind === 'failed' ? state.errorCode ?? state.reason : undefined;

        if ( state.kind === 'progress' ) {
            root.dataset.phase = state.currentPhase ?? '';
            root.dataset.confirmed = String(state.confirmed === true);
            const elapsed = Number.isFinite(extra?.elapsedMs) ? extra.elapsedMs / 1000 : null;
            // A fresh attempt restarts the window clock: a new opening for the never-regress guard.
            if ( elapsed !== null ) { if ( elapsed < last_elapsed ) opening++; last_elapsed = elapsed; }
            const label = BOOT_PHASES.find(p => p.id === state.currentPhase)?.label ?? BOOT_PROGRESS_HEADLINE;
            const floor = state.confirmed === true ? CONFIRMED_FLOOR : PHASE_FLOOR[state.currentPhase] ?? 0;
            const percent = aws || elapsed === null ? 'indeterminate' : Math.round(100 * openingFraction({
                floor, ceiling: 0.9, elapsed, expected: TYPICAL_BOOT_MS / 1000, reducedMotion: prefersReducedMotion() }));
            surface.paint({
                status: aws ? awsStillStartingCopy() : label, percent, key: `boot-${opening}`,
                meta: elapsed === null ? '' : state.isRunningLong ? `${OPENING_COPY.long} · ${formatElapsed(elapsed)}` : formatElapsed(elapsed),
                long: state.isRunningLong === true,
            });
            return;
        }
        delete root.dataset.phase;

        if ( state.kind === 'not_configured' ) {
            // Nothing to retry: no provider is configured, so the next
            // attempt fails identically. Offering a button would be a lie.
            surface.paint({ status: BOOT_NOT_CONFIGURED_COPY.title, body: BOOT_NOT_CONFIGURED_COPY.body, percent: null });
            return;
        }

        if ( state.kind === 'failed' ) {
            const copy = BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
            surface.paint({ status: copy.title, body: copy.body, percent: null, retry: true, feedback: true });
            return;
        }

        // 'ready' and 'ready_unverified' — the caller is about to swap the
        // iframe in over this panel. Leave the last frame in place rather than
        // blanking it, so there is no white flash between the two.
        //
        // 🔴 The two are NOT the same to the user, and this file is not where
        // the difference is drawn: `ready_unverified` means the desktop is
        // shown but nothing checked it, and `DisplayNotice` below is what says
        // so, on top of the frame.
    }

    return { el: root, render };
}

/**
 * The `ready_unverified` surface: a small, EZiL-branded strip that sits ON TOP
 * of a desktop that is being shown without having been checked.
 *
 * 🔴 WHY THIS EXISTS AT ALL. `ready_unverified` is what the display gate
 * produces when it could not obtain an answer — Neko's session API refused our
 * login, answered a shape we do not recognise, or did not answer. The desktop
 * is still revealed, because hiding a desktop we have no evidence AGAINST would
 * break every working desktop at once the moment that API changes. But
 * revealing it silently would make "we could not check" and "we checked and it
 * is fine" pixel-identical to the user, which is precisely the confusion this
 * whole task exists to remove. So the difference is drawn here, in one strip,
 * in EZiL's own voice.
 *
 * 🔴 NOT A TOAST. It does not auto-dismiss. A notice that disappears on a timer
 * would be a claim retracted by a clock — the same class of lie as a checkmark
 * drawn by one. It goes away when the user dismisses it, when they retry, or
 * when the window is closed.
 *
 * @param {object} opts
 * @param {() => void} opts.onRetry Re-runs the whole boot.
 */
export function DisplayNotice ({ onRetry } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-display-notice';
    root.hidden = true;
    // `alert`, not `status`: unlike the boot phases this is a single message
    // the user has to be able to act on, and it appears over content they are
    // otherwise being invited to treat as working.
    root.setAttribute('role', 'alert');

    root.innerHTML = `
        <div class="ezil-display-notice-text">
            <strong class="ezil-display-notice-title"></strong>
            <span class="ezil-display-notice-body"></span>
        </div>
        <div class="ezil-display-notice-actions">
            <button type="button" class="ezil-display-notice-retry">Try again</button>
            <button type="button" class="ezil-display-notice-dismiss" aria-label="Dismiss">Dismiss</button>
        </div>`;

    root.querySelector('.ezil-display-notice-title').textContent = BOOT_UNVERIFIED_COPY.title;
    root.querySelector('.ezil-display-notice-body').textContent = BOOT_UNVERIFIED_COPY.body;

    const hide = () => { root.hidden = true; };

    // Same `stopPropagation` rule as the Retry button above: these sit inside a
    // `.window-body` and must not reach UIWindow's focus/drag handlers.
    root.querySelector('.ezil-display-notice-retry').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hide();
        if ( typeof onRetry === 'function' ) onRetry();
    });
    root.querySelector('.ezil-display-notice-dismiss').addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        hide();
    });

    return { el: root, show: () => { root.hidden = false; }, hide };
}

export default BootProgress;
