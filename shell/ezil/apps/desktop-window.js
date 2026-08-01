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
// ── 🔴 The taskbar is hidden; the drawer is the only way out ────────────────
// Once full-bleed, `enter_fullpage_mode` has hidden the taskbar AND the window
// head, and `style.css:246` hides `.window-minimize-btn` in fullpage mode. So
// there is NO chrome on screen except the control drawer. Minimise therefore
// cannot just call `hideWindow()`: it has to bring the taskbar back first, or
// the window animates into a dock that is not there and the user is left with
// a desktop they cannot leave. See `minimise_to_taskbar` below.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import { computeBootUiState } from '../boot-phases.js';
import BootProgress from '../ui/boot-progress.js';
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
 * @returns {Promise<HTMLElement|null>}
 */
export async function openDesktopWindow (ctx = {}) {
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    // The computer's own name, not the app's: the window IS that machine, and
    // a user with two computers must be able to tell which one they are in.
    const title = computer?.name || 'Linux Desktop';

    if ( ! computer?.id ) {
        // Nothing to connect to. `/os` already refuses to render the shell in
        // this case, so reaching here means a rehydrated payload lost its
        // computer — say so instead of opening an empty window.
        console.error(`[${PHASE}] refusing to open: the boot payload carries no computer`);
        return null;
    }

    const t_open = performance.now();

    const el_window = await UIWindow({
        title,
        app: 'desktop',
        icon: ctx.icon,
        // 🔴 Navigated exactly once, after previewUrl resolves. See header.
        iframe_url: 'about:blank',
        // 🔴 NOT `is_fullpage: true`. That is what hid the taskbar from the
        // first frame; full-bleed is entered by `go_fullbleed` below, once
        // there is a desktop to be full-bleed WITH. See the header.
        is_fullpage: false,
        // Big enough for the boot panel with room around it, small enough to
        // read as "an app starting" rather than "the OS is this window".
        width: 560,
        height: 400,
        // 🔴 Resizable — and NOT because anyone needs to resize a boot panel.
        // `UIWindow.js:346` renders the head's MINIMISE button only when
        // `is_resizable && show_minimize_button && !is_embedded`. OBSERVED in
        // Chromium with `is_resizable: false`: the head came out with a close
        // button and nothing else, which would leave "get this out of my way
        // while my computer boots" as a thing the user can only do by closing
        // the window. `ezil-shell.css` hides the resize handles once the window
        // is full-bleed, so a stray drag still cannot shrink the live desktop.
        is_resizable: true,
        // The maximize button would fight `go_fullbleed` for the same geometry
        // and leave `data-is_maximized` set behind a full-bleed window.
        show_maximize_button: false,
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
        return null;
    }

    const el_body = el_window.querySelector('.window-body');
    const el_iframe = el_window.querySelector('.window-app-iframe');

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

    const stop_timers = () => {
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const progress = BootProgress({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(progress.el);

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
        const paint = () => {
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
            progress.render(computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            }));
            return;
        }

        console.info(`[${PHASE}] desktop ready in ${Math.round(performance.now() - t0)}ms`
            + ` (${Math.round(performance.now() - t_open)}ms since the window opened;`
            + ` frame confirmed server-side: ${res.frameConfirmed === true})`);
        progress.render(computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            // 🔴 Not a constant, and not defaulted to true. `openDesktop`
            // reports this only when the SERVER observed the desktop origin
            // answering, before it handed the URL over. If it is false,
            // `computeBootUiState` renders the failure panel instead of
            // `ready` — see its `success` branch.
            frameConfirmed: res.frameConfirmed,
        }));

        // 🔴 The single navigation. Everything above had to have finished.
        el_iframe.src = res.url;
        settle_frame(my_attempt, res.url);
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
    function settle_frame (my_attempt, url) {
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
                // 🔴 The one path to the viewport. "The panel is gone" and "the
                // taskbar is gone" stay one decision, and that decision now
                // rests on a real HTTP answer from the desktop's own origin.
                progress.el.hidden = true;
                go_fullbleed('frame confirmed by the server');
                return;
            }

            console.error(`[${PHASE}] the frame is not a desktop (confirmFrame -> ${String(seen)})`);
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
        may_fullbleed = false;
    }

    // ── teardown ───────────────────────────────────────────────────────────
    /** Everything that must stop, whichever way this window ends. */
    const dispose = () => {
        disposed = true;
        stop_timers();
        observer.disconnect();
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
