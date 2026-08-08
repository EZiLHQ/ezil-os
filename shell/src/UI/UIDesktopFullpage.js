/**
 * Copyright (C) 2024-present Puter Technologies Inc.
 *
 * This file is part of Puter.
 *
 * Puter is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// MODIFIED BY EZIL 2026-07-31: extracted four functions from upstream
// `src/gui/src/UI/UIDesktop.js` (2,479 lines, at upstream commit 5a15719,
// approximately lines 2388-2450) and nothing else.
//
// UIDesktop.js is Puter's *filesystem* desktop: it builds an item container
// over `puter.fs`, wires socket.io for realtime `item.added`/`trash.is_empty`
// events, reads the wallpaper out of `puter.kv`, and owns the app launcher.
// None of that exists in EZiL-OS, so the other ~2,430 lines are not ported and
// the EZiL desktop root is written fresh instead. But `UIWindow.js` -- taken
// whole -- calls `window.enter_fullpage_mode`, `window.exit_fullpage_mode` and
// `window.reset_window_size_and_position` by name, so those three have to
// exist and behave the way UIWindow expects. This file is exactly that seam.
//
// Changes inside the extracted functions:
//   - `refresh_item_container($('.desktop.item-container'), ...)` is gone from
//     `exit_fullpage_mode`. It repopulated the desktop from `puter.fs`; there
//     are no filesystem icons to repaint. Left as a comment, not a stub call,
//     because on this path a rejecting stub would abort the rest of the
//     restore -- and a window that enters fullpage but never comes back is
//     precisely the class of half-working breakage this port is avoiding.
//   - `window.refresh_desktop_background()` (upstream `helpers.js`, reads the
//     wallpaper from `puter.kv`) is likewise dropped for the same reason: it
//     is the last statement of the restore and must not be able to throw.
// Everything else -- the CSS geometry, the taskbar rebuild, the 680x380 reset
// box, `window.window_border_radius` -- is upstream's, unchanged.

import UITaskbar from './UITaskbar.js';

// 🔴 The extraction originally started at upstream L2405 and MISSED this
// function by seventeen lines. It is not optional and it is not dead code:
//
//   `UIWindow.js:3633`      ($.fn.close) calls it on every window close
//   `UITaskbarItem.js:247`  calls it from "Remove from Taskbar"
//
// Its absence was invisible while the shell opened no app windows —
// `parseInt(undefined)` is NaN and `NaN === 1` is false, so close() never
// reached the call. The moment an app window exists (which auto-creates a
// taskbar item, UIWindow.js:596), closing it throws a ReferenceError INSIDE
// `$.fn.close` BEFORE `delete_window_element` runs: the taskbar item stays,
// the window stays on screen, and it is now unclosable. Verbatim from
// upstream L2388-2403.
// MODIFIED BY EZIL 2026-08-01: D1 fix (close-then-reopen loses its taskbar
// item). This used to unconditionally `$(item).remove()` once its 300ms of
// fade+shrink animation finished. `item` is a specific, already-resolved DOM
// node (the taskbar-item `<div>` for one app), NOT a re-run selector, so the
// bug was never "wrong node" -- it was TRUSTING STALE INTENT: the node is
// captured and this removal scheduled at the moment `$.fn.close`
// (UIWindow.js) decides the app's last window is closing (its
// `data-open-windows` count just hit zero). But the DOM node itself is not
// removed until this animation's completion callback fires, up to ~200ms
// later. If the same app is relaunched inside that window, UIWindow.js's
// window-creation code finds this SAME still-present node (its own
// same-app-taskbar-item selector matches it, since it hasn't been removed
// yet) and reuses it for the new window, bumping `data-open-windows` back to
// 1. This callback then ran anyway and deleted that node -- deleting the
// reopened window's only taskbar item.
// MEASURED: reopen at ~112ms -> windows=1, taskbarItems=0.
//
// Fix: re-check LIVE state at the moment of removal, not the state that was
// true when this animation was scheduled. If something has since claimed
// this node (`data-open-windows` > 0), it is no longer this callback's to
// delete -- undo the fade/shrink instead of finishing the removal. (The
// window-creation reuse path in UIWindow.js ALSO stops and restores this
// animation the instant it reclaims the node, so in practice this branch is
// the last-resort safety net, not the primary fix -- belt and braces, since
// this project has been bitten before by fixes that only worked from one
// side of a race.)
window.remove_taskbar_item = function (item) {
    const $item = $(item);
    if ( $item.length === 0 ) {
        return;
    }

    $item.find('*').fadeOut(100, function () {

    });

    $item.animate({ width: 0 }, 200, function () {
        const still_empty = (parseInt($item.attr('data-open-windows')) || 0) === 0;
        if ( ! still_empty ) {
            // Reclaimed by a newer window since this removal was scheduled:
            // undo the shrink/fade instead of deleting it out from under it.
            $item.stop(true, true).css('width', '');
            $item.find('*').stop(true, true).show();
            return;
        }

        $item.remove();

        // Adjust taskbar item sizes after removing an item
        if ( window.adjust_taskbar_item_sizes ) {
            setTimeout(() => {
                window.adjust_taskbar_item_sizes();
            }, 10);
        }
    });
};

// MODIFIED BY EZIL 2026-08-04 (W2 item 4): stash the window's geometry from
// the moment BEFORE it goes full-page, on the element itself (`dataset`
// survives detach/reattach and needs no separate registry to leak). Guarded
// so a SECOND `enter_fullpage_mode` on the same element (minimise -> restore
// -> full-bleed again) does not overwrite the one true "pre-fullpage" value
// with the fullpage geometry this function is about to apply.
// `reset_window_size_and_position` below reads it back and falls back to the
// historical 680x380 box only when nothing was ever stashed (e.g. a window
// that somehow reaches exit without ever having entered).
window.enter_fullpage_mode = (el_window) => {
    $('.taskbar').hide();
    $(el_window).find('.window-head').hide();
    $('body').addClass('fullpage-mode');
    if ( el_window && el_window.dataset.ezilPrevFpWidth === undefined ) {
        const $el = $(el_window);
        el_window.dataset.ezilPrevFpWidth = $el.css('width');
        el_window.dataset.ezilPrevFpHeight = $el.css('height');
        el_window.dataset.ezilPrevFpTop = $el.css('top');
        el_window.dataset.ezilPrevFpLeft = $el.css('left');
        el_window.dataset.ezilPrevFpBorderRadius = $el.css('border-radius');
    }
    $(el_window).css({
        width: '100%',
        height: '100%',
        top: `${window.toolbar_height }px`,
        left: 0,
        'border-radius': 0,
    });
};

// MODIFIED BY EZIL 2026-08-04 (W2 item 4): split out of `exit_fullpage_mode`
// below. This half is pure CHROME — taskbar, window head, the body class,
// the desktop's own height — and never touches the window's own geometry.
// Minimise (`_ezil_minimise` / `minimise_to_taskbar`, `shell/ezil/apps/`)
// should call THIS, not `exit_fullpage_mode`, so a window being minimised
// keeps its full-page size the whole time it is hidden: there is then
// nothing for `showWindow`'s restore to flash BEFORE `go_fullbleed`
// reapplies full-bleed, because the geometry never left full-bleed in the
// first place. `exit_fullpage_mode` (unchanged call sites: window close)
// still does chrome + geometry together.
window.exit_fullpage_chrome = (el_window) => {
    $('body').removeClass('fullpage-mode');
    window.taskbar_height = window.default_taskbar_height;
    // In fullpage mode the taskbar is never built, so create it on exit; otherwise just restore it.
    if ( $('.taskbar').length === 0 ) {
        UITaskbar();
    } else {
        $('.taskbar').css('height', window.taskbar_height);
        $('.taskbar').show();
    }
    // EZIL: upstream called refresh_item_container() here to repaint the
    // desktop's filesystem icons. There is no filesystem. See header.
    // MODIFIED BY EZIL 2026-08-08: `removeAttr` moved INSIDE the guard it was
    // sitting one line above. It only ever looked harmless because
    // `$(undefined)` is an empty jQuery set and so the call quietly did
    // nothing — the guard on the next line existed precisely because
    // `el_window` is optional, and this statement was outside it by accident.
    // It matters now: `style.css`'s minimise-button rule is keyed on
    // `data-is_fullpage`, so this is the write that gives a window its head
    // controls back, and it belongs with the rest of the per-window restore.
    //
    // 🔴 MERGE NOTE: the `removeAttr` moves in here, but the
    // `reset_window_size_and_position` that accompanied it on the branch does
    // NOT. W2 item 4 split this function out of `exit_fullpage_mode` precisely
    // so that CHROME could be restored without touching GEOMETRY — a window
    // being minimised keeps its full-page size the whole time it is hidden, so
    // there is nothing for `showWindow` to flash before `go_fullbleed`
    // reapplies full-bleed. Geometry now lives in `exit_fullpage_mode` below,
    // behind the `data-closing` guard from W2 item 2. Restoring it here would
    // undo both.
    if ( el_window ) {
        $(el_window).removeAttr('data-is_fullpage');
        $(el_window).find('.window-head').show();
    }

    // reset dektop height to take into account the taskbar height
    $('.desktop').css('height', `calc(100vh - ${window.taskbar_height + window.toolbar_height}px)`);

    // EZIL: upstream called window.refresh_desktop_background() here; the
    // wallpaper lived in puter.kv. See header.
};

window.exit_fullpage_mode = (el_window) => {
    window.exit_fullpage_chrome(el_window);
    // MODIFIED BY EZIL 2026-08-04 (W2 item 2): skip the geometry reset for a
    // window mid-close (`data-closing` is stamped synchronously, before any
    // `await`, by `$.fn.close` in UIWindow.js) — resetting geometry on a
    // window already animating out would jump it to a floating box first,
    // which is exactly the flash this change exists to avoid on the OTHER
    // path (minimise). A window that isn't closing still gets its geometry
    // restored here, same as before this change.
    if ( el_window && $(el_window).attr('data-closing') !== '1' ) {
        window.reset_window_size_and_position(el_window);
    }
};

window.reset_window_size_and_position = (el_window) => {
    const ds = el_window && el_window.dataset;
    const has_stash = !! (ds && ds.ezilPrevFpWidth !== undefined);
    $(el_window).css({
        width: has_stash ? ds.ezilPrevFpWidth : 680,
        height: has_stash ? ds.ezilPrevFpHeight : 380,
        'border-radius': has_stash ? ds.ezilPrevFpBorderRadius : window.window_border_radius,
        top: has_stash ? ds.ezilPrevFpTop : 'calc(50% - 190px)',
        left: has_stash ? ds.ezilPrevFpLeft : 'calc(50% - 340px)',
    });
    if ( has_stash ) {
        delete ds.ezilPrevFpWidth;
        delete ds.ezilPrevFpHeight;
        delete ds.ezilPrevFpTop;
        delete ds.ezilPrevFpLeft;
        delete ds.ezilPrevFpBorderRadius;
    }
};

export default {
    remove_taskbar_item: window.remove_taskbar_item,
    enter_fullpage_mode: window.enter_fullpage_mode,
    exit_fullpage_chrome: window.exit_fullpage_chrome,
    exit_fullpage_mode: window.exit_fullpage_mode,
    reset_window_size_and_position: window.reset_window_size_and_position,
};
