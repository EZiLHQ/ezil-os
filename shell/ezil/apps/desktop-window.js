// desktop-window.js — EZiL-authored. Not Puter code.
//
// The one window Wave 1 opens: the user's real Linux container, full-bleed,
// with honest boot progress in front of it until it exists.
//
// ── 🔴 The URL comes from the server procedure, never from us ───────────────
// The iframe's src is obtained ONLY through `session.openDesktop()` ->
// `POST /api/shell/desktop` -> `cloudflareGuacamole.previewUrl`. That procedure
// runs `enableImplicitHosting` SERVER-SIDE and must finish BEFORE the iframe
// exists, because the desktop client reads that flag once, at websocket init.
// A shell that composed its own preview URL — or created the iframe first and
// pointed it at the URL later on a race — produces a desktop that renders
// perfectly, animates, and silently ignores every click. There is no error
// anywhere; it just does not respond. So the iframe here starts on
// `about:blank` and is navigated exactly once, after the procedure has
// RESOLVED.
//
// ── Why about:blank and not a late-built iframe ─────────────────────────────
// `UIWindow` builds the iframe itself, with its sandbox/allow policy, its
// `data-app`, and the `.window-body-app` class the fullpage height rules key
// off. Handing it `iframe_url: 'about:blank'` keeps ALL of that in one place
// and leaves this file with a single `src` assignment. Building our own iframe
// later would fork the sandbox policy into a second location, which is exactly
// the sort of divergence that is invisible until it is a security bug.
//
// ── 🔴 Full-bleed is EARNED, not assumed ────────────────────────────────────
// This window used to be created with `is_fullpage: true`, which makes
// `UIWindow` (UIWindow.js:2861) call `window.enter_fullpage_mode` on a 50ms
// timer — and that does `$('.taskbar').hide()`. So the dock the shell had just
// painted was gone from effectively the first frame, and for the whole ~26s
// container boot the user had a full-bleed BOOT PANEL and a 54x15px drawer
// tongue. The taskbar only ever appeared if they found the tongue and
// minimised. That is not "a usable OS while your machine boots".
//
// So the window opens WINDOWED now — over the wallpaper and a real taskbar —
// and takes the viewport only once there is a desktop in it to take it with
// (`go_fullbleed`, called from `settle_frame` once the server has CONFIRMED
// the frame is a desktop — see that function). Three things follow:
//   - a boot that FAILS or is unconfigured never hides the taskbar: the
//     failure panel and its Retry sit in an ordinary window, on an OS the
//     user can still use;
//   - during boot the way out is the window's own head — an ordinary titlebar
//     with minimise and close — so the drawer is attached up front but stays
//     hidden (CSS, keyed off `.ezil-fullbleed`) until it is the only chrome;
//   - if the drawer could not attach we simply never go full-bleed, rather
//     than going full-bleed and backing out of it.
//
// ── 🔴 `load` is NOT proof that a desktop arrived ───────────────────────────
// An iframe fires `load` for an HTTP 500 error page exactly as it does for a
// working desktop, and cross-origin script cannot read its status code or its
// document. Observed 2026-07-31: the preview host returned 500 "Proxy routing
// error", `load` fired, and this window reported `ready` and hid its boot panel
// over it. The Worker could not have caught it either — its `guacamoleRunning`
// comes out of Durable Object storage and never crosses the edge, so it said
// `true` the whole time.
//
// The browser has no honest signal here. The SERVER does: it can make a plain
// HTTP request to the desktop origin and read the status line. So `load` is now
// the TRIGGER to ask (`session.confirmFrame`), never the answer. See
// `settle_frame`.
//
// ── 🔴 NOR IS A CONFIRMED ORIGIN PROOF THAT PIXELS ARRIVED ──────────────────
// The paragraph above closed one gap and stopped one layer short of the floor.
// A Neko origin serves its SPA shell with a 200 whether or not WebRTC will ever
// connect, so `confirmFrame` saying yes is entirely compatible with a blank
// screen. Measured under WebKit: this window declared ready in **4.6s** while
// the video element had `videoWidth: 0`, `paused: true`, `srcObject: false` —
// and because the panel had already come down, what the user actually saw was
// a bare third-party n.eko logo and spinner. No EZiL copy, no retry, no way to
// tell whose product had failed. Half the harm was the vendor-branding leak.
//
// Reading `videoWidth` from here is not an option and never was: the iframe is
// `8181-<sandbox>-nekodesktop.<zone>` inside this app's origin, so the document
// is cross-origin and the video element is unreachable BY CONSTRUCTION. A
// "check the video element" fix would throw or silently return nothing while
// looking exactly like a check, which is worse than the bug.
//
// Neko itself knows, and the server can ask it — it flips a per-session
// `is_watching` flag from its WebRTC peer's `connected` state change. So the
// panel now comes down on THAT (`session.confirmDisplay` -> `start_display_gate`),
// and `confirmFrame` joins `load` as a trigger rather than an answer.
//
// ── 🔴 The taskbar is hidden; the drawer is the only way out ────────────────
// Once full-bleed, `enter_fullpage_mode` has hidden the taskbar AND the window
// head, and `style.css:246` hides `.window-minimize-btn` in fullpage mode. So
// there is NO chrome on screen except the control drawer. Minimise therefore
// cannot just call `hideWindow()`: it has to bring the taskbar back first, or
// the window animates into a dock that is not there and the user is left with
// a desktop they cannot leave. See `minimise_to_taskbar` below.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import telemetry from '../telemetry.js';
import { applyDisplayEvidence, computeBootUiState } from '../boot-phases.js';
import BootProgress, { DisplayNotice } from '../ui/boot-progress.js';
import attach_app_drawer from '../ui/app-drawer.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:desktop';

/** How often the UI re-derives its phase from elapsed time. */
const TICK_MS = 250;
/** How often the cheap status probe runs. It does NOT wake a container. */
const POLL_MS = 2_000;

/**
 * The post-handoff frame confirmation (`settle_frame`). These three govern
 * asking the question, never answering it — no elapsed time here can produce a
 * "ready", only another attempt to obtain a real answer.
 *
 * FALLBACK: when to ask if the iframe never fires `load` at all. Same 4s the
 * old blind reveal used, so a frame that silently never loads is settled on the
 * same schedule it used to be revealed on — the difference is that it is now
 * settled by an ANSWER rather than by the timer itself.
 *
 * ATTEMPTS/RETRY: how many times to re-ask when OUR OWN request fails to land
 * (offline, a 502 from our host). That is not an observation of the desktop, so
 * it must not be recorded as one in either direction; three tries 1.5s apart is
 * enough to ride out a blip without leaving the user staring at a panel.
 */
const FRAME_CONFIRM_FALLBACK_MS = 4_000;
const FRAME_CONFIRM_ATTEMPTS = 3;
const FRAME_CONFIRM_RETRY_MS = 1_500;

/**
 * The display gate (`start_display_gate`) — the answer to "did any pixel
 * actually arrive", which `confirmFrame` above structurally cannot give.
 *
 * 🔴 NONE OF THESE PRODUCES A VERDICT. The deadlines govern how long we keep
 * ASKING; they never manufacture an answer, in either direction. A boot that
 * reaches one without having obtained a well-formed observation is `unknown`,
 * not `blank` — see `start_display_gate`.
 *
 * POLL: how often to re-ask, and how much slower to re-ask once the fast path
 * has clearly been missed. The first ask goes out at NAVIGATION, not after the
 * frame check, so a desktop whose WebRTC peer connects promptly usually costs
 * the boot nothing at all: the answer is already in hand when the frame check
 * lands. (Measured: this is the whole of the +1.5s the gate used to add.)
 *
 * ── Two deadlines, because they are answers to two different questions ──────
 * There used to be one, at 20s, and it was wrong in both directions at once.
 *
 * UNVERIFIED (6s) — "how long do we wait for OUR OWN plumbing before admitting
 * we cannot check?" Reached only when not one understood answer has come back,
 * which is a fact about us, never about the user's screen. Measured: a probe
 * that could not answer pushed settle from 7s to 29.7s, because each ask can
 * burn `session.js`'s 12s budget and the old deadline was only tested AFTER an
 * ask returned — so every user of a degraded deployment waited ~20 extra
 * seconds to be shown a desktop that had been working the whole time. 6s is
 * two full poll cycles plus slack, and it is enforced by a TIMER rather than by
 * the ask loop, so a probe that hangs cannot outlast it.
 *
 * BLANK (45s) — "how long may a genuinely-connecting desktop take?" This is the
 * only verdict that HIDES anything, so it must be the hardest to reach. 20s was
 * sized for ICE against STUN. There is no STUN path here: PLATFORM-NOTES §6
 * says Cloudflare Containers carry no UDP, so **every** connection is relayed
 * through TURN, and a relayed candidate is only tried after the direct ones
 * have timed out. Stack that against DTLS's own retransmit schedule
 * (1+2+4+8+16s for a single lost handshake flight) and 20s is inside the
 * envelope of a connection that was about to succeed — i.e. the old number
 * could hide a working desktop, which is the defect this gate exists to fix,
 * sign-flipped. 45s clears one full DTLS retransmit ladder. Only a failing
 * desktop ever spends it, the user watches an honest "Connecting the display"
 * on an OS that still has its taskbar, and `LONG_BOOT_MS` (35s) gives them the
 * "still working" copy before it elapses.
 *
 * FRESHNESS: how recently a well-formed `blank` must have been observed for the
 * blank verdict to stand at the deadline. Without this the flag was STICKY: one
 * `blank` at t=1s followed by 44 seconds of unanswerable probe still hid the
 * desktop, on evidence that was a minute stale. Two poll cycles.
 */
const DISPLAY_POLL_MS = 1_000;
const DISPLAY_POLL_SLOW_MS = 2_000;
const DISPLAY_POLL_SLOW_AFTER_MS = 10_000;
const DISPLAY_UNVERIFIED_DEADLINE_MS = 6_000;
const DISPLAY_BLANK_DEADLINE_MS = 45_000;
const DISPLAY_BLANK_FRESHNESS_MS = 5_000;

const MINIMISE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="round" aria-hidden="true"><line x1="5" y1="17" x2="19" y2="17"/></svg>';

// ── App focus (in-stream) ───────────────────────────────────────────────────
// `POST /api/shell/focus { computerId, app }` raises an app's window inside the
// container's X session, which changes what the WebRTC stream shows. The
// transport is `session.focusApp` — a real, same-origin Route Handler as of
// the wave-a seam pass; before that this file (and `preview.js`) POSTed to a
// URL feature-detected from `desktopState.endpoints.focus`, which did not
// exist, so nothing was ever drawn.
//
// 🔴 Still feature-detected, and that is not vestigial: a deployment whose
// server does not publish `endpoints.focus` must get no button rather than a
// button wired to a path this file assumed.
//
// 🔴 ONE ENTRY, ON PURPOSE. This list used to offer "VS Code" as well. The
// container image no longer HAS an Electron VS Code — it was replaced with
// code-server, an HTTP server on 127.0.0.1:8443 that is not an X client, so
// `neko-switch-app.sh vscode` can never resolve a window and exits 1
// (`worker/scripts/start-neko.sh`'s own heredoc says so, and
// `validate-neko-focus.sh` asserts it). That button would have failed 100% of
// the time. The server-side enum `FOCUSABLE_APPS`
// (`app/src/server/lib/cloudflare-guacamole-provider.ts`) is the authority and
// rejects anything else as a 400; `focus-app-enum.test.ts` keeps it honest by
// reading the image's own `EZIL_DESKTOP_APPS` declaration. Adding an entry
// here without adding it there gets a 400, not a silent no-op.
//
// So this is a "bring the browser back to the front" control, not a switcher —
// it is worth having because a stray click in the X session can leave the
// stream showing a bare desktop with no obvious way back.
const FOCUS_TIMEOUT_MS = 8_000;
/** PLATFORM-NOTES §7: 15fps + `keyframe-max-dist=25`, encoder-bound. An ESTIMATE, not a promise. */
const FOCUS_LEGIBLE_ESTIMATE_MS = 1_700;
const FOCUS_APPS = [
    {
        id: 'chromium',
        label: 'Show the browser',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"'
            + ' aria-hidden="true"><circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2"/></svg>',
    },
];

/** `data-is_minimized` is written as 1/0 at creation and true/false later. */
function is_minimized (el) {
    const v = $(el).attr('data-is_minimized');
    return v === '1' || v === 'true';
}

/**
 * The class that says "this window currently owns the viewport".
 *
 * It is EZiL's own, deliberately NOT `data-is_fullpage`: upstream's
 * `exit_fullpage_mode` REMOVES that attribute, so it cannot answer "is this
 * window full-bleed right now" across a minimise. `ezil-shell.css` keys the
 * control drawer's visibility off this class, and `go_fullbleed` /
 * `minimise_to_taskbar` are the only two places that write it.
 */
const FULLBLEED_CLASS = 'ezil-fullbleed';

// ═══════════════════════════════════════════════════════════════════════════
// THE STREAM'S SHAPE, AND WHAT THIS FILE CAN AND CANNOT DO ABOUT IT
// ═══════════════════════════════════════════════════════════════════════════
// ADDED BY EZIL 2026-08-08.
//
// The remote desktop is HARD-PINNED to 1920x1080 on the server and there is no
// client -> server resize path. Traced to ground, not assumed:
//
//   worker/scripts/start-neko.sh:138   NEKO_SCREEN=${NEKO_SCREEN:-1920x1080x24}
//   worker/scripts/start-neko.sh:843   Xvfb "$DISPLAY" -screen 0 "$NEKO_SCREEN"
//   worker/scripts/start-neko.sh:1319  chromium --window-size=1920,1080
//   worker/scripts/start-neko.sh:1490  neko.yaml desktop.screen: "1920x1080@60"
//   worker/scripts/start-neko.sh:1519  "Resolution (1920x1080) also stays untouched"
//
// So the stream is 16:9, always, and this window is a box of whatever shape the
// user or the viewport makes it. The mismatch has to go SOMEWHERE, and there
// are only two places it can go: bars, or a stretched picture.
//
// 🔴 What this file cannot do, and must not try:
//
//   - It cannot touch the video. The desktop is a cross-origin neko SPA in an
//     iframe (`8181-<sandbox>-nekodesktop.<zone>`), so its `<video>` element is
//     unreachable BY CONSTRUCTION — `object-fit` on it is not something this
//     side of the origin boundary can set, and neither is anything else.
//   - It must not change the stream's RESOLUTION to match the window. Every
//     capture-pipeline restart is a 5-10s interruption plus a full software-vp8
//     re-init. That is an explicit user action at most, and never a resize
//     handler.
//
// 🔴 What it CAN do, and now does: choose the shape of the box it hands the
// iframe. `fit_stream` below sizes the iframe to the largest 16:9 rectangle
// that fits the window body and centres it, so the neko client's own viewport
// is always exactly the aspect of the picture inside it and its internal fit
// produces no bars of its own. The remaining margin is drawn by the WINDOW, in
// `--color-charcoal`, next to the rest of the OS chrome — instead of by a
// third-party page in whatever black its stylesheet happens to use.
//
// This makes the window's default size matter, so `WINDOW_*` below derive from
// the stream rather than being round numbers: a freshly opened Browser window
// has a content box that is exactly 16:9 and therefore no bars at all.
//
// 🔴 Sizing the IFRAME is not "resizing on window.resize" in the forbidden
// sense. Nothing here reaches the server, nothing renegotiates a capture, and
// the iframe's box ALREADY changed on every window drag (it is `width: 100%;
// height: 100%` in `style.css`). If anything this reduces the pressure: the
// client's viewport aspect is now constant across every window shape, where
// before it was whatever the user dragged.
const STREAM_W = 1920;
const STREAM_H = 1080;
/** 1.777…, i.e. 16:9. Derived, so the two numbers above stay the only source. */
const STREAM_ASPECT = STREAM_W / STREAM_H;
/**
 * The default window. Content box exactly 16:9 (960x540), plus the 30px head
 * — `style.css`'s `.window-body-app { height: calc(100% - 30px) }`, which is
 * the one number this has to agree with.
 *
 * Bigger than the 560x400 it replaces, and deliberately: that box was sized
 * for the boot panel alone ("an app starting", not "the OS is this window"),
 * from before this window had a real desktop to show at a real aspect. 960x540
 * is a half-scale 1920x1080 — the exact pixel-doubled shape of the thing being
 * streamed — and still leaves the taskbar and the desktop visible around it on
 * any laptop screen.
 */
const WINDOW_HEAD_H = 30;
const WINDOW_W = 960;
const WINDOW_H = Math.round(WINDOW_W / STREAM_ASPECT) + WINDOW_HEAD_H;

/**
 * Size and centre the stream iframe to the largest `STREAM_ASPECT` rectangle
 * that fits `el_body`, and report what it did.
 *
 * Written in whole pixels: a half-pixel box on a scaled video is a visibly
 * soft picture, and the centring offsets have to add up to the body's own
 * integer size or the bars come out uneven.
 *
 * @param {HTMLElement} el_body   The window body — the box to fit inside.
 * @param {HTMLElement} el_iframe The stream iframe.
 * @returns {{w: number, h: number}|null} null if the body has no layout yet
 *   (a minimised or not-yet-shown window), in which case nothing is written.
 */
function fit_stream (el_body, el_iframe) {
    if ( ! el_body || ! el_iframe ) return null;
    const bw = Math.round(el_body.clientWidth);
    const bh = Math.round(el_body.clientHeight);
    // A hidden or minimised window measures 0, and writing `0px` through
    // would collapse the iframe and leave it collapsed after a restore,
    // because the restore does not necessarily change the body's size again.
    //
    // 🔴 HONESTY NOTE — this early return is NOT mutation-proven, and it is
    // the only line in this change that is not. Deleting it leaves
    // `os-chrome-browser-test.mjs` 62/62 green, including its explicit
    // minimise/restore round trip. The reason is that ResizeObserver does not
    // deliver an observation for an element with no box, so today the only
    // caller (the observer in `openDesktopWindow`) never actually reaches it
    // with a zero: `hideWindow` ends in `display: none` and the callback
    // simply does not fire. It is kept as a precondition on a function that
    // writes geometry from a measurement, not as a fix for an observed bug —
    // and it is written down here as unproven rather than quietly counted
    // among the guards that were proven.
    if ( bw <= 0 || bh <= 0 ) return null;

    let w = bw;
    let h = Math.round(bw / STREAM_ASPECT);
    if ( h > bh ) {
        h = bh;
        w = Math.round(bh * STREAM_ASPECT);
    }
    el_iframe.style.width = `${w}px`;
    el_iframe.style.height = `${h}px`;
    el_iframe.style.left = `${Math.round((bw - w) / 2)}px`;
    el_iframe.style.top = `${Math.round((bh - h) / 2)}px`;
    return { w, h };
}

/**
 * Open the desktop window.
 *
 * @param {object} ctx
 * @param {object} ctx.payload      `window.__EZIL_BOOT__`
 * @param {object} ctx.computer     `payload.computer`
 * @param {object} ctx.desktopState `payload.desktopState`
 * @param {string} [ctx.icon]       The launching descriptor's icon, so the
 *   window head, the taskbar item and the control tray all show the same
 *   image as the dock the user clicked. `registry.launch` supplies it.
 * @param {string} [ctx.appName]    The launching descriptor's `name` — this
 *   window's TITLE, for the same reason and from the same place as `ctx.icon`.
 *   See the `title` assignment in the body.
 * @returns {Promise<HTMLElement|null>}
 */
export async function openDesktopWindow (ctx = {}) {
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    // MODIFIED BY EZIL 2026-08-08: the APP's name, not the machine's.
    //
    // This was `computer?.name || 'Browser'`. The owner's computer is called
    // "Computer", so the Browser window's titlebar read "Computer" — OBSERVED,
    // and it is what a titlebar is least allowed to be: ambiguous about which
    // program you are looking at. Every desktop OS titles a window after the
    // application (macOS especially: the titlebar names the app/document, never
    // the host machine), and `code.js`/`preview.js` had the mirror-image bug
    // ("Computer — Code"). All three are fixed the same way, together, because
    // a titling convention that holds for two windows out of three is not a
    // convention.
    //
    // `ctx.appName` is the registry descriptor's own `name`, passed by
    // `registry.js`'s `launch()` alongside `ctx.icon` and for the same stated
    // reason: the window head, the taskbar item and the dock tile must not
    // disagree about what this app is called. The literal is the fallback for
    // a direct `openDesktopWindow()` call that bypasses the registry.
    //
    // 🔴 The machine identity is NOT lost. It was never carried by this string
    // alone: `registry.js` stamps `data-ezil-computer-id` on the window (which
    // is what Settings actually reads), and the head's `title=` tooltip below
    // names the computer in full for a user with two of them.
    const title = ctx.appName || 'Browser';
    const title_tooltip = computer?.name ? `${title} — ${computer.name}` : title;

    if ( ! computer?.id ) {
        // Nothing to connect to. `/os` already refuses to render the shell in
        // this case, so reaching here means a rehydrated payload lost its
        // computer — say so instead of opening an empty window.
        console.error(`[${PHASE}] refusing to open: the boot payload carries no computer`);
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/desktop#open', code: 'no_computer_in_payload',
        });
        return null;
    }

    const t_open = performance.now();

    const el_window = await UIWindow({
        title,
        // The machine, on hover. See the `title` assignment above.
        title_tooltip,
        app: 'desktop',
        icon: ctx.icon,
        // 🔴 Navigated exactly once, after previewUrl resolves. See header.
        iframe_url: 'about:blank',
        // 🔴 NOT `is_fullpage: true`. That is what hid the taskbar from the
        // first frame; full-bleed is entered by `go_fullbleed` below, once
        // there is a desktop to be full-bleed WITH. See the header.
        is_fullpage: false,
        // MODIFIED BY EZIL 2026-08-08: derived from the stream's own shape,
        // was a flat 560x400. See `WINDOW_W` / `WINDOW_H` above — the content
        // box is now exactly 16:9, so a freshly opened Browser window shows
        // the desktop with no bars at all.
        width: WINDOW_W,
        height: WINDOW_H,
        // 🔴 Resizable — and NOT because anyone needs to resize a boot panel.
        // `UIWindow.js:346` renders the head's MINIMISE button only when
        // `is_resizable && show_minimize_button && !is_embedded`. OBSERVED in
        // Chromium with `is_resizable: false`: the head came out with a close
        // button and nothing else, which would leave "get this out of my way
        // while my computer boots" as a thing the user can only do by closing
        // the window. `ezil-shell.css` hides the resize handles once the window
        // is full-bleed, so a stray drag still cannot shrink the live desktop.
        is_resizable: true,
        // MODIFIED BY EZIL 2026-08-08: true, was false.
        //
        // It was false because "The maximize button would fight `go_fullbleed`
        // for the same geometry and leave `data-is_maximized` set behind a
        // full-bleed window" — a correct diagnosis of `window.scale_window`,
        // and the price was that the Browser was the ONE window in this OS
        // with no expand control, in a titlebar that shows the other two. An
        // OS whose main window is missing a standard control does not read as
        // an OS.
        //
        // The fight is now settled rather than avoided: `UIWindow.js`'s
        // `scale_window` checks for an `_ezil_maximise` hook FIRST and returns
        // if it finds one, so on this window it never runs, never writes
        // `data-is_maximized`, and has no geometry to disagree about. The hook
        // (installed below, right after `go_fullbleed` is in scope) routes the
        // button to `go_fullbleed`, which is what "expand" means here.
        show_maximize_button: true,
        // 🔴 NOT `stay_on_top: true`. Full-bleed is a LAYOUT mode
        // (`go_fullbleed` below sets `width/height: 100%` via
        // `enter_fullpage_mode` — pure geometry, in `UIDesktopFullpage.js`,
        // which never touches z-index). `stay_on_top` is a STACKING mode:
        // `UIWindow.js:215` puts the window in a `99999999+` z band at
        // creation, and `window_zindex_base` (`UIWindow.js:4066`) keeps it
        // there forever, while `focusWindow` (`UIWindow.js:4089`) explicitly
        // SKIPS re-raising a `stay_on_top` window on focus. The two properties
        // were never coupled by anything this window needs — this file set
        // `stay_on_top: true` on its own initiative, not because
        // `UIWindow.js:122`'s `window.is_embedded || window.is_fullpage_mode`
        // auto-promotion applies (neither global is ever set anywhere in this
        // codebase; grepped clean). The result: a normal window (Settings,
        // Preview — both explicitly `stay_on_top: false`) is structurally
        // incapable of ever rising above this one, in ANY of its states,
        // including windowed-and-booting. OBSERVED in real Chrome: Settings at
        // z=4 under a full-bleed desktop at z=100000002,
        // `document.elementFromPoint()` at the Settings titlebar returning the
        // desktop's iframe — reproduced byte-for-byte by
        // `../ui/Settings/stacking-browser-test.mjs` before this line changed.
        // Dropping `stay_on_top` puts the desktop in the same z band as every
        // other window: it wins when it is the most-recently-focused window
        // (ordinary `focusWindow` behaviour, unaffected by this change) and
        // loses to whatever the user opens or clicks next — exactly what
        // guarantee #1 (Settings -> Computers -> Delete reachable from a
        // stuck full-bleed desktop) requires.
        stay_on_top: false,
        single_instance: true,
        show_in_taskbar: true,
        is_droppable: false,
        window_class: 'ezil-desktop-window',
        selectable_body: false,
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:apps/desktop#open', code: 'uiwindow_returned_nothing',
        });
        return null;
    }

    const el_body = el_window.querySelector('.window-body');
    const el_iframe = el_window.querySelector('.window-app-iframe');

    // ── keep the stream's box at the stream's aspect ───────────────────────
    // ADDED BY EZIL 2026-08-08. See the `fit_stream` block at the top of this
    // file for what this does and, more importantly, for the two things it
    // deliberately does NOT do (touch the video — impossible, cross-origin —
    // and change the capture resolution, which is never a resize handler's
    // decision).
    //
    // A `ResizeObserver` on the BODY, not a `window.resize` listener: the body
    // changes size for reasons the viewport does not (full-bleed in and out, a
    // drag on a resize handle, a restore from the taskbar), and it is the box
    // the fit is actually against. It fires once on observe, which is what
    // sizes the iframe initially.
    //
    // 🔴 Guarded, and the guard is not theoretical. The first version of this
    // was a bare `new ResizeObserver(...)`, and `boot-test.mjs` went from 110
    // checks to a hard crash: jsdom has no `ResizeObserver`, the constructor
    // threw INSIDE `openDesktopWindow`, `registry.launch` caught it — and the
    // user's entire desktop window failed to open. That is the right lesson
    // regardless of jsdom. Fitting the stream to its aspect is an improvement
    // on a window; it is not the window, and it must never be able to take
    // the window down with it. Every browser this ships to has
    // `ResizeObserver` (Chrome 64+, Safari 13.1+), so the fallback is not
    // expected to run — but "not expected to run" is exactly what the bare
    // constructor assumed.
    //
    // The fallback still fits once, so even without an observer the window
    // opens at the right shape and only stops TRACKING later resizes.
    let fit_observer = null;
    if ( typeof ResizeObserver === 'function' ) {
        fit_observer = new ResizeObserver(() => { fit_stream(el_body, el_iframe); });
        fit_observer.observe(el_body);
    } else {
        console.warn(`[${PHASE}] no ResizeObserver; the stream will be fitted once and not tracked`);
        fit_stream(el_body, el_iframe);
    }

    // ── boot state ─────────────────────────────────────────────────────────
    let tick_timer = null;
    let poll_timer = null;
    let attempt = 0;          // guards a stale request finishing after a retry
    let running_signal;       // undefined until a poll lands; never coerced to false
    let disposed = false;
    /**
     * Set once the desktop has actually been shown. It is the DESIRE, not the
     * state — a minimise clears the full-bleed geometry but not this, which is
     * how a restore knows to go back to full-bleed instead of a 560x400 box.
     */
    let wants_fullbleed = false;
    /**
     * Cleared if the control drawer fails to attach. Full-bleed hides the
     * taskbar and the window head, so without the drawer there would be no way
     * out of the window at all — better to stay windowed forever.
     */
    let may_fullbleed = true;
    /**
     * Repaints the panel from the CURRENT attempt's clock and observations.
     * Assigned by `start_boot`, which owns both; held out here so the display
     * gate can put the panel back on live progress after the frame check has
     * written something else into it. A no-op before the first attempt.
     */
    let paint = () => {};

    const stop_timers = () => {
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const progress = BootProgress({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(progress.el);

    // The `ready_unverified` strip. Attached up front, hidden, for the same
    // reason the drawer is: whether it CAN be shown must be settled before
    // anything could need to show it. It is a sibling of the boot panel, not a
    // child, because it outlives the panel — it is the one thing on screen
    // once the desktop has been revealed without having been checked.
    const notice = DisplayNotice({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(notice.el);

    /** Show the panel again (retry after a failure, or a fresh attempt). */
    const show_panel = () => { progress.el.hidden = false; };

    /**
     * Hand the viewport to the desktop.
     *
     * 🔴 The ONLY caller that matters is `reveal()` — i.e. this happens when
     * the desktop frame is on screen, not when a request came back. It is the
     * moment the promise "your computer takes over" is actually true; before
     * it, taking the viewport would mean a boot panel eating the OS.
     *
     * Deliberately does nothing while the window is minimised: the user went
     * somewhere else and must not have the viewport yanked out from under
     * them. `wants_fullbleed` remembers, and the restore observer below
     * finishes the job when they come back.
     */
    function go_fullbleed (why) {
        if ( disposed ) return;
        wants_fullbleed = true;
        if ( ! may_fullbleed ) return;
        if ( is_minimized(el_window) ) return;
        if ( el_window.classList.contains(FULLBLEED_CLASS) ) return;

        el_window.classList.add(FULLBLEED_CLASS);
        window.enter_fullpage_mode(el_window);
        // `$.fn.close` reads this to decide whether it owes the user a taskbar
        // back (UIWindow.js:3641). It is '0' until now, because until now the
        // taskbar was never hidden.
        $(el_window).attr('data-is_fullpage', '1');
        // 🔴 `style.css` gives `.window-app-iframe` `pointer-events: none` and
        // only `.window-active .window-app-iframe` gets them back. A user who
        // clicked the wallpaper during the boot would otherwise get a desktop
        // that renders perfectly and ignores every click.
        $(el_window).focusWindow();
        // The drawer is now the only chrome on screen; let it introduce itself.
        el_window._ezil_drawer_flash?.();
        console.info(`[${PHASE}] full-bleed (${why})`);
    }

    async function start_boot () {
        if ( disposed ) return;
        const my_attempt = ++attempt;
        stop_timers();
        show_panel();
        // A fresh attempt has established nothing yet, so last attempt's "we
        // could not check" must not linger over it.
        notice.hide();
        running_signal = undefined;

        if ( desktop_state.configured !== true ) {
            // No provider at all. Do not send a request whose answer is
            // already known, and do not offer a Retry that cannot succeed —
            // `BootProgress` hides the button for this state on purpose.
            console.warn(`[${PHASE}] no desktop provider is configured`);
            progress.render(computeBootUiState({ requestStatus: 'not_configured', elapsedMs: 0 }));
            return;
        }

        const t0 = performance.now();
        paint = () => {
            if ( disposed || my_attempt !== attempt ) return;
            progress.render(computeBootUiState({
                requestStatus: 'pending',
                elapsedMs: performance.now() - t0,
                confirmedGuacamoleRunning: running_signal,
            }));
        };
        paint();
        tick_timer = setInterval(paint, TICK_MS);

        // The ONE genuine mid-boot signal the browser has. Safe to run while
        // the long request is in flight: the container is already being woken
        // by that request, and this probe never wakes one itself.
        poll_timer = setInterval(async () => {
            if ( disposed || my_attempt !== attempt ) return;
            const running = await session.desktopRunning(computer.id);
            if ( disposed || my_attempt !== attempt ) return;
            if ( running === true ) {
                running_signal = true;
                clearInterval(poll_timer); poll_timer = null;
                console.info(`[${PHASE}] desktop process is up (+${Math.round(performance.now() - t0)}ms)`);
                paint();
            }
            // `undefined` means the probe did not answer. It is NOT recorded
            // as `false`: that would be a negative signal we do not have.
        }, POLL_MS);

        console.info(`[${PHASE}] booting computer ${computer.id} (budget ${DESKTOP_BOOT_TIMEOUT_MS}ms)`);
        const res = await session.openDesktop(computer.id);

        if ( disposed || my_attempt !== attempt ) return;
        stop_timers();

        if ( ! res.ok ) {
            console.error(`[${PHASE}] boot failed after ${Math.round(performance.now() - t0)}ms: ${res.errorCode}`);
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: res.errorCode,
                durationMs: performance.now() - t0,
            });
            progress.render(computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            }));
            return;
        }

        console.info(`[${PHASE}] desktop URL in ${Math.round(performance.now() - t0)}ms`
            + ` (${Math.round(performance.now() - t_open)}ms since the window opened;`
            + ` frame confirmed server-side: ${res.frameConfirmed === true})`);

        if ( res.frameConfirmed === true ) {
            // 🔴 NOT `ready`, and this is the change the whole task turns on.
            // The server has confirmed the desktop ORIGIN answers; nothing has
            // yet seen a pixel, and until `start_display_gate` below obtains that,
            // the true statement is the one the panel is already making —
            // "Connecting the display". Rendering `ready` here would put
            // `data-kind="ready"` on the panel while the screen may be blank,
            // which is the claim being deferred.
            //
            // So the clock keeps running (the phase list stays live, and a slow
            // boot still gets its "still working" copy) while the status poll
            // is left stopped — `guacamoleRunning` has nothing further to say
            // once the preview request itself has resolved.
            tick_timer = setInterval(paint, TICK_MS);
            paint();
        } else {
            // The server looked and did NOT see a desktop. Say so now rather
            // than showing progress over it; `settle_frame` re-asks from the
            // browser and can still overturn this.
            progress.render(computeBootUiState({
                requestStatus: 'success',
                elapsedMs: 0,
                // 🔴 Not a constant, and not defaulted to true. `openDesktop`
                // reports this only when the SERVER observed the desktop origin
                // answering, before it handed the URL over.
                frameConfirmed: res.frameConfirmed,
            }));
        }

        // 🔴 The single navigation. Everything above had to have finished.
        el_iframe.src = res.url;
        // 🔴 THE GATE STARTS HERE, NOT AFTER THE FRAME CHECK. Asking Neko
        // whether a peer is connected is independent of everything
        // `settle_frame` does — it goes to Neko's own API, not to the iframe —
        // so running it second was pure serial cost on every healthy boot. It
        // still cannot RELEASE the desktop until the frame check has confirmed
        // (`gate.frameConfirmed`), so the two gates compose exactly as before;
        // only the waiting overlaps.
        const gate = start_display_gate(my_attempt, res.url);
        settle_frame(my_attempt, res.url, gate);
    }

    // ── the handoff ────────────────────────────────────────────────────────
    /**
     * 🔴 THE PANEL COMES DOWN — AND THE VIEWPORT IS TAKEN — ON AN OBSERVATION,
     * NEVER ON AN EVENT OR A TIMER.
     *
     * This replaced the one hole in the whole honesty contract:
     *
     *     el_iframe.addEventListener('load', () => reveal(...), { once: true });
     *     setTimeout(() => reveal(...), 4_000);
     *
     * An iframe fires `load` for an HTTP 500 error page exactly as it does for
     * a working desktop, and cross-origin script cannot read the status code or
     * the document — so `load` only ever proved that the browser finished
     * fetching *something*. The 4s timer proved nothing at all. On 2026-07-31
     * the preview host returned 500 "Proxy routing error" and this window hid
     * its boot panel over the error page and reported ready; with `reveal` now
     * also calling `go_fullbleed`, it would hand the whole viewport to it too.
     *
     * `load` is KEPT — it is the earliest moment worth asking the question. It
     * is no longer the answer. The answer comes from the server, which can make
     * a plain HTTP request to the desktop origin and read its status line
     * (`session.confirmFrame`). Same demotion for the timer: a frame that never
     * fires `load` still gets asked about on a schedule; it never gets believed
     * on one.
     *
     * Three outcomes, all of them honest:
     *   confirmed — panel down, viewport handed over, exactly as before.
     *   refuted   — panel STAYS, failure copy + Retry, window stays windowed on
     *               a usable OS. The user is told their display is not
     *               answering rather than handed an error page full-screen.
     *   no answer — retried a bounded number of times, then treated as refuted.
     *               "We could not confirm your desktop" is a true statement;
     *               an indefinite spinner is not more honest, and Retry re-runs
     *               the whole boot.
     */
    function settle_frame (my_attempt, url, gate) {
        let settled = false;
        let asks = 0;

        const ask = async () => {
            if ( settled || disposed || my_attempt !== attempt ) return;
            asks++;
            const seen = await session.confirmFrame(computer.id, url);
            if ( settled || disposed || my_attempt !== attempt ) return;

            if ( seen === undefined ) {
                // OUR request never landed. That is not an observation of the
                // desktop, so it decides nothing — ask again, bounded.
                if ( asks < FRAME_CONFIRM_ATTEMPTS ) {
                    setTimeout(() => { void ask(); }, FRAME_CONFIRM_RETRY_MS);
                    return;
                }
                console.warn(`[${PHASE}] gave up confirming the frame after ${asks} tries`);
            }

            settled = true;

            if ( seen === true ) {
                // 🔴 NO LONGER THE PATH TO THE VIEWPORT. It used to be, and
                // that was the remaining hole: a confirmed ORIGIN is not a
                // confirmed PICTURE. Measured under WebKit, this branch fired
                // at 4.6s over `videoWidth: 0, paused: true, srcObject: false`
                // and handed the user a third-party spinner full-screen.
                //
                // It is now the RELEASE for the second gate, which is the one
                // that can actually end the boot and which has been asking
                // since the navigation. See `start_display_gate`.
                gate.frameConfirmed();
                return;
            }

            console.error(`[${PHASE}] the frame is not a desktop (confirmFrame -> ${String(seen)})`);
            telemetry.capture({
                eventClass: 'display_failure', site: 'ezil-os:apps/desktop#confirmFrame', code: 'frame_not_answering',
                attrs: { seen: String(seen) },
            });
            gate.stop();
            stop_timers();
            show_panel();
            progress.render(computeBootUiState({
                requestStatus: 'success',
                elapsedMs: 0,
                frameConfirmed: false,
            }));
        };

        el_iframe.addEventListener('load', () => { void ask(); }, { once: true });
        setTimeout(() => { void ask(); }, FRAME_CONFIRM_FALLBACK_MS);
    }

    // ── the display gate ───────────────────────────────────────────────────
    /**
     * 🔴 READY REQUIRES EVIDENCE THAT PIXELS ARRIVED.
     *
     * Everything the boot contract knew before this function existed was about
     * REACHABILITY: the Worker registered a port, the container reports the
     * desktop process up, the desktop origin answers HTTP without an error
     * status. All three can be true of a completely blank screen, and measured
     * under WebKit all three WERE true while the video element had
     * `videoWidth: 0`, `paused: true` and no `srcObject` at all.
     *
     * The browser cannot close that gap. The desktop iframe is cross-origin, so
     * `el_iframe.contentDocument` is null and `video.videoWidth` is not merely
     * hard to reach but forbidden — an attempt throws or silently returns
     * nothing, which is worse than not checking, because it LOOKS like a check.
     *
     * The server can, because Neko keeps the books. `session.confirmDisplay`
     * asks it whether any session's WebRTC peer is connected, which is the far
     * end of the very pipe whose near end we are not allowed to look at.
     *
     * Three outcomes, and the third is the one that took the most care:
     *
     *   live    — panel down, viewport handed over. The only path to `ready`.
     *
     *   blank   — a real, WELL-FORMED and RECENT observation that nobody is
     *             watching, still true at the blank deadline. EZiL's own
     *             failure copy and a Retry, in a window on a usable OS.
     *             Crucially the user is told whose product failed and what to
     *             do, instead of being left staring at a vendor logo.
     *
     *   unknown — we never got an answer we understood. The desktop is still
     *             revealed, because refusing to show a desktop we have no
     *             evidence AGAINST would break every working desktop at once
     *             the moment Neko renames a field — the same lie, sign
     *             flipped, and total. But it is NOT called ready: the
     *             `ready_unverified` strip says plainly that we could not
     *             check, and offers the retry.
     *
     * 🔴 `unknown` NEVER BECOMES `blank`. A failure panel is shown only when we
     * positively observed a session list with no watcher in it, RECENTLY — see
     * `DISPLAY_BLANK_FRESHNESS_MS`. Not answering is a fact about our plumbing,
     * never about the user's screen, and a stale fact is not an observation.
     *
     * 🔴 THE DEADLINES DO NOT DECIDE ANYTHING. They bound how long we keep
     * asking, and they differ (6s / 45s) because they bound two different
     * waits — see their declarations. The verdict at either one is whatever was
     * actually established along the way.
     *
     * ── It starts at the NAVIGATION, and it releases at the frame check ──────
     * This used to be called BY `settle_frame`, so its whole round trip sat
     * end-to-end after a check it has nothing to do with, and a healthy warm
     * boot paid a measured +1508ms for a question that could have been asked,
     * and usually answered, while the frame check was still in flight. It now
     * starts the instant the iframe is pointed at the desktop and hands
     * `frameConfirmed` back to `settle_frame`.
     *
     * 🔴 THAT IS NOT A WEAKENING, AND THE DISTINCTION IS THE WHOLE THING.
     * Nothing is revealed earlier on less evidence. `frame_state` is still
     * `computeBootUiState`'s real verdict for a confirmed frame, the gate still
     * refuses to spend any observation until `frameConfirmed()` says that
     * verdict exists, and `applyDisplayEvidence` is still the only thing that
     * turns evidence into UI. What changed is that the WAITING overlaps —
     * exactly like the status poll, which has always run while the preview
     * request was in flight.
     *
     * @returns {{frameConfirmed: () => void, stop: () => void}}
     */
    function start_display_gate (my_attempt, url) {
        const t_display = performance.now();
        let asks = 0;
        /** Has `computeBootUiState` produced a `ready` for us to spend yet? */
        let frame_ok = false;
        /** A terminal verdict has been rendered; nothing further may act. */
        let done = false;
        /** The desktop is on screen. Once true it is never taken back. */
        let revealed = false;
        /** A `live` observed before the frame check landed, held to be spent. */
        let pending_live = false;
        /** Did the unverified deadline elapse while we were still frame-blind? */
        let unverified_due = false;
        /** `performance.now()` of the most recent WELL-FORMED `blank`. 0 = never. */
        let last_blank_at = 0;
        /** Have we EVER understood an answer? Only this suppresses `unverified`. */
        let ever_wellformed = false;
        let unverified_timer = null;
        let blank_timer = null;

        // The first gate's verdict, run for real rather than assumed — the two
        // gates compose, and `applyDisplayEvidence` can only ever take this
        // `ready` away, never manufacture one.
        const frame_state = computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: true,
        });

        const alive = () => ! disposed && my_attempt === attempt;
        const age = () => performance.now() - t_display;

        const stop = () => {
            done = true;
            clearTimeout(unverified_timer); unverified_timer = null;
            clearTimeout(blank_timer); blank_timer = null;
        };

        /**
         * The one place this gate acts, for all three verdicts. Routing every
         * outcome through `applyDisplayEvidence` rather than branching on the
         * evidence directly is deliberate: the mapping from what was observed
         * to what the user is shown lives in one pure, swept-over function, and
         * this function cannot disagree with it.
         *
         * 🔴 `terminal: false` is the ONE non-final call, and it is only ever
         * reachable with `unknown` — see `reveal_unverified`.
         *
         * 🔴 IT NEVER RETRACTS. A `failed` verdict arriving after the desktop
         * has been revealed is logged and dropped, not rendered. Pulling a
         * full-bleed desktop out from under someone 40 seconds after handing it
         * to them is a worse outcome than the strip they are already reading,
         * which says we could not check and offers the retry. The path is
         * narrow by construction: revealing early requires that NOTHING was
         * ever understood, so a later `blank` means our plumbing broke, then
         * healed, and only then found a dark screen.
         */
        const settle = (evidence, terminal) => {
            if ( ! alive() || done ) return;
            const state = applyDisplayEvidence(frame_state, evidence);

            if ( state.kind === 'failed' ) {
                if ( revealed ) {
                    console.warn(`[${PHASE}] the display went to "${evidence}" ${Math.round(age())}ms in,`
                        + ' after the desktop was already revealed — leaving it up, with its notice');
                    stop();
                    return;
                }
                stop();
                stop_timers();
                progress.render(state);
                // The blank frame is never revealed. The panel stays, over an
                // ordinary window, on an OS with its taskbar still on it.
                show_panel();
                return;
            }

            // `ready` or `ready_unverified`: the desktop is shown either way.
            // The difference the user sees is the strip, and only the strip.
            //
            // 🔴 THE CLOCK STOPS HERE, EVEN WHEN THE ASKING DOES NOT. `paint`
            // renders `requestStatus: 'pending'`, so a tick surviving the
            // reveal writes `data-kind="progress"` back over the panel — a
            // hidden panel claiming a boot still in progress under a desktop
            // that is on screen. Caught by boot-test, intermittently, which is
            // the worst way to find out.
            stop_timers();
            progress.render(state);
            progress.el.hidden = true;
            if ( state.kind === 'ready_unverified' ) notice.show();
            else notice.hide();
            go_fullbleed(state.kind === 'ready'
                ? 'the display was observed streaming'
                : 'the display could not be verified');
            revealed = true;
            if ( state.kind === 'ready' || terminal ) stop();
        };

        /**
         * Show the desktop while we keep trying to check it.
         *
         * Reachable ONLY while `ever_wellformed` is false — i.e. our own
         * plumbing has not produced one intelligible answer. That is the state
         * `ready_unverified` was built for, and making the user wait the full
         * blank deadline first bought nothing: we were not waiting on their
         * desktop, we were waiting on us.
         */
        const reveal_unverified = () => {
            if ( ! alive() || done || revealed || ever_wellformed ) return;
            if ( ! frame_ok ) { unverified_due = true; return; }
            console.warn(`[${PHASE}] no intelligible answer about the display after`
                + ` ${Math.round(age())}ms (${asks} asks) — showing it UNVERIFIED,`
                + ' and still asking');
            settle('unknown', false);
        };

        /**
         * The blank deadline. The last moment at which this gate is allowed to
         * hold the boot, and the only place `blank` can be reached.
         *
         * 🔴 FRESHNESS, NOT STICKINESS. The predecessor latched a boolean the
         * first time it understood an answer, so one `blank` at t=1s followed
         * by forty-four seconds of unanswerable probe still hid the desktop —
         * on evidence a minute old, which is not an observation, it is a
         * memory. `blank` now needs a well-formed blank from within the last
         * `DISPLAY_BLANK_FRESHNESS_MS`; anything else is `unknown`, which
         * reveals.
         */
        const conclude = () => {
            if ( ! alive() || done ) return;
            const fresh = last_blank_at !== 0
                && performance.now() - last_blank_at <= DISPLAY_BLANK_FRESHNESS_MS;
            if ( fresh ) {
                console.error(`[${PHASE}] nothing is watching this desktop after`
                    + ` ${Math.round(age())}ms (${asks} asks) — no pixels reached the browser`);
                telemetry.capture({
                    eventClass: 'display_failure', site: 'ezil-os:apps/desktop#watch', code: 'no_watcher',
                    durationMs: age(), attrs: { seen: 'blank' },
                });
                settle('blank', true);
                return;
            }
            console.warn(`[${PHASE}] could not determine whether the display is streaming`
                + ` (${asks} asks, last understood answer`
                + `${last_blank_at ? ` ${Math.round(performance.now() - last_blank_at)}ms ago` : ' never'})`
                + ' — leaving it UNVERIFIED');
            settle('unknown', true);
        };

        const ask = async () => {
            if ( ! alive() || done ) return;
            asks++;
            const seen = await session.confirmDisplay(computer.id, url);
            if ( ! alive() || done ) return;

            if ( seen === 'blank' ) { ever_wellformed = true; last_blank_at = performance.now(); }

            if ( seen === 'live' ) {
                console.info(`[${PHASE}] the display is streaming`
                    + ` (+${Math.round(age())}ms after the navigation, ${asks} ask(s))`);
                ever_wellformed = true;
                // 🔴 The best answer this gate can get. If the frame check has
                // not landed yet we hold it rather than spend it: `ready`
                // belongs to `computeBootUiState`, and until that has said so
                // there is nothing for `applyDisplayEvidence` to downgrade.
                if ( frame_ok ) settle('live', true);
                else pending_live = true;
                return;
            }
            // 'blank' is a real answer and 'unknown' is not — but neither ends
            // the wait on its own. A desktop that has only just been navigated
            // to has not had time to negotiate WebRTC, so an early `blank` is
            // expected and means nothing yet.

            if ( age() >= DISPLAY_BLANK_DEADLINE_MS ) { conclude(); return; }

            // The unverified reveal is timer-driven rather than checked here on
            // purpose: an ask that hangs burns `session.js`'s 12s budget, and a
            // deadline only tested when an ask RETURNS is a deadline a hung
            // probe can walk straight through. (It did: settle went to 29.7s.)
            if ( unverified_due ) reveal_unverified();

            setTimeout(() => { void ask(); },
                age() < DISPLAY_POLL_SLOW_AFTER_MS ? DISPLAY_POLL_MS : DISPLAY_POLL_SLOW_MS);
        };

        unverified_timer = setTimeout(() => {
            unverified_timer = null;
            unverified_due = true;
            reveal_unverified();
        }, DISPLAY_UNVERIFIED_DEADLINE_MS);

        // 🔴 BOTH DEADLINES ARE TIMERS, for the same reason. Checking one only
        // when an ask RETURNS makes it a deadline the transport can walk
        // through: an ask that hangs holds the boot open past it, and the one
        // case that reaches here with `ever_wellformed` already true — a blank
        // observed early, then a probe that goes silent — has no unverified
        // escape hatch by design (the user is waiting on their desktop, not on
        // us). Without this timer that boot would wait forever.
        blank_timer = setTimeout(() => { blank_timer = null; conclude(); }, DISPLAY_BLANK_DEADLINE_MS);

        void ask();

        return {
            /**
             * `settle_frame` has obtained the FIRST gate's `ready`. Only now may
             * anything this gate observed be turned into UI.
             */
            frameConfirmed () {
                if ( ! alive() || done || frame_ok ) return;
                frame_ok = true;
                // 🔴 Whatever the frame check left on the panel, the true
                // statement until this gate settles is "Connecting the
                // display" — so put the live progress painting back. This
                // matters on one real race: the server's own probe can refute a
                // frame that the browser's re-ask then confirms a moment later,
                // and without this the user would sit under "Your desktop isn't
                // answering" for the whole display wait and then be handed a
                // working desktop.
                show_panel();
                stop_timers();
                tick_timer = setInterval(paint, TICK_MS);
                paint();

                if ( pending_live ) { settle('live', true); return; }
                if ( unverified_due ) reveal_unverified();
            },
            stop,
        };
    }

    // ── minimise ───────────────────────────────────────────────────────────
    /**
     * 🔴 Order matters. `exit_fullpage_mode` un-hides the taskbar (creating it
     * if it is somehow gone), restores the window head and resets the window
     * to a floating box; only THEN does `hideWindow` have a taskbar item to
     * animate into and the user a way back. Reversed, the window shrinks
     * toward a hidden dock and the OS looks empty.
     */
    function minimise_to_taskbar (el) {
        // Guarded, because this handler is now reachable from a window that
        // never went full-bleed (the drawer exists from the moment the window
        // does). `exit_fullpage_mode` on a windowed window would reset its
        // geometry and re-show a head that was never hidden.
        if ( el.classList.contains(FULLBLEED_CLASS) ) {
            el.classList.remove(FULLBLEED_CLASS);
            window.exit_fullpage_mode(el);
        }
        $(el).hideWindow();
    }

    // ── the two window-control hooks ───────────────────────────────────────
    // ADDED BY EZIL 2026-08-08. This window's minimise and expand are not
    // `hideWindow()` and `scale_window()`; they are the two functions in this
    // file, which know about full-bleed. Before these hooks only the control
    // DRAWER reached them, so the very same window behaved one way from its
    // tray and another way from its titlebar and titlebar context menu:
    //
    //   minimise — the head button and the context menu both call
    //     `minimize_window` -> `hideWindow()`, which hides a FULL-BLEED window
    //     without first restoring the taskbar it is covering. The window
    //     shrinks toward a dock that is not on screen and the OS looks empty.
    //     `minimise_to_taskbar` above has the ordering and the reasoning.
    //
    //   expand — there was no head button at all (see `show_maximize_button`
    //     in the `UIWindow` options above), because upstream's `scale_window`
    //     would have written a competing geometry.
    //
    // 🔴 The hook is read by `UIWindow.js` (`minimize_window` and
    // `scale_window`), which is Puter-derived and must not learn what
    // `ezil-fullbleed` is. This is the seam that keeps that true: the generic
    // file asks "does this window minimise/expand itself?", and only this
    // file, which owns full-bleed, answers yes. Every other window in the OS
    // is unaffected and keeps upstream's behaviour exactly.
    //
    // Both hooks take the whole job, including the hide — `minimize_window`
    // does not fall through to `hideWindow()` when the hook is present, so
    // neither hook may call back into it.
    el_window._ezil_minimise = () => { minimise_to_taskbar(el_window); };
    el_window._ezil_maximise = () => { go_fullbleed('expand button'); };

    // Coming back from the taskbar must return to full-bleed, or a desktop
    // that WAS full-bleed reopens as a 680x380 box (that is what
    // `exit_fullpage_mode` left it at). `showWindow` has no hook of its own,
    // so watch the attribute it writes — which keeps this entirely inside EZiL
    // code and leaves the whole-file UIWindow.js port untouched.
    //
    // 🔴 Gated on `wants_fullbleed`. A window minimised WHILE IT IS STILL
    // BOOTING was never full-bleed, and restoring it must not hide the taskbar
    // to show a progress panel.
    let was_minimized = is_minimized(el_window);
    const observer = new MutationObserver(() => {
        const now_minimized = is_minimized(el_window);
        if ( was_minimized && ! now_minimized && wants_fullbleed ) {
            // After showWindow's 0.2s geometry transition, so the window
            // grows back to full-bleed instead of jumping. `go_fullbleed`
            // re-checks `disposed` and the minimised state itself, and
            // restores `data-is_fullpage` (which exit_fullpage_mode removed)
            // so a later close() still knows to bring the taskbar back.
            setTimeout(() => go_fullbleed('restored from the taskbar'), 220);
        }
        was_minimized = now_minimized;
    });
    observer.observe(el_window, { attributes: true, attributeFilter: ['data-is_minimized'] });

    // ── app switching wiring ─────────────────────────────────────────────────
    // See the constants block above for the feature-detection rule. Only
    // computed once, up front, so the drawer either offers real buttons or
    // none — never buttons that are wired up after the fact.
    const focus_endpoint = session.payload()?.desktopState?.endpoints?.focus;
    let switch_in_flight = false;

    /**
     * Two-phase honest status, surfaced in the drawer's own title slot while
     * it is expanded (the drawer has no separate status area — see
     * `attach_app_drawer`'s markup, which is upstream-derived and not this
     * task's to restructure). Restores the real title when done; the
     * collapse timers already hide it the rest of the time.
     */
    async function switchApp (app, label, el) {
        if ( switch_in_flight || disposed || ! focus_endpoint ) return;
        switch_in_flight = true;
        const el_title = el.querySelector('.dashboard-app-drawer-title');
        const restore_title = () => { if ( el_title ) el_title.textContent = title; };
        if ( el_title ) el_title.textContent = `${label}…`;

        const t0 = performance.now();
        const ok = await session.focusApp(computer.id, app, FOCUS_TIMEOUT_MS);
        if ( disposed ) { switch_in_flight = false; return; }

        if ( ok !== true ) {
            if ( el_title ) {
                el_title.textContent = ok === undefined ? "Couldn't reach your computer" : 'Your computer refused that';
                setTimeout(restore_title, 2_500);
            }
            switch_in_flight = false;
            return;
        }

        // Real signal (round trip) done; the encoder is not. Wait out the
        // rest of the measured floor before saying anything is visible.
        const remaining = Math.max(0, FOCUS_LEGIBLE_ESTIMATE_MS - (performance.now() - t0));
        await new Promise((r) => setTimeout(r, remaining));
        if ( disposed ) { switch_in_flight = false; return; }
        // This is a live WebRTC/Neko stream, not a static iframe: the encoder
        // catching up is what makes the switch visible, and there is nothing
        // here to reload. Only the label is honest progress — "should be", not
        // "is": nothing here can observe the pixel.
        if ( el_title ) {
            el_title.textContent = 'It should be in front now';
            setTimeout(restore_title, 2_500);
        }
        switch_in_flight = false;
    }

    // ── the control tray ───────────────────────────────────────────────────
    // Attached AFTER the window exists and BEFORE the boot starts, so that
    // whether there IS a way out of full-bleed is known before we could ever
    // enter it — and so `go_fullbleed` has a drawer to flash the moment it
    // fires.
    //
    // 🔴 `flash_on_attach: false`. While the window is windowed its own head
    // is the chrome and the drawer is hidden by CSS; playing the intro here
    // would animate an invisible element and spend the one gesture that
    // teaches where the controls live on a moment the user has no use for it.
    // `go_fullbleed` plays it instead, when the drawer becomes the only way
    // out.
    const drawer_actions = [
        {
            id: 'minimize',
            label: 'Minimise',
            svg: MINIMISE_SVG,
            onClick: minimise_to_taskbar,
        },
        // Settings drops in here in a later wave — the drawer renders
        // whatever this array contains, in order, before Close.
    ];
    if ( focus_endpoint ) {
        for ( const app of FOCUS_APPS ) {
            drawer_actions.push({
                id: `focus-${app.id}`,
                label: app.label,
                svg: app.svg,
                onClick: (el) => { void switchApp(app.id, app.label, el); },
            });
        }
    }
    const drawer = attach_app_drawer(el_window, {
        title,
        icon: ctx.icon,
        flash_on_attach: false,
        actions: drawer_actions,
    });
    if ( ! drawer ) {
        // The drawer failing to attach means a full-bleed window with no exit.
        // Staying windowed is worse-looking and strictly better than trapping
        // the user inside their container. Now that full-bleed is something
        // this file opts INTO, refusing is a flag rather than a reversal —
        // there is no window of time in which the taskbar is already gone.
        console.error(`[${PHASE}] control drawer did not attach — this window will stay windowed, over the taskbar`);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:apps/desktop#drawer', code: 'drawer_attach_failed',
        });
        may_fullbleed = false;
    }

    // ── teardown ───────────────────────────────────────────────────────────
    /** Everything that must stop, whichever way this window ends. */
    const dispose = () => {
        disposed = true;
        stop_timers();
        observer.disconnect();
        // The aspect-fit observer holds a reference to the window body; a
        // window that is going away must not leave one behind. Null when the
        // environment has no ResizeObserver — see where it is created.
        fit_observer?.disconnect();
        window.removeEventListener('ezil:teardown', dispose);
    };

    // `$.fn.close` awaits this before it dismantles anything, so it is the one
    // place guaranteed to run exactly once per close.
    el_window.on_before_exit = async () => {
        dispose();
        return true;
    };

    // The other way a window ends: something removed it from the document
    // without closing it, and the shell is rebuilding the desktop (see
    // `ensure_intact` in ../boot.js). `$.fn.close` never runs in that case, so
    // without this the orphan keeps polling and its in-flight boot keeps
    // racing the rebuilt window for the same container.
    window.addEventListener('ezil:teardown', dispose);

    void start_boot();
    return el_window;
}

export default openDesktopWindow;
