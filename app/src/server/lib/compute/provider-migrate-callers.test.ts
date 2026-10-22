import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateAbort, migrateBegin, migrateCommit, migrateExport, migrateExportHead, migrateReopen,
    mintSandboxPreviewToken, requestGuacamoleDesktopRestart, resolveCloudflareGuacamoleConfig } from '../cloudflare-guacamole-provider';

const name = 'sandbox/name';
const commit = { targetProvider: 'aws-ec2' as const, expectedEtag: 'source', expectedSystemEtag: null };
const begin = { etag: 'etag', systemEtag: null, generation: 'gen', chunkCount: 1, totalBytes: 42, sha256: 'a'.repeat(64) };
const calls = [
    ['begin', () => migrateBegin(name), begin, {}],
    ['commit', () => migrateCommit(name, commit), { ok: true, systemFenced: false }, commit],
    ['abort', () => migrateAbort(name), { ok: true }, {}],
    ['reopen', () => migrateReopen(name, { expectedMigratedEtag: 'migrated' }), { ok: true }, { expectedMigratedEtag: 'migrated' }],
    ['export/head', () => migrateExportHead(name, 'workspace'), { generation: 'gen' }, undefined],
    ['export/system/head', () => migrateExportHead(name, 'system'), { generation: 'gen' }, undefined],
] as const;
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1234567890000);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.test/');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-secret');
    fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('migration Worker callers', () => {
    for (const [action, call, data, body] of calls) {
        it(action + ' uses the existing restart signer and the expected wire contract', async () => {
            fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, outcome: 'restarted' })));
            await requestGuacamoleDesktopRestart(resolveCloudflareGuacamoleConfig(), 'test-secret', name);
            const restartHeaders = fetcher.mock.calls[0]![1].headers;
            fetcher.mockResolvedValueOnce(new Response(JSON.stringify(data)));
            const timeout = vi.spyOn(AbortSignal, 'timeout');
            expect(await call()).toEqual({ ok: true, data });
            const [url, init] = fetcher.mock.calls[1]!;
            expect(url).toBe(`https://worker.test/sandbox/sandbox%2Fname/migrate/${action}`);
            expect(init.headers.Authorization).toBe(restartHeaders.Authorization);
            expect(init.headers.Authorization).toBe(`Bearer ${mintSandboxPreviewToken('test-secret')}`);
            expect(init.headers['x-correlation-id']).toEqual(expect.any(String));
            expect(init.method).toBe(body === undefined ? 'GET' : 'POST');
            expect(init.body).toBe(body === undefined ? undefined : JSON.stringify(body));
            expect(init.cache).toBe('no-store'); expect(init.redirect).toBe('error');
            expect(timeout).toHaveBeenLastCalledWith(action === 'begin' ? 120_000 : 30_000);
        });
        it.each([[404, 'not_found'], [409, 'conflict'], [503, 'unavailable'], [401, 'unavailable']] as const)(action + ' maps %i', async (status, error) => {
            fetcher.mockResolvedValue(new Response('private error', { status }));
            expect(await call()).toEqual({ ok: false, error, ...(status === 409 ? { reason: 'other' } : {}) });
        });
        it(action + ' rejects transport errors, malformed JSON and malformed success', async () => {
            fetcher.mockRejectedValueOnce(new Error('private'));
            expect(await call()).toEqual({ ok: false, error: 'unavailable' });
            for (const body of ['not json', 'null', '[]', '{}', '{"ok":false}']) {
                fetcher.mockResolvedValueOnce(new Response(body));
                expect(await call()).toEqual({ ok: false, error: 'unavailable' });
            }
        });
    }
    it.each(['CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'CLOUDFLARE_GUACAMOLE_WORKER_URL'])('refuses missing configuration %s', async key => {
        vi.stubEnv(key, '');
        expect(await migrateBegin(name)).toEqual({ ok: false, error: 'unavailable' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('bounds JSON responses before parsing', async () => {
        fetcher.mockResolvedValue(new Response(' '.repeat(1024 * 1024 + 1)));
        expect(await migrateExportHead(name, 'workspace')).toEqual({ ok: false, error: 'unavailable' });
    });
    it.each([-1, 512, 1.5, NaN])('refuses invalid export index %s', async index => {
        expect(await migrateExport(name, 'workspace', 'g', index)).toEqual({ ok: false, error: 'unavailable' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('refuses invalid kind at runtime', async () => {
        expect(await migrateExport(name, 'other' as 'workspace')).toEqual({ ok: false, error: 'unavailable' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('rejects invalid content length', async () => {
        fetcher.mockResolvedValue(new Response('{}', { headers: { 'content-length': 'invalid' } }));
        expect(await migrateExportHead(name, 'workspace')).toEqual({ ok: false, error: 'unavailable' });
    });
});
