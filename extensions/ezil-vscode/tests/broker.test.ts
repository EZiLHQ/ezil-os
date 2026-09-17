import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, symlinkSync, chmodSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { parsePort, readBroker, readModels, sendOperation, type ModelBrokerDescriptor } from '../src/broker';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
    const root = realpathSync(mkdtempSync('/tmp/ezil-connector-')); roots.push(root);
    const dataRoot = join(root, 'data'); const workspaceId = randomUUID();
    const workspacePath = join(dataRoot, 'native-v1', 'workspaces', workspaceId, 'files');
    mkdirSync(workspacePath, { recursive: true });
    const privateRoot = join(dataRoot, 'private'); mkdirSync(privateRoot);
    const descriptor = { contractVersion: 1, origin: 'http://127.0.0.1:49152', workspaceId, workspacePath, dataRoot, token: randomBytes(32).toString('base64url'), expiresAt: Date.now() + 60_000 };
    const path = join(privateRoot, 'broker.json');
    writeFileSync(path, JSON.stringify(descriptor), { mode: 0o600 });
    return { path, descriptor, folders: [workspacePath] };
}
test('reads private external descriptor only for its explicit workspace', () => {
    const f = fixture();
    expect(readBroker(f.path, f.folders)).toEqual(f.descriptor);
    expect(() => readBroker(f.path, [])).toThrow();
    expect(() => readBroker(f.path, ['/tmp/other-workspace'])).toThrow();
    expect(() => readBroker(f.path, f.folders, f.descriptor.expiresAt)).toThrow();
});
test('rejects project descriptors, symlinks, public permissions and foreign hosts', () => {
    const f = fixture(); const projectPath = join(f.descriptor.workspacePath, 'broker.json');
    writeFileSync(projectPath, JSON.stringify(f.descriptor), { mode: 0o600 });
    expect(() => readBroker(projectPath, f.folders)).toThrow();
    const link = `${f.path}.link`; symlinkSync(f.path, link);
    expect(() => readBroker(link, f.folders)).toThrow();
    chmodSync(f.path, 0o644); expect(() => readBroker(f.path, f.folders)).toThrow();
    chmodSync(f.path, 0o600);
    for (const origin of ['http://localhost:3000', 'https://example.com', 'http://127.0.0.1:3000/?token=secret', 'http://127.0.0.1:99999']) {
        writeFileSync(f.path, JSON.stringify({ ...f.descriptor, origin }));
        expect(() => readBroker(f.path, f.folders)).toThrow();
    }
});
test('ports accept only explicit loopback port numbers', () => {
    for (const text of ['1024', '3000', '65535']) expect(parsePort(text)).toBe(Number(text));
    for (const text of ['80', '65536', '3000.1', ' 3000', '3000;echo', 'http://127.0.0.1:3000', '-3000']) expect(parsePort(text)).toBeUndefined();
});
test('private connector descriptors can bind an Electron-owned managed root', () => {
    const f = fixture(); const workspacePath = join(f.descriptor.dataRoot, 'workspaces', f.descriptor.workspaceId, 'files');
    mkdirSync(workspacePath, { recursive: true });
    const descriptor = { ...f.descriptor, workspacePath };
    writeFileSync(f.path, JSON.stringify(descriptor));
    expect(readBroker(f.path, [workspacePath])).toEqual(descriptor);
    const projectDescriptor = join(workspacePath, 'broker.json');
    writeFileSync(projectDescriptor, JSON.stringify(descriptor), { mode: 0o600 });
    expect(() => readBroker(projectDescriptor, [workspacePath])).toThrow();
});
test('Electron model descriptor calls only advertised models with no Origin or provider secrets', async () => {
    const f = fixture();
    const descriptor: ModelBrokerDescriptor = { contractVersion: 1, url: 'http://127.0.0.1:49153',
        capability: randomBytes(32).toString('hex'), operations: ['models', 'chat'],
        formats: ['text/event-stream', 'application/vnd.amazon.eventstream'] };
    writeFileSync(f.path, JSON.stringify(descriptor));
    expect(readBroker(f.path, f.folders)).toEqual(descriptor);
    const original = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = (async (url, init) => {
        calls.push(url);
        expect(url).toBe(descriptor.url + '/v1/models');
        expect(init?.method).toBe('GET');
        expect(init?.redirect).toBe('error');
        expect(new Headers(init?.headers).get('origin')).toBeNull();
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${descriptor.capability}`);
        return Response.json({ models: ['configured-model'] });
    }) as typeof fetch;
    try {
        expect(await readModels(descriptor)).toEqual(['configured-model']);
        await expect(readModels({ ...descriptor, operations: ['chat'] })).rejects.toThrow();
        for (const op of [{ op: 'workspace.remove' }, { op: 'editor.readiness', state: 'closed' },
            { op: 'preview.register', port: 80 }, { op: 'preview.register', port: 3000, url: 'http://foreign.example' }]) {
            await expect(sendOperation(f.descriptor as never, op)).rejects.toThrow();
        }
        expect(calls).toHaveLength(1);
    } finally { globalThis.fetch = original; }
    for (const change of [{ url: 'http://foreign.example' }, { operations: ['models', 'exec'] }, { providerKey: 'forbidden' }]) {
        writeFileSync(f.path, JSON.stringify({ ...descriptor, ...change }));
        expect(() => readBroker(f.path, f.folders)).toThrow();
    }
});
