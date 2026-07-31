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
import {
    liveComputersOf,
    liveOwnedComputer,
    pickFreeSlot,
    softDeleteComputer,
    type ComputerStoreDb,
} from './computer-store';

const USER = '11111111-1111-1111-1111-111111111111';
const OTHER_USER = '22222222-2222-2222-2222-222222222222';
const COMPUTER = '33333333-3333-3333-3333-333333333333';
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
