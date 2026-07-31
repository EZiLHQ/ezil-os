/**
 * Boot phase state mapping for the desktop-boot experience.
 * (`docs/RUNBOOK.md` Wave B1, `docs/PLATFORM-NOTES.md` §11.)
 *
 * ── Honesty constraint ──────────────────────────────────────────────────────
 * The browser has exactly two genuine signals during a cold boot:
 *
 *   1. The single `POST /sandbox/preview` request (`requestGuacamolePreview`
 *      in `cloudflare-guacamole-provider.ts`), which resolves ONLY at the
 *      very end — success or a specific error. Nothing about it is
 *      observable mid-flight.
 *   2. `GET /sandbox/:id/status` — cheap, does NOT wake a sleeping container,
 *      returns `{ ok, sandboxName, guacamoleRunning, mode }`. Polling it
 *      WHILE the preview request is in flight is safe (the container is
 *      already being woken by that request) and gives one real mid-boot
 *      fact: whether the desktop process has come up.
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
 */
export type BootFailureReason = 'worker_unreachable' | 'sandbox_crashed' | 'timeout' | 'unknown';

export interface BootFailureState {
    kind: 'failed';
    reason: BootFailureReason;
}

export type BootUiState = BootProgressState | BootReadyState | BootNotConfiguredState | BootFailureState;

/** The error codes `requestGuacamolePreview` can genuinely produce, plus `timeout`. */
export type BootErrorCode =
    | 'connection_refused'
    | 'fetch_failed'
    | 'sandbox_runtime_blocked'
    | 'sandbox_start_failed'
    | 'worker_http_error'
    | 'timeout'
    | 'unknown';

export interface ComputeBootUiStateInput {
    /** Overall status of the one-shot `POST /sandbox/preview` request. */
    requestStatus: 'not_configured' | 'pending' | 'success' | 'error';
    /** ms since this boot attempt started. Ignored once the request has settled. */
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
        case 'timeout':
            return 'timeout';
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
        return { kind: 'ready' };
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
