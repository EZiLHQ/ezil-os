// boot.js — EZiL-authored. The single entry point `shell/build-shell.sh` hands
// to esbuild; everything that ends up in `app/public/os/bundle.min.js` is
// reachable from here.
//
// ── What this replaces ──────────────────────────────────────────────────────
// Upstream Puter's `src/gui/src/initgui.js` is 2,322 lines. The overwhelming
// majority of it is the cloud identity flow this fork does not have: the
// signup/login/2FA/password-recovery dialog chain, the temporary-user
// provisioning path, `puter.auth` token exchange, the `/whoami` bootstrap, the
// socket.io connection with its dozen realtime subscriptions, the app-launch
// deep-link router, and the desktop's own filesystem hydration. None of it
// crosses. What is left — install the globals, decide the device class, build a
// desktop root, build a taskbar, open something — is this file.
//
// ── The rule that shapes it: never wait on the container ────────────────────
// A cold desktop boot is ~22s (docs/PLATFORM-NOTES.md §11). Everything below
// runs against data already in the document (`window.__EZIL_BOOT__`, inlined by
// `app/src/app/os/page.tsx`), so the wallpaper and the taskbar are on screen
// before any request exists. The container boots BEHIND the desktop window's
// own progress panel, and the user can minimise it and use the OS meanwhile.
//
// ── Load order below is LOAD-BEARING ────────────────────────────────────────
// ES `import` declarations are hoisted and a module's dependencies evaluate,
// in source order, before its own body — so the order these appear in is the
// order they run in:
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
// windows that never attach. `/os` uses `defer`.

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
// The globals UIWindow's open/close path calls that upstream defines in
// un-ported files. Must evaluate before any window is closed; see the file's
// header for why only four of the twenty missing ones are defined.
import '../src/ezil-app-lifecycle.js';
import { PuterBackendRemovedError, puter } from '../src/ezil-stubs.js';

import session from './session.js';
import registry from './apps/registry.js';

const PHASE = 'ezil-os:boot';

export const shell = {
    version: 1,
    session,
    registry,

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

    /** The boot payload this shell started from, or null. */
    payload: null,
    /** The `.desktop` root element, once mounted. */
    desktop: null,

    booted: false,
    mounted: false,
};

/**
 * Upstream (`initgui.js:952-968`) writes this with
 * `$('body').attr('class', 'device-desktop')`, which REPLACES every class on
 * the element. That is safe on a page Puter owns outright; it is not safe
 * here, where `/os` inherits the Next app's root layout and the body already
 * carries Tailwind classes. `addClass` instead — same resulting selector, no
 * collateral.
 *
 * 🔴 This is not cosmetic. `style.css:1014` reads
 * `.fullpage-mode.device-desktop .window-body-app { height: calc(100%) }`.
 * Without the class the generic `.window-body-app { height: calc(100% - 30px) }`
 * wins and the full-bleed desktop iframe is 30 pixels short of the viewport
 * for its entire life.
 */
function set_device_class () {
    let cls = 'device-desktop';
    if ( isMobile.phone ) {
        cls = 'device-phone';
    } else if ( isMobile.tablet ) {
        // Upstream's "smarter check": a tablet with a real pointer gets the
        // desktop UI; a touch-only one gets the mobile UI.
        const has_pointer = window.matchMedia && window.matchMedia('(hover: hover)').matches;
        cls = has_pointer ? 'device-desktop' : 'device-tablet';
    }
    $('body').addClass(cls);
    return cls;
}

/**
 * The desktop root — the wallpaper layer, the taskbar's parent, and the drop
 * target the ported CSS expects. Upstream builds this in `UIDesktop.js` out of
 * a `puter.fs` listing of the user's Desktop folder; there is no filesystem
 * here, so it is an empty container and any icons come later, from apps.
 *
 * Reuses an existing `.desktop` if one is already in the document, so a second
 * call (or a host page that pre-rendered one) cannot produce two.
 */
function mount_desktop_root () {
    const existing = document.querySelector('.desktop');
    if ( existing ) return existing;

    // `/os` renders `<div id="ezil-os-root">` for us to fill. Falling back to
    // <body> keeps the bundle usable on a bare page (the headless load test,
    // and any future host that just wants the shell).
    const host = document.getElementById('ezil-os-root') ?? document.body;
    const el = document.createElement('div');
    el.className = 'desktop ezil-desktop';
    host.appendChild(el);
    return el;
}

/**
 * The Start button's menu. Upstream opened a 500x500 popover backed by
 * `puter.apps` (recents, recommendations, search, drag-to-pin). There is no
 * app store to query, so this lists exactly what `registry.resolve()` returned
 * — today, one thing — using the ported context menu.
 */
function open_start_menu (apps, ctx, el_anchor) {
    const items = apps.map(app => ({
        html: app.name,
        // 🔴 `UIContextMenu`'s `icon` is interpolated as RAW HTML, not used as
        // an `<img src>` — upstream passes emoji ("📋", "📂"). OBSERVED in
        // Chromium: handing it the descriptor's data URI printed the entire
        // URI as visible text next to the app name. It has to be markup.
        icon: `<img src="${html_encode(app.icon)}" alt="" style="width:16px;height:16px;border-radius:3px;vertical-align:middle">`,
        onClick: () => { void registry.launch(app.id, ctx); },
    }));
    if ( items.length === 0 ) items.push({ html: 'Nothing to open', disabled: true });

    const rect = el_anchor?.getBoundingClientRect?.();
    UIContextMenu({
        items,
        // Above the dock, left-aligned to the button. The context menu clamps
        // itself to the viewport, so a bad rect degrades to a visible menu
        // rather than one off-screen.
        position: rect ? { top: rect.top - 8, left: rect.left } : undefined,
    });
}

/**
 * Everything after the globals: the desktop, the taskbar, and exactly one
 * window. Not awaited by `boot()` — the caller's frame must not be held open
 * by window construction.
 */
async function mount (payload) {
    if ( shell.mounted ) {
        console.info(`[${PHASE}] already mounted; ignoring`);
        return;
    }
    shell.mounted = true;

    const t0 = performance.now();
    const ctx = {
        payload,
        computer: payload.computer,
        desktopState: payload.desktopState,
    };

    shell.desktop = mount_desktop_root();
    const apps = registry.resolve(payload);

    // The taskbar. Built BEFORE the window, so it exists for
    // `exit_fullpage_mode` to un-hide rather than have to re-create, and so
    // the first paint already has a dock in it.
    await UITaskbar({});

    // Pinned items, created up front rather than left to `UIWindow` — an app
    // pinned here survives its window being closed (UIWindow's own item is
    // created with `keep-in-taskbar="false"` and is removed on the last
    // close), so the dock does not empty itself the first time someone closes
    // the desktop. UIWindow sees the item already exists and just increments
    // its open-window count.
    for ( const app of apps.filter(a => a.pinned) ) {
        UITaskbarItem({
            app: app.id,
            name: app.name,
            icon: app.icon,
            keep_in_taskbar: true,
            lock_keep_in_taskbar: true,
            open_windows_count: 0,
            // Returning anything other than `false` suppresses UITaskbarItem's
            // built-in `showWindow()` — `launch` already restores an existing
            // window and opens one otherwise.
            onClick: () => { void registry.launch(app.id, ctx); },
        });
    }

    window.addEventListener('ezil:start-click', (e) => {
        open_start_menu(apps, ctx, e.detail?.element);
    });

    console.info(`[${PHASE}] desktop + taskbar painted in ${(performance.now() - t0).toFixed(1)}ms`);

    // 🔴 EXACTLY ONE WINDOW. Two windows racing for one cold container means
    // two boot spinners, one of which is lying, and a user with no way to tell
    // which. `shell.mounted` above, `single_instance` in the registry and
    // `single_instance` in UIWindow are three independent guards on the same
    // rule, because each of them can be bypassed by a different caller.
    const first = apps[0];
    if ( ! first ) {
        console.warn(`[${PHASE}] no apps to open`);
        return;
    }
    await registry.launch(first.id, ctx);
}

/**
 * Install the globals the ported code reads, start tracking the mouse so
 * window snapping works, and — if the page handed us a boot payload — build
 * the desktop. Idempotent.
 *
 * With NO payload this stops after the globals and draws nothing. That is
 * deliberate: a shell with no payload does not know who it is or which
 * computer it owns, and a desktop drawn for nobody is worse than a blank page.
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
    set_device_class();

    // Snapping, drag-target detection and the mouseover-window z-order probe
    // all read state that only this handler maintains.
    document.addEventListener('mousemove', (e) => {
        update_mouse_position(e.clientX, e.clientY);
    });

    shell.booted = true;

    const payload = session.payload();
    shell.payload = payload;
    if ( ! payload ) {
        console.warn(`[${PHASE}] no window.__EZIL_BOOT__; globals installed, desktop NOT drawn`);
        return shell;
    }

    console.info(
        `[${PHASE}] shell ready (v${shell.version}) in ${(performance.now() - t0).toFixed(1)}ms`,
    );
    // Not awaited: `boot()` returns as soon as the OS is on screen.
    void mount(payload).catch((err) => {
        console.error(`[${PHASE}] mount failed`, err);
    });
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

// Self-starting, because nothing else calls it. `/os` emits three plain
// <script> tags and no inline bootstrap; a bundle that waited to be invoked
// would sit on the page doing nothing at all. `defer` guarantees the document
// is parsed by the time this runs, so there is no readyState dance.
if ( typeof document !== 'undefined' && typeof window !== 'undefined' ) {
    boot();
}

export default shell;
