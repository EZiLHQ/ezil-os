// code.js — EZiL-authored. Not Puter code.
//
// The Code window: code-server (VS Code Web), over plain HTTP, in an iframe.
// Sibling of `preview.js` — same sandbox, same bridge MECHANISM (a reverse
// proxy into one container port, gated by a short-lived bootstrap token), a
// different port and a different reason to exist.
//
// ── Why this is its own window, not a mode of the streamed desktop ─────────
// Wave A's container task replaced Electron VS Code (an X11 app inside the
// Neko/WebRTC desktop) with **code-server**, which is an HTTP server on
// `127.0.0.1:8443` — not an X client. `worker/src/sandbox-control.ts`'s
// `neko-switch-app.sh` can only ever raise a WINDOW, and code-server has none
// to raise (`wmctrl -x -l` never lists it); `validate-neko-focus.sh` asserts
// the resulting non-zero exit as CORRECT behaviour, and
// `cloudflare-guacamole-provider.ts`'s `FOCUSABLE_APPS` was narrowed to
// `['chromium']` for exactly this reason (see its doc comment). So "focus
// code inside the stream" is not a smaller version of this feature — it is a
// different, impossible feature. The actual upgrade code-server buys (crisp
// text at any size, real browser text selection/find, no TURN relay, no video
// encode of a terminal) only exists on the OTHER side of that fact: a plain
// HTTP window, exactly like this one, never inside the WebRTC canvas.
//
// ── Where the URL comes from ────────────────────────────────────────────────
// `POST /api/shell/code-preview-url` -> `cloudflareGuacamole.codePreviewUrl`,
// which reuses the SAME `/sandbox/preview` Worker call `previewUrl` and
// `appPreviewUrl` make (idempotent, warm-fast, but able to cold-boot the
// container on the very first call of a session) and reads the Worker's own
// `codePreviewUrl` field — composed, ready to embed — falling back to
// composing one locally only against a Worker deployed before that field
// existed. See `cloudflare-guacamole-provider.ts`'s `codePreviewUrl` doc
// comment for the full three-state contract.
//
// 🔴 Deliberately NOT routed through `shell/ezil/session.js`. That file is
// owned by a sibling task this wave, and adding a `codePreviewUrl` export to
// it would risk exactly the merge collision file ownership exists to
// prevent. This module makes its own POST, mirroring `session.js`'s
// `previewUrl()` shape byte-for-byte (same timeout budget, same error-code
// taxonomy), and reuses `session.confirmFrame` / `session.desktopRunning` /
// `session.payload` UNMODIFIED — those are already-exported, already-generic
// functions; nothing about them is app-preview-specific. See
// `app/src/server/lib/app-preview-frame-honesty.test.ts`'s
// `isOwnDesktopOrigin` suite, which proves the server-side pin those
// functions ultimately rely on already accepts the code-server origin
// (`<CODE_PREVIEW_PORT>-<sandbox>-code.<zone>`) — this file does not need to,
// and must not, reimplement that proof.
//
// ── 🔴 Mint the token per window-open — NEVER reuse an earlier one ─────────
// Identical rule to `preview.js`, for the identical reason: the code-preview
// URL carries a bootstrap token good for FIVE MINUTES
// (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`, reused verbatim for the
// code-server bridge — see `cloudflare-guacamole-provider.ts`). A URL held
// across window-opens, or read from the boot payload, is routinely already
// dead by the time it is used. The protection is the same three structural
// properties `preview.js` documents:
//
//   1. this file never stores a URL in module state;
//   2. it never reads one from `session.payload()` (the server puts none
//      there, deliberately — see `boot-payload.ts`);
//   3. `el_iframe.src` is assigned EXACTLY ONCE per `start_boot()`.
//
// ── 🔴 Frame honesty, inherited — not reinvented ────────────────────────────
// Same contract as `preview.js` and `desktop-window.js`: an iframe `load`
// event fires identically for an HTTP error page and a real one, so this
// window never trusts it. `settle_frame` below is byte-for-byte
// `preview.js`'s `settle_frame`, targeted at the code-preview URL instead of
// the app-preview one. See that file's header for the full account of why
// the gate is the server's and this window only asks — and see
// `app-preview-frame-honesty.test.ts` for BOTH directions proven against a
// real HTTP bridge (a healthy frame confirms; a 500 does not).
//
// ── 🔴 RUNTIME_SHIM must never reach code-server ────────────────────────────
// `worker/src/preview-bridge.ts`'s `handlePreviewProxy` monkey-patches
// `window.WebSocket` (via `RUNTIME_SHIM`) to rewrite Next.js/Vite HMR paths —
// necessary for the app-preview window, instantly fatal to code-server's
// extension host, which uses WebSockets for something that is not HMR at
// all. This file has NOTHING to do to keep that true: the exclusion is
// `target === 'code'`-gated entirely server-side
// (`const injected = target === 'code' ? bodyText : injectRuntimeShim(bodyText);`),
// and this window reaches that target purely by virtue of which bridge host
// `codePreviewUrl` points at. VERIFIED, not assumed: read the source above,
// and ran `worker`'s own suite —
// `preview-bridge.test.ts`'s "NEVER injects RUNTIME_SHIM into an HTML
// response — code-server WebSocket traffic is not HMR" and
// `route-auth.test.ts`'s equivalent both pass. See the wave-b-t7 report for
// the exact commands run.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import telemetry from '../telemetry.js';
import { computeBootUiState } from '../boot-phases.js';
import BootProgress from '../ui/boot-progress.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:code';

/** How often the UI re-derives its phase from elapsed time. */
const TICK_MS = 250;
/** How often the cheap status probe runs. It does NOT wake a container. */
const POLL_MS = 2_000;

/**
 * The post-handoff frame confirmation. Kept in step with `preview.js`'s own
 * constants of the same name — this is the same contract, a different URL.
 */
const FRAME_CONFIRM_FALLBACK_MS = 4_000;
const FRAME_CONFIRM_ATTEMPTS = 3;
const FRAME_CONFIRM_RETRY_MS = 1_500;

/**
 * Mint a fresh code-server window URL. Mirrors `session.js`'s `previewUrl()`
 * exactly (same request shape, same error-code taxonomy) against
 * `/api/shell/code-preview-url` instead of `/api/shell/preview-url` — see
 * this file's header for why it is not itself a `session.js` export.
 *
 * @param {string} computerId
 * @returns {Promise<{ok: true, url: string, expiresAt?: number}
 *                  | {ok: false, errorCode: string, message?: string}>}
 */
async function mintCodePreviewUrl (computerId) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to preview.' };
    }

    const endpoint = session.payload()?.desktopState?.endpoints?.codePreviewUrl
        ?? '/api/shell/code-preview-url';

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId }),
            signal: AbortSignal.timeout(DESKTOP_BOOT_TIMEOUT_MS),
        });
    } catch ( err ) {
        // Same distinction session.js's `request()` makes: our own timeout
        // vs. a genuine transport failure.
        const timed_out = err && err.name === 'TimeoutError';
        return {
            ok: false,
            errorCode: timed_out ? 'timeout' : 'fetch_failed',
            message: timed_out ? 'The request took too long.' : 'Could not reach the server.',
        };
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if ( ! res.ok ) {
        const code = data?.error?.code;
        if ( code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: data?.error?.message };
        return { ok: false, errorCode: 'unknown', message: data?.error?.message ?? 'Something went wrong.' };
    }

    if ( data?.ok !== true ) {
        return { ok: false, errorCode: data?.errorCode ?? 'unknown' };
    }
    if ( typeof data.codePreviewUrl !== 'string' || data.codePreviewUrl === '' ) {
        // Reported success with nothing to show. Loud, not silent — same rule
        // `session.js`'s `previewUrl()` follows for `appPreviewUrl`.
        console.error(`[${PHASE}] codePreviewUrl returned ok with no URL`);
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/code#mint', code: 'code_preview_url_missing',
        });
        return { ok: false, errorCode: 'unknown' };
    }
    return { ok: true, url: data.codePreviewUrl, expiresAt: data.expiresAt };
}

/**
 * Open the Code window.
 *
 * @param {object} ctx
 * @param {object} ctx.payload      `window.__EZIL_BOOT__`
 * @param {object} ctx.computer     `payload.computer`
 * @param {object} ctx.desktopState `payload.desktopState`
 * @param {string} [ctx.icon]       The launching descriptor's icon.
 * @param {string} [ctx.appName]    The launching descriptor's `name` — this
 *   window's TITLE. See the `title` assignment in the body.
 * @returns {Promise<HTMLElement|null>}
 */
export async function openCodeWindow (ctx = {}) {
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    // MODIFIED BY EZIL 2026-08-08: the APP's name, not the machine's. This was
    // `computer?.name ? \`${computer.name} — Code\` : 'Code'`, which titled the
    // window "Computer — Code" for a computer named "Computer". See
    // `desktop-window.js`'s matching block for the full reasoning — all three
    // app windows are titled the same way, from `ctx.appName`, and carry the
    // machine in the head's tooltip instead.
    const title = ctx.appName || 'Code';
    const title_tooltip = computer?.name ? `${title} — ${computer.name}` : title;

    if ( ! computer?.id ) {
        console.error(`[${PHASE}] refusing to open: the boot payload carries no computer`);
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/code#open', code: 'no_computer_in_payload',
        });
        return null;
    }

    const el_window = await UIWindow({
        title,
        // The machine, on hover. See the `title` assignment above.
        title_tooltip,
        app: 'code',
        icon: ctx.icon,
        // 🔴 Same reasoning as `preview.js`: navigated exactly once, after a
        // freshly minted URL is confirmed. See the header.
        iframe_url: 'about:blank',
        is_fullpage: false,
        // An editor wants more room than the app-preview default — this is
        // the one number in this file with no contract behind it, unlike the
        // timeouts/tokens above; resize freely if it reads wrong on screen.
        width: 980,
        height: 680,
        is_resizable: true,
        show_maximize_button: true,
        stay_on_top: false,
        single_instance: true,
        show_in_taskbar: true,
        is_droppable: false,
        window_class: 'ezil-code-window',
        selectable_body: false,
    });

    if ( ! el_window ) {
        console.error(`[${PHASE}] UIWindow returned nothing`);
        telemetry.capture({
            eventClass: 'window_error', site: 'ezil-os:apps/code#open', code: 'uiwindow_returned_nothing',
        });
        return null;
    }

    const el_body = el_window.querySelector('.window-body');
    const el_iframe = el_window.querySelector('.window-app-iframe');
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

    // ── the "no field yet" panel — same reasoning as `preview.js`'s: "the
    // deployment does not support this" is a different, honest claim from any
    // BootProgress state, and blurring them would say something untrue. No
    // Retry: the next attempt fails identically until the deployment changes.
    const el_unavailable = document.createElement('div');
    // Styles live in `ezil-shell.css`, NOT inline: an inline `display` beats
    // the UA's `[hidden] { display: none }`, so `hidden = true` below would
    // hide nothing and this panel would paint over a working iframe forever.
    el_unavailable.className = 'ezil-code-unavailable';
    el_unavailable.hidden = true;
    el_unavailable.innerHTML = `
        <div style="font-size:15px;font-weight:600;">Code isn't available yet</div>
        <div style="font-size:13px;max-width:32em;opacity:0.75;">
            This computer's code editor hasn't been turned on for this deployment.
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

        // 🔴 THE MINT. Exactly once per genuine window-open — see the file
        // header for the three structural properties this depends on.
        console.info(`[${PHASE}] minting a code-preview URL for computer ${computer.id} (budget ${DESKTOP_BOOT_TIMEOUT_MS}ms)`);
        const res = await mintCodePreviewUrl(computer.id);

        if ( disposed || my_attempt !== attempt ) return;
        stop_timers();

        if ( ! res.ok ) {
            // `code_preview_unavailable` is the one code that means "this
            // deployment/container cannot serve code-server at all" — the
            // honest "not available" panel, not a failure to retry. Mirrors
            // `preview.js`'s `app_preview_unavailable` handling exactly.
            if ( res.errorCode === 'code_preview_unavailable' ) {
                console.warn(`[${PHASE}] this computer cannot serve code-server: ${res.errorCode}`);
                show_unavailable();
                return;
            }
            console.error(`[${PHASE}] code-preview mint failed after ${Math.round(performance.now() - t0)}ms: ${res.errorCode}`);
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: res.errorCode,
                durationMs: performance.now() - t0,
            });
            progress.render(computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            }));
            return;
        }

        // 🔴 DEGRADE HONESTLY, still — belt-and-braces over `mintCodePreviewUrl`
        // already refusing to report `ok` without a URL.
        const code_preview_url = res.url;
        if ( typeof code_preview_url !== 'string' || code_preview_url === '' ) {
            console.warn(`[${PHASE}] code-preview-url returned ok with no URL; code-server is not available`);
            show_unavailable();
            return;
        }

        console.info(`[${PHASE}] mint resolved in ${Math.round(performance.now() - t0)}ms`);
        progress.render(computeBootUiState({
            requestStatus: 'success',
            elapsedMs: 0,
            frameConfirmed: false,
        }));

        el_iframe.src = code_preview_url;
        settle_frame(my_attempt);
    }

    /**
     * The post-handoff frame confirmation. Byte-for-byte `preview.js`'s
     * `settle_frame`, targeted at the code-preview URL — see that file's
     * header for why the honesty gate itself is unchanged rather than
     * reimplemented, and `app-preview-frame-honesty.test.ts` for both
     * directions proven against a real HTTP bridge.
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
                console.warn(`[${PHASE}] gave up confirming the code frame after ${asks} tries`);
            }

            settled = true;

            if ( seen === true ) {
                progress.el.hidden = true;
                el_unavailable.hidden = true;
                console.info(`[${PHASE}] code frame confirmed by the server`);
                return;
            }

            console.error(`[${PHASE}] the code frame is not answering (confirmFrame -> ${String(seen)})`);
            telemetry.capture({
                eventClass: 'display_failure', site: 'ezil-os:apps/code#confirmFrame', code: 'frame_not_answering',
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

export default openCodeWindow;
