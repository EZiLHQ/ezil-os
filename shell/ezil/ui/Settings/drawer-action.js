// drawer-action.js — EZiL-authored. Not Puter code.
//
// 🔴 GUARANTEE #1: a Settings button inside the full-bleed desktop window's
// control drawer.
//
// ── Why this is not optional ────────────────────────────────────────────────
// `window.enter_fullpage_mode` (`shell/src/UI/UIDesktopFullpage.js`) does
// `$('.taskbar').hide()` and hides the window head, and `style.css:246` hides
// the minimise button in fullpage mode. So while a desktop window is
// full-bleed there is NO taskbar and NO window chrome — the pinned Settings
// taskbar icon `registry.js` creates is on screen only when nothing is
// full-bleed. Without a Settings entry in the drawer, a user whose only
// desktop is stuck full-bleed cannot reach Delete, and the 2-computer cap
// becomes a permanent trap: two computers, both broken, no way to free a slot
// short of finding `/computers` by hand.
//
// ── Why it is injected rather than declared ─────────────────────────────────
// `attach_app_drawer` (`../app-drawer.js`) takes a declarative `actions`
// array and its author left the seam open on purpose ("Settings drops in here
// in a later wave"). That array literal lives in `../../apps/desktop-window.js`,
// which is OUTSIDE this task's owned paths (`shell/ezil/ui/Settings/**`,
// `shell/ezil/apps/registry.js`, `shell/PUTER-PROVENANCE.md`), and a change to
// a file this task does not own is discarded at merge — i.e. it would silently
// un-ship the guarantee. So the button is added from the owned side instead.
//
// This is safe and deterministic, not a race, because of an OBSERVED ordering:
// `openDesktopWindow` calls `attach_app_drawer` at `desktop-window.js:474` and
// returns the window at :523 with no `await` in between, so by the time
// `registry.launch()`'s `await app.open(ctx)` resolves, the drawer is already a
// child of the returned element. The bounded retry below exists only so that a
// future refactor which made that attach asynchronous would degrade to a short
// delay instead of to a missing button.
//
// If `desktop-window.js` ever DOES adopt `registry.settingsDrawerAction()`
// into its `actions` array, this module detects the button already present and
// does nothing — the two cannot double up.
//
// ── The CSS half of the same guarantee ──────────────────────────────────────
// `shell/src/css/dashboard.css:52` derives the tray's open width from a calc
// sized for EXACTLY two buttons, and `.dashboard-app-drawer-clip` is
// `overflow:hidden`. A third button would be clipped and unclickable, which is
// indistinguishable from not shipping it.
//
// MODIFIED BY EZIL 2026-08-01 (wave-a seams): this was originally fixed by a
// hand-written `--open-w` for exactly THREE buttons, hung on `MARKER_CLASS` in
// `settings.css`. The app switcher then made it four and would have clipped
// again — a landmine that re-arms every time anyone adds a button. The width
// is now derived from the actual button count by `sync_drawer_width`
// (`../app-drawer.js`), which this file calls after injecting. `MARKER_CLASS`
// survives as a state marker (the idempotency check and `settings-test.mjs`
// both read it); it no longer carries any geometry.

import { sync_drawer_width } from '../app-drawer.js';
import telemetry from '../../telemetry.js';

const PHASE = 'ezil-os:settings/drawer';

/** Set on the drawer element; `settings.css` widens `--open-w` for it. */
export const MARKER_CLASS = 'ezil-has-settings-action';

/** Upstream's own button class shape: the generic `-btn` carries all the
 * styling (`dashboard.css:201`), the specific one is a hook. */
const BTN_CLASS = 'dashboard-app-drawer-btn dashboard-app-drawer-settings';

/** Same 24px stroked gear as the taskbar/dock icon, at drawer stroke weight. */
export const SETTINGS_DRAWER_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
    + '<circle cx="12" cy="12" r="3"/>'
    + '<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33'
    + ' 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06'
    + 'a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09'
    + 'a1.65 1.65 0 0 0 1.51-1.08 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06'
    + 'a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51'
    + ' 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9'
    + 'a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>'
    + '</svg>';

const RETRY_MS = 100;
const MAX_RETRIES = 30; // 3s, the same order as desktop-window.js's own bounded waits.

/**
 * @param {HTMLElement} drawer
 * @param {HTMLElement} el_window
 * @param {() => void} onOpen
 * @returns {boolean} true when the drawer is in its final, augmented state.
 */
function inject (drawer, el_window, onOpen) {
    // Already ours, or already carrying a Settings button that
    // `desktop-window.js` declared itself — either way, nothing to do.
    if ( drawer.classList.contains(MARKER_CLASS) ) return true;
    if ( drawer.querySelector('.dashboard-app-drawer-settings') ) {
        drawer.classList.add(MARKER_CLASS);
        return true;
    }

    const controls = drawer.querySelector('.dashboard-app-drawer-controls');
    if ( ! controls ) return false;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = BTN_CLASS;
    btn.title = 'Settings';
    btn.setAttribute('aria-label', 'Settings');
    btn.innerHTML = SETTINGS_DRAWER_SVG;

    btn.addEventListener('click', (e) => {
        // Mirrors `add_button` in ../app-drawer.js exactly: swallow the click
        // so the drawer's own toggle does not also see it, retract the tray,
        // then act — and never let a throwing handler escape, because this
        // tray is the only way out of a full-bleed window.
        e.stopPropagation();
        try {
            el_window._dashboard_drawer_collapse?.();
        } catch ( err ) {
            console.error(`[${PHASE}] collapse threw`, err);
            telemetry.capture({
                eventClass: 'window_error', site: 'ezil-os:settings/drawer-action#collapse', code: 'collapse_threw',
                detail: err,
            });
        }
        try {
            onOpen();
        } catch ( err ) {
            console.error(`[${PHASE}] "Settings" handler threw`, err);
            telemetry.capture({
                eventClass: 'window_error', site: 'ezil-os:settings/drawer-action#open', code: 'settings_handler_threw',
                detail: err,
            });
        }
    });

    // BEFORE Close, matching the order `attach_app_drawer` documents for its
    // `actions` array ("rendered left-to-right BEFORE the close button").
    const close = controls.querySelector('.dashboard-app-drawer-close');
    if ( close ) controls.insertBefore(btn, close);
    else controls.appendChild(btn);

    drawer.classList.add(MARKER_CLASS);
    // 🔴 The tray's open width is derived from its button COUNT (see
    // `sync_drawer_width` in ../app-drawer.js). This injection happens after
    // `attach_app_drawer` has already sized it, so the count must be
    // re-published or the button lands outside `overflow: hidden` — present in
    // the DOM, invisible on screen, and passing every DOM-level test.
    sync_drawer_width(drawer);
    console.info(`[${PHASE}] Settings button attached to the control drawer`);
    return true;
}

/**
 * Put a Settings button in `el_window`'s control drawer, if it has one.
 * Idempotent, and safe to call on a window that will never grow a drawer as
 * long as `expected` is false (no warning is emitted in that case).
 *
 * @param {HTMLElement|null} el_window The window `registry.launch` just opened.
 * @param {() => void} onOpen What the button does. Injected rather than
 *   imported so this module never has to import `registry.js`, which already
 *   imports (transitively) this directory.
 * @param {{expected?: boolean}} [opts] `expected: true` means "this window is
 *   supposed to have a drawer" — only then is a miss worth warning about.
 */
export function ensureSettingsDrawerButton (el_window, onOpen, opts = {}) {
    if ( ! el_window || typeof el_window.querySelector !== 'function' ) return;
    if ( typeof onOpen !== 'function' ) return;

    let tries = 0;
    const attempt = () => {
        // Re-query every attempt: a rebuild can replace the drawer node.
        const drawer = el_window.querySelector('.dashboard-app-drawer');
        if ( drawer && inject(drawer, el_window, onOpen) ) return;
        if ( ++tries > MAX_RETRIES ) {
            if ( opts.expected ) {
                // Not fatal: `desktop-window.js` refuses to go full-bleed at
                // all when its drawer fails to attach, so the taskbar — and
                // with it the pinned Settings icon — stays on screen.
                console.warn(`[${PHASE}] no control drawer found on this window; Settings stays taskbar-only`);
            }
            return;
        }
        setTimeout(attempt, RETRY_MS);
    };
    attempt();
}

export default { ensureSettingsDrawerButton, MARKER_CLASS, SETTINGS_DRAWER_SVG };
