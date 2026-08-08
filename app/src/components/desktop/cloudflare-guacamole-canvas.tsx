'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api } from '@/trpc/react';
import { DESKTOP_PREVIEW_RETRIES, retryTransientOnly } from '@/trpc/retry-policy';
import {
    BOOT_FAILURE_COPY,
    BOOT_NOT_CONFIGURED_COPY,
    BOOT_PHASES,
    BOOT_PROGRESS_HEADLINE,
    BOOT_PROGRESS_LONG_SUBTEXT,
    BOOT_PROGRESS_SUBTEXT,
    WAKE_DEADLINE_MS,
    WAKE_REASK_MS,
    computeBootUiState,
    phaseVisualState,
    type BootErrorCode,
    type BootProgressState,
    type PhaseVisualState,
} from './boot-phases';
import { desktopSurfaceStatus, useReportDesktopStatus } from './desktop-status';

/**
 * CloudflareGuacamoleCanvas
 *
 * Renders a computer's EZiL OS desktop: an iframe pointing at the Neko
 * desktop viewer served by the sandbox container behind `worker/`. This is
 * the ONLY surface `/computer/[id]` renders — no top bar, no side panel, no
 * chat; the computer canvas fills the viewport under whatever thin chrome
 * the page itself adds.
 *
 * Architecture:
 *   this component (iframe)
 *     -> cloudflareGuacamole.previewUrl (tRPC)  — one long POST /sandbox/preview,
 *        resolves only at the end (success or a specific error)
 *     -> cloudflareGuacamole.status (tRPC)      — cheap GET /sandbox/:id/status,
 *        polled ONLY while the preview request above is in flight, to pick up
 *        one real mid-boot fact (`guacamoleRunning`) without waking anything
 *        extra (the preview request is already doing that)
 *     -> server/lib/cloudflare-guacamole-provider.ts
 *     -> worker/ (Cloudflare Worker, @cloudflare/sandbox container)
 *           -> Neko desktop (port 8080)
 *
 * The ~22s cold boot (docs/PLATFORM-NOTES.md §11) is shown honestly via
 * `./boot-phases.ts`: phase progress is a time-based ESTIMATE anchored to the
 * measured reference boot, and is never rendered as confirmed unless backed
 * by the real `guacamoleRunning` signal above or the final request settling.
 * See that module's doc comment for the full honesty rationale, including why
 * `/preview-status`'s `no_package_json`/`port_not_listening`/`crashed`/
 * `crash_looping` taxonomy does not apply to this desktop-boot path.
 *
 * Carried and simplified from EBuilder's
 * `apps/web/client/src/components/desktop/cloudflare-guacamole-canvas.tsx`
 * (authored post-Onlook-import, listed as safe to carry). Dropped: the
 * `onOpenAppPreview` toggle and `angularPreviewUrl` badge link (both
 * belonged to the app-preview/"Option D" surface, which
 * `server/lib/cloudflare-guacamole-provider.ts` doesn't carry either — see
 * that file's doc comment) and the dual Guacamole/Neko provider hook
 * (`use-preview-provider.ts` in the source) — this app has exactly one
 * desktop mode, so there is nothing to select between.
 */

export interface CloudflareGuacamoleCanvasProps {
    /** The computer's id — used to derive the Cloudflare sandbox container id. */
    computerId: string;
    /** Session correlation key (arbitrary UUID). */
    sessionId: string;
}

type WorkspaceStatus = {
    mounted: boolean;
    mountPath?: string;
    detail?: string;
};

/** Overall status of the single, one-shot `POST /sandbox/preview` request. */
type RequestStatus = 'not_configured' | 'pending' | 'success' | 'error';

/** Human-readable label for the product's sole desktop preview mode. */
const EZIL_OS_LABEL = 'EZiL OS';

/**
 * Shown ONLY when the server could not put the desktop into implicit-hosting
 * mode (`controlMode === 'manual'` — see `enableImplicitHosting` in
 * `server/lib/cloudflare-guacamole-provider.ts`). In that state a click on the
 * desktop is silently ignored, and the only way in is Neko's own mouse icon,
 * which `embed=1` keeps visible in the video's top-right corner. Saying so is
 * the honest fallback; the alternative is a computer that appears broken.
 *
 * When implicit hosting IS on — the normal case — nothing is rendered, because
 * there is nothing to explain: you click your computer and it is yours.
 */
export const CONTROL_HINT_COPY =
    'Click the mouse icon at the top right of the desktop to take control of this computer.';

/**
 * The hint appears for exactly one reason and disappears for exactly two.
 * Extracted so the rule is testable without a DOM: a nag that shows up on a
 * healthy desktop, or that refuses to go away, is its own defect.
 */
export function shouldShowControlHint(
    controlMode: 'implicit' | 'manual' | undefined,
    dismissed: boolean,
): boolean {
    return controlMode === 'manual' && !dismissed;
}

/**
 * Map the worker/provider's own error-code strings onto the plain-language
 * taxonomy `boot-phases.ts` renders. Anything not recognized collapses to
 * `unknown` rather than guessing.
 */
function toBootErrorCode(raw: string | undefined): BootErrorCode {
    switch (raw) {
        case 'bad_request':
        case 'unauthorized':
        case 'preconditions_unmet':
        case 'custom_domain_required':
        case 'connection_refused':
        case 'fetch_failed':
        case 'sandbox_runtime_blocked':
        case 'sandbox_start_failed':
        // Both added 2026-08-08, and both were already being PRODUCED by
        // `previewUrl` and dropped on the floor here — collapsing to `unknown`
        // ("We couldn't start your computer") a wake that was going fine, and a
        // display-route failure that has its own accurate copy.
        case 'sandbox_starting':
        case 'desktop_unreachable':
        case 'worker_http_error':
        case 'timeout':
            return raw;
        default:
            return 'unknown';
    }
}

/** How often the preview query re-asks a server that said `sandbox_starting`. */
const PREVIEW_TOKEN_REFRESH_MS = 50 * 60 * 1000;

export function CloudflareGuacamoleCanvas({ computerId, sessionId }: CloudflareGuacamoleCanvasProps) {
    const [reloadKey, setReloadKey] = useState(0);
    const [controlHintDismissed, setControlHintDismissed] = useState(false);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    /**
     * ms since the current boot PHASE began, and which phase that was.
     *
     * `Date.now()` never happens in the render body, so the component stays
     * pure. Only ever used to pick which phase to HIGHLIGHT as an estimate, and
     * to bound the two waits — never to assert a phase is actually done (see
     * boot-phases.ts).
     *
     * Written ONLY from the interval callback below — never synchronously in
     * an effect body, and never read from a ref during render, so the
     * component stays pure and does not cascade renders. `null` before the
     * first tick of the first phase, and reset to `null` by a manual reload.
     */
    const [phaseClock, setPhaseClock] = useState<{ phase: 'boot' | 'handoff'; elapsedMs: number } | null>(
        null,
    );

    const isConfiguredQuery = api.cloudflareGuacamole.isConfigured.useQuery(undefined, {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
    });

    /**
     * Has this attempt spent its whole wake budget?
     *
     * 🔴 Read off the BOOT phase's clock specifically, and deliberately NOT
     * off the phase-relative `elapsedMs` below. That value resets to 0 the
     * moment the phase changes, and `requestStatus` depends on this flag — so
     * a reset would flip the status back to `pending`, restart the clock, and
     * oscillate. The clock is left holding its expired boot value once the
     * effect stops, which makes this a latch without needing to be one.
     */
    const wakeExpired = phaseClock?.phase === 'boot' && phaseClock.elapsedMs >= WAKE_DEADLINE_MS;

    const previewQuery = api.cloudflareGuacamole.previewUrl.useQuery(
        { sessionId, computerId },
        {
            enabled: isConfiguredQuery.data?.isConfigured === true,
            /**
             * 🔴 TWO DIFFERENT CADENCES, AND THE FAST ONE IS THE WAKE LOOP.
             *
             * A hibernated container answers `sandbox_starting` — a labelled,
             * retryable "not ready yet" the server produces at 12s rather than
             * holding the connection for ~187s and then failing
             * unclassifiably (see `SANDBOX_WAKE_ANSWER_BUDGET_MS`). It arrives
             * as a VALUE on a 200, so TanStack's `retry` never sees it; the
             * re-ask has to be this. Bounded by `wakeExpired`, so a container
             * that never comes up ends at a visible failure rather than
             * polling forever.
             *
             * Everything else keeps the original cadence: one refresh five
             * minutes before the 55-minute token expires.
             */
            refetchInterval: (query) => {
                const data = query.state.data as { ok?: boolean; errorCode?: string } | undefined;
                if (data?.ok === false && data.errorCode === 'sandbox_starting') {
                    return wakeExpired ? false : WAKE_REASK_MS;
                }
                return PREVIEW_TOKEN_REFRESH_MS;
            },
            refetchOnWindowFocus: false,
            staleTime: 0,
            // Retry ONLY what a second identical attempt could fix. A blanket
            // `retry: 2` meant a deterministic failure — a `400
            // missing_project_id`, a bad HMAC signature, a
            // `CustomDomainRequiredError`, an ownership rejection — burned
            // three attempts plus 1s+2s of backoff before the user saw a
            // word, for an answer that was fixed from the first request.
            // Transient failures (5xx, transport, cold-start races) still
            // retry exactly as before. See `@/trpc/retry-policy`.
            retry: retryTransientOnly(DESKTOP_PREVIEW_RETRIES),
        },
    );

    const { requestStatus, errorCode } = useMemo<{
        requestStatus: RequestStatus;
        errorCode?: BootErrorCode;
    }>(() => {
        if (isConfiguredQuery.isLoading) {
            return { requestStatus: 'pending' };
        }
        if (!isConfiguredQuery.data?.isConfigured) {
            return { requestStatus: 'not_configured' };
        }
        if (previewQuery.isLoading) {
            return { requestStatus: 'pending' };
        }
        if (previewQuery.error) {
            // A thrown TRPCError means the Worker returned something outside
            // the operational error codes it classifies for us — we don't
            // have a more specific genuine code to report than "unknown".
            return { requestStatus: 'error', errorCode: 'unknown' };
        }
        if (!previewQuery.data) {
            return { requestStatus: 'pending' };
        }
        if (!previewQuery.data.ok) {
            const errData = previewQuery.data as { ok: false; errorCode?: string };
            // 🔴 A WAKE IS PROGRESS, NOT AN ERROR. `sandbox_starting` means the
            // container is coming up and the server declined to hold the
            // connection while it does. Rendering it as `error` would show
            // "This is taking too long" twelve seconds into a boot that is
            // going exactly as expected — so it stays `pending`, the phase
            // list keeps running, and the `refetchInterval` above asks again.
            // Past `WAKE_DEADLINE_MS` it becomes a real, visible failure with
            // its own copy and its own Retry.
            if (errData.errorCode === 'sandbox_starting' && !wakeExpired) {
                return { requestStatus: 'pending' };
            }
            return { requestStatus: 'error', errorCode: toBootErrorCode(errData.errorCode) };
        }
        return { requestStatus: 'success' };
    }, [
        isConfiguredQuery.isLoading,
        isConfiguredQuery.data,
        previewQuery.isLoading,
        previewQuery.error,
        previewQuery.data,
        wakeExpired,
    ]);

    // ── Is the thing the iframe is pointed at actually a desktop? ───────────
    // 🔴 `requestStatus === 'success'` only ever meant "the Worker gave us a
    // URL". On 2026-07-31 that URL served HTTP 500 "Proxy routing error" and
    // this canvas rendered the error page with a green "Live" pill over it,
    // because nothing downstream of the preview request asked the desktop
    // origin anything. `previewUrl` now probes that origin server-side before
    // it returns (`frame.confirmed`), and this query re-asks afterwards — the
    // 500 was observed appearing MID-SESSION, so a check that only runs before
    // the handoff would still go stale.
    //
    // Deliberately NOT on a background interval: one confirmation at handoff
    // plus one whenever the user comes back to the tab is what this contract
    // needs, and a per-minute poll to an edge host from every open tab is a
    // cost with no honesty gained. The pill reports what was last observed,
    // and coming back to look at it re-observes.
    const previewOk = previewQuery.data?.ok === true ? previewQuery.data : undefined;
    const guacamoleUrl = previewOk?.guacamoleUrl;

    const frameQuery = api.cloudflareGuacamole.confirmFrame.useQuery(
        { computerId, frameUrl: guacamoleUrl ?? '' },
        {
            enabled: requestStatus === 'success' && typeof guacamoleUrl === 'string' && guacamoleUrl !== '',
            refetchOnWindowFocus: true,
            staleTime: 0,
            // Same reasoning as the status poll below: this answer is a point
            // observation, and a retry budget would only stack duplicate GETs
            // against a host we already failed to reach. A negative answer is
            // meant to be believed, not re-asked until it agrees.
            retry: false,
        },
    );

    /**
     * The frame observation `computeBootUiState` gates `ready` on.
     *
     * Prefer the LATER of the two (this query), fall back to the one
     * `previewUrl` made server-side before handing the URL over. Never
     * defaulted to `true`: if neither exists, the boot state stays unconfirmed
     * and the UI says so.
     */
    const frameConfirmed = frameQuery.data?.confirmed ?? previewOk?.frame?.confirmed;

    // The cheap, non-waking status probe — polled ONLY while a boot attempt
    // is genuinely in flight. This is the one real mid-boot signal available;
    // see boot-phases.ts's module doc.
    const sandboxStatusQuery = api.cloudflareGuacamole.status.useQuery(
        { computerId },
        {
            enabled: requestStatus === 'pending',
            refetchInterval: 2_000,
            refetchOnWindowFocus: false,
            // Already correct, and deliberately NOT switched to
            // `retryTransientOnly`: this is a 2s poll, so the next refetch IS
            // the retry. Adding a retry budget on top would stack duplicate
            // in-flight probes against a container that is mid-boot, and a
            // deterministic failure here (ownership rejection) would still be
            // re-asked every 2s regardless. `false` is the honest answer for
            // both families — see `@/trpc/retry-policy` for the rule this
            // satisfies.
            retry: false,
        },
    );
    const confirmedGuacamoleRunning =
        sandboxStatusQuery.data?.ok === true ? sandboxStatusQuery.data.guacamoleRunning : undefined;

    /**
     * 🔴 WHICH PHASE THE CLOCK IS TIMING — and `null` when there is nothing
     * left to time.
     *
     * `computeBootUiState`'s `elapsedMs` is phase-relative (see its field doc):
     * while `pending` it times the container boot and picks the estimated
     * phase; once `success` it times the DISPLAY HANDOFF against
     * `FRAME_CONFIRM_DEADLINE_MS`. Those are two different clocks and they must
     * not be one — a boot that spent 200s waking a hibernated container would
     * otherwise arrive at the handoff with its confirmation budget already
     * gone, and fail a desktop that was about to confirm.
     */
    const timingPhase: 'boot' | 'handoff' | null =
        requestStatus === 'pending'
            ? 'boot'
            : requestStatus === 'success' && frameConfirmed !== true
              ? 'handoff'
              : null;

    // Tick every 500ms while a phase is being timed. `Date.now()` and every
    // state write happen inside the interval CALLBACK — never in the render
    // body and never synchronously in the effect body — so the component stays
    // pure and a phase change costs no cascading render. A new phase gets a new
    // anchor, and the interval stops entirely once nothing is being timed.
    useEffect(() => {
        if (timingPhase === null) return;
        const startedAt = Date.now();
        const id = setInterval(() => {
            setPhaseClock({ phase: timingPhase, elapsedMs: Date.now() - startedAt });
        }, 500);
        return () => clearInterval(id);
    }, [timingPhase]);

    /**
     * The clock `computeBootUiState` is given: this phase's elapsed time, or 0.
     *
     * A reading left over from the PREVIOUS phase reads as 0 rather than being
     * carried over — which is the whole point of the phase being part of the
     * state. Without it, the first render after a 200-second wake would hand
     * the handoff branch a 200-second clock and fail a desktop that was about
     * to confirm.
     */
    const elapsedMs = phaseClock !== null && phaseClock.phase === timingPhase ? phaseClock.elapsedMs : 0;

    const bootUiState = useMemo(
        () =>
            computeBootUiState({
                requestStatus,
                elapsedMs,
                confirmedGuacamoleRunning,
                errorCode,
                frameConfirmed,
            }),
        [requestStatus, elapsedMs, confirmedGuacamoleRunning, errorCode, frameConfirmed],
    );

    // Publish what we observed, so the page's status pill can stop being a
    // decoration. `live` is reachable only from `kind: 'ready'`, which is
    // reachable only from a confirmed frame — see `desktopSurfaceStatus`.
    useReportDesktopStatus(desktopSurfaceStatus(bootUiState.kind));

    const handleReload = useCallback(() => {
        // A fresh attempt gets a fresh clock. Without this, a boot that used up
        // its whole wake budget would stay `wakeExpired` and the retry would
        // report a timeout before it had asked anything.
        setPhaseClock(null);
        // A reload is a fresh boot, and implicit hosting is re-attempted with
        // it — so a previously-dismissed hint must be allowed to come back if
        // the new attempt still lands in 'manual'.
        setControlHintDismissed(false);
        setReloadKey((k) => k + 1);
        void previewQuery.refetch();
        // The frame observation belongs to the OLD attempt. Re-ask, or a retry
        // after a transient outage would keep rendering the stale "not
        // answering" verdict over a desktop that had come back.
        void frameQuery.refetch();
    }, [previewQuery, frameQuery]);

    if (bootUiState.kind === 'not_configured') {
        return (
            <Panel testId="cf-guacamole-not-configured" tone="neutral">
                <p className="mb-1 font-medium text-white">{BOOT_NOT_CONFIGURED_COPY.title}</p>
                <p className="mb-3 text-xs text-neutral-400">{BOOT_NOT_CONFIGURED_COPY.body}</p>
                <p className="text-xs text-neutral-500">
                    Set{' '}
                    <code className="rounded bg-neutral-800 px-1 py-0.5 text-orange-400">
                        CLOUDFLARE_GUACAMOLE_WORKER_URL
                    </code>{' '}
                    in your server environment to activate.
                </p>
            </Panel>
        );
    }

    if (bootUiState.kind === 'failed') {
        const copy = BOOT_FAILURE_COPY[bootUiState.reason];
        const tone = bootUiState.reason === 'sandbox_crashed' ? 'warning' : 'error';
        return (
            <Panel testId={`cf-guacamole-failed-${bootUiState.reason}`} tone={tone} onRetry={handleReload}>
                <p className="mb-2 font-semibold text-white">{copy.title}</p>
                <p className="text-xs text-neutral-400">{copy.body}</p>
            </Panel>
        );
    }

    if (bootUiState.kind === 'progress') {
        return <BootProgressPanel progress={bootUiState} />;
    }

    // `kind: 'ready'` is only produced with a confirmed frame, so reaching here
    // means the preview request succeeded AND the desktop origin was observed
    // answering. The cast mirrors that narrowing for the fields the union's
    // failure arms do not carry.
    const { workspace, controlMode } = previewQuery.data as {
        ok: true;
        guacamoleUrl: string;
        workspace?: WorkspaceStatus;
        controlMode?: 'implicit' | 'manual';
    };

    return (
        <div
            className="relative flex h-full w-full flex-col overflow-hidden bg-neutral-950"
            data-testid="cf-guacamole-canvas"
        >
            {workspace && (
                <div
                    className={`absolute top-2 left-2 z-10 flex items-center gap-1.5 rounded-full border px-2 py-0.5 ${
                        workspace.mounted
                            ? 'border-emerald-500/30 bg-emerald-500/10'
                            : 'border-neutral-600/40 bg-neutral-800/40'
                    }`}
                    data-testid="cf-guacamole-workspace-status"
                    data-workspace-mounted={workspace.mounted}
                    title={workspace.detail ?? (workspace.mounted ? workspace.mountPath : undefined)}
                >
                    <span
                        className={`h-1.5 w-1.5 rounded-full ${workspace.mounted ? 'bg-emerald-400' : 'bg-neutral-500'}`}
                    />
                    <span
                        className={`text-[10px] font-medium ${workspace.mounted ? 'text-emerald-300' : 'text-neutral-400'}`}
                    >
                        {workspace.mounted
                            ? `Workspace: ${workspace.mountPath ?? 'mounted'}`
                            : (workspace.detail ?? 'Workspace: not mounted')}
                    </span>
                </div>
            )}

            <iframe
                ref={iframeRef}
                key={`${guacamoleUrl}:${reloadKey}`}
                src={guacamoleUrl}
                title={`${EZIL_OS_LABEL} desktop`}
                data-testid="cf-guacamole-iframe"
                className="h-full w-full border-0"
                // Neko uses WebSocket internally — allow-same-origin is required.
                sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads"
                allow="clipboard-read; clipboard-write; fullscreen"
                style={{ display: 'block' }}
            />

            {shouldShowControlHint(controlMode, controlHintDismissed) && (
                <div
                    className="absolute bottom-2 left-2 z-10 flex max-w-sm items-start gap-2 rounded-md border border-yellow-700/40 bg-yellow-950/40 px-2.5 py-1.5"
                    data-testid="cf-guacamole-control-hint"
                >
                    <span className="text-[11px] leading-snug text-yellow-200/90">{CONTROL_HINT_COPY}</span>
                    <button
                        type="button"
                        onClick={() => setControlHintDismissed(true)}
                        className="shrink-0 text-[11px] leading-none text-yellow-200/60 hover:text-yellow-100"
                        title="Dismiss"
                        data-testid="cf-guacamole-control-hint-dismiss"
                    >
                        ✕
                    </button>
                </div>
            )}

            <button
                type="button"
                onClick={handleReload}
                className="absolute right-2 bottom-2 z-10 rounded border border-neutral-700 bg-neutral-900/80 p-1.5 text-neutral-400 hover:bg-neutral-800 hover:text-white"
                title="Reload desktop"
                data-testid="cf-guacamole-reload"
            >
                <ReloadIcon className="h-3.5 w-3.5" />
            </button>
        </div>
    );
}

/**
 * The boot-progress screen shown for the ~22s cold start. Every phase is
 * drawn from `BOOT_PHASES`; its visual state (`upcoming` / `current` /
 * `passed` / `confirmed`) comes from `phaseVisualState`, which is the ONLY
 * thing allowed to decide whether a checkmark appears. `passed`/`current`
 * are time-based estimates and deliberately never render a checkmark —
 * only `confirmed` (backed by a real `guacamoleRunning` observation) does.
 */
function BootProgressPanel({ progress }: { progress: BootProgressState }) {
    return (
        <div
            className="relative flex h-full w-full items-center justify-center bg-neutral-950"
            data-testid="cf-guacamole-boot-progress"
            data-current-phase={progress.currentPhase}
            data-confirmed={progress.confirmed}
        >
            <div className="flex w-full max-w-xs flex-col gap-4">
                <div className="text-center">
                    <p className="text-sm font-medium text-white">{BOOT_PROGRESS_HEADLINE}</p>
                    <p className="mt-1 text-xs text-neutral-500">{BOOT_PROGRESS_SUBTEXT}</p>
                    {progress.isRunningLong && (
                        <p className="mt-1 text-xs text-neutral-500" data-testid="cf-guacamole-boot-long-wait">
                            {BOOT_PROGRESS_LONG_SUBTEXT}
                        </p>
                    )}
                </div>

                <ol className="flex flex-col gap-2.5">
                    {BOOT_PHASES.map((phase) => {
                        const visual = phaseVisualState(phase.id, progress);
                        return (
                            <li
                                key={phase.id}
                                className="flex items-center gap-2.5"
                                data-testid={`cf-guacamole-boot-phase-${phase.id}`}
                                data-phase-state={visual}
                            >
                                <PhaseIndicator visual={visual} />
                                <span
                                    className={
                                        visual === 'upcoming'
                                            ? 'text-xs text-neutral-600'
                                            : visual === 'confirmed'
                                              ? 'text-xs font-medium text-emerald-300'
                                              : visual === 'current'
                                                ? 'text-xs font-medium text-white'
                                                : 'text-xs text-neutral-500'
                                    }
                                >
                                    {phase.label}
                                </span>
                            </li>
                        );
                    })}
                </ol>
            </div>
        </div>
    );
}

function PhaseIndicator({ visual }: { visual: PhaseVisualState }) {
    if (visual === 'confirmed') {
        return (
            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400">
                <CheckIcon className="h-2.5 w-2.5" />
            </span>
        );
    }
    if (visual === 'current') {
        return (
            <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
                <span className="absolute h-4 w-4 animate-ping rounded-full bg-teal/40" />
                <span className="relative h-2 w-2 rounded-full bg-teal" />
            </span>
        );
    }
    if (visual === 'passed') {
        // Estimated-complete only — a dimmer filled dot, deliberately NOT a
        // checkmark, so it never reads as a confirmed observation.
        return <span className="h-2 w-2 shrink-0 rounded-full bg-neutral-500" />;
    }
    return <span className="h-2 w-2 shrink-0 rounded-full border border-neutral-700" />;
}

function Panel({
    children,
    testId,
    tone,
    onRetry,
}: {
    children: React.ReactNode;
    testId: string;
    tone: 'neutral' | 'error' | 'warning';
    onRetry?: () => void;
}) {
    const border = {
        neutral: 'border-neutral-700',
        error: 'border-red-700/40',
        warning: 'border-yellow-700/40',
    }[tone];
    const bg = {
        neutral: 'bg-neutral-900',
        error: 'bg-red-950/20',
        warning: 'bg-yellow-950/15',
    }[tone];

    return (
        <div
            className="relative flex h-full w-full flex-col items-center justify-center gap-3 bg-neutral-950 text-sm"
            data-testid={testId}
        >
            <div className={`max-w-md rounded-lg border ${border} ${bg} p-6`}>
                {children}
                {onRetry && (
                    <button
                        type="button"
                        onClick={onRetry}
                        className="mt-4 rounded border border-neutral-700 bg-neutral-800/60 px-2.5 py-1 text-[11px] text-neutral-400 transition-colors hover:bg-neutral-700 hover:text-white"
                        data-testid="cf-guacamole-reload"
                    >
                        Retry
                    </button>
                )}
            </div>
        </div>
    );
}

function ReloadIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true" {...props}>
            <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
        </svg>
    );
}

function CheckIcon(props: React.SVGProps<SVGSVGElement>) {
    return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} aria-hidden="true" {...props}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
        </svg>
    );
}
