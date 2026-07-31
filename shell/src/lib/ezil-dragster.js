// ezil-dragster.js — EZiL-authored. Not Puter code, and not a copy of the
// jquery.dragster plugin either.
//
// WHY THIS EXISTS. `jquery.dragster.js` is on the DO-NOT-TAKE list along with
// seven other vendored libs. Seven of those eight really are unused. This one
// is not: `UI/UIWindow.js` — which was ported WHOLE and must not be pruned in
// this wave — calls `$(el).dragster({...})` three times, and the very first
// call runs unconditionally on every single window that is ever created. With
// no such plugin, `UIWindow()` throws `$(...).dragster is not a function` after
// it has already appended the window to the DOM. That is the exact failure
// shape this port was told to avoid: the window renders, so it looks fine, and
// then everything after line 1716 of the constructor silently never runs.
// (Found by shell's headless load test, not by `node --check`.)
//
// The alternative to writing this was vendoring the plugin, which the take list
// forbids. So the plugin is not taken; its BEHAVIOUR is reimplemented here from
// first principles, in EZiL's own code, in ~30 lines.
//
// WHAT IT HAS TO DO. Native HTML5 `dragenter`/`dragleave` fire again every time
// the pointer crosses a *descendant* boundary, so a naive handler flickers
// enter/leave/enter/leave while dragging across a window's own children. The
// fix is to count: only the first enter and the last leave are real. That is
// the entire purpose of the plugin, and it is what is reproduced below — with a
// depth counter rather than the original's two booleans, which behaves the same
// for one level of nesting and is correct for arbitrary depth as well.
//
// WHAT IT AFFECTS IN THIS FORK. Of UIWindow's three call sites, two are
// external-file drops that call `window.upload_items` — dead here, there is no
// filesystem. The first one is not: it is the window manager's "drag something
// over a background window for 1.4s and it comes to the front" behaviour, which
// is real chrome and would have been lost to a no-op stub.

import './ezil-jquery.js';

$.fn.dragster = function (options) {
    const settings = $.extend({
        enter: $.noop,
        leave: $.noop,
        over: $.noop,
        drop: $.noop,
    }, options);

    return this.each(function () {
        const $this = $(this);
        // Nesting depth of the drag inside this element's subtree. Enter fires
        // on the 0 -> 1 transition, leave on the 1 -> 0 transition.
        let depth = 0;

        const fire = (name, event) => {
            // The upstream plugin dispatched a `dragster:*` jQuery event and
            // bound the callback to it. Calling directly is equivalent for
            // every call site in this codebase and avoids leaking four event
            // names per window into a namespace we do not own.
            settings[name].call(this, { dragsterEvent: true, type: `dragster:${name}` }, event);
        };

        $this.on({
            dragenter: function (event) {
                depth++;
                if ( depth === 1 ) fire('enter', event);
                event.preventDefault();
            },
            dragleave: function (event) {
                if ( depth > 0 ) depth--;
                if ( depth === 0 ) fire('leave', event);
                event.preventDefault();
            },
            dragover: function (event) {
                fire('over', event);
                event.preventDefault();
            },
            drop: function (event) {
                // A drop ends the drag outright, however deep it was.
                depth = 0;
                fire('drop', event);
                event.preventDefault();
            },
        });
    });
};

export default $.fn.dragster;
