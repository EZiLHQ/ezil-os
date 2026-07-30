'use client';

import { useCallback, useMemo, useRef, useState } from 'react';

import { api } from '@/trpc/react';

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
 *     -> cloudflareGuacamole.previewUrl (tRPC)
 *     -> server/lib/cloudflare-guacamole-provider.ts
 *     -> worker/ (Cloudflare Worker, @cloudflare/sandbox container)
 *           -> Neko desktop (port 8080)
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

type LoadState =
    | { phase: 'loading' }
    | { phase: 'ready'; guacamoleUrl: string; workspace?: WorkspaceStatus }
    | { phase: 'not_configured' }
    | { phase: 'worker_unreachable'; rawError?: string }
    | { phase: 'sandbox_runtime_blocked' }
    | { phase: 'error'; message: string };

/** Human-readable label for the product's sole desktop preview mode. */
const EZIL_OS_LABEL = 'EZiL OS';

export function CloudflareGuacamoleCanvas({ computerId, sessionId }: CloudflareGuacamoleCanvasProps) {
    const [reloadKey, setReloadKey] = useState(0);
    const iframeRef = useRef<HTMLIFrameElement | null>(null);

    const isConfiguredQuery = api.cloudflareGuacamole.isConfigured.useQuery(undefined, {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
    });

    const previewQuery = api.cloudflareGuacamole.previewUrl.useQuery(
        { sessionId, computerId },
        {
            enabled: isConfiguredQuery.data?.isConfigured === true,
            // Refresh 5 min before token expiry (tokens are 55 min).
            refetchInterval: 50 * 60 * 1000,
            refetchOnWindowFocus: false,
            staleTime: 0,
            retry: 2,
        },
    );

    // Derived, not stored — `loadState` is a pure function of the two
    // queries above, so it's computed with `useMemo` rather than mirrored
    // into `useState` via an effect (which would cause an extra render on
    // every query transition for no benefit).
    const loadState: LoadState = useMemo(() => {
        if (isConfiguredQuery.isLoading) {
            return { phase: 'loading' };
        }
        if (!isConfiguredQuery.data?.isConfigured) {
            return { phase: 'not_configured' };
        }
        if (previewQuery.isLoading) {
            return { phase: 'loading' };
        }
        if (previewQuery.error) {
            const code = (previewQuery.error as { data?: { code?: string } }).data?.code;
            if (code === 'BAD_GATEWAY') {
                return { phase: 'worker_unreachable', rawError: previewQuery.error.message };
            }
            return {
                phase: 'error',
                message: `Failed to get ${EZIL_OS_LABEL} preview URL. Check server logs.`,
            };
        }
        if (!previewQuery.data) {
            return { phase: 'loading' };
        }
        if (!previewQuery.data.ok) {
            const errData = previewQuery.data as { ok: false; error?: string; errorCode?: string };
            if (errData.errorCode === 'connection_refused' || errData.errorCode === 'fetch_failed') {
                return { phase: 'worker_unreachable', rawError: errData.error };
            }
            if (
                errData.errorCode === 'sandbox_runtime_blocked' ||
                errData.errorCode === 'sandbox_start_failed'
            ) {
                return { phase: 'sandbox_runtime_blocked' };
            }
            return {
                phase: 'error',
                message: errData.error ?? `${EZIL_OS_LABEL} provider returned an error.`,
            };
        }
        return {
            phase: 'ready',
            guacamoleUrl: previewQuery.data.guacamoleUrl,
            workspace: previewQuery.data.workspace,
        };
    }, [
        isConfiguredQuery.isLoading,
        isConfiguredQuery.data,
        previewQuery.isLoading,
        previewQuery.error,
        previewQuery.data,
    ]);

    const handleReload = useCallback(() => {
        setReloadKey((k) => k + 1);
        void previewQuery.refetch();
    }, [previewQuery]);

    if (loadState.phase === 'not_configured') {
        return (
            <Panel testId="cf-guacamole-not-configured" tone="neutral">
                <p className="mb-1 font-medium text-white">EZiL OS desktop</p>
                <p className="mb-3 text-xs text-neutral-400">This computer&apos;s desktop provider is not configured.</p>
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

    if (loadState.phase === 'worker_unreachable') {
        return (
            <Panel testId="cf-guacamole-worker-down" tone="error" onRetry={handleReload}>
                <p className="mb-2 font-semibold text-white">Desktop worker unreachable</p>
                {loadState.rawError && (
                    <p className="mb-2 truncate rounded border border-neutral-700/50 bg-neutral-900/60 px-3 py-2 font-mono text-[10px] text-neutral-500">
                        {loadState.rawError.slice(0, 120)}
                    </p>
                )}
                <p className="text-xs text-neutral-400">
                    The worker that runs this computer isn&apos;t reachable right now. Try again in a
                    moment.
                </p>
            </Panel>
        );
    }

    if (loadState.phase === 'sandbox_runtime_blocked') {
        return (
            <Panel testId="cf-guacamole-runtime-blocked" tone="warning" onRetry={handleReload}>
                <p className="mb-2 font-semibold text-white">Desktop runtime unavailable</p>
                <p className="text-xs text-neutral-400">
                    The worker is reachable but the sandbox runtime failed to start. Retrying often
                    resolves this.
                </p>
            </Panel>
        );
    }

    if (loadState.phase === 'error') {
        return (
            <Panel testId="cf-guacamole-error" tone="error" onRetry={handleReload}>
                <p className="mb-2 font-semibold text-white">{EZIL_OS_LABEL} preview error</p>
                <p className="text-xs text-neutral-400">{loadState.message}</p>
            </Panel>
        );
    }

    if (loadState.phase === 'loading') {
        return (
            <div
                className="relative flex h-full w-full items-center justify-center bg-neutral-950"
                data-testid="cf-guacamole-loading"
            >
                <div className="flex flex-col items-center gap-2 text-neutral-400">
                    <div className="h-6 w-6 animate-spin rounded-full border-2 border-neutral-600 border-t-teal" />
                    <span className="text-xs">Starting {EZIL_OS_LABEL} sandbox…</span>
                </div>
            </div>
        );
    }

    const { guacamoleUrl, workspace } = loadState;

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
