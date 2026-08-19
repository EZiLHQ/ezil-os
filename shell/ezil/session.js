// session.js — EZiL-authored. The shell's ENTIRE server surface.
//
// 🔴 LOCAL CODE ONLY. Upstream Puter's GUI talks to a cloud backend for
// identity (`puter.auth`), files (`puter.fs`, 71 calls), preferences
// (`puter.kv`, ~40 calls), app metadata (`puter.apps`) and realtime
// (socket.io). None of that came across. This module is what replaced all of
// it, and it is deliberately small enough to read in one sitting:
//
//   - preferences  -> localStorage, right here (`get`/`set`/`del`).
//   - identity     -> `window.__EZIL_BOOT__`, inlined into the /os document by
//                     `app/src/app/os/page.tsx`. The shell NEVER asks who the
//                     user is; the answer is already in its first paint.
//   - the desktop  -> two plain-JSON Route Handlers under `/api/shell/*`.
//
// No `@trpc/client`, no `superjson`, no socket. Those handlers are a transport
// over `appRouter.createCaller`, so `protectedProcedure` and the
// ownership-scoped row filters remain the single authorization implementation
// — see `app/src/server/shell/http.ts`. Bundling a tRPC client here would add
// a second serialization format and 100KB+ to a page whose budget is 200ms,
// and buy nothing.
//
// EVERY function below is failure-first: nothing throws at the call site for
// an expected failure, and nothing invents a success. A rejected fetch comes
// back as a typed `{ ok: false, errorCode }` the boot UI already knows how to
// render honestly (see `boot-phases.js`).

import telemetry from './telemetry.js';
import { WAKE_DEADLINE_MS, WAKE_REASK_MS, isRetryableBootErrorCode } from './boot-phases.js';

const NS = 'ezil-os:';

/**
 * The shell's client budget for a cold desktop boot.
 *
 * `POST /api/shell/desktop` -> `cloudflareGuacamole.previewUrl` ->
 * `requestGuacamolePreview`, whose own budget is `SANDBOX_COLD_START_TIMEOUT_MS`
 * = 210s (180s Worker ceiling + 30s margin;
 * `app/src/server/lib/cloudflare-guacamole-provider.ts`). This must sit ABOVE
 * that and BELOW the route's `maxDuration = 300`, or the browser gives up on
 * a request the server is still about to answer successfully — the user then
 * sees a timeout for a desktop that actually booted.
 *
 * A cold boot is ~22s measured (docs/PLATFORM-NOTES.md §11). This ceiling is
 * not a target; it is the point past which we stop waiting.
 */
export const DESKTOP_BOOT_TIMEOUT_MS = 215_000;

/** The cheap status probe never wakes a container, so it gets a short leash. */
const STATUS_TIMEOUT_MS = 12_000;

// ---------------------------------------------------------------------------
// Preferences — the `puter.kv` replacement
// ---------------------------------------------------------------------------
// `UI/UITaskbar.js` imports this module for `taskbar_position` and
// `taskbar_items`; upstream read both from the cloud. Same keys, same
// semantics, no network, and namespaced so the shell cannot collide with the
// Next app's own localStorage on the same origin.

/** localStorage can throw, not just return null (Safari private mode, disabled storage, quota). */
function storage () {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

export function get (key, fallback = null) {
    const s = storage();
    if ( ! s ) return fallback;
    try {
        const raw = s.getItem(NS + key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

export function set (key, value) {
    const s = storage();
    if ( ! s ) return false;
    try {
        s.setItem(NS + key, JSON.stringify(value));
        return true;
    } catch {
        return false;
    }
}

export function del (key) {
    const s = storage();
    if ( ! s ) return false;
    try {
        s.removeItem(NS + key);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Identity — `window.__EZIL_BOOT__`
// ---------------------------------------------------------------------------

/**
 * The inlined boot payload, or `null` if the page did not provide one.
 *
 * Returning `null` rather than a plausible empty object is the whole point:
 * a shell with no payload is a shell that must NOT draw a desktop for nobody.
 * `boot.js` treats it as a hard stop.
 */
export function payload () {
    const raw = typeof window === 'undefined' ? null : window.__EZIL_BOOT__;
    if ( ! raw || typeof raw !== 'object' ) return null;
    // The one field every consumer dereferences. A payload without it is
    // malformed, not partial.
    if ( ! raw.user || typeof raw.user.id !== 'string' ) return null;
    return raw;
}

/** Where the Route Handlers live. Mirrors `SHELL_API_ROUTES` in boot-payload.ts. */
export const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    focus: '/api/shell/focus',
};

/** The payload carries its own endpoint map; prefer it, fall back to the mirror. */
function endpoint (name) {
    return payload()?.desktopState?.endpoints?.[name] ?? ENDPOINTS[name];
}

// ---------------------------------------------------------------------------
// The two Route Handlers
// ---------------------------------------------------------------------------

/**
 * One fetch, one shape out. Never throws for an HTTP-level failure — a
 * caller that has to `try` around every network call ends up with one
 * `catch` that cannot tell 401 from offline, and then shows the same wrong
 * message for both.
 *
 * @returns {Promise<{ok: true, data: any} | {ok: false, code: string, status: number, message: string}>}
 */
async function request (url, { method = 'GET', body, timeoutMs } = {}) {
    let res;
    try {
        res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
        });
    } catch ( err ) {
        // `AbortSignal.timeout` rejects with a DOMException named
        // 'TimeoutError'; everything else here is a genuine transport
        // failure. The distinction survives into the boot UI's copy.
        const timedOut = err && err.name === 'TimeoutError';
        return {
            ok: false,
            code: timedOut ? 'TIMEOUT' : 'NETWORK',
            status: 0,
            message: timedOut ? 'The request took too long.' : 'Could not reach the server.',
        };
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if ( ! res.ok ) {
        return {
            ok: false,
            code: data?.error?.code ?? `HTTP_${res.status}`,
            status: res.status,
            message: data?.error?.message ?? 'Something went wrong.',
        };
    }
    return { ok: true, data };
}

// ---------------------------------------------------------------------------
// The wake loop, and the one automatic retry
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on how many times ONE call may hit the server, whatever the
 * two real bounds below happen to say. See the comment at the top of
 * `withWakeAndOneRetry`'s loop for why a ceiling and not just the conditions.
 */
const MAX_ISSUES = 40;

/**
 * 🔴 THE BEAT BEFORE THE ONE AUTOMATIC RETRY — AND IT USED TO BE ZERO.
 *
 * ── The measurement this exists for ─────────────────────────────────────────
 * `ezil_error_events`, 2026-08-08 → 2026-08-10: 10 of 26 desktop launches
 * failed with `desktop_unreachable`, and the automatic retry failed on all
 * ten. Reading the two events that bracket it — `session#openDesktop`
 * `auto_retry_desktop_unreachable` carries elapsed-at-retry, and
 * `apps/desktop#mint` carries elapsed-at-give-up — gives the gap between the
 * first failure and the second, identical one:
 *
 *     2026-08-09 03:32   22560ms -> 24142ms     retry took 1582ms
 *     2026-08-09 05:04   33492ms -> 34037ms     retry took  545ms
 *     2026-08-10 10:54   32933ms -> 34569ms     retry took 1636ms
 *     2026-08-10 12:30   32355ms -> 32760ms     retry took  405ms
 *
 * A 405ms round trip is not a second chance at anything. The retry branch
 * below `continue`d with no delay at all (see commit 8510ff6, which noticed
 * exactly this while proving `MAX_ISSUES` was load-bearing: "the retry branch
 * has no delay"), so the second ask reached the server while the first
 * answer was still the current state of the world. `desktop_unreachable` in
 * particular means the app server's own handoff probe of the desktop origin
 * did not get an answer — a condition that resolves in SECONDS as a container
 * finishes coming up, and never in the sub-second gap this loop was leaving.
 *
 * ── Why 1.5s and not more ───────────────────────────────────────────────────
 * Same number as `WAKE_REASK_MS`, and for the same reason: it is a beat
 * between asks, not a budget. The real waiting belongs SERVER-side, where the
 * probe can be re-issued against a live socket without paying a browser round
 * trip each time (see this task's report — `probeDesktopFrame` is still a
 * single 6s shot). Making this large enough to cover a container boot on its
 * own would put the user in front of a spinner that this file cannot explain.
 */
const RETRY_DELAY_MS = 1_500;

/**
 * 🔴 THE HIBERNATION FIX, CLIENT SIDE. One implementation, three callers
 * (`openDesktop`, `previewUrl`, and `apps/code.js`'s own mint) — three copies
 * of a retry loop is how the timings drift apart and one surface quietly stops
 * waiting.
 *
 * Two distinct behaviours, and they are NOT the same thing:
 *
 *   1. THE WAKE LOOP. `sandbox_starting` is not a failure. It is the server
 *      saying "the container is coming up and I am not going to hold this
 *      socket for three minutes" (see `SANDBOX_WAKE_ANSWER_BUDGET_MS` in
 *      `app/src/server/lib/cloudflare-guacamole-provider.ts`). The honest
 *      response is to ask again, which is what this does, until
 *      `WAKE_DEADLINE_MS`. The caller's boot panel is on a `setInterval` of its
 *      own, so the phase list keeps running the whole time — the user sees
 *      "Waking your machine" for as long as that is the true statement, instead
 *      of a dead socket followed by "We couldn't start your computer."
 *
 *   2. ONE AUTOMATIC RETRY. Measured on this repo's own regression: the first
 *      mint after an idle period fails, and the second one — issued seconds
 *      later, byte-identical — succeeds every single time. So a RETRYABLE
 *      failure buys exactly one silent re-ask before the user is shown
 *      anything. ONE. `retried` is a plain boolean, set before the second
 *      attempt is issued and never cleared inside this call, so there is no
 *      path through here that can issue a third. A DETERMINISTIC failure
 *      (`isRetryableBootErrorCode` — an HMAC mismatch, a malformed request)
 *      buys none, because re-asking a fixed question is just latency.
 *
 * The wake loop and the retry compose without interfering: `sandbox_starting`
 * is consumed by (1) and never reaches (2), so a long wake cannot silently
 * spend the one retry that a genuine failure is owed.
 *
 * @param {() => Promise<{ok: true} | {ok: false, errorCode: string, message?: string}>} issue
 *   Sends the request once. Must never throw.
 * @param {string} what For the log line only.
 */
async function withWakeAndOneRetry (issue, what) {
    const t0 = Date.now();
    let retried = false;
    let asks = 0;

    for (;;) {
        // 🔴 THE STRUCTURAL BACKSTOP, AND IT IS NOT DECORATION. Every other
        // bound in this function is a CONDITION — a clock for the wake, a
        // boolean for the retry — and a condition can be edited away. Removing
        // the `retried = true` line was tried during review and it turned this
        // into an unbounded, zero-delay request loop that HUNG the headless
        // suite rather than failing it. A browser would have hammered the
        // server for as long as the tab stayed open.
        //
        // `MAX_ISSUES` is far above every legitimate path (a full 215s wake at
        // ~13.5s per ask is ~16, plus one retry) so it can never fire in normal
        // use, and it turns any future breakage of the two real bounds into a
        // stop rather than a spin. With it in place the same mutation now
        // reports `attempts=40` and fails three named checks.
        if ( asks >= MAX_ISSUES ) {
            console.error(`[ezil-os:session] ${what}: refusing to ask a ${asks + 1}th time; stopping`);
            telemetry.capture({
                eventClass: 'contract_violation', site: `ezil-os:session#${what}`, code: 'ask_cap_reached',
                durationMs: Date.now() - t0, detail: `${asks} asks`,
            });
            return { ok: false, errorCode: 'unknown', message: 'Gave up asking the server.' };
        }
        asks++;
        const res = await issue();
        if ( res.ok === true ) return res;

        if ( res.errorCode === 'sandbox_starting' ) {
            const waited = Date.now() - t0;
            if ( waited >= WAKE_DEADLINE_MS ) {
                console.warn(`[ezil-os:session] ${what}: still waking after ${waited}ms; giving up`);
                telemetry.capture({
                    eventClass: 'api_failure', site: `ezil-os:session#${what}`, code: 'sandbox_starting',
                    durationMs: waited, detail: `gave up after ${asks} asks`,
                });
                // The honest code for "it never finished waking within our
                // budget". `classifyFailure` in boot-phases.js turns it into
                // the `timeout` copy — "it may still come up in the background
                // — try again" — which is exactly what is true.
                return res;
            }
            await new Promise(r => setTimeout(r, WAKE_REASK_MS));
            continue;
        }

        // A genuine failure. One silent re-ask if a second attempt could
        // plausibly answer differently, then hand it to the user.
        if ( ! retried && isRetryableBootErrorCode(res.errorCode) ) {
            retried = true;
            console.info(`[ezil-os:session] ${what}: ${res.errorCode} on the first attempt; retrying once in ${RETRY_DELAY_MS}ms`);
            telemetry.capture({
                eventClass: 'api_failure', site: `ezil-os:session#${what}`, code: `auto_retry_${res.errorCode}`,
                durationMs: Date.now() - t0,
            });
            // Measured: without this the second ask landed 405-1636ms after
            // the first and returned the same answer 10 times out of 10. See
            // `RETRY_DELAY_MS`. The telemetry above is emitted BEFORE the
            // wait, so its `durationMs` still marks the first failure and the
            // arithmetic in that comment keeps working.
            await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
            continue;
        }
        return res;
    }
}

/** `GET /api/shell/session` — read-only. `computer` may be null. */
export function readSession () {
    return request(endpoint('session'), { timeoutMs: STATUS_TIMEOUT_MS });
}

/** `POST /api/shell/session` — get-or-create the default computer. Idempotent. */
export function openSession () {
    return request(endpoint('session'), { method: 'POST', body: {}, timeoutMs: STATUS_TIMEOUT_MS });
}

/**
 * `POST /api/shell/desktop` — the long one. Starts (or attaches to) the
 * computer's desktop and resolves only at the end.
 *
 * 🔴 This is the ONLY way the shell may obtain a desktop URL. It routes to
 * `cloudflareGuacamole.previewUrl`, which runs `enableImplicitHosting`
 * SERVER-SIDE before returning — the Neko client reads that flag once, at
 * websocket init, so it must already be true when the iframe is created. A
 * shell that composed its own URL would produce a desktop that renders
 * perfectly and silently ignores every click.
 *
 * @returns {Promise<{ok: true, url: string, frameConfirmed: boolean, controlMode?: string, mode?: string, workspace?: any}
 *                  | {ok: false, errorCode: string, message?: string}>}
 */
export async function openDesktop (computerId) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to open.' };
    }
    return withWakeAndOneRetry(() => openDesktopOnce(computerId), 'openDesktop');
}

/** One `POST /api/shell/desktop`. The loop that may call it more than once is above. */
async function openDesktopOnce (computerId) {
    const res = await request(endpoint('desktop'), {
        method: 'POST',
        body: { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
    });

    if ( ! res.ok ) {
        // Transport/HTTP failure. `TIMEOUT` is the one code `previewUrl`
        // itself can never produce and the boot UI has real copy for.
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        return { ok: false, errorCode: 'unknown', message: res.message };
    }

    // `previewUrl` returns operational + deterministic failures as VALUES on
    // a 200, so that a retrying client cannot re-ask a question whose answer
    // is fixed. Pass the code straight through; `classifyFailure` in
    // boot-phases.js owns the mapping to user-facing copy.
    const data = res.data ?? {};
    if ( data.ok !== true ) {
        return { ok: false, errorCode: data.errorCode ?? 'unknown' };
    }
    if ( typeof data.guacamoleUrl !== 'string' || data.guacamoleUrl === '' ) {
        // Reported success with nothing to show. Loud, not silent.
        console.error('[ezil-os:session] previewUrl returned ok with no URL');
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:session#previewUrl', code: 'preview_url_missing',
        });
        return { ok: false, errorCode: 'unknown' };
    }
    return {
        ok: true,
        url: data.guacamoleUrl,
        // 🔴 Whether the SERVER observed the desktop origin answering, before
        // it handed this URL over. Strict `=== true`, and never defaulted to
        // true: a response that omits the field is a server that did not check,
        // and `computeBootUiState` must treat that as "not confirmed" rather
        // than inherit the old assumption that a URL implies a desktop.
        frameConfirmed: data.frame?.confirmed === true,
        controlMode: data.controlMode,
        mode: data.mode,
        workspace: data.workspace,
    };
}

/**
 * `POST /api/shell/preview-url` — mint a FRESH app-preview window URL.
 *
 * 🔴 CALL THIS AT WINDOW-OPEN, EVERY TIME. NEVER STASH THE RESULT.
 *
 * The URL it returns is `…/preview-bootstrap?token=…`, and that token is good
 * for FIVE MINUTES (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`, enforced by the
 * Worker's `verifyPreviewBootstrapToken`). This is the whole reason the URL is
 * not in the boot payload: that payload is built once, at page load, and a
 * user who opens a Preview window ten minutes later would navigate to a dead
 * token and get a blank window plus `preview_bootstrap_token_expired`. There
 * is nothing in the failure a user could act on and nothing in the UI that
 * could explain it.
 *
 * The protection is structural, not a TTL check: there is no cache here, no
 * module-level variable holding a URL, and nothing on `session.payload()` to
 * read one from. The only way to obtain one is to call this, and the only
 * honest place to call it is immediately before navigating a frame to it.
 *
 * This can be SLOW — it may cold-boot the container (~22s measured), exactly
 * like `openDesktop`, so it takes the same budget.
 *
 * @returns {Promise<{ok: true, url: string, expiresAt?: number}
 *                  | {ok: false, errorCode: string, message?: string}>}
 */
export async function previewUrl (computerId) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to preview.' };
    }
    return withWakeAndOneRetry(() => previewUrlOnce(computerId), 'previewUrl');
}

/** One `POST /api/shell/preview-url`. The loop that may call it more than once is above. */
async function previewUrlOnce (computerId) {
    const res = await request(endpoint('previewUrl'), {
        method: 'POST',
        body: { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
    });

    if ( ! res.ok ) {
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        return { ok: false, errorCode: 'unknown', message: res.message };
    }

    const data = res.data ?? {};
    if ( data.ok !== true ) {
        return { ok: false, errorCode: data.errorCode ?? 'unknown' };
    }
    if ( typeof data.appPreviewUrl !== 'string' || data.appPreviewUrl === '' ) {
        // Reported success with nothing to show. Loud, not silent — same rule
        // as `openDesktop` above.
        console.error('[ezil-os:session] appPreviewUrl returned ok with no URL');
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:session#appPreviewUrl', code: 'app_preview_url_missing',
        });
        return { ok: false, errorCode: 'unknown' };
    }
    return { ok: true, url: data.appPreviewUrl, expiresAt: data.expiresAt };
}

/**
 * `POST /api/shell/focus` — raise an app's window inside the container's X
 * session, changing what the desktop stream shows.
 *
 * `app` is validated SERVER-side against `FOCUSABLE_APPS`
 * (`app/src/server/lib/cloudflare-guacamole-provider.ts`) and anything else is
 * a 400. The shell does not keep its own copy of that list to check against:
 * two lists is how they drift, and the whole reason this endpoint needed
 * reconciling in the first place was three copies of an app enum disagreeing.
 *
 * @returns {Promise<boolean|undefined>} `true`/`false` is a real answer from
 *   the server. `undefined` means OUR request never landed (offline, timeout)
 *   and must not be read as either verdict. Even `true` only means the request
 *   completed — nothing here can observe that the pixel changed, and no caller
 *   may claim it did.
 */
export async function focusApp (computerId, app, timeoutMs = STATUS_TIMEOUT_MS) {
    if ( ! computerId || ! app ) return false;
    const res = await request(endpoint('focus'), {
        method: 'POST',
        body: { computerId, app },
        timeoutMs,
    });
    // A transport failure is not an observation of the container.
    if ( ! res.ok && (res.code === 'TIMEOUT' || res.code === 'NETWORK') ) return undefined;
    if ( ! res.ok ) return false;
    return res.data?.ok === true;
}

/**
 * `GET /api/shell/desktop?confirm=frame` — ask the server to check, right now,
 * that the URL the iframe is showing is a desktop and not an error page.
 *
 * 🔴 WHY THE `load` EVENT IS NOT THIS. An iframe fires `load` for an HTTP 500
 * error page exactly as it does for a working desktop, and cross-origin script
 * cannot read the status code or the document. On 2026-07-31 the preview host
 * returned 500 "Proxy routing error" and the shell hid its boot panel over it
 * on `load`. The browser has no honest signal here; the server does, because it
 * can make a plain HTTP request to that origin and read the status line.
 *
 * Cheap: one GET to an edge hostname. No Worker call, no container wake.
 *
 * @returns {Promise<boolean | undefined>} `true` = the origin answered without
 *   an error status. `false` = it answered with one, or did not answer at all.
 *   `undefined` = OUR request never landed, which is not an observation of the
 *   desktop and must not be read as either verdict.
 */
export async function confirmFrame (computerId, frameUrl) {
    if ( ! computerId || ! frameUrl ) return undefined;
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`
        + `&confirm=frame&frameUrl=${encodeURIComponent(frameUrl)}`;
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    if ( ! res.ok ) return undefined;
    if ( res.data?.ok !== true ) return undefined;
    return res.data.confirmed === true;
}

/**
 * `GET /api/shell/desktop?confirm=display` — ask the server whether the desktop
 * is actually PUTTING PIXELS IN THE BROWSER, not merely answering HTTP.
 *
 * 🔴 WHY `confirmFrame` IS NOT THIS. `confirmFrame` reads a status line. A Neko
 * origin serves its SPA shell with a 200 whether or not WebRTC will ever
 * connect, so a 200 there is entirely compatible with a blank screen — measured
 * under WebKit, the shell went ready in 4.6s with `videoWidth: 0`, `paused:
 * true`, `srcObject: false`, and the user got a third-party spinner under our
 * checkmark.
 *
 * 🔴 WHY THE BROWSER CANNOT ANSWER IT. The desktop iframe is cross-origin
 * (`8181-<sandbox>-nekodesktop.<zone>` inside this app's origin). Reading
 * `video.videoWidth` out of it is not "hard", it is forbidden — the attempt
 * throws or returns nothing, which is worse than not asking, because it looks
 * like a check. The server can ask Neko, which knows: it flips a per-session
 * `is_watching` flag from its WebRTC peer's `connected` state change.
 *
 * 🔴 z1: THIS ONE CALL CAN TAKE SEVERAL SECONDS ON PURPOSE. The server now
 * HOLDS the request, re-checking internally, for up to `DISPLAY_LONGPOLL_HOLD_MS`
 * (`cloudflare-guacamole-provider.ts`, currently 4s) before answering — a peer
 * that connects mid-hold is caught there instead of by our next poll a second
 * or more later. That is comfortably under `STATUS_TIMEOUT_MS` below (this
 * call's own fetch abort) and under `start_display_gate`'s
 * `DISPLAY_UNVERIFIED_DEADLINE_MS` (`desktop-window.js`), so a normal hold
 * finishing does not race either. Nothing here changed to make that true:
 * this function still does exactly one GET and reports exactly what comes
 * back, in either direction — a server that does not hold (an older
 * deployment) just answers fast, and this loop's own retry cadence below is
 * the bounded fallback for that case, unchanged.
 *
 * @returns {Promise<'live' | 'blank' | 'unknown'>}
 *   `'live'`    — a WebRTC peer is connected and being fed video.
 *   `'blank'`   — a real, well-formed observation that nobody is watching.
 *   `'unknown'` — no usable answer. This is NOT `'blank'`: it is a fact about
 *                 our plumbing, not about the user's screen, and it must never
 *                 be rendered as either a ready desktop or a broken one.
 *                 Anything unexpected off the wire lands here on purpose.
 */
export async function confirmDisplay (computerId, frameUrl) {
    if ( ! computerId || ! frameUrl ) return 'unknown';
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`
        + `&confirm=display&frameUrl=${encodeURIComponent(frameUrl)}`;
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    if ( ! res.ok ) return 'unknown';
    if ( res.data?.ok !== true ) return 'unknown';
    // Strict equality against the two claims, never a truthiness test and never
    // a default: a body that says something we did not plan for is exactly the
    // case `'unknown'` exists to catch.
    if ( res.data.display === 'live' ) return 'live';
    if ( res.data.display === 'blank' ) return 'blank';
    return 'unknown';
}

/**
 * `GET /api/shell/desktop?computerId=` — the cheap poll. Does NOT wake a
 * sleeping container, so it is safe to run every 2s WHILE the boot request
 * above is in flight. It is the single genuine mid-boot signal the browser
 * has; everything else the progress UI shows is an estimate and says so.
 *
 * @returns {Promise<boolean | undefined>} `guacamoleRunning`, or `undefined`
 *   when no answer landed. `undefined` must NOT be read as `false` — that
 *   would fabricate a negative signal we do not have.
 */
export async function desktopRunning (computerId) {
    if ( ! computerId ) return undefined;
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`;
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    if ( ! res.ok ) return undefined;
    return res.data?.ok === true ? res.data.guacamoleRunning : undefined;
}

/**
 * Is a Worker-side "restart this desktop" route published by THIS
 * deployment, right now? Read fresh every call — a rehydrate can bring in a
 * newer or older payload than the one this module first saw.
 *
 * 🔴 FEATURE-DETECTED, and deliberately NOT added to the `ENDPOINTS` mirror
 * with a hardcoded path. `payload().desktopState.endpoints` is the ONLY source
 * of truth for "can the server actually do this today", the same rule
 * `desktop-window.js` already applies to `endpoints.focus` (see that file's
 * `focus_endpoint` constant and its header comment). Every caller of
 * `restartDesktop` below must treat a `null` here as "no", never invent
 * `/api/shell/restart` and try it anyway — the bundle and the server deploy
 * separately, so a shell newer than its server is a real state, not a
 * hypothetical one.
 *
 * @returns {string|null}
 */
export function restartEndpoint () {
    const url = payload()?.desktopState?.endpoints?.restart;
    return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * `POST <endpoints.restart>` — ask the server to restart this computer's
 * desktop container without destroying the computer itself or its workspace.
 * Same response-shape convention as `openDesktop`/`previewUrl`: a 200 with
 * `{ok:true, ...}`, or `{ok:false, errorCode}` for an operational failure the
 * server observed. Never guesses at success: a transport failure, a timeout,
 * or the route not existing at all are all `{ok:false}`, never `{ok:true}`.
 *
 * @returns {Promise<{ok:true} | {ok:false, errorCode:string, message?:string}>}
 */
export async function restartDesktop (computerId) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to restart.' };
    }
    const url = restartEndpoint();
    if ( ! url ) {
        // Not published by this deployment — say so WITHOUT making a request.
        // See `restartEndpoint()`'s header for why this never invents a URL.
        return {
            ok: false,
            errorCode: 'unsupported',
            message: "Restarting isn't available in this deployment yet.",
        };
    }
    const res = await request(url, {
        method: 'POST',
        body: { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
    });
    if ( ! res.ok ) {
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        return { ok: false, errorCode: 'unknown', message: res.message };
    }
    const data = res.data ?? {};
    if ( data.ok !== true ) {
        return { ok: false, errorCode: data.errorCode ?? 'unknown', message: data.message };
    }
    return { ok: true };
}

/**
 * Is a Worker-side "record recent input" route published by THIS
 * deployment, right now? Read fresh every call, mirroring `restartEndpoint()`
 * — the container-idle reaper this feeds needs no static mirror in
 * `ENDPOINTS` above: an OLDER server that has never heard of this field must
 * get NO request at all, never a 404 sprayed at a path this bundle invented.
 *
 * @returns {string|null}
 */
export function activityEndpoint () {
    const url = payload()?.desktopState?.endpoints?.activity;
    return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * `POST <endpoints.activity>` — tell the server a human is present at this
 * computer's desktop, so its container-idle reaper does not cool the
 * container down out from under someone who is actually watching it. See
 * `apps/desktop-window.js`'s heartbeat wiring for when this is called (every
 * `HEARTBEAT_INTERVAL_MS` while the window is open, the tab is visible, and
 * PRESENCE is recent — `../activity-heartbeat.js` owns that decision).
 *
 * 🔴 FEATURE-DETECTED, same contract as `restartDesktop` above: a deployment
 * that does not publish `endpoints.activity` gets NO request at all. This is
 * the difference between "an older server degrades to no heartbeat" and "an
 * older server's console fills up with 404s" — the whole reason this checks
 * `activityEndpoint()` FIRST rather than just POSTing and reading the status.
 *
 * NEVER THROWS, and a resolved promise is not proof the server recorded
 * anything — this is a best-effort signal. A failed or skipped beat is
 * swallowed by the caller, not retried: the next one is only
 * `HEARTBEAT_INTERVAL_MS` away, and retrying a heartbeat is a contradiction
 * in terms.
 *
 * @param {string} computerId
 * @param {number} lastInputAgoMs Milliseconds since the user was last PRESENT
 *   (see `../activity-heartbeat.js`). The wire name predates the correction
 *   from "observed input" to "presence" and is deliberately kept: the server
 *   only ever reads it as `now - ago`, which is exactly what it still means,
 *   so nothing on the Worker side had to change.
 * @returns {Promise<boolean|undefined>} `true`/`false` is a real answer from
 *   the server. `undefined` means either OUR request never landed, or this
 *   deployment does not publish the endpoint at all — neither is an
 *   observation of anything and callers must not treat it as a failure.
 */
export async function reportActivity (computerId, lastInputAgoMs) {
    if ( ! computerId ) return undefined;
    const url = activityEndpoint();
    if ( ! url ) return undefined;
    const res = await request(url, {
        method: 'POST',
        body: { computerId, lastInputAgoMs },
        timeoutMs: STATUS_TIMEOUT_MS,
    });
    if ( ! res.ok ) return undefined;
    return res.data?.ok === true;
}

export { withWakeAndOneRetry };

export default {
    get, set, del,
    payload,
    readSession, openSession,
    openDesktop, desktopRunning, confirmFrame, confirmDisplay,
    previewUrl, focusApp,
    restartEndpoint, restartDesktop,
    activityEndpoint, reportActivity,
    withWakeAndOneRetry,
    ENDPOINTS,
    DESKTOP_BOOT_TIMEOUT_MS,
};
