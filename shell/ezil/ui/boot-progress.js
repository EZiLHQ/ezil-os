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
    phaseVisualState,
} from '../boot-phases.js';

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
     */
    function render (state) {
        root.setAttribute('data-kind', state.kind);

        if ( state.kind === 'progress' ) {
            el_title.textContent = BOOT_PROGRESS_HEADLINE;
            el_sub.textContent = state.isRunningLong
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

        // 'ready' — the caller is about to swap the iframe in over this
        // panel. Leave the last frame in place rather than blanking it, so
        // there is no white flash between the two.
    }

    return { el: root, render };
}

export default BootProgress;
