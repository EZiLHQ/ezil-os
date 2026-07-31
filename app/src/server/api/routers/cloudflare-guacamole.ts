/**
 * Cloudflare Guacamole/Neko Sandbox tRPC Router
 *
 * The bridge between an authenticated computer owner and the `worker/`
 * Cloudflare Worker that actually runs their desktop.
 *
 * Procedures:
 *   cloudflareGuacamole.isConfigured — check whether env vars are present
 *   cloudflareGuacamole.previewUrl   — get/create a desktop preview URL
 *   cloudflareGuacamole.status       — health-check a computer's sandbox
 *   cloudflareGuacamole.terminate    — request sandbox teardown
 *
 * Security:
 *   - The Worker URL and HMAC secret NEVER reach the browser.
 *   - The browser only receives the opaque preview URL and provider metadata.
 *   - All calls to the Worker are server-side only.
 *   - `previewUrl`/`status`/`terminate` all derive the sandbox id from the
 *     AUTHENTICATED `ctx.user.id` + an ownership-checked computer id (via
 *     `computer.get` below) — a caller can only ever operate on their own
 *     computer's sandbox.
 *
 * Carried and simplified from EBuilder's
 * `apps/web/client/src/server/api/routers/cloudflare-guacamole.ts`
 * (authored post-Onlook-import, listed as safe to carry). See
 * `server/lib/cloudflare-guacamole-provider.ts`'s doc comment for what was
 * dropped and why (app-preview bootstrap, Twen orchestration, the Azure
 * dual-desktop-mode machinery — none of it applies to this repo, which has
 * exactly one desktop mode and one provider).
 */

import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { computers } from '@/server/db/schema';
import {
    composeBrowserDesktopUrl,
    deriveGuacamoleSandboxId,
    deriveNekoAdminValue,
    enableImplicitHosting,
    getGuacamoleSandboxStatus,
    isOwnDesktopOrigin,
    newCorrelationId,
    probeDesktopFrame,
    requestGuacamolePreview,
    requestGuacamoleSandboxTerminate,
    resolveCloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';
import { createTRPCRouter, protectedProcedure } from '../trpc';

// Error codes that represent expected operational failures (not server bugs).
// For these the router returns a typed result object instead of throwing so
// the canvas can render a first-class actionable diagnostics panel.
const OPERATIONAL_ERROR_CODES = new Set([
    'connection_refused',
    'fetch_failed',
    'sandbox_runtime_blocked',
    'sandbox_start_failed',
    'timeout',
]);

/** Ownership check shared by every procedure below — never trust a bare computerId. */
async function assertOwnedComputer(
    db: typeof import('@/server/db').db,
    userId: string,
    computerId: string,
): Promise<void> {
    const computer = await db.query.computers.findFirst({
        where: and(eq(computers.id, computerId), eq(computers.userId, userId), isNull(computers.deletedAt)),
        columns: { id: true },
    });
    if (!computer) {
        // NOT_FOUND, never FORBIDDEN — mirrors computer.get's anti-enumeration contract.
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
    }
}

export const cloudflareGuacamoleRouter = createTRPCRouter({
    /**
     * Check whether the desktop provider is configured. Safe to call from
     * the browser — returns only boolean metadata, never secret values or
     * internal URLs.
     */
    isConfigured: protectedProcedure.query(() => {
        const config = resolveCloudflareGuacamoleConfig();
        return {
            isConfigured: config.isConfigured,
            hasHmacSecret: config.hasHmacSecret,
            provider: 'cloudflare-guacamole' as const,
        };
    }),

    /**
     * Get or create a desktop preview URL for the given computer. Returns a
     * preview URL the desktop canvas iframe embeds.
     */
    previewUrl: protectedProcedure
        .input(
            z.object({
                sessionId: z.string().uuid(),
                computerId: z.string().uuid(),
            }),
        )
        .query(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return {
                    ok: false as const,
                    error: 'cloudflare_guacamole_not_configured',
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            const correlationId = newCorrelationId();

            const result = await requestGuacamolePreview(
                config,
                hmacSecret,
                {
                    sessionId: input.sessionId,
                    userId: ctx.user.id,
                    projectId: input.computerId,
                    desktopMode: 'neko',
                },
                correlationId,
            );

            if (!result.ok) {
                const logSafe = result.error.slice(0, 200);
                console.error('[cloudflareGuacamole.previewUrl] worker error', {
                    correlationId,
                    computerId: input.computerId,
                    error: logSafe,
                    errorCode: result.errorCode,
                    retryable: result.retryable,
                });

                // Throwing is not neutral: a thrown error is the only thing
                // TanStack Query retries, so anything thrown here is
                // re-attempted before the user sees a word. Right for a
                // transient failure, wrong for a deterministic one — a `400
                // missing_project_id`, a rejected HMAC signature, a
                // `CustomDomainRequiredError` all return the same answer
                // however many times they are asked. So `retryable: false`
                // comes back as a VALUE, which cannot be retried by
                // construction, alongside the operational codes that already
                // did. See `isRetryablePreviewErrorCode` in the provider.
                if (result.errorCode && (!result.retryable || OPERATIONAL_ERROR_CODES.has(result.errorCode))) {
                    return {
                        ok: false as const,
                        error: logSafe,
                        errorCode: result.errorCode,
                        provider: 'cloudflare-guacamole' as const,
                    };
                }

                throw new TRPCError({
                    code: 'BAD_GATEWAY',
                    message: `Desktop Worker returned an error (correlationId=${correlationId}). Check server logs for details.`,
                });
            }

            const sandboxId = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const composedGuacamoleUrl = composeBrowserDesktopUrl(
                result.guacamoleUrl,
                hmacSecret,
                sandboxId,
            );

            // 🔴 THE HANDOFF CHECK. Everything above proves the Worker
            // registered a preview port and gave us a URL. None of it proves a
            // browser pointed at that URL gets a desktop — the Worker's own
            // `guacamoleRunning` is read out of Durable Object storage and
            // never travels through the edge, so a broken edge route reports
            // healthy forever. Observed live 2026-07-31: `guacamoleRunning:
            // true` alongside HTTP 500 "Proxy routing error" on every request
            // to the preview host, with both surfaces reporting success over
            // it. Ask the origin directly, before the URL is handed out.
            //
            // Deliberately BEFORE `enableImplicitHosting` rather than after:
            // that handshake talks to the same origin and would otherwise burn
            // up to its own 8s budget failing against a host we already know is
            // not answering.
            const frame = await probeDesktopFrame(result.guacamoleUrl);
            if (!frame.alive) {
                console.error('[cloudflareGuacamole.previewUrl] desktop origin did not confirm', {
                    correlationId,
                    computerId: input.computerId,
                    reason: frame.reason,
                    status: frame.status,
                    detail: frame.detail,
                });
                // A VALUE, not a throw: the canvas retries thrown errors, and
                // hammering a broken edge route three times before the user
                // hears anything helps nobody. `desktop_unreachable` has its
                // own honest copy and its own Retry button.
                return {
                    ok: false as const,
                    error: `desktop_frame_${frame.reason}${frame.status ? `_${frame.status}` : ''}`,
                    errorCode: 'desktop_unreachable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            // Make the desktop respond to a plain click before the browser is
            // told where it is. This is one person's own computer, so control
            // must not be a handshake — see `enableImplicitHosting`. It runs
            // HERE, not in the browser, for two reasons: the admin credential
            // must never leave the server, and the client reads the flag once
            // at websocket init, so it has to be true before the iframe
            // exists. It never throws; a failure downgrades to 'manual' and
            // the canvas says so out loud rather than shipping a desktop that
            // silently ignores clicks.
            const controlMode =
                result.mode === 'local-dev-stub'
                    ? ('manual' as const)
                    : await enableImplicitHosting(
                          result.guacamoleUrl,
                          hmacSecret ? deriveNekoAdminValue(hmacSecret, sandboxId) : 'admin',
                      );
            if (controlMode !== 'implicit') {
                console.warn('[cloudflareGuacamole.previewUrl] implicit hosting unavailable', {
                    correlationId,
                    computerId: input.computerId,
                });
            }

            return {
                ok: true as const,
                correlationId,
                guacamoleUrl: composedGuacamoleUrl,
                expiresAt: result.expiresAt,
                provider: 'cloudflare-guacamole' as const,
                mode: result.mode,
                workspace: result.workspace,
                controlMode,
                // What we actually observed, with its status line, so the
                // client's `ready` is traceable to a real HTTP answer rather
                // than to this procedure having returned at all. Unreachable
                // as `false` — the guard above returns early — but typed as
                // the observation it is, not as a constant.
                frame: { confirmed: frame.alive, status: frame.status, observedAt: Date.now() },
            };
        }),

    /**
     * Re-confirm, AFTER the handoff, that the frame the browser is showing is
     * still a desktop.
     *
     * `previewUrl` probes the origin before it hands the URL out, which closes
     * the window this defect was found in. It cannot close the one after:
     * the edge route observed failing on 2026-07-31 degraded MID-SESSION, and
     * an iframe's `load` event fires for a 500 error page exactly as it does
     * for a working desktop. So `load` is treated as necessary but not
     * sufficient — the client calls this, and only a positive answer here
     * takes the boot panel down or lights the "Live" pill.
     *
     * Cheap by construction: one HTTP GET to an edge hostname. It does not
     * touch the Worker, does not wake a container, and cannot start one.
     *
     * 🔴 The `frameUrl` is CLIENT-SUPPLIED, which makes a naive implementation
     * an SSRF primitive. `isOwnDesktopOrigin` pins it to this authenticated
     * user's own sandbox hostname under our own Worker's zone; see that
     * function for the two conditions and why neither alone is enough. A URL
     * that fails the guard is answered `confirmed: false` with
     * `reason: 'not_own_origin'` and is never fetched.
     */
    confirmFrame: protectedProcedure
        .input(
            z.object({
                computerId: z.string().uuid(),
                frameUrl: z.string().url().max(2048),
            }),
        )
        .query(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return { confirmed: false as const, reason: 'provider_not_configured' as const };
            }

            let workerHost: string;
            try {
                workerHost = new URL(config.workerUrl).hostname;
            } catch {
                return { confirmed: false as const, reason: 'provider_not_configured' as const };
            }

            const sandboxId = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            if (!isOwnDesktopOrigin(workerHost, sandboxId, input.frameUrl)) {
                // Not a refusal to answer — an answer. The browser is showing
                // something that is not this user's desktop, which is exactly
                // the thing we must not call "Live".
                console.warn('[cloudflareGuacamole.confirmFrame] refused a foreign origin', {
                    computerId: input.computerId,
                });
                return { confirmed: false as const, reason: 'not_own_origin' as const };
            }

            const frame = await probeDesktopFrame(input.frameUrl);
            if (frame.alive) {
                return { confirmed: true as const, status: frame.status };
            }
            return { confirmed: false as const, reason: frame.reason, status: frame.status };
        }),

    /** Health-check a computer's sandbox. */
    status: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return { ok: false as const, error: 'provider_not_configured', provider: 'cloudflare-guacamole' as const };
            }

            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            const status = await getGuacamoleSandboxStatus(config, sandboxName, correlationId);

            return { ...status, sandboxName, correlationId, provider: 'cloudflare-guacamole' as const };
        }),

    /** Request teardown of a computer's sandbox. Fire-and-forget. */
    terminate: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return { ok: false as const, error: 'provider_not_configured', provider: 'cloudflare-guacamole' as const };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            const result = await requestGuacamoleSandboxTerminate(config, hmacSecret, sandboxName, correlationId);
            // Report what the Worker actually confirmed, not a hardcoded
            // success — `result.ok` is false for still_running/destroy_failed,
            // a rejected signature, or an unreachable Worker.
            return {
                ok: result.ok,
                terminated: result.terminated,
                outcome: result.outcome,
                error: result.error,
                sandboxName,
                correlationId,
                provider: 'cloudflare-guacamole' as const,
            };
        }),
});
