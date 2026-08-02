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

/**
 * ── 🔴 THE HYDRATION CONTRACT ───────────────────────────────────────────────
 * `/os` is a React (Next.js App Router) document. React OWNS `<body>` and
 * `<div id="ezil-os-root">`: it rendered them on the server and it will
 * re-check them, node by node, when its own chunks arrive and it hydrates.
 *
 * If anything mutates a node React owns BEFORE that check, React finds a tree
 * it did not render, reports a hydration mismatch (minified error #418) and
 * REGENERATES THE WHOLE TREE from its own copy — deleting every element the
 * shell built. `suppressHydrationWarning` suppresses the warning, not the
 * regeneration. MEASURED on the production build with 900ms of latency on
 * `/_next/static/chunks/**`: 4 of 5 loads ended as a blank white page.
 *
 * So the shell does not touch a React-owned node until React says it has
 * hydrated. The host page opts into that handshake by marking its mount point
 * (`data-awaits-hydration="react"`, see `app/src/app/os/page.tsx`) and
 * dispatching `ezil:hydrated` from a client effect. A page with NO marker —
 * the headless tests, any future bare host — mounts immediately, exactly as
 * before; nothing is waiting for an event that will never arrive.
 *
 * Two independent guards back it up, because a handshake that can be missed
 * must not be the only thing standing between a user and a blank page:
 *   - the wait is CAPPED (`HYDRATION_CAP_MS`), so a page whose React never
 *     loads still gets an OS;
 *   - the mount is REBUILDABLE (`ensure_intact`), so if the desktop is ever
 *     removed from the document — by a late hydration, by a future mutation
 *     nobody predicted — the shell notices and builds it again. The failure
 *     mode degrades to "boots twice", never to "blank forever".
 */
const HYDRATION_ATTR = 'data-awaits-hydration';
const HYDRATION_EVENT = 'ezil:hydrated';
/**
 * How long to wait for `ezil:hydrated` before mounting anyway.
 *
 * Above the observed hydration time on a badly delayed production load (~1.1s
 * with 900ms of artificial latency on React's chunks) and far below anything a
 * user would sit through. Past it we accept a possible wipe — which
 * `ensure_intact` then repairs — rather than leave the page with no OS on it
 * because a script we do not control never ran.
 */
const HYDRATION_CAP_MS = 3_000;
/**
 * A mount that keeps disappearing is a bug, not a retry loop. One initial
 * mount plus three rebuilds, then stop and say so.
 */
const MAX_MOUNT_ATTEMPTS = 4;

/** Set while `mount()` is in flight, so a rebuild cannot race a build. */
let mounting = false;
let mount_attempts = 0;
/** The current app list + launch context, for listeners bound exactly once. */
let current_apps = [];
let current_ctx = null;
let start_click_bound = false;
/**
 * 🔴 THE LAUNCHER TOGGLE. The Start button's menu had no state at all: every
 * `ezil:start-click` unconditionally called `UIContextMenu(...)`, which is a
 * stateless factory that always appends a fresh `.context-menu` — it has no
 * notion of "one already exists for this caller" (unlike, say,
 * `UITaskbarItem`'s own right-click menu, which checks `has-open-contextmenu`
 * on its anchor first). OBSERVED in a real browser (Playwright, headless
 * Chromium): three Start clicks in a row against the built bundle produced 1,
 * then 2, then 3 `.context-menu` elements in the DOM — never 0, and never
 * fewer than the click count. That is "spawns one more on top of it," in the
 * owner's own words, not a stale-flag or double-binding bug: `start_click_bound`
 * above already guards against the LISTENER being attached twice (verified by
 * reading `mount`'s rebuild path), and there is only one `open_start_menu`
 * call site. The defect is the total absence of a toggle: nothing ever
 * remembers that a menu is already open, so nothing ever tells the second
 * click to close it instead of opening a second one.
 *
 * `start_menu` holds the currently-open menu's controller (`UIContextMenu`'s
 * return value), its DOM node (for outside-click detection) and the anchor
 * element (`aria-expanded`, and so outside-click detection does not treat a
 * click on the TOGGLE BUTTON itself as "outside" — that click is the toggle's
 * own job, handled by the listener below, not a dismiss-and-reopen).
 * `null` whenever no Start menu is open, by ANY closing path (toggle-click,
 * outside-click, Escape, or picking an item) — `close_start_menu` and the
 * `onClose` wired in `open_start_menu` are the only two writers, and both set
 * it to `null` before doing anything else, so nothing can observe a half-torn-
 * down menu as "open".
 */
let start_menu = null;
/** Watches for the desktop being removed from the document. */
let removal_observer = null;

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
    /**
     * True while a built desktop is believed to be on screen.
     *
     * 🔴 NOT a latch. It used to be one, and that made a single lost race
     * unrecoverable: React deleted the desktop, `mounted` stayed true, every
     * re-entry into `mount()` returned early, and the user sat on a blank page
     * for the rest of the session. It is now cleared by `ensure_intact()` the
     * moment the desktop is no longer in the document, and by `mount()` itself
     * if the build throws. Nothing can set it true and walk away.
     */
    mounted: false,
    /** Mount attempts so far, including rebuilds. Observability, not state. */
    get mountAttempts () { return mount_attempts; },

    /**
     * 🔴 Set — and left set — when this shell has given up putting a desktop
     * on screen. `null` while there is still any prospect of one.
     *
     * A LATCH, deliberately, unlike `mounted`. The host page's watchdog
     * (`app/src/app/os/boot-watchdog.tsx`) has to be able to learn about a
     * surrender that happened before it was listening: the bundle is
     * `defer`red and can exhaust its budget before React has run a single
     * effect. So `give_up()` both fires `ezil:stalled` for a listener that is
     * already there and records it here for one that arrives later.
     *
     * Without this the page keeps showing a wallpaper and nothing else,
     * indefinitely — an OS that looks like it is still loading and never will
     * be. The console.error below is not a user-visible failure state.
     */
    stalled: null,

    /**
     * Rebuild the desktop if it is missing. Safe to call at any time: it does
     * nothing when the OS is intact, and it resets the attempt budget so a
     * user (or a console) always has a way back. This is the manual half of
     * the same guarantee `ensure_intact` gives automatically.
     */
    recover () {
        mount_attempts = 0;
        shell.stalled = null;
        ensure_intact('recover() called');
        return shell.mounted;
    },
};

/**
 * Stop trying, and make sure somebody other than the console finds out.
 *
 * The host page turns this into words on screen; a bare page (the headless
 * tests) has no listener and simply carries the latch. Either way the shell
 * never leaves a wallpaper standing in for an OS it has stopped building.
 */
function give_up (reason, detail) {
    if ( shell.stalled ) return;
    shell.stalled = { reason, ...detail };
    console.error(`[${PHASE}] giving up: ${reason}`, shell.stalled);
    if ( typeof window !== 'undefined' && typeof CustomEvent === 'function' ) {
        window.dispatchEvent(new CustomEvent('ezil:stalled', { detail: shell.stalled }));
    }
}

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
 *
 * 🔴 Called from `mount()`, NEVER from `boot()`. `<body>` is React's element on
 * `/os` and writing to it before hydration is what destroyed the shell — see
 * THE HYDRATION CONTRACT at the top of this file. The class cannot move onto
 * an EZiL-owned wrapper instead, because `UIWindow.js:51` appends every window
 * to `<body>` directly: a wrapper inside `#ezil-os-root` would not be an
 * ancestor of the windows, and ~40 `.device-* .window-*` rules would stop
 * matching.
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
 * call cannot produce two — and so the one `/os` renders SERVER-SIDE (inside
 * `#ezil-os-root`, see `app/src/app/os/page.tsx`) is adopted rather than
 * duplicated. That server-rendered node is why the wallpaper is on screen
 * before any script runs, and why the shell has nothing to append into a
 * React-owned element in the common case.
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
 * Tears down whatever `start_menu` currently points at, however it needs to
 * go: the toggle-click path wants it gone SYNCHRONOUSLY (so a click landing a
 * beat later sees a clean "closed" state, not a menu still mid-fade), so this
 * always cancels with `fade: false`. `UIContextMenu`'s own `remove` handler
 * fires `onClose` regardless of which path removed the node, and that is what
 * actually clears `start_menu` and `aria-expanded` (see `open_start_menu`) —
 * so calling this when nothing is open, or twice in a row, is harmless.
 */
function close_start_menu () {
    start_menu?.handle?.cancel?.({ fade: false });
}

/**
 * The Start button's menu. Upstream opened a 500x500 popover backed by
 * `puter.apps` (recents, recommendations, search, drag-to-pin). There is no
 * app store to query, so this lists exactly what `registry.resolve()` returned
 * — today, one thing — using the ported context menu.
 *
 * 🔴 THE TOGGLE. Callers must check `start_menu` themselves before calling
 * this (the `ezil:start-click` listener below does) — this function's job is
 * only to open one and remember it, never to decide whether one should be
 * open. See the `start_menu` doc comment (top of file) for the mechanism this
 * closes: `UIContextMenu` itself has no concept of "already open."
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
    const handle = UIContextMenu({
        items,
        // Above the dock, left-aligned to the button. The context menu clamps
        // itself to the viewport, so a bad rect degrades to a visible menu
        // rather than one off-screen.
        position: rect ? { top: rect.top - 8, left: rect.left } : undefined,
    });

    // SIMPLIFIED (see UIContextMenu.js's stack-guard doc comment): `UIContextMenu`
    // itself now closes any other open ROOT menu before creating a new one, so
    // there is no longer a "which one is mine" question — at most one
    // `:not([data-is-submenu])` node can exist in the DOM at this exact point,
    // and it is the one this call just created, even if a different, unrelated
    // context menu (a taskbar item's right-click) was open a moment ago. This
    // used to pick the LAST of possibly several such nodes for exactly that
    // ambiguity; the factory now makes the ambiguity impossible, not just rare.
    const el = document.querySelector('.context-menu:not([data-is-submenu="true"])');

    const on_outside_mousedown = (e) => {
        if ( el?.contains(e.target) ) return;
        if ( el_anchor?.contains?.(e.target) ) return; // the toggle button's own job, not "outside"
        close_start_menu();
    };
    const on_keydown = (e) => {
        if ( e.key === 'Escape' ) close_start_menu();
    };
    // Capture phase: this must see the click BEFORE anything inside the menu
    // (an item's own click handler) has a chance to stop its propagation.
    document.addEventListener('mousedown', on_outside_mousedown, true);
    document.addEventListener('keydown', on_keydown, true);

    el_anchor?.setAttribute?.('aria-expanded', 'true');

    start_menu = { handle, el, anchor: el_anchor };
    // Fires on ANY removal of `el` — an item click (`fade_remove`), the
    // toggle-close path above (`cancel({fade:false})` -> `remove()`), or a
    // future caller of `.cancel()` this file does not yet have. Whichever it
    // is, the menu is gone and the state above must say so, exactly once.
    handle.onClose = () => {
        document.removeEventListener('mousedown', on_outside_mousedown, true);
        document.removeEventListener('keydown', on_keydown, true);
        el_anchor?.setAttribute?.('aria-expanded', 'false');
        start_menu = null;
    };
}

/**
 * Everything after the globals: the device class, the desktop, the taskbar,
 * and exactly one window. Not awaited by `boot()` — the caller's frame must
 * not be held open by window construction.
 *
 * 🔴 Runs only after the host page has hydrated (or declared it will not).
 * Everything below writes to DOM React owns.
 */
async function mount (payload) {
    if ( shell.mounted ) {
        console.info(`[${PHASE}] already mounted; ignoring`);
        return;
    }
    shell.mounted = true;

    try {
        await build(payload);
    } catch ( err ) {
        // 🔴 A build that threw half-way must not leave the shell believing it
        // is mounted — that is how `mounted` became a one-way door. Clear it,
        // and let `ensure_intact` decide whether to try again.
        shell.mounted = false;
        throw err;
    }
}

async function build (payload) {
    const t0 = performance.now();
    const ctx = {
        payload,
        computer: payload.computer,
        desktopState: payload.desktopState,
    };

    set_device_class();
    shell.desktop = mount_desktop_root();
    watch_for_removal();
    const apps = registry.resolve(payload);
    current_apps = apps;
    current_ctx = ctx;

    // The taskbar. Built BEFORE the window, so it exists for
    // `exit_fullpage_mode` to un-hide rather than have to re-create, and so
    // the first paint already has a dock in it.
    //
    // On a REBUILD (see `ensure_intact`) any taskbar still in the document is
    // an orphan of the mount that was destroyed — `UITaskbar` appends
    // unconditionally, so it has to go or the dock is drawn twice.
    $('.taskbar').remove();
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

    // Bound ONCE, whatever happens afterwards: a rebuild that re-bound it
    // would open one Start menu per rebuild. It reads the current app list
    // from module state instead of closing over this call's copy.
    //
    // 🔴 THE TOGGLE ITSELF. `start_menu` is truthy iff a menu this listener
    // opened is still in the DOM (see its doc comment, top of file). A second
    // click while it is open CLOSES it — it must not also open a new one, or
    // every click after the first would leave two menus fighting for the same
    // spot. Every other closing path (outside-click, Escape, picking an item)
    // clears `start_menu` through the exact same `onClose` this file wires in
    // `open_start_menu`, so this check is never looking at stale state.
    if ( ! start_click_bound ) {
        start_click_bound = true;
        window.addEventListener('ezil:start-click', (e) => {
            if ( start_menu ) {
                close_start_menu();
                return;
            }
            open_start_menu(current_apps, current_ctx, e.detail?.element);
        });
    }

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

// ───────────────────────────────────────────────────────────────────────────
// The hydration handshake and the rebuild guard. See THE HYDRATION CONTRACT
// at the top of this file for why any of this exists.
// ───────────────────────────────────────────────────────────────────────────

/** `/os`'s mount point, or null on a bare page. */
function host_element () {
    return document.getElementById('ezil-os-root');
}

/**
 * Does the host page say React is going to hydrate it? Opt-IN: an unmarked
 * page (the headless tests, a bare host) mounts immediately, so nothing ever
 * waits on an event that is never coming.
 */
function awaits_hydration () {
    return host_element()?.getAttribute(HYDRATION_ATTR) === 'react';
}

/**
 * Call `fn` when it is safe to write to React-owned DOM: as soon as the host
 * page reports it has hydrated, immediately if it never will, or at
 * `HYDRATION_CAP_MS` if the signal never arrives.
 */
function when_hydrated (fn) {
    if ( ! awaits_hydration() ) {
        fn('host does not hydrate');
        return;
    }
    // The effect may have run before this bundle did — the flag is the
    // already-happened form of the event, and one of the two always applies.
    if ( globalThis.__EZIL_HYDRATED__ ) {
        fn('host already hydrated');
        return;
    }

    let fired = false;
    const go = (how) => {
        if ( fired ) return;
        fired = true;
        clearTimeout(timer);
        window.removeEventListener(HYDRATION_EVENT, on_signal);
        fn(how);
    };
    const on_signal = () => go('host hydrated');
    window.addEventListener(HYDRATION_EVENT, on_signal);
    const timer = setTimeout(() => go(`no hydration signal in ${HYDRATION_CAP_MS}ms`), HYDRATION_CAP_MS);
}

/** Is a desktop this shell built still on screen? */
function is_intact () {
    return shell.mounted
        && !! shell.desktop
        && shell.desktop.isConnected
        && !! document.querySelector('.taskbar');
}

/**
 * Start a mount, unless one is already running, already succeeded, or has
 * failed too many times. The attempt budget is what makes this terminate: no
 * path through here can loop.
 */
function begin_mount (why) {
    if ( mounting || shell.mounted || ! shell.payload ) return;
    if ( mount_attempts >= MAX_MOUNT_ATTEMPTS ) {
        console.error(
            `[${PHASE}] the desktop could not be kept on screen after ${mount_attempts} attempts (${why}).`
            + ' Not trying again — reload the page, or call ezil.recover().',
        );
        // 🔴 Bounded AND legible. Exhausting the budget used to be visible
        // only in the console, which meant the user was left looking at the
        // server-rendered wallpaper with no OS on it and no way to know.
        give_up('mount-budget-exhausted', { attempts: mount_attempts, why });
        return;
    }
    mount_attempts += 1;
    mounting = true;
    void mount(shell.payload)
        .catch((err) => { console.error(`[${PHASE}] mount failed (${why})`, err); })
        .finally(() => {
            mounting = false;
            // The desktop can be destroyed WHILE it is being built; re-check
            // once the build has settled rather than trusting that it stuck.
            ensure_intact(`mount settled (${why})`);
        });
}

/**
 * The guard that makes a lost race survivable: if the desktop this shell built
 * is no longer in the document, build it again.
 *
 * 🔴 This is the reason `shell.mounted` can no longer strand the app. Whatever
 * removes the desktop — a late React hydration, a future host-page change, a
 * script nobody has written yet — the shell notices and rebuilds, bounded by
 * `MAX_MOUNT_ATTEMPTS`. The worst case is a desktop that boots twice.
 */
function ensure_intact (why) {
    if ( ! shell.booted || ! shell.payload ) return;
    // A mount in flight re-checks itself when it settles; interrupting it now
    // would build a second desktop on top of the first.
    if ( mounting || is_intact() ) return;

    if ( shell.mounted ) {
        console.warn(`[${PHASE}] the desktop is no longer in the document (${why}); rebuilding it`);
        shell.mounted = false;
        shell.desktop = null;
        // The windows of the destroyed desktop were never closed — their
        // `$.fn.close` teardown did not run, so they are still holding timers
        // and, possibly, an in-flight container boot. Tell them to stop before
        // the rebuilt desktop opens its own.
        window.dispatchEvent(new CustomEvent('ezil:teardown'));
    }
    begin_mount(why);
}

/**
 * Notice the desktop being removed. Two containers are enough to see every
 * way it can happen: React regenerating the page removes `#ezil-os-root` from
 * `<body>`, and React re-writing the host's contents removes `.desktop` from
 * `#ezil-os-root`. `childList` only, no subtree — dragging a window must not
 * pay for this.
 */
function watch_for_removal () {
    if ( typeof MutationObserver === 'undefined' ) return;
    if ( ! removal_observer ) {
        removal_observer = new MutationObserver(() => ensure_intact('DOM mutation'));
    }
    // Re-armed on every mount: after a regeneration the host element is a NEW
    // node, and an observer still watching the old detached one sees nothing.
    removal_observer.disconnect();
    if ( document.body ) removal_observer.observe(document.body, { childList: true });
    const host = host_element();
    if ( host ) removal_observer.observe(host, { childList: true });
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

    // 🔴 Nothing in here may write to the DOM. `install_globals` touches only
    // `window` and localStorage; the listeners below add no nodes. The device
    // class moved into `mount()` for exactly this reason — see THE HYDRATION
    // CONTRACT at the top of the file.
    install_globals();

    // Snapping, drag-target detection and the mouseover-window z-order probe
    // all read state that only this handler maintains.
    document.addEventListener('mousemove', (e) => {
        update_mouse_position(e.clientX, e.clientY);
    });

    // Every hydration — the first one, and any re-render React does after a
    // mismatch — is a moment the desktop may have just been deleted. Bound
    // permanently, not `{ once: true }`.
    window.addEventListener(HYDRATION_EVENT, () => ensure_intact('host hydrated'));

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
    // Not awaited: `boot()` returns as soon as the OS is on screen — or, on a
    // React host, as soon as the desktop is SCHEDULED to go on screen.
    when_hydrated((why) => {
        console.info(`[${PHASE}] mounting (${why})`);
        begin_mount(why);
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
