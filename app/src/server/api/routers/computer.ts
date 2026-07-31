/**
 * "Computers" tRPC Router
 *
 * A computer is the top-level unit of EZiL OS: login -> up to
 * `MAX_COMPUTERS_PER_USER` computers -> open one -> the streamed Linux
 * desktop. Projects (if any, later) are plain folders inside a computer's
 * workspace — no separate data model for them.
 *
 * A computer's `id` occupies the same "scope id" slot the Cloudflare
 * Guacamole/Neko desktop stack already treats as an opaque UUID (see
 * `server/lib/cloudflare-guacamole-provider.ts` and
 * `worker/src/index.ts`'s `deriveSandboxId` / `ensureWorkspaceMount`).
 *
 * Procedures: list / create / get / rename / touch / delete. `delete` is
 * SOFT delete only — it stamps `deleted_at` and never issues a SQL DELETE;
 * see `./computer-store.ts` for the full rationale and the type-level
 * guarantee that enforces it.
 *
 * Carried near-verbatim from EBuilder's
 * `apps/web/client/src/server/api/routers/computer.ts` (authored
 * post-Onlook-import, listed as safe to carry). Adapted only for this
 * repo's own db schema import path and its own (smaller)
 * `isUniqueViolation` helper — EBuilder's version lived in
 * `server/api/routers/project/access.ts`, which is Onlook-derived
 * scaffolding this repo does not carry, so the tiny helper is reproduced
 * fresh below instead of imported.
 */

import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { computers } from '@/server/db/schema';
import {
    deriveGuacamoleSandboxId,
    newCorrelationId,
    requestGuacamoleSandboxTerminate,
    resolveCloudflareGuacamoleConfig,
} from '@/server/lib/cloudflare-guacamole-provider';
import {
    liveComputersOf,
    liveOwnedComputer,
    MAX_COMPUTERS_PER_USER,
    pickFreeSlot,
    softDeleteComputer,
} from './computer-store';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Re-exported from `./computer-store.ts` (which owns them, so the row-level
 * rules stay importable without pulling in `../trpc` -> `@/server/db` ->
 * `@/env`). These two import paths are long-standing public API of this
 * module, so they keep working unchanged.
 */
export { MAX_COMPUTERS_PER_USER, pickFreeSlot };

/** Typed, friendly error thrown when a user is already at the computer cap. */
function computerLimitError(): TRPCError {
    return new TRPCError({ code: 'FORBIDDEN', message: 'computer_limit_reached' });
}

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code?: unknown }).code === '23505'
    );
}

/**
 * Ask the desktop Worker to tear down this computer's sandbox.
 *
 * Throws when the Worker did not CONFIRM the teardown (rejected the signed
 * request, answered `still_running`/`destroy_failed`, or was unreachable) —
 * `softDeleteComputer`'s try/catch (see `./computer-store.ts`) turns that
 * into `sandboxTerminated: false` and logs it, while the soft delete itself
 * still proceeds. A provider that isn't configured at all is a no-op rather
 * than a failure, since there is no sandbox to tear down.
 */
async function terminateComputerSandbox(userId: string, computerId: string): Promise<void> {
    const config = resolveCloudflareGuacamoleConfig();
    if (!config.isConfigured) return;
    const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    const result = await requestGuacamoleSandboxTerminate(
        config,
        hmacSecret,
        deriveGuacamoleSandboxId(userId, computerId),
        newCorrelationId(),
    );
    if (!result.ok) {
        throw new Error(`sandbox_terminate_not_confirmed: ${result.error ?? result.outcome ?? 'unknown'}`);
    }
}

export const computerRouter = createTRPCRouter({
    /**
     * List the authenticated user's live computers, lowest slot first.
     * Soft-deleted rows are excluded by `liveComputersOf`'s `deleted_at IS
     * NULL` half — a deleted computer is gone from this list immediately.
     */
    list: protectedProcedure.query(async ({ ctx }) => {
        return ctx.db.query.computers.findMany({
            where: liveComputersOf(ctx.user.id),
            orderBy: (row, { asc }) => [asc(row.slot)],
        });
    }),

    /**
     * Create a new computer in the caller's lowest free slot. Throws the
     * typed `computer_limit_reached` FORBIDDEN error once the user already
     * has `MAX_COMPUTERS_PER_USER` live computers — including the race case
     * where a concurrent duplicate request (e.g. a double-click) wins the
     * same slot first: the partial unique index on `(user_id, slot) WHERE
     * deleted_at IS NULL` turns that race into a Postgres unique violation,
     * which is caught here and converted to the SAME typed error rather
     * than surfacing as a raw 500.
     */
    create: protectedProcedure
        .input(
            z.object({
                name: z.string().trim().min(1).max(200).optional(),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const existing = await ctx.db.query.computers.findMany({
                where: liveComputersOf(ctx.user.id),
                columns: { slot: true },
            });

            const slot = pickFreeSlot(existing.map((row) => row.slot));
            if (slot === null) {
                throw computerLimitError();
            }

            try {
                const [created] = await ctx.db
                    .insert(computers)
                    .values({
                        userId: ctx.user.id,
                        slot,
                        name: input.name?.trim() || 'Computer',
                    })
                    .returning();

                if (!created) {
                    throw new TRPCError({
                        code: 'INTERNAL_SERVER_ERROR',
                        message: 'Failed to create computer.',
                    });
                }

                return created;
            } catch (err) {
                if (isUniqueViolation(err)) {
                    // Lost the race for this slot to a concurrent create —
                    // report the identical friendly, typed error instead of
                    // letting the raw Postgres unique-violation bubble up as
                    // an opaque 500.
                    throw computerLimitError();
                }
                throw err;
            }
        }),

    /** Fetch a single computer by id. Ownership-scoped: never returns another user's row. */
    get: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .query(async ({ ctx, input }) => {
            const computer = await ctx.db.query.computers.findFirst({
                where: liveOwnedComputer(ctx.user.id, input.id),
            });

            if (!computer) {
                // NOT_FOUND (never a distinguishing FORBIDDEN) so a caller
                // cannot use the response code to probe for the existence
                // of another user's computer.
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return computer;
        }),

    /** Rename a computer. Ownership-scoped. */
    rename: protectedProcedure
        .input(
            z.object({
                id: z.string().uuid(),
                name: z.string().trim().min(1).max(200),
            }),
        )
        .mutation(async ({ ctx, input }) => {
            const [updated] = await ctx.db
                .update(computers)
                .set({ name: input.name.trim() })
                .where(liveOwnedComputer(ctx.user.id, input.id))
                .returning();

            if (!updated) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return updated;
        }),

    /**
     * Stamp `lastOpenedAt = now()`. Called when the user opens a computer
     * into the EZiL OS desktop, so `list` can order/surface "recently used"
     * later.
     */
    touch: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            const [updated] = await ctx.db
                .update(computers)
                .set({ lastOpenedAt: new Date() })
                .where(liveOwnedComputer(ctx.user.id, input.id))
                .returning();

            if (!updated) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return updated;
        }),

    /**
     * SOFT delete a computer, freeing its slot.
     *
     * Without this, a user who has created `MAX_COMPUTERS_PER_USER`
     * computers is permanently stuck: `create` refuses a third and nothing
     * can release a slot.
     *
     * Order matters and is enforced in `softDeleteComputer`: ownership check
     * -> terminate the sandbox (which flushes the workspace to R2 and only
     * then destroys the container) -> stamp `deleted_at`. Freeing the slot
     * falls out of the stamp via the partial unique index; nothing else is
     * written, and **no SQL DELETE is ever issued** — the row id IS the R2
     * workspace prefix, so removing the row would orphan the user's files
     * forever (see `./computer-store.ts`).
     */
    delete: protectedProcedure
        .input(z.object({ id: z.string().uuid() }))
        .mutation(async ({ ctx, input }) => {
            const deleted = await softDeleteComputer(ctx.db, {
                userId: ctx.user.id,
                computerId: input.id,
                terminateSandbox: () => terminateComputerSandbox(ctx.user.id, input.id),
            });

            if (!deleted) {
                // Missing, already deleted, or someone else's — one
                // indistinguishable NOT_FOUND, same anti-enumeration
                // contract as `get`.
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return deleted;
        }),
});
