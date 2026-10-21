import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateBegin, migrateExport, MIGRATE_HEAD_LIMIT } from './cloudflare-guacamole-provider';

beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'migration-test-secret');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('migration conflict reasons', () => {
    it.each([
        'head_moved', 'migration_not_started', 'no_checkpoint', 'previous_head_missing',
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
