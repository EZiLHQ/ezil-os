// EZiL app loading surface. Physical app readiness remains owned by the caller.
// Hosted computers also show protected, read-only computer.progress observations.
// Paused/operator/queued states override recorded migration intent; none animate.
// The separate observer owns polling and disposal, never allocation or fake progress.
// Without an authoritative observation, do not infer a transfer from launch flags.
// Native/local callers retain the original BootUiState and retry behavior.

import {
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
} from '../boot-phases.js';

import { observeComputerProgress } from './computer-progress.js';
import { isNative } from '../native-runtime.js';

import { LAUNCH_COPY } from '../launch-copy.js';

// Like the boot copy tables, static text is rendered via textContent.
const MIGRATION_COPY = {
    title: 'Moving your computer to AWS (India)',
    body: 'This first start takes a few minutes. Your files come with you.',
};

/**
 * Build the spinner once. Returns a controller the caller drives — same
 * `{ el, render }` shape as `BootProgress`, so either can sit in a window
 * body and be driven by the same `paint()` loop.
 *
 * @param {object} opts
 * @param {string} [opts.label] Shown while `state.kind === 'progress'`.
 *   Callers pass the app's own name — "Opening Browser…", "Opening
 *   Preview…", "Opening Code…" — never machine vocabulary.
 * @param {() => void} [opts.onRetry] Called by the failure state's Retry button.
 * @param {() => boolean} [opts.isMigrating] Reads this computer's observed migration state.
 * @param {() => boolean} [opts.isLaunching] Reads this computer's observed fresh launch state.
 * @param {{title: string, body: string}} [opts.failureCopy] Static app-specific
 *   failure guidance. Changes wording only, never readiness or retry behavior.
 */
export function AppSpinner ({ computerId, onProgressChange, label = 'Opening…', onRetry, failureCopy, isMigrating = () => false, isLaunching = () => false } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-app-spinner';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    root.innerHTML = `
        <div class="ezil-app-spinner-panel">
            <div class="ezil-app-spinner-ring" aria-hidden="true"></div>
            <h1 class="ezil-boot-title ezil-app-spinner-label"></h1>
            <p class="ezil-boot-sub ezil-app-spinner-sub" hidden></p>
            <div class="ezil-computer-progress" hidden></div>
            <div class="ezil-boot-actions">
                <button type="button" class="ezil-boot-retry">Try again</button>
            </div>
        </div>`;

    const el_ring = root.querySelector('.ezil-app-spinner-ring');
    const el_label = root.querySelector('.ezil-app-spinner-label');
    const el_sub = root.querySelector('.ezil-app-spinner-sub');
    const el_actions = root.querySelector('.ezil-boot-actions');
    const el_retry = root.querySelector('.ezil-boot-retry');

    const el_detail = root.querySelector('.ezil-computer-progress');
    let observation = null, latestState = null, progressChecked = false, paintedObservation = null;
    const observer = computerId && !isNative() ? observeComputerProgress({ computerId, element: root, onChange: value => {
        observation = value; progressChecked = true;
        if (latestState) render(latestState);
        onProgressChange?.();
    } }) : null;
    el_label.textContent = label;
    el_actions.hidden = true;

    el_retry.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if ( typeof onRetry === 'function' ) onRetry();
    });

    /**
     * @param {import('../boot-phases.js').BootUiState} state
     */
    function render (state) {
        latestState = state;
        root.setAttribute('data-kind', state.kind);
        const pending = state.kind === 'progress' || state.kind === 'failed';
        if (pending) observer?.start(); else {
            observer?.stop(); observation = null; progressChecked = false;
        }
        const showObservation = pending && observation && (state.kind === 'progress' || ['operations_paused', 'needs_operator', 'queued'].includes(observation.stage));
        const fingerprint = showObservation ? JSON.stringify(observation) : null;
        if (fingerprint !== null && fingerprint === paintedObservation) return;
        paintedObservation = fingerprint;
        el_detail.hidden = true;
        if (showObservation) {
            el_ring.hidden = !observation.active;
            el_label.textContent = observation.title;
            el_sub.hidden = false; el_sub.textContent = observation.body;
            el_actions.hidden = !['failed_reopened'].includes(observation.stage);
            el_detail.replaceChildren(); el_detail.hidden = false;
            if (observation.steps.length) {
                const list = document.createElement('ol'); list.setAttribute('aria-label', 'Saved migration stages');
                for (const step of observation.steps) {
                    const item = document.createElement('li'); item.textContent = step.label; item.dataset.state = step.state;
                    if (step.state === 'current') item.setAttribute('aria-current', 'step');
                    list.appendChild(item);
                }
                el_detail.appendChild(list);
            }
            for (const text of [observation.guidance, observation.next, observation.updated ? `Last recorded update: ${observation.updated}` : '']) {
                if (!text) continue;
                const line = document.createElement('p'); line.textContent = text; el_detail.appendChild(line);
            }
            return;
        }

        if (state.kind === 'progress' && observer) {
            // Optional AWS/migration metadata must not replace physical app startup.
            el_ring.hidden = false;
            el_label.textContent = label;
            el_sub.hidden = !progressChecked;
            el_sub.textContent = progressChecked ? 'Detailed computer progress is unavailable.' : '';
            el_actions.hidden = true;
            return;
        }
        if ( state.kind === 'progress' ) {
            const copy = isMigrating() === true ? MIGRATION_COPY : isLaunching() === true ? LAUNCH_COPY : null;
            el_ring.hidden = false;
            el_label.textContent = copy ? copy.title : label;
            el_sub.hidden = !copy;
            el_sub.textContent = copy ? copy.body : '';
            el_actions.hidden = true;
            return;
        }

        el_ring.hidden = true;

        if ( state.kind === 'not_configured' ) {
            el_label.textContent = BOOT_NOT_CONFIGURED_COPY.title;
            el_sub.hidden = false;
            el_sub.textContent = BOOT_NOT_CONFIGURED_COPY.body;
            // Nothing to retry: no provider is configured, so the next
            // attempt fails identically. Same rule as `BootProgress`.
            el_actions.hidden = true;
            return;
        }

        if ( state.kind === 'failed' ) {
            const copy = failureCopy ?? BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
            el_label.textContent = copy.title;
            el_sub.hidden = false;
            el_sub.textContent = copy.body;
            el_actions.hidden = false;
            return;
        }

        // 'ready' and 'ready_unverified' — the caller is about to swap the
        // iframe in over this panel, or has already retired it. Nothing to
        // draw: this component has no opinion about the unverified strip
        // either (that is `DisplayNotice`'s, and only the desktop window
        // uses it — Preview/Code are HTML documents with no separate
        // "did pixels arrive" question).
    }

    return { el: root, render, hasComputerProgress: () => observation !== null, dispose: () => observer?.stop() };
}

export default AppSpinner;
