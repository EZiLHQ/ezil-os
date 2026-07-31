/**
 * Computer row access — the SOFT-DELETE-ONLY database surface.
 *
 * Everything in this module is deliberately free of `../trpc`, `@/server/db`
 * and `@/env`, so the row-level rules that matter most (which rows are
 * "live", how a slot is freed, and the fact that a computer is NEVER hard
 * deleted) can be unit tested against a real Drizzle query builder without a
 * database or a validated environment.
 *
 * ## Why there is no hard delete
 *
 * A computer's `id` is used VERBATIM as the root of its R2 workspace prefix
 * (`${id}/branches/${branch}/...` — see `worker/src/index.ts`'s
 * `ensureWorkspaceHydratedFromR2` / `deriveSandboxId`). The row is the ONLY
 * thing that names that prefix. Hard-deleting the row therefore orphans the
 * user's files in R2 with nothing left able to address them, forever.
 *
 * So deletion is `deleted_at = now()` and nothing else. Three layers back
 * that up, and this module is the third:
 *
 *   1. Schema — `src/server/db/schema/computers.ts` documents it, and the
 *      partial unique index `(user_id, slot) WHERE deleted_at IS NULL` makes
 *      a soft delete free the slot by design.
 *   2. Database — `drizzle/0000_massive_mole_man.sql` grants SELECT, INSERT
 *      and UPDATE policies to the owner and deliberately NO DELETE policy.
 *   3. Types — `ComputerStoreDb` below is a `Pick<>` of the Drizzle database
 *      that exposes `query` and `update` and nothing else. There is no
 *      `delete` method on it, so `softDeleteComputer` cannot issue a DELETE:
 *      there is structurally nothing to call. This mirrors the put-only
 *      bucket interface the Worker's flush path uses for the same reason
 *      (`worker/src/workspace-persist.ts`, and `docs/PLATFORM-NOTES.md` §10 —
 *      "enforce it in the type system, not by convention").
 */

import { and, eq, isNull, type ExtractTablesWithRelations, type SQL } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';

/**
 * Hard cap on live (non-soft-deleted) computers per user. Lives here (and,
 * as a CHECK constraint, in the schema/migration) rather than only in the
 * partial unique index, so raising it later is a small, explicit,
 * one-place change. Re-exported from `./computer.ts`, which is the import
 * path the rest of the server uses.
 */
export const MAX_COMPUTERS_PER_USER = 2;

/**
 * The ONLY database surface the computer row helpers below are given:
 * relational reads (`query`) and `update`.
 *
 * `delete` is absent ON PURPOSE — see this module's doc comment. Widening
 * this type is the single change that could reintroduce the orphaned-R2-
 * prefix hazard, and `computer-store.test.ts` pins it shut with a
 * `@ts-expect-error` that starts failing the build the moment `delete`
 * becomes reachable.
 *
 * Typed off Drizzle's generic `PgDatabase` (not the concrete
 * `PostgresJsDatabase`) so the production `ctx.db` AND a driverless test
 * database both satisfy it.
 */
export type ComputerStoreDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
    'query' | 'update'
>;

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

/**
 * Filter for every LIVE computer belonging to `userId`. The `deleted_at IS
 * NULL` half is what makes a soft-deleted computer disappear from `list`,
 * stop counting toward the cap in `create`, and become unaddressable by
 * `get` / `rename` / `touch` / `delete` and the desktop provider router.
 */
export function liveComputersOf(userId: string): SQL | undefined {
    return and(eq(computers.userId, userId), isNull(computers.deletedAt));
}

/**
 * Filter for ONE live computer, scoped to its owner. Every per-computer
 * procedure funnels through this, so ownership can never be forgotten at a
 * call site: an id belonging to another user simply matches no row (and the
 * callers turn "no row" into NOT_FOUND, never a distinguishing FORBIDDEN).
 */
export function liveOwnedComputer(userId: string, id: string): SQL | undefined {
    return and(eq(computers.id, id), eq(computers.userId, userId), isNull(computers.deletedAt));
}

export interface SoftDeleteComputerInput {
    userId: string;
    computerId: string;
    /**
     * Tear down any sandbox running for this computer. Invoked BEFORE the
     * row is stamped, while the computer is still live and addressable —
     * the Worker's `DELETE /sandbox/:name` flushes the workspace to R2 and
     * only then destroys the container, so running it first is what turns
     * "the desktop is killed" into "the desktop is killed after its files
     * are safely in R2".
     *
     * Best effort by contract: a throw is logged and swallowed, never
     * propagated. A user whose desktop Worker is unreachable must still be
     * able to free their slot — that is the whole bug this procedure fixes.
     */
    terminateSandbox: () => Promise<void>;
    /** Injectable clock, for deterministic tests. */
    now?: Date;
}

export interface SoftDeleteComputerResult {
    id: string;
    /** The slot this computer occupied — now free for a new computer. */
    slot: number;
    deletedAt: Date | null;
    /** False when the sandbox teardown call failed; the soft delete still happened. */
    sandboxTerminated: boolean;
}

/**
 * Soft delete one computer: ownership-check, terminate its sandbox, then
 * stamp `deleted_at`. Returns `null` when there is no live computer with
 * that id owned by `userId` (missing, already deleted, or someone else's) —
 * the caller maps that to a plain NOT_FOUND.
 *
 * Freeing the slot is a CONSEQUENCE of the stamp, not a separate write: the
 * partial unique index `(user_id, slot) WHERE deleted_at IS NULL` stops
 * covering the row the instant `deleted_at` is non-null, so the next
 * `create` finds the slot free via `pickFreeSlot`.
 */
export async function softDeleteComputer(
    db: ComputerStoreDb,
    { userId, computerId, terminateSandbox, now = new Date() }: SoftDeleteComputerInput,
): Promise<SoftDeleteComputerResult | null> {
    // 1) Ownership first — never terminate a sandbox for a computer the
    //    caller does not own, and never reveal that it exists.
    const existing = await db.query.computers.findFirst({
        where: liveOwnedComputer(userId, computerId),
        columns: { id: true },
    });
    if (!existing) {
        return null;
    }

    // 2) Terminate BEFORE stamping. See `terminateSandbox`'s doc comment for
    //    why a failure here must not abort the delete.
    let sandboxTerminated = false;
    try {
        await terminateSandbox();
        sandboxTerminated = true;
    } catch (err) {
        console.error('[computer.delete] sandbox teardown failed — deleting anyway', {
            computerId,
            error: err instanceof Error ? err.message : String(err),
        });
    }

    // 3) UPDATE, never DELETE. The where clause is the same live+owned
    //    filter, so a concurrent delete that won the race leaves no row to
    //    update and this returns null rather than double-stamping.
    const [updated] = await db
        .update(computers)
        .set({ deletedAt: now })
        .where(liveOwnedComputer(userId, computerId))
        .returning({ id: computers.id, slot: computers.slot, deletedAt: computers.deletedAt });

    if (!updated) {
        return null;
    }

    return { ...updated, sandboxTerminated };
}
