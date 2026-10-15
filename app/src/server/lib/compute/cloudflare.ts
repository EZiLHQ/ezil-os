/**
 * Cloudflare adapter for `ComputeProvider` (docs/AWS-COMPUTERS.md, C-1).
 *
 * 🔴 A WRAPPER, NOT A MOVE. Every Worker call still lives in
 * `../cloudflare-guacamole-provider.ts`, under its existing name — that path
 * is read by `sdk/src/surface.test.ts`, `worker/src/screen-modes.test.ts` and
 * `local/src/server/shell-contract.test.ts`. This file only resolves the
 * Cloudflare configuration, derives the sandbox name from the
 * ownership-checked `(userId, computerId)` pair, and forwards. Results are the
 * provider functions' own objects, returned unchanged, so the router's
 * responses are byte-for-byte what they were before the seam existed
 * (`cloudflare.test.ts` proves the Worker sees identical requests).
 *
 * On Cloudflare, `stop` and `terminate` are the same Worker call:
 * `DELETE /sandbox/:name` flushes the workspace to R2 and destroys the
 * container. There is no stopped-but-retained state on this provider.
 */

import {
    deriveGuacamoleSandboxId,
    getGuacamoleSandboxStatus,
    requestGuacamoleActivity,
    requestGuacamoleDesktopRestart,
    requestGuacamolePreview,
    requestGuacamoleSandboxTerminate,
    resolveCloudflareGuacamoleConfig,
    type CloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';

import { previewTokenV2Enabled, type WorkerAuth } from './preview-token-v2';
import type {
    ActivitySignal,
    ComputeCtx,
    ComputeProvider,
    ComputerRef,
    EnsureOptions,
    StopReason,
} from './provider';

export interface CloudflareComputeDeps {
    resolveConfig: () => CloudflareGuacamoleConfig;
    /** Read at call time, never cached: same as the call sites this replaces. */
    readHmacSecret: () => string;
    /**
     * Sign Worker calls with the v2 envelope (C-5) instead of v1. Read at call
     * time. Default OFF: `EZIL_PREVIEW_TOKEN_V2=1` only, and only once the
     * Worker that verifies v2 is deployed.
     */
    useTokenV2: () => boolean;
}

const defaultDeps: CloudflareComputeDeps = {
    resolveConfig: resolveCloudflareGuacamoleConfig,
    readHmacSecret: () => process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
    useTokenV2: () => previewTokenV2Enabled(),
};

export function createCloudflareComputeProvider(overrides: Partial<CloudflareComputeDeps> = {}) {
    const deps: CloudflareComputeDeps = { ...defaultDeps, ...overrides };
    const sandboxOf = (c: ComputerRef) => deriveGuacamoleSandboxId(c.userId, c.computerId);
    /**
     * v2 claims for a Cloudflare computer: no generation or lease (0, 0), and
     * NO store claim (''): this app has no per-computer store record, and a
     * guessed 'r2' would lock every S3-pinned computer out (the Worker refuses
     * a store claim that differs from the computer's sticky store).
     */
    const authOf = (c: ComputerRef): WorkerAuth =>
        deps.useTokenV2()
            ? {
                kind: 'v2',
                claims: {
                    sandboxId: sandboxOf(c),
                    computerId: c.computerId,
                    userId: c.userId,
                    provider: 'cloudflare',
                    store: '',
                    generation: 0,
                    leaseEpoch: 0,
                },
            }
            : { kind: 'v1' };

    const terminate = (ctx: ComputeCtx, c: ComputerRef) =>
        requestGuacamoleSandboxTerminate(deps.resolveConfig(), deps.readHmacSecret(), sandboxOf(c), ctx.correlationId, authOf(c));

    return {
        kind: 'cloudflare' as const,

        /** `POST /sandbox/preview`. The body key order matches the pre-seam router. */
        ensure: (ctx: ComputeCtx, c: ComputerRef, opts: EnsureOptions) =>
            requestGuacamolePreview(
                deps.resolveConfig(),
                deps.readHmacSecret(),
                {
                    sessionId: opts.sessionId,
                    userId: c.userId,
                    projectId: c.computerId,
                    desktopMode: opts.desktopMode,
                    ...(opts.screen ? { screen: opts.screen } : {}),
                },
                ctx.correlationId,
                authOf(c),
            ),

        /**
         * `GET /sandbox/:name/status`. 🔴 UNAUTHENTICATED on the Worker today
         * (no signature is sent). C-1 asks for an authenticated status; that is
         * a Worker change, out of scope for a no-behaviour-change seam.
         */
        status: (ctx: ComputeCtx, c: ComputerRef) =>
            getGuacamoleSandboxStatus(deps.resolveConfig(), sandboxOf(c), ctx.correlationId),

        activity: (ctx: ComputeCtx, c: ComputerRef, s: ActivitySignal) =>
            requestGuacamoleActivity(
                deps.resolveConfig(),
                deps.readHmacSecret(),
                sandboxOf(c),
                s.lastInputAgoMs,
                ctx.correlationId,
                authOf(c),
            ),

        restart: (ctx: ComputeCtx, c: ComputerRef) =>
            requestGuacamoleDesktopRestart(deps.resolveConfig(), deps.readHmacSecret(), sandboxOf(c), ctx.correlationId, authOf(c)),

        stop: (ctx: ComputeCtx, c: ComputerRef, reason: StopReason) => {
            void reason; // Cloudflare has one teardown, whatever the reason.
            return terminate(ctx, c);
        },

        terminate,
    } satisfies ComputeProvider;
}

export type CloudflareComputeProvider = ReturnType<typeof createCloudflareComputeProvider>;

export const cloudflareComputeProvider: CloudflareComputeProvider = createCloudflareComputeProvider();
