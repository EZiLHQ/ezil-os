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

function makeTestDb() {
    const statements: Statement[] = [];
    const proxy = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            if (/^\s*insert\b/i.test(sql) && /returning/i.test(sql)) {
                // Every row "wins" the insert (no pre-existing eventId) unless a
                // test overrides this by re-running with different mocked rows.
                return { rows: params.slice(0, 1).map(() => []) };
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
    it('does three inserts in order: fingerprints, events, user_hours', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event()], USER_HASH);

        const inserts = statements.filter((s) => /^\s*insert\b/i.test(s.sql));
        expect(inserts).toHaveLength(3);
        expect(inserts[0]!.sql).toMatch(/"ezil_error_fingerprints"/);
        expect(inserts[1]!.sql).toMatch(/"ezil_error_events"/);
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

    it('strips a disallowed attrs key before it ever reaches the insert params', async () => {
        const { db, statements } = makeTestDb();
        await ingestBatch(db, [event({ attrs: { stack_head: 'x@y.js', secret_token: 'nope' } })], USER_HASH);
        for (const s of statements) {
            expect(JSON.stringify(s.params)).not.toMatch(/secret_token/);
        }
    });
});
