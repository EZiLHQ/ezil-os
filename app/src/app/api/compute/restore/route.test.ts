import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db', () => ({ db: { execute: vi.fn() } }));
import { db } from '@/server/db';
import { GET as headGET, runtime, dynamic } from './[computerId]/[kind]/head/route';
import { GET as chunkGET, runtime as chunkRuntime, dynamic as chunkDynamic } from './[computerId]/[kind]/chunk/[index]/route';
import { deriveGuacamoleSandboxId, MIGRATE_CHUNK_LIMIT, MIGRATE_HEAD_LIMIT } from '@/server/lib/cloudflare-guacamole-provider';

const C = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const token = 'private-restore-token';
let row: Record<string, unknown>;
let upstream: ReturnType<typeof vi.fn>;
function call({ computerId = C, kind = 'workspace', index, generation = G, auth = `Bearer ${token}` }: {
    computerId?: string; kind?: string; index?: string; generation?: string; auth?: string;
} = {}) {
    const req = new Request(`https://app.test/api/compute/restore/${computerId}/${kind}/head?generation=${generation}`, {
        headers: auth ? { Authorization: auth } : {},
    });
    return index === undefined ? headGET(req, { params: Promise.resolve({ computerId, kind }) })
        : chunkGET(req, { params: Promise.resolve({ computerId, kind, index }) });
}

beforeEach(() => {
    row = { id: U, computer_id: C, user_id: U, generation: G, system_head: { generation: U }, state: 'exported', last_error: null,
        restore_token_sha256: createHash('sha256').update(token).digest('hex'),
        restore_token_expires_at: new Date(Date.now() + 900_000).toISOString() };
    vi.mocked(db.execute).mockReset().mockResolvedValue([row] as never);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.test');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-hmac-secret');
    upstream = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', upstream);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('restore proxy capability boundary', () => {
    it('runs uncached on node', () => {
        expect([runtime, chunkRuntime]).toEqual(['nodejs', 'nodejs']);
        expect([dynamic, chunkDynamic]).toEqual(['force-dynamic', 'force-dynamic']);
    });
    for (const index of [undefined, '0']) {
        it.each(['missing', 'wrong', 'expired', 'other computer', 'other generation', 'unknown', 'revoked', 'recovery'])('%s token returns opaque 401 for index ' + index, async reason => {
            let auth = `Bearer ${token}`;
            if (reason === 'missing') auth = '';
            if (reason === 'wrong') auth = 'Bearer wrong';
            if (reason === 'expired') row.restore_token_expires_at = new Date(Date.now() - 1).toISOString();
            if (reason === 'other computer') row.computer_id = U;
            if (reason === 'other generation') row.generation = U;
            if (reason === 'unknown') vi.mocked(db.execute).mockResolvedValue([] as never);
            if (reason === 'revoked') row.state = 'committed';
            if (reason === 'recovery') row.last_error = 'recovery:abort:export';
            const res = await call({ auth, index });
            expect(res.status).toBe(401);
            expect(await res.text()).toBe('');
            expect(res.headers.get('cache-control')).toBe('no-store');
            expect(upstream).not.toHaveBeenCalled();
            if (reason === 'missing') expect(db.execute).not.toHaveBeenCalled();
        });
    }
    it.each(['Basic token', 'Bearer', 'Bearer a b'])('rejects malformed authorization %s', async auth => {
        expect((await call({ auth })).status).toBe(401);
        expect(db.execute).not.toHaveBeenCalled();
    });
    it.each([
        { computerId: 'bad' }, { computerId: C + 'x' }, { kind: 'other' }, { kind: 'Workspace' },
        { generation: '' }, { generation: 'bad' }, { index: '-1' }, { index: '512' }, { index: '1.5' },
        { index: 'NaN' }, { index: '01' }, { index: '1e2' }, { index: '9007199254740993' }, { index: '' },
    ])('rejects invalid parameters %j before DB/Worker access', async params => {
        const res = await call(params);
        expect(res.status).toBe(400);
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(db.execute).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });
    it('fails closed on a changed migration between verification and owner lookup', async () => {
        vi.mocked(db.execute).mockResolvedValueOnce([row] as never).mockResolvedValueOnce([{ ...row, generation: U }] as never);
        expect((await call()).status).toBe(401);
        expect(upstream).not.toHaveBeenCalled();
    });
    it('fails closed without a record after verification', async () => {
        vi.mocked(db.execute).mockResolvedValueOnce([row] as never).mockResolvedValueOnce([] as never);
        expect((await call()).status).toBe(401);
    });
});

describe('restore proxy streaming', () => {
    it.each(['workspace', 'system'])('streams %s bytes and headers from the correct signed export', async kind => {
        let finish!: () => void;
        upstream.mockResolvedValue(new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array([0, 255]));
            finish = () => { controller.enqueue(new Uint8Array([1, 2])); controller.close(); };
        } }), { headers: { 'x-ezil-chunk-sha256': 'a'.repeat(64), 'content-length': '4', 'set-cookie': 'private=bad' } }));
        const res = await call({ kind, index: '511' });
        const reader = res.body!.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([0, 255]));
        finish();
        expect((await reader.read()).value).toEqual(new Uint8Array([1, 2]));
        expect((await reader.read()).done).toBe(true);
        expect(res.status).toBe(200);
        expect(res.headers.get('x-ezil-chunk-sha256')).toBe('a'.repeat(64));
        expect(res.headers.get('content-length')).toBe('4');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.has('set-cookie')).toBe(false);
        const [url, init] = upstream.mock.calls[0]!;
        expect(url).toBe(`https://worker.test/sandbox/${deriveGuacamoleSandboxId(U, C)}/migrate/export/${kind === 'system' ? 'system/' : ''}chunk/511?generation=${kind === 'system' ? U : G}`);
        expect(init.headers.Authorization).toMatch(/^Bearer t=\d+,v1=[a-f0-9]{64}$/);
        expect(JSON.stringify(init)).not.toContain(token);
    });
    it.each(['workspace', 'system'])('proxies %s head with generation', async kind => {
        upstream.mockResolvedValue(new Response(JSON.stringify({ generation: kind === 'system' ? U : G })));
        const res = await call({ kind });
        expect(await res.json()).toEqual({ generation: G });
        expect(upstream.mock.calls[0]![0]).toContain(`/export/${kind === 'system' ? 'system/' : ''}head?generation=${kind === 'system' ? U : G}`);
    });
    it('projects the pinned system generation without changing integrity metadata', async () => {
        const head = { generation: U, chunkGeneration: C, archiveSha256: 'a'.repeat(64), chunks: [{ size: 1, sha256: 'b'.repeat(64) }] };
        upstream.mockResolvedValue(new Response(JSON.stringify(head)));
        const res = await call({ kind: 'system' });
        expect(await res.json()).toEqual({ ...head, generation: G });
    });
    it('rejects a changed system generation before publishing a head', async () => {
        upstream.mockResolvedValue(new Response(JSON.stringify({ generation: C })));
        expect((await call({ kind: 'system' })).status).toBe(409);
    });
    it.each([null, {}, { generation: 'bad' }])('refuses absent or corrupt stored system scope %j', async head => {
        row.system_head = head;
        expect((await call({ kind: 'system' })).status).toBe(head && 'generation' in head ? 503 : 404);
        expect(upstream).not.toHaveBeenCalled();
    });
    it('rechecks a rotated capability after the owner lookup', async () => {
        vi.mocked(db.execute).mockResolvedValueOnce([row] as never).mockResolvedValueOnce([{ ...row, restore_token_sha256: 'f'.repeat(64) }] as never);
        expect((await call()).status).toBe(401);
        expect(upstream).not.toHaveBeenCalled();
    });
    it.each([[404, 404], [409, 409], [500, 503], [401, 503]])('maps Worker %i to %i without body details', async (status, expected) => {
        upstream.mockResolvedValue(new Response(token, { status }));
        const res = await call();
        expect(res.status).toBe(expected);
        expect(await res.text()).toBe('');
    });
    it('never logs credentials on DB, transport, or upstream failure', async () => {
        const logs = ['log', 'warn', 'error', 'info', 'debug'].map(name => vi.spyOn(console, name as 'log').mockImplementation(() => {}));
        upstream.mockRejectedValue(new Error(token));
        expect((await call()).status).toBe(503);
        vi.mocked(db.execute).mockRejectedValueOnce(new Error(token));
        expect((await call()).status).toBe(503);
        upstream.mockResolvedValue(new Response(token, { status: 409 }));
        expect((await call()).status).toBe(409);
        for (const log of logs) expect(log).not.toHaveBeenCalled();
    });
    for (const [index, limit] of [[undefined, MIGRATE_HEAD_LIMIT], ['0', MIGRATE_CHUNK_LIMIT]] as const) {
        it('rejects declared oversize for index ' + index, async () => {
            const cancel = vi.fn();
            upstream.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { 'content-length': String(limit + 1) } }));
            expect((await call({ index })).status).toBe(503);
            expect(cancel).toHaveBeenCalled();
        });
        it('bounds undeclared streaming size for index ' + index, async () => {
            upstream.mockResolvedValue(new Response(new Uint8Array(limit + 1)));
            const res = await call({ index });
            await expect(res.arrayBuffer()).rejects.toThrow('migration_response_size');
        });
        it('accepts the exact byte limit for index ' + index, async () => {
            upstream.mockResolvedValue(new Response(new Uint8Array(limit)));
            expect((await (await call({ index })).arrayBuffer()).byteLength).toBe(limit);
        });
    }
    it('counts cumulative bytes and does not trust an understated content length', async () => {
        upstream.mockResolvedValue(new Response(new ReadableStream({ start(c) {
            c.enqueue(new Uint8Array(MIGRATE_CHUNK_LIMIT)); c.enqueue(new Uint8Array(1)); c.close();
        } }), { headers: { 'content-length': '1' } }));
        await expect((await call({ index: '0' })).arrayBuffer()).rejects.toThrow('migration_response_size');
    });
    it('cancels the Worker stream when the host disconnects', async () => {
        const cancel = vi.fn();
        upstream.mockResolvedValue(new Response(new ReadableStream({ cancel })));
        await (await call({ index: '0' })).body!.cancel();
        expect(cancel).toHaveBeenCalled();
    });
});
