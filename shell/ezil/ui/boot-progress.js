// boot-progress.js — EZiL-authored. Not Puter code.
//
// Round 5 (D5): the `BootProgress` phase PANEL is retired. The Desktop window
// shows one opening surface (`app-spinner.js`) from the first paint to the
// reveal, so nothing swaps at 4 s. What remains here is pure and panel-free:
//
//   - the AWS boot-budget verdicts the desktop window asks (`awsBootTimeoutVerdict`,
//     `awsBootWaitVerdict`) and their constants: the re-open loop, the 600 s
//     hard stop, needs_operator → Try again at once;
//   - `awsStillStartingCopy`, the line a re-open shows without a live observation;
//   - `DisplayNotice`, the `ready_unverified` strip over a revealed desktop.
//
// No timers, no fetches: the caller owns the clock and passes it in.

import { BOOT_UNVERIFIED_COPY } from '../boot-phases.js';

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

