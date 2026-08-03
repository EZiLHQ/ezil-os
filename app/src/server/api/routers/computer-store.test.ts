/**
 * Tests for the soft-delete-only computer row surface.
 *
 * These run against a REAL Drizzle query builder — `drizzle-orm/pg-proxy`
 * gives a database whose "driver" is a plain async callback, so every
 * statement the production code path builds is captured as the exact SQL
 * text and parameters Postgres would receive, with no database, no
 * connection and no `@/env`. That matters here: the two properties under
 * test ("deleted rows are filtered out" and "no hard DELETE is ever
 * issued") are properties of the generated SQL, not of a mock's call log.
 *
 * See `docs/PLATFORM-NOTES.md`'s method note — verify the artifact that
 * actually executes.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/pg-proxy';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { computerCreateError } from './computer-errors';
import {
    createComputerInLowestFreeSlot,
    getOrCreateDefaultComputer,
    isUniqueViolation,
    liveComputersOf,
    liveOwnedComputer,
    pickFreeSlot,
    softDeleteComputer,
    type ComputerCreateDb,
    type ComputerStoreDb,
} from './computer-store';

/**
 * True when `needle` appears in an error's message or anywhere down its
 * `cause` chain.
 *
 * drizzle-orm >= 0.44 wraps every driver error in a `DrizzleQueryError`
 * ("Failed query: …") and hangs the original postgres error off `.cause`, so
 * a top-level message match no longer sees the real failure. Bounded depth so
 * a self-referential cause cannot hang the suite.
 */
function causeChainIncludes(error: unknown, needle: string): boolean {
    let current: unknown = error;
    for (let depth = 0; depth < 5; depth += 1) {
        if (typeof current !== 'object' || current === null) return false;
        const message = (current as { message?: unknown }).message;
        if (typeof message === 'string' && message.includes(needle)) return true;
        current = (current as { cause?: unknown }).cause;
    }
    return false;
}

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '22222222-2222-2222-2222-222222222222';
const COMPUTER = '33333333-3333-3333-3333-333333333333';
const WINNER = '44444444-4444-4444-4444-444444444444';
const DELETED_AT = new Date('2026-07-31T12:00:00.000Z');

interface Statement {
    sql: string;
    params: unknown[];
}

/**
 * A driverless Drizzle database that records every statement and replays
 * canned rows. Rows are arrays of column values in `returning`/`columns`
 * order, which is exactly the shape the pg-proxy driver contract expects.
 */
function makeTestDb(rows: { select?: unknown[][]; update?: unknown[][] } = {}) {
    const statements: Statement[] = [];
    const db = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            if (/^\s*update\b/i.test(sql)) return { rows: rows.update ?? [] };
            return { rows: rows.select ?? [] };
        },
        { schema },
    );
    return { db, statements };
}

/** A row exists and is the caller's; the UPDATE then stamps and returns it. */
function makeLiveComputerDb(slot = 1) {
    return makeTestDb({
        select: [[COMPUTER]],
        update: [[COMPUTER, slot, DELETED_AT.toISOString()]],
    });
}

/**
 * A driverless database whose answer to each statement is scripted BY CALL
 * ORDER, so a multi-statement race can be reproduced exactly: return rows to
 * replay them, return an `Error` to make that statement fail (which is how a
 * real SQLSTATE 23505 unique violation is injected).
 *
 * Column order for a full row, taken from the SQL drizzle actually emits:
 * id, user_id, name, slot, created_at, last_opened_at, deleted_at, metadata.
 */
function makeScriptedDb(script: (unknown[][] | Error)[]) {
    const statements: Statement[] = [];
    const db = drizzle(
        async (sql, params) => {
            const answer = script[statements.length] ?? [];
            statements.push({ sql, params });
            if (answer instanceof Error) throw answer;
            return { rows: answer };
        },
        { schema },
    );
    return { db, statements };
}

/** Exactly what postgres.js surfaces for a partial-unique-index collision. */
function uniqueViolation(): Error {
    return Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
        constraint_name: 'ezil_computers_user_slot_uidx',
    });
}

function computerRow(id: string, slot: number, name = 'Computer'): unknown[] {
    return [id, USER, name, slot, '2026-07-31T09:00:00.000Z', null, null, null];
}

const isInsert = (s: Statement) => /^\s*insert\b/i.test(s.sql);

beforeEach(() => {
    vi.restoreAllMocks();
});

// ── The "live" filters — what makes a soft-deleted computer disappear ────────

describe('liveComputersOf (the filter computer.list uses)', () => {
    it('excludes soft-deleted rows in SQL, scoped to the owner', async () => {
        const { db, statements } = makeTestDb();

        await db.query.computers.findMany({ where: liveComputersOf(USER) });

        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/"deleted_at" is null/);
        expect(statements[0]!.sql).toMatch(/"user_id" = \$1/);
        expect(statements[0]!.params).toEqual([USER]);
    });
});

describe('liveOwnedComputer (the filter get/rename/touch/delete use)', () => {
    it('requires the id, the owner AND a live row', async () => {
        const { db, statements } = makeTestDb();

        await db.query.computers.findFirst({ where: liveOwnedComputer(USER, COMPUTER) });

        expect(statements[0]!.sql).toMatch(/"deleted_at" is null/);
        expect(statements[0]!.params).toContain(USER);
        expect(statements[0]!.params).toContain(COMPUTER);
    });
});

// ── softDeleteComputer ───────────────────────────────────────────────────────

describe('softDeleteComputer', () => {
    it('stamps deleted_at with an UPDATE and issues no DELETE at all', async () => {
        const { db, statements } = makeLiveComputerDb(2);

        const result = await softDeleteComputer(db, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {},
            now: DELETED_AT,
        });

        expect(result).toEqual({
            id: COMPUTER,
            slot: 2,
            deletedAt: DELETED_AT,
            sandboxTerminated: true,
        });

        const update = statements.find((s) => /^\s*update\b/i.test(s.sql));
        expect(update).toBeDefined();
        expect(update!.sql).toMatch(/^update "ezil_computers" set "deleted_at" = \$1/);
        // Drizzle serializes the timestamp on the way to the driver.
        expect(update!.params[0]).toBe(DELETED_AT.toISOString());

        // The load-bearing assertion: a hard DELETE would orphan the
        // computer's R2 prefix forever, because the row id IS that prefix.
        for (const statement of statements) {
            expect(statement.sql).not.toMatch(/\bdelete\s+from\b/i);
            expect(statement.sql).not.toMatch(/\btruncate\b/i);
        }
    });

    it('frees the slot: the stamped row drops out of the (user_id, slot) live index', async () => {
        const { db } = makeLiveComputerDb(1);

        const result = await softDeleteComputer(db, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {},
        });

        // Slot 1 was occupied and is reported as freed; with only slot 2
        // still taken, the next `create` picks slot 1 again.
        expect(result!.slot).toBe(1);
        expect(pickFreeSlot([2])).toBe(1);
    });

    it('scopes the UPDATE by user_id and deleted_at, not by id alone', async () => {
        const { db, statements } = makeLiveComputerDb();

        await softDeleteComputer(db, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {},
        });

        const update = statements.find((s) => /^\s*update\b/i.test(s.sql))!;
        expect(update.sql).toMatch(/"deleted_at" is null/);
        expect(update.params).toContain(USER);
        expect(update.params).toContain(COMPUTER);
    });

    it("refuses another user's computer: returns null, writes nothing, terminates nothing", async () => {
        // The ownership-scoped read matches no row for this caller.
        const { db, statements } = makeTestDb({ select: [] });
        const terminateSandbox = vi.fn(async () => {});

        const result = await softDeleteComputer(db, {
            userId: OTHER_USER,
            computerId: COMPUTER,
            terminateSandbox,
        });

        expect(result).toBeNull();
        expect(terminateSandbox).not.toHaveBeenCalled();
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/^select/i);
    });

    it('terminates the sandbox BEFORE stamping deleted_at', async () => {
        const { db } = makeLiveComputerDb();
        const order: string[] = [];
        const dbSpy: ComputerStoreDb = {
            query: db.query,
            update: ((...args: Parameters<typeof db.update>) => {
                order.push('update');
                return db.update(...args);
            }) as typeof db.update,
        };

        await softDeleteComputer(dbSpy, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {
                order.push('terminate');
            },
        });

        // The Worker's DELETE /sandbox/:name flushes the workspace to R2
        // and only then destroys the container, so it must run while the
        // computer is still live.
        expect(order).toEqual(['terminate', 'update']);
    });

    it('still frees the slot when sandbox teardown fails', async () => {
        const { db } = makeLiveComputerDb(2);
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await softDeleteComputer(db, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {
                throw new Error('worker unreachable');
            },
        });

        // A user whose desktop Worker is down must still be able to delete —
        // being unable to is the exact bug this procedure exists to fix.
        expect(result).toMatchObject({ id: COMPUTER, slot: 2, sandboxTerminated: false });
        expect(consoleError).toHaveBeenCalled();
    });

    it('returns null when a concurrent delete already stamped the row', async () => {
        // Read saw a live row; by UPDATE time another request had stamped it,
        // so the live-scoped where matches nothing.
        const { db } = makeTestDb({ select: [[COMPUTER]], update: [] });

        const result = await softDeleteComputer(db, {
            userId: USER,
            computerId: COMPUTER,
            terminateSandbox: async () => {},
        });

        expect(result).toBeNull();
    });
});

// ── The cap, and how a slot is freed ────────────────────────────────────────

describe('pickFreeSlot', () => {
    it('is null for a user at the cap — the state a delete has to rescue', () => {
        expect(pickFreeSlot([1, 2])).toBeNull();
    });

    it('reuses whichever slot was freed', () => {
        expect(pickFreeSlot([2])).toBe(1);
        expect(pickFreeSlot([1])).toBe(2);
        expect(pickFreeSlot([])).toBe(1);
    });
});

// ── createComputerInLowestFreeSlot — one implementation of the cap ──────────

describe('createComputerInLowestFreeSlot', () => {
    it('inserts into the lowest free slot and returns the row', async () => {
        const { db, statements } = makeScriptedDb([
            [[2]], // live slots: 2 is taken
            [computerRow(COMPUTER, 1)],
        ]);

        const outcome = await createComputerInLowestFreeSlot(db, { userId: USER });

        expect(outcome).toEqual({
            ok: true,
            computer: expect.objectContaining({ id: COMPUTER, slot: 1 }),
        });
        const insert = statements.find(isInsert)!;
        expect(insert.params).toContain(USER);
        expect(insert.params).toContain(1);
    });

    it('refuses at the cap WITHOUT attempting an insert', async () => {
        const { db, statements } = makeScriptedDb([[[1], [2]]]);

        const outcome = await createComputerInLowestFreeSlot(db, { userId: USER });

        expect(outcome).toEqual({ ok: false, reason: 'computer_limit_reached' });
        // The read alone settled it — a third computer is never even offered
        // to Postgres.
        expect(statements.filter(isInsert)).toHaveLength(0);
    });

    it('turns a lost slot race (SQLSTATE 23505) into the same typed reason, not a raw error', async () => {
        const { db } = makeScriptedDb([[], uniqueViolation()]);

        const outcome = await createComputerInLowestFreeSlot(db, { userId: USER });

        expect(outcome).toEqual({ ok: false, reason: 'computer_limit_reached' });
    });

    it('rethrows any OTHER database error — a real bug must not be reported as the cap', async () => {
        // 23502 = not_null_violation. Misreporting this as "you have too many
        // computers" would send the user to delete one for no reason.
        const notNull = Object.assign(new Error('null value in column'), { code: '23502' });
        const { db } = makeScriptedDb([[], notNull]);

        // Asserted through the cause chain, not on the top-level message:
        // drizzle-orm >= 0.44 wraps driver errors in a `DrizzleQueryError`
        // ("Failed query: …") and hangs the original off `.cause`. The
        // property under test is unchanged — a non-unique error must escape
        // rather than be laundered into the cap — so this checks the two
        // things that actually matter: it rejects at all, and the real error
        // is still reachable. Swallow it or map it to `computer_limit_reached`
        // and this still fails.
        let thrown: unknown;
        try {
            await createComputerInLowestFreeSlot(db, { userId: USER });
        } catch ( err ) {
            thrown = err;
        }
        expect(thrown, 'must reject, not return the cap outcome').toBeDefined();
        expect(causeChainIncludes(thrown, 'null value in column')).toBe(true);
    });

    it('reports an insert that returned no row distinctly from the cap', async () => {
        const { db } = makeScriptedDb([[], []]);

        const outcome = await createComputerInLowestFreeSlot(db, { userId: USER });

        expect(outcome).toEqual({ ok: false, reason: 'insert_returned_no_row' });
    });

    it('trims a supplied name and falls back to "Computer" for a blank one', async () => {
        for (const [supplied, expected] of [
            ['  Work box  ', 'Work box'],
            ['   ', 'Computer'],
            [undefined, 'Computer'],
        ] as const) {
            const { db, statements } = makeScriptedDb([[], [computerRow(COMPUTER, 1, expected)]]);
            await createComputerInLowestFreeSlot(db, { userId: USER, name: supplied });
            expect(statements.find(isInsert)!.params).toContain(expected);
        }
    });
});

// ── getOrCreateDefaultComputer — how /os boots ──────────────────────────────

describe('getOrCreateDefaultComputer', () => {
    it('returns the existing computer after exactly ONE read, and never inserts', async () => {
        const { db, statements } = makeScriptedDb([[computerRow(COMPUTER, 1)]]);

        const outcome = await getOrCreateDefaultComputer(db, { userId: USER });

        expect(outcome).toEqual({
            ok: true,
            created: false,
            computer: expect.objectContaining({ id: COMPUTER, slot: 1 }),
        });
        // The `/os` shell renders behind this call, so the returning-user path
        // is one indexed query — not a read, a slot scan and a write.
        expect(statements).toHaveLength(1);
        expect(statements.filter(isInsert)).toHaveLength(0);
    });

    it('asks the database for the LOWEST slot rather than sorting in JS', async () => {
        const { db, statements } = makeScriptedDb([[computerRow(COMPUTER, 2)]]);

        await getOrCreateDefaultComputer(db, { userId: USER });

        expect(statements[0]!.sql).toMatch(/order by "computers"\."slot" asc/);
        expect(statements[0]!.sql).toMatch(/"deleted_at" is null/);
        expect(statements[0]!.params).toContain(USER);
    });

    it('creates slot 1 for a user with no computers, and says so with created: true', async () => {
        const { db, statements } = makeScriptedDb([
            [], // no live computer
            [], // no live slots taken
            [computerRow(COMPUTER, 1)],
        ]);

        const outcome = await getOrCreateDefaultComputer(db, { userId: USER });

        expect(outcome).toEqual({
            ok: true,
            created: true,
            computer: expect.objectContaining({ id: COMPUTER, slot: 1 }),
        });
        expect(statements.filter(isInsert)).toHaveLength(1);
    });

    it('THE RACE: the loser of a concurrent double-create returns the winner\'s row, not a duplicate and not a 500', async () => {
        const { db, statements } = makeScriptedDb([
            [], // read: no computer yet
            [], // slot scan: nothing taken
            uniqueViolation(), // the other tab inserted slot 1 first
            [computerRow(WINNER, 1)], // re-read: the winner's row is now visible
        ]);

        const outcome = await getOrCreateDefaultComputer(db, { userId: USER });

        expect(outcome).toEqual({
            ok: true,
            created: false, // it exists, but THIS call did not create it
            computer: expect.objectContaining({ id: WINNER, slot: 1 }),
        });
        // Exactly one insert was attempted and it failed — so there is
        // precisely one row, and both callers were served from it.
        expect(statements.filter(isInsert)).toHaveLength(1);
    });

    it('THE CAP RACE: when the re-read still finds nothing, it reports computer_limit_reached — never a raw 23505', async () => {
        const { db, statements } = makeScriptedDb([
            [],
            [],
            uniqueViolation(),
            [], // re-read: still nothing (the winning row was soft-deleted meanwhile)
        ]);

        const outcome = await getOrCreateDefaultComputer(db, { userId: USER });

        // The typed reason the router turns into FORBIDDEN
        // `computer_limit_reached` — a refusal the client already knows how to
        // render, rather than an opaque 500 leaking a Postgres error code.
        expect(outcome).toEqual({ ok: false, reason: 'computer_limit_reached' });
        expect(statements.filter(isInsert)).toHaveLength(1);
    });

    it('does not retry the insert after a lost race — the re-read is the whole recovery', async () => {
        const { db, statements } = makeScriptedDb([[], [], uniqueViolation(), [computerRow(WINNER, 1)]]);

        await getOrCreateDefaultComputer(db, { userId: USER });

        // A second insert attempt is how a race turns into two computers.
        expect(statements.filter(isInsert)).toHaveLength(1);
        expect(statements).toHaveLength(4);
    });

    it('rethrows a non-unique-violation error instead of masking it as the cap', async () => {
        const boom = Object.assign(new Error('connection terminated'), { code: '08006' });
        const { db } = makeScriptedDb([[], [], boom]);

        // Cause-chain assertion — see the note on the create-path twin above.
        let thrown: unknown;
        try {
            await getOrCreateDefaultComputer(db, { userId: USER });
        } catch ( err ) {
            thrown = err;
        }
        expect(thrown, 'must reject, not return the cap outcome').toBeDefined();
        expect(causeChainIncludes(thrown, 'connection terminated')).toBe(true);
    });

    it('issues no DELETE on any path', async () => {
        const { db, statements } = makeScriptedDb([[], [], uniqueViolation(), [computerRow(WINNER, 1)]]);

        await getOrCreateDefaultComputer(db, { userId: USER });

        for (const statement of statements) {
            expect(statement.sql).not.toMatch(/\bdelete\s+from\b/i);
        }
    });

    it('hands the create path a database type with no `delete` member either', () => {
        const readDelete = (db: ComputerCreateDb) =>
            // @ts-expect-error — ComputerCreateDb deliberately exposes no `delete`.
            db.delete;
        expect(typeof readDelete).toBe('function');
    });
});

describe('isUniqueViolation', () => {
    it('is true only for SQLSTATE 23505', () => {
        expect(isUniqueViolation(uniqueViolation())).toBe(true);
        expect(isUniqueViolation({ code: '23505' })).toBe(true);
        expect(isUniqueViolation({ code: '23502' })).toBe(false);
        expect(isUniqueViolation(new Error('nope'))).toBe(false);
        expect(isUniqueViolation(null)).toBe(false);
        expect(isUniqueViolation(undefined)).toBe(false);
        expect(isUniqueViolation('23505')).toBe(false);
    });
});

describe('computerCreateError — the reason the browser actually receives', () => {
    it('maps the cap (however it was hit) to FORBIDDEN computer_limit_reached', () => {
        const err = computerCreateError('computer_limit_reached');
        expect(err.code).toBe('FORBIDDEN');
        // The client switches on this exact string — see
        // `src/app/computers/_lib/computer-limit.ts`.
        expect(err.message).toBe('computer_limit_reached');
    });

    it('keeps an unexpected empty insert as a 500, not a lie about the cap', () => {
        const err = computerCreateError('insert_returned_no_row');
        expect(err.code).toBe('INTERNAL_SERVER_ERROR');
        expect(err.message).toBe('Failed to create computer.');
    });
});

// ── No hard delete, structurally ────────────────────────────────────────────

describe('hard-delete guards', () => {
    it('hands the soft-delete path a database type with no `delete` member', () => {
        // This is a COMPILE-TIME guarantee and this is how it is pinned:
        // the directive below becomes an "unused '@ts-expect-error'" error
        // in `tsc --noEmit` the moment `ComputerStoreDb` grows a `delete` —
        // which is the only change that would make a hard DELETE against a
        // computer row writable in the first place.
        const readDelete = (db: ComputerStoreDb) =>
            // @ts-expect-error — ComputerStoreDb deliberately exposes no `delete`.
            db.delete;
        expect(typeof readDelete).toBe('function');
    });

    it('never calls .delete() anywhere in the computer router or its store', () => {
        for (const file of ['./computer.ts', './computer-store.ts']) {
            const source = readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
            expect(source).not.toMatch(/\.\s*delete\s*\(/);
        }
    });

    it('leaves the computer router with no second copy of the live-row filter', () => {
        // An inline `isNull(computers.deletedAt)` re-introduced in the router
        // is how "excluded from list" and "still addressable somewhere else"
        // would silently drift apart.
        const source = readFileSync(fileURLToPath(new URL('./computer.ts', import.meta.url)), 'utf8');
        expect(source).not.toMatch(/isNull\s*\(/);
    });
});
