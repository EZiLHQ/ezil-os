import { afterEach, expect, test } from 'bun:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { parseOperation, NATIVE_RUNTIME } from '../src/contract.ts';
import { SurfaceLifecycle, nativeFrameUrl, nativeEvents, type SurfaceOperation, type SurfaceResult } from '../src/surfaces.ts';
import { createNativeRuntime } from '../src/server.ts';

const identity = () => ({ workspaceId: randomUUID(), surfaceId: randomUUID(), generation: 1, sequence: 1 });
test('v2 runtime capabilities and strict layout schema', () => {
    expect(NATIVE_RUNTIME).toEqual({ contractVersion: 2, executionTarget: 'macos-host', isolation: 'trusted-native',
        editor: 'embedded-code-server', externalEditor: 'optional-microsoft-vscode', browser: 'native-chromium', cloudSync: 'disabled' });
    const op = { ...identity(), op: 'browser.layout' as const, bounds: { x: -1, y: 20, width: 800.5, height: 600 }, visible: true, occluded: false };
    expect(parseOperation(op)).toEqual(op);
    for (const bounds of [{ ...op.bounds, width: -1 }, { ...op.bounds, x: NaN }, { ...op.bounds, y: Infinity }, { ...op.bounds, height: 32769 }, { ...op.bounds, command: 'open' }]) expect(() => parseOperation({ ...op, bounds })).toThrow();
    for (const patch of [{ visible: 1 }, { url: 'http://localhost' }, { sequence: 0 }, { generation: 1.5 }, { surfaceId: '../path' }]) expect(() => parseOperation({ ...op, ...patch })).toThrow();
    expect(parseOperation({ ...identity(), op: 'browser.navigate', url: 'https://example.com/' }).op).toBe('browser.navigate');
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://example.com/', 'https://u:p@example.com/'])
        expect(() => parseOperation({ ...identity(), op: 'browser.navigate', url })).toThrow();
});
test('lifecycle rejects replay, stale generations, kind changes and post-close messages', () => {
    const life = new SurfaceLifecycle(); const id = identity();
    const open: SurfaceOperation = { ...id, op: 'code.open' }; life.accept(open);
    expect(() => life.accept(open)).toThrow('stale_surface');
    expect(() => life.accept({ ...id, sequence: 2, op: 'browser.focus' })).toThrow('stale_surface');
    life.accept({ ...id, sequence: 2, op: 'code.close' });
    expect(() => life.accept({ ...id, sequence: 3, op: 'code.status' })).toThrow('stale_surface');
    life.accept({ ...open, generation: 2 });
    expect(life.current(open)).toBe(false);
    expect(() => life.accept({ ...open, sequence: 4 })).toThrow('stale_surface');
    expect(life.hasWorkspace(id.workspaceId)).toBe(true);
});
test('frame URLs and diagnostics exclude arbitrary hosts, credentials and free text', () => {
    expect(nativeFrameUrl('http://127.0.0.1:8443/')).toBe('http://127.0.0.1:8443/');
    for (const url of ['file:///etc/passwd', 'https://example.com', 'http://localhost:8443/', 'http://u:p@127.0.0.1:8443/', 'http://127.0.0.1:8443/?token=secret', 'http://127.0.0.1:22/', 'http://127.0.0.1:8443/#secret']) expect(() => nativeFrameUrl(url)).toThrow();
    expect(nativeEvents([{ event: 'code_ready', t: 1, durationMs: 20, path: '/secret', message: 'secret' }, { event: 'secret', t: 1 }, { event: 'code_failed', t: NaN }])).toEqual([{ event: 'code_ready', t: 1, durationMs: 20 }]);
});
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach(fn => fn()));
async function fixture() {
    const root = realpathSync(mkdtempSync('/tmp/ezil-parity-runtime-')); const token = randomBytes(32).toString('base64url');
    const calls: SurfaceOperation[] = []; let state = 'ready'; let badUrl = false;
    const runtime = createNativeRuntime({ dataRoot: root, adminToken: token, hostAdapter: {
        async surface(op) { calls.push(op); return { ...op, ok: true, state,
            ...(/^(code|preview)\.(open|status)$/.test(op.op) ? { url: badUrl ? 'https://hostile.example/' : `http://127.0.0.1:${op.op.startsWith('code') ? 8443 : 3000}/` } : {}) } as SurfaceResult; },
        async diagnostics() { return [{ event: 'code_ready', t: 1, message: 'secret' } as any]; },
    } });
    cleanup.push(() => { runtime.stop(); rmSync(root, { recursive: true, force: true }); });
    const operation = async (op: unknown, auth = token) => {
        const response = await runtime.fetch(new Request('http://127.0.0.1:49152/api/native/operations', { method: 'POST', headers: {
            host: '127.0.0.1:49152', origin: 'http://127.0.0.1:49152', authorization: `Bearer ${auth}`, 'content-type': 'application/json' }, body: JSON.stringify(op) }), 'http://127.0.0.1:49152');
        return { status: response.status, body: await response.json() as any };
    };
    const workspace = (await operation({ op: 'workspace.create', name: 'Local' })).body.workspace;
    return { operation, calls, workspaceId: workspace.id as string, state: (s: string) => { state = s; }, badUrl: () => { badUrl = true; } };
}
test('runtime code readiness/failure and registered-port preview, revocation and diagnostics', async () => {
    const f = await fixture(); const id = { ...identity(), workspaceId: f.workspaceId };
    f.state('starting'); expect((await f.operation({ ...id, op: 'code.open' })).body.state).toBe('starting');
    f.state('ready'); expect((await f.operation({ ...id, sequence: 2, op: 'code.status' })).body.url).toBe('http://127.0.0.1:8443/');
    f.state('failed'); expect((await f.operation({ ...id, sequence: 3, op: 'code.status' })).body.state).toBe('failed');
    expect((await f.operation({ ...id, sequence: 2, op: 'code.status' })).body.error).toBe('stale_surface');
    const preview = { ...identity(), workspaceId: f.workspaceId, op: 'preview.open', port: 3000 };
    expect((await f.operation(preview)).body.error).toBe('preview_not_registered');
    await f.operation({ op: 'editor.readiness', workspaceId: f.workspaceId, state: 'active' });
    await f.operation({ op: 'preview.register', workspaceId: f.workspaceId, port: 3000 });
    f.state('ready'); expect((await f.operation(preview)).body.url).toBe('http://127.0.0.1:3000/');
    await f.operation({ op: 'preview.unregister', workspaceId: f.workspaceId, port: 3000 });
    const { port, ...status } = preview;
    expect((await f.operation({ ...status, op: 'preview.status', sequence: 2 })).body.error).toBe('preview_not_registered');
    expect((await f.operation({ op: 'diagnostics.read', workspaceId: f.workspaceId })).body.events).toEqual([{ event: 'code_ready', t: 1 }]);
    f.badUrl(); expect((await f.operation({ ...id, sequence: 4, op: 'code.status' })).body.error).toBe('invalid_surface_url');
});
test('workspace rename persists without accepting paths; open surfaces block deletion', async () => {
    const f = await fixture();
    const r = await f.operation({ op: 'workspace.rename', workspaceId: f.workspaceId, name: 'Renamed' });
    expect(r.body.workspace.name).toBe('Renamed');
    expect((await f.operation({ op: 'workspace.get', workspaceId: f.workspaceId })).body.workspace.name).toBe('Renamed');
    expect((await f.operation({ op: 'workspace.rename', workspaceId: f.workspaceId, name: 'x', path: '/tmp' })).status).toBe(400);
    await f.operation({ ...identity(), workspaceId: f.workspaceId, op: 'browser.attach' });
    expect((await f.operation({ op: 'workspace.remove', workspaceId: f.workspaceId })).body.error).toBe('handoff_pending');
});
