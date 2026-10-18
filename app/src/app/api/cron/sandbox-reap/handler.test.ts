import { sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { noNonCloudflarePlacement } from '@/server/lib/compute/placement';

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

describe('P3: the Cloudflare sweep never addresses a non-Cloudflare computer', () => {
    const secret = 'x'.repeat(32);
    const stale = (id: string) => ({ id, user_id: `u-${id}`, last_opened_at: new Date('2026-01-01T00:00:00Z') });
    const sqlText = (db: SandboxReapDb) => {
        const q = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { queryChunks?: unknown[] };
        return JSON.stringify(q);
    };

    it('an aws-ec2 (or unknown) placement is skipped BEFORE the status check; cloudflare is reaped as before', async () => {
        const db = makeDb([stale('aws'), stale('cf'), stale('odd')]);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true });
        const providerOf = vi.fn(async (id: string) => (id === 'aws' ? 'aws-ec2' : id === 'odd' ? 'gcp' : 'cloudflare'));
        const res = await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, checkRunning, terminate, providerOf }));
        const body = await res.json();
        expect(body.results.map((r: { computerId: string; outcome: string }) => [r.computerId, r.outcome])).toEqual([
            ['aws', 'skipped_not_cloudflare'],
            ['cf', 'terminated'],
            ['odd', 'skipped_not_cloudflare'],
        ]);
        expect(checkRunning).toHaveBeenCalledTimes(1);
        expect(checkRunning).toHaveBeenCalledWith('guac-u-cf-cf');
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(terminate).toHaveBeenCalledWith('guac-u-cf-cf');
    });

    it('a placement read that throws is check_failed and never terminated', async () => {
        const db = makeDb([stale('dup')]);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true });
        const providerOf = vi.fn(async () => { throw new Error('duplicate_placement'); });
        const body = await (await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, checkRunning, terminate, providerOf }))).json();
        expect(body.results).toEqual([{ computerId: 'dup', sandboxName: 'guac-u-dup-dup', outcome: 'check_failed', error: 'duplicate_placement' }]);
        expect(checkRunning).not.toHaveBeenCalled();
        expect(terminate).not.toHaveBeenCalled();
    });

    it('without providerOf (placement reads off) every candidate is treated exactly as before P3', async () => {
        const db = makeDb([stale('a')]);
        const checkRunning = vi.fn().mockResolvedValue(true);
        const body = await (await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, checkRunning }))).json();
        expect(body.results).toEqual([{ computerId: 'a', sandboxName: 'guac-u-a-a', outcome: 'terminated' }]);
    });

    it('SQL assertion: the candidate query never names a placement table (C-2 single writer)', async () => {
        const db = makeDb([]);
        await findStaleComputers(db, new Date('2026-01-01T00:00:00Z'), 5);
        const text = sqlText(db);
        expect(text).toMatch(/FROM ezil_computers/);
        expect(text).not.toMatch(/placement/i);
    });
});

describe('P3: AWS rows never starve Cloudflare reaping (Codex 4275269660)', () => {
    const rendered = (db: SandboxReapDb) => {
        const q = (db.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0];
        return new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, ' ');
    };

    it('with placement reads on, the non-Cloudflare filter is IN the candidate query, before ORDER BY / LIMIT', async () => {
        const db = makeDb([]);
        await findStaleComputers(db, new Date(), 200, noNonCloudflarePlacement(sql`ezil_computers.id`));
        const text = rendered(db);
        const filter = text.indexOf("NOT EXISTS (SELECT 1 FROM public.ezil_computer_placements p WHERE p.computer_id = ezil_computers.id AND p.provider <> 'cloudflare')");
        expect(filter).toBeGreaterThan(text.indexOf('WHERE deleted_at IS NULL'));
        expect(filter).toBeLessThan(text.indexOf('ORDER BY'));
        expect(text.indexOf('ORDER BY')).toBeLessThan(text.indexOf('LIMIT'));
    });

    it('placement reads off: no placement table is named (the table may not exist)', async () => {
        const db = makeDb([]);
        await findStaleComputers(db, new Date(), 200);
        expect(rendered(db)).not.toMatch(/placements|NOT EXISTS/);
    });

    it('the handler passes its candidateFilter to the candidate query', async () => {
        const secret = 'x'.repeat(32);
        const db = makeDb([]);
        await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, candidateFilter: noNonCloudflarePlacement(sql`ezil_computers.id`) }));
        expect(rendered(db)).toMatch(/AND NOT EXISTS \(SELECT 1 FROM public\.ezil_computer_placements p/);
    });
});

describe('the AWS background reconcile rides this cron as its own job', () => {
    const secret = 'x'.repeat(32);

    it('runs after the bearer check, reports its summary, and the reap still runs', async () => {
        const awsReconcile = vi.fn().mockResolvedValue({ ok: true, deleted: { checked: 1, retiresStarted: 1, retired: 0 } });
        const db = makeDb([]);
        const body = await (await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, awsReconcile }))).json();
        expect(awsReconcile).toHaveBeenCalledTimes(1);
        expect(body).toMatchObject({ ok: true, aws: { ok: true, deleted: { retiresStarted: 1 } } });
        expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('never runs for an unauthenticated caller', async () => {
        const awsReconcile = vi.fn();
        expect((await handleSandboxReap(req('Bearer nope'), baseDeps({ cronSecret: secret, awsReconcile }))).status).toBe(404);
        expect(awsReconcile).not.toHaveBeenCalled();
    });

    it('a failure is reported in `aws` and never blocks the Cloudflare reap', async () => {
        const awsReconcile = vi.fn().mockRejectedValue(new Error('throttled'));
        const db = makeDb([]);
        const res = await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, awsReconcile }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, aws: { ok: false, error: 'aws_reconcile_failed' } });
        expect(db.execute).toHaveBeenCalledTimes(1);
    });

    it('the reap kill switch stops reaping only: retirement still runs', async () => {
        const awsReconcile = vi.fn().mockResolvedValue({ ok: true, skipped: 'aws_disabled' });
        const db = makeDb([]);
        const body = await (await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, db, killSwitch: 'off', awsReconcile }))).json();
        expect(body).toMatchObject({ skipped: true, reason: 'kill_switch_disabled', aws: { ok: true } });
        expect(awsReconcile).toHaveBeenCalledTimes(1);
        expect(db.execute).not.toHaveBeenCalled();
    });
});

describe('the stale cutoff is bound as an ISO timestamptz, never a raw Date', () => {
    it('drizzle + postgres-js reject a raw Date param ("Received an instance of Date"); the query binds a string', async () => {
        const db = makeDb([]);
        const cutoff = new Date('2026-10-13T04:08:00.000Z');
        await findStaleComputers(db, cutoff, 200);
        const { sql: text, params } = new PgDialect().sqlToQuery((db.execute as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
        expect(params[0]).toBe('2026-10-13T04:08:00.000Z');
        expect(params.some((p) => p instanceof Date)).toBe(false);
        expect(text).toMatch(/last_opened_at < \$1::timestamptz/);
    });
});

describe('Codex 4277262205: an AWS outage can never starve the Cloudflare reaper', () => {
    const secret = 'x'.repeat(32);
    const STALE = [{ id: 'c-1', user_id: 'u-1', last_opened_at: new Date('2026-01-01T00:00:00Z') }];

    it('the reap runs while the AWS pass is still in flight (the two jobs are concurrent)', async () => {
        let finishAws!: (v: unknown) => void;
        const awsReconcile = vi.fn(() => new Promise<unknown>((resolve) => { finishAws = resolve; }));
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true });
        const db = makeDb(STALE);
        const pending = handleSandboxReap(req(`Bearer ${secret}`), baseDeps({
            cronSecret: secret, db, awsReconcile, checkRunning: vi.fn().mockResolvedValue(true), terminate,
        }));
        await vi.waitFor(() => expect(terminate).toHaveBeenCalledTimes(1));
        finishAws({ ok: true, fleet: { checked: 3 } });
        const body = await (await pending).json();
        expect(body).toMatchObject({ ok: true, reaped: 1, aws: { ok: true, fleet: { checked: 3 } } });
    });

    it('an AWS pass that hangs past its budget is cut off: aborted, reported as a timeout, and the reap result stands', async () => {
        let seen: AbortSignal | undefined;
        const awsReconcile = vi.fn((signal: AbortSignal) => {
            seen = signal;
            return new Promise<unknown>(() => {}); // never settles: an AWS outage
        });
        const terminate = vi.fn().mockResolvedValue({ ok: true, terminated: true });
        const res = await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({
            cronSecret: secret, db: makeDb(STALE), awsReconcile, awsBudgetMs: 20, checkRunning: vi.fn().mockResolvedValue(true), terminate,
        }));
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, reaped: 1, aws: { ok: false, error: 'aws_reconcile_timeout' } });
        expect(terminate).toHaveBeenCalledTimes(1);
        expect(seen?.aborted).toBe(true);
    });

    it('a pass that finishes inside its budget is not aborted', async () => {
        let seen: AbortSignal | undefined;
        const awsReconcile = vi.fn(async (signal: AbortSignal) => { seen = signal; return { ok: true }; });
        const body = await (await handleSandboxReap(req(`Bearer ${secret}`), baseDeps({ cronSecret: secret, awsReconcile, awsBudgetMs: 5_000 }))).json();
        expect(body).toMatchObject({ ok: true, aws: { ok: true } });
        expect(seen?.aborted).toBe(false);
    });
});

