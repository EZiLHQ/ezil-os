import { expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createNativeRuntime } from '../../../native/src/server.ts';

test('activation acknowledges readiness and commands register/unregister a preview with the real handler', async () => {
    const root = mkdtempSync('/tmp/ezil-extension-'); const dataRoot = join(root, 'data');
    const admin = randomBytes(32).toString('base64url'); const origin = 'http://127.0.0.1:49152';
    const workspacePath = join(root, 'electron-project'); mkdirSync(workspacePath);
    const workspaceId = randomUUID();
    const runtime = createNativeRuntime({ dataRoot, adminToken: admin, attachedWorkspace: { id: workspaceId, root: workspacePath } });
    const actualFetch = globalThis.fetch;
    const previousDescriptor = process.env.EZIL_BROKER_FILE;
    const calls: Record<string, unknown>[] = [];
    const notifications: string[] = [];
    const commands = new Map<string, () => Promise<void>>();
    const request = (path: string, value: unknown, token = admin) => runtime.fetch(new Request(origin + path, {
        method: 'POST', headers: { host: '127.0.0.1:49152', origin, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(value),
    }), origin);
    let extension: typeof import('../src/extension') | undefined;
    try {
        const record = (await (await request('/api/native/operations', { op: 'workspace.get', workspaceId })).json()).workspace;
        const capability = await (await request('/api/native/capabilities', { workspaceId: record.id, role: 'connector' })).json();
        const descriptor = join(root, 'broker.json');
        writeFileSync(descriptor, JSON.stringify({ contractVersion: 1, origin, workspaceId: record.id, dataRoot, workspacePath, token: capability.token, expiresAt: capability.expiresAt }), { mode: 0o600 });
        process.env.EZIL_BROKER_FILE = descriptor;
        mock.module('vscode', () => ({
            workspace: { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: workspacePath } }] },
            window: {
                showInputBox: async () => '3000',
                showInformationMessage: (text: string) => { notifications.push(text); },
            },
            commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; } },
        }));
        globalThis.fetch = (async (url, init) => {
            calls.push(JSON.parse(String(init?.body)));
            const headers = new Headers(init?.headers); headers.set('host', '127.0.0.1:49152');
            return runtime.fetch(new Request(String(url), { ...init, headers }), origin);
        }) as typeof fetch;
        extension = await import('../src/extension');
        await extension.activate({ subscriptions: [] } as never);
        expect(calls[0]).toEqual({ op: 'editor.readiness', state: 'active', workspaceId: record.id });
        await commands.get('ezil.registerPreview')!();
        expect(calls.at(-1)?.op).toBe('preview.register');
        await commands.get('ezil.unregisterPreview')!();
        expect(calls.at(-1)?.op).toBe('preview.unregister');
        await extension.deactivate();
        expect(calls.at(-1)?.state).toBe('unknown');
        expect(JSON.stringify(notifications)).not.toContain(capability.token);
        expect(JSON.stringify(notifications)).not.toContain(descriptor);
        calls.length = 0; commands.clear();
        writeFileSync(descriptor, JSON.stringify({ contractVersion: 1, url: origin,
            capability: randomBytes(32).toString('hex'), operations: ['models', 'chat'], formats: ['text/event-stream'] }));
        globalThis.fetch = (async (url, init) => {
            expect(String(url)).toBe(origin + '/v1/models');
            expect(new Headers(init?.headers).has('origin')).toBe(false);
            calls.push({ op: 'models' });
            return Response.json({ models: ['model-one'] });
        }) as typeof fetch;
        await extension.activate({ subscriptions: [] } as never);
        expect(calls).toHaveLength(0);
        expect(commands.has('ezil.registerPreview')).toBe(false);
        await commands.get('ezil.listModels')!();
        expect(calls).toEqual([{ op: 'models' }]);
    } finally {
        await extension?.deactivate(); globalThis.fetch = actualFetch;
        if (previousDescriptor === undefined) delete process.env.EZIL_BROKER_FILE; else process.env.EZIL_BROKER_FILE = previousDescriptor;
        runtime.stop(); rmSync(root, { recursive: true, force: true });
    }
});
