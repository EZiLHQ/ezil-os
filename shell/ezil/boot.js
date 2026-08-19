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
// desktop root, build a taskbar, warm the container silently, and open NOTHING
// — is this file.
//
// ── The rule that shapes it: never wait on the container, never show one either ──
// A cold desktop boot is ~22s (docs/PLATFORM-NOTES.md §11). Everything below
// runs against data already in the document (`window.__EZIL_BOOT__`, inlined by
// `app/src/app/os/page.tsx`), so the wallpaper and the taskbar are on screen
// before any request exists.
//
// MODIFIED BY EZIL 2026-08-04 (W3, "app-open feel"): this used to also launch
// `apps[0]` the instant the desktop painted, so every login opened a boot
// panel nobody asked for. The owner, directly: "The moment I log in, it just
// shows a computer loading and then a mounting screen... App opening should
// be like opening an app." Login now opens nothing at all — the wallpaper and
// dock ARE the boot. `warm.js` fires the one request that used to be implicit
// in that launch (silently, fire-and-forget, `claim()`ed by the desktop
// window on its first real open), so the container is already most of the
// way through its ~22s by the time anyone clicks Browser, without a window
// ever existing to show a panel for it.
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

// 🔴 FIRST IMPORT, ON PURPOSE — see "Load order below is LOAD-BEARING" above.
// `telemetry.js` installs `window.onerror`/`unhandledrejection` AT ITS OWN
// MODULE TOP LEVEL (see that file's tail), specifically so those listeners
// exist before ANY of the modules imported below get a chance to run their
// own top-level code — `UIWindow.js` (imported via `../src/UI/UIWindow.js`)
// references `document.body` at module scope, per this file's own header.
// An error that happens during THAT import would otherwise be invisible.
import telemetry from './telemetry.js';
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
import { warm } from './warm.js';

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
    telemetry.capture({ eventClass: 'boot_stall', site: 'ezil-os:boot#give_up', code: reason });
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
 *
 * ── MODIFIED BY EZIL 2026-08-19 (W7, contract §7.3) ─────────────────────────
 * This used to be pure UA sniffing — `isMobile.phone` / `isMobile.tablet`,
 * which are `navigator.userAgent`/`platform`/`maxTouchPoints` regexes in
 * `../src/lib/isMobile.min.js`. Three consequences, all observed:
 *
 *   - a narrow desktop window was NEVER `device-phone`, so the phone layout
 *     could not be reproduced (or tested) by resizing a browser;
 *   - in-app webviews and "request desktop site" mobile Safari fell through
 *     to `device-desktop` on a 390px screen;
 *   - it was called exactly ONCE, so nothing re-evaluated on rotation.
 *
 * See `DEVICE_RULE` below for the rule that replaced it, `evaluate_device_class`
 * for the re-evaluation, and `publish_viewport_metrics` for the keyboard.
 */

/**
 * ── 🔴 THE DEVICE RULE ──────────────────────────────────────────────────────
 * Three signals, combined in a fixed order. First clause that matches wins.
 *
 *   touch_first  = (pointer: coarse)          // the PRIMARY pointer is coarse
 *               || isMobile.phone || isMobile.tablet
 *
 *   phone_shaped = isMobile.phone                          // (A) the UA says so
 *               || w <= PHONE_MAX_W                       // (B) narrow viewport
 *               || (touch_first                           // (C) a phone in
 *                   && min(w,h) <= PHONE_MAX_SHORT        //     landscape
 *                   && max(w,h) <= PHONE_MAX_LONG)
 *
 *   phone_shaped -> device-phone
 *   touch_first  -> device-tablet
 *   otherwise    -> device-desktop
 *
 * WHY EACH PIECE:
 *
 * `(pointer: coarse)` and not `(any-pointer: coarse)`: `any-pointer` is true
 * for a DESKTOP with a touchscreen attached, which is emphatically not a
 * tablet. `pointer` describes the primary input, which is the one the layout
 * has to serve. A Surface with its keyboard folded back reports `coarse` and
 * gets the tablet UI; the same Surface docked to a mouse reports `fine` and
 * gets the desktop UI, which is exactly the distinction the old
 * `(hover: hover)` tablet branch was groping for.
 *
 * 🔴 Clause (A) — the old UA check — IS STILL FIRST, and that is not
 * politeness to the previous implementation. The brief for this change is
 * "widen the signal", and widening must be strictly additive: every device
 * that used to be classed `device-phone` must still be. MEASURED, and the
 * reason this clause was re-added after being dropped from a first draft: a
 * page with NO `<meta name="viewport">` gets the 980px legacy layout viewport
 * on every mobile browser, so on such a page clause (B) sees 980, not 390, and
 * a real iPhone came out `device-tablet`. `/os` relies on Next's DEFAULT
 * viewport metadata (`width=device-width`) — nothing in `app/src/app/**`
 * declares one — and a rule that silently depends on a default someone else
 * owns is a rule that breaks the day they change it. `isMobile.phone` is the
 * signal that does not care.
 *
 * Clause (B) is DELIBERATELY unconditional on input. A 390px viewport cannot
 * usefully show a draggable 680px window whatever is pointing at it, and this
 * is the clause that finally makes the phone layout reachable from a desktop
 * browser — see "FAILURE MODES" for what it costs.
 *
 * Clause (C) exists because a phone held in landscape is 844x390, and its
 * WIDTH (844) is nothing like a phone's. `min(w,h)` catches it. The
 * `max(w,h) <= PHONE_MAX_LONG` cap is what stops a 1400x500 touch display —
 * a kiosk strip, a car head unit — from being called a phone on the strength
 * of a short edge alone. (VERIFIED: a synthetic touch context at 1400x500
 * comes out `device-tablet`, not `device-phone`.)
 *
 * WIDTH, NEVER HEIGHT, drives clause (B). That is not an accident: a mobile
 * URL bar collapsing on scroll changes the height by ~60px several times a
 * second and would otherwise flip the class under the user's finger. Height
 * only appears inside clause (C), behind `touch_first`, and only as `min`/`max`
 * of both axes, which a URL-bar collapse cannot move across a threshold.
 *
 * FAILURE MODES, stated rather than discovered:
 *
 *   1. A desktop browser narrowed below PHONE_MAX_W gets the phone layout,
 *      which HIDES the window resize handles and the maximize control
 *      (`style.css` `.device-phone .window .ui-resizable-handle`). Widening
 *      the window brings them back — that only became true with this change,
 *      because nothing re-evaluated before. Judged the right trade: at 600px
 *      a floating window manager is worse than a full-bleed one.
 *   2. Mobile Safari in "Request Desktop Website" reports a 980px layout
 *      viewport, a fine pointer AND a desktop UA. It will be classed
 *      `device-desktop`. No viewport-based rule can see through a viewport the
 *      site was TOLD to use, and no UA-based one can see through a UA the user
 *      asked to have replaced. NOT FIXED.
 *   3. An iPad with an Apple Pencil is `device-tablet`. iPadOS reports
 *      `pointer: coarse` regardless of the stylus, so the stylus is invisible
 *      to us. `device-tablet` keeps the resize handles and loses only the
 *      maximize button, which is the conservative half of the guess.
 *   4. A foldable unfolded past PHONE_MAX_LONG in landscape is `device-tablet`,
 *      not `device-phone`. Deliberate: at that size it IS a small tablet.
 *   5. A browser with no `matchMedia` (none that matters; jsdom in
 *      `boot-test.mjs` does have it) degrades to `touch_first = isMobile.*`,
 *      i.e. exactly the old behaviour plus clause (B).
 */
const PHONE_MAX_W = 600;
const PHONE_MAX_SHORT = 500;
const PHONE_MAX_LONG = 950;
/**
 * Hysteresis, in CSS pixels, applied to all three thresholds *while already
 * `device-phone`*. A viewport parked exactly on a boundary — a user dragging a
 * desktop window's edge across 600px, a rotation animation passing through it —
 * would otherwise flip the class on every frame, and a class that flips
 * repeatedly during a drag is worse than one that never changes. 40px is wider
 * than any single resize step a human produces and far narrower than the gap
 * between any two real device widths.
 */
const DEVICE_HYSTERESIS = 40;
/**
 * Trailing debounce for re-evaluation. Long enough that a drag of a desktop
 * window's edge produces ONE class change at the end rather than one per
 * frame; short enough that a rotation feels instant.
 */
const DEVICE_SETTLE_MS = 150;

const DEVICE_CLASSES = ['device-desktop', 'device-tablet', 'device-phone'];

/** The class currently on `<body>`, or null before the first evaluation. */
let device_class = null;
/** Listeners are installed once, however many times `build()` runs. */
let device_listeners_bound = false;
let device_settle_timer = null;
let viewport_metrics_frame = 0;

function media_matches (query) {
    try {
        return !! (window.matchMedia && window.matchMedia(query).matches);
    } catch {
        // A media feature the browser does not know throws in some engines
        // rather than returning false. Unknown means "no signal", never
        // "phone".
        return false;
    }
}

/**
 * The rule above, as code. Pure: reads the environment, returns a class name,
 * touches nothing. `current` is the class already applied, and is what makes
 * the hysteresis one-directional — it widens the phone band only for a session
 * that is ALREADY a phone.
 */
function device_class_for (current) {
    const w = window.innerWidth || document.documentElement?.clientWidth || 0;
    const h = window.innerHeight || document.documentElement?.clientHeight || 0;
    const slack = current === 'device-phone' ? DEVICE_HYSTERESIS : 0;

    const touch_first = media_matches('(pointer: coarse)')
        || !! isMobile.phone || !! isMobile.tablet;

    const phone_shaped = !! isMobile.phone
        || w <= PHONE_MAX_W + slack
        || (
            touch_first
            && Math.min(w, h) <= PHONE_MAX_SHORT + slack
            && Math.max(w, h) <= PHONE_MAX_LONG + slack
        );

    if ( phone_shaped ) return 'device-phone';
    if ( touch_first ) return 'device-tablet';
    return 'device-desktop';
}

/**
 * ── 🔴 THE KEYBOARD ─────────────────────────────────────────────────────────
 * A raised mobile keyboard does NOT change `window.innerHeight` on iOS Safari
 * or on Android Chrome's default `resizes-visual` mode — it shrinks the VISUAL
 * viewport and leaves the layout viewport alone. So `100dvh`, `100%` and
 * `window.innerHeight` all keep reporting the full screen and the bottom of
 * the desktop, along with whatever field the user is typing into, ends up
 * behind the keyboard.
 *
 * `visualViewport` is the only thing that sees it. This publishes what it sees
 * as two custom properties on `<body>`:
 *
 *   --ezil-vvh   the visual viewport's height in px — what "full height"
 *                actually means right now.
 *   --ezil-kb    the number of px of the layout viewport currently obscured at
 *                the BOTTOM (the keyboard), or 0.
 *
 * `<body>` and not `:root` for the same reason the device class is on `<body>`:
 * `UIWindow.js:51` appends every window to `<body>` directly, so a custom
 * property set here inherits into every window, the taskbar and the desktop
 * alike. It is also the element THE HYDRATION CONTRACT already sanctions
 * writing to from `mount()`.
 *
 * Consumers are in `../src/css/style.css`'s `.device-phone` block — a rule that
 * uses `var(--ezil-vvh, 100dvh)` degrades to today's behaviour on a browser
 * with no `visualViewport` (and inside jsdom), which is why the fallback is
 * spelled out at every use site.
 *
 * 🔴 The 60px floor on the inset. A mobile URL bar collapsing on scroll moves
 * `innerHeight` and `visualViewport.height` TOGETHER, so it should net to
 * zero — but sub-pixel rounding and the animation's intermediate frames do
 * not, and an unfloored inset makes the taskbar jitter for the whole scroll.
 * No software keyboard is 60px tall; every URL-bar artefact is under it.
 */
const KEYBOARD_MIN_PX = 60;

function publish_viewport_metrics () {
    const body = document.body;
    if ( ! body ) return;
    const vv = window.visualViewport;
    const layout_h = window.innerHeight || 0;
    const visual_h = vv ? vv.height : layout_h;
    let inset = vv ? Math.round(layout_h - vv.height - vv.offsetTop) : 0;
    if ( ! (inset >= KEYBOARD_MIN_PX) ) inset = 0;
    body.style.setProperty('--ezil-vvh', `${Math.round(visual_h)}px`);
    body.style.setProperty('--ezil-kb', `${inset}px`);
}

/** rAF-coalesced: `visualViewport` fires many times per keyboard animation. */
function schedule_viewport_metrics () {
    if ( viewport_metrics_frame ) return;
    const raf = window.requestAnimationFrame
        ? (fn) => window.requestAnimationFrame(fn)
        : (fn) => setTimeout(fn, 16);
    viewport_metrics_frame = 1;
    raf(() => {
        viewport_metrics_frame = 0;
        publish_viewport_metrics();
    });
}

/**
 * Apply the rule and, if the answer changed, move the class. Returns the class
 * now on `<body>`.
 *
 * `removeClass` names the three classes EXPLICITLY rather than resetting the
 * attribute — same reason `addClass` replaced upstream's `attr('class', …)`:
 * `<body>` on `/os` carries Tailwind classes this shell did not put there and
 * must not remove.
 *
 * No-op when the answer is unchanged. That matters on the resize path: the
 * common case of a resize is "same class", and re-writing it would invalidate
 * style for the whole document on every settled resize for nothing.
 */
function apply_device_class () {
    const next = device_class_for(device_class);
    // 🔴 `next === device_class` is not on its own enough to skip the write.
    // `ensure_intact` exists because the tree CAN be regenerated out from
    // under the shell (a late React hydration), and a regenerated `<body>`
    // carries React's className, not ours — the module would still believe
    // the class is applied. Check the document, not just the variable.
    const on_body = !! document.body?.classList?.contains(next);
    if ( next === device_class && on_body ) return next;
    const previous = device_class;
    device_class = next;
    $('body').removeClass(DEVICE_CLASSES.join(' ')).addClass(next);
    if ( previous === next ) return next;
    if ( previous !== null ) {
        console.info(`[${PHASE}] device class ${previous} -> ${next} (${window.innerWidth}x${window.innerHeight})`);
    }
    // Lets a test (and any future consumer) wait for the settled answer
    // instead of polling. Fired only on a real change, never on a no-op and
    // never on a re-assert of the class the body already had.
    if ( typeof CustomEvent === 'function' ) {
        window.dispatchEvent(new CustomEvent('ezil:device-class', {
            detail: { previous, current: next, width: window.innerWidth, height: window.innerHeight },
        }));
    }
    return next;
}

/** Trailing debounce — see `DEVICE_SETTLE_MS`. */
function schedule_device_class () {
    if ( device_settle_timer ) clearTimeout(device_settle_timer);
    device_settle_timer = setTimeout(() => {
        device_settle_timer = null;
        apply_device_class();
    }, DEVICE_SETTLE_MS);
}

/**
 * 🔴 Bound ONCE, however many times `build()` runs (`ensure_intact` can rebuild
 * the mount up to `MAX_MOUNT_ATTEMPTS` times) — the same guard, and the same
 * reason, as `start_click_bound` below.
 *
 * Four sources, because no one of them covers the ground:
 *   - `resize`          desktop window resizing, and Android's keyboard in
 *                       `resizes-content` mode.
 *   - `orientationchange` fires BEFORE `resize` on some engines and after on
 *                       others; both are debounced into the same trailing call
 *                       so the double-fire costs nothing.
 *   - `(pointer: coarse)` a mouse being plugged into or unplugged from a
 *                       tablet, which changes the class without changing a
 *                       single pixel and is therefore invisible to `resize`.
 *   - `visualViewport`  the keyboard. `resize` AND `scroll`: iOS reports part
 *                       of a keyboard opening as an offset change, not a
 *                       height change.
 *
 * Nothing here is ever removed. These are page-lifetime listeners on a shell
 * that has no teardown path (`ensure_intact` rebuilds the DOM, it does not
 * unload the module), and adding a removal path we never call would be dead
 * code that only looks careful.
 */
function bind_device_listeners () {
    if ( device_listeners_bound ) return;
    device_listeners_bound = true;

    window.addEventListener('resize', () => {
        schedule_viewport_metrics();
        schedule_device_class();
    });
    window.addEventListener('orientationchange', schedule_device_class);

    try {
        const mq = window.matchMedia && window.matchMedia('(pointer: coarse)');
        // `addEventListener` on a MediaQueryList is Safari 14+; `addListener`
        // is the deprecated spelling that older WebKit still needs. A phone is
        // exactly where the old spelling is most likely to be the only one.
        if ( mq?.addEventListener ) mq.addEventListener('change', schedule_device_class);
        else if ( mq?.addListener ) mq.addListener(schedule_device_class);
    } catch { /* no matchMedia: the rule already degrades, see DEVICE_RULE */ }

    const vv = window.visualViewport;
    if ( vv?.addEventListener ) {
        vv.addEventListener('resize', schedule_viewport_metrics);
        vv.addEventListener('scroll', schedule_viewport_metrics);
    }
}

function set_device_class () {
    const cls = apply_device_class();
    publish_viewport_metrics();
    bind_device_listeners();
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
 * Warm the desktop container only when there is somewhere for it to open —
 * the SAME gate `build()` used to apply once, unconditionally, at login (see
 * "LOGIN NO LONGER WARMS" further down for why that changed). Never sends a
 * request whose answer is already known (`configured !== true`), and never
 * warms a deployment that cannot serve the app at all.
 *
 * @param {object} ctx `{ computer, desktopState }`, as built by `build()`.
 * @param {import('./apps/registry.js').AppDescriptor[]} apps
 */
function maybe_warm_desktop (ctx, apps) {
    if ( ctx?.computer?.id
        && ctx?.desktopState?.configured === true
        && apps.some((a) => a.id === 'desktop') ) {
        warm(ctx.computer.id);
    }
}

/**
 * 🔴 WARM ON INTENT, NOT ON LOGIN (container-billing fix). `warm()` used to
 * fire unconditionally the instant the desktop painted — see "LOGIN NO LONGER
 * WARMS" in `build()`, below, for the full account of why that booted a
 * container for every user who merely landed on `/os`. `warm()` ITSELF is
 * unchanged: still single-flight, still `WARM_MAX_AGE_MS` (see that file's
 * own header) — what changed is WHO calls it and WHEN. A `pointerenter`
 * (the cursor arriving over the target) or a `pointerdown` (about to click
 * it) on the Browser dock icon or its Start-menu entry is the first moment a
 * real open is actually likely, which is the whole reason `warm()` exists:
 * to have paid for as much of the ~22s cold boot as possible before the click
 * that needs it.
 *
 * Both events are bound, on purpose: a mouse user typically fires
 * `pointerenter` before `pointerdown`, but a keyboard/switch user reaching the
 * dock item with focus-and-Enter never fires `pointerenter` at all, so
 * `pointerdown` alone still covers them. Firing `warm()` twice for the same
 * computer (hover THEN click) is a documented no-op — see that file's own
 * `warm()` — so binding both, and binding this on two separate surfaces
 * (the dock and the Start menu), cannot double-boot anything.
 *
 * @param {Element|null|undefined} el The dock icon or launcher menu item, if it exists.
 * @param {object} ctx
 * @param {import('./apps/registry.js').AppDescriptor[]} apps
 */
function bind_warm_intent (el, ctx, apps) {
    if ( ! el ) return;
    const on_intent = () => { maybe_warm_desktop(ctx, apps); };
    el.addEventListener('pointerdown', on_intent);
    el.addEventListener('pointerenter', on_intent);
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

    // 🔴 WARM ON INTENT — the Start-menu half of the same fix as the dock
    // icon in `build()`. `items` above is built from `apps`, in order, so the
    // Browser entry's `data-action` index (`UIContextMenu`'s own markup, see
    // that file) is just `apps`' own index of it. See `bind_warm_intent`'s
    // doc comment for why both `pointerdown` and `pointerenter` are bound.
    const desktop_idx = apps.findIndex((a) => a.id === 'desktop');
    if ( desktop_idx !== -1 ) {
        bind_warm_intent(el?.querySelector(`li[data-action="${desktop_idx}"]`), ctx, apps);
    }

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
        const el_item = UITaskbarItem({
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
        // 🔴 WARM ON INTENT — see `bind_warm_intent`'s doc comment and "LOGIN
        // NO LONGER WARMS" below. The dock icon is the far more common path to
        // opening Browser than the Start menu (`open_start_menu` binds the
        // same thing on that surface), so THIS is where most real opens will
        // actually earn their head start on the ~22s cold boot.
        if ( app.id === 'desktop' ) bind_warm_intent(el_item, ctx, apps);
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

    // 🔴 LOGIN OPENS NOTHING (W3). The wallpaper and dock above ARE the boot —
    // nobody asked to watch a machine start. The owner, directly: "The moment
    // I log in, it just shows a computer loading and then a mounting
    // screen... App opening should be like opening an app." This used to
    // `registry.launch(apps[0].id, ctx)` here, unconditionally, the instant
    // the desktop painted; it no longer opens anything at all. A resolve
    // sanity log replaces it, so a boot with an empty app list is still
    // visible in the console rather than silently doing nothing for a reason
    // nobody can see.
    console.info(`[${PHASE}] resolved ${apps.length} app(s); opening none automatically`,
        apps.map(a => a.id));

    // 🔴 LOGIN NO LONGER WARMS (container-billing fix). This used to fire
    // `warm()` SILENTLY, right here, the instant the desktop painted — well
    // before the user had clicked anything. Sound reasoning for "make the
    // first real click fast"; wrong for "boot a Cloudflare container for
    // every login". MEASURED: a container idle-resident for 26 hours on a
    // 30-minute sleep timer, because the flush loop `ensureDesktop` starts on
    // a successful mint resets the container's idle clock every 10 seconds —
    // so a container this call warmed for a user who never opened Browser
    // stayed billed indefinitely, not for the ~22s this file's own header
    // describes. `warm()` now fires from `bind_warm_intent`, wired onto the
    // dock icon (in this function, above) and the Start-menu entry (in
    // `open_start_menu`) — the first moment a click is actually likely,
    // rather than the moment the wallpaper exists. `warm()` itself, and its
    // single-flight + `WARM_MAX_AGE_MS` semantics, are unchanged.
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
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:boot#mount', code: 'mount_failed',
            detail: `exhausted after ${mount_attempts} attempts (${why})`,
        });
        // 🔴 Bounded AND legible. Exhausting the budget used to be visible
        // only in the console, which meant the user was left looking at the
        // server-rendered wallpaper with no OS on it and no way to know.
        give_up('mount-budget-exhausted', { attempts: mount_attempts, why });
        return;
    }
    mount_attempts += 1;
    mounting = true;
    void mount(shell.payload)
        .catch((err) => {
            console.error(`[${PHASE}] mount failed (${why})`, err);
            telemetry.capture({
                eventClass: 'window_error', site: 'ezil-os:boot#mount', code: 'mount_failed',
                detail: err,
            });
        })
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
