// boot-progress.js — EZiL-authored. Not Puter code.
//
// The inside of the Desktop window while there is no desktop yet.
//
// It renders `boot-phases.js`'s pure state into DOM and NOTHING else: no
// timers, no fetches, no knowledge of what a container is. The caller
// (`apps/desktop-window.js`) owns the clock and the two requests and pushes
// state in. That split is what makes the honesty constraint enforceable —
// this file physically cannot invent a phase, because it is never told the
// time.
//
// 🔴 The one rule inherited from `boot-phases.js`: a checkmark is a CLAIM.
// Only `phaseVisualState() === 'confirmed'` draws one, and that state is
// reachable only from the real `guacamoleRunning` signal. `passed` and
// `current` are estimates and are drawn as estimates. A spinner that fills
// four checkmarks on a timer while the container is dead is worse than no
// progress at all, because the user then blames themselves.

import {
    BOOT_PHASES,
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
    BOOT_PROGRESS_HEADLINE,
    BOOT_PROGRESS_LONG_SUBTEXT,
    BOOT_PROGRESS_SUBTEXT,
    BOOT_UNVERIFIED_COPY,
    phaseVisualState,
} from '../boot-phases.js';

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
const awsBudgetSpent = (observation, bootElapsedMs) => bootElapsedMs >= AWS_BOOT_HARD_STOP_MS
    || (Number.isFinite(observation?.elapsed) && observation.elapsed * 1000 >= AWS_BOOT_HARD_STOP_MS);

/**
 * What a boot attempt that just FAILED should do next.
 *
 *   'reopen'       — a `timeout` while the observation reports `activeAws`:
 *                    ask again (`session.openDesktop`, never a warm replay).
 *   'budget_spent' — the same, but ten minutes (either clock) or the reopen cap
 *                    has been reached: the existing failure + Try again.
 *   'fail'         — anything else, including no observation at all: exactly
 *                    the failure the window rendered before this existed.
 *
 * @param {{reason?: string, observation?: any, bootElapsedMs: number, reopens?: number}} input
 * @returns {'reopen' | 'budget_spent' | 'fail'}
 */
export function awsBootTimeoutVerdict ({ reason, observation, bootElapsedMs, reopens = 0 }) {
    if ( reason !== 'timeout' || ! observation || observation.activeAws !== true ) return 'fail';
    if ( AWS_STOP_STAGES.includes(observation.stage) ) return 'fail';
    return awsBudgetSpent(observation, bootElapsedMs) || reopens >= AWS_BOOT_MAX_REOPENS ? 'budget_spent' : 'reopen';
}

/**
 * While a reopen is in flight: keep waiting, or stop now. A missing observation
 * (hidden tab, failed poll) is not a reason to stop; the clock still bounds it.
 *
 * @param {{observation?: any, bootElapsedMs: number}} input
 * @returns {'wait' | 'budget_spent' | 'fail'}
 */
export function awsBootWaitVerdict ({ observation, bootElapsedMs }) {
    if ( observation && AWS_STOP_STAGES.includes(observation.stage) ) return 'fail';
    return awsBudgetSpent(observation, bootElapsedMs) ? 'budget_spent' : 'wait';
}

/**
 * The phase panel's subtext while a reopen is in flight, from the observation's
 * own countdown ("About 2 min left", "Less than a minute left"); anything else,
 * including "Almost there" past the typical time, is only "still working".
 *
 * @param {string} [countdown]
 */
export function awsStillStartingCopy (countdown) {
    const left = typeof countdown === 'string' && /^(About \d+ min|Less than a minute) left$/.test(countdown)
        ? countdown[0].toLowerCase() + countdown.slice(1) : 'still working';
    return `Your AWS computer is still starting — ${left}.`;
}

const CHECK = '<svg class="ezil-boot-check" viewBox="0 0 16 16" aria-hidden="true">'
    + '<path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></svg>';

/**
 * Build the panel once. Returns a controller the caller drives; the DOM is
 * created here and only ever UPDATED afterwards, so nothing flashes between
 * ticks and the phase rows never re-mount mid-animation.
 *
 * @param {object} opts
 * @param {() => void} opts.onRetry Called by the failure state's Retry button.
 */
export function BootProgress ({ onRetry } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-boot';
    root.setAttribute('role', 'status');
    // The phase list changes on a timer; announcing every change would make a
    // screen reader read four labels over 22 seconds. The headline and the
    // failure copy are the parts worth announcing, so politeness lives there.
    root.setAttribute('aria-live', 'polite');

    root.innerHTML = `
        <div class="ezil-boot-panel">
            <div class="ezil-boot-mark" aria-hidden="true"></div>
            <h1 class="ezil-boot-title"></h1>
            <p class="ezil-boot-sub"></p>
            <ol class="ezil-boot-phases"></ol>
            <div class="ezil-boot-actions">
                <button type="button" class="ezil-boot-retry">Try again</button>
            </div>
        </div>`;

    const el_title = root.querySelector('.ezil-boot-title');
    const el_sub = root.querySelector('.ezil-boot-sub');
    const el_phases = root.querySelector('.ezil-boot-phases');
    const el_actions = root.querySelector('.ezil-boot-actions');
    const el_retry = root.querySelector('.ezil-boot-retry');

    // One row per phase, created once and reused. `data-phase` is the hook
    // the tests and the CSS both read.
    const rows = new Map();
    for ( const phase of BOOT_PHASES ) {
        const li = document.createElement('li');
        li.className = 'ezil-boot-phase';
        li.setAttribute('data-phase', phase.id);
        li.setAttribute('data-state', 'upcoming');
        li.innerHTML = `<span class="ezil-boot-dot" aria-hidden="true">${CHECK}</span>`
            + `<span class="ezil-boot-label"></span>`;
        // textContent, not innerHTML: the labels are product copy today, but
        // this is the kind of place a translated string eventually lands.
        li.querySelector('.ezil-boot-label').textContent = phase.label;
        el_phases.appendChild(li);
        rows.set(phase.id, li);
    }

    el_retry.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if ( typeof onRetry === 'function' ) onRetry();
    });

    /**
     * @param {import('../boot-phases.js').BootUiState} state
     * @param {{countdown?: string} | null} [aws] Set only while the window is
     *   re-asking because the AWS observation says the computer is still opening.
     *   Changes the subtext only; the phase rows are drawn exactly as before.
     */
    function render (state, aws = null) {
        root.setAttribute('data-kind', state.kind);

        if ( state.kind === 'progress' ) {
            el_title.textContent = BOOT_PROGRESS_HEADLINE;
            el_sub.textContent = aws ? awsStillStartingCopy(aws.countdown)
                : state.isRunningLong
                ? BOOT_PROGRESS_LONG_SUBTEXT
                : BOOT_PROGRESS_SUBTEXT;
            el_phases.hidden = false;
            el_actions.hidden = true;
            for ( const phase of BOOT_PHASES ) {
                // The ONLY source of a checkmark. `phaseVisualState` returns
                // 'confirmed' exclusively when the progress state was built
                // from the real status signal.
                rows.get(phase.id).setAttribute('data-state', phaseVisualState(phase.id, state));
            }
            return;
        }

        el_phases.hidden = true;

        if ( state.kind === 'not_configured' ) {
            el_title.textContent = BOOT_NOT_CONFIGURED_COPY.title;
            el_sub.textContent = BOOT_NOT_CONFIGURED_COPY.body;
            // Nothing to retry: no provider is configured, so the next
            // attempt fails identically. Offering a button would be a lie.
            el_actions.hidden = true;
            return;
        }

        if ( state.kind === 'failed' ) {
            const copy = BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
            el_title.textContent = copy.title;
            el_sub.textContent = copy.body;
            el_actions.hidden = false;
            return;
        }

        // 'ready' and 'ready_unverified' — the caller is about to swap the
        // iframe in over this panel. Leave the last frame in place rather than
        // blanking it, so there is no white flash between the two.
        //
        // 🔴 The two are NOT the same to the user, and this file is not where
        // the difference is drawn: `ready_unverified` means the desktop is
        // shown but nothing checked it, and `DisplayNotice` below is what says
        // so, on top of the frame. Rendering that text into a panel that is
        // about to be hidden would be the same as not saying it.
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
