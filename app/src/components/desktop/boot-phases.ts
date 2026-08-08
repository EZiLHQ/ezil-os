/**
 * Boot phase state mapping for the desktop-boot experience.
 * (`docs/RUNBOOK.md` Wave B1, `docs/PLATFORM-NOTES.md` §11.)
 *
 * ── Honesty constraint ──────────────────────────────────────────────────────
 * The browser has exactly two genuine signals during a cold boot:
 *
 *   1. The `POST /sandbox/preview` request (`requestGuacamolePreview` in
 *      `cloudflare-guacamole-provider.ts`), which resolves ONLY at the very
 *      end — success or a specific error. Nothing about it is observable
 *      mid-flight.
 *
 *      🔴 It stopped being a SINGLE request on 2026-08-08, and the reason is
 *      worth knowing here. Containers hibernate when idle, and the wake
 *      outlives any sane request budget: measured, the first request after a
 *      hibernation blocked for 187s and then failed with something the browser
 *      could only call `unknown`, while the wake it had started went on to
 *      succeed. So the server now answers `sandbox_starting` at
 *      `SANDBOX_WAKE_ANSWER_BUDGET_MS` (12s) and the caller asks again
 *      (`withWakeAndOneRetry` in the shell, the `refetchInterval` in the
 *      canvas) until `WAKE_DEADLINE_MS`. That is not a new signal about the
 *      desktop — it says nothing this module may render as progress EARNED —
 *      it only means the estimate below gets to keep running honestly instead
 *      of being cut short by a dead socket.
 *   2. `GET /sandbox/:id/status` — cheap, does NOT wake a sleeping container,
 *      returns `{ ok, sandboxName, guacamoleRunning, mode }`. Polling it
 *      WHILE the preview request is in flight is safe (the container is
 *      already being woken by that request) and gives one real mid-boot
 *      fact: whether the desktop process has come up.
 *
 * ── The third signal, added after the contract was found to stop early ─────
 * The two signals above both describe the CONTAINER. Neither can see whether
 * the preview URL actually routes: `guacamoleRunning` is derived from
 * `sandbox.getExposedPorts()`, which reads Durable Object storage and never
 * goes through the edge. Observed live on 2026-07-31 — `guacamoleRunning: true`
 * while every request to the preview host returned HTTP 500 "Proxy routing
 * error", and both surfaces reported success over it. The iframe cannot close
 * the gap either: its `load` event fires for a 500 error page exactly as it
 * does for a working desktop.
 *
 *   3. A server-side HTTP probe of the DESKTOP ORIGIN itself
 *      (`probeDesktopFrame`, reached here as `frameConfirmed`). This is the
 *      only signal in the system that can distinguish a desktop from an error
 *      page, and `computeBootUiState` now requires it before it will say
 *      `ready`.
 *
 * ── The fourth signal, added after `ready` was measured over a blank screen ──
 * All three above are about REACHABILITY. None of them can see whether a
 * single frame of video was ever decoded, and measured under WebKit the gap
 * was total: the shell declared ready in 4.6s with `videoWidth: 0`,
 * `paused: true`, `srcObject: false`, and the user got a third-party spinner
 * under our checkmark. The browser cannot close it either — the desktop iframe
 * is cross-origin, so the `<video>` element is unreadable from the parent by
 * construction, not by difficulty.
 *
 *   4. Neko's own WebRTC bookkeeping, read server-side
 *      (`probeDesktopDisplay`, reached here as `DisplayEvidence`). Neko flips a
 *      per-session `is_watching` flag from its peer connection's `connected`
 *      state change, so it is the far end of the same pipe whose near end we
 *      are not allowed to look at. `applyDisplayEvidence` — deliberately a
 *      SECOND gate rather than a fourth input to `computeBootUiState` — is
 *      what turns it into UI.
 *
 * Everything shown before those signals land is a TIME-BASED ESTIMATE,
 * anchored to the measured reference boot in PLATFORM-NOTES §11
 * (container_start ~0.3s, workspace_mount ~5.9s, desktop_ready_wait ~15.3s,
 * total ~21.9s). `computeBootUiState` marks a phase `confirmed: true` ONLY
 * when it is backed by the real `guacamoleRunning` signal above — never on a
 * timer. Callers must not render a checkmark (or any "done" affordance)
 * unless `confirmed` is true; see `phaseVisualState`, which draws a hard line
 * between "estimated so far" (`passed`/`current`) and "actually observed"
 * (`confirmed`).
 *
 * `/preview-status` (the Option D dev-server bridge's readiness probe, with
 * its own `no_package_json` / `port_not_listening` / `crashed` /
 * `crash_looping` taxonomy in `worker/src/preview-bridge.ts`) is intentionally
 * NOT used here: it isn't wired to this app's desktop path at all (Neko, not
 * an in-sandbox dev server — see `cloudflare-guacamole-provider.ts`'s module
 * doc), and even if it were, it costs 6+ `sandbox.exec()` calls and wakes a
 * sleeping container, so it must never be polled speculatively. The failure
 * taxonomy below (`BootFailureReason`) instead maps the error codes this
 * app's actual boot path (`GuacamolePreviewErrorCode`) can genuinely produce,
 * plus a real client-side `timeout` (the `AbortSignal.timeout` this app's own
 * fetch already carries — see `classifyPreviewFetchError` below).
 */

export type BootPhaseId = 'waking' | 'mounting' | 'starting' | 'connecting';

export interface BootPhaseDef {
    id: BootPhaseId;
    /** Plain, user-facing label — never internal jargon like "container_start". */
    label: string;
}

/** Phase vocabulary, in boot order. This is product copy, not a log line. */
export const BOOT_PHASES: readonly BootPhaseDef[] = [
    { id: 'waking', label: 'Waking your machine' },
    { id: 'mounting', label: 'Mounting your files' },
    { id: 'starting', label: 'Starting the desktop' },
    { id: 'connecting', label: 'Connecting the display' },
];

// Measured reference timings (ms) — PLATFORM-NOTES §11's live measurement.
// These are cumulative boundaries for when the ESTIMATE moves the highlighted
// phase forward. They are not a promise that the phase is actually complete
// at that instant — only a real signal (guacamoleRunning) or the final
// request resolution can promise that.
const CONTAINER_START_MS = 300;
const WORKSPACE_MOUNT_MS = 5_900;
const DESKTOP_READY_WAIT_MS = 15_300;

const WAKING_ENDS_MS = CONTAINER_START_MS;
const MOUNTING_ENDS_MS = WAKING_ENDS_MS + WORKSPACE_MOUNT_MS;
const STARTING_ENDS_MS = MOUNTING_ENDS_MS + DESKTOP_READY_WAIT_MS;

/** Measured total (~21.9s) — the "usually takes about" figure used in copy. */
export const TYPICAL_BOOT_MS = STARTING_ENDS_MS;

/** Past this, we're well outside the typical envelope — reassure, don't alarm. */
export const LONG_BOOT_MS = 35_000;

/**
 * How long `computeBootUiState` will show the `connecting` phase over a
 * SUCCESSFUL preview request whose frame nobody has confirmed yet, before it
 * gives up and says `desktop_unreachable`.
 *
 * 🔴 THIS IS THE THING THAT KEEPS THE NEW `success` BRANCH TERMINAL. That
 * branch used to fail closed the instant it saw anything other than
 * `frameConfirmed === true`, which was wrong in the common case (nobody had
 * asked yet) but right about one thing: a permanent progress bar is not more
 * honest than a failure, it is just quieter. So the "we have not asked yet"
 * state is bounded here rather than left open.
 *
 * Sized from the WORST CASE of the callers' own bounded confirmation loops,
 * not from the happy path. `shell/ezil/apps/desktop-window.js` (and its two
 * siblings) ask up to `FRAME_CONFIRM_ATTEMPTS` (3) times, `FRAME_CONFIRM_RETRY_MS`
 * (1.5s) apart, and each ask carries `session.js`'s `STATUS_TIMEOUT_MS` (12s)
 * budget — ~40s if every single one of them times out. Anything below that
 * would fire the deadline BEFORE the caller had finished asking, turning a
 * slow confirmation into a fabricated failure. Measured healthy gap: ~6s.
 */
export const FRAME_CONFIRM_DEADLINE_MS = 45_000;

/**
 * How long to wait after a `sandbox_starting` answer before asking again.
 *
 * The server already spends `SANDBOX_WAKE_ANSWER_BUDGET_MS` (12s) per ask, so
 * this is only the beat between them — it paces the loop, it does not set it.
 * Short on purpose: each re-ask is also what keeps the Worker driving the wake,
 * and the already-exposed fast path in `ensureDesktop` makes a re-ask cheap the
 * moment the container is up.
 */
export const WAKE_REASK_MS = 1_500;

/**
 * Total patience for a container that keeps answering "still waking".
 *
 * 🔴 DELIBERATELY THE SAME NUMBER THE SHELL ALREADY WAITED. `session.js`'s
 * `DESKTOP_BOOT_TIMEOUT_MS` is 215s and always was; what changed is what
 * happens during those 215s. It used to be one silent socket that produced an
 * unclassifiable failure at the end; it is now a live phase list and a bounded
 * loop of labelled answers. The user's worst case did not get longer — a
 * hibernation wake was measured at ~187s, and the whole point is to still be
 * waiting, honestly, when it lands.
 *
 * Pinned to `session.DESKTOP_BOOT_TIMEOUT_MS` by a test, because two numbers
 * that must agree and live in different files do not stay agreed.
 */
export const WAKE_DEADLINE_MS = 215_000;

/**
 * Purely time-based phase estimate. Never use this alone to decide whether to
 * show a checkmark — only to decide which phase is CURRENTLY highlighted
 * while we wait for a real signal or the request to settle.
 */
export function estimatePhaseForElapsedMs(elapsedMs: number): BootPhaseId {
    if (elapsedMs < WAKING_ENDS_MS) return 'waking';
    if (elapsedMs < MOUNTING_ENDS_MS) return 'mounting';
    if (elapsedMs < STARTING_ENDS_MS) return 'starting';
    return 'connecting';
}

export interface BootProgressState {
    kind: 'progress';
    currentPhase: BootPhaseId;
    /**
     * True only when `currentPhase` is backed by the real `guacamoleRunning`
     * signal from the status poll — never set from elapsed time alone.
     */
    confirmed: boolean;
    /** True once elapsed time is well past the typical ~22s boot. */
    isRunningLong: boolean;
}

export interface BootReadyState {
    kind: 'ready';
}

export interface BootNotConfiguredState {
    kind: 'not_configured';
}

/**
 * Plain-language failure taxonomy for THIS app's desktop-boot path. Deliberately
 * does not include `no_package_json` / `port_not_listening` / `crash_looping`
 * — those belong to the unwired Option D dev-server bridge (see module doc)
 * and have no genuine signal on this path. `sandbox_crashed` is the honest
 * analog of "crashed" available here (the Worker reports the container/sandbox
 * runtime itself failed to start, via `sandbox_runtime_blocked` /
 * `sandbox_start_failed`). `timeout` is real: it fires only when this app's
 * own client-side `AbortSignal.timeout` actually elapses.
 *
 * `desktop_unreachable` is the one added after the boot contract was found to
 * stop at the handoff: the preview request succeeded, and then the desktop
 * origin itself either answered with an error status or did not answer. See
 * `computeBootUiState`'s `success` branch.
 *
 * `display_not_streaming` is the one added after the contract was found to stop
 * one layer BELOW that: the desktop origin answered 200 and no pixels ever
 * arrived. It is produced by `applyDisplayEvidence`, never by
 * `classifyFailure` — there is no `BootErrorCode` for it, because the preview
 * request cannot fail this way. See `applyDisplayEvidence`.
 */
export type BootFailureReason =
    | 'worker_unreachable'
    | 'sandbox_crashed'
    | 'desktop_unreachable'
    | 'display_not_streaming'
    | 'timeout'
    | 'unknown';

export interface BootFailureState {
    kind: 'failed';
    reason: BootFailureReason;
}

/**
 * The desktop is on screen, and we could NOT determine whether it is showing
 * anything.
 *
 * 🔴 This is not a softer `ready` and it is not a softer `failed`. It is the
 * state of our knowledge, rendered. It exists because the two honest-looking
 * alternatives are both dishonest:
 *
 *   - calling it `ready` is the exact lie the display gate was built to stop,
 *     just relocated to the case where the gate itself could not run;
 *   - calling it `failed` hides a desktop that is probably working perfectly,
 *     on no evidence at all, and would do so for EVERY user at once the moment
 *     a Neko bump renames a field. Same lie, sign flipped, and total.
 *
 * So the desktop is revealed, and the user is told plainly that we could not
 * check it, with a way to retry. No checkmark is drawn and nothing anywhere
 * reports this as live.
 */
export interface BootUnverifiedState {
    kind: 'ready_unverified';
}

export type BootUiState =
    | BootProgressState
    | BootReadyState
    | BootNotConfiguredState
    | BootFailureState
    | BootUnverifiedState;

/**
 * What was observed about pixels actually reaching the browser.
 *
 * Produced server-side by `probeDesktopDisplay`
 * (`server/lib/cloudflare-guacamole-provider.ts`), which asks Neko whether any
 * session's WebRTC peer is connected. Carried to the shell by
 * `session.confirmDisplay`.
 */
export type DisplayEvidence = 'live' | 'blank' | 'unknown';

/**
 * The error codes `requestGuacamolePreview` can genuinely produce, plus
 * `timeout`. Kept in lockstep with `GuacamolePreviewErrorCode` — including
 * the four DETERMINISTIC codes, which have no honest specific copy of their
 * own (see `classifyFailure`) but must still be representable, or this union
 * silently stops mirroring the thing it claims to mirror.
 */
export type BootErrorCode =
    | 'bad_request'
    | 'unauthorized'
    | 'preconditions_unmet'
    | 'custom_domain_required'
    | 'connection_refused'
    | 'fetch_failed'
    | 'sandbox_runtime_blocked'
    | 'sandbox_start_failed'
    | 'sandbox_starting'
    | 'worker_http_error'
    | 'desktop_unreachable'
    | 'timeout'
    | 'unknown';

/**
 * The deterministic family, restated for the browser. Byte-for-byte the same
 * membership as `DETERMINISTIC_PREVIEW_ERROR_CODES` in
 * `server/lib/cloudflare-guacamole-provider.ts` — and pinned to it by a test
 * that sweeps every member of both unions, because two copies of a rule is
 * exactly how this codebase has drifted before.
 *
 * Retryable is the DEFAULT here for the same reason it is there: an
 * unrecognised code (a future addition, or one arriving from a server newer
 * than this bundle) costs at most one duplicate request, rather than silently
 * hardening a transient blip into a dead end.
 */
const DETERMINISTIC_BOOT_ERROR_CODES: readonly string[] = [
    'bad_request',
    'unauthorized',
    'preconditions_unmet',
    'custom_domain_required',
    'sandbox_runtime_blocked',
];

/**
 * True when re-sending the identical request could plausibly change the answer.
 *
 * The browser-side half of the automatic retry: a first attempt that failed
 * this way is worth one silent re-ask, and one that did not is worth none.
 */
export function isRetryableBootErrorCode(code: string | undefined): boolean {
    if (!code) return true;
    return !DETERMINISTIC_BOOT_ERROR_CODES.includes(code);
}

export interface ComputeBootUiStateInput {
    /** Overall status of the one-shot `POST /sandbox/preview` request. */
    requestStatus: 'not_configured' | 'pending' | 'success' | 'error';
    /**
     * ms since the CURRENT PHASE began — not since the window opened.
     *
     *   `pending` — since this boot attempt started. Picks which phase the
     *               time-based estimate highlights.
     *   `success` — since the desktop URL was handed to the browser. This is a
     *               DIFFERENT clock on purpose: the display handoff is what is
     *               being timed there, and a cold boot that took 200s must not
     *               spend the confirmation's whole budget before the
     *               confirmation has been asked for once.
     *   `error` / `not_configured` — ignored.
     */
    elapsedMs: number;
    /**
     * Last observed value from polling the cheap `GET /sandbox/:id/status`
     * endpoint while `requestStatus === 'pending'`. `undefined` means no poll
     * has landed yet — must NOT be treated as `false` (that would fabricate a
     * negative signal we don't have).
     */
    confirmedGuacamoleRunning?: boolean;
    /** Present only when `requestStatus === 'error'`. */
    errorCode?: BootErrorCode;
    /**
     * Whether the DESKTOP ORIGIN itself has been observed answering — not the
     * Worker, and not the iframe's `load` event. Read only when
     * `requestStatus === 'success'`.
     *
     * 🔴 THREE VALUES, THREE MEANINGS. Same convention as
     * `confirmedGuacamoleRunning` above, and for the same reason:
     *
     *   `true`      — observed answering. The one and only route to `ready`.
     *   `false`     — ASKED AND REFUTED. The probe read an error status, or the
     *                 caller exhausted its own bounded retries and is reporting
     *                 the negative. A real observation, and a failure.
     *   `undefined` — nobody has asked yet. NOT a pass, and not a failure
     *                 either: fabricating a negative from the absence of an
     *                 observation is what painted a dead end over six seconds
     *                 of a perfectly healthy boot. See the `success` branch.
     */
    frameConfirmed?: boolean;
}

/** Map a genuine error code to the plain-language failure taxonomy this UI renders. */
function classifyFailure(errorCode: BootErrorCode | undefined): BootFailureReason {
    switch (errorCode) {
        case 'connection_refused':
        case 'fetch_failed':
            return 'worker_unreachable';
        case 'sandbox_runtime_blocked':
        case 'sandbox_start_failed':
            return 'sandbox_crashed';
        case 'desktop_unreachable':
            return 'desktop_unreachable';
        // `sandbox_starting` is the server saying "still waking, ask again" —
        // it is normally consumed as PROGRESS by the caller's wake loop and
        // never reaches here at all. It only lands in this switch when that
        // loop ran out of patience, and at that point the honest thing to say
        // is the `timeout` copy, which is already exactly right: "it may still
        // come up in the background — try again." Deliberately NOT
        // `sandbox_crashed`: nothing crashed, and nothing observed says it did.
        case 'sandbox_starting':
        case 'timeout':
            return 'timeout';
        // The deterministic family — a malformed request, a rejected HMAC
        // signature, an unmet Worker precondition, a `.workers.dev` host the
        // Sandbox SDK refuses to expose a port on. All four are OUR bug or
        // OUR misconfiguration, not something the user did or can influence,
        // and none is a crash. `sandbox_crashed`'s copy ("Retrying usually
        // fixes this") would be a straight lie for them, so they take the
        // generic `unknown` copy, whose second clause ("if it keeps
        // happening, let us know") is exactly right. Deliberately NOT given
        // invented copy of their own: there is nothing true to say that the
        // generic text doesn't already say.
        case 'bad_request':
        case 'unauthorized':
        case 'preconditions_unmet':
        case 'custom_domain_required':
        case 'worker_http_error':
        case 'unknown':
        default:
            return 'unknown';
    }
}

/**
 * Pure function: derive what the boot UI should show. No timers, no network
 * calls — the caller owns the clock and the two queries; this only decides
 * how to represent their combined state honestly.
 */
export function computeBootUiState(input: ComputeBootUiStateInput): BootUiState {
    if (input.requestStatus === 'not_configured') {
        return { kind: 'not_configured' };
    }
    if (input.requestStatus === 'success') {
        // 🔴 `success` means the PREVIEW REQUEST resolved ok — the Worker
        // registered a port and handed back a URL. It has never meant that a
        // browser pointed at that URL gets a desktop, and on 2026-07-31 the
        // two were observed apart: `guacamoleRunning: true` while the preview
        // host returned HTTP 500 "Proxy routing error". Both this app's
        // surfaces then reported success over it, because this branch was the
        // end of the contract.
        //
        // So `ready` STILL requires a SECOND, independent, positive observation
        // of the desktop origin itself (`probeDesktopFrame` in
        // `server/lib/cloudflare-guacamole-provider.ts`, reached from the
        // shell as `frameConfirmed`). Strict `=== true`, for the same reason
        // `confirmed` below is: nothing truthy off the wire may stand in for a
        // real observation. That has not moved, and the `display === 'live'`
        // gate in `applyDisplayEvidence` still sits underneath it.
        //
        // 🔴 WHAT DID MOVE, AND WHY (2026-08-08). This branch read "anything
        // that is not `true` is `desktop_unreachable`". So in the instant after
        // a mint resolved — before anybody had asked the origin anything — every
        // caller painted a TERMINAL failure over a workspace that was booting
        // normally. Measured: the mint resolved at 2:41:06, the frame confirmed
        // at 2:41:12, and for those six seconds the user was told their desktop
        // was not answering. Nobody had asked it yet. That is not failing
        // closed; it is answering a question that was never put.
        //
        // The three answers are now kept apart, and exactly one of them is new:
        //
        //   `true`        — observed answering. `ready`, as before.
        //   `false`       — ASKED AND REFUTED: the probe read an error status,
        //                   or the caller exhausted its own bounded retries.
        //                   `desktop_unreachable`, as before.
        //   anything else — NOBODY HAS ASKED YET. Not a pass. No longer a
        //                   failure either: it is the `connecting` phase, which
        //                   is the true statement while a confirmation is in
        //                   flight. This converts a false FAILURE into
        //                   PROGRESS; it opens no new route to `ready`.
        //
        // It still ends TERMINALLY. `elapsedMs` here is time since the URL was
        // handed to the browser (see the field's doc), and at
        // `FRAME_CONFIRM_DEADLINE_MS` the unanswered case becomes the same
        // visible, retryable `desktop_unreachable` it always was. A caller that
        // never threads an observation gets that, not a permanent spinner.
        if (input.frameConfirmed === true) {
            return { kind: 'ready' };
        }
        if (input.frameConfirmed === false || input.elapsedMs >= FRAME_CONFIRM_DEADLINE_MS) {
            return { kind: 'failed', reason: 'desktop_unreachable' };
        }
        return {
            kind: 'progress',
            currentPhase: 'connecting',
            // Never `true`. `confirmed` is what draws a CHECKMARK, and the
            // display is precisely the thing not yet confirmed.
            confirmed: false,
            isRunningLong: input.elapsedMs >= LONG_BOOT_MS,
        };
    }
    if (input.requestStatus === 'error') {
        return { kind: 'failed', reason: classifyFailure(input.errorCode) };
    }

    // pending
    const estimated = estimatePhaseForElapsedMs(input.elapsedMs);
    const confirmedRunning = input.confirmedGuacamoleRunning === true;

    // A confirmed `guacamoleRunning: true` is real evidence the desktop
    // process is up — advance (never regress) to `connecting` and mark it
    // confirmed, even if the timer estimate hasn't caught up yet.
    const currentPhase: BootPhaseId = confirmedRunning ? 'connecting' : estimated;

    return {
        kind: 'progress',
        currentPhase,
        confirmed: confirmedRunning && currentPhase === 'connecting',
        isRunningLong: input.elapsedMs >= LONG_BOOT_MS,
    };
}

/**
 * The SECOND gate: given what `computeBootUiState` decided, and what was
 * observed about pixels arriving, decide what the user may be shown.
 *
 * ── Why this is a separate function and not another field on the input ──────
 * `computeBootUiState` has resisted five separate attempts to make it show a
 * checkmark it had not earned, and its `success` branch is the load-bearing
 * part. Threading a fourth optional flag through it would put every one of
 * those attacks back in play, and would also be WRONG for its other callers:
 * the app-preview and code-server windows are HTML documents, where "the
 * origin answered without an error status" genuinely is the whole question.
 * Only the desktop is a video stream, and only the desktop needs this. So the
 * desktop path composes two gates instead of one function growing a mode.
 *
 * ── Why there is no way to get `ready` out of this by omission ──────────────
 * `'live'` is the ONLY input that returns `{ kind: 'ready' }`. `undefined`,
 * `null`, `true`, `'LIVE'`, `1`, an object — every one of them is
 * `ready_unverified`. A caller that forgets to thread the evidence therefore
 * gets the "we did not check" state, which is exactly what has happened. There
 * is no default-to-pass anywhere in here, which is the property that makes this
 * safe to add to a contract already carrying the weight it does.
 *
 * ── It only ever DOWNGRADES ─────────────────────────────────────────────────
 * A state that is not `ready` comes back untouched. Pixel evidence cannot
 * rescue a boot that failed, cannot end a boot still in progress, and cannot
 * conjure a desktop where no provider is configured. It can only take `ready`
 * away.
 *
 * @param state the state `computeBootUiState` produced
 * @param display what `session.confirmDisplay` observed, if anything
 */
export function applyDisplayEvidence(state: BootUiState, display: DisplayEvidence | undefined): BootUiState {
    if (!state || state.kind !== 'ready') return state;
    if (display === 'live') return { kind: 'ready' };
    if (display === 'blank') return { kind: 'failed', reason: 'display_not_streaming' };
    return { kind: 'ready_unverified' };
}

export type PhaseVisualState = 'upcoming' | 'current' | 'passed' | 'confirmed';

/**
 * How a single phase row should render given the overall progress state.
 * `passed`/`current` are estimates (no checkmark); `confirmed` is the one
 * state backed by a real observation.
 */
export function phaseVisualState(phaseId: BootPhaseId, progress: BootProgressState): PhaseVisualState {
    const order = BOOT_PHASES.map((p) => p.id);
    const idx = order.indexOf(phaseId);
    const curIdx = order.indexOf(progress.currentPhase);
    if (idx < curIdx) return 'passed';
    if (idx > curIdx) return 'upcoming';
    return progress.confirmed ? 'confirmed' : 'current';
}

/**
 * Classify a caught fetch error from `requestGuacamolePreview`'s network
 * layer into `BootErrorCode`, adding the one code that function's own
 * `GuacamolePreviewErrorCode` union doesn't carry: a genuine client-side
 * timeout. `AbortSignal.timeout(...)` rejects with a `DOMException` named
 * `TimeoutError` (verified against Node's `undici` fetch) — distinct from a
 * network-level `ETIMEDOUT`, which stays classified as `fetch_failed`.
 */
export function classifyPreviewFetchError(err: unknown): 'timeout' | undefined {
    if (err instanceof Error && err.name === 'TimeoutError') {
        return 'timeout';
    }
    return undefined;
}

// ─── User-facing copy ───────────────────────────────────────────────────────

export const BOOT_PROGRESS_HEADLINE = 'Starting your computer';
export const BOOT_PROGRESS_SUBTEXT = 'This usually takes about 20 seconds.';
export const BOOT_PROGRESS_LONG_SUBTEXT =
    'Still working — first boots and larger workspaces can take a bit longer.';

export interface BootFailureCopy {
    title: string;
    body: string;
}

export const BOOT_FAILURE_COPY: Record<BootFailureReason, BootFailureCopy> = {
    worker_unreachable: {
        title: "Can't reach your computer",
        body: "The service that runs your computer isn't responding right now. This is usually temporary — try again in a moment.",
    },
    sandbox_crashed: {
        title: "Your computer didn't start",
        body: 'Something went wrong while starting the machine itself. Retrying usually fixes this.',
    },
    // Covers both halves of the same honest statement — the display answered
    // with an error, or it did not answer at all. The copy deliberately does
    // not guess which, and does not blame the machine: the container may well
    // be up (it usually is), and it is the route to its display that is not
    // working.
    desktop_unreachable: {
        title: "Your desktop isn't answering",
        body: "Your computer started, but we couldn't reach its display. This is usually temporary — try again.",
    },
    // One layer below `desktop_unreachable`: the display DID answer, and then
    // no picture came through it. The distinction is worth keeping because the
    // remedies differ — that one is usually a route that will come back on its
    // own, this one is usually the network between the user and the video
    // stream. Neither blames the machine, because in both cases it is fine.
    display_not_streaming: {
        title: "Your desktop isn't coming through",
        body: "Your computer is running, but its screen isn't reaching your browser. This is usually a network problem — try again, and if it keeps happening, let us know.",
    },
    timeout: {
        title: 'This is taking too long',
        body: "Starting your computer is taking longer than it should. It may still come up in the background — try again.",
    },
    unknown: {
        title: 'Something went wrong',
        body: "We couldn't start your computer. Try again, and if it keeps happening, let us know.",
    },
};

export const BOOT_NOT_CONFIGURED_COPY: BootFailureCopy = {
    title: 'EZiL OS desktop',
    body: "This computer's desktop provider is not configured.",
};

/**
 * `ready_unverified`. Says what we know and what we don't, in that order, and
 * hands the judgement to the only party who can actually see the screen.
 *
 * 🔴 The word "ready" does not appear, and neither does anything green. This
 * copy is the entire user-visible difference between "we checked" and "we
 * couldn't check", so it may never be softened into reassurance.
 */
export const BOOT_UNVERIFIED_COPY: BootFailureCopy = {
    title: "We couldn't check your display",
    body: "Your desktop is here, but we couldn't confirm it's actually showing. If the screen is blank, try again.",
};
