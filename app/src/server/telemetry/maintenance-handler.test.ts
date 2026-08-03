import { describe, expect, it, vi } from 'vitest';

import { handleTelemetryMaintenance } from './maintenance-handler';
import type { RetentionDb } from './retention';

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
