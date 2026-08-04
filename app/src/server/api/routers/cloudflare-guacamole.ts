/**
 * Cloudflare Guacamole/Neko Sandbox tRPC Router
 *
 * The bridge between an authenticated computer owner and the `worker/`
 * Cloudflare Worker that actually runs their desktop.
 *
 * Procedures:
 *   cloudflareGuacamole.isConfigured   — check whether env vars are present
 *   cloudflareGuacamole.previewUrl     — get/create a desktop preview URL
 *   cloudflareGuacamole.appPreviewUrl  — mint a fresh app-preview window URL
 *   cloudflareGuacamole.codePreviewUrl — mint a fresh code-server window URL
 *   cloudflareGuacamole.status         — health-check a computer's sandbox
 *   cloudflareGuacamole.terminate      — request sandbox teardown
 *   cloudflareGuacamole.reportActivity — record that a human is present (container-billing fix)
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
    APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
    composeAppPreviewBootstrapUrl,
    composeAppPreviewOrigin,
    composeBrowserDesktopUrl,
    composeCodePreviewOrigin,
    deriveGuacamoleSandboxId,
    deriveNekoAdminValue,
    enableImplicitHosting,
    FOCUSABLE_APPS,
    getGuacamoleSandboxStatus,
    isOwnDesktopOrigin,
    mintAppPreviewBootstrapToken,
    newCorrelationId,
    probeDesktopDisplay,
    probeDesktopFrame,
    readWorkerBridgeUrl,
    requestGuacamoleActivity,
    requestGuacamoleDesktopRestart,
    requestGuacamoleFocusApp,
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
     * Mint a fresh app-preview ("Option D" dev-server) window URL for the
     * given computer's sandbox.
     *
     * 🔴 Called PER WINDOW-OPEN, and refetched roughly every 50s by the
     * client while the window stays open — NEVER cached in
     * `/api/shell/session`'s boot payload. The minted bootstrap token has a
     * 5-minute TTL (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`); a token
     * minted once at boot and used minutes later — or held across a
     * long-open window without ever being refreshed — would already be
     * expired by the time it is actually used. Refetching well inside the
     * TTL keeps a fresh token ready for every reload the window might need,
     * without ever running the clock down to the wire.
     *
     * Reuses the exact SAME `/sandbox/preview` Worker call `previewUrl`
     * above makes (idempotent, and cheap once the desktop is warm —
     * `ensureDesktop`'s already-exposed fast path in `worker/src/index.ts` —
     * but able to cold-boot the container on the very first call), which is
     * why `../../../app/api/shell/preview-url/route.ts` needs the same
     * extended `maxDuration` as `../desktop/route.ts`.
     */
    appPreviewUrl: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
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
                    // Same correlation convention as `../desktop/route.ts`'s
                    // POST handler: defaulting sessionId to the computer id
                    // when the shell has no separate session concept for it.
                    sessionId: input.computerId,
                    userId: ctx.user.id,
                    projectId: input.computerId,
                    desktopMode: 'neko',
                },
                correlationId,
            );

            if (!result.ok) {
                const logSafe = result.error.slice(0, 200);
                console.error('[cloudflareGuacamole.appPreviewUrl] worker error', {
                    correlationId,
                    computerId: input.computerId,
                    error: logSafe,
                    errorCode: result.errorCode,
                    retryable: result.retryable,
                });

                // Same value-vs-throw split as `previewUrl` above — a thrown
                // error is what TanStack Query (and this route's own client
                // poller) retries, which is wrong for a deterministic
                // rejection and right for a transient one.
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

            // The ONE authoritative NEGATIVE signal `appPreviewExpose` can
            // give: exposure was attempted THIS call and failed. On the
            // warm/fast path the Worker reports `attempted: false` even when
            // a PRIOR call already exposed the port successfully (see
            // `GuacamolePreviewSuccess.appPreviewExpose`'s doc comment in the
            // provider) — so `attempted: false` is never treated as a
            // failure here, only an OBSERVED failure is.
            if (result.appPreviewExpose?.attempted && !result.appPreviewExpose.exposed) {
                console.error('[cloudflareGuacamole.appPreviewUrl] app-preview port exposure failed', {
                    correlationId,
                    computerId: input.computerId,
                    error: result.appPreviewExpose.error,
                });
                return {
                    ok: false as const,
                    error: result.appPreviewExpose.error ?? 'app_preview_expose_failed',
                    errorCode: 'app_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            // 🔴 PREFER THE WORKER'S OWN COMPOSED URL, and read `null` vs
            // `undefined` as the Worker means them.
            //
            // `handlePreview` now composes the whole
            // `…/preview-bootstrap?token=…` URL from the hostname
            // `exposePreviewPort` ACTUALLY produced, so it cannot disagree
            // with the Worker's per-request zone-collapse decision the way a
            // second implementation over here can. It also documents the
            // three-state field deliberately:
            //
            //   string     — use it verbatim;
            //   null       — this Worker knows about the field and is saying
            //                the port is NOT exposed. That is a real negative,
            //                and composing our own URL to paper over it would
            //                hand the user a window that cannot load;
            //   undefined  — the Worker predates the field. App and Worker are
            //                separate deploy targets, so this is a real state
            //                and not a hypothetical: fall back to composing
            //                the URL here, exactly as before.
            const verdict = readWorkerBridgeUrl(result.appPreviewUrl);
            if (verdict.kind === 'refuse') {
                console.error('[cloudflareGuacamole.appPreviewUrl] worker reports the app-preview port is not exposed', {
                    correlationId,
                    computerId: input.computerId,
                });
                return {
                    ok: false as const,
                    error: 'app_preview_port_not_exposed',
                    errorCode: 'app_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }
            if (verdict.kind === 'use') {
                return {
                    ok: true as const,
                    correlationId,
                    appPreviewUrl: verdict.url,
                    expiresAt: Date.now() + APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const appPreviewOrigin = composeAppPreviewOrigin(result.guacamoleUrl, sandboxId);
            if (!appPreviewOrigin) {
                console.error('[cloudflareGuacamole.appPreviewUrl] could not derive an app-preview origin', {
                    correlationId,
                    computerId: input.computerId,
                });
                return {
                    ok: false as const,
                    error: 'app_preview_origin_unresolvable',
                    errorCode: 'app_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const token = mintAppPreviewBootstrapToken(hmacSecret, sandboxId);
            const appPreviewUrl = composeAppPreviewBootstrapUrl(appPreviewOrigin, token);

            return {
                ok: true as const,
                correlationId,
                appPreviewUrl,
                expiresAt: Date.now() + APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
                provider: 'cloudflare-guacamole' as const,
            };
        }),

    /**
     * Mint a fresh code-server window URL for the given computer's sandbox.
     *
     * MODIFIED BY EZIL 2026-08-01 (T7): this is `appPreviewUrl` above, applied
     * to the code-server bridge instead of the app-preview one — same Worker
     * call, same bootstrap-token contract, same three-state
     * `readWorkerBridgeUrl` reasoning, same "call per window-open, never
     * cache" rule (the whole gap this task closes: the Worker has returned
     * `codePreviewUrl` since Wave A and nothing on the app side ever read it —
     * see `cloudflare-guacamole-provider.ts`'s `GuacamolePreviewSuccess`
     * doc comment).
     *
     * Deliberately a SEPARATE procedure rather than a parameterised
     * `previewUrl({computerId, target})`: the two bridges differ in exactly
     * the fields read off `result` (`codePreviewExpose`/`codePreviewUrl` vs.
     * `appPreviewExpose`/`appPreviewUrl`) and in the fallback compose helper
     * (`composeCodePreviewOrigin` vs. `composeAppPreviewOrigin`) — a shared
     * implementation would need a runtime branch on every one of those, for a
     * function this short. Two readable procedures beat one branchy one.
     *
     * Reuses the exact SAME `/sandbox/preview` Worker call `appPreviewUrl`
     * makes — the Worker mints/returns both bridge URLs on one round trip —
     * which is why `../../../app/api/shell/code-preview-url/route.ts` needs
     * the same extended `maxDuration` as `../preview-url/route.ts`.
     */
    codePreviewUrl: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
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
                    sessionId: input.computerId,
                    userId: ctx.user.id,
                    projectId: input.computerId,
                    desktopMode: 'neko',
                },
                correlationId,
            );

            if (!result.ok) {
                const logSafe = result.error.slice(0, 200);
                console.error('[cloudflareGuacamole.codePreviewUrl] worker error', {
                    correlationId,
                    computerId: input.computerId,
                    error: logSafe,
                    errorCode: result.errorCode,
                    retryable: result.retryable,
                });

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

            // Same rule as `appPreviewUrl`'s `appPreviewExpose` check above:
            // `attempted: false` is never a negative on its own (either
            // guacamole mode has no code-server surface, or a prior call
            // already exposed it and the fast path skipped re-attempting).
            // Only an OBSERVED `attempted: true, exposed: false` is refused.
            if (result.codePreviewExpose?.attempted && !result.codePreviewExpose.exposed) {
                console.error('[cloudflareGuacamole.codePreviewUrl] code-preview port exposure failed', {
                    correlationId,
                    computerId: input.computerId,
                    error: result.codePreviewExpose.error,
                });
                return {
                    ok: false as const,
                    error: result.codePreviewExpose.error ?? 'code_preview_expose_failed',
                    errorCode: 'code_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            // Prefer the Worker's own composed URL; fall back to composing
            // ours only when this Worker predates the field. See
            // `readWorkerBridgeUrl`'s doc comment — same three-state contract
            // `appPreviewUrl` above already relies on.
            const verdict = readWorkerBridgeUrl(result.codePreviewUrl);
            if (verdict.kind === 'refuse') {
                console.error('[cloudflareGuacamole.codePreviewUrl] worker reports the code-preview port is not exposed', {
                    correlationId,
                    computerId: input.computerId,
                });
                return {
                    ok: false as const,
                    error: 'code_preview_port_not_exposed',
                    errorCode: 'code_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }
            if (verdict.kind === 'use') {
                return {
                    ok: true as const,
                    correlationId,
                    codePreviewUrl: verdict.url,
                    expiresAt: Date.now() + APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const codePreviewOrigin = composeCodePreviewOrigin(result.guacamoleUrl, sandboxId);
            if (!codePreviewOrigin) {
                console.error('[cloudflareGuacamole.codePreviewUrl] could not derive a code-preview origin', {
                    correlationId,
                    computerId: input.computerId,
                });
                return {
                    ok: false as const,
                    error: 'code_preview_origin_unresolvable',
                    errorCode: 'code_preview_unavailable' as const,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const token = mintAppPreviewBootstrapToken(hmacSecret, sandboxId);
            // `folder=` is what makes code-server open with a file tree instead
            // of "You have no recent folders" — see `handlePreviewBootstrap`'s
            // doc comment in `worker/src/preview-bridge.ts` for the full
            // mechanism. This is the FALLBACK branch only (a Worker predating
            // `codePreviewUrl` on the wire); the primary path already gets
            // `folder=` baked in by `worker/src/index.ts`'s `buildBridgeUrl`,
            // which this mirrors using the SAME `workspace.mountPath` the
            // Worker computed and returned on this exact response — never a
            // literal `/workspace` — guarded by the same `mounted` check
            // `buildBridgeUrl` uses, since an unmounted workspace means the
            // container's real root is its own `/home/neko/project` fallback.
            const codeFolder = result.workspace?.mounted && result.workspace.mountPath
                ? { folder: result.workspace.mountPath }
                : undefined;
            const codePreviewUrl = composeAppPreviewBootstrapUrl(codePreviewOrigin, token, '/', codeFolder);

            return {
                ok: true as const,
                correlationId,
                codePreviewUrl,
                expiresAt: Date.now() + APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
                provider: 'cloudflare-guacamole' as const,
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

    /**
     * Is the desktop actually DELIVERING PIXELS to a browser?
     *
     * `confirmFrame` above answers "is there a desktop at that URL". This
     * answers the question underneath it, and the two are genuinely separable:
     * measured under WebKit, the origin answered 200 and the shell went ready
     * in 4.6s while the `<video>` element had `videoWidth: 0` and no
     * `srcObject` at all. Neko is the only witness — see `probeDesktopDisplay`.
     *
     * 🔴 Same SSRF pin as `confirmFrame`, for the same reason and with more at
     * stake: this one posts the per-sandbox Neko ADMIN credential to whatever
     * origin it is given. `isOwnDesktopOrigin` must gate it, and a refusal here
     * is `unknown` rather than `blank` — refusing to probe is not an
     * observation of anything, and must not be laundered into a failure the
     * user is shown.
     */
    confirmDisplay: protectedProcedure
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
                return { display: 'unknown' as const, reason: 'provider_not_configured' as const };
            }

            let workerHost: string;
            try {
                workerHost = new URL(config.workerUrl).hostname;
            } catch {
                return { display: 'unknown' as const, reason: 'provider_not_configured' as const };
            }

            const sandboxId = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            if (!isOwnDesktopOrigin(workerHost, sandboxId, input.frameUrl)) {
                console.warn('[cloudflareGuacamole.confirmDisplay] refused a foreign origin', {
                    computerId: input.computerId,
                });
                return { display: 'unknown' as const, reason: 'not_own_origin' as const };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            // Same fallback as `previewUrl`'s implicit-hosting handshake: a
            // keyless local dev environment runs Neko's built-in default admin
            // password. The derived value is never returned or logged.
            const adminPassword = hmacSecret ? deriveNekoAdminValue(hmacSecret, sandboxId) : 'admin';

            const probe = await probeDesktopDisplay(input.frameUrl, adminPassword);
            if (probe.display === 'live') {
                return { display: 'live' as const, watching: probe.watching, sessions: probe.sessions };
            }
            if (probe.display === 'blank') {
                return { display: 'blank' as const, sessions: probe.sessions };
            }
            return { display: 'unknown' as const, reason: probe.reason, status: probe.status };
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

    /**
     * Foreground an app inside the computer's X session.
     *
     * The one thing to notice about the input schema: `app` is
     * `z.enum(FOCUSABLE_APPS)` — the PRODUCT's enum, not the Worker's. See
     * `FOCUSABLE_APPS` in the provider for why they differ and why narrowing
     * belongs here. A client asking for anything else (including the Worker's
     * still-legal `'vscode'`) is rejected by zod as a 400 before a Worker call
     * is made, so the browser can never be handed a control that is guaranteed
     * to fail.
     *
     * Returns the outcome as a VALUE on a 200, like `terminate` above: a focus
     * switch that the container refused is a real answer the UI must render
     * honestly, not an exception for a client to retry.
     */
    focusApp: protectedProcedure
        .input(
            z.object({
                computerId: z.string().uuid(),
                app: z.enum(FOCUSABLE_APPS),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return { ok: false as const, error: 'provider_not_configured', provider: 'cloudflare-guacamole' as const };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            const result = await requestGuacamoleFocusApp(config, hmacSecret, sandboxName, input.app, correlationId);

            return {
                ok: result.ok,
                app: input.app,
                error: result.error,
                correlationId,
                provider: 'cloudflare-guacamole' as const,
            };
        }),

    /**
     * Record that a human is present at a computer's desktop — the
     * client-side heartbeat that lets the Worker's idle-container reaper tell
     * "someone is watching" from "a tab is merely still open". See
     * `shell/ezil/apps/desktop-window.js`'s heartbeat wiring for the caller
     * and `requestGuacamoleActivity`'s doc comment for why this NEVER touches
     * the container itself.
     *
     * Ownership is checked here, once, by `assertOwnedComputer` — same as
     * every other procedure in this router. Same "value not exception"
     * contract as `focusApp`/`terminate`: a rejected or disabled heartbeat is
     * a real, non-fatal answer the client silently swallows (see
     * `session.js#reportActivity`), never something to throw and retry — a
     * thrown error is what TanStack Query retries, and retrying a heartbeat
     * whose next beat is 60s away is a contradiction in terms.
     */
    reportActivity: protectedProcedure
        .input(
            z.object({
                computerId: z.string().uuid(),
                lastInputAgoMs: z.number().finite().nonnegative(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return {
                    ok: false as const,
                    error: 'provider_not_configured',
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            const result = await requestGuacamoleActivity(
                config,
                hmacSecret,
                sandboxName,
                input.lastInputAgoMs,
                correlationId,
            );

            return {
                ok: result.ok,
                error: result.error,
                correlationId,
                provider: 'cloudflare-guacamole' as const,
            };
        }),

    /**
     * Restart the desktop stack inside the computer's LIVE container.
     *
     * Ownership is checked here, once, by `assertOwnedComputer` — exactly like
     * `terminate`/`focusApp`. The sandbox id is DERIVED from
     * `(ctx.user.id, computerId)`, never taken from the client, so a caller
     * cannot address someone else's container even if they guess its name.
     *
     * Returns the Worker's outcome as a VALUE on a 200, like `terminate` and
     * `focusApp`: a restart the container refused (`stop_timed_out`,
     * `unsupported_mode`) is a real answer the UI must render honestly, not an
     * exception. `errorCode` is what `shell/ezil/ui/Settings/tabs/troubleshoot.js`
     * renders through its `reasonCopy()` switch, so it is a stable, low-cardinality
     * string, not a raw message.
     */
    restartDesktop: protectedProcedure
        .input(z.object({ computerId: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            await assertOwnedComputer(ctx.db, ctx.user.id, input.computerId);

            const config = resolveCloudflareGuacamoleConfig();
            if (!config.isConfigured) {
                return {
                    ok: false as const,
                    errorCode: 'provider_not_configured',
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
            const sandboxName = deriveGuacamoleSandboxId(ctx.user.id, input.computerId);
            const correlationId = newCorrelationId();
            const result = await requestGuacamoleDesktopRestart(config, hmacSecret, sandboxName, correlationId);

            if (!result.ok) {
                return {
                    ok: false as const,
                    // The Worker's own discriminator when it answered at all;
                    // `unknown` when it did not (transport failure). 🔴 Never
                    // `result.error` — that is a free-text message that can carry
                    // a URL or a stack fragment, and this value is rendered.
                    errorCode: result.outcome ?? 'unknown',
                    correlationId,
                    provider: 'cloudflare-guacamole' as const,
                };
            }

            return {
                ok: true as const,
                outcome: result.outcome,
                wasRunning: result.wasRunning,
                correlationId,
                provider: 'cloudflare-guacamole' as const,
            };
        }),
});
