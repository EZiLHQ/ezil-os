/**
 * `runTelemetrySpoolDrain` against a REAL Drizzle query builder
 * (`drizzle-orm/pg-proxy`, same technique as `ingest.test.ts`) so the
 * "stored under the sentinel" assertions are about the actual SQL/params
 * `ingestBatch` emits, not a mock's call log. The Worker HTTP transport
 * (`drainPage`/`ack`) is injected — see `spool-drain.ts`'s own doc comment
 * for why: this file never imports `@/env` or makes a real network call.
 */
import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import {
    handleTelemetrySpoolDrain,
    runTelemetrySpoolDrain,
    type DrainPageResult,
    type SpoolDrainEngineDeps,
} from './spool-drain';
import type { IngestDb } from './ingest';
import { WORKER_SENTINEL_USER_HASH } from './types';

interface Statement {
    sql: string;
    params: unknown[];
}

/** Same fake `IngestDb` shape `ingest.test.ts` uses: a `pg-proxy` builder
 * wrapped so `db.transaction(cb)` just calls `cb` against it directly. */
function makeIngestDb(): { db: IngestDb; statements: Statement[] } {
    const statements: Statement[] = [];
    const proxy = drizzle(
        async (sql, params) => {
            statements.push({ sql, params });
            if (/^\s*insert\b/i.test(sql) && /returning\s+"event_id"/i.test(sql)) {
                const cols = (sql.match(/insert into "ezil_error_events" \(([^)]*)\)/i)?.[1] ?? '')
                    .split(',')
                    .map((c) => c.trim().replace(/"/g, ''));
                const idIdx = cols.indexOf('event_id');
                const ids: string[] = [];
                if (idIdx >= 0 && cols.length > 0) {
                    for (let i = 0; i + cols.length <= params.length; i += cols.length) {
                        const id = params[i + idIdx] as string;
                        if (!ids.includes(id)) ids.push(id);
                    }
                }
                return { rows: ids.map((id) => [id]) };
            }
            return { rows: [] };
        },
        { schema },
    );
    const db = { transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy) } as unknown as IngestDb;
    return { db, statements };
}

/** A raw NDJSON line as the Worker's `spoolTelemetry()` actually writes one
 * (`worker/src/telemetry.ts`'s `TelemetryEventInput`), pre-serialized. */
function rawEventLine(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        eventId: overrides.eventId ?? '550e8400-e29b-41d4-a716-446655440000',
        schemaVersion: 1,
        eventClass: 'boot_summary',
        source: 'worker',
        occurredAt: '2026-08-03T14:00:00.000Z',
        site: 'sandbox.preview.desktop_ready',
        code: 'ok',
        outcome: 'ok',
        ...overrides,
    });
}

function page(objects: { key: string; body: string }[], opts: { truncated?: boolean; cursor?: string } = {}): DrainPageResult {
    return { ok: true, objects, truncated: opts.truncated ?? false, cursor: opts.cursor };
}

describe('runTelemetrySpoolDrain — the core loop', () => {
    it('🔴 ingests a drained event under WORKER_SENTINEL_USER_HASH, never a real userHash', async () => {
        const { db, statements } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body: rawEventLine() }]));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result.eventsIngested).toBe(1);
        const insertStmt = statements.find((s) => /insert into "ezil_error_events"/i.test(s.sql));
        expect(insertStmt).toBeTruthy();
        expect(insertStmt!.params).toContain(WORKER_SENTINEL_USER_HASH);
    });

    it('acks a page ONLY after ingest for that page has resolved without throwing', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body: rawEventLine() }]));
        const ack = vi.fn().mockResolvedValue(true);

        await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(ack).toHaveBeenCalledTimes(1);
        expect(ack).toHaveBeenCalledWith(['v1/a.ndjson']);
    });

    it('🔴 an ingest failure for a page means that page is NEVER acked — it must be re-drained, not lost', async () => {
        const db: IngestDb = { transaction: () => Promise.reject(new Error('pool exhausted')) };
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body: rawEventLine() }]));
        const ack = vi.fn().mockResolvedValue(true);
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(ack).not.toHaveBeenCalled();
        expect(result.objectsAcked).toBe(0);
        expect(result.eventsIngested).toBe(0);
        consoleSpy.mockRestore();
    });

    it('paginates via cursor across multiple pages until truncated:false', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi
            .fn()
            .mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body: rawEventLine({ eventId: '550e8400-e29b-41d4-a716-446655440001' }) }], { truncated: true, cursor: 'v1/a.ndjson' }))
            .mockResolvedValueOnce(page([{ key: 'v1/b.ndjson', body: rawEventLine({ eventId: '550e8400-e29b-41d4-a716-446655440002' }) }], { truncated: false }));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(drainPage).toHaveBeenCalledTimes(2);
        expect(drainPage).toHaveBeenNthCalledWith(1, undefined);
        expect(drainPage).toHaveBeenNthCalledWith(2, 'v1/a.ndjson');
        expect(result.pagesDrained).toBe(2);
        expect(result.eventsIngested).toBe(2);
    });

    it('an empty-but-truncated page advances the cursor and keeps going without ingesting/acking anything', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi
            .fn()
            .mockResolvedValueOnce(page([], { truncated: true, cursor: 'v1/empty.ndjson' }))
            .mockResolvedValueOnce(page([{ key: 'v1/b.ndjson', body: rawEventLine() }], { truncated: false }));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(drainPage).toHaveBeenCalledTimes(2);
        expect(result.pagesDrained).toBe(2);
        expect(result.eventsIngested).toBe(1);
    });

    it('a Worker/transport failure on the FIRST page stops cleanly — zero pages drained, ack never called', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValueOnce({ ok: false } satisfies DrainPageResult);
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result).toEqual({
            pagesDrained: 0,
            objectsSeen: 0,
            eventsParsed: 0,
            eventsDroppedInvalid: 0,
            eventsIngested: 0,
            objectsAcked: 0,
        });
        expect(ack).not.toHaveBeenCalled();
    });

    it('drops a torn/malformed NDJSON line without failing its neighbours in the same object', async () => {
        const { db } = makeIngestDb();
        const body = ['{not valid json', rawEventLine()].join('\n');
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body }]));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result.eventsParsed).toBe(1); // the torn line never became a parsed value at all
        expect(result.eventsIngested).toBe(1);
    });

    it('a structurally-invalid event (fails the zod schema) is counted as droppedInvalid, not ingested, and does not block valid siblings', async () => {
        const { db } = makeIngestDb();
        const body = [
            JSON.stringify({ eventId: 'not-a-uuid', schemaVersion: 1, eventClass: 'crash', source: 'worker', occurredAt: 'x', site: 's', code: 'c', outcome: 'error' }),
            rawEventLine({ eventId: '550e8400-e29b-41d4-a716-446655440003' }),
        ].join('\n');
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body }]));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result.eventsDroppedInvalid).toBe(1);
        expect(result.eventsIngested).toBe(1);
    });

    it('a failed ack is swallowed — objectsAcked stays 0 for that page but ingestion already happened (idempotent, safe to re-drain)', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValueOnce(page([{ key: 'v1/a.ndjson', body: rawEventLine() }]));
        const ack = vi.fn().mockResolvedValue(false);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result.eventsIngested).toBe(1);
        expect(result.objectsAcked).toBe(0);
    });

    it('respects an injected maxPages ceiling so one run cannot run unbounded', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockImplementation(() =>
            Promise.resolve(page([{ key: 'v1/x.ndjson', body: rawEventLine() }], { truncated: true, cursor: 'v1/x.ndjson' })),
        );
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack, maxPages: 3 });

        expect(drainPage).toHaveBeenCalledTimes(3);
        expect(result.pagesDrained).toBe(3);
    });

    it('an empty object array with truncated:false ends the loop with a zeroed result', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValueOnce(page([], { truncated: false }));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack });

        expect(result.pagesDrained).toBe(1);
        expect(result.eventsIngested).toBe(0);
        expect(ack).not.toHaveBeenCalled();
    });
});

// ── handleTelemetrySpoolDrain — fail-closed, mirroring maintenance-handler.ts ─

function req(auth?: string): Request {
    return new Request('https://example.test/api/cron/telemetry-drain', {
        method: 'GET',
        headers: auth ? { authorization: auth } : {},
    });
}

function baseDeps(overrides: Partial<SpoolDrainEngineDeps> = {}): SpoolDrainEngineDeps {
    const { db } = makeIngestDb();
    return {
        db,
        drainPage: vi.fn().mockResolvedValue({ ok: false } satisfies DrainPageResult),
        ack: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
}

describe('handleTelemetrySpoolDrain: fail-closed exactly like handleTelemetryMaintenance', () => {
    it('404s when CRON_SECRET is not configured, even with a bearer token supplied', async () => {
        const res = await handleTelemetrySpoolDrain(req('Bearer whatever'), { cronSecret: undefined, ...baseDeps() });
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a missing Authorization header', async () => {
        const res = await handleTelemetrySpoolDrain(req(), { cronSecret: 'x'.repeat(32), ...baseDeps() });
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a wrong bearer token', async () => {
        const res = await handleTelemetrySpoolDrain(req('Bearer nope'), { cronSecret: 'x'.repeat(32), ...baseDeps() });
        expect(res.status).toBe(404);
    });

    it('runs the drain and returns 200 with a result summary on a correct secret', async () => {
        const secret = 'x'.repeat(32);
        const res = await handleTelemetrySpoolDrain(req(`Bearer ${secret}`), { cronSecret: secret, ...baseDeps() });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.result).toHaveProperty('pagesDrained');
        expect(body.result).toHaveProperty('eventsIngested');
    });

    it('an engine failure is caught and returns 500, never throws to the caller', async () => {
        const secret = 'x'.repeat(32);
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const deps = baseDeps({ drainPage: vi.fn().mockRejectedValue(new Error('worker unreachable')) });
        const res = await handleTelemetrySpoolDrain(req(`Bearer ${secret}`), { cronSecret: secret, ...deps });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        consoleSpy.mockRestore();
    });
});
