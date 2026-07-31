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
    getGuacamoleSandboxStatus,
    newCorrelationId,
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
                });

                if (result.errorCode && OPERATIONAL_ERROR_CODES.has(result.errorCode)) {
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

            return {
                ok: true as const,
                correlationId,
                guacamoleUrl: composedGuacamoleUrl,
                expiresAt: result.expiresAt,
                provider: 'cloudflare-guacamole' as const,
                mode: result.mode,
                workspace: result.workspace,
            };
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

            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            await requestGuacamoleSandboxTerminate(config, sandboxName, correlationId);
            return { ok: true as const, sandboxName, correlationId, provider: 'cloudflare-guacamole' as const };
        }),
});
