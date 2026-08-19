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
        expect(body.failed).toEqual(['maintenance']);
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
        expect((await res.json()).failed).toEqual(['maintenance', 'drain']);
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

    it('omitting `drain` keeps the retention-only behaviour byte for byte', async () => {
        const res = await handleTelemetryMaintenance(req(`Bearer ${secret}`), { cronSecret: secret, db: makeDb([]) });
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
        expect(body.drain).toBeUndefined();
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
