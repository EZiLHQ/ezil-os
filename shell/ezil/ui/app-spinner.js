// EZiL app loading surface. Physical app readiness remains owned by the caller.
// Hosted computers also show protected, read-only computer.progress observations.
// Paused/operator/queued states override recorded migration intent; none animate.
// The separate observer owns polling, never allocation; this file owns no clock:
// the elapsed time and bar advance only when the caller paints.
// Without an authoritative observation, do not infer a transfer from launch flags.
// Native/local callers retain the original BootUiState and retry behavior.
// Round 3: renders through the one opening surface (`OpeningSurface`).

import {
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
} from '../boot-phases.js';

import { observeComputerProgress, OpeningSurface, OPENING_COPY, OPENING_MILESTONES, formatElapsed, openingAt, prefersReducedMotion } from './computer-progress.js';
import { isNative } from '../native-runtime.js';

import { LAUNCH_COPY } from '../launch-copy.js';

// Like the boot copy tables, static text is rendered via textContent.
const MIGRATION_COPY = {
    title: 'Moving your computer to AWS (India)',
    body: 'This first start takes a few minutes. Your files come with you.',
};

/** "Opening Code…" → "Code". */
const appNameOf = label => String(label ?? '').replace(/^Opening\s+/, '').replace(/…$/, '').trim();

/**
 * Build the spinner once. Returns a controller the caller drives — same
 * `{ el, render }` shape as `BootProgress`, so either can sit in a window
 * body and be driven by the same `paint()` loop.
 *
 * @param {object} opts
 * @param {string} [opts.label] The status line while `state.kind === 'progress'`
 *   and no observation exists: "Opening Browser…", "Opening Code…".
 * @param {string} [opts.appName] Shown under the icon; defaults to the label's app.
 * @param {string} [opts.icon] The app's icon (a data: or same-origin URL).
 * @param {() => void} [opts.onRetry] Called by the failure state's Retry button.
 * @param {() => boolean} [opts.isMigrating] Reads this computer's observed migration state.
 * @param {() => boolean} [opts.isLaunching] Reads this computer's observed fresh launch state.
 * @param {{title: string, body: string}} [opts.failureCopy] Static app-specific
 *   failure guidance. Changes wording only, never readiness or retry behavior.
 */
export function AppSpinner ({ computerId, onProgressChange, label = 'Opening…', appName, icon, onRetry, failureCopy, isMigrating = () => false, isLaunching = () => false } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-app-spinner';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    const name = appName ?? appNameOf(label);
    let failureCode;
    const surface = OpeningSurface({ appName: name, icon, onRetry, feedbackCode: () => failureCode,
        statusClass: 'ezil-app-spinner-label', subClass: 'ezil-app-spinner-sub' });
    surface.el.classList.add('ezil-app-spinner-panel');
    root.appendChild(surface.el);

    let observation = null, latestState = null, latestExtra = {}, progressChecked = false, client = 0;
    // Rendered as `progress` = this window's open is in flight: a not-yet-recorded opening never reads "stopped".
    const observer = computerId && !isNative() ? observeComputerProgress({ computerId, element: root, appName: name,
        openRequested: () => latestState?.kind === 'progress', onChange: value => {
        observation = value; progressChecked = true;
        if (latestState) render(latestState, latestExtra);
        onProgressChange?.();
    } }) : null;
    root.dataset.progress = observer ? 'pending' : 'none';
    surface.paint({ status: label, percent: null });

    /**
     * @param {import('../boot-phases.js').BootUiState} state
     * @param {{elapsedMs?: number}} [extra] The caller's own boot clock, for the
     *   elapsed time when no server observation exists.
     */
    function render (state, extra = {}) {
        latestState = state; latestExtra = extra ?? {};
        const pending = state.kind === 'progress' || state.kind === 'failed';
        if (pending) observer?.start(); else {
            observer?.stop(); observation = null; progressChecked = false;
        }
        if (observer) root.dataset.progress = observation ? 'observed' : progressChecked ? 'unavailable' : 'pending';
        // Round 4: the raw server code (e.g. `billing_files_on_aws`), not the classified reason.
        failureCode = state.kind === 'failed' ? state.errorCode ?? state.reason : observation?.stage === 'needs_operator' ? 'needs_operator' : undefined;
        const activeTimeout = state.kind === 'failed' && state.reason === 'timeout' && observation?.activeAws;
        // `observedBudgetSpent`: the desktop window's own ten-minute clock ran out first.
        const runningLong = (state.kind === 'progress' || activeTimeout) && observation?.activeAws
            && (observation.elapsed >= 600 || state.observedBudgetSpent === true);
        root.setAttribute('data-kind', activeTimeout ? 'progress' : state.kind);
        root.classList.toggle('ezil-app-spinner-running-long', !!runningLong);
        const showObservation = pending && observation && (state.kind === 'progress' || activeTimeout
            || ['operations_paused', 'needs_operator', 'queued', 'failed_reopened'].includes(observation.stage));
        if (showObservation) {
            const at = openingAt(observation, Date.now(), { reducedMotion: prefersReducedMotion(), client });
            const attention = observation.stage === 'needs_operator';
            const retry = !!(runningLong || observation.stage === 'failed_reopened'
                || (state.kind === 'failed' && attention && !observation.manualAttention));
            const meta = !at ? '' : at.long && !runningLong ? `${OPENING_COPY.long} · ${at.elapsedText}` : at.elapsedText;
            const dev = [observation.next, observation.updated ? `Last recorded update: ${observation.updated}` : ''].filter(Boolean).join(' ');
            surface.paint({
                status: observation.title,
                body: runningLong ? OPENING_COPY.runningLong : [observation.body, observation.bytes, dev].filter(Boolean).join(' · '),
                percent: at ? at.percent : observation.indeterminate ? 'indeterminate' : null, key: observation.openingKey, meta, long: at?.long,
                retry, feedback: attention || retry,
            });
            return;
        }

        if ( state.kind === 'progress' ) {
            // Optional AWS/migration metadata must not replace physical app startup.
            const copy = observer ? null : isMigrating() === true ? MIGRATION_COPY : isLaunching() === true ? LAUNCH_COPY : null;
            const elapsed = Number.isFinite(extra?.elapsedMs) ? extra.elapsedMs / 1000 : null;
            surface.paint({ status: copy ? copy.title : label, body: copy ? copy.body : '', percent: 'indeterminate',
                meta: elapsed === null ? '' : formatElapsed(elapsed) });
            return;
        }

        if ( state.kind === 'not_configured' ) {
            // Nothing to retry: no provider is configured, so the next
            // attempt fails identically. Same rule as `BootProgress`.
            surface.paint({ status: BOOT_NOT_CONFIGURED_COPY.title, body: BOOT_NOT_CONFIGURED_COPY.body, percent: null });
            return;
        }

        if ( state.kind === 'failed' ) {
            const copy = failureCopy ?? BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
            surface.paint({ status: copy.title, body: copy.body, percent: null, retry: true, feedback: true });
            return;
        }

        // 'ready' and 'ready_unverified' — the caller is about to swap the
        // iframe in over this panel, or has already retired it. Nothing to
        // draw: the unverified strip is `DisplayNotice`'s, and only the desktop
        // window uses it.
    }

    /** The caller's client milestones: `url_received`, then `first_frame` (the bar's 100%); null starts a new attempt. */
    function stamp (key) {
        if (key === null) { client = 0; return; }
        const i = OPENING_MILESTONES.indexOf(key);
        if (i > client) { client = i; if (latestState) render(latestState, latestExtra); }
    }

    return { el: root, render, stamp, hasComputerProgress: () => observation !== null, computerProgress: () => observation,
        dispose: () => observer?.stop() };
}

export default AppSpinner;
