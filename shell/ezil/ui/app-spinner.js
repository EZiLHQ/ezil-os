// app-spinner.js — EZiL-authored. Not Puter code.
//
// "Opening an app" instead of "booting a machine": a rotating ring and one
// line of copy, no phase list, no "waking your machine" / "mounting your
// files" vocabulary. The owner, directly: "The user doesn't care about any
// of that... App opening should be like opening an app — a circular thing
// rotates a few seconds, then it opens."
//
// ── Who uses this, and why it is not just a smaller BootProgress ──────────
// `preview.js` and `code.js` are plain HTTP iframes with no machine to boot —
// they used `BootProgress` anyway, rendering "Waking your machine" and four
// container phases describing nothing that is actually happening to an HTML
// document. They now use this instead, exclusively.
//
// `apps/desktop-window.js` (a REAL streamed container) keeps `BootProgress`
// too, but opens showing THIS component and only reveals the phase panel
// after `PHASE_LIST_AFTER_MS` — see that file. A warm open never sees a
// phase list; a genuinely long cold boot earns the detail because it is
// genuinely taking longer.
//
// ── Same input, same honesty rules, deliberately no new ones ──────────────
// This takes the exact same `BootUiState` `computeBootUiState` produces and
// draws the same `BOOT_FAILURE_COPY` / `BOOT_NOT_CONFIGURED_COPY` any other
// boot surface in this codebase draws. It invents nothing of its own: for an
// HTML document (Preview, Code) "the origin answered without an error
// status" genuinely is the whole question, and this component's honesty
// obligation stops exactly where `computeBootUiState`'s does.
//
// ── 🔴 NO TIMERS OF ITS OWN ──────────────────────────────────────────────
// The caller owns the clock — the same rule `boot-progress.js` follows, for
// the same reason: a component that can start its own timer can eventually
// be tempted to invent progress on one. The ring's rotation is pure CSS
// (`@keyframes` in `ezil-shell.css`), and `render()` never schedules a
// callback of any kind. `app-spinner-test.mjs` asserts this file's source
// contains none of the browser's deferred-callback APIs, so it is physically
// unable to regress. (That sentence is phrased this way, rather than naming
// the two APIs outright, so the guard's own grep does not trip over its own
// doc comment.)

import {
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
} from '../boot-phases.js';

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
 */
export function AppSpinner ({ label = 'Opening…', onRetry } = {}) {
    const root = document.createElement('div');
    root.className = 'ezil-app-spinner';
    root.setAttribute('role', 'status');
    root.setAttribute('aria-live', 'polite');

    root.innerHTML = `
        <div class="ezil-app-spinner-panel">
            <div class="ezil-app-spinner-ring" aria-hidden="true"></div>
            <h1 class="ezil-boot-title ezil-app-spinner-label"></h1>
            <p class="ezil-boot-sub ezil-app-spinner-sub" hidden></p>
            <div class="ezil-boot-actions">
                <button type="button" class="ezil-boot-retry">Try again</button>
            </div>
        </div>`;

    const el_ring = root.querySelector('.ezil-app-spinner-ring');
    const el_label = root.querySelector('.ezil-app-spinner-label');
    const el_sub = root.querySelector('.ezil-app-spinner-sub');
    const el_actions = root.querySelector('.ezil-boot-actions');
    const el_retry = root.querySelector('.ezil-boot-retry');

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
        root.setAttribute('data-kind', state.kind);

        if ( state.kind === 'progress' ) {
            el_ring.hidden = false;
            el_label.textContent = label;
            el_sub.hidden = true;
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
            const copy = BOOT_FAILURE_COPY[state.reason] ?? BOOT_FAILURE_COPY.unknown;
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

    return { el: root, render };
}

export default AppSpinner;
