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
 * Procedures: list / create / get / rename / touch. No delete procedure —
 * deletion is soft-delete only and out of scope for this wave.
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
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { computers } from '@/server/db/schema';
import { createTRPCRouter, protectedProcedure } from '../trpc';

/**
 * Hard cap on live (non-soft-deleted) computers per user. Lives here (and,
 * as a CHECK constraint, in the schema/migration) rather than only in the
 * partial unique index, so raising it later is a small, explicit,
 * one-place change.
 */
export const MAX_COMPUTERS_PER_USER = 2;

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
 * Pick the lowest-numbered free slot (1..MAX_COMPUTERS_PER_USER) given the
 * slots already occupied by the caller's live computers. Returns `null`
 * when every slot is taken. Pure and exported so slot-assignment behavior
 * (including the "always fill the lowest free slot, e.g. after deleting
 * slot 1" case) can be unit tested directly, without a database.
 */
export function pickFreeSlot(takenSlots: readonly number[]): number | null {
    const taken = new Set(takenSlots);
    for (let slot = 1; slot <= MAX_COMPUTERS_PER_USER; slot++) {
        if (!taken.has(slot)) {
            return slot;
        }
    }
    return null;
}

/** Standard "live" (non-soft-deleted) row filter, scoped to the caller. */
function ownedLiveComputer(userId: string, id: string) {
    return and(eq(computers.id, id), eq(computers.userId, userId), isNull(computers.deletedAt));
}

export const computerRouter = createTRPCRouter({
    /** List the authenticated user's live computers, lowest slot first. */
    list: protectedProcedure.query(async ({ ctx }) => {
        return ctx.db.query.computers.findMany({
            where: and(eq(computers.userId, ctx.user.id), isNull(computers.deletedAt)),
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
                where: and(eq(computers.userId, ctx.user.id), isNull(computers.deletedAt)),
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
                where: ownedLiveComputer(ctx.user.id, input.id),
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
                .where(ownedLiveComputer(ctx.user.id, input.id))
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
                .where(ownedLiveComputer(ctx.user.id, input.id))
                .returning();

            if (!updated) {
                throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
            }

            return updated;
        }),
});
