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
//
// ── Full view, its strip, and the stopped/reconnecting state ────────────────
// ADDED 2026-10-30 (app-code lane A2). See `docs/APP-CODE-FULL-VIEW.md`.
//   - Full view is the Browser's full-bleed, shared through
//     `../ui/full-view.js`: no taskbar, no head, the window at the viewport.
//     The green button, a title double-click and the head's context menu
//     toggle it (`_ezil_maximise`); "restore" goes back to the bounds the
//     window had. A launch with `ctx.view === 'full'` (the `/app/code` route)
//     opens in it; a launch with no view opens windowed 980x680 unless the
//     user's last explicit choice in this tab was full (`VIEW_STORAGE_KEY`).
//     Never the browser Fullscreen API.
//   - In full view a compact dark strip replaces the head. It holds two
//     things: the control drawer's grab notch, centred, and the small
//     Feedback icon in its top-right corner. The title, Show desktop,
//     Restore window and Close live in the notch's expanded tray (gate G3,
//     2026-10-31; until then a top bar carried its own title and buttons).
//   - The shell never calls a history API from here. Each change of view is
//     announced as `ezil:app-view-changed` for the router to record.
//   - When the shell sees the computer go away (a restart/switch transition,
//     or the return-from-away check finding it stopped) the frame is covered
//     by an OS state — "Reconnecting…" or "Computer stopped" — instead of
//     leaving code-server's own reconnect dialog, which this cross-origin
//     shell cannot see, on screen. Coming back re-mints through
//     `start_boot()`, the same path as every other open.

import session, { DESKTOP_BOOT_TIMEOUT_MS } from '../session.js';
import telemetry from '../telemetry.js';
import { failureFields } from '../failure-diagnostics.js';
import { HEARTBEAT_INTERVAL_MS, isPresent, shouldHeartbeat } from '../activity-heartbeat.js';
import { watchRuntimeOnReturn } from '../runtime-recheck.js';
import { computeBootUiState, FRAME_CONFIRM_DEADLINE_MS } from '../boot-phases.js';
import AppSpinner from '../ui/app-spinner.js';
import { TRANSITION_EVENT, watchComputerTransition } from '../ui/computer-progress.js';
import attach_app_drawer from '../ui/app-drawer.js';
import { createFullView } from '../ui/full-view.js';
import UIWindow from '../../src/UI/UIWindow.js';

const PHASE = 'ezil-os:code';

/**
 * sessionStorage: the user's last EXPLICIT view choice for Code in this tab
 * (`'full'` | `'window'`) — written only by a gesture (green button, title
 * double-click, context menu, the drawer's restore, a double-click on the
 * strip), never by a route-driven launch or relaunch. Read only when a launch
 * names no view.
 */
export const VIEW_STORAGE_KEY = 'ezil-os:view.code';
/** Window event announcing a change of view; the router records it (contract item 5). */
export const VIEW_EVENT = 'ezil:app-view-changed';
/** How often the "Computer stopped" state asks the cheap status probe whether the computer is back. */
const STOPPED_POLL_MS = 10_000;
/** How often "Reconnecting…" checks that its transition watch has not given up (the watch polls every 5s). */
const TRANSITION_GUARD_MS = 5_000;

function remembered_view () {
    try { return sessionStorage.getItem(VIEW_STORAGE_KEY) === 'full' ? 'full' : 'window'; } catch { return 'window'; }
}
function remember_view (view) {
    try { sessionStorage.setItem(VIEW_STORAGE_KEY, view); } catch { /* the choice still applies to this window */ }
}

const MINIMISE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"'
    + ' stroke-linecap="round" aria-hidden="true"><line x1="6" y1="12" x2="18" y2="12"/></svg>';
const RESTORE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"'
    + ' stroke-linejoin="round" aria-hidden="true"><rect x="5" y="8" width="11" height="11" rx="1.5"/>'
    + '<path d="M9 8V5.5A.5.5 0 0 1 9.5 5H18.5a.5.5 0 0 1 .5.5V14.5a.5.5 0 0 1-.5.5H16"/></svg>';

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
            // Phase B r9 (REVERSE-MOVE-CONTRACT §5.9, opt-in trigger): opening Code is a real open of the computer, and
            // only an ask that says so may start moving a held computer's files. An older server ignores the field.
            body: JSON.stringify({ computerId, intent: 'open' }),
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
        // FEEDBACK-DIAG: keep the server's validated `reason`/`correlationId` on every branch.
        const diagnostics = failureFields(data?.error);
        if ( code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: data?.error?.message, ...diagnostics };
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
            return { ok: false, errorCode: 'fetch_failed', message: data?.error?.message, ...diagnostics };
        }
        return { ok: false, errorCode: 'unknown', message: data?.error?.message ?? 'Something went wrong.', ...diagnostics };
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
 * @param {'full'|'window'} [ctx.view] How to open (the `/app/code` route passes
 *   `'full'`). Absent or anything else: windowed, unless the user's last
 *   explicit choice in this tab was full (`VIEW_STORAGE_KEY`).
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
        // It is also the WINDOWED size: full view (below) is entered after
        // creation, so leaving it restores this box (or wherever the user
        // moved it), never a guess.
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
        // Round 6 (seam C): the first Code open after the computer starts waits for its config to apply.
        isPreparing: () => session.isComputePreparing(computer.id),
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

    // ── the "Reconnecting…" / "Computer stopped" state (lane A2) ─────────
    // An OS-level cover over the frame for the moments the shell KNOWS the
    // computer is not there: a restart/switch transition in flight, or the
    // return-from-away check finding it stopped. Without it the frame keeps
    // code-server's own "Attempting to reconnect" dialog, which lives inside
    // the cross-origin iframe where this shell can neither see nor replace it.
    // Retired by `show_panel()`, i.e. by every `start_boot()`. Styled in
    // `ezil-shell.css` and hidden with `hidden` — no inline `display`, for the
    // reason documented on `el_unavailable` above.
    //
    // "Start computer" is `start_boot()` on an explicit click: the same mint
    // (`mintCodePreviewUrl` -> `session.cancellableWake`, which the server's
    // ensure() uses to start a stopped computer, and which Stop can cancel via
    // `session.cancelComputerOpens`) that "Try again" already runs. Nothing
    // here starts a computer on its own.
    const el_state = document.createElement('div');
    el_state.className = 'ezil-code-state';
    el_state.hidden = true;
    el_state.setAttribute('role', 'status');
    el_state.setAttribute('aria-live', 'polite');
    const el_state_title = document.createElement('div');
    el_state_title.className = 'ezil-code-state-title';
    const el_state_body = document.createElement('div');
    el_state_body.className = 'ezil-code-state-body';
    const el_state_start = document.createElement('button');
    el_state_start.type = 'button';
    el_state_start.className = 'ezil-code-state-start';
    el_state_start.textContent = 'Start computer';
    el_state_start.addEventListener('click', () => { void start_boot(); });
    el_state.append(el_state_title, el_state_body, el_state_start);
    el_body.appendChild(el_state);

    const STATE_COPY = {
        reconnecting: ['Reconnecting…', 'Your computer is restarting or switching configuration. Code reopens here when it is back. Your files are safe.'],
        stopped: ['Computer stopped', "Your computer isn't running, so Code can't reach it. Your files are safe."],
    };
    /** The cheap status probe while "Computer stopped" is up: never wakes anything. */
    let stopped_timer = null;
    let stopped_asking = false;
    const hide_state = () => {
        clearInterval(stopped_timer); stopped_timer = null;
        el_state.hidden = true;
        delete el_state.dataset.state;
    };
    const show_state = (kind) => {
        if ( disposed ) return;
        hide_state();
        [el_state_title.textContent, el_state_body.textContent] = STATE_COPY[kind];
        el_state.dataset.state = kind;
        el_state_start.hidden = kind !== 'stopped';
        el_state.hidden = false;
        if ( kind !== 'stopped' ) return;
        // Back to running by any other route (the Browser opened it, another
        // tab started it): re-mint the same Code URL through `start_boot()`.
        // Only the cheap probe, only while the tab is visible.
        stopped_timer = setInterval(async () => {
            if ( disposed || stopped_asking || document.visibilityState !== 'visible' ) return;
            stopped_asking = true;
            try {
                const running = await session.desktopRunning(computer.id);
                if ( ! disposed && el_state.dataset.state === 'stopped' && running === true ) void start_boot();
            } finally {
                stopped_asking = false;
            }
        }, STOPPED_POLL_MS);
    };

    const show_panel = () => { hide_state(); progress.el.hidden = false; el_unavailable.hidden = true; };
    const show_unavailable = () => { hide_state(); progress.el.hidden = true; el_unavailable.hidden = false; };

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
                // FEEDBACK-DIAG: the server's reason and log-line id, for a feedback report.
                session.captureUnavailable('ezil-os:apps/code#mint', res);
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
                // FEEDBACK-DIAG: into the local mirror only (`diagnostics.js`).
                reason: res.reason, serverCorrelationId: res.correlationId,
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
    //
    // MODIFIED 2026-10-30 (lane A2): a computer found STOPPED is no longer
    // started again by THIS window just because the tab regained focus. It
    // used to `start_boot()` here, and that mint's ensure() starts a stopped
    // computer — including one its owner stopped from another tab or device.
    // Now the frame is covered by "Computer stopped" with an explicit Start,
    // and the state re-mints on its own as soon as the computer is running
    // again (see `show_state`). This is Code's rule only: the Browser window's
    // own return check (`desktop-window.js`, unchanged) still `start_boot()`s,
    // so with the Browser open the computer still starts on return and this
    // cover then re-mints by itself. Pending owner sign-off
    // (docs/APP-CODE-FULL-VIEW.md §4); the revert is `void start_boot()` here.
    const stop_runtime_recheck = heartbeat_timer === null ? null : watchRuntimeOnReturn({
        computerId: computer.id,
        isLive: () => !! el_iframe.getAttribute('src'),
        reboot: () => { show_state('stopped'); },
        desktopRunning: (id) => session.desktopRunning(id),
    });

    // A completed desktop restart restarts code-server too on an AWS host, and
    // the open frame then shows "Cannot reconnect". Re-mint for the same
    // computer (live 2026-10-22). Its Settings → Troubleshoot sender was
    // removed on 2026-10-30 (lane A2); the listener stays for any caller of the
    // kept `session.restartDesktop`.
    const on_restarted = (e) => { if ( ! disposed && e?.detail?.computerId === computer.id ) void start_boot(); };
    // A switch or a computer restart replaces the machine; re-mint once the server settles it (round 3).
    // While it is in flight the frame is covered by "Reconnecting…" (lane A2).
    let transition_watch = null;
    /**
     * 🔴 The watch can also end WITHOUT settling: `watchComputerTransition`
     * gives up after its poll budget (~16 min) and never calls `onSettled`.
     * Without this the opaque "Reconnecting…" cover would then stay up for
     * good with nothing to press. So once the watch is no longer active and
     * nothing re-minted, the cover becomes "Computer stopped": its Start, and
     * its own probe that re-mints as soon as the computer is running.
     */
    let transition_guard = null;
    const on_transition = (e) => {
        if ( disposed || nativeSurface || e?.detail?.computerId !== computer.id || transition_watch?.active() ) return;
        transition_watch = watchComputerTransition({
            computerId: computer.id, element: el_window,
            transitionId: typeof e.detail.transitionId === 'string' ? e.detail.transitionId : null,
            onSettled: () => {
                transition_watch = null;
                clearInterval(transition_guard); transition_guard = null;
                if ( ! disposed ) void start_boot();
            },
        });
        show_state('reconnecting');
        clearInterval(transition_guard);
        transition_guard = setInterval(() => {
            if ( disposed || transition_watch?.active() ) return;
            clearInterval(transition_guard); transition_guard = null;
            transition_watch = null;
            if ( el_state.dataset.state === 'reconnecting' ) show_state('stopped');
        }, TRANSITION_GUARD_MS);
    };

    // ── full view and its strip (lane A2; gate G3) ───────────────────────
    // The mechanism is `../ui/full-view.js`, shared with the Browser. What is
    // Code's own: the view is a TOGGLE (the Browser's expand only enters), it
    // is chosen at launch (`ctx.view`, else the remembered choice), and the
    // chrome full view hides is replaced by a compact strip whose only
    // controls are the drawer's centred grab notch and the Feedback icon.
    // Visual values are provisional — see `docs/APP-CODE-FULL-VIEW.md` §3.
    const full_view = createFullView(el_window);

    // The control drawer: the Browser's tray, centred in the strip as the
    // Browser's is. Its expanded tray carries the title and every window
    // action. "Show desktop" is the one minimise: until G3 the top bar also
    // had a "Minimise" that called the same `full_view.minimise()`.
    // Hidden while windowed (`.ezil-full-view-host:not(.ezil-fullbleed)`).
    const drawer = attach_app_drawer(el_window, {
        title,
        icon: ctx.icon,
        flash_on_attach: false,
        actions: [
            { id: 'minimize', label: 'Show desktop', svg: MINIMISE_SVG, onClick: () => { full_view.minimise(); } },
            { id: 'restore', label: 'Restore window', svg: RESTORE_SVG, onClick: () => { set_view('window', { remember: true }); } },
        ],
    });

    // The strip itself: an empty, presentational band (the window's own dark
    // background shows through it) that keeps the head's two mouse gestures.
    // Nothing in it is focusable or announced; the notch is the controls.
    const el_bar = document.createElement('div');
    el_bar.className = 'ezil-full-view-bar';
    el_bar.setAttribute('aria-hidden', 'true');
    // Double-clicking the strip is the head's double-click: back to a window.
    el_bar.addEventListener('dblclick', () => { set_view('window', { remember: true }); });
    // Pressing the strip activates the window, as pressing a head would (the
    // iframe only takes pointer events in an active window). Same latch as the
    // drawer's: `pointerdown` then its synthesized `mousedown` focus once.
    let bar_press_pending = false;
    el_bar.addEventListener('pointerdown', () => { bar_press_pending = true; setTimeout(() => $(el_window).focusWindow(), 0); });
    el_bar.addEventListener('mousedown', () => {
        if ( bar_press_pending ) { bar_press_pending = false; return; }
        setTimeout(() => $(el_window).focusWindow(), 0);
    });
    // DOM order is tab order: the drawer (its toggle, then the tray's
    // buttons), then the editor. The strip has nothing to focus.
    el_window.insertBefore(el_bar, el_body);
    if ( drawer ) el_window.insertBefore(drawer, el_bar);
    if ( ! drawer ) {
        // 🔴 Full view hides the taskbar and the head: no drawer, no entry.
        // The window keeps upstream's maximise (no hook is installed below).
        console.error(`[${PHASE}] control drawer did not attach — Code will stay windowed`);
        telemetry.capture({ eventClass: 'window_error', site: 'ezil-os:apps/code#drawer', code: 'drawer_attach_failed' });
        full_view.forbid();
    }

    /**
     * The window's title everywhere it is shown — the head and the drawer's
     * tray — as TEXT (`textContent`), never markup. A later lane names the
     * project/repo here. Empty input falls back to the app's name.
     */
    const set_title = (text) => {
        const t = String(text ?? '').trim() || title;
        const el_head_title = el_window.querySelector(':scope > .window-head .window-head-title');
        if ( el_head_title ) el_head_title.textContent = t;
        const el_drawer_title = drawer?.querySelector('.dashboard-app-drawer-title');
        if ( el_drawer_title ) el_drawer_title.textContent = t;
    };
    set_title(title);
    el_window._ezil_set_title = set_title;

    /** The view the router was last told about. The open itself is not announced. */
    let view_now = 'window';
    const current_view = () => (full_view.allowed && full_view.wants ? 'full' : 'window');
    // Read by the router (`../app-history.js`) each time it writes an entry
    // for this window: the view NOW, from the full-view state, not the last
    // one announced. 'full' while minimised from full view (it still wants it).
    el_window._ezil_view = current_view;
    /**
     * Apply a view. `remember` only for a user's gesture. Announces
     * `ezil:app-view-changed` when the view actually changes — never at open:
     * the router launches, THEN pushes its entry, and an event fired inside
     * the launch would be recorded on the entry being left.
     */
    function set_view (view, { remember = false } = {}) {
        if ( disposed ) return;
        if ( view === 'full' ) full_view.enter(); else full_view.exit();
        if ( remember ) remember_view(view);
        const next = current_view();
        if ( next === view_now ) return;
        view_now = next;
        window.dispatchEvent(new CustomEvent(VIEW_EVENT, { detail: { appId: 'code', view: next } }));
    }

    if ( full_view.allowed ) {
        // The green button, a head double-click and the head's context-menu
        // Maximize all reach `scale_window`, which hands the whole job to this.
        el_window._ezil_maximise = () => {
            set_view(full_view.is_full() ? 'window' : 'full', { remember: true });
        };
    }
    // Deliberately NO `_ezil_minimise` hook (the Browser has one). Its only
    // callers, the head's minimise button and the head's context menu
    // (`minimize_window`, UIWindow.js), are hidden whenever this window is in
    // full view, so they can only ever minimise a WINDOWED Code — which
    // upstream's `hideWindow()` already does exactly. In full view the
    // drawer's Show desktop calls `full_view.minimise()` itself.
    // `seam-minimise-browser-test.mjs` pins one provider of that hook.
    /**
     * Single-instance relaunch (contract item 4): the registry calls this on the
     * existing window, after `showWindow()`, with the launch's ctx. Only
     * `ctx.view` is read, and only `'full'` / `'window'`; every other key and
     * value is ignored (a later lane reads `ctx.project`). Not remembered.
     */
    el_window._ezil_relaunch = (relaunch_ctx) => {
        const view = relaunch_ctx?.view;
        if ( view === 'full' || view === 'window' ) set_view(view);
    };
    // Back from the taskbar: full view again if still wanted, else the
    // windowed bounds a minimise-from-full left stashed. After `showWindow`'s
    // 0.2s geometry transition, as the Browser does, and re-checked then.
    const restore_observer = full_view.watch_restore(() => {
        setTimeout(() => {
            if ( disposed ) return;
            if ( full_view.wants ) full_view.enter(); else full_view.settle();
        }, 220);
    });

    const launch_view = ctx.view === 'full' || ctx.view === 'window' ? ctx.view : remembered_view();
    if ( launch_view === 'full' ) full_view.enter();
    view_now = current_view();

    const dispose = () => {
        progress.dispose();
        if (disposed) return;
        disposed = true;
        hide_state();
        restore_observer.disconnect();
        // A closed window stops asking: no ask after close can reach ensure() (hotfix r5).
        mint_ctl?.abort();
        window.removeEventListener('ezil:desktop-restarted', on_restarted);
        window.removeEventListener(TRANSITION_EVENT, on_transition);
        transition_watch?.stop();
        clearInterval(transition_guard);
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
        // Closing from full view while the Browser is still full-bleed must
        // not put the taskbar over it (`full-view.js#prepare_close`).
        full_view.prepare_close();
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
