// full-view.js — EZiL-authored. Not Puter code.
//
// ONE window owning the viewport: no taskbar, no window head, the window at
// 100% x 100% with an OS control strip across its top. The Browser has done
// this since Wave 1 under the name "full-bleed" (`go_fullbleed` in
// `../apps/desktop-window.js`); app-code lane A2 (2026-10-30) gives the Code
// window the same mode, so the mechanism now lives here and both windows call
// it. The Browser's behaviour is unchanged — every DOM write below is the one
// `go_fullbleed` / `minimise_to_taskbar` made, in the same order.
//
// ── What "full view" is, mechanically ──────────────────────────────────────
//   - `window.enter_fullpage_mode` (`../../src/UI/UIDesktopFullpage.js`) hides
//     the taskbar and this window's head, sizes the window to the viewport, and
//     stashes the pre-full geometry on the element (`data-ezil-prev-fp-*`).
//   - `ezil-fullbleed` on the window says "this window is in full view NOW".
//     The class name is historical and kept on purpose: `feedback.js` (the
//     Feedback icon's strip position), `diagnostics.js`, the boot and browser
//     suites and several e2e journeys all read it. It is EZiL's own, NOT
//     `data-is_fullpage`, because upstream's `exit_fullpage_mode` removes that
//     attribute, so it cannot answer "is this window full right now" across a
//     minimise.
//   - `data-is_fullpage="1"` is written too, because `$.fn.close`
//     (UIWindow.js) reads it to decide whether it owes the user a taskbar back.
//   - `ezil-full-view-host` marks a window that CAN go full view. The shared
//     strip/drawer/handle rules in `ezil-shell.css` key off it (they were keyed
//     off `.ezil-desktop-window` when the Browser was the only such window).
//
// ── Wanting full view vs being in it ───────────────────────────────────────
// `wants` is the DESIRE and outlives a minimise: minimise is chrome-only
// (`exit_fullpage_chrome`, never `exit_fullpage_mode` — see the long note on
// `minimise_to_taskbar` in desktop-window.js for the flicker that rule fixed),
// so a window restored from the taskbar goes back to full view only if it still
// wants to. `exit()` clears the desire and restores the stashed bounds — the
// Code window's "restore to window"; the Browser never leaves full view except
// by minimise or close.
//
// ── 🔴 No exit, no entry ───────────────────────────────────────────────────
// Full view hides the taskbar and the head. A window whose own way out (the
// control drawer, and for Code the top bar) failed to attach calls `forbid()`
// and is never put into full view: staying windowed is worse-looking and
// strictly better than trapping the user inside it.
//
// ── Two windows in full view ───────────────────────────────────────────────
// Before Code had a full view this could not happen. Leaving full view (exit
// or minimise) gives the taskbar back only when no OTHER visible window is
// still in full view; otherwise only this window's own head comes back. With
// one full window — every state the Browser could reach before — this is
// exactly `exit_fullpage_chrome`. Closing is the same rule through
// `prepare_close()`, which a window's `on_before_exit` calls: `$.fn.close`
// (UIWindow.js, not this lane's) would otherwise always restore the taskbar.
//
// 🔴 This module never calls the browser Fullscreen API. "Full view" is a
// layout mode inside the page, not `requestFullscreen()`.

/** Is the window in full view right now. */
export const FULL_VIEW_CLASS = 'ezil-fullbleed';
/** A window that can go full view (keys the shared CSS). */
export const FULL_VIEW_HOST_CLASS = 'ezil-full-view-host';

/** `data-is_minimized` is written as 1/0 at creation and true/false later. */
export function is_minimized (el) {
    const v = $(el).attr('data-is_minimized');
    return v === '1' || v === 'true';
}

/** Another rendered, non-minimised, non-closing window is in full view. */
function other_full_view_visible (el) {
    return [...document.querySelectorAll(`.window.${FULL_VIEW_CLASS}`)].some(w => w !== el
        && ! is_minimized(w) && w.getAttribute('data-closing') !== '1' && w.isConnected);
}

/** Give back the chrome this window's full view took (see the header). */
function release_chrome (el) {
    if ( other_full_view_visible(el) ) {
        $(el).removeAttr('data-is_fullpage');
        $(el).find('.window-head').show();
        return;
    }
    window.exit_fullpage_chrome(el);
}

/**
 * @param {HTMLElement} el_window
 * @returns {{
 *   enter: () => boolean, exit: () => boolean, minimise: () => void,
 *   settle: () => void, prepare_close: () => void,
 *   watch_restore: (fn: () => void) => MutationObserver,
 *   is_full: () => boolean, forbid: () => void,
 *   readonly wants: boolean, readonly allowed: boolean,
 * }}
 */
export function createFullView (el_window) {
    let wants = false;
    let may = true;
    el_window.classList.add(FULL_VIEW_HOST_CLASS);
    const is_full = () => el_window.classList.contains(FULL_VIEW_CLASS);
    const has_stash = () => el_window.dataset.ezilPrevFpWidth !== undefined;

    /**
     * Take the viewport. Records the desire first, then does nothing while the
     * window may not, is minimised (the restore finishes the job — see
     * `watch_restore`), or already is. Returns whether it entered just now.
     */
    function enter () {
        wants = true;
        if ( ! may ) return false;
        if ( is_minimized(el_window) ) return false;
        if ( is_full() ) return false;

        el_window.classList.add(FULL_VIEW_CLASS);
        window.enter_fullpage_mode(el_window);
        // `$.fn.close` reads this to decide whether it owes the user a taskbar
        // back (UIWindow.js). It is '0' until now, because until now the
        // taskbar was never hidden.
        $(el_window).attr('data-is_fullpage', '1');
        // 🔴 `style.css` gives `.window-app-iframe` `pointer-events: none` and
        // only `.window-active .window-app-iframe` gets them back. A window
        // that is not active would render perfectly and ignore every click.
        $(el_window).focusWindow();
        // The drawer is now a way out; let it introduce itself.
        el_window._ezil_drawer_flash?.();
        return true;
    }

    /**
     * Back to an ordinary window at the bounds it had before full view (the
     * stash `enter_fullpage_mode` wrote). Clears the desire. While minimised it
     * only clears the desire; `settle()` on the restore restores the bounds.
     * Returns whether it left full view just now.
     */
    function exit () {
        wants = false;
        if ( ! is_full() ) {
            if ( ! is_minimized(el_window) ) settle();
            return false;
        }
        el_window.classList.remove(FULL_VIEW_CLASS);
        release_chrome(el_window);
        window.reset_window_size_and_position(el_window);
        return true;
    }

    /**
     * A window that no longer wants full view but still has full-view geometry
     * (it was minimised FROM full view, which is chrome-only) goes back to its
     * stashed bounds. A no-op otherwise.
     */
    function settle () {
        if ( wants || is_full() || ! has_stash() ) return;
        window.reset_window_size_and_position(el_window);
    }

    /**
     * 🔴 Order matters: the chrome comes back BEFORE `hideWindow`, so the
     * window has a taskbar item to animate into and the user a way back.
     * Chrome only — the geometry stays full while hidden (see the header). A
     * windowed window just hides.
     */
    function minimise () {
        if ( is_full() ) {
            // The class comes off so a later `enter()` is not turned away by
            // its own already-full early return; that call puts the chrome back.
            el_window.classList.remove(FULL_VIEW_CLASS);
            release_chrome(el_window);
        }
        $(el_window).hideWindow();
    }

    /**
     * For the window's `on_before_exit`, which `$.fn.close` awaits BEFORE its
     * own full-page exit (UIWindow.js). That exit always gives the taskbar back
     * — right for the last full window, wrong while another one is still in
     * full view. So in exactly that case this window hands back only its own
     * head and drops `data-is_fullpage`, and `$.fn.close` then has no taskbar
     * to restore. Geometry is left alone (the window is closing). With no
     * other full window — every state the Browser could reach before Code had
     * a full view — it does nothing.
     */
    function prepare_close () {
        if ( ! is_full() || ! other_full_view_visible(el_window) ) return;
        el_window.classList.remove(FULL_VIEW_CLASS);
        $(el_window).removeAttr('data-is_fullpage');
        $(el_window).find('.window-head').show();
    }

    /**
     * Call `fn` each time the window comes back from the taskbar. `showWindow`
     * has no hook of its own, so this watches the attribute it writes — which
     * keeps the whole job inside EZiL code. The caller decides what a restore
     * means (re-enter when `wants`, or `settle()`), and disconnects on dispose.
     */
    function watch_restore (fn) {
        let was = is_minimized(el_window);
        const observer = new MutationObserver(() => {
            const now = is_minimized(el_window);
            if ( was && ! now ) fn();
            was = now;
        });
        observer.observe(el_window, { attributes: true, attributeFilter: ['data-is_minimized'] });
        return observer;
    }

    return {
        enter,
        exit,
        settle,
        minimise,
        prepare_close,
        watch_restore,
        is_full,
        forbid () { may = false; },
        get wants () { return wants; },
        get allowed () { return may; },
    };
}

export default createFullView;
