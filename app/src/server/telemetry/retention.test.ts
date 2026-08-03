import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
    analyzeErrorEvents,
    pruneErrorEvents,
    pruneStaleFingerprints,
    pruneUserHours,
    runTelemetryMaintenance,
    type RetentionDb,
} from './retention';

const dialect = new PgDialect();

/** Real drizzle `SQL` template objects only stringify to `[object Object]`;
 * this renders them the same way `drizzle-orm/pg-proxy` does before handing
 * text to a driver, so assertions can match on actual SQL. */
function toSqlText(query: unknown): string {
    return dialect.sqlToQuery(query as Parameters<PgDialect['sqlToQuery']>[0]).sql;
}

interface Call {
    sql: string;
}

/** A fake `RetentionDb` whose `execute` replays a scripted sequence of row
 * counts, one per call, so the chunked-loop behaviour (keep going until an
 * empty chunk) can be pinned without a real Postgres. */
function scriptedDb(counts: number[]) {
    const calls: Call[] = [];
    let i = 0;
    const db: RetentionDb = {
        execute: async (query) => {
            calls.push({ sql: toSqlText(query) });
            const n = counts[i] ?? 0;
            i++;
            return { rows: Array.from({ length: n }, (_, j) => ({ event_id: `row-${j}` })) };
        },
    };
    return { db, calls };
}

describe('pruneErrorEvents: chunked, never a single unbounded DELETE', () => {
    it('loops until an empty chunk, summing deleted rows across calls', async () => {
        const { db, calls } = scriptedDb([5000, 5000, 3, 0]);
        const result = await pruneErrorEvents(db, { chunkSize: 5000 });
        expect(result).toEqual({ deletedRows: 10003, hitBudget: false });
        expect(calls.length).toBe(4); // stopped as soon as a chunk came back empty
        for (const call of calls) {
            expect(call.sql).toMatch(/delete\s+from\s+ezil_error_events/i);
            expect(call.sql).toMatch(/limit/i);
        }
    });

    it('stops after a single chunk when nothing more is left', async () => {
        const { db, calls } = scriptedDb([0]);
        const result = await pruneErrorEvents(db);
        expect(result).toEqual({ deletedRows: 0, hitBudget: false });
        expect(calls.length).toBe(1);
    });

    it('respects the wall-clock budget rather than looping forever', async () => {
        // Every chunk claims to be full (never signals "done") — a real
        // unbounded backlog. The budget must still cut this off.
        const db: RetentionDb = {
            execute: async () => ({ rows: Array.from({ length: 5000 }, (_, j) => ({ event_id: `r${j}` })) }),
        };
        const result = await pruneErrorEvents(db, { chunkSize: 5000, budgetMs: 1 });
        expect(result.hitBudget).toBe(true);
        expect(result.deletedRows).toBeGreaterThan(0);
    });
});

describe('pruneUserHours: same chunked-loop shape', () => {
    it('loops until empty', async () => {
        const { db, calls } = scriptedDb([100, 0]);
        const result = await pruneUserHours(db, { chunkSize: 100 });
        expect(result).toEqual({ deletedRows: 100, hitBudget: false });
        expect(calls.length).toBe(2);
        expect(calls[0]!.sql).toMatch(/delete\s+from\s+ezil_error_user_hours/i);
    });
});

describe('pruneStaleFingerprints: unchunked but capped, low volume expected', () => {
    it('deletes rows matching the stale+low-count predicate', async () => {
        const { db, calls } = scriptedDb([7]);
        const result = await pruneStaleFingerprints(db);
        expect(result).toEqual({ deletedRows: 7, hitBudget: false });
        expect(calls[0]!.sql).toMatch(/delete\s+from\s+ezil_error_fingerprints/i);
        expect(calls[0]!.sql).toMatch(/total_count/i);
    });
});

describe('analyzeErrorEvents', () => {
    it('issues an ANALYZE, so the load-shed breaker sees fresh reltuples next', async () => {
        const seen: string[] = [];
        const db: RetentionDb = {
            execute: async (q) => {
                seen.push(toSqlText(q));
                return { rows: [] };
            },
        };
        await analyzeErrorEvents(db);
        expect(seen[0]).toMatch(/analyze/i);
        expect(seen[0]).toMatch(/ezil_error_events/i);
    });
});

describe('runTelemetryMaintenance: the whole hourly job', () => {
    it('prunes events, then user_hours, then stale fingerprints, then analyzes — and returns all three results', async () => {
        const order: string[] = [];
        const db: RetentionDb = {
            execute: async (q) => {
                const text = toSqlText(q).toLowerCase();
                if (text.includes('analyze')) order.push('analyze');
                else if (text.includes('ezil_error_events')) order.push('events');
                else if (text.includes('ezil_error_user_hours')) order.push('user_hours');
                else if (text.includes('ezil_error_fingerprints')) order.push('fingerprints');
                return { rows: [] };
            },
        };
        const result = await runTelemetryMaintenance(db);
        expect(order).toEqual(['events', 'user_hours', 'fingerprints', 'analyze']);
        expect(result.events).toEqual({ deletedRows: 0, hitBudget: false });
        expect(result.userHours).toEqual({ deletedRows: 0, hitBudget: false });
        expect(result.fingerprints).toEqual({ deletedRows: 0, hitBudget: false });
    });
});
