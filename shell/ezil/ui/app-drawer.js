// app-drawer.js — DERIVED FROM PUTER. AGPL-3.0-only.
//
// Adapted from `attach_dashboard_app_drawer`, upstream
// `src/gui/src/UI/UIWindow.js` lines ~4426-4554 at upstream commit 5a15719.
// The interaction design — the tongue/tray morph, the collapse timers, the
// mouse-only hover rule, the two-frame intro flash — is upstream's and is
// reproduced faithfully. See ../../PUTER-PROVENANCE.md and ATTRIBUTIONS.md.
//
// ── Why this is a fresh module and not a call into UIWindow.js ─────────────
// The whole-file UIWindow.js port still contains upstream's copy, but it is
// module-private AND gated behind `is_dashboard_app_chrome`, which requires
// `window.is_dashboard_mode` — Puter's Dashboard, a surface this fork does not
// have and will not build. EZiL needs the same tray for a different reason, so
// the gate is dropped and the three things that were hard-wired to the
// Dashboard become parameters:
//
//   MODIFIED: `minimize_window()` (which calls `pop_dashboard_app_url`, a
//     no-op outside dashboard mode) -> an `on_minimize` callback. EZiL's
//     minimise has to restore the taskbar first — see below.
//   MODIFIED: the fixed icon/title/minimise/close row -> a declarative
//     `actions` array, so Settings can be added without touching this file.
//   MODIFIED: `push/pop_dashboard_app_url` and the
//     `dashboard-app-windows-changed` event are gone. EZiL's shell does not
//     own the address bar; `/os` is one URL.
//
// ── 🔴 Why this tray is not optional ──────────────────────────────────────
// `window.enter_fullpage_mode` (shell/src/UI/UIDesktopFullpage.js) does
// `$('.taskbar').hide()` AND `$(el_window).find('.window-head').hide()`, and
// `style.css:246` hides `.window-minimize-btn` in fullpage mode for good
// measure. So a full-bleed desktop window has NO window chrome and NO taskbar.
// This drawer is the only thing on screen the user can click that is not the
// remote Linux desktop. If it fails to attach, the user is locked inside their
// container with no way back to the OS.
//
// The CSS class names are upstream's (`dashboard-app-drawer*`) on purpose:
// `shell/src/css/dashboard.css` is the ported 275-line extract that styles
// exactly those selectors. Renaming them here would mean re-porting the
// stylesheet to gain nothing.

import telemetry from '../telemetry.js';

const PHASE = 'ezil-os:drawer';

/**
 * @param {HTMLElement} el_window
 * @param {object} options
 * @param {string} options.title       Shown in the tray.
 * @param {string} [options.icon]      Data URI from `window.icons`.
 * @param {Array<{id:string,label:string,svg:string,onClick:Function}>} [options.actions]
 *   Rendered left-to-right BEFORE the close button. Wave 1 passes minimise;
 *   Settings drops in here with no change to this file.
 * @param {Function} [options.on_close] Defaults to closing the window.
 * @param {boolean} [options.flash_on_attach=true] Play the intro on attach.
 *   Upstream always does, because upstream's drawer only ever exists on a
 *   chrome-less window. EZiL attaches it to a window that is still WINDOWED
 *   (its own head is the chrome, and CSS keeps the drawer hidden until the
 *   window goes full-bleed), so the caller plays the intro at the moment the
 *   drawer becomes the only way out instead. See `go_fullbleed` in
 *   ../apps/desktop-window.js.
 * @returns {HTMLElement|null} the drawer element, or null if it could not attach.
 */
/**
 * Tell the stylesheet how many buttons the tray is actually carrying.
 *
 * 🔴 WHY THIS EXISTS — a real defect, found in composition, twice over.
 * `src/css/dashboard.css` (Puter-derived, and not ours to restructure) sizes
 * the open tray from a calc written for EXACTLY two buttons:
 *
 *   --open-w: calc(12px + --icon + --i2t + --title-w + --t2b + --btn + 2px + --btn + 10px)
 *
 * and `.dashboard-app-drawer-clip` is `overflow: hidden`. Any third button is
 * therefore present in the DOM, and invisible and unclickable on screen. The
 * Settings task hit this and widened the calc by hand, for exactly three. Then
 * the app switcher arrived and made it four, which would have silently clipped
 * again — and, being a DOM-level pass, would have gone on passing every test.
 *
 * A hand-written constant for N buttons is a landmine that re-arms itself
 * every time someone adds one. So the count becomes DATA: this writes
 * `--btn-count` on the drawer, and `ezil-shell.css` derives `--open-w` from it
 * with the same formula generalised. Both call sites that can change the
 * count — `attach_app_drawer` below and `Settings/drawer-action.js`, which
 * injects after the fact — call this, and it is idempotent.
 *
 * Only the TOTAL is redefined, never any part, so dashboard.css's
 * `(pointer: coarse)` and `(max-width: 500px)` overrides of `--btn` /
 * `--title-w` / `--t2b` still flow through the calc unchanged: custom
 * properties in a calc resolve at use time.
 *
 * @param {HTMLElement|null} drawer the `.dashboard-app-drawer` element
 */
export function sync_drawer_width (drawer) {
    if ( ! drawer ) return;
    const n = drawer.querySelectorAll('.dashboard-app-drawer-btn').length;
    // A drawer with no buttons is not a state this produces (Close is
    // unconditional), but never write a 0 that would collapse the calc.
    drawer.style.setProperty('--btn-count', String(Math.max(1, n)));
}

export function attach_app_drawer (el_window, options = {}) {
    if ( ! el_window ) {
        console.error(`[${PHASE}] refusing to attach to a null window`);
        telemetry.capture({ eventClass: 'contract_violation', site: 'ezil-os:ui/app-drawer#attach', code: 'null_window' });
        return null;
    }

    const icon = options.icon || window.icons?.['app.svg'] || '';
    const title = options.title || '';
    const actions = Array.isArray(options.actions) ? options.actions : [];

    // The toggle comes FIRST in the DOM so Tab reaches it before the
    // controls' buttons; both layers are absolutely positioned (see
    // dashboard.css), so DOM order does not affect the visuals.
    const $drawer = $(`
        <div class="dashboard-app-drawer ezil-app-drawer collapsed">
            <button type="button" class="dashboard-app-drawer-toggle" aria-expanded="false" title="Window controls" aria-label="Window controls">
                <span class="dashboard-app-drawer-grabber" aria-hidden="true"></span>
            </button>
            <div class="dashboard-app-drawer-clip">
                <div class="dashboard-app-drawer-controls">
                    <img class="dashboard-app-drawer-icon" src="${html_encode(icon)}" alt="" draggable="false">
                    <span class="dashboard-app-drawer-title">${html_encode(title)}</span>
                </div>
            </div>
        </div>
    `);
    const drawer = $drawer.get(0);
    const toggle = $drawer.find('.dashboard-app-drawer-toggle').get(0);
    const $controls = $drawer.find('.dashboard-app-drawer-controls');

    let collapse_timer = null;
    let opened_at = 0;
    const expand = () => {
        clearTimeout(collapse_timer);
        if ( drawer.classList.contains('collapsed') ) opened_at = Date.now();
        drawer.classList.remove('collapsed');
        toggle.setAttribute('aria-expanded', 'true');
    };
    const collapse = () => {
        clearTimeout(collapse_timer);
        drawer.classList.add('collapsed');
        toggle.setAttribute('aria-expanded', 'false');
    };
    const schedule_collapse = (ms) => {
        clearTimeout(collapse_timer);
        collapse_timer = setTimeout(collapse, ms);
    };
    // Expand + auto-collapse: played once on open, so the controls introduce
    // themselves — and retract INTO the tongue, teaching where they live —
    // without permanently costing pixels.
    const flash = () => {
        expand();
        schedule_collapse(2600);
    };

    // One builder for every button, so the close button cannot drift from the
    // caller-supplied ones.
    const add_button = (spec, extra_class) => {
        const $btn = $(
            `<button type="button" class="dashboard-app-drawer-btn ${extra_class}"`
            + ` title="${html_encode(spec.label)}" aria-label="${html_encode(spec.label)}">${spec.svg}</button>`,
        );
        $btn.on('click', function (e) {
            e.stopPropagation();
            collapse();
            try {
                spec.onClick(el_window);
            } catch ( err ) {
                // A throwing handler must not take the tray down with it —
                // the tray is the only way out of a full-bleed window.
                console.error(`[${PHASE}] "${spec.label}" handler threw`, err);
                telemetry.capture({
                    eventClass: 'window_error', site: 'ezil-os:ui/app-drawer#handler', code: 'drawer_handler_threw',
                    detail: err,
                });
            }
        });
        $controls.append($btn);
        return $btn;
    };

    for ( const spec of actions ) {
        add_button(spec, `dashboard-app-drawer-${spec.id}`);
    }
    add_button({
        id: 'close',
        label: 'Close',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">'
            + '<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/></svg>',
        onClick: options.on_close ?? ((el) => { $(el).close(); }),
    }, 'dashboard-app-drawer-close');

    sync_drawer_width(drawer);

    // Hover pulls the drawer open and leaving lets it settle — mouse only: a
    // touch tap synthesizes a pointerenter right before its click, which would
    // make the toggle below see an already-open drawer and shut it again.
    // Touch devices open by tap instead, and since they never fire
    // pointerleave, that path self-schedules its collapse. (Upstream.)
    $drawer.on('pointerenter', (e) => {
        if ( e.pointerType === 'mouse' ) expand();
    });
    $drawer.on('pointerleave', (e) => {
        if ( e.pointerType === 'mouse' ) schedule_collapse(900);
    });
    $drawer.on('focusin', () => expand());
    $drawer.on('focusout', () => schedule_collapse(1100));

    // Pressing the drawer activates its window, as pressing a titlebar would —
    // the drawer took over the head's job. Deferred a tick because the
    // document-level activation handler runs after this one.
    //
    // 🔴 This is load-bearing for EZiL specifically: `style.css` gives
    // `.window-app-iframe` `pointer-events: none` and only
    // `.window-active .window-app-iframe` gets `pointer-events: all`. A
    // desktop window that is not `window-active` renders perfectly and
    // ignores every click — the same symptom as a failed implicit-hosting
    // handshake, from a completely different cause.
    $drawer.on('mousedown', () => {
        setTimeout(() => $(el_window).focusWindow(), 0);
    });

    // The grabber is the drawer's one toggle: opens it when shut, shuts it
    // when open. A click landing within a beat of the open is the SAME gesture
    // that opened it (hover-then-click mice, tap) — hold the drawer open
    // instead of instantly re-shutting it. (Upstream.)
    $(toggle).on('click', function (e) {
        e.stopPropagation();
        if ( drawer.classList.contains('collapsed') ) {
            expand();
            schedule_collapse(3500);
        } else if ( Date.now() - opened_at < 500 ) {
            schedule_collapse(3500);
        } else {
            collapse();
        }
    });

    // `showWindow` (UIWindow.js) calls this hook on restore, so a window comes
    // back showing the app, not the chrome. Upstream's name, kept because
    // upstream's code is what calls it.
    el_window._dashboard_drawer_collapse = collapse;
    // EZiL: the desktop window's own restore path needs to replay the intro,
    // since the taskbar it was restored from is about to disappear again.
    el_window._ezil_drawer_flash = flash;

    $(el_window).append($drawer);
    // Two frames so the collapsed state paints first and the intro morphs out
    // of the tongue instead of popping in fully open. (Upstream.)
    if ( options.flash_on_attach !== false ) {
        requestAnimationFrame(() => requestAnimationFrame(flash));
    }

    return drawer;
}

export default attach_app_drawer;
