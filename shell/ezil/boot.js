// boot.js — EZiL-authored. The single entry point `shell/build-shell.sh` hands
// to esbuild; everything that ends up in `app/public/os/bundle.min.js` is
// reachable from here.
//
// Load order below is LOAD-BEARING and is the reason this file is a chain of
// side-effecting imports rather than a tidy list. ES `import` declarations are
// hoisted and a module's dependencies evaluate, in source order, before its own
// body — so the order these appear in is the order they run in:
//
//   1. lib/ezil-vendor.js   publishes $ / jQuery / jQuery UI / html_encode /
//                           isMobile as real globals. UIWindow.js assigns
//                           `$.fn.showWindow` at module top level, so jQuery
//                           must exist before step 4 is even evaluated.
//   2. ezil-globals.js      is imported here but CALLED from boot(), not at
//                           import time, because it touches localStorage and
//                           reads window.innerWidth.
//   3. i18n/i18n.js         installs window.i18n. UIWindow.js has 73 i18n()
//                           calls; all are runtime, but UITaskbar calls
//                           i18n('start') the moment it builds.
//   4. UI/*.js              the ported Puter window manager.
//
// One thing this file cannot fix: upstream `UIWindow.js` runs
// `document.getElementsByTagName('body')[0]` at module scope. The bundle must
// therefore be loaded with `defer`, as `type="module"`, or at the end of
// <body>. A plain blocking <script> in <head> yields a null body reference and
// windows that never attach.

import '../src/lib/ezil-vendor.js';
import install_globals from '../src/ezil-globals.js';
import '../src/i18n/i18n.js';
import '../src/helpers/uuidv4.js';
import update_mouse_position from '../src/helpers/update_mouse_position.js';
import UIWindow from '../src/UI/UIWindow.js';
import UIComponentWindow from '../src/UI/UIComponentWindow.js';
import UIAlert from '../src/UI/UIAlert.js';
import UIContextMenu from '../src/UI/UIContextMenu.js';
import UIPopover from '../src/UI/UIPopover.js';
import UITaskbar from '../src/UI/UITaskbar.js';
import UITaskbarItem from '../src/UI/UITaskbarItem.js';
import '../src/UI/UIDesktopFullpage.js';
import { PuterBackendRemovedError, puter } from '../src/ezil-stubs.js';

import session from './session.js';

const PHASE = 'ezil-os:boot';

export const shell = {
    version: 1,
    session,

    // The ported window manager. See shell/PUTER-PROVENANCE.md for what each
    // of these is and how much of it is upstream.
    UIWindow,
    UIComponentWindow,
    UIAlert,
    UIContextMenu,
    UIPopover,
    UITaskbar,
    UITaskbarItem,
    update_mouse_position,

    /** Thrown/rejected by every removed cloud call. Exported so callers can
     *  tell "this fork does not do that" from "this fork is broken". */
    PuterBackendRemovedError,
    puter,

    /** Set by the desktop root once mounted. Still owned by a later wave. */
    desktop: null,

    booted: false,
};

/**
 * Install the globals the ported code reads, and start tracking the mouse so
 * window snapping works. Idempotent.
 *
 * Deliberately does NOT build a desktop or a taskbar — `app/` is owned by a
 * parallel agent and nothing here is wired to it yet.
 */
export function boot () {
    // Phase-tagged, timestamped logging — the only observability that survives
    // into the browser. See docs/PLATFORM-NOTES.md §11.
    const t0 = performance.now();

    if ( shell.booted ) {
        console.info(`[${PHASE}] already booted; ignoring`);
        return shell;
    }

    install_globals();

    // Snapping, drag-target detection and the mouseover-window z-order probe
    // all read state that only this handler maintains.
    document.addEventListener('mousemove', (e) => {
        update_mouse_position(e.clientX, e.clientY);
    });

    shell.booted = true;
    console.info(
        `[${PHASE}] shell ready (v${shell.version}) in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    return shell;
}

// `boot` is attached to the same object the global points at. Without this,
// `globalThis.ezil` looks like the entry point but has no way to start —
// esbuild's `--global-name` puts the module's exports on `globalThis.EzilShell`
// instead, and a caller reaching for `ezil.boot()` gets "not a function".
// Caught by the headless load test, not by `node --check`.
shell.boot = boot;

if ( typeof globalThis !== 'undefined' ) {
    globalThis.ezil = shell;
}

export default shell;
