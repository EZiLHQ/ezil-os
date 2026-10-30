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
// The shell's own "long enough ago to count as absent" threshold. Read by
// `RELEASE_PRESENCE_AGO_MS` below so a release and a heartbeat cannot drift
// apart about what "nobody is here" means.
import { ACTIVITY_FRESH_MS } from './activity-heartbeat.js';
// Phase B: what one `computer.progress` read says about a moving open (the moving view's one reader).
import { moveAskOf, MOVE_BUDGET_SECONDS } from './ui/computer-progress.js';

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

/**
 * Leash for a LIVE screen resize (`setScreen`).
 *
 * Longer than `STATUS_TIMEOUT_MS` because the container really does work — the
 * Worker logs into neko and neko restarts the capture pipeline — and shorter
 * than anything on the boot path because the container is already awake and
 * the whole round trip is two loopback calls inside it. The Worker's own
 * budget is 12s and the app's is 20s; 25s sits outside both, so a timeout seen
 * HERE means the network, not the resize.
 */
const SCREEN_TIMEOUT_MS = 25_000;

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

/**
 * 🔴 THE current computer — the one Settings marks Current AND the one every
 * new Desktop/Code/Preview window opens on (`registry.js`'s `launchContext`,
 * used by the dock, the Start menu and the App Store's `launchApp`). The boot payload's computer until the user switches in
 * Settings, then the computer switched to, for the rest of this page.
 * `setCurrentComputer(null)` clears the choice (back to the payload's).
 * Module state, never written into `window.__EZIL_BOOT__`. Founder-reported
 * 2026-10-18: with two copies of this (the dock's build-time ctx and Settings'
 * own last-switched id), Settings said Computer 1 while Code opened on 2.
 */
let chosenComputer = null;
export function currentComputer () { return chosenComputer ?? payload()?.computer ?? null; }
export function setCurrentComputer (computer) { chosenComputer = computer?.id ? computer : null; }

/** Where the Route Handlers live. Mirrors `SHELL_API_ROUTES` in boot-payload.ts. */
export const ENDPOINTS = {
    session: '/api/shell/session',
    desktop: '/api/shell/desktop',
    previewUrl: '/api/shell/preview-url',
    focus: '/api/shell/focus',
    // 🔴 Written down here for the same reason `focus` is — one canonical list
    // of paths — but NEVER used as a fallback: `screenEndpoint()` reads the
    // payload and only the payload. See its doc comment.
    screen: '/api/shell/screen',
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
async function request (url, { method = 'GET', body, timeoutMs, signal } = {}) {
    let res;
    try {
        res = await fetch(url, {
            method,
            credentials: 'same-origin',
            headers: body === undefined ? undefined : { 'content-type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: requestSignal(timeoutMs, signal),
        });
    } catch ( err ) {
        // `AbortSignal.timeout` rejects with a DOMException named
        // 'TimeoutError'; everything else here is a genuine transport
        // failure. The distinction survives into the boot UI's copy.
        const timedOut = err && err.name === 'TimeoutError';
        if ( ! timedOut && signal?.aborted ) {
            return { ok: false, code: 'CANCELLED', status: 0, message: 'The request was cancelled.' };
        }
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
// AWS pending responses return immediately, unlike Cloudflare's held wake
// requests. Allow the full existing 215s deadline at the 1.5s polling cadence.
const AWS_MAX_ISSUES = Math.ceil(WAKE_DEADLINE_MS / WAKE_REASK_MS) + 2;
// A paid upgrade includes host provisioning and workspace/system restore.
// Count from the first migration answer, then allow a full ordinary AWS wake.
export const MIGRATION_DEADLINE_MS = 10 * 60_000;
// A replacement AMI boot gets one bounded budget, retained after enrollment. Both match the
// loader's 10-minute calm ceiling; a stalled pool adoption self-recovers well inside it.
export const LAUNCH_DEADLINE_MS = 10 * 60_000;
export { LAUNCH_COPY } from './launch-copy.js';

const LAUNCH_MAX_ISSUES = Math.ceil(LAUNCH_DEADLINE_MS / WAKE_REASK_MS) + 2;
const MIGRATION_MAX_ISSUES = Math.ceil(MIGRATION_DEADLINE_MS / WAKE_REASK_MS) + 2;
/**
 * Round 6a (C2): how long a loop waits from the FIRST preparing answer it sees (`computePreparing`: the
 * computer's desktop is taking this host boot's config, or code-server is starting after it). Without it an
 * open that carries no launch flag (a stopped computer starting in place, a warm pool adopt) and first sees
 * preparing at ~70 s gave up at 216 s, before the Worker's own verdict at ~222 s, and read "Code isn't
 * reachable" over a wait that was still bounded.
 *
 * 180 s = the Worker's 150 s bound (worker/src/aws-ice.ts AWS_DESKTOP_CONFIG_APPLY_MS, counted from its one
 * push, which the first preparing answer never precedes) + 30 s: the ask that carries the verdict lands up to
 * one re-ask later (WAKE_REASK_MS, then one ask's answer: the Worker's 8 s status read and 5 s surface probe),
 * and a config applied at the very end of the window still restarts the desktop's container before code-server
 * answers (`code_starting`, a preparing reason too). The spinner says "Taking longer than usual" from
 * PREPARE_EXPECTED_S (150 s, ui/app-spinner.js) after the same first sight, so that always shows first.
 * Extended once per loop, never past t0 + LAUNCH_DEADLINE_MS (the loader's ten-minute ceiling,
 * ui/boot-progress.js AWS_BOOT_HARD_STOP_MS); an ordinary wake ends by 215 s + 180 s = 395 s at the latest.
 */
export const PREPARE_DEADLINE_MS = 180_000;
const PREPARE_MAX_ISSUES = Math.ceil(PREPARE_DEADLINE_MS / WAKE_REASK_MS) + 2;
/**
 * 🔴 PHASE B (reverse move contract §5.3, §6.4): A MOVE IS NOT A BOOT. While a held computer's files move from its
 * AWS computer to its Free computer, every open is answered by the server's reverse waiting provider
 * (`computeMoving`), which never boots anything, for as long as the move runs: up to `budgetSeconds` (13 200 s, the
 * sum of the server's own step deadlines). The wake, migration, launch and prepare clocks (215 s to ten minutes) would
 * fail every move half way, so a moving answer REPLACES the loop's deadline and cap with these, from the first moving
 * answer: `budgetSeconds` + 300 s (two cron ticks of pass-detection lag per state), re-asked at most every 30 s.
 * Only the server's outcome ends a move; this clock running out is "still working on it", never a failure.
 */
export const MOVE_WATCH_MS = (MOVE_BUDGET_SECONDS + 300) * 1000;
export const MOVE_REASK_MS = 30_000;
const MOVE_MAX_ISSUES = Math.ceil(MOVE_WATCH_MS / MOVE_REASK_MS) + 2;
/** tRPC's GET route (`ui/Settings/trpc.js` documents the wire shape); here with this file's timeout and cancel. */
const TRPC_ENDPOINT = '/api/trpc';

// Per-request observations let a window show a warm request's progress too.
// Concurrent opens cannot clear one another's still-active migration signal.
const migratingRequests = new Map();
const launchingRequests = new Map();
/** Phase B: in-flight asks whose last answer said the computer's files are moving (`computeMoving`). */
const movingRequests = new Map();
/**
 * Round 6 (seam C): in-flight asks whose server answer said the computer's desktop is taking this host
 * boot's config (one push, then a container restart; the Worker bounds it at 150 s) or code-server is
 * starting after it (`computePreparing`, app aws-preview.ts AWS_PREPARING_REASONS). Kept for the rest of
 * that ask's loop once seen: during the restart the Worker answers other starting codes without the flag.
 */
const preparingRequests = new Map();
export function isComputeLaunching (computerId) {
    return !!computerId && [...launchingRequests.values()].includes(computerId);
}
export function isComputePreparing (computerId) {
    return !!computerId && [...preparingRequests.values()].includes(computerId);
}
export function isComputeMigrating (computerId) {
    return !!computerId && [...migratingRequests.values()].includes(computerId);
}
export function isComputeMoving (computerId) {
    return !!computerId && [...movingRequests.values()].includes(computerId);
}

/**
 * Phase B (§6.4 rule 3): one `computer.progress` read for a moving loop. 'ask' only when it shows this computer's move
 * in flight or committed; 'stop' on a failed outcome; 'wait' for anything else, a failed read included.
 */
async function readMoveAsk (computerId, signal) {
    const input = encodeURIComponent(JSON.stringify({ json: { computerId } }));
    const res = await request(`${TRPC_ENDPOINT}/computer.progress?input=${input}`, { timeoutMs: STATUS_TIMEOUT_MS, signal });
    if ( ! res.ok ) return 'wait';
    const data = res.data?.result?.data;
    return moveAskOf(data && typeof data === 'object' && 'json' in data ? data.json : data, computerId);
}

/**
 * The fetch signal for one request: its timeout and, when given, the caller's
 * cancel. An engine without `AbortSignal.any` keeps the timeout only; the
 * caller's loop still stops at its next cancel check, it just cannot cut the
 * request already on the wire.
 */
function requestSignal (timeoutMs, cancel) {
    const timeout = timeoutMs ? AbortSignal.timeout?.(timeoutMs) : undefined;
    if ( ! cancel ) return timeout;
    if ( ! timeout ) return cancel;
    return typeof AbortSignal.any === 'function' ? AbortSignal.any([timeout, cancel]) : timeout;
}

/** A sleep that ends early when `signal` aborts. */
function pause (ms, signal) {
    return new Promise((resolve) => {
        if ( signal?.aborted ) return resolve();
        const done = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); };
        const timer = setTimeout(done, ms);
        signal?.addEventListener?.('abort', done, { once: true });
    });
}

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
 * 🔴 CODES THAT ARE TERMINAL AT THIS LAYER, WHICH `isRetryableBootErrorCode`
 * CANNOT KNOW ABOUT.
 *
 * `isRetryableBootErrorCode` mirrors the SERVER's
 * `DETERMINISTIC_PREVIEW_ERROR_CODES` byte-for-byte, pinned by a test, and that
 * list is about the DESKTOP preview path. `code_preview_unavailable` and
 * `app_preview_unavailable` travel on different routes entirely
 * (`codePreviewUrl` / `previewUrl`), are not members of `BootErrorCode`, and so
 * fall through that function's `!DETERMINISTIC.includes(code)` default and are
 * classified retryable. They are not. Widening the server's list to cover them
 * would break the pin and misfile a code-server fact as a desktop-preview fact.
 *
 * They mean "this deployment/container cannot serve that app at all".
 * `apps/code.js` and `apps/preview.js` both already treat them as TERMINAL and
 * paint an honest "not available" panel — read the comment above
 * `show_unavailable()` in either file. Re-asking cannot change the answer, so
 * the retry is one wasted request and, since `RETRY_DELAY_MS` landed, 1.5s of
 * spinner in front of a panel we were ready to draw immediately.
 *
 * 🔴 MEASURED, not theorised. `apps/code-test.mjs`'s Direction C went red on
 * the merged tree (38/40) and green on `main` (40/40) for exactly this reason:
 * the delay pushed the panel past the test's settle window. The retry was
 * ALWAYS wrong here; before the delay it was merely invisible.
 */
const TERMINAL_ERROR_CODES = ['code_preview_unavailable', 'app_preview_unavailable'];

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
 *      `WAKE_DEADLINE_MS`. A flagged migration first gets its own bounded
 *      deadline, then a fresh wake budget when the flag drops; a flagged launch
 *      gets its own; the first preparing answer extends it once, to the
 *      Worker's verdict (`PREPARE_DEADLINE_MS`). The caller's boot panel is on a `setInterval` of its
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
 *   3. PHASE B, TESTED FIRST: A MOVE. A `computeMoving` answer (the computer's
 *      files are moving to its Free computer) is not a wake. It runs on the
 *      move's own clocks (`MOVE_WATCH_MS`, `MOVE_REASK_MS`), and it is re-asked
 *      only after a `computer.progress` read shows the move in flight or
 *      committed: after a failed move an ordinary open boots the AWS computer
 *      under the Free hold, which the user must choose. The first answer
 *      without the flag re-anchors the wake clocks. A
 *      `computeMoveNeedsAttention` answer is deterministic and returns at once.
 *
 * @param {() => Promise<{ok: true} | {ok: false, errorCode: string, message?: string}>} issue
 *   Sends the request once. Must never throw.
 * @param {string} what For the log line only.
 * @param {string} [computerId] Scopes migration progress to this computer.
 */
async function withWakeAndOneRetry (issue, what, computerId, signal) {
    // `let`: the first answer after a move re-anchors it (rule 4 of contract §6.4).
    let t0 = Date.now();
    let retried = false;
    let asks = 0;
    let maxIssues = MAX_ISSUES;
    let deadline = t0 + WAKE_DEADLINE_MS;
    let migrationStartedAt = null;
    let launchStartedAt = null;
    let prepareStartedAt = null;
    let wakeResumed = false;
    // Phase B: the first moving answer (the move's own clock), the cap it set, whether the wake clocks were
    // re-anchored since the last moving answer, and the reads that asked nothing (bounded like the asks).
    let moveStartedAt = null;
    let moveMaxIssues = 0;
    let moveResumed = true;
    let moveReads = 0;
    const progressKey = Symbol();
    // 🔴 A CANCELLED LOOP NEVER ASKS AGAIN. Every ask runs the server's ensure,
    // and on an UNCONFIRMED + ENROLLMENT_FAILED placement that ensure launches a
    // replacement host. A window that has stopped waiting (needs_operator, its
    // ten-minute stop, a close) must not leave this loop asking behind its back.
    const cancelled = () => {
        migratingRequests.delete(progressKey);
        launchingRequests.delete(progressKey);
        preparingRequests.delete(progressKey);
        movingRequests.delete(progressKey);
        console.info(`[ezil-os:session] ${what}: cancelled by the caller after ${asks} ask(s); not asking again`);
        return { ok: false, errorCode: 'cancelled', message: 'Stopped asking: the caller cancelled.' };
    };

    try {
        for (;;) {
            if ( signal?.aborted ) return cancelled();
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
            if ( asks >= maxIssues ) {
                console.error(`[ezil-os:session] ${what}: refusing to ask a ${asks + 1}th time; stopping`);
                telemetry.capture({
                    eventClass: 'contract_violation', site: `ezil-os:session#${what}`, code: 'ask_cap_reached',
                    durationMs: Date.now() - t0, detail: `${asks} asks`,
                });
                return { ok: false, errorCode: 'unknown', message: 'Gave up asking the server.' };
            }
            asks++;
            const res = await issue();
            // Checked before anything reads `res`: an aborted request surfaces as a
            // transport failure, which would otherwise buy the one silent re-ask.
            if ( signal?.aborted ) return cancelled();
            const now = Date.now();
            // 🔴 PHASE B FIRST (§6.4 rules 2 and 6), before the migrating, launching and preparing branches and the
            // `sandbox_starting` deadline: none of their clocks may end a move. Keyed on the flags only, never `error`.
            if ( res.ok !== true && res.computeMoveNeedsAttention === true ) {
                // The blocked answer is deterministic (`preconditions_unmet`): no silent re-ask, no wait.
                movingRequests.delete(progressKey);
                console.info(`[ezil-os:session] ${what}: the computer's move needs attention; not asking again`);
                return res;
            }
            if ( res.ok !== true && res.computeMoving === true ) {
                migratingRequests.delete(progressKey);
                launchingRequests.delete(progressKey);
                preparingRequests.delete(progressKey);
                if ( computerId ) movingRequests.set(progressKey, computerId);
                if ( moveStartedAt === null ) {
                    moveStartedAt = now;
                    moveMaxIssues = asks - 1 + MOVE_MAX_ISSUES;
                    console.info(`[ezil-os:session] ${what}: the computer's files are moving to its Free computer;`
                        + ` asking again at most every ${MOVE_REASK_MS}ms while the move runs`);
                }
                // Replaced, never raised from a wake clock: the move's own bound, from its first answer.
                deadline = moveStartedAt + MOVE_WATCH_MS;
                maxIssues = moveMaxIssues;
                moveResumed = false;
                // Rule 3: only a progress read says whether asking is safe. Without the computer there is none.
                if ( ! computerId ) return res;
                for (;;) {
                    if ( Date.now() >= deadline ) {
                        // Rule 5: "still working on it", never a failure. The caller reads the move itself.
                        console.warn(`[ezil-os:session] ${what}: the move is still running after ${Date.now() - moveStartedAt}ms; handing back its last answer`);
                        telemetry.capture({
                            eventClass: 'api_failure', site: `ezil-os:session#${what}`, code: 'computer_moving',
                            durationMs: Date.now() - moveStartedAt, detail: `move watch spent after ${asks} asks`,
                        });
                        return res;
                    }
                    await pause(MOVE_REASK_MS, signal);
                    if ( signal?.aborted ) return cancelled();
                    // The same structural backstop as `maxIssues`, for the reads that ask nothing.
                    if ( ++moveReads > MOVE_MAX_ISSUES ) {
                        console.error(`[ezil-os:session] ${what}: refusing to read the move a ${moveReads}th time; stopping`);
                        telemetry.capture({
                            eventClass: 'contract_violation', site: `ezil-os:session#${what}`, code: 'move_read_cap_reached',
                            durationMs: Date.now() - t0, detail: `${moveReads - 1} reads`,
                        });
                        return res;
                    }
                    const next = await readMoveAsk(computerId, signal);
                    if ( signal?.aborted ) return cancelled();
                    if ( next === 'ask' ) break;
                    if ( next === 'stop' ) {
                        // Never auto-open the AWS computer: the caller shows the outcome and the user chooses.
                        console.info(`[ezil-os:session] ${what}: the move ended without moving the files; not asking again`);
                        return res;
                    }
                    // 'wait': the read is no evidence the move is in flight, so it is never an ask.
                }
                continue;
            }
            movingRequests.delete(progressKey);
            if ( ! moveResumed ) {
                // Rule 4: the first answer without the flag after a moving one (the commit's open of the Free
                // computer) re-anchors the loop, as `wakeResumed` does after a forward migration.
                moveResumed = true;
                t0 = now;
                deadline = now + WAKE_DEADLINE_MS;
                maxIssues = asks - 1 + AWS_MAX_ISSUES;
                prepareStartedAt = null;
                launchStartedAt = null;
            }
            const migrating = res.ok !== true && res.errorCode === 'sandbox_starting'
                && res.computeProvider === 'aws-ec2' && res.computeMigrating === true;
            if (migrating) {
                if (computerId) migratingRequests.set(progressKey, computerId);
                if (migrationStartedAt === null) {
                    migrationStartedAt = now;
                    deadline = migrationStartedAt + MIGRATION_DEADLINE_MS;
                    maxIssues = asks - 1 + MIGRATION_MAX_ISSUES;
                }
            } else {
                migratingRequests.delete(progressKey);
                if (migrationStartedAt !== null && !wakeResumed) {
                    wakeResumed = true;
                    deadline = now + WAKE_DEADLINE_MS;
                    maxIssues = asks - 1 + AWS_MAX_ISSUES;
                }
            }
            const launching = res.ok !== true && res.errorCode === 'sandbox_starting'
                && res.computeProvider === 'aws-ec2' && res.computeLaunching === true;
            if (launching && !migrating) {
                if (computerId) launchingRequests.set(progressKey, computerId);
                if (launchStartedAt === null) {
                    launchStartedAt = now;
                    deadline = Math.max(deadline, launchStartedAt + LAUNCH_DEADLINE_MS);
                    maxIssues = Math.max(maxIssues, asks - 1 + LAUNCH_MAX_ISSUES);
                }
            } else {
                launchingRequests.delete(progressKey);
            }
            // Seam C: the computer's desktop is taking this host boot's config (or code-server is starting after
            // it). Round 6a (C2): the FIRST such answer also bounds the wait by the Worker's own verdict
            // (PREPARE_DEADLINE_MS from now), once per loop, never shortening it and never past the ten-minute
            // ceiling. The deadline is the loop's whatever the caller; only the surface's flag needs the id.
            const preparing = res.ok !== true && res.errorCode === 'sandbox_starting'
                && res.computeProvider === 'aws-ec2' && res.computePreparing === true;
            if (preparing) {
                if (computerId) preparingRequests.set(progressKey, computerId);
                if (prepareStartedAt === null) {
                    prepareStartedAt = now;
                    deadline = Math.max(deadline, Math.min(prepareStartedAt + PREPARE_DEADLINE_MS, t0 + LAUNCH_DEADLINE_MS));
                    maxIssues = Math.max(maxIssues, asks - 1 + PREPARE_MAX_ISSUES);
                }
            }
            if ( res.ok === true ) return res;

            if ( res.errorCode === 'sandbox_starting' ) {
                // Never lowers a cap a preparing answer raised (this runs on every starting answer).
                if (res.computeProvider === 'aws-ec2' && migrationStartedAt === null && launchStartedAt === null) maxIssues = Math.max(maxIssues, AWS_MAX_ISSUES);
                const waited = now - t0;
                if ( now >= deadline ) {
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
                await pause(WAKE_REASK_MS, signal);
                continue;
            }

            // A genuine failure. One silent re-ask if a second attempt could
            // plausibly answer differently, then hand it to the user. Round 4: a
            // `billing_*` refusal never qualifies (`isRetryableBootErrorCode`);
            // only `billing_unavailable` does.
            if ( ! retried && ! TERMINAL_ERROR_CODES.includes(res.errorCode)
                 && isRetryableBootErrorCode(res.errorCode) ) {
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
                await pause(RETRY_DELAY_MS, signal);
                continue;
            }
            return res;
        }
    } finally {
        migratingRequests.delete(progressKey);
        launchingRequests.delete(progressKey);
        preparingRequests.delete(progressKey);
        movingRequests.delete(progressKey);
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
 * @param {string} computerId
 * @param {{width:number, height:number}} [screen] The shape to boot the
 *   desktop at, in device pixels — see `apps/desktop-screen.js`'s
 *   `measureDesktopBox`. OPTIONAL in both directions: an older server ignores
 *   an unknown body field, and this client omits the field entirely when it
 *   has nothing to measure, so neither side has to know about the other.
 * @returns {Promise<{ok: true, url: string, frameConfirmed: boolean, controlMode?: string, mode?: string, workspace?: any, screen?: {width:number,height:number,source:string}}
 *                  | {ok: false, errorCode: string, message?: string}>}
 */
export async function openDesktop (computerId, screen, { signal } = {}) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to open.' };
    }
    // Every open is cancellable three ways: by the caller's own `signal`, by
    // `cancelOpenDesktop(computerId)` — which also reaches an open the caller
    // did not start itself (the paint-time warm, via `warm.js`) — and by
    // `cancelComputerOpens` (Stop/Delete, after the windows close).
    return cancellableWake(computerId, 'openDesktop', (s) => openDesktopOnce(computerId, screen, s), { signal });
}

/**
 * In-flight wake loops that can reach the server's `ensure()` — `openDesktop`,
 * `previewUrl` and the Code window's mint — so a caller can stop every one for a
 * computer. Each entry: `{computerId, what, cancel, done}`.
 */
const openCancels = new Map();

/**
 * 🔴 HOTFIX r5 (ACCEPT-11865d06 B6): `withWakeAndOneRetry`, registered and
 * cancellable. Every ask of these routes runs the server's `ensure()`, which on a
 * STOPPED computer STARTS it. A loop that outlives its window (closed by Stop)
 * kept asking every 1.5 s and re-provisioned the computer 0.23 s after the stop
 * confirmed. `issue(signal)` sends one request with that signal; the loop stops
 * at once when the caller's `signal` aborts or `cancelComputerOpens` reaches it.
 *
 * @param {string} computerId
 * @param {string} what The loop's name ('openDesktop' | 'previewUrl' | 'codePreviewUrl').
 * @param {(signal: AbortSignal) => Promise<any>} issue One request. Must never throw.
 * @param {{signal?: AbortSignal}} [opts]
 */
export function cancellableWake (computerId, what, issue, { signal } = {}) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if ( signal?.aborted ) cancel(); else signal?.addEventListener?.('abort', cancel, { once: true });
    const key = Symbol();
    const entry = { computerId, what, cancel, done: null };
    openCancels.set(key, entry);
    entry.done = (async () => {
        try {
            return await withWakeAndOneRetry(() => issue(controller.signal), what, computerId, controller.signal);
        } finally {
            openCancels.delete(key);
            signal?.removeEventListener?.('abort', cancel);
        }
    })();
    return entry.done;
}

/**
 * Stop every in-flight `openDesktop` for `computerId`: each stops asking at once
 * (its request on the wire is aborted where the engine allows) and resolves
 * `{ok: false, errorCode: 'cancelled'}`. `warm.js` drops a failed entry, so a
 * cancelled warm is never replayed. Returns how many were cancelled.
 *
 * @param {string} computerId
 */
export function cancelOpenDesktop (computerId) {
    let n = 0;
    for ( const entry of openCancels.values() ) {
        if ( entry.what === 'openDesktop' && entry.computerId === computerId ) { entry.cancel(); n++; }
    }
    return n;
}

/**
 * Stop/Delete: cancel EVERY wake loop (desktop, Preview, Code) for `computerId`
 * — or, with no id, for every computer except `keep` — and resolve once each has
 * returned, so no further ask can reach `ensure()` after this settles. A loop
 * whose request is already on the wire returns when that request is aborted (or,
 * on an engine without `AbortSignal.any`, answers); callers bound the wait.
 *
 * @param {string} [computerId]
 * @param {{keep?: string}} [opts]
 * @returns {Promise<number>} how many loops were cancelled
 */
export async function cancelComputerOpens (computerId, { keep } = {}) {
    const hit = [...openCancels.values()].filter(entry => computerId !== undefined
        ? entry.computerId === computerId
        : keep === undefined || entry.computerId !== keep);
    for ( const entry of hit ) entry.cancel();
    await Promise.allSettled(hit.map(entry => entry.done));
    return hit.length;
}

/**
 * Computers the owner stopped from Settings in this page.
 *
 * 🔴 HOTFIX r5 (review of ACCEPT-11865d06 B6): every hover-warm (`warm.js`) is a
 * `POST /api/shell/desktop`, which runs the server's `ensure()` — and on a
 * STOPPED computer that STARTS it. After Settings → Stop, merely moving the
 * pointer over the Browser dock icon (or its Start-menu entry) restarted the
 * computer the owner had just stopped. So a stopped computer is never warmed
 * until the owner opens it on purpose (the desktop window's `claim()`, which
 * calls `releaseStopHold`). No timer: a hover a minute later would be the same
 * restart, only later. A reload forgets it; the page then starts cold anyway.
 */
const stoppedHolds = new Set();

/** Settings → Stop, confirmed: no hover-warm may start `computerId` again until an explicit open. */
export function holdAfterStop (computerId) {
    if ( computerId ) stoppedHolds.add(computerId);
}

/** An explicit open of `computerId` (Browser window, Settings → Open desktop): hover may warm it again. */
export function releaseStopHold (computerId) {
    stoppedHolds.delete(computerId);
}

/** True while `computerId` is held by `holdAfterStop`. */
export function stoppedByUser (computerId) {
    return stoppedHolds.has(computerId);
}

// Local preview routes currently only mint URLs for a running container. Code
// and Preview must pay the same cold start as Browser, even when opened first.
const localStarts = new Map();
export async function ensureLocalDesktop (computerId) {
    if ( payload()?.desktopState?.provider !== 'local-vm' ) return { ok: true };
    if ( ! localStarts.has(computerId) ) {
        const start = openDesktop(computerId).finally(() => localStarts.delete(computerId));
        localStarts.set(computerId, start);
    }
    return localStarts.get(computerId);
}

/** One `POST /api/shell/desktop`. The loop that may call it more than once is above. */
async function openDesktopOnce (computerId, screen, signal) {
    // 🔴 The field is OMITTED, not sent as null, when there is nothing to ask
    // for. The server treats absent and malformed identically, but a body that
    // is byte-identical to the pre-change one is the strongest form of "an old
    // server sees exactly what it always saw".
    const usable = screen
        && Number.isInteger(screen.width) && Number.isInteger(screen.height)
        && screen.width > 0 && screen.height > 0;
    const res = await request(endpoint('desktop'), {
        method: 'POST',
        body: usable
            ? { computerId, screen: { width: screen.width, height: screen.height } }
            : { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
        signal,
    });

    if ( ! res.ok ) {
        if ( res.code === 'CANCELLED' ) return { ok: false, errorCode: 'cancelled', message: res.message };
        // Transport/HTTP failure. `TIMEOUT` is the one code `previewUrl`
        // itself can never produce and the boot UI has real copy for.
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        // 🔴 A 502/504 IS A CLASSIFIED FAILURE, NOT AN UNKNOWN ONE. The route
        // handler re-emits tRPC's own code verbatim (`shellErrorResponse`), so
        // `previewUrl`'s `BAD_GATEWAY` throw — "the desktop Worker returned an
        // error" — arrived here as `unknown` and was rendered with the generic
        // "if it keeps happening, let us know" copy. `fetch_failed` is the
        // `BootErrorCode` that `classifyFailure` maps to `worker_unreachable`,
        // which is what actually happened and what the user can act on.
        if ( res.code === 'BAD_GATEWAY' || res.code === 'GATEWAY_TIMEOUT' ) {
            return { ok: false, errorCode: 'fetch_failed', message: res.message };
        }
        return { ok: false, errorCode: 'unknown', message: res.message };
    }

    // `previewUrl` returns operational + deterministic failures as VALUES on
    // a 200, so that a retrying client cannot re-ask a question whose answer
    // is fixed. Pass the code straight through; `classifyFailure` in
    // boot-phases.js owns the mapping to user-facing copy.
    const data = res.data ?? {};
    if ( data.ok !== true ) {
        // 🔴 `data.error` IS CARRIED, and it used to be dropped on the floor.
        // That is why ten production `desktop_unreachable` failures were
        // indistinguishable from each other: the server had said
        // `desktop_frame_http_error_404` vs `_410` vs `_500`, and this line
        // kept only the errorCode, so nothing downstream could say WHICH. The
        // code still drives the UI copy — nothing about the rendering changes
        // — but the observation now survives the trip.
        return {
            ok: false,
            errorCode: data.errorCode ?? 'unknown',
            computeProvider: data.computeProvider,
            ...(data.computeMigrating === true ? { computeMigrating: true } : {}),
            ...(data.computeLaunching === true ? { computeLaunching: true } : {}),
            // Phase B (§6.4 rule 1): `previewUrl` is where the next-open move starts; its answers carry the move.
            ...(data.computeMoving === true ? { computeMoving: true } : {}),
            ...(data.computeMoveNeedsAttention === true ? { computeMoveNeedsAttention: true } : {}),
            ...capacityAttemptOf(data),
            message: typeof data.error === 'string' ? data.error : undefined,
        };
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
        relay: data.relay,
        // 🔴 Whether the SERVER observed the desktop origin answering, before
        // it handed this URL over. Strict `=== true`, and never defaulted to
        // true: a response that omits the field is a server that did not check,
        // and `computeBootUiState` must treat that as "not confirmed" rather
        // than inherit the old assumption that a URL implies a desktop.
        frameConfirmed: data.frame?.confirmed === true,
        controlMode: data.controlMode,
        mode: data.mode,
        workspace: data.workspace,
        // 🔴 What the server says it ACTUALLY booted the desktop at, passed
        // through raw and NEVER defaulted here. An older server omits it, and
        // the window must read that as "I still know nothing about the stream's
        // shape" (i.e. keep assuming 1920x1080, exactly as before) rather than
        // as any particular size. `apps/desktop-screen.js`'s
        // `readAppliedScreen` is the one validator.
        screen: data.screen,
        // Round 6 (CR-3): which provider answered ('aws-ec2' for an AWS computer), as the
        // refusal branch above already carries it. `desktopState.provider` cannot say.
        computeProvider: data.computeProvider,
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
/**
 * A not-ok preview body for the wake loop. Preserve the provider and explicit
 * migration or fresh-launch signal so fast AWS replies receive the appropriate bounded budget.
 * Phase B: and the move flags, so Code's mint (`apps/code.js`) and Preview wait on a move as the desktop does.
 */
export function pendingOrRefused (data) {
    return { ok: false, errorCode: data?.errorCode ?? 'unknown', computeProvider: data?.computeProvider,
        ...(data?.computeMigrating === true ? { computeMigrating: true } : {}),
        ...(data?.computeLaunching === true ? { computeLaunching: true } : {}),
        ...(data?.computePreparing === true ? { computePreparing: true } : {}),
        ...(data?.computeMoving === true ? { computeMoving: true } : {}),
        ...(data?.computeMoveNeedsAttention === true ? { computeMoveNeedsAttention: true } : {}),
        ...capacityAttemptOf(data) };
}

/** RETRY-118: only a `capacity_attempt_expired` answer carries the attempt an explicit Retry may reset. */
function capacityAttemptOf (data) {
    return data?.errorCode === 'capacity_attempt_expired' && typeof data.capacityAttemptId === 'string'
        && data.capacityAttemptId !== '' ? { capacityAttemptId: data.capacityAttemptId } : {};
}

export async function previewUrl (computerId, { signal } = {}) {
    if ( ! computerId ) {
        return { ok: false, errorCode: 'bad_request', message: 'No computer to preview.' };
    }
    // Cancellable: the Preview window's close and Stop (`cancelComputerOpens`) end it.
    return cancellableWake(computerId, 'previewUrl', (s) => previewUrlOnce(computerId, s), { signal });
}

/** One `POST /api/shell/preview-url`. The loop that may call it more than once is above. */
async function previewUrlOnce (computerId, signal) {
    const started = await ensureLocalDesktop(computerId);
    if ( ! started.ok ) return started;
    const res = await request(endpoint('previewUrl'), {
        method: 'POST',
        body: { computerId },
        timeoutMs: DESKTOP_BOOT_TIMEOUT_MS,
        signal,
    });

    if ( ! res.ok ) {
        if ( res.code === 'CANCELLED' ) return { ok: false, errorCode: 'cancelled', message: res.message };
        if ( res.code === 'TIMEOUT' ) return { ok: false, errorCode: 'timeout', message: res.message };
        if ( res.code === 'NETWORK' ) return { ok: false, errorCode: 'fetch_failed', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, errorCode: 'unauthorized', message: res.message };
        return { ok: false, errorCode: 'unknown', message: res.message };
    }

    const data = res.data ?? {};
    if ( data.ok !== true ) return pendingOrRefused(data);
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
export async function confirmFrame (computerId, frameUrl, surface = 'desktop') {
    return (await observeFrame(computerId, frameUrl, surface)).confirmed;
}

/**
 * Keep the authenticated probe's transient failure evidence for Code's bounded
 * recovery. The boolean API above still exposes just the health verdict.
 * A retryable negative is still unconfirmed; OUR refusals never qualify.
 *
 * Two different HTTP statuses meet here and are never mixed:
 *   - `routeStatus` is OUR app route's (`/api/shell/desktop`) status. A 401/403
 *     there is our own auth refusing — terminal, reported as `route_refused`.
 *   - `status` is the ORIGIN's, as the server's probe read it (`data.status`).
 *
 * 🔴 Follow-up r5 (ACCEPT-9a755827 e2e-standard A3): on the code surface ANY
 * origin `http_error` is retryable, not just 500-504. The hops in front of a
 * booting code-server answer fast and wrong during the transition — the
 * Worker's AWS preview auth (401), the host edge (401 on a gw1 binding or clock
 * skew, 404 on an unknown path), a stale route (410), the tunnel (52x/530) —
 * and Code used to stop on the first such answer with ~44 s of its 45 s budget
 * unused. The recovery stays bounded by Code's ask cap and deadline. The
 * server's own refusals (`not_own_origin`, `provider_not_configured`,
 * `bad_url`) and a reason-less negative stay terminal: asking again would get
 * the same answer. Desktop/Preview keep the original 500-504 rule.
 */
export async function observeFrame (computerId, frameUrl, surface = 'desktop') {
    const unknown = { confirmed: undefined, retryable: false };
    if ( ! computerId || ! frameUrl ) return unknown;
    const url = `${endpoint('desktop')}?computerId=${encodeURIComponent(computerId)}`
        + `&confirm=frame&frameUrl=${encodeURIComponent(frameUrl)}`
        + (payload()?.desktopState?.provider === 'local-vm' ? `&surface=${encodeURIComponent(surface)}` : '');
    const res = await request(url, { timeoutMs: STATUS_TIMEOUT_MS });
    // An HTTP authentication/authorization refusal is an answer, even if the
    // response body is absent, non-JSON, or claims success. Never retry it.
    if ( ! res.ok ) {
        return res.status === 401 || res.status === 403
            ? { confirmed: false, retryable: false, reason: 'route_refused', routeStatus: res.status }
            : unknown;
    }
    const data = res.data;
    const status = Number.isInteger(data?.status) ? data.status : undefined;
    const reason = typeof data?.reason === 'string' ? data.reason : undefined;
    if ( surface === 'code' && data?.confirmed === true ) {
        // Both hosted/local HTTP probes return a successful status and omit
        // reason on success. A malformed or contradictory positive must not
        // release Code's overlay, including after its recovery navigation.
        const confirmed = data.ok === true && Number.isInteger(data.status)
            && data.status >= 200 && data.status < 400 && !Object.hasOwn(data, 'reason');
        return { confirmed, retryable: false, reason, status };
    }
    if ( data?.ok !== true ) return unknown;
    const transient = reason === 'unreachable' || (reason === 'http_error'
        && (surface === 'code' || [500, 502, 503, 504].includes(data.status)));
    return {
        confirmed: data.confirmed === true,
        retryable: data.confirmed === false && transient,
        reason,
        status,
    };
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
 * RETRY-118. Is the explicit capacity Retry route published by THIS deployment?
 * Feature-detected exactly like `restartEndpoint()`: the payload only, never an
 * invented path. Absent → a Retry simply reopens (the pre-RETRY-118 behaviour).
 *
 * @returns {string|null}
 */
export function capacityRetryEndpoint () {
    const url = payload()?.desktopState?.endpoints?.capacityRetry;
    return typeof url === 'string' && url !== '' ? url : null;
}

const capacityResetsInFlight = new Map();

/** The only reset outcomes the server can answer, and the app-level `ok` each must carry. */
const CAPACITY_RESET_OUTCOMES = { reset: true, already_reset: true, superseded: true, not_found: false };

/**
 * Strictly read a `POST <endpoints.capacityRetry>` reply. Only an app-level `ok`
 * consistent with a known outcome counts; anything else (an `ok:false` claiming
 * `reset`, a missing or unknown outcome, a non-object body) is `malformed_reply`.
 * Exported for tests.
 *
 * @returns {{reset: boolean, outcome?: string, errorCode?: string}}
 */
export function readCapacityResetReply (data) {
    const outcome = data && typeof data === 'object' ? data.outcome : undefined;
    if ( typeof outcome !== 'string' || ! Object.prototype.hasOwnProperty.call(CAPACITY_RESET_OUTCOMES, outcome)
        || data.ok !== CAPACITY_RESET_OUTCOMES[outcome] ) {
        return { reset: false, errorCode: 'malformed_reply' };
    }
    return { reset: outcome === 'reset', outcome };
}

/**
 * RETRY-118: the ONE place an explicit user "Try again" resets an expired capacity
 * attempt. Call it ONLY from a user's Retry handler, with the failure that is on
 * screen; never from polling, the wake loop or a transport retry (those keep
 * `capacity_attempt_expired` terminal: `isRetryableBootErrorCode` is false for it).
 *
 * - Not a `capacity_attempt_expired` failure with a stored id, or the route not
 *   published: no request (`{ reset: false }`), and the caller reopens as before.
 * - Otherwise exactly one `POST <endpoints.capacityRetry>` per computer AND attempt
 *   at a time: every caller for that attempt (any window) joins the same request.
 * - The reply is read strictly (`readCapacityResetReply`); a transport failure is
 *   `{ reset: false, errorCode }`. Callers reopen whatever this answers: the
 *   server's next answer is the truth, never this one.
 *
 * @returns {Promise<{reset: boolean, outcome?: string, errorCode?: string}>}
 */
export function retryCapacityAttempt (computerId, failure) {
    const attemptId = failure?.errorCode === 'capacity_attempt_expired' ? failure.capacityAttemptId : null;
    const url = capacityRetryEndpoint();
    if ( ! computerId || typeof attemptId !== 'string' || attemptId === '' || ! url ) {
        return Promise.resolve({ reset: false });
    }
    const key = `${computerId}|${attemptId}`;
    const inFlight = capacityResetsInFlight.get(key);
    if ( inFlight ) return inFlight;
    const pending = request(url, { method: 'POST', body: { computerId, attemptId }, timeoutMs: STATUS_TIMEOUT_MS })
        .then((res) => {
            if ( ! res.ok ) {
                return { reset: false, errorCode: res.code === 'TIMEOUT' ? 'timeout' : res.code === 'NETWORK' ? 'fetch_failed'
                    : res.code === 'UNAUTHORIZED' ? 'unauthorized' : 'request_failed' };
            }
            return readCapacityResetReply(res.data);
        }, () => ({ reset: false, errorCode: 'fetch_failed' }))
        .finally(() => capacityResetsInFlight.delete(key));
    capacityResetsInFlight.set(key, pending);
    return pending;
}

/** computer|attempt -> the reopen callbacks still owed one reopen when that reset settles. */
const reopensOwed = new Map();

/**
 * RETRY-118: what every surface's user-facing "Try again" calls, with the failure it
 * is showing and ITS OWN stable reopen callback (defined once per window, so a double
 * click is recognisable). Shared so Desktop, Code and Preview behave identically.
 * - Anything but `capacity_attempt_expired` with a stored id (or no published route):
 *   reopens immediately, exactly as before.
 * - Otherwise the RESET is shared per computer+attempt (one request, whichever window
 *   clicks), and every window whose Retry was clicked is reopened exactly once after
 *   it settles, whatever the outcome. A second click in the same window while that
 *   is pending joins it (no second reset, no second reopen). A window closed in the
 *   meantime is skipped by its own callback (`disposed`), never at another's expense.
 * Never call this from polling, a wake loop or an automatic retry.
 *
 * @returns {Promise<{reset: boolean, outcome?: string, errorCode?: string}>}
 */
export function userRetry (computerId, failure, reopen) {
    const expired = failure?.errorCode === 'capacity_attempt_expired' && typeof failure.capacityAttemptId === 'string'
        && failure.capacityAttemptId !== '' && capacityRetryEndpoint() !== null && !! computerId;
    if ( ! expired ) { reopen(); return Promise.resolve({ reset: false }); }
    const key = `${computerId}|${failure.capacityAttemptId}`;
    const shared = retryCapacityAttempt(computerId, failure);
    let owed = reopensOwed.get(key);
    if ( owed?.has(reopen) ) return shared; // the same window's second click: joined
    if ( ! owed ) { owed = new Set(); reopensOwed.set(key, owed); }
    owed.add(reopen);
    return shared.then((result) => {
        owed.delete(reopen);
        if ( owed.size === 0 && reopensOwed.get(key) === owed ) reopensOwed.delete(key);
        reopen();
        return result;
    });
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

/**
 * How stale a presence report has to be for the server's idle-stop path to
 * treat it as "nobody is here any more" — the value {@link releaseDesktop}
 * puts on the wire.
 *
 * 🔴 THIS IS NOT A NEW LIFECYCLE VERB, AND IT MUST NOT BECOME ONE. The shell
 * has never had the power to destroy a container and this does not give it
 * one. All it can say is the one thing the activity transport has always been
 * able to say — "the user was last here N ms ago" — with an N that means
 * "they have gone". The Worker's `EzilSandboxDO.recordActivity` writes
 * `now - N` to `LAST_ACTIVITY_AT_KEY` and its own idle-stop path
 * (`isIdleStopDue`, `IDLE_STOP_MS` = 10 minutes, PLUS a `/proc/loadavg` busy
 * probe, PLUS a successful final workspace flush) decides on its own whether
 * that means stop. A release is a fact reported, not an order given, and
 * every safety rule on the server side still applies to it unchanged.
 *
 * The number is `ACTIVITY_FRESH_MS` (30 minutes — `../activity-heartbeat.js`'s
 * own definition of "the tab is open but nobody is there"), not a bespoke
 * constant, and deliberately not `Infinity`/`Number.MAX_SAFE_INTEGER`: the
 * server's `computeActivityTimestamp` subtracts it from `Date.now()`, so a
 * silly value would write a nonsense timestamp for anyone reading DO storage
 * later. 30 minutes is 3x the server's 10-minute idle window, so the release
 * is due IMMEDIATELY on the next flush alarm (<=60s) whatever that window is
 * retuned to, while still being a duration a human could actually have been
 * away for.
 *
 * Imported rather than redeclared so there is exactly one definition of "long
 * enough ago to count as absent" in the shell.
 */
const RELEASE_PRESENCE_AGO_MS = ACTIVITY_FRESH_MS;

/**
 * `POST <endpoints.activity>` — report that presence at this desktop has
 * ENDED, because the window showing it was closed.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `apps/desktop-window.js`'s `dispose()` used to stop the heartbeat and
 * nothing else, so closing a desktop window released nothing at all: the
 * container then sat until the Worker's own `IDLE_STOP_MS` (10 minutes) plus
 * an alarm tick noticed the beats had stopped. This is the shell saying so
 * out loud instead of letting a ten-minute silence say it.
 *
 * ── Why it is `reportActivity` and not a new verb ───────────────────────────
 * See {@link RELEASE_PRESENCE_AGO_MS}. Same route, same body shape, same
 * server handler, same DO write — an OLDER server needs no change at all to
 * honour this, and a NEWER server gains no capability it did not already
 * have. The only difference from a heartbeat is the number, and the number is
 * one the server has always had to be able to handle (a user who really has
 * been away 30 minutes with the tab open sends it too).
 *
 * ── Contract with the caller ────────────────────────────────────────────────
 * NEVER THROWS and NEVER BLOCKS A CLOSE. The caller fires this and does not
 * await it: a user who closes a window gets a closed window whether or not
 * this request ever lands. Feature-detected exactly like `reportActivity`
 * above — a deployment that does not publish `endpoints.activity` gets NO
 * request, never a 404 sprayed at a path this bundle invented.
 *
 * 🔴 NOT called on minimise. A minimised desktop is still open and still
 * heartbeating; releasing it would stop a container the user is coming back
 * to. `apps/desktop-window.js`'s `minimise_to_taskbar` deliberately does not
 * reach this, and must not learn to.
 *
 * @param {string} computerId
 * @returns {Promise<boolean|undefined>} `true`/`false` is a real answer from
 *   the server. `undefined` means either OUR request never landed, or this
 *   deployment does not publish the endpoint at all — neither is an
 *   observation of anything, and in particular `undefined` is NOT "the
 *   container is still running".
 */
export async function releaseDesktop (computerId) {
    return reportActivity(computerId, RELEASE_PRESENCE_AGO_MS);
}

/**
 * Is a LIVE screen-resize route published by THIS deployment, right now?
 *
 * 🔴 FEATURE-DETECTED, and read from the PAYLOAD only — never from the
 * `ENDPOINTS` mirror, even though `screen` appears there. Same rule as
 * `restartEndpoint()` and `activityEndpoint()` above, and the same rule
 * `apps/desktop-window.js` applies to `endpoints.focus`:
 * `payload().desktopState.endpoints` is the only source of truth for "can the
 * server actually do this today". The mirror exists so the path is written
 * down in one canonical place next to its siblings, not so a newer bundle can
 * invent a route against an older server.
 *
 * 🔴 BOOT-TIME SIZING DOES NOT DEPEND ON THIS. That travels on the existing
 * `openDesktop` call and needs no new route, so a deployment without this key
 * still opens the desktop at the right shape — it just cannot change it
 * afterwards, and the window letterboxes as it always did.
 *
 * @returns {string|null}
 */
export function screenEndpoint () {
    const url = payload()?.desktopState?.endpoints?.screen;
    return typeof url === 'string' && url !== '' ? url : null;
}

/**
 * `POST <endpoints.screen>` — ask the server to change this computer's LIVE
 * desktop to a different screen mode.
 *
 * The server snaps whatever it is given to the closed mode table and reports
 * BACK what it applied, so `width`/`height` in the answer are authoritative
 * and may differ from what was asked. A caller that letterboxes to its own
 * request rather than to the answer reproduces the exact defect this whole
 * change exists to fix.
 *
 * NEVER THROWS. Every failure — including "this deployment has no such route"
 * — comes back as `{ok:false, code}` from the closed set
 * `BAD_REQUEST|NOT_FOUND|UNSUPPORTED|UPSTREAM|TIMEOUT`, so a caller can tell
 * "stop asking forever" (`UNSUPPORTED`: the container's X server has a fixed
 * framebuffer) from "that one attempt failed".
 *
 * @returns {Promise<{ok:true, width:number, height:number, source:string}
 *                 | {ok:false, code:string, message?:string}>}
 */
/**
 * `GET <endpoints.screen>?computerId=…` — what the desktop's screen ACTUALLY
 * is right now, without changing it.
 *
 * 🔴 WHY A READ IS NEEDED AT ALL. `setScreen` is the only other way to learn
 * this, and it costs a capture-pipeline restart. That made the shell unable to
 * correct itself: `desktop-window.js` writes its `stream` size twice (boot
 * read-back, successful resize) and the controller seeds its dedup with the
 * boot ask, so when the container's screen moves WITHOUT the shell asking —
 * a troubleshoot restart resets it to 1920x1080; a warm container is handed to
 * a window that never sized it — every later measurement is dropped as settled
 * against a belief that is false, and the picture stays letterboxed to an
 * aspect the stream does not have.
 *
 * NEVER THROWS, same closed code set as `setScreen`. A failed reconcile must
 * leave the caller exactly as it was: the belief it holds may be stale, but a
 * stale belief is strictly better than a guess, and better than a throw on a
 * restore path.
 *
 * @returns {Promise<{ok:true, width:number, height:number, source:string}
 *                 | {ok:false, code:string, message?:string}>}
 */
export async function getScreen (computerId, timeoutMs = SCREEN_TIMEOUT_MS) {
    if ( ! computerId ) {
        return { ok: false, code: 'BAD_REQUEST', message: 'No computer.' };
    }
    const url = screenEndpoint();
    if ( ! url ) {
        return { ok: false, code: 'UNSUPPORTED', message: "Resizing isn't available in this deployment." };
    }

    const sep = url.includes('?') ? '&' : '?';
    const res = await request(`${url}${sep}computerId=${encodeURIComponent(computerId)}`, { method: 'GET', timeoutMs });
    if ( ! res.ok ) {
        if ( res.code === 'TIMEOUT' ) return { ok: false, code: 'TIMEOUT', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, code: 'NOT_FOUND', message: res.message };
        // A deployment whose POST exists but whose GET does not is a real
        // state — the two shipped in different releases. UNSUPPORTED so the
        // caller stops asking rather than retrying a route that will not
        // appear mid-session.
        if ( res.status === 404 || res.status === 405 ) {
            return { ok: false, code: 'UNSUPPORTED', message: res.message };
        }
        return { ok: false, code: 'UPSTREAM', message: res.message };
    }

    const data = res.data ?? {};
    if ( data.ok !== true ) {
        const code = typeof data.error?.code === 'string' ? data.error.code : 'UPSTREAM';
        return { ok: false, code, message: data.error?.message };
    }
    if ( ! Number.isInteger(data.width) || ! Number.isInteger(data.height) ) {
        return { ok: false, code: 'UPSTREAM', message: 'The server reported a screen it did not name.' };
    }
    return { ok: true, width: data.width, height: data.height, source: data.source ?? 'observed' };
}

/**
 * `GET <endpoints.system>?computerId=…` — what Settings → System may say about
 * the machine behind a computer: recorded provider, configured size, lifecycle
 * state. Read only on the server; it never assigns a provider.
 *
 * NEVER THROWS. `UNSUPPORTED` when this deployment has no `system` endpoint (a
 * shell newer than its server), so the tab says "not available" instead of
 * calling a URL it invented.
 *
 * @returns {Promise<{ok:true, info:object} | {ok:false, code:string, message?:string}>}
 */
export async function getSystemInfo (computerId, timeoutMs = SCREEN_TIMEOUT_MS) {
    if ( ! computerId ) return { ok: false, code: 'BAD_REQUEST', message: 'No computer.' };
    const url = payload()?.desktopState?.endpoints?.system;
    if ( typeof url !== 'string' || url === '' ) return { ok: false, code: 'UNSUPPORTED' };
    const sep = url.includes('?') ? '&' : '?';
    const res = await request(`${url}${sep}computerId=${encodeURIComponent(computerId)}`, { method: 'GET', timeoutMs });
    if ( ! res.ok ) {
        if ( res.code === 'TIMEOUT' ) return { ok: false, code: 'TIMEOUT' };
        if ( res.code === 'UNAUTHORIZED' || res.status === 404 ) return { ok: false, code: 'NOT_FOUND' };
        return { ok: false, code: 'UPSTREAM' };
    }
    const data = res.data ?? {};
    if ( data.ok !== true || ! data.info || typeof data.info !== 'object' ) return { ok: false, code: 'UPSTREAM' };
    return { ok: true, info: data.info };
}

export async function setScreen (computerId, width, height, timeoutMs = SCREEN_TIMEOUT_MS) {
    if ( ! computerId || ! Number.isInteger(width) || ! Number.isInteger(height) ) {
        return { ok: false, code: 'BAD_REQUEST', message: 'No computer, or nothing measurable.' };
    }
    const url = screenEndpoint();
    if ( ! url ) {
        // Not published by this deployment — say so WITHOUT making a request,
        // and say it as UNSUPPORTED so the caller disarms permanently rather
        // than re-asking a server that will never grow the route mid-session.
        return { ok: false, code: 'UNSUPPORTED', message: "Resizing isn't available in this deployment." };
    }

    const res = await request(url, { method: 'POST', body: { computerId, width, height }, timeoutMs });
    if ( ! res.ok ) {
        if ( res.code === 'TIMEOUT' ) return { ok: false, code: 'TIMEOUT', message: res.message };
        if ( res.code === 'UNAUTHORIZED' ) return { ok: false, code: 'NOT_FOUND', message: res.message };
        // 404 from a route that is published but not deployed yet is the same
        // permanent state as "no key at all".
        if ( res.status === 404 ) return { ok: false, code: 'UNSUPPORTED', message: res.message };
        return { ok: false, code: 'UPSTREAM', message: res.message };
    }

    const data = res.data ?? {};
    if ( data.ok !== true ) {
        const code = typeof data.error?.code === 'string' ? data.error.code : 'UPSTREAM';
        return { ok: false, code, message: data.error?.message };
    }
    if ( ! Number.isInteger(data.width) || ! Number.isInteger(data.height) ) {
        // Reported success with nothing to fit to. Loud, not silent — the same
        // rule `openDesktopOnce` applies to a URL-less success.
        console.error('[ezil-os:session] setScreen returned ok with no size');
        telemetry.capture({
            eventClass: 'contract_violation', site: 'ezil-os:apps/desktop#screen', code: 'screen_size_missing',
        });
        return { ok: false, code: 'UPSTREAM', message: 'The server confirmed a size it did not name.' };
    }
    return { ok: true, width: data.width, height: data.height, source: data.source ?? 'requested' };
}

export { withWakeAndOneRetry };

export default {
    get, set, del,
    payload, currentComputer, setCurrentComputer,
    readSession, openSession,
    openDesktop, cancelOpenDesktop, cancellableWake, cancelComputerOpens, holdAfterStop, releaseStopHold, stoppedByUser, ensureLocalDesktop, desktopRunning, confirmFrame, observeFrame, confirmDisplay,
    previewUrl, pendingOrRefused, focusApp,
    restartEndpoint, restartDesktop,
    capacityRetryEndpoint, retryCapacityAttempt, readCapacityResetReply, userRetry,
    activityEndpoint, reportActivity, releaseDesktop,
    screenEndpoint, setScreen, getScreen, getSystemInfo,
    withWakeAndOneRetry, isComputeMigrating, isComputeLaunching, isComputePreparing, isComputeMoving,
    ENDPOINTS,
    DESKTOP_BOOT_TIMEOUT_MS,
};
