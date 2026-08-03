// preview.js — EZiL-authored. Not Puter code.
//
// The Preview window: the user's own app, over plain HTTP, in an iframe.
// Companion to `desktop-window.js` (the full streamed Linux desktop) — same
// sandbox, a different transport. docs/PLATFORM-NOTES.md §6: there is no UDP
// path to a Cloudflare Container, so the WebRTC desktop is relayed through
// TURN no matter what, while anything renderable as a web page reaches this
// window as a plain reverse-proxied HTTP response. **That makes this window
// the lower-latency way to look at the user's own app whenever the app is a
// web page** — it is easy to under-rate because it is "just an iframe".
//
// ── Where the URL comes from ────────────────────────────────────────────────
// `session.previewUrl(computerId)` -> `POST /api/shell/preview-url` ->
// `cloudflareGuacamole.appPreviewUrl`, which checks ownership, ensures the
// container's port 3002 is exposed, and mints a `/preview-bootstrap?token=…`
// URL for the app-preview bridge host.
//
// 🔴 This file was originally written against a DIFFERENT guess: that
// `session.openDesktop()` would grow an `appPreviewUrl` field. It never did —
// the URL landed behind its own route instead — so every open of this window
// fell through to `show_unavailable()` and the Preview window silently never
// worked. The seam is closed; the note survives because "the field my sibling
// task will add" is exactly the kind of assumption that fails quietly.
//
// ── 🔴 Mint the token per window-open — NEVER reuse an earlier one ─────────
// The app-preview URL carries a bootstrap token good for FIVE MINUTES
// (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`, enforced by the Worker's
// `verifyPreviewBootstrapToken`; the same reason
// `cloudflare-guacamole-canvas.tsx` refetches the full desktop's URL on a
// timer). A page can sit open for a long time between load and the user
// actually clicking the Preview icon, so a URL captured at boot-payload time —
// or cached from a PRIOR window-open — is routinely already dead by the time a
// window would use it. The symptom is a blank window and
// `preview_bootstrap_token_expired`, with nothing in the UI able to explain it.
//
// The protection is STRUCTURAL, not a TTL check. Three properties, and all
// three have to hold:
//
//   1. this file never stores a URL in module state;
//   2. it never reads one from `session.payload()` (the server deliberately
//      puts none there — see `boot-payload.ts`);
//   3. `el_iframe.src` is assigned EXACTLY ONCE per `start_boot()`, and
//      nothing ever re-navigates it. An earlier draft had an app-switcher
//      here that re-assigned `el_iframe.src` to force a repaint — which would
//      have re-requested `/preview-bootstrap` with a token minted minutes ago.
//      That switcher is gone (see the note below), and this is the reason it
//      must not come back in this form.
//
// Re-opening a closed instance re-runs `start_boot()` (registry's
// single-instance restore only re-focuses a window that is still open), so
// every genuine open mints fresh.
//
// ── Why there is no app switcher in THIS window ─────────────────────────────
// There was one, mirroring the desktop window's. It does not belong here, for
// a reason that is easy to miss: this iframe shows the user's DEV SERVER over
// HTTP (container port 3002), not the X session. Raising Chromium's window
// inside the container changes what the WebRTC DESKTOP stream shows and has no
// effect whatsoever on what this iframe renders. A control that reports
// success and visibly changes nothing is worse than no control. The switcher
// lives in `desktop-window.js`, where the thing it moves is the thing on
// screen.
//
// ── 🔴 Frame honesty, inherited — not reinvented ────────────────────────────
// `desktop-window.js` was fixed after an iframe reported `ready` over an HTTP
// 500 "Proxy routing error" — `load` fires identically for an error page and
// a real one, and cross-origin script can read neither the status nor the
// document. The fix there is "ask the server, never trust `load`"
// (`session.confirmFrame`, gated through `computeBootUiState`'s
// `frameConfirmed` branch). This file reuses BOTH exactly, unmodified,
// against the app-preview URL instead of the desktop URL — not a parallel
// re-implementation. See `settle_frame` below, which is `desktop-window.js`'s
// `settle_frame` with the desktop-specific full-bleed handoff removed and
// nothing about the honesty gate touched.
//
// 🔴 An earlier version of this comment warned that `confirmFrame`'s
// `isOwnDesktopOrigin` pin was scoped to the desktop origin and would refuse a
// healthy preview forever. That turned out to be WRONG about the cause and
// RIGHT about the risk. The pin is deliberately port- and token-agnostic and
// always accepted this host. The false negative was one function further on:
// `probeDesktopFrame` stripped the query string before probing — correct for
// the desktop, whose query is a credential; fatal here, where the query IS the
// key to the document, so the Worker answered 401 to every probe of a
// perfectly healthy preview. Fixed, with both directions proven, in
// `app/src/server/lib/app-preview-frame-honesty.test.ts`. Nothing in this file
// needed to change — which is the point: the gate is the server's, and this
// window just asks.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import telemetry from '../telemetry.js';
import { computeBootUiState } from '../boot-phases.js';
import BootProgress from '../ui/boot-progress.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:preview';

/** How often the UI re-derives its phase from elapsed time. */
const TICK_MS = 250;
/** How often the cheap status probe runs. It does NOT wake a container. */
const POLL_MS = 2_000;

/**
 * The post-handoff frame confirmation. Kept byte-for-byte in step with
 * `desktop-window.js`'s own constants of the same name — this is the same
 * contract applied to a different URL, not a separate policy. See that file's
 * header for what each one is for.
 */
const FRAME_CONFIRM_FALLBACK_MS = 4_000;
const FRAME_CONFIRM_ATTEMPTS = 3;
const FRAME_CONFIRM_RETRY_MS = 1_500;

/**
 * Open the Preview window.
 *
 * @param {object} ctx
 * @param {object} ctx.payload      `window.__EZIL_BOOT__`
 * @param {object} ctx.computer     `payload.computer`
 * @param {object} ctx.desktopState `payload.desktopState`
 * @param {string} [ctx.icon]       The launching descriptor's icon.
 * @returns {Promise<HTMLElement|null>}
 */
export async function openPreviewWindow (ctx = {}) {
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    const title = computer?.name ? `${computer.name} — Preview` : 'Preview';

    if ( ! computer?.id ) {
        console.error(`[${PHASE}] refusing to open: the boot payload carries no computer`);
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/preview#open', code: 'no_computer_in_payload',
        });
        return null;
    }

    const el_window = await UIWindow({
        title,
        app: 'preview',
        icon: ctx.icon,
        // 🔴 Same reasoning as `desktop-window.js`: navigated exactly once,
        // after a freshly minted URL is confirmed. See the header.
        iframe_url: 'about:blank',
        is_fullpage: false,
        width: 720,
        height: 480,
        is_resizable: true,
        // Unlike the desktop window this is a secondary utility surface, not
        // the thing that eats the viewport — a normal maximize is fine here.
        show_maximize_button: true,
        stay_on_top: false,
        single_instance: true,
        show_in_taskbar: true,
        is_droppable: false,
        window_class: 'ezil-preview-window',
        selectable_body: false,
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:apps/preview#open', code: 'uiwindow_returned_nothing',
        });
        return null;
    }

    const el_body = el_window.querySelector('.window-body');
    const el_iframe = el_window.querySelector('.window-app-iframe');
    // A positioning context for the switcher toolbar below, without touching
    // any stylesheet this task does not own. Safe on an element that already
    // fills its window: it only affects where ABSOLUTELY positioned children
    // anchor, not this element's own layout.
    if ( getComputedStyle(el_body).position === 'static' ) el_body.style.position = 'relative';

    let tick_timer = null;
    let poll_timer = null;
    let attempt = 0;
    let running_signal;
    let disposed = false;

    const stop_timers = () => {
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const progress = BootProgress({ onRetry: () => { void start_boot(); } });
    el_body.appendChild(progress.el);

    // ── the "no field yet" panel — a DIFFERENT message from any BootProgress
    // state, because "the deployment does not support this" is not the same
    // honest claim as "not configured" or "failed to confirm", and blurring
    // them would tell the user something that is not true. No Retry: the
    // next attempt would fail identically until the deployment changes, and
    // offering one anyway would be exactly the "spinner that lies" this
    // whole feature is warned against building.
    const el_unavailable = document.createElement('div');
    // Styles live in `ezil-shell.css`, NOT inline: an inline `display` beats
    // the UA's `[hidden] { display: none }`, so `hidden = true` below would
    // hide nothing and this panel would paint over a working iframe forever.
    el_unavailable.className = 'ezil-preview-unavailable';
    el_unavailable.hidden = true;
    el_unavailable.innerHTML = `
        <div style="font-size:15px;font-weight:600;">Preview isn't available yet</div>
        <div style="font-size:13px;max-width:32em;opacity:0.75;">
            This computer's app preview hasn't been turned on for this deployment.
            The full desktop still works from its own window.
        </div>`;
    el_body.appendChild(el_unavailable);

    const show_panel = () => { progress.el.hidden = false; el_unavailable.hidden = true; };
    const show_unavailable = () => { progress.el.hidden = true; el_unavailable.hidden = false; };

    async function start_boot () {
        if ( disposed ) return;
        const my_attempt = ++attempt;
        stop_timers();
        show_panel();
        running_signal = undefined;

        if ( desktop_state.configured !== true ) {
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

        poll_timer = setInterval(async () => {
            if ( disposed || my_attempt !== attempt ) return;
            const running = await session.desktopRunning(computer.id);
            if ( disposed || my_attempt !== attempt ) return;
            if ( running === true ) {
                running_signal = true;
                clearInterval(poll_timer); poll_timer = null;
                paint();
            }
        }, POLL_MS);

        // 🔴 THE MINT — and the whole of Seam 4's answer.
        //
        // This call happens exactly once per genuine window-open, right here,
        // right now. Not read from the boot payload (the server puts nothing
        // there, deliberately), not carried over from a previous open (no
        // module state holds a URL), and not derived from anything cached. The
        // five-minute token starts its life a few hundred milliseconds before
        // the single `el_iframe.src =` below consumes it. See the file header.
        console.info(`[${PHASE}] minting a preview URL for computer ${computer.id} (budget ${DESKTOP_BOOT_TIMEOUT_MS}ms)`);
        const res = await session.previewUrl(computer.id);

        if ( disposed || my_attempt !== attempt ) return;
        stop_timers();

        if ( ! res.ok ) {
            // `app_preview_unavailable` is the one code that means "this
            // deployment/container cannot serve a preview at all" rather than
            // "something went wrong": the port could not be exposed, or the
            // origin could not be derived. That is not a failure to retry, it
            // is the honest "not available" panel — the same distinction the
            // panel's own copy makes.
            if ( res.errorCode === 'app_preview_unavailable' ) {
                console.warn(`[${PHASE}] this computer cannot serve an app preview: ${res.errorCode}`);
                show_unavailable();
                return;
            }
            console.error(`[${PHASE}] preview mint failed after ${Math.round(performance.now() - t0)}ms: ${res.errorCode}`);
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:apps/preview#mint', code: res.errorCode,
                durationMs: performance.now() - t0,
            });
            progress.render(computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            }));
            return;
        }

        // 🔴 DEGRADE HONESTLY, still. `session.previewUrl` already refuses to
        // report `ok` without a URL, so this is belt-and-braces rather than
        // the primary guard — but this window must never invent a URL to fill
        // a gap, and the cheapest way to guarantee that is to have no code
        // path that could.
        const preview_url = res.url;
        if ( typeof preview_url !== 'string' || preview_url === '' ) {
            console.warn(`[${PHASE}] preview-url returned ok with no URL; app preview is not available`);
            show_unavailable();
            return;
        }

        console.info(`[${PHASE}] mint resolved in ${Math.round(performance.now() - t0)}ms`);
        // Same rule as `desktop-window.js`: only the SERVER's confirmation
        // may reveal the frame; render() below still gates on `frameConfirmed`.
        progress.render(computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: false,
        }));

        el_iframe.src = preview_url;
        settle_frame(my_attempt);
    }

    /**
     * The post-handoff frame confirmation. This IS `desktop-window.js`'s
     * `settle_frame`, targeted at the app-preview URL instead of the desktop
     * URL, with the full-bleed handoff removed (this window is never
     * full-bleed) — see the file header for why the honesty gate itself is
     * unchanged rather than reimplemented.
     */
    function settle_frame (my_attempt) {
        let settled = false;
        let asks = 0;

        const ask = async () => {
            if ( settled || disposed || my_attempt !== attempt ) return;
            asks++;
            const seen = await session.confirmFrame(computer.id, el_iframe.src);
            if ( settled || disposed || my_attempt !== attempt ) return;

            if ( seen === undefined ) {
                if ( asks < FRAME_CONFIRM_ATTEMPTS ) {
                    setTimeout(() => { void ask(); }, FRAME_CONFIRM_RETRY_MS);
                    return;
                }
                console.warn(`[${PHASE}] gave up confirming the preview frame after ${asks} tries`);
            }

            settled = true;

            if ( seen === true ) {
                progress.el.hidden = true;
                el_unavailable.hidden = true;
                console.info(`[${PHASE}] preview frame confirmed by the server`);
                return;
            }

            console.error(`[${PHASE}] the preview frame is not answering (confirmFrame -> ${String(seen)})`);
            telemetry.capture({
                eventClass: 'display_failure', site: 'ezil-os:apps/preview#confirmFrame', code: 'frame_not_answering',
                attrs: { seen: String(seen) },
            });
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

    const dispose = () => {
        disposed = true;
        stop_timers();
        window.removeEventListener('ezil:teardown', dispose);
    };

    el_window.on_before_exit = async () => {
        dispose();
        return true;
    };
    window.addEventListener('ezil:teardown', dispose);

    void start_boot();
    return el_window;
}

export default openPreviewWindow;
