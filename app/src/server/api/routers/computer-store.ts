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
import { computers, type Computer } from '@/server/db/schema';

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
 * The database surface the CREATE path is given: relational reads (`query`)
 * and `insert`.
 *
 * A separate type from `ComputerStoreDb` on purpose. The soft-delete surface
 * above is documented as "`query` + `update`, and `delete` is absent ON
 * PURPOSE"; widening THAT type to also carry `insert` would blur the one
 * sentence a future reader most needs to be able to trust. So the create
 * path gets its own equally-narrow `Pick<>` — which, note, also has no
 * `delete`. Every database surface in this module is delete-free.
 */
export type ComputerCreateDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
    'query' | 'insert'
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

// ── Creating, and the get-or-create the OS shell boots through ──────────────

/** True for a Postgres unique-violation error (SQLSTATE 23505). */
export function isUniqueViolation(error: unknown): boolean {
    // 🔴 Walk the `cause` chain — do not just read `error.code`.
    //
    // drizzle-orm >= 0.44 wraps every driver error in a `DrizzleQueryError`
    // ("Failed query: insert into …") and hangs the original postgres error,
    // the one carrying SQLSTATE, off `.cause`. Before that upgrade the driver
    // error arrived bare, so a top-level `code` check was sufficient.
    //
    // This is not cosmetic. Both slot races depend on recognising 23505:
    // `createComputerInLowestFreeSlot` reports `computer_limit_reached`
    // instead of a raw 500, and `getOrCreateDefaultComputer` re-reads to
    // return the WINNER's row rather than failing the loser. A bare check
    // silently stops matching after the upgrade and both degrade into 500s
    // under exactly the concurrency they exist to handle — caught only
    // because those races have tests.
    //
    // Bounded depth: a cause chain is short, and an unbounded walk on a
    // self-referential `cause` would hang.
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth += 1) {
        if (typeof current !== 'object' || current === null) return false;
        if ((current as { code?: unknown }).code === '23505') return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

/**
 * Why the create path returns an outcome instead of throwing: this module is
 * deliberately free of `../trpc`, so it cannot mint a `TRPCError`. The router
 * maps each reason to the SAME typed error it has always thrown — see
 * `computerCreateError` in `./computer.ts`.
 *
 * `computer_limit_reached` covers BOTH ways a user can be at the cap: the
 * plain read said every slot was taken, and the read said otherwise but a
 * concurrent insert won the slot first (SQLSTATE 23505 on the partial unique
 * index `(user_id, slot) WHERE deleted_at IS NULL`). Collapsing them here is
 * the point — a double-click must not be able to produce a raw 500 or a
 * third computer.
 */
export type CreateComputerOutcome =
    | { ok: true; computer: Computer }
    | { ok: false; reason: 'computer_limit_reached' | 'insert_returned_no_row' };

/** The lowest-slot LIVE computer owned by `userId`, or undefined if they have none. */
export async function findLowestLiveComputer(
    db: ComputerCreateDb,
    userId: string,
): Promise<Computer | undefined> {
    return db.query.computers.findFirst({
        where: liveComputersOf(userId),
        orderBy: (row, { asc }) => [asc(row.slot)],
    });
}

/**
 * Insert one computer into the caller's lowest free slot.
 *
 * The single implementation of "make a computer", shared by
 * `computer.create` and `computer.getOrCreateDefault` so the cap and the
 * race handling below cannot drift between the two entry points.
 */
export async function createComputerInLowestFreeSlot(
    db: ComputerCreateDb,
    { userId, name }: { userId: string; name?: string },
): Promise<CreateComputerOutcome> {
    const existing = await db.query.computers.findMany({
        where: liveComputersOf(userId),
        columns: { slot: true },
    });

    const slot = pickFreeSlot(existing.map((row) => row.slot));
    if (slot === null) {
        return { ok: false, reason: 'computer_limit_reached' };
    }

    try {
        const [created] = await db
            .insert(computers)
            .values({ userId, slot, name: name?.trim() || 'Computer' })
            .returning();

        if (!created) {
            return { ok: false, reason: 'insert_returned_no_row' };
        }

        return { ok: true, computer: created };
    } catch (err) {
        if (isUniqueViolation(err)) {
            // Lost the race for this slot to a concurrent create — report the
            // identical friendly, typed reason instead of letting the raw
            // Postgres unique-violation bubble up as an opaque 500.
            return { ok: false, reason: 'computer_limit_reached' };
        }
        throw err;
    }
}

export interface GetOrCreateDefaultComputerResult {
    computer: Computer;
    /** True only when THIS call inserted the row. Never guessed. */
    created: boolean;
}

export type GetOrCreateDefaultComputerOutcome =
    | ({ ok: true } & GetOrCreateDefaultComputerResult)
    | { ok: false; reason: 'computer_limit_reached' | 'insert_returned_no_row' };

/**
 * "Open my computer" — the operation the OS shell boots through.
 *
 * Returns the caller's LOWEST-slot live computer, creating one only if they
 * have none. Idempotent by construction: a user who already has a computer
 * gets it back after exactly ONE indexed read, and never a second row.
 *
 * ## The race
 *
 * Two tabs (or a page and its prefetch) can reach the empty-user path at the
 * same instant. Both read zero live computers, both pick slot 1, and the
 * partial unique index turns the loser's insert into SQLSTATE 23505 —
 * surfaced by `createComputerInLowestFreeSlot` as `computer_limit_reached`.
 *
 * For a get-or-create, that reason is not yet an answer: the loser's user is
 * not at the cap, they simply lost a slot to their own other tab. So the
 * loser RE-READS. If the winner's row is now visible — the overwhelmingly
 * common case — it is returned with `created: false`, which is exactly what
 * get-or-create promises: one row, both callers served, no duplicate and no
 * 500.
 *
 * The re-read is allowed to come back empty (the winner's row soft-deleted in
 * the microseconds between), and then there is nothing true left to return.
 * The cap reason stands and the router raises the same typed
 * `computer_limit_reached` FORBIDDEN that `create` raises. That is a
 * deliberate choice of the honest failure over an invented one: the caller
 * gets a typed, retryable refusal rather than a fabricated row or a 500.
 */
export async function getOrCreateDefaultComputer(
    db: ComputerCreateDb,
    { userId, name }: { userId: string; name?: string },
): Promise<GetOrCreateDefaultComputerOutcome> {
    const existing = await findLowestLiveComputer(db, userId);
    if (existing) {
        return { ok: true, computer: existing, created: false };
    }

    const outcome = await createComputerInLowestFreeSlot(db, { userId, name });
    if (outcome.ok) {
        return { ok: true, computer: outcome.computer, created: true };
    }

    if (outcome.reason === 'computer_limit_reached') {
        const winner = await findLowestLiveComputer(db, userId);
        if (winner) {
            return { ok: true, computer: winner, created: false };
        }
    }

    return outcome;
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
