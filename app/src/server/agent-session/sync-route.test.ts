import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ sync: vi.fn() }));
vi.mock('./store', async importOriginal => ({ ...await importOriginal<typeof import('./store')>(), syncEditor: h.sync }));
import { handleEditorSync, signEditorSync, type EditorSyncDeps } from './sync-route';

const secret = 'synthetic-editor-bridge-secret';
const now = 1_790_000_000_000;
const sandbox = 'guac-1111111111114111-2222222222224222';
const computer = { id: randomUUID(), user_id: randomUUID() };
const execute = vi.fn();
const base = { ownerId: 'window-fixture', epoch: 0, seq: 1 };
const deps = (overrides: Partial<EditorSyncDeps> = {}): EditorSyncDeps => ({
    db: { execute, transaction: vi.fn() }, secret, enabled: 'enabled', now: () => now, ...overrides,
});
const request = (payload: unknown, timestamp = String(now / 1000)) => {
    const body = Buffer.from(JSON.stringify(payload));
    return new Request('https://os.example.test/api/editor-bridge/v1/sync', { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-ezil-sandbox': sandbox, 'x-ezil-timestamp': timestamp,
            'x-ezil-signature': signEditorSync(secret, timestamp, sandbox, body) },
    });
};
beforeEach(() => {
    execute.mockReset().mockResolvedValue([computer]);
    h.sync.mockReset().mockResolvedValue({ owner: 'self', epoch: 1, deliver: [], applied: 0 });
});

describe('Worker-signed editor sync transport', () => {
    it('defaults off and rejects invalid or expired signatures before any SQL', async () => {
        expect((await handleEditorSync(request({ protocol: 1, ...base }), deps({ enabled: undefined }))).status).toBe(503);
        expect((await handleEditorSync(request({ protocol: 1, ...base }), deps({ secret: '' }))).status).toBe(503);
        expect((await handleEditorSync(request({ protocol: 1, ...base }, String(now / 1000 - 61)), deps())).status).toBe(401);
        const changed = request({ protocol: 1, ...base });
        changed.headers.set('x-ezil-signature', 'v1=' + '0'.repeat(64));
        expect((await handleEditorSync(changed, deps())).status).toBe(401);
        expect(execute).not.toHaveBeenCalled();
        expect(h.sync).not.toHaveBeenCalled();
    });

    it('accepts protocol 2 with an explicit controls gate and downgrades safely while it is off', async () => {
        const payload = { protocol: 2, ...base, sessions: [{ resource: 'session', title: 'test', open: true,
            status: 'idle', model: 'test-model', requests: 0 }] };
        const disabled = await handleEditorSync(request(payload), deps());
        expect(await disabled.json()).toMatchObject({ ok: true, protocol: 1 });
        expect(h.sync).toHaveBeenLastCalledWith(expect.anything(), { id: computer.id, userId: computer.user_id }, payload, { controls: false });
        const enabled = await handleEditorSync(request(payload), deps({ controls: 'enabled' }));
        expect(await enabled.json()).toMatchObject({ ok: true, protocol: 2 });
        expect(h.sync).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), payload, { controls: true });
    });

    it('rejects unknown versions, protocol-2 fields on protocol 1, and oversized bodies before SQL', async () => {
        for (const payload of [
            { protocol: 3, ...base }, { protocol: 1, ...base, catalog: {} },
            { protocol: 2, ...base, sessions: [{ resource: 'r', title: 't', open: true, status: 'idle' }] },
        ]) expect((await handleEditorSync(request(payload), deps())).status).toBe(400);
        expect((await handleEditorSync(request({ padding: 'x'.repeat(256 * 1024) }), deps())).status).toBe(413);
        expect(execute).not.toHaveBeenCalled();
    });

    it('refuses ambiguous computer prefixes and reports replay or lost ownership without delivery', async () => {
        execute.mockResolvedValueOnce([]).mockResolvedValueOnce([computer, computer]);
        for (let i = 0; i < 2; i++) expect((await handleEditorSync(request({ protocol: 1, ...base }), deps())).status).toBe(404);
        expect(h.sync).not.toHaveBeenCalled();
        h.sync.mockResolvedValueOnce({ owner: 'replayed' }).mockResolvedValueOnce({ owner: 'gone' });
        expect((await handleEditorSync(request({ protocol: 1, ...base }), deps())).status).toBe(409);
        expect((await handleEditorSync(request({ protocol: 1, ...base }), deps())).status).toBe(404);
    });
});
