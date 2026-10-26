import { createHash } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ execute: vi.fn(), export: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { execute: h.execute } }));
vi.mock('../cloudflare-guacamole-provider', () => ({ migrateExport: h.export, deriveGuacamoleSandboxId: () => 'sandbox', MIGRATE_HEAD_LIMIT: 1024 * 1024 }));
import { proxyMigrationRestore } from './provider-migrate-restore';

const C = '11111111-1111-4111-8111-111111111111', G = '22222222-2222-4222-8222-222222222222';
const token = 'fixture-restore-token', dialect = new PgDialect();
let row: Record<string, unknown>;
const updates = () => h.execute.mock.calls.map(([query]) => dialect.sqlToQuery(query as SQL)).filter(query => query.sql.startsWith('UPDATE'));
const call = (kind = 'workspace', index = '0', auth = token) => proxyMigrationRestore(new Request(
    `https://app.test/api/compute/restore/${C}/${kind}/chunk/${index}?generation=${G}&size=999`,
    { headers: { Authorization: `Bearer ${auth}` } }), { computerId: C, kind, ...(index === 'head' ? {} : { index }) });
beforeEach(() => {
    row = { id: G, computer_id: C, user_id: G, generation: G, state: 'exported', last_error: null,
        workspace_head: { generation: G, chunks: [{ size: 3 }] }, system_head: { generation: C, chunks: [{ size: 7 }] },
        restore_token_sha256: createHash('sha256').update(token).digest('hex'), restore_token_expires_at: new Date(Date.now() + 900_000).toISOString() };
    h.execute.mockReset().mockImplementation(async (query: SQL) => dialect.sqlToQuery(query).sql.startsWith('UPDATE') ? [] : [row]);
    h.export.mockReset().mockResolvedValue({ ok: true, data: new Response('abc') });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('restore proxy accounting', () => {
    it.each([['workspace', 3], ['system', 7]] as const)('records successful %s chunks using the stored size', async (kind, size) => {
        const response = await call(kind);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('abc');
        expect(updates()).toHaveLength(1);
        expect(updates()[0]!.params).toContain(size);
        expect(updates()[0]!.params).not.toContain(999);
        expect(h.export).toHaveBeenCalledWith('sandbox', kind, kind === 'system' ? C : G, 0);
    });
    it.each(['workspace', 'system'])('does not count %s heads', async kind => {
        h.export.mockResolvedValue({ ok: true, data: new Response(JSON.stringify({ generation: kind === 'system' ? C : G })) });
        expect((await call(kind, 'head')).status).toBe(200);
        expect(updates()).toHaveLength(0);
    });
    it.each([['not_found', 404], ['conflict', 409], ['unavailable', 503]] as const)('does not count upstream %s failures', async (error, status) => {
        h.export.mockResolvedValue({ ok: false, error });
        expect((await call()).status).toBe(status);
        expect(updates()).toHaveLength(0);
    });
    it('does not count token failures or Worker transport errors', async () => {
        expect((await call('workspace', '0', 'wrong')).status).toBe(401);
        expect(h.export).not.toHaveBeenCalled();
        h.export.mockRejectedValue(new Error('worker failed'));
        expect((await call()).status).toBe(503);
        expect(updates()).toHaveLength(0);
    });
    it.each([206, 404, 500])('does not count a non-200 Worker response (%i)', async status => {
        h.export.mockResolvedValue({ ok: true, data: new Response('body', { status }) });
        await call();
        expect(updates()).toHaveLength(0);
    });
    it('does not count a response without a body or an index absent from the stored head', async () => {
        h.export.mockResolvedValueOnce({ ok: true, data: new Response(null) });
        expect((await call()).status).toBe(200);
        expect((await call('workspace', '1')).status).toBe(200);
        expect(updates()).toHaveLength(0);
    });
    it('streams the original body without buffering it or waiting for its end', async () => {
        let finish!: () => void;
        h.export.mockResolvedValue({ ok: true, data: new Response(new ReadableStream({ start(controller) {
            controller.enqueue(new Uint8Array([1]));
            finish = () => { controller.enqueue(new Uint8Array([2, 3])); controller.close(); };
        } })) });
        const response = await call(), reader = response.body!.getReader();
        expect((await reader.read()).value).toEqual(new Uint8Array([1]));
        finish();
        expect((await reader.read()).value).toEqual(new Uint8Array([2, 3]));
        expect((await reader.read()).done).toBe(true);
        expect(updates()).toHaveLength(1);
    });
    it('serves the chunk and logs without raw details when the accounting update fails', async () => {
        h.execute.mockImplementation(async (query: SQL) => {
            if (dialect.sqlToQuery(query).sql.startsWith('UPDATE')) throw new Error(token);
            return [row];
        });
        const response = await call();
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('abc');
        expect(console.warn).toHaveBeenCalledOnce();
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain(token);
    });
    it('bounds a stalled accounting update so the chunk is still served', async () => {
        vi.useFakeTimers();
        h.execute.mockImplementation(async (query: SQL) => dialect.sqlToQuery(query).sql.startsWith('UPDATE') ? new Promise(() => {}) : [row]);
        const pending = call();
        await vi.advanceTimersByTimeAsync(250);
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('abc');
        expect(console.warn).toHaveBeenCalledOnce();
    });
});
