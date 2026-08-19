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
            // The loop stopped because the Worker was unreachable, not because
            // the clock ran out.
            hitBudget: false,
            // 🔴 The one field that separates this outcome from a healthy
            // empty spool. Both stop the loop at zero pages; only this says
            // WHY. Measured 2026-08-19: 173 objects sat undrained in
            // `ezil-telemetry-spool` for 16 days while every cron run returned
            // `200 {ok:true}` — see this field's doc comment in
            // `./spool-drain.ts`.
            drainFailures: 1,
        });
        expect(ack).not.toHaveBeenCalled();
    });

    it('🔴 an EMPTY spool and an UNREACHABLE Worker are distinguishable, not both "zero pages"', async () => {
        const { db } = makeIngestDb();
        const ack = vi.fn().mockResolvedValue(true);

        const empty = await runTelemetrySpoolDrain({
            db,
            ack,
            drainPage: vi.fn().mockResolvedValue({ ok: true, objects: [], truncated: false } satisfies DrainPageResult),
        });
        const unreachable = await runTelemetrySpoolDrain({
            db,
            ack,
            drainPage: vi.fn().mockResolvedValue({ ok: false } satisfies DrainPageResult),
        });

        // Identical on every pre-existing field — which is exactly why the
        // outage was invisible for 16 days.
        expect(empty.objectsSeen).toBe(unreachable.objectsSeen);
        expect(empty.eventsIngested).toBe(unreachable.eventsIngested);
        expect(empty.objectsAcked).toBe(unreachable.objectsAcked);
        // And different on the field that was added to tell them apart.
        expect(empty.drainFailures).toBe(0);
        expect(unreachable.drainFailures).toBe(1);
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

    it('🔴 stops starting pages once the wall-clock budget is spent, and says so', async () => {
        // The drain no longer owns its invocation: it runs at the tail of
        // `/api/cron/telemetry-maintenance`, so a page COUNT is not a bound on
        // how long it may take. Each page here burns real time, and the budget
        // — not `maxPages` — is what ends the run.
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockImplementation(async () => {
            await new Promise((r) => setTimeout(r, 12));
            return page([{ key: `v1/${drainPage.mock.calls.length}.ndjson`, body: rawEventLine() }], {
                truncated: true,
                cursor: 'more',
            });
        });
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack, maxPages: 50, budgetMs: 20 });

        expect(result.hitBudget).toBe(true);
        expect(result.pagesDrained).toBeGreaterThan(0); // it did real work
        expect(result.pagesDrained).toBeLessThan(50); // and stopped well short of the page ceiling
        // Everything it did drain was ingested and acked before it stopped —
        // stopping on the clock must never orphan a half-processed page.
        expect(result.objectsAcked).toBe(result.objectsSeen);
    });

    it('always attempts the FIRST page, however little budget is left — a silent no-op is the outage`s own shape', async () => {
        const { db } = makeIngestDb();
        const drainPage = vi.fn().mockResolvedValue(page([{ key: 'v1/a.ndjson', body: rawEventLine() }], { truncated: false }));
        const ack = vi.fn().mockResolvedValue(true);

        const result = await runTelemetrySpoolDrain({ db, drainPage, ack, budgetMs: 0 });

        expect(drainPage).toHaveBeenCalledTimes(1);
        expect(result.pagesDrained).toBe(1);
        expect(result.hitBudget).toBe(false);
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
