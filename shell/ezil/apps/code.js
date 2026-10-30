import { selectRuntimeAdapter, watchNativeSurface, editorFailureCopy } from '../native-runtime.js';
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
import { HEARTBEAT_INTERVAL_MS, isPresent, shouldHeartbeat } from '../activity-heartbeat.js';
import { watchRuntimeOnReturn } from '../runtime-recheck.js';
import { computeBootUiState, FRAME_CONFIRM_DEADLINE_MS } from '../boot-phases.js';
import AppSpinner from '../ui/app-spinner.js';
import { TRANSITION_EVENT, watchComputerTransition } from '../ui/computer-progress.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:code';

/** How often the UI re-derives its phase from elapsed time. */
const TICK_MS = 250;
/** How often the cheap status probe runs. It does NOT wake a container. */
const POLL_MS = 2_000;

/**
 * Probe early without depending on iframe load. With immediate unknown replies,
 * asks fall at 300, 900, 2100, 4000, 5500 and 7000 ms: retain the old late
 * retry window while adding three early opportunities. Requests are serial;
 * the existing handoff deadline also caps slow/in-flight replies.
 * Transport-unknown replies retain the Preview window's schedule. An observed
 * transient backend failure gets a longer recovery budget, under the same deadline.
 */
const FRAME_CONFIRM_DELAYS_MS = [300, 600, 1_200, 1_900, 1_500, 1_500];
const FRAME_CONFIRM_ATTEMPTS = FRAME_CONFIRM_DELAYS_MS.length;
const FRAME_RECOVERY_ATTEMPTS = 12;

/**
 * Round 6 (R3-1/R3-2, live 10-30 05:42-05:44Z): the mint gave up (its existing wake deadline) while the
 * computer was observed RUNNING with nothing opening. The generic `timeout` copy ("Starting your computer is
 * taking longer than it should") is false there: the computer is up and Code did not answer. Same Try again.
 */
const CODE_UNREACHABLE_COPY = {
    title: "Code isn't reachable right now",
    body: "Your computer is running, but Code didn't answer in time. It may still be starting up — try again.",
};

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
async function mintCodePreviewUrl (computerId, signal) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to preview.' };
    }
    // 🔴 THE WAKE LOOP AND THE ONE RETRY ARE SESSION.JS'S, NOT A COPY. This
    // window's own timeline is the one the regression was measured on
    // (`POST /api/shell/code-preview-url` at 12:40:57, dead at 12:44:05 after
    // 187505ms with `errorCode: unknown`; retry two seconds later resolved in
    // 5460ms). Re-implementing the loop here is how the two surfaces would
    // stop waiting for the same length of time — see `withWakeAndOneRetry`.
    //
    // 🔴 HOTFIX r5 (ACCEPT-11865d06 B6): and it is CANCELLABLE. Every ask runs the
    // server's ensure(), which starts a STOPPED computer; this loop used to keep
    // asking after its window closed (Stop closes it first) and re-provisioned the
    // computer 0.23 s after the stop. `signal` is the window's, aborted on close;
    // Stop also reaches it through `session.cancelComputerOpens`.
    return session.cancellableWake(computerId, 'codePreviewUrl', (s) => mintCodePreviewUrlOnce(computerId, s), { signal });
}

/** The request's signal: its timeout and, when given, the loop's cancel. */
function mintSignal (cancel) {
    const timeout = AbortSignal.timeout(DESKTOP_BOOT_TIMEOUT_MS);
    if ( ! cancel ) return timeout;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, cancel]) : timeout;
}

/** One `POST /api/shell/code-preview-url`. The loop that may call it more than once is above. */
async function mintCodePreviewUrlOnce (computerId, cancel) {
    const started = await session.ensureLocalDesktop(computerId);
    if ( ! started.ok ) return started;
    const endpoint = session.payload()?.desktopState?.endpoints?.codePreviewUrl
        ?? '/api/shell/code-preview-url';

    let res;
    try {
        res = await fetch(endpoint, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ computerId }),
            signal: mintSignal(cancel),
        });
    } catch ( err ) {
        // Same distinction session.js's `request()` makes: our own timeout
        // vs. a genuine transport failure vs. the caller's cancel.
        const timed_out = err && err.name === 'TimeoutError';
        if ( ! timed_out && cancel?.aborted ) return { ok: false, errorCode: 'cancelled', message: 'The request was cancelled.' };
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
        // 🔴 A 502/504 IS A CLASSIFIED FAILURE, NOT AN UNKNOWN ONE. Identical
        // defect, identical treatment, to the one fixed in
        // `session.js#openDesktopOnce` — see the long note there. This route
        // handler is the same `shellErrorResponse` shape, so tRPC's own
        // `BAD_GATEWAY` / `GATEWAY_TIMEOUT` arrives here verbatim in
        // `data.error.code` and used to be flattened to `unknown`, which
        // `classifyFailure` renders with the generic "if it keeps happening,
        // let us know" copy. `fetch_failed` is the `BootErrorCode` that maps to
        // `worker_unreachable` — what actually happened, and something the user
        // can act on. The HTTP status is checked as well as the body code
        // because a gateway can answer 502 with no JSON body at all, in which
        // case `data` is `null` and the body code is the thing that is missing.
        if ( code === 'BAD_GATEWAY' || code === 'GATEWAY_TIMEOUT'
             || res.status === 502 || res.status === 504 ) {
            return { ok: false, errorCode: 'fetch_failed', message: data?.error?.message };
        }
        return { ok: false, errorCode: 'unknown', message: data?.error?.message ?? 'Something went wrong.' };
    }

    if ( data?.ok !== true ) return session.pendingOrRefused(data);
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
    // `registry.js#launch` hands this in when it opened the trace for THIS
    // app-open (`owns_boot_trace: true` on the `code` descriptor) — see that
    // file's own doc on the flag, and `preview.js`'s identical seam.
    // Defaulted so this function stays callable without a registry launch.
    // `.end()` is idempotent, so calling it from more than one terminal
    // point is safe.
    const trace = ctx.trace ?? { step () {}, end () {} };
    const computer = ctx.computer ?? ctx.payload?.computer ?? null;
    const desktop_state = ctx.desktopState ?? ctx.payload?.desktopState ?? {};
    const nativeSurface = selectRuntimeAdapter(ctx)?.surface('code');
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
    /** The current attempt's mint loop: aborted by the next attempt and by close (hotfix r5). */
    let mint_ctl = null;
    /** RETRY-118: the failure on screen, for an explicit user Retry only (`session.userRetry`). */
    let last_failure = null;
    /** Stable per window, so `session.userRetry` reopens THIS window exactly once. */
    const reopen_after_retry = () => { if ( ! disposed ) void start_boot(); };
    let stop_monitor = () => {};
    let stop_confirmation = () => {};
    /**
     * Round 6 (R3-1/R3-2): this attempt's last computer.progress answer. A hidden tab or a failed poll
     * clears the spinner's live answer, so the mint's give-up decides from this one, never from that alone.
     */
    let last_progress = null;
    /** The mint's timeout give-up while it is on screen with the generic copy (no running answer yet). */
    let generic_timeout = null;
    /** A timeout give-up over a computer last seen running with nothing opening is Code's, not the computer's. */
    const code_timeout = failed => last_progress?.connect === true ? { ...failed, copy: CODE_UNREACHABLE_COPY } : failed;

    const stop_timers = () => {
        stop_confirmation(); stop_confirmation = () => {};
        stop_monitor(); stop_monitor = () => {};
        clearInterval(tick_timer); tick_timer = null;
        clearInterval(poll_timer); poll_timer = null;
    };

    const nativeFailureCopy = nativeSurface ? editorFailureCopy() : undefined;
    const progress = AppSpinner({ computerId: nativeSurface ? undefined : computer.id, label: 'Opening Code…', icon: ctx.icon, isMigrating: () => session.isComputeMigrating(computer.id),
        isLaunching: () => session.isComputeLaunching(computer.id),
        onRetry: () => { void session.userRetry(computer.id, last_failure, reopen_after_retry); }, failureCopy: nativeFailureCopy,
        onProgressChange: () => {
            const seen = progress.computerProgress();
            if ( ! seen ) return;
            last_progress = seen;
            // A give-up painted before any running answer (tab hidden, polls failing) takes Code's words once one arrives.
            if ( generic_timeout && seen.connect === true ) { progress.render(code_timeout(generic_timeout)); generic_timeout = null; }
        } });
    el_body.appendChild(progress.el);

    // ── the "editor is not reachable" panel ──────────────────────────────
    //
    // 🔴 REWRITTEN 2026-08-22, and the old copy was WRONG IN THE FIELD. It
    // read "This computer's code editor hasn't been turned on for this
    // deployment", with no Retry, on the reasoning that "the next attempt
    // fails identically until the deployment changes".
    //
    // That reasoning does not hold, because `code_preview_unavailable` is not
    // a statement about configuration. All three of its producers
    // (`cloudflare-guacamole.ts`) are RUNTIME conditions: the code-preview
    // port could not be exposed, the Worker reports it is not exposed, or the
    // origin could not be derived. Every one of them is true of a container
    // whose code-server has just crashed or is still coming up, and every one
    // of them can stop being true a second later.
    //
    // A user hit exactly this: they installed an extension, the editor died,
    // and on refresh the OS told them the editor had never been turned on for
    // their deployment. That is a false statement about their account
    // presented as a settled fact, and it sent them looking for a
    // configuration problem that did not exist.
    //
    // So the copy now says only what is actually known — the editor is not
    // reachable right now — and there IS a Retry, because the most common
    // cause is transient.
    const el_unavailable = document.createElement('div');
    // Styles live in `ezil-shell.css`, NOT inline: an inline `display` beats
    // the UA's `[hidden] { display: none }`, so `hidden = true` below would
    // hide nothing and this panel would paint over a working iframe forever.
    el_unavailable.className = 'ezil-code-unavailable';
    el_unavailable.hidden = true;
    el_unavailable.innerHTML = `
        <div style="font-size:15px;font-weight:600;">Code isn't reachable right now</div>
        <div style="font-size:13px;max-width:34em;opacity:0.75;">
            The code editor on this computer isn't answering. It may still be
            starting up, or it may have stopped — installing an extension can
            restart it. The full desktop keeps running in its own window.
        </div>`;
    // A real Retry. `start_boot` re-mints from scratch and is already
    // re-entrant (`my_attempt !== attempt` guards every await in it), which is
    // the same contract `AppSpinner`'s own onRetry relies on.
    const el_retry = document.createElement('button');
    el_retry.type = 'button';
    el_retry.className = 'ezil-code-unavailable-retry';
    el_retry.textContent = 'Try again';
    el_retry.addEventListener('click', () => { void start_boot(); });
    el_unavailable.appendChild(el_retry);
    el_body.appendChild(el_unavailable);

    const show_panel = () => { progress.el.hidden = false; el_unavailable.hidden = true; };
    const show_unavailable = () => { progress.el.hidden = true; el_unavailable.hidden = false; };

    async function start_boot () {
        last_failure = null;
        last_progress = null; generic_timeout = null;
        if ( disposed ) return;
        const my_attempt = ++attempt;
        stop_timers();
        show_panel();
        running_signal = undefined;

        if ( desktop_state.configured !== true ) {
            console.warn(`[${PHASE}] no desktop provider is configured`);
            progress.render(computeBootUiState({ requestStatus: 'not_configured', elapsedMs: 0 }));
            // Terminal: no provider means no mint will ever be attempted.
            // `'skipped'`, not `'error'` — an honest, known deployment
            // state, not a failure this boot attempted and lost.
            trace.step('not_configured');
            trace.end('skipped');
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

        if (!nativeSurface) poll_timer = setInterval(async () => {
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
        mint_ctl?.abort();
        mint_ctl = new AbortController();
        const res = await (nativeSurface ? nativeSurface.open(ctx.previewPort) : mintCodePreviewUrl(computer.id, mint_ctl.signal));

        if ( disposed || my_attempt !== attempt ) return;
        stop_timers();

        if ( ! res.ok ) {
            last_failure = res;
            if (nativeFailureCopy) Object.assign(nativeFailureCopy, editorFailureCopy(res.errorCode));
            // `code_preview_unavailable` is the one code that means "this
            // deployment/container cannot serve code-server at all" — the
            // honest "not available" panel, not a failure to retry. Mirrors
            // `preview.js`'s `app_preview_unavailable` handling exactly.
            if ( res.errorCode === 'code_preview_unavailable' ) {
                console.warn(`[${PHASE}] this computer cannot serve code-server: ${res.errorCode}`);
                show_unavailable();
                // Terminal: an honest, known "this deployment does not
                // support it" state, not a failure this boot attempted and
                // lost.
                trace.step('mint_unavailable');
                trace.end('skipped');
                return;
            }
            console.error(`[${PHASE}] code-preview mint failed after ${Math.round(performance.now() - t0)}ms: ${res.errorCode}`);
            telemetry.capture({
                eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: res.errorCode,
                durationMs: performance.now() - t0,
            });
            const failed = computeBootUiState({
                requestStatus: 'error',
                elapsedMs: performance.now() - t0,
                errorCode: res.errorCode,
            });
            // A give-up over a computer last seen running (and opening nothing) is Code's, not the computer's.
            const timed_out = failed.kind === 'failed' && failed.reason === 'timeout';
            const shown = timed_out ? code_timeout(failed) : failed;
            generic_timeout = timed_out && ! shown.copy ? failed : null;
            progress.render(shown);
            // Terminal: the mint failed for real.
            trace.step('mint_error');
            trace.end('error');
            return;
        }

        // 🔴 DEGRADE HONESTLY, still — belt-and-braces over `mintCodePreviewUrl`
        // already refusing to report `ok` without a URL.
        const code_preview_url = res.url;
        if ( typeof code_preview_url !== 'string' || code_preview_url === '' ) {
            console.warn(`[${PHASE}] code-preview-url returned ok with no URL; code-server is not available`);
            show_unavailable();
            // Terminal, and `'error'` rather than `'skipped'`:
            // `mintCodePreviewUrl` violating its own "never `ok` without a
            // URL" contract, not an honest "not configured" answer.
            trace.step('mint_url_missing');
            trace.end('error');
            return;
        }

        console.info(`[${PHASE}] mint resolved in ${Math.round(performance.now() - t0)}ms`);
        trace.step('mint_ok');

        // 🔴 THE HANDOFF IS NOT A VERDICT. This used to pass
        // `frameConfirmed: false`, which `computeBootUiState` read as "asked
        // and refuted" and rendered as the terminal "Your desktop isn't
        // answering" panel — over a window that was working. Nobody had asked
        // anything yet: `settle_frame` below is what asks, and measured, it
        // answers about six seconds later. The flag is now OMITTED, which is
        // the input that means "no observation exists", and the panel shows
        // the `connecting` phase until there is one. The boot still ends on
        // its own: `FRAME_CONFIRM_DEADLINE_MS` is measured from `t_handoff`.
        // The open answered with a URL: a real signal, so the one bar takes the
        // opening-app floor (never 100 before the frame is confirmed).
        progress.stamp('url_received');
        const t_handoff = performance.now();
        const paint_handoff = () => {
            if ( disposed || my_attempt !== attempt ) return;
            progress.render(computeBootUiState({
                requestStatus: 'success',
                elapsedMs: performance.now() - t_handoff,
            }));
        };
        paint_handoff();
        tick_timer = setInterval(paint_handoff, TICK_MS);

        el_iframe.src = code_preview_url;
        trace.step('frame_nav');
        settle_frame(my_attempt);
    }

    /** Confirm Code's HTTP route, recovering transient startup failures before the deadline. */
    function settle_frame (my_attempt) {
        let settled = false;
        let in_flight = false;
        let asks = 0;
        let recovering = false;
        let needs_reload = false;
        let awaiting_reload = false;
        let probe_timer = null;
        let deadline_timer = null;
        // The last answer, so a failure (including the deadline) names the hop that answered.
        let last_observation = null;
        const frame_url = el_iframe.src;
        const stale = () => settled || disposed || my_attempt !== attempt;
        stop_confirmation = () => {
            settled = true;
            clearTimeout(probe_timer);
            clearTimeout(deadline_timer);
            el_iframe.removeEventListener('load', on_load);
        };

        const finish = (seen) => {
            if ( stale() ) return;
            settled = true;
            // Either way the handoff clock has done its job — stop repainting
            // it before writing a settled state, or the next tick overwrites
            // the answer with the progress panel again.
            stop_timers();

            if ( seen === true ) {
                // The real ready signal concludes this open on the one surface (bar to 100), so a
                // later start_boot (restart, switch, reboot) is a fresh open with its own clock.
                progress.render(computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: true }));
                progress.el.hidden = true;
                el_unavailable.hidden = true;
                stop_monitor = watchNativeSurface(nativeSurface, reason => {
                    if (disposed || my_attempt !== attempt) return;
                    if (nativeFailureCopy) Object.assign(nativeFailureCopy, editorFailureCopy(reason || 'editor_connection_lost'));
                    show_panel();
                    progress.render(computeBootUiState({ requestStatus: 'success', elapsedMs: 0, frameConfirmed: false }));
                });
                console.info(`[${PHASE}] code frame confirmed by the server`);
                // Terminal: a confirmed frame IS the whole verdict for this
                // window — there is no separate display gate here.
                trace.step('confirm_ok');
                trace.end('ok');
                return;
            }

            const reason = last_observation?.reason;
            const status = last_observation?.status;
            // The console line keeps its exact text (browser suites allow-list it); the
            // reason and origin status travel in the telemetry attrs below.
            console.error(`[${PHASE}] the code frame is not answering (confirmFrame -> ${String(seen)})`);
            // `status` is only ever the ORIGIN's (the probe's `data.status`); our own route's
            // refusal is `reason: 'route_refused'` with no status.
            telemetry.capture({
                eventClass: 'display_failure', site: 'ezil-os:apps/code#confirmFrame', code: 'frame_not_answering',
                attrs: { seen: String(seen), ...(reason ? { reason } : {}), ...(Number.isInteger(status) ? { status } : {}) },
            });
            show_panel();
            // A terminal refusal or an exhausted confirmation/recovery budget.
            progress.render(computeBootUiState({
                requestStatus: 'success',
                elapsedMs: 0,
                frameConfirmed: false,
            }));
            // Terminal: the frame never confirmed.
            trace.step('confirm_error');
            trace.end('error');
        };

        const ask = async () => {
            if ( stale() || in_flight || awaiting_reload ) return;
            clearTimeout(probe_timer);
            in_flight = true;
            asks++;
            // Keep the exported trace short enough to retain confirm_ok.
            if ( asks === 1 ) trace.step('confirm_ask');
            // Keep the authenticated server/native gate. A load event cannot
            // prove readiness, and HTTP confirmation is not an editor-ready
            // message: the hosted frame exposes no such signal to this shell.
            const observation = nativeSurface
                ? { confirmed: await nativeSurface.confirm(), retryable: false }
                : await session.observeFrame(computer.id, frame_url, 'code');
            const seen = observation.confirmed;
            in_flight = false;
            if ( stale() ) return;
            last_observation = observation;
            // Never apply a positive verdict to a replaced frame URL.
            if ( el_iframe.src !== frame_url ) { last_observation = { reason: 'frame_replaced' }; finish(false); return; }
            if ( observation.retryable ) {
                recovering = true;
                needs_reload = true;
            }
            const max_asks = recovering ? FRAME_RECOVERY_ATTEMPTS : FRAME_CONFIRM_ATTEMPTS;
            if ( seen === true && needs_reload ) {
                // The iframe may still contain the earlier 502 document. Replace
                // it only after the backend answers, then wait for that navigation
                // and a fresh authenticated probe. Neither load nor health alone
                // can reveal the old error page. Reloads share the fixed ask cap.
                if ( asks >= max_asks ) { finish(undefined); return; }
                needs_reload = false;
                awaiting_reload = true;
                el_iframe.src = frame_url;
                trace.step('frame_recover');
                return;
            }
            if ( (seen === undefined || observation.retryable) && asks < max_asks ) {
                const delay = recovering ? Math.min(500 * 2 ** (asks - 1), 5_000) : FRAME_CONFIRM_DELAYS_MS[asks];
                probe_timer = setTimeout(() => { void ask(); }, delay);
                return;
            }
            if ( seen === undefined ) console.warn(`[${PHASE}] gave up confirming the code frame after ${asks} tries`);
            finish(seen);
        };
        const on_load = () => {
            trace.step('frame_load');
            // Load can accelerate the first probe, but must not race an
            // in-flight request or defeat the retry spacing/count bound.
            if ( awaiting_reload ) {
                awaiting_reload = false;
                void ask();
            } else if ( asks === 0 ) void ask();
        };
        el_iframe.addEventListener('load', on_load);
        probe_timer = setTimeout(() => { void ask(); }, FRAME_CONFIRM_DELAYS_MS[0]);
        deadline_timer = setTimeout(() => {
            trace.step('confirm_timeout');
            finish(undefined);
        }, FRAME_CONFIRM_DEADLINE_MS);
    }

    // ── Presence heartbeat: activity belongs to the COMPUTER ─────────────────
    // Until 2026-10-04 only the desktop window reported presence, so someone
    // working only in Code was idle-stopped after `IDLE_STOP_MS` and the editor
    // fell onto 410 STALE_PREVIEW_URL. Same rule as `desktop-window.js`
    // (`activity-heartbeat.js`): beat while visible and present, stop when the
    // tab is hidden or nobody is there; never seeded from open time, so it can
    // never keep an abandoned computer alive. Hosted only: a local editor has
    // no container to keep warm.
    let last_present_at = null;
    let was_present = false;
    const sample_presence = () => {
        const present = isPresent({
            visibilityState: document.visibilityState,
            hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
        });
        if ( present || was_present ) last_present_at = performance.now();
        was_present = present;
    };
    const heartbeat_tick = () => {
        if ( disposed ) return;
        sample_presence();
        const lastPresenceAgoMs = last_present_at === null ? NaN : performance.now() - last_present_at;
        if ( ! shouldHeartbeat({ visible: document.visibilityState === 'visible', lastPresenceAgoMs }) ) return;
        void session.reportActivity(computer.id, Math.round(lastPresenceAgoMs));
    };
    const heartbeat_timer = nativeSurface || ! computer?.id ? null : setInterval(heartbeat_tick, HEARTBEAT_INTERVAL_MS);
    if ( heartbeat_timer !== null ) {
        window.addEventListener('focus', sample_presence);
        window.addEventListener('blur', sample_presence);
        document.addEventListener('visibilitychange', sample_presence);
        sample_presence();
    }
    // Back after an absence long enough for an idle-stop: re-check before the
    // stale frame is used (`../runtime-recheck.js`).
    const stop_runtime_recheck = heartbeat_timer === null ? null : watchRuntimeOnReturn({
        computerId: computer.id,
        isLive: () => !! el_iframe.getAttribute('src'),
        reboot: () => { void start_boot(); },
        desktopRunning: (id) => session.desktopRunning(id),
    });

    // Restart desktop (Settings → Troubleshoot) restarts code-server too on an AWS host, and the
    // open frame then shows "Cannot reconnect". Re-mint for the same computer (live 2026-10-22).
    const on_restarted = (e) => { if ( ! disposed && e?.detail?.computerId === computer.id ) void start_boot(); };
    // A switch or a computer restart replaces the machine; re-mint once the server settles it (round 3).
    let transition_watch = null;
    const on_transition = (e) => {
        if ( disposed || nativeSurface || e?.detail?.computerId !== computer.id || transition_watch?.active() ) return;
        transition_watch = watchComputerTransition({
            computerId: computer.id, element: el_window,
            transitionId: typeof e.detail.transitionId === 'string' ? e.detail.transitionId : null,
            onSettled: () => { transition_watch = null; if ( ! disposed ) void start_boot(); },
        });
    };

    const dispose = () => {
        progress.dispose();
        if (disposed) return;
        disposed = true;
        // A closed window stops asking: no ask after close can reach ensure() (hotfix r5).
        mint_ctl?.abort();
        window.removeEventListener('ezil:desktop-restarted', on_restarted);
        window.removeEventListener(TRANSITION_EVENT, on_transition);
        transition_watch?.stop();
        nativeSurface?.dispose();
        stop_timers();
        stop_runtime_recheck?.();
        if ( heartbeat_timer !== null ) {
            clearInterval(heartbeat_timer);
            window.removeEventListener('focus', sample_presence);
            window.removeEventListener('blur', sample_presence);
            document.removeEventListener('visibilitychange', sample_presence);
        }
        window.removeEventListener('ezil:teardown', dispose);
        // The window can close mid-boot before any terminal point above ever
        // fires. Without this the trace would sit open until `registry.js`'s
        // bounded fallback finally closes it as `'unknown'`. `'skipped'`:
        // abandoned, not failed and not completed. No-op if a terminal point
        // already ended it (`trace.step`/`trace.end` are idempotent).
        trace.step('disposed');
        trace.end('skipped');
    };

    el_window.on_before_exit = async () => {
        dispose();
        return true;
    };
    window.addEventListener('ezil:teardown', dispose);
    window.addEventListener('ezil:desktop-restarted', on_restarted);
    window.addEventListener(TRANSITION_EVENT, on_transition);

    void start_boot();
    return el_window;
}

export default openCodeWindow;
