import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { handleTelemetryMaintenance } from './maintenance-handler';
import type { RetentionDb } from './retention';
import type { SpoolDrainEngineDeps } from './spool-drain';

function makeDb(rows: unknown[] = []): RetentionDb {
    return { execute: vi.fn().mockResolvedValue({ rows }) };
}

function req(auth?: string): Request {
    return new Request('https://example.test/api/cron/telemetry-maintenance', {
        method: 'POST',
        headers: auth ? { authorization: auth } : {},
    });
}

describe('handleTelemetryMaintenance: fail-closed twice over', () => {
    it('404s when CRON_SECRET is not configured, even with a bearer token supplied', async () => {
        const res = await handleTelemetryMaintenance(req('Bearer whatever'), { cronSecret: undefined, db: makeDb() });
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a missing Authorization header', async () => {
        const res = await handleTelemetryMaintenance(req(), { cronSecret: 'x'.repeat(32), db: makeDb() });
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a wrong bearer token — indistinguishable from unconfigured', async () => {
        const res = await handleTelemetryMaintenance(req('Bearer nope'), {
            cronSecret: 'x'.repeat(32),
            db: makeDb(),
        });
        expect(res.status).toBe(404);
    });

    it('runs maintenance and returns 200 with a result summary on a correct secret', async () => {
        const db = makeDb([]);
        const secret = 'x'.repeat(32);
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.result).toHaveProperty('events');
        expect(body.result).toHaveProperty('userHours');
        expect(body.result).toHaveProperty('fingerprints');
    });

    it('a maintenance failure is caught and returns 500, never throws to the caller', async () => {
        const db: RetentionDb = { execute: vi.fn().mockRejectedValue(new Error('pool exhausted')) };
        const secret = 'x'.repeat(32);
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});

// ── Two jobs, one cron: the isolation guarantee ──────────────────────────────

/**
 * The drain half, injected. `db` here is the ingest db, deliberately distinct
 * from the retention db above so a test can break one and watch the other keep
 * going — which is the entire reason the two jobs share an invocation rather
 * than a call stack.
 */
function drainDeps(overrides: Partial<SpoolDrainEngineDeps> = {}): SpoolDrainEngineDeps {
    return {
        db: { transaction: vi.fn() } as unknown as SpoolDrainEngineDeps['db'],
        drainPage: vi.fn().mockResolvedValue({ ok: true, objects: [], truncated: false }),
        ack: vi.fn().mockResolvedValue(true),
        ...overrides,
    };
}

describe('handleTelemetryMaintenance: retention AND the spool drain, isolated from each other', () => {
    const secret = 'x'.repeat(32);

    it('runs both and reports both when both succeed', async () => {
        const drain = drainDeps();
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), {
            cronSecret: secret,
            db: makeDb([]),
            drain,
        });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.result).toHaveProperty('events');
        expect(body.drain).toMatchObject({ pagesDrained: 1, drainFailures: 0 });
        expect(body.failed).toBeUndefined();
        expect(drain.drainPage).toHaveBeenCalled();
    });

    it('🔴 a dead database does not stop the drain — it still runs and still reports', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const drain = drainDeps();
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), {
            cronSecret: secret,
            db: { execute: vi.fn().mockRejectedValue(new Error('pool exhausted')) },
            drain,
        });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.failed).toEqual(['maintenance', 'feedback']);
        expect(drain.drainPage).toHaveBeenCalled();
        expect(body.drain).toBeDefined();
        consoleSpy.mockRestore();
    });

    it('🔴 a drain that THROWS does not undo or hide the retention that already ran', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const drain = drainDeps({ drainPage: vi.fn().mockRejectedValue(new Error('worker exploded')) });
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), {
            cronSecret: secret,
            db: makeDb([]),
            drain,
        });
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(body.failed).toEqual(['drain']);
        // The retention result survives the drain's failure, in the body.
        expect(body.result).toHaveProperty('events');
        expect(body.drain).toBeUndefined();
        consoleSpy.mockRestore();
    });

    it('names BOTH halves when both fail, rather than reporting one generic 500', async () => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), {
            cronSecret: secret,
            db: { execute: vi.fn().mockRejectedValue(new Error('pool exhausted')) },
            drain: drainDeps({ drainPage: vi.fn().mockRejectedValue(new Error('worker exploded')) }),
        });
        expect(res.status).toBe(500);
        expect((await res.json()).failed).toEqual(['maintenance', 'feedback', 'drain']);
        consoleSpy.mockRestore();
    });

    it('🔴 an unreachable Worker is reported as a fault, not as a quiet successful run', async () => {
        // This is the shape the 16-day outage had: a 200 with nothing in it.
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), {
            cronSecret: secret,
            db: makeDb([]),
            drain: drainDeps({ drainPage: vi.fn().mockResolvedValue({ ok: false }) }),
        });
        const body = await res.json();
        // The run itself did not throw, so it is a 200 — but the counter says so.
        expect(res.status).toBe(200);
        expect(body.drain.drainFailures).toBe(1);
        expect(body.drain.pagesDrained).toBe(0);
        consoleSpy.mockRestore();
    });

    it('omitting `drain` still runs both retention jobs', async () => {
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db: makeDb([]) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.drain).toBeUndefined();
        expect(body.feedback).toHaveProperty('attachments');
    });

    it('does not run the drain for an unauthenticated caller — the 404 comes first', async () => {
        const drain = drainDeps();
        const res = await handleTelemetryMaintenance(req('Bearer nope'), {
            cronSecret: secret,
            db: makeDb([]),
            drain,
        });
        expect(res.status).toBe(404);
        expect(drain.drainPage).not.toHaveBeenCalled();
    });
});

describe('feedback retention shares the cron and isolates failures', () => {
    const secret = 'x'.repeat(32);

    function dbWithFailures(fail: 'telemetry' | 'feedback' | null) {
        const order: string[] = [];
        const db: RetentionDb = { execute: vi.fn(async (q) => {
            const sql = new PgDialect().sqlToQuery(q).sql;
            const job = sql.includes('ezil_feedback_') ? 'feedback' : 'telemetry';
            order.push(job);
            if (job === fail) throw new Error(`${job} unavailable`);
            // The presence probe (to_regclass) answers "all tables exist".
            if (sql.includes('to_regclass')) return [{ reports: true, attachments: true, access_log: true }];
            return [];
        }) };
        return { db, order };
    }

    it('runs telemetry, feedback, then the drain and reports all three', async () => {
        const { db, order } = dbWithFailures(null);
        const drain = drainDeps({ drainPage: vi.fn(async () => {
            order.push('drain');
            return { ok: true, objects: [], truncated: false };
        }) });
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db, drain });
        expect(res.status).toBe(200);
        expect(order).toEqual(['telemetry', 'telemetry', 'telemetry', 'telemetry', 'feedback', 'feedback', 'feedback', 'feedback', 'drain']);
        expect(await res.json()).toMatchObject({ ok: true, result: { events: { deletedRows: 0 } }, feedback: {
            attachments: { deletedRows: 0, hitBudget: false },
            reports: { deletedRows: 0, hitBudget: false },
            accessLog: { deletedRows: 0, hitBudget: false },
        }, drain: { pagesDrained: 1 } });
    });

    it.each(['telemetry', 'feedback'] as const)('%s failure does not hide or prevent the other retention job or drain', async (fail) => {
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
            const { db, order } = dbWithFailures(fail);
            const drain = drainDeps();
            const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db, drain });
            expect(res.status).toBe(500);
            const body = await res.json();
            expect(body.failed).toEqual([fail === 'telemetry' ? 'maintenance' : 'feedback']);
            expect(order).toContain('telemetry');
            expect(order).toContain('feedback');
            expect(body[fail === 'telemetry' ? 'feedback' : 'result']).toBeDefined();
            expect(body[fail === 'telemetry' ? 'result' : 'feedback']).toBeUndefined();
            expect(body.drain).toBeDefined();
            expect(drain.drainPage).toHaveBeenCalled();
        } finally {
            consoleSpy.mockRestore();
        }
    });

    it.each([undefined, 'wrong'])('does not run either retention job without authorization (%s)', async (token) => {
        const { db } = dbWithFailures(null);
        const res = await handleTelemetryMaintenance(req(token), { cronSecret: secret, db });
        expect(res.status).toBe(404);
        expect(db.execute).not.toHaveBeenCalled();
    });
});

describe('feedback retention before the feedback SQL is registered', () => {
    const secret = 'x'.repeat(32);

    it('skips (200, not 500) when no feedback table exists, running no DELETE', async () => {
        const seen: string[] = [];
        const db: RetentionDb = { execute: vi.fn(async (q) => {
            const sql = new PgDialect().sqlToQuery(q).sql;
            seen.push(sql);
            if (sql.includes('to_regclass')) return [{ reports: false, attachments: false, access_log: false }];
            // A DELETE against a missing table is exactly what Postgres would reject.
            if (sql.includes('ezil_feedback_')) throw new Error('relation "ezil_feedback_reports" does not exist');
            return [];
        }) };
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.failed).toBeUndefined();
        expect(body.feedback).toEqual({
            attachments: { deletedRows: 0, hitBudget: false, skipped: true },
            reports: { deletedRows: 0, hitBudget: false, skipped: true },
            accessLog: { deletedRows: 0, hitBudget: false, skipped: true },
        });
        expect(seen.filter((s) => /DELETE FROM ezil_feedback_/.test(s))).toEqual([]);
    });

    it('prunes reports + access log without touching attachments when only 0003 exists', async () => {
        const seen: string[] = [];
        const db: RetentionDb = { execute: vi.fn(async (q) => {
            const sql = new PgDialect().sqlToQuery(q).sql;
            seen.push(sql);
            if (sql.includes('to_regclass')) return [{ reports: true, attachments: false, access_log: true }];
            if (sql.includes('ezil_feedback_attachments')) throw new Error('relation "ezil_feedback_attachments" does not exist');
            return [];
        }) };
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.feedback.attachments).toEqual({ deletedRows: 0, hitBudget: false, skipped: true });
        expect(body.feedback.reports).toEqual({ deletedRows: 0, hitBudget: false });
        expect(seen.some((s) => /DELETE FROM ezil_feedback_reports/.test(s))).toBe(true);
        expect(seen.some((s) => /DELETE FROM ezil_feedback_access_log/.test(s))).toBe(true);
    });
});
