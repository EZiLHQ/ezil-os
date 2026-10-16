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

    // The opt-in branch keeps the Puter tray below unchanged. Full-bleed's
    // only exit must fail closed to windowed mode (desktop-window.js:2070).
    if ( options.variant === 'floating' ) return attach_floating_drawer(el_window, options);

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
        if ( e.pointerType === 'mouse' ) {
            expand();
            // Enter can fire when full-bleed moves the drawer underneath the
            // pointer still resting on the dock. Let that idle hover retract
            // instead of leaving the controls open over the stream forever.
            schedule_collapse(2600);
        }
    });
    $drawer.on('pointermove', (e) => {
        if ( e.pointerType === 'mouse' && ! drawer.classList.contains('collapsed') ) {
            schedule_collapse(3500);
        }
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
    //
    // 🔴 `pointerdown` as well as `mousedown`, for the touch case: a mobile
    // browser synthesizes `mousedown` only after `touchend`, so on a tap the
    // iframe's pointer-events came back one whole gesture too late and the
    // user's first tap was always swallowed. `pointerdown` fires for mouse,
    // touch and pen alike, at the start of the press. `mousedown` stays bound
    // as the fallback for anything without Pointer Events; the latch below
    // makes the pair fire `focusWindow()` exactly once, because that function
    // is not idempotent (every call bumps `window.last_window_zindex` and
    // re-runs the whole focus side effect). Same shape as `UIWindow.js`'s
    // `focus_on_press` — see the long comment there for why a latch and not a
    // time window, and why the guard lives in the binding.
    let pointer_press_pending = false;
    $drawer.on('pointerdown mousedown', (e) => {
        if ( e?.type === 'pointerdown' ) {
            pointer_press_pending = true;
        } else if ( pointer_press_pending ) {
            pointer_press_pending = false;
            return;
        }
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

// Floating chrome follows docs/FEEDBACK-CONTROLS-CONTRACT.md:28. It shares
// upstream's timer/intro conventions, but owns its DOM so legacy geometry,
// action order and focus behaviour cannot change when the flag is absent.
function attach_floating_drawer (el_window, options) {
    let drawer;
    const cleanups = [];
    try {
        drawer = document.createElement('div');
        drawer.className = 'dashboard-app-drawer ezil-app-drawer ezil-floating-drawer collapsed';
        drawer.innerHTML = `
            <button type="button" class="dashboard-app-drawer-toggle" aria-expanded="false" aria-label="Window controls" title="Window controls">
                <span class="dashboard-app-drawer-grabber" aria-hidden="true"></span>
            </button>
            <div class="dashboard-app-drawer-clip">
                <div class="dashboard-app-drawer-controls" role="toolbar" aria-label="Window controls" aria-hidden="true">
                    <div class="ezil-traffic-lights"></div>
                    <div class="ezil-drawer-identity">
                        <img class="dashboard-app-drawer-icon" alt="" draggable="false">
                        <span class="dashboard-app-drawer-title"></span>
                    </div>
                    <div class="ezil-drawer-actions"></div>
                </div>
            </div>
            <div class="ezil-drawer-status" aria-live="polite" aria-atomic="true"></div>
            <div class="ezil-drawer-menu" role="menu" aria-label="More window controls" hidden></div>`;
        const toggle = drawer.querySelector('.dashboard-app-drawer-toggle');
        const controls = drawer.querySelector('.dashboard-app-drawer-controls');
        const lights = drawer.querySelector('.ezil-traffic-lights');
        const actions = drawer.querySelector('.ezil-drawer-actions');
        const menu = drawer.querySelector('.ezil-drawer-menu');
        const status = drawer.querySelector('.ezil-drawer-status');
        const icon = drawer.querySelector('.dashboard-app-drawer-icon');
        icon.src = options.icon || window.icons?.['app.svg'] || '';
        icon.hidden = ! (options.icon || window.icons?.['app.svg']);
        drawer.querySelector('.dashboard-app-drawer-title').textContent = options.title || '';

        let collapse_timer = null;
        let opened_at = 0;
        let previous_focus = null;
        let restoring_focus = false;
        let pointer_inside = false;
        let roving_button;
        const toolbar_buttons = () => Array.from(controls.querySelectorAll('button'));
        const update_tabindex = () => {
            for ( const button of toolbar_buttons() ) {
                button.tabIndex = ! drawer.classList.contains('collapsed') && button === roving_button ? 0 : -1;
            }
        };
        const reveal = (from = document.activeElement) => {
            clearTimeout(collapse_timer);
            if ( drawer.classList.contains('collapsed') ) {
                previous_focus = from;
                opened_at = Date.now();
            }
            drawer.classList.remove('collapsed');
            toggle.setAttribute('aria-expanded', 'true');
            controls.removeAttribute('aria-hidden');
            update_tabindex();
        };
        const close_menu = (focus = false) => {
            menu.hidden = true;
            overflow_button.setAttribute('aria-expanded', 'false');
            if ( focus ) overflow_button.focus();
        };
        const collapse = (restore = drawer.contains(document.activeElement)) => {
            clearTimeout(collapse_timer);
            close_menu();
            drawer.classList.add('collapsed');
            toggle.setAttribute('aria-expanded', 'false');
            controls.setAttribute('aria-hidden', 'true');
            update_tabindex();
            if ( restore ) {
                // focusin normally reveals. Suppress only the focus we restore
                // ourselves, or Escape's fallback would reopen the same tray
                // (docs/FEEDBACK-CONTROLS-CONTRACT.md:53).
                restoring_focus = true;
                const target = previous_focus?.isConnected && ! drawer.contains(previous_focus)
                    && previous_focus !== document.body ? previous_focus : toggle;
                target.focus();
                if ( document.activeElement !== target ) toggle.focus();
                restoring_focus = false;
            }
        };
        const schedule_collapse = (ms = 1500) => {
            clearTimeout(collapse_timer);
            collapse_timer = setTimeout(() => {
                // Timers queued by pointerleave/intro must not hide a keyboard
                // user's controls or an open menu; the legacy timer at
                // app-drawer.js:148 predates this keyboard toolbar.
                if ( ! pointer_inside && ! drawer.contains(document.activeElement) && menu.hidden ) collapse();
            }, ms);
        };
        const flash = () => { reveal(); schedule_collapse(2600); };
        const invoke = (handler) => {
            try { handler(); }
            catch (err) {
                console.error(`[${PHASE}] floating handler threw`, err);
                telemetry.capture({ eventClass: 'window_error', site: 'ezil-os:ui/app-drawer#handler',
                    code: 'drawer_handler_threw', detail: err });
            }
        };
        const button = (parent, label, className, glyph, handler, retract = true) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = `dashboard-app-drawer-btn ${className}`;
            btn.title = label;
            btn.setAttribute('aria-label', label);
            btn.tabIndex = -1;
            const mark = document.createElement('span');
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = glyph;
            btn.append(mark);
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                if ( retract ) collapse();
                invoke(handler);
            });
            parent.append(btn);
            return btn;
        };
        const traffic = options.traffic || {};
        roving_button = button(lights, 'Close', 'dashboard-app-drawer-close', '×',
            traffic.on_close ?? (() => $(el_window).close()));
        button(lights, 'Minimise', 'dashboard-app-drawer-minimize', '−', traffic.on_minimize);
        const expand_button = traffic.expand_supported
            ? button(lights, 'Enter full screen', 'ezil-traffic-expand', '+', traffic.on_expand, false) : null;
        const set_fullscreen = (active) => {
            if ( ! expand_button ) return;
            expand_button.setAttribute('aria-pressed', String(!! active));
            const label = active ? 'Exit full screen' : 'Enter full screen';
            expand_button.setAttribute('aria-label', label);
            expand_button.title = label;
            expand_button.firstElementChild.textContent = active ? '−' : '+';
        };
        set_fullscreen(false);
        const overflow_button = button(actions, 'More window controls', 'ezil-drawer-overflow', '⋯', () => {
            if ( ! menu.hidden ) { close_menu(true); return; }
            reveal();
            menu.hidden = false;
            overflow_button.setAttribute('aria-expanded', 'true');
            menu.firstElementChild?.focus();
        }, false);
        overflow_button.setAttribute('aria-haspopup', 'menu');
        overflow_button.setAttribute('aria-expanded', 'false');
        if ( typeof options.on_feedback === 'function' ) {
            button(actions, 'Feedback', 'ezil-drawer-feedback', 'Feedback', options.on_feedback);
        }
        const overflow_items = new Map();
        const add_overflow_item = (item) => {
            if ( overflow_items.has(item.id) ) return;
            const btn = button(menu, item.label, item.className || '', item.label, item.onClick);
            btn.setAttribute('role', 'menuitem');
            overflow_items.set(item.id, btn);
        };
        for ( const item of options.overflow || [] ) add_overflow_item(item);

        drawer.addEventListener('focusin', (e) => {
            if ( restoring_focus ) return;
            reveal(e.relatedTarget);
            if ( controls.contains(e.target) && e.target.matches('button') ) {
                roving_button = e.target;
                update_tabindex();
            }
        });
        drawer.addEventListener('focusout', () => schedule_collapse());
        drawer.addEventListener('pointerenter', (e) => {
            if ( e.pointerType !== 'mouse' ) return;
            pointer_inside = true;
            reveal();
        });
        drawer.addEventListener('pointerleave', (e) => {
            if ( e.pointerType !== 'mouse' ) return;
            pointer_inside = false;
            schedule_collapse();
        });
        toggle.addEventListener('click', (e) => {
            e.stopPropagation();
            if ( drawer.classList.contains('collapsed') || Date.now() - opened_at < 500 ) reveal();
            else collapse();
        });
        drawer.addEventListener('keydown', (e) => {
            if ( e.key === 'Escape' ) {
                e.preventDefault();
                e.stopPropagation();
                if ( ! menu.hidden ) close_menu(true);
                else collapse(true);
                return;
            }
            const in_menu = menu.contains(e.target);
            const buttons = in_menu ? Array.from(menu.children) : toolbar_buttons();
            const index = buttons.indexOf(e.target);
            const backwards = in_menu ? 'ArrowUp' : 'ArrowLeft';
            const forwards = in_menu ? 'ArrowDown' : 'ArrowRight';
            if ( index >= 0 && [backwards, forwards, 'Home', 'End'].includes(e.key) ) {
                e.preventDefault();
                e.stopPropagation();
                const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
                    : (index + (e.key === backwards ? -1 : 1) + buttons.length) % buttons.length;
                buttons[next].focus();
            } else if ( (e.key === 'Enter' || e.key === ' ') && e.target.matches('button') ) {
                // Prevent the native follow-up click so each key activates
                // exactly once, including Space (the toolbar in
                // docs/FEEDBACK-CONTROLS-CONTRACT.md:53).
                e.preventDefault();
                e.stopPropagation();
                if ( ! e.repeat ) e.target.click();
            } else if ( e.key === 'Tab' && ! menu.hidden ) close_menu(true);
        });

        // Same latch as the legacy tray (app-drawer.js:249): touch must
        // activate its window before the stream's next gesture arrives.
        let pointer_press_pending = false;
        $(drawer).on('pointerdown mousedown', (e) => {
            if ( e.type === 'pointerdown' ) pointer_press_pending = true;
            else if ( pointer_press_pending ) { pointer_press_pending = false; return; }
            setTimeout(() => $(el_window).focusWindow(), 0);
        });
        const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
        const coarse = window.matchMedia('(any-pointer: coarse)');
        const update_mode = () => {
            const overlay = fine.matches && ! coarse.matches
                && ! document.body.matches('.device-phone, .device-tablet');
            // Contract puts the mode on the drawer; mirror it on the parent
            // so the sibling stream inherits strip height (ezil-shell.css:750).
            for ( const element of [drawer, el_window] ) {
                element.classList.toggle('ezil-mode-overlay', overlay);
                element.classList.toggle('ezil-mode-strip', ! overlay);
            }
        };
        for ( const query of [fine, coarse] ) {
            query.addEventListener('change', update_mode);
            cleanups.push(() => query.removeEventListener('change', update_mode));
        }
        const outside_press = (e) => {
            if ( ! drawer.contains(e.target) && (coarse.matches || e.pointerType === 'touch') ) collapse();
        };
        document.addEventListener('pointerdown', outside_press);
        cleanups.push(() => document.removeEventListener('pointerdown', outside_press));
        // A tap in the stream never bubbles out of its iframe. The shell's
        // focus moves to that element instead; dismiss without stealing it
        // back (the stream frame is selected in desktop-window.js:597).
        let blur_timer;
        const frame_press = () => {
            clearTimeout(blur_timer);
            blur_timer = setTimeout(() => {
                if ( coarse.matches && document.activeElement?.tagName === 'IFRAME' ) collapse(false);
            }, 0);
        };
        window.addEventListener('blur', frame_press);
        cleanups.push(() => window.removeEventListener('blur', frame_press), () => clearTimeout(blur_timer));
        let connected = el_window.isConnected;
        const observer = new MutationObserver((records) => {
            connected ||= drawer.isConnected;
            if ( connected && ! drawer.isConnected ) {
                for ( const cleanup of cleanups ) cleanup();
                return;
            }
            if ( records.some(record => record.target === document.body && record.type === 'attributes') ) update_mode();
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
        cleanups.push(() => observer.disconnect(), () => clearTimeout(collapse_timer));

        drawer.ezil_controls = {
            set_status: (text) => { status.textContent = text; },
            set_fullscreen,
            reveal: () => reveal(),
            collapse: () => collapse(),
            focus_grabber: () => toggle.focus(),
            add_overflow_item,
        };
        el_window.append(drawer);
        el_window.classList.add('ezil-floating-controls');
        update_mode();
        el_window._dashboard_drawer_collapse = () => collapse();
        el_window._ezil_drawer_flash = flash;
        if ( options.flash_on_attach !== false ) {
            let frame = requestAnimationFrame(() => { frame = requestAnimationFrame(flash); });
            cleanups.push(() => cancelAnimationFrame(frame));
        }
        return drawer;
    } catch (err) {
        for ( const cleanup of cleanups ) cleanup();
        drawer?.remove();
        el_window.classList.remove('ezil-floating-controls', 'ezil-mode-overlay', 'ezil-mode-strip');
        console.error(`[${PHASE}] floating drawer did not attach`, err);
        telemetry.capture({ eventClass: 'window_error', site: 'ezil-os:ui/app-drawer#attach',
            code: 'drawer_attach_failed', detail: err });
        return null;
    }
}
