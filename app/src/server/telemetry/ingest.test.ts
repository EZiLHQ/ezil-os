/**
 * Tests run against a REAL Drizzle query builder — `drizzle-orm/pg-proxy`
 * (same technique as `computer-store.test.ts`) — so the assertions are about
 * the actual SQL `ingestBatch` emits (ON CONFLICT clauses, statement order,
 * idempotency), not about a mock's call log. The proxy driver does not
 * implement `.transaction()`, so the fake `IngestDb` below invokes the
 * batch's callback directly against the same captured-statement query
 * builder — `ingestBatch` never calls anything ON the transaction handle
 * that this substitution would change the shape of (no nested
 * transactions, no savepoints), so this is a faithful stand-in for what
 * `db.transaction(async (tx) => ...)` looks like to the code under test.
 */
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { fingerprint } from './fingerprint';
import { ingestBatch, type IngestDb } from './ingest';
import type { ParsedTelemetryEventInput } from './schema';

interface Statement {
    sql: string;
    params: unknown[];
}

/**
 * @param alreadyStored eventIds Postgres would reject as duplicates, i.e. what
 *   `ON CONFLICT DO NOTHING` silently drops. The previous version of this
 *   harness could not express that at all — it returned one opaque row for
 *   every insert regardless — which is precisely why the aggregate
 *   double-counting bug survived ten green tests here and was only found by
 *   POSTing the same batch twice at a real Postgres. Modelling the drop is the
 *   difference between a mock that can fail and one that cannot.
 */
function makeTestDb(alreadyStored: readonly string[] = []) {
    const statements: Statement[] = [];
    const rejected = new Set(alreadyStored);
    const proxy = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            if (/^\s*insert\b/i.test(sql) && /returning\s+"event_id"/i.test(sql)) {
                // `RETURNING "event_id"` gives back exactly the rows that were
                // inserted, as single-column tuples. Recover each row's
                // event_id positionally from the real column list in the SQL
                // (rather than sniffing for uuid-shaped params, which would
                // also match `computer_id`), then drop the known duplicates.
                const cols = (sql.match(/insert into "ezil_error_events" \(([^)]*)\)/i)?.[1] ?? '')
                    .split(',')
                    .map((c) => c.trim().replace(/"/g, ''));
                const idIdx = cols.indexOf('event_id');
                if (idIdx < 0 || cols.length === 0) throw new Error('could not parse the events insert column list');
                const ids: string[] = [];
                for (let i = 0; i + cols.length <= params.length; i += cols.length) {
                    const id = params[i + idIdx] as string;
                    // Postgres inserts a repeated eventId once, so dedupe too.
                    if (!rejected.has(id) && !ids.includes(id)) ids.push(id);
                }
                return { rows: ids.map((id) => [id]) };
            }
            return { rows: [] };
        },
        { schema },
    );
    const db = {
        transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy),
    } as unknown as IngestDb;
    return { db, statements };
}

function event(overrides: Partial<ParsedTelemetryEventInput> = {}): ParsedTelemetryEventInput {
    return {
        eventId: '550e8400-e29b-41d4-a716-446655440000',
        schemaVersion: 1,
        eventClass: 'crash',
        source: 'shell',
        occurredAt: '2026-08-01T00:00:00.000Z',
        site: 'ezil-os:boot#mount',
        code: 'mount_failed',
        outcome: 'error',
        ...overrides,
    };
}

const USER_HASH = 'u_f5537974';

describe('ingestBatch: statement shape and order', () => {
    /**
     * 🔴 EVENTS FIRST. The counters in statements 2 and 3 are derived from what
     * statement 1 actually stored, so this order is correctness, not style.
     * The FK order that IS forced by the schema (`ezil_error_user_hours` ->
     * `ezil_error_fingerprints`) is still 2 before 3.
     */
    it('does three inserts in order: events, fingerprints, user_hours', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const inserts = statements.filter((s) => /^\s*insert\b/i.test(s.sql));
        expect(inserts).toHaveLength(3);
        expect(inserts[0]!.sql).toMatch(/"ezil_error_events"/);
        expect(inserts[1]!.sql).toMatch(/"ezil_error_fingerprints"/);
        expect(inserts[2]!.sql).toMatch(/"ezil_error_user_hours"/);
    });

    it('the events insert uses ON CONFLICT DO NOTHING on event_id (idempotent re-send)', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const eventsInsert = statements.find((s) => /"ezil_error_events"/.test(s.sql) && /insert/i.test(s.sql));
        expect(eventsInsert!.sql).toMatch(/on conflict/i);
        expect(eventsInsert!.sql).toMatch(/do nothing/i);
    });

    it('the fingerprints insert upserts last_seen_at and increments total_count', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const fpInsert = statements.find((s) => /"ezil_error_fingerprints"/.test(s.sql));
        expect(fpInsert!.sql).toMatch(/on conflict/i);
        expect(fpInsert!.sql).toMatch(/do update/i);
        expect(fpInsert!.sql).toMatch(/total_count/i);
    });

    it('the user_hours insert upserts on the (fingerprint, hour_bucket, user_hash) key', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const hoursInsert = statements.find((s) => /"ezil_error_user_hours"/.test(s.sql));
        expect(hoursInsert!.sql).toMatch(/on conflict/i);
        expect(hoursInsert!.sql).toMatch(/event_count/i);
    });

    it('stores the SERVER-computed fingerprint, never trusting a client-supplied one', async () => {
        const { db, statements } = makeTestDb();
        const e = event({ detail: 'boom 12345678ms' });
        await ingestBatch(db, [e], USER_HASH);

        const expectedFp = fingerprint({
            eventClass: e.eventClass,
            source: e.source,
            site: e.site,
            code: e.code,
            detail: e.detail,
        });
        const eventsInsert = statements.find((s) => /"ezil_error_events"/.test(s.sql) && /insert/i.test(s.sql));
        expect(eventsInsert!.params).toContain(expectedFp);
    });

    it('stores exactly the caller-supplied user_hash — ingestBatch never derives or invents one', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const eventsInsert = statements.find((s) => /"ezil_error_events"/.test(s.sql) && /insert/i.test(s.sql));
        expect(eventsInsert!.params).toContain(USER_HASH);
        const hoursInsert = statements.find((s) => /"ezil_error_user_hours"/.test(s.sql));
        expect(hoursInsert!.params).toContain(USER_HASH);
    });

    it('an empty batch does nothing — no statements at all', async () => {
        const { db, statements } = makeTestDb();
        const result = await ingestBatch(db, [], USER_HASH);
        expect(statements).toHaveLength(0);
        expect(result).toEqual({ fingerprintsTouched: 0, inserted: 0, attempted: 0 });
    });

    it('caps at MAX_EVENTS_PER_BATCH even if handed more (defence in depth vs. the schema-layer cap)', async () => {
        const { db } = makeTestDb();
        const events = Array.from({ length: 80 }, (_, i) =>
            event({ eventId: `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}` }),
        );
        const result = await ingestBatch(db, events, USER_HASH);
        expect(result.attempted).toBe(50);
    });

    it('folds repeated identical crashes in one batch into ONE fingerprint row with count > 1', async () => {
        const { db } = makeTestDb();
        const dup = event({ eventId: '550e8400-e29b-41d4-a716-446655440001' });
        const result = await ingestBatch(db, [event(), dup, dup], USER_HASH);
        expect(result.fingerprintsTouched).toBe(1);
        expect(result.attempted).toBe(3);
    });

    /**
     * 🔴 THE REGRESSION, found by POSTing one batch twice at a real Postgres
     * (Supabase 17.6, throwaway container) during the integration merge — with
     * ten green tests in this file and a code comment that promised exactly the
     * property it did not have.
     *
     * `ezil_error_events` was idempotent on `event_id`, so the replay added no
     * rows. But the dimension upsert ran FIRST and added `+N` unconditionally,
     * so `total_count` and `event_count` counted events that exist nowhere in
     * the events table — permanently, and worse than "permanently" because raw
     * events are pruned at retention while the rollup is kept 90 days, so the
     * inflated number is the one that survives to be read.
     */
    it('🔴 a fully-duplicate batch touches NO counter — not just no event row', async () => {
        const e = event();
        const { db, statements } = makeTestDb([e.eventId]);
        const result = await ingestBatch(db, [e], USER_HASH);

        const inserts = statements.filter((s) => /^\s*insert\b/i.test(s.sql));
        expect(inserts).toHaveLength(1);
        expect(inserts[0]!.sql).toMatch(/"ezil_error_events"/);
        expect(result).toEqual({ fingerprintsTouched: 0, inserted: 0, attempted: 1 });
    });

    it('🔴 a half-duplicate batch counts only the half that was actually stored', async () => {
        const fresh = event({ eventId: '550e8400-e29b-41d4-a716-446655440002' });
        const dupe = event({ eventId: '550e8400-e29b-41d4-a716-446655440003' });
        const { db, statements } = makeTestDb([dupe.eventId]);
        const result = await ingestBatch(db, [fresh, dupe], USER_HASH);

        expect(result.inserted).toBe(1);
        expect(result.attempted).toBe(2);
        // Both events share a fingerprint, so the increment is what proves it:
        // 1 (the stored one), never 2.
        const fpInsert = statements.find((s) => /"ezil_error_fingerprints"/.test(s.sql))!;
        const hoursInsert = statements.find((s) => /"ezil_error_user_hours"/.test(s.sql))!;
        expect(fpInsert.params).toContain(1);
        expect(fpInsert.params).not.toContain(2);
        expect(hoursInsert.params).toContain(1);
        expect(hoursInsert.params).not.toContain(2);
    });

    it('counts a repeated eventId INSIDE one batch once — Postgres only stores it once', async () => {
        const e = event();
        const { db, statements } = makeTestDb();
        const result = await ingestBatch(db, [e, e], USER_HASH);

        expect(result.inserted).toBe(1);
        expect(result.attempted).toBe(2);
        const fpInsert = statements.find((s) => /"ezil_error_fingerprints"/.test(s.sql))!;
        expect(fpInsert.params).toContain(1);
        expect(fpInsert.params).not.toContain(2);
    });

    it('strips a disallowed attrs key before it ever reaches the insert params', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event({ attrs: { stack_head: 'x@y.js', secret_token: 'nope' } })], USER_HASH);
        for (const s of statements) {
            expect(JSON.stringify(s.params)).not.toMatch(/secret_token/);
        }
    });
});
