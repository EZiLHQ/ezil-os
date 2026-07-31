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
// ── 🔴 The taskbar is hidden; the drawer is the only way out ────────────────
// `enter_fullpage_mode` does `$('.taskbar').hide()` AND hides the window head,
// and `style.css:246` hides `.window-minimize-btn` in fullpage mode. So once
// this window goes full-bleed there is NO chrome on screen except the control
// drawer. Minimise therefore cannot just call `hideWindow()`: it has to bring
// the taskbar back first, or the window animates into a dock that is not
// there and the user is left with a desktop they cannot leave. See
// `minimise_to_taskbar` below.

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

const MINIMISE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="round" aria-hidden="true"><line x1="5" y1="17" x2="19" y2="17"/></svg>';

/** `data-is_minimized` is written as 1/0 at creation and true/false later. */
function is_minimized (el) {
    const v = $(el).attr('data-is_minimized');
    return v === '1' || v === 'true';
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
        is_fullpage: true,
        stay_on_top: true,
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

    const stop_timers = () => {
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const progress = BootProgress({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(progress.el);

    /** Show the panel again (retry after a failure, or a fresh attempt). */
    const show_panel = () => { progress.el.hidden = false; };

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
            + ` (${Math.round(performance.now() - t_open)}ms since the window opened)`);
        progress.render(computeBootUiState({ requestStatus: 'success', elapsedMs: 0 }));

        // 🔴 The single navigation. Everything above had to have finished.
        el_iframe.src = res.url;
        // Hide the panel only once the frame has something to show, so the
        // swap is desktop-for-progress rather than progress-for-white. If the
        // load event never fires we still get out of the way — a stuck panel
        // over a working desktop would be a worse failure than a blank frame.
        const reveal = () => { progress.el.hidden = true; };
        el_iframe.addEventListener('load', reveal, { once: true });
        setTimeout(reveal, 4_000);
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
        window.exit_fullpage_mode(el);
        $(el).hideWindow();
    }

    // Coming back from the taskbar must return to full-bleed, or the desktop
    // reopens as a 680x380 box (that is what `exit_fullpage_mode` left it at).
    // `showWindow` has no hook of its own, so watch the attribute it writes —
    // which keeps this entirely inside EZiL code and leaves the whole-file
    // UIWindow.js port untouched.
    let was_minimized = is_minimized(el_window);
    const observer = new MutationObserver(() => {
        const now_minimized = is_minimized(el_window);
        if ( was_minimized && ! now_minimized ) {
            // After showWindow's 0.2s geometry transition, so the window
            // grows back to full-bleed instead of jumping.
            setTimeout(() => {
                if ( disposed || is_minimized(el_window) ) return;
                window.enter_fullpage_mode(el_window);
                // exit_fullpage_mode removed this; restore it so a later
                // close() still knows to bring the taskbar back.
                $(el_window).attr('data-is_fullpage', '1');
                // The taskbar it was just restored from is now hidden again,
                // so replay the drawer's intro — otherwise the only chrome on
                // screen never announces itself a second time.
                el_window._ezil_drawer_flash?.();
            }, 220);
        }
        was_minimized = now_minimized;
    });
    observer.observe(el_window, { attributes: true, attributeFilter: ['data-is_minimized'] });

    // ── the control tray ───────────────────────────────────────────────────
    // Attached AFTER the window exists and BEFORE the boot starts, so it is
    // present for the whole of a 22-second boot — a user who changes their
    // mind 3 seconds in must not have to wait for the container to finish
    // before they can leave.
    const drawer = attach_app_drawer(el_window, {
        title,
        icon: ctx.icon,
        actions: [
            {
                id: 'minimize',
                label: 'Minimise',
                svg: MINIMISE_SVG,
                onClick: minimise_to_taskbar,
            },
            // Settings drops in here in a later wave — the drawer renders
            // whatever this array contains, in order, before Close.
        ],
    });
    if ( ! drawer ) {
        // The drawer failing to attach means a full-bleed window with no exit.
        // Leaving the taskbar visible is worse-looking and strictly better
        // than trapping the user inside their container.
        console.error(`[${PHASE}] control drawer did not attach — staying windowed so there is a way out`);
        window.exit_fullpage_mode(el_window);
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
