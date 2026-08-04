import { describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_MAX_REAP_PER_RUN,
    DEFAULT_STALE_AFTER_MS,
    findStaleComputers,
    handleSandboxReap,
    reapCronDisabled,
    type SandboxReapDb,
    type SandboxReapDeps,
} from './handler';

function makeDb(rows: unknown[] = []): SandboxReapDb {
    return { execute: vi.fn().mockResolvedValue(rows) };
}

function req(auth?: string): Request {
    return new Request('https://example.test/api/cron/sandbox-reap', {
        method: 'GET',
        headers: auth ? { authorization: auth } : {},
    });
}

function baseDeps(overrides: Partial<SandboxReapDeps> = {}): SandboxReapDeps {
    return {
        cronSecret: 'x'.repeat(32),
        db: makeDb([]),
        killSwitch: undefined,
        deriveSandboxName: (userId, computerId) => `guac-${userId}-${computerId}`,
        checkRunning: vi.fn().mockResolvedValue(false),
        terminate: vi.fn().mockResolvedValue({ ok: true, terminated: true }),
        ...overrides,
    };
}

describe('reapCronDisabled', () => {
    it('is enabled (false) when unset', () => {
        expect(reapCronDisabled(undefined)).toBe(false);
        expect(reapCronDisabled('')).toBe(false);
    });

    it('recognizes the shared off vocabulary, case-insensitively and trimmed', () => {
        for (const v of ['off', 'OFF', ' Off ', 'false', '0', 'disabled', 'no']) {
            expect(reapCronDisabled(v)).toBe(true);
        }
    });

    it('treats any other value as enabled', () => {
        expect(reapCronDisabled('on')).toBe(false);
        expect(reapCronDisabled('yes')).toBe(false);
        expect(reapCronDisabled('true')).toBe(false);
    });
});

describe('handleSandboxReap: fail-closed twice over (mirrors handleTelemetryMaintenance)', () => {
    it('404s when CRON_SECRET is not configured, even with a bearer token supplied', async () => {
        const res = await handleSandboxReap(req('Bearer whatever'), baseDeps({ cronSecret: undefined }));
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a missing Authorization header', async () => {
        const res = await handleSandboxReap(req(), baseDeps());
        expect(res.status).toBe(404);
    });

    it('404s (not 401) on a wrong bearer token', async () => {
        const res = await handleSandboxReap(req('Bearer nope'), baseDeps());
        expect(res.status).toBe(404);
    });

    it('runs and returns 200 on a correct secret', async () => {
        const secret = 'x'.repeat(32);
        const res = await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret }));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.ok).toBe(true);
    });

    it('a run failure is caught and returns 500, never throws to the caller', async () => {
        const secret = 'x'.repeat(32);
        const db: SandboxReapDb = { execute: vi.fn().mockRejectedValue(new Error('pool exhausted')) };
        const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const res = await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db }));
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.ok).toBe(false);
        expect(consoleSpy).toHaveBeenCalled();
        consoleSpy.mockRestore();
    });
});

describe('handleSandboxReap: kill switch', () => {
    it('is a safe no-op when disabled — auth still checked, but DB/Worker are never touched', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([]);
        const checkRunning = vi.fn();
        const terminate = vi.fn();
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, killSwitch: 'off', db, checkRunning, terminate }),
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toEqual({ ok: true, skipped: true, reason: 'kill_switch_disabled' });
        expect(db.execute).not.toHaveBeenCalled();
        expect(checkRunning).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
    });

    it('still 404s on a bad secret even with the kill switch off', async () => {
        const res = await handleSandboxReap(req('Bearer nope'), baseDeps({ killSwitch: 'off' }));
        expect(res.status).toBe(404);
    });
});

describe('handleSandboxReap: this cron is harmless when the primary idle-stop is working', () => {
    it('terminates nothing when there are no stale candidates', async () => {
        const secret = 'x'.repeat(32);
        const checkRunning = vi.fn();
        const terminate = vi.fn();
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db: makeDb([]), checkRunning, terminate }),
        );
        const body = await res.json();
        expect(body.candidates).toBe(0);
        expect(body.reaped).toBe(0);
        expect(checkRunning).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
    });

    it('checks a stale candidate but does NOT terminate it when the sandbox already reports stopped', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([{ id: 'computer-1', user_id: 'user-1', last_opened_at: new Date(0) }]);
        const checkRunning = vi.fn().mockResolvedValue(false);
        const terminate = vi.fn();
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db, checkRunning, terminate }),
        );
        const body = await res.json();
        expect(checkRunning).toHaveBeenCalledWith('guac-user-1-computer-1');
        expect(terminate).not.toHaveBeenCalled();
        expect(body.reaped).toBe(0);
        expect(body.results[0].outcome).toBe('not_running');
    });
});

describe('handleSandboxReap: the actual backstop path', () => {
    it('terminates a stale candidate whose sandbox is still reported running', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([{ id: 'computer-1', user_id: 'user-1', last_opened_at: new Date(0) }]);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true, outcome: 'destroyed' });
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db, checkRunning, terminate }),
        );
        const body = await res.json();
        expect(terminate).toHaveBeenCalledWith('guac-user-1-computer-1');
        expect(body.reaped).toBe(1);
        expect(body.results[0]).toEqual({
            computerId: 'computer-1',
            sandboxName: 'guac-user-1-computer-1',
            outcome: 'terminated',
        });
    });

    it('reports terminate_failed without throwing when the Worker rejects the DELETE', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([{ id: 'computer-1', user_id: 'user-1', last_opened_at: new Date(0) }]);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn().mockResolvedValue({ ok: false, terminated: false, error: 'still_running' });
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db, checkRunning, terminate }),
        );
        const body = await res.json();
        expect(body.reaped).toBe(0);
        expect(body.results[0].outcome).toBe('terminate_failed');
        expect(body.results[0].error).toBe('still_running');
    });

    it('reports check_failed (not a crash) when checkRunning throws', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([{ id: 'computer-1', user_id: 'user-1', last_opened_at: new Date(0) }]);
        const checkRunning = vi.fn().mockRejectedValue(new Error('worker unreachable'));
        const terminate = vi.fn();
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db, checkRunning, terminate }),
        );
        const body = await res.json();
        expect(terminate).not.toHaveBeenCalled();
        expect(body.results[0].outcome).toBe('check_failed');
    });
});

describe('handleSandboxReap: the max-reap-per-run cap', () => {
    it('stops terminating once maxReapPerRun is reached and reports the rest as skipped_cap', async () => {
        const secret = 'x'.repeat(32);
        const rows = Array.from({ length: 5 }, (_, i) => ({
            id: `computer-${i}`,
            user_id: `user-${i}`,
            last_opened_at: new Date(0),
        }));
        const db = makeDb(rows);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true });
        const res = await handleSandboxReap(
            req(`Bearer ${secret}`),
            baseDeps({ cronSecret: secret, db, checkRunning, terminate, maxReapPerRun: 2 }),
        );
        const body = await res.json();
        expect(terminate).toHaveBeenCalledTimes(2);
        expect(body.reaped).toBe(2);
        const outcomes = body.results.map((r: { outcome: string }) => r.outcome);
        expect(outcomes).toEqual(['terminated', 'terminated', 'skipped_cap', 'skipped_cap', 'skipped_cap']);
    });

    it('defaults the cap to 25', () => {
        expect(DEFAULT_MAX_REAP_PER_RUN).toBe(25);
    });
});

describe('findStaleComputers', () => {
    it('queries with deleted_at IS NULL, last_opened_at IS NOT NULL, and the staleness cutoff', async () => {
        const db = makeDb([]);
        await findStaleComputers(db, new Date('2026-08-01T00:00:00Z'), 10);
        expect(db.execute).toHaveBeenCalledTimes(1);
        const query = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0][0];
        // drizzle-orm's `sql` tag stores literal text as `StringChunk { value: string[] }`
        // entries interleaved with bound params (dates/numbers) in `queryChunks` —
        // join just the literal text to inspect the SQL shape without depending on
        // drizzle's parameter-binding internals.
        const text = query.queryChunks
            .map((c: unknown) => {
                const chunk = c as { value?: unknown[] };
                return Array.isArray(chunk?.value) ? chunk.value.join('') : '';
            })
            .join(' ');
        expect(text).toContain('deleted_at IS NULL');
        expect(text).toContain('last_opened_at IS NOT NULL');
        expect(text).toContain('ORDER BY last_opened_at ASC');
        expect(text).toContain('LIMIT');
    });

    it('maps snake_case rows to the camelCase shape the handler expects', async () => {
        const db = makeDb([{ id: 'c1', user_id: 'u1', last_opened_at: '2026-01-01T00:00:00.000Z' }]);
        const rows = await findStaleComputers(db, new Date(), 10);
        expect(rows).toEqual([{ id: 'c1', userId: 'u1', lastOpenedAt: new Date('2026-01-01T00:00:00.000Z') }]);
    });
});

describe('defaults', () => {
    it('DEFAULT_STALE_AFTER_MS is 24 hours', () => {
        expect(DEFAULT_STALE_AFTER_MS).toBe(24 * 60 * 60 * 1000);
    });
});
