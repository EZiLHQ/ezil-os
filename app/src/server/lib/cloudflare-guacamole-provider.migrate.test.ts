import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    migrateBegin, migrateExport, MIGRATE_ACTION_TIMEOUT_MS, MIGRATE_HEAD_LIMIT, migrateImportAbort, migrateImportBegin, migrateImportCommit, migrateImportPull,
} from './cloudflare-guacamole-provider';

beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'migration-test-secret');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('migration conflict reasons', () => {
    it.each([
        'head_moved', 'migration_not_started', 'no_checkpoint', 'no_context', 'no_workspace', 'previous_head_missing',
        'generation_mismatch', 'chunk_unavailable', 'already_migrated', 'workspace_too_large',
        'workspace_size_unknown', 'system_too_large', 'system_size_unknown', 'final_checkpoint_failed',
        'flag_write_failed', 'stop_failed', 'migrating', 'not_migrated',
    ])('carries the known Worker reason %s through JSON and streaming clients', async reason => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: reason }, { status: 409 })));
        const expected = { ok: false, error: 'conflict', reason };
        expect(await migrateBegin('computer')).toEqual(expected);
        expect(await migrateExport('computer', 'workspace')).toEqual(expected);
    });

    it.each([
        { error: 'upstream detail with secrets' }, { error: 'HEAD_MOVED' }, { error: 'head_moved:detail' },
        { error: 'system_head_mismatch' }, { error: 409 }, { error: ['head_moved'] }, {}, null, ['head_moved'],
    ])('redacts non-enum payload %j to other', async body => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json(body, { status: 409 })));
        expect(await migrateBegin('computer')).toEqual({ ok: false, error: 'conflict', reason: 'other' });
    });

    it.each(['not JSON', '', JSON.stringify({ error: 'head_moved', detail: 'x'.repeat(MIGRATE_HEAD_LIMIT + 1) })])(
        'keeps malformed or oversized bodies classified as conflicts', async body => {
            vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 409 })));
            expect(await migrateBegin('computer')).toEqual({ ok: false, error: 'conflict', reason: 'other' });
        },
    );

    it.each([[404, 'not_found'], [500, 'unavailable']] as const)('preserves HTTP %s classification', async (status, error) => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'head_moved' }, { status })));
        expect(await migrateBegin('computer')).toEqual({ ok: false, error });
    });
});

describe('the reverse move\'s import client (REVERSE-MOVE-CONTRACT §4.1, §4.6)', () => {
    const binding = { moveId: '99999999-9999-4999-8999-999999999999', generation: '77777777-7777-4777-8777-777777777777',
        computerId: 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1', placementGeneration: 5, leaseEpoch: 8 };
    const calls = [
        ['import/begin', 60_000, () => migrateImportBegin('computer', binding), { ok: true, headKind: 'migrated', export: { state: 'capturing' } }],
        ['import/pull', 40_000, () => migrateImportPull('computer', { ...binding, from: 0, count: 64 }),
            { ok: true, export: { state: 'ready' }, head: { v: 1 }, stored: [0, 1], next: 2 }],
        ['import/commit', 30_000, () => migrateImportCommit('computer', { moveId: binding.moveId, generation: binding.generation,
            computerId: binding.computerId, sha256: 'f'.repeat(64), chunkCount: 3, verifyOnly: true }), { ok: true, verified: true }],
        ['import/abort', 60_000, () => migrateImportAbort('computer', { moveId: binding.moveId, generation: binding.generation, computerId: binding.computerId }), { ok: true }],
    ] as const;
    it.each(calls)('%s posts the body to /migrate/%s with its own timeout (%i ms)', async (action, ms, call, data) => {
        const fetcher = vi.fn(async () => Response.json(data));
        vi.stubGlobal('fetch', fetcher);
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        expect(await call()).toEqual({ ok: true, data });
        const [url, init] = fetcher.mock.calls[0]! as unknown as [string, RequestInit];
        expect(url).toBe(`https://worker.example/sandbox/computer/migrate/${action}`);
        expect(init.method).toBe('POST');
        expect(timeout).toHaveBeenLastCalledWith(ms);
        expect(MIGRATE_ACTION_TIMEOUT_MS[action]).toBe(ms);
    });
    it('the forward begin keeps 120 s and every other forward action 30 s', () => {
        expect(MIGRATE_ACTION_TIMEOUT_MS.begin).toBe(120_000);
        expect(MIGRATE_ACTION_TIMEOUT_MS.commit).toBeUndefined();
    });
    it.each([
        'container_running', 'head_invalid', 'head_unreadable', 'system_head_moved', 'import_busy', 'import_not_started', 'import_mismatch',
        'store_unsupported', 'prefix_mismatch', 'export_host_mismatch', 'export_refused', 'export_head_invalid', 'export_workspace_missing',
        'export_capture_failed', 'export_desktop_stop_failed', 'export_staging_space', 'chunk_mismatch', 'already_imported', 'not_verified',
        'commit_in_progress', 'head_moved', 'workspace_too_large',
    ])('carries the §4.6 Worker reason %s (never other)', async reason => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: reason }, { status: 409 })));
        expect(await migrateImportPull('computer', { ...binding, from: 0, count: 0 })).toEqual({ ok: false, error: 'conflict', reason });
    });
    it('503 export_unreachable is unavailable; 404 (routes not deployed) is not_found; a malformed success is unavailable', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'export_unreachable' }, { status: 503 })));
        expect(await migrateImportBegin('computer', binding)).toEqual({ ok: false, error: 'unavailable' });
        vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
        expect(await migrateImportBegin('computer', binding)).toEqual({ ok: false, error: 'not_found' });
        for (const body of [{ ok: true, export: { state: 'capturing' }, head: null, stored: [-1], next: null }, { ok: true, export: { state: 'odd' }, head: null, stored: [], next: null },
            { ok: true, export: { state: 'ready' }, head: [], stored: [], next: null }]) {
            vi.stubGlobal('fetch', vi.fn(async () => Response.json(body)));
            expect(await migrateImportPull('computer', { ...binding, from: 0, count: 0 }), JSON.stringify(body)).toEqual({ ok: false, error: 'unavailable' });
        }
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, verified: true })));
        expect(await migrateImportCommit('computer', { moveId: binding.moveId, generation: binding.generation, computerId: binding.computerId,
            sha256: 'f'.repeat(64), chunkCount: 3, verifyOnly: false }), 'a verify answer is not a commit').toEqual({ ok: false, error: 'unavailable' });
    });
});
