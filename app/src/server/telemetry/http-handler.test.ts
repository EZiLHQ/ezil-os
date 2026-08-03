import { drizzle } from 'drizzle-orm/pg-proxy';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { handleTelemetryPost, type TelemetryRequestContext } from './http-handler';
import { resetLoadShedCacheForTests, setLoadShedCacheForTests, SHED_ABOVE_ROWS } from './load-shed';
import { resetRateLimitForTests } from './rate-limit';
import { TELEMETRY_LIMITS } from './types';

function validEvent(id = '550e8400-e29b-41d4-a716-446655440000') {
    return {
        eventId: id,
        schemaVersion: 1,
        eventClass: 'crash',
        source: 'shell',
        occurredAt: '2026-08-01T00:00:00.000Z',
        site: 'ezil-os:boot#mount',
        code: 'mount_failed',
        outcome: 'error',
    };
}

function makeDb() {
    const statements: { sql: string; params: unknown[] }[] = [];
    const proxy = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            return { rows: [] };
        },
        { schema },
    );
    const db = {
        transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy),
        execute: (proxy as unknown as { execute: (q: unknown) => Promise<unknown> }).execute.bind(proxy),
    } as unknown as TelemetryRequestContext['db'];
    return { db, statements };
}

function jsonRequest(body: unknown): Request {
    return new Request('https://example.test/api/shell/telemetry', {
        method: 'POST',
        body: JSON.stringify(body),
    });
}

const AUTH_USER = { id: '11111111-1111-1111-1111-111111111111' };

describe('handleTelemetryPost: the guarantee — always 202, nothing to branch on', () => {
    afterEach(() => {
        resetRateLimitForTests();
        resetLoadShedCacheForTests();
    });

    it('always answers 202, authenticated or not', async () => {
        const { db } = makeDb();
        const schedule = vi.fn();
        const res = await handleTelemetryPost(jsonRequest({ schemaVersion: 1, events: [validEvent()] }), {
            getContext: async () => ({ user: null, db }),
            schedule,
        });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('schedules ingest work for a valid authenticated batch, and only then', async () => {
        // Seed a FRESH, under-ceiling load-shed cache so this test isolates
        // ingest scheduling from load-shed's own background refresh (which
        // legitimately issues its own `db.execute` on a cold/stale cache —
        // see load-shed.test.ts for that behaviour on its own).
        setLoadShedCacheForTests(0);
        const { db, statements } = makeDb();
        const schedule = vi.fn();
        const res = await handleTelemetryPost(jsonRequest({ schemaVersion: 1, events: [validEvent()] }), {
            getContext: async () => ({ user: AUTH_USER, db }),
            schedule,
        });
        expect(res.status).toBe(202);
        expect(schedule).toHaveBeenCalledTimes(1);
        expect(statements).toHaveLength(0); // nothing runs before the scheduled callback fires

        await schedule.mock.calls[0]![0]!();
        expect(statements.length).toBeGreaterThan(0); // now the deferred work has actually run
    });

    it('malformed JSON -> 202, nothing scheduled', async () => {
        const { db } = makeDb();
        const schedule = vi.fn();
        const req = new Request('https://example.test/api/shell/telemetry', { method: 'POST', body: '{not json' });
        const res = await handleTelemetryPost(req, { getContext: async () => ({ user: AUTH_USER, db }), schedule });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('a batch of entirely invalid events (e.g. one smuggling userId) -> 202, nothing scheduled', async () => {
        const { db } = makeDb();
        const schedule = vi.fn();
        const res = await handleTelemetryPost(
            jsonRequest({ schemaVersion: 1, events: [{ ...validEvent(), userId: 'leak-attempt' }] }),
            { getContext: async () => ({ user: AUTH_USER, db }), schedule },
        );
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('a body over MAX_BODY_BYTES is dropped based on ACTUAL bytes read, not Content-Length', async () => {
        const { db } = makeDb();
        const schedule = vi.fn();
        const oversized = 'x'.repeat(TELEMETRY_LIMITS.MAX_BODY_BYTES + 1);
        // Content-Length deliberately WRONG (understated) — the reader must
        // still catch this by counting real bytes off the stream.
        const req = new Request('https://example.test/api/shell/telemetry', {
            method: 'POST',
            body: oversized,
            headers: { 'content-length': '10' },
        });
        const res = await handleTelemetryPost(req, { getContext: async () => ({ user: AUTH_USER, db }), schedule });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('rate-limited user -> 202, nothing scheduled', async () => {
        const { db } = makeDb();
        const schedule = vi.fn();
        const req = () => jsonRequest({ schemaVersion: 1, events: [validEvent()] });
        for (let i = 0; i < 20; i++) {
            await handleTelemetryPost(req(), { getContext: async () => ({ user: AUTH_USER, db }), schedule });
        }
        schedule.mockClear();
        const res = await handleTelemetryPost(req(), { getContext: async () => ({ user: AUTH_USER, db }), schedule });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('under the load-shed breaker -> 202, nothing scheduled, product unaffected', async () => {
        setLoadShedCacheForTests(SHED_ABOVE_ROWS + 1);
        const { db } = makeDb();
        const schedule = vi.fn();
        const res = await handleTelemetryPost(jsonRequest({ schemaVersion: 1, events: [validEvent()] }), {
            getContext: async () => ({ user: AUTH_USER, db }),
            schedule,
        });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });

    it('a scheduled ingest failure is swallowed, never thrown back at the caller', async () => {
        const db = {
            transaction: async () => {
                throw new Error('db is down');
            },
        } as unknown as TelemetryRequestContext['db'];
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const schedule = vi.fn();
        const res = await handleTelemetryPost(jsonRequest({ schemaVersion: 1, events: [validEvent()] }), {
            getContext: async () => ({ user: AUTH_USER, db }),
            schedule,
        });
        expect(res.status).toBe(202);
        await expect(schedule.mock.calls[0]![0]!()).resolves.toBeUndefined();
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });

    it('getContext throwing (e.g. a dead Supabase call) still answers 202', async () => {
        const schedule = vi.fn();
        const res = await handleTelemetryPost(jsonRequest({ schemaVersion: 1, events: [validEvent()] }), {
            getContext: async () => {
                throw new Error('supabase unreachable');
            },
            schedule,
        });
        expect(res.status).toBe(202);
        expect(schedule).not.toHaveBeenCalled();
    });
});
