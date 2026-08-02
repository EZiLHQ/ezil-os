'use client';

/**
 * The `/computer/[id]` status pill, and the channel that feeds it.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * The pill used to be four lines of static JSX in the page's server component:
 *
 *     <span className="… border-teal/30 …">
 *         <span className="… bg-teal" />
 *         Live
 *     </span>
 *
 * It was not derived from anything. It said "Live" before the preview request
 * had been issued, it said "Live" through the whole ~22s cold boot, it said
 * "Live" over every failure panel the canvas rendered, and on 2026-07-31 it
 * said "Live" over an HTTP 500 "Proxy routing error" from the desktop host.
 * A green dot is a claim; that one was decorative.
 *
 * So the pill now renders ONLY what `CloudflareGuacamoleCanvas` actually
 * observed. The canvas is a client component holding that state and the header
 * is chrome around it, so a tiny context is the seam: the page wraps both, the
 * canvas reports, the pill reads. There is no default and no optimistic
 * initial value — before the canvas has said anything the pill shows
 * "Checking", because that is the true state of our knowledge.
 *
 * `useReportDesktopStatus` is a no-op outside a provider, so the canvas stays
 * usable on its own (it is embedded without this chrome elsewhere).
 */

import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * What we know about the desktop on screen. Every value is an OBSERVATION, and
 * `live` is the only one that may be drawn green.
 *
 *   checking — nothing has been observed yet (initial state, and the state
 *              while `isConfigured`/`previewUrl` are still in flight).
 *   starting — the boot is genuinely in progress; the canvas is showing phases.
 *   live     — the preview request succeeded AND the desktop origin itself was
 *              observed answering (`probeDesktopFrame`). Nothing else earns it.
 *   down     — a boot failure, or the desktop origin did not confirm.
 *   off      — no desktop provider is configured at all.
 */
export type DesktopSurfaceStatus = 'checking' | 'starting' | 'live' | 'down' | 'off';

type Ctx = {
    status: DesktopSurfaceStatus;
    report: (status: DesktopSurfaceStatus) => void;
};

const DesktopStatusContext = createContext<Ctx | null>(null);

export function DesktopStatusProvider({ children }: { children: React.ReactNode }) {
    const [status, setStatus] = useState<DesktopSurfaceStatus>('checking');
    const value = useMemo<Ctx>(() => ({ status, report: setStatus }), [status]);
    return <DesktopStatusContext.Provider value={value}>{children}</DesktopStatusContext.Provider>;
}

/**
 * Publish the surface's observed status. Safe to call with the same value on
 * every render — the effect only fires when it changes.
 */
export function useReportDesktopStatus(status: DesktopSurfaceStatus) {
    const ctx = useContext(DesktopStatusContext);
    const report = ctx?.report;
    useEffect(() => {
        report?.(status);
    }, [report, status]);
}

/**
 * The single mapping from what the boot logic decided to what the pill claims.
 *
 * Extracted and pure so the rule is testable without a DOM, for the same
 * reason `shouldShowControlHint` is: a badge that goes green over a failure is
 * its own defect, and it is far easier to assert here than to notice in a
 * screenshot.
 *
 * 🔴 `live` is reachable from exactly ONE input — `kind: 'ready'` — and
 * `computeBootUiState` only produces that with a confirmed desktop frame. So
 * the green dot inherits the whole honesty chain rather than restating it.
 *
 * @param kind `computeBootUiState(...).kind`, or `undefined` before the canvas
 *   has computed one at all.
 */
export function desktopSurfaceStatus(
    kind: 'progress' | 'ready' | 'not_configured' | 'failed' | 'ready_unverified' | undefined,
): DesktopSurfaceStatus {
    switch (kind) {
        case 'ready':
            return 'live';
        // 🔴 The desktop is on screen and NOBODY CHECKED IT. Deliberately not
        // `live` — that is the entire point of the state — and deliberately not
        // `down` either, because nothing observed a failure. "Checking" is the
        // literal truth: our knowledge of this desktop never got past checking.
        //
        // `/computer/[id]` does not thread display evidence today, so this
        // canvas cannot currently produce this kind; only the `/os` shell can
        // (`settle_display` in `shell/ezil/apps/desktop-window.js`). It is
        // mapped anyway rather than left to the `default`, so that wiring the
        // evidence in here later is a one-line change that cannot silently
        // land on the wrong pill.
        case 'ready_unverified':
            return 'checking';
        case 'progress':
            return 'starting';
        case 'failed':
            return 'down';
        case 'not_configured':
            return 'off';
        default:
            return 'checking';
    }
}

const PILL: Record<DesktopSurfaceStatus, { label: string; ring: string; dot: string; text: string }> = {
    // Neutral, not green, and not red: we are not claiming either yet.
    checking: {
        label: 'Checking',
        ring: 'border-white/15 bg-white/5',
        dot: 'bg-gray-500',
        text: 'text-gray-400',
    },
    starting: {
        label: 'Starting',
        ring: 'border-amber-400/30 bg-amber-400/10',
        dot: 'bg-amber-400',
        text: 'text-amber-300',
    },
    live: {
        label: 'Live',
        ring: 'border-teal/30 bg-teal/10',
        dot: 'bg-teal',
        text: 'text-teal',
    },
    // "Not responding", not "Offline": the container is usually up, and it is
    // the route to its display that is not answering. Saying "offline" would be
    // a second guess dressed as a fact.
    down: {
        label: 'Not responding',
        ring: 'border-red-500/30 bg-red-500/10',
        dot: 'bg-red-400',
        text: 'text-red-300',
    },
    off: {
        label: 'Not configured',
        ring: 'border-white/15 bg-white/5',
        dot: 'bg-gray-500',
        text: 'text-gray-400',
    },
};

/** The pill itself. Renders the context's value and nothing else. */
export function DesktopStatusBadge() {
    const ctx = useContext(DesktopStatusContext);
    const status = ctx?.status ?? 'checking';
    const style = PILL[status];
    return (
        <span
            className={`flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium ${style.ring} ${style.text}`}
            data-testid="computer-status-pill"
            data-status={status}
        >
            <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
            {style.label}
        </span>
    );
}
