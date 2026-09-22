import { expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createNativeRuntime } from '../../../native/src/server.ts';

function crc32(value: Uint8Array): number {
    let crc = 0xffffffff;
    for (const byte of value) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
    return (crc ^ 0xffffffff) >>> 0;
}
function bedrockFrame(type: string, payload: object): Buffer {
    const name = Buffer.from(':event-type'), value = Buffer.from(type);
    const headers = Buffer.concat([Buffer.from([name.length]), name, Buffer.from([7, value.length >> 8, value.length & 0xff]), value]);
    const body = Buffer.from(JSON.stringify(payload)); const frame = Buffer.alloc(16 + headers.length + body.length);
    frame.writeUInt32BE(frame.length, 0); frame.writeUInt32BE(headers.length, 4); frame.writeUInt32BE(crc32(frame.subarray(0, 8)), 8);
    headers.copy(frame, 12); body.copy(frame, 12 + headers.length); frame.writeUInt32BE(crc32(frame.subarray(0, -4)), frame.length - 4);
    return frame;
}

test('activation acknowledges readiness and commands register/unregister a preview with the real handler', async () => {
    const root = realpathSync(mkdtempSync('/tmp/ezil-extension-')); const dataRoot = join(root, 'data');
    const admin = randomBytes(32).toString('base64url'); const origin = 'http://127.0.0.1:49152';
    const workspaceId = randomUUID();
    const workspacePath = join(dataRoot, 'workspaces', workspaceId, 'files'); mkdirSync(workspacePath, { recursive: true });
    const runtime = createNativeRuntime({ dataRoot, adminToken: admin, attachedWorkspace: { id: workspaceId, root: workspacePath } });
    const actualFetch = globalThis.fetch;
    const previousDescriptor = process.env.EZIL_BROKER_FILE;
    const previousAI = process.env.EZIL_AI_BROKER_FILE;
    const calls: Record<string, unknown>[] = [];
    const notifications: string[] = [];
    const commands = new Map<string, () => Promise<void>>();
    const providers: unknown[] = [];
    class TextPart { constructor(public value: string) {} }
    const request = (path: string, value: unknown, token = admin) => runtime.fetch(new Request(origin + path, {
        method: 'POST', headers: { host: '127.0.0.1:49152', origin, 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(value),
    }), origin);
    let extension: typeof import('../src/extension') | undefined;
    try {
        const record = (await (await request('/api/native/operations', { op: 'workspace.get', workspaceId })).json()).workspace;
        const capability = await (await request('/api/native/capabilities', { workspaceId: record.id, role: 'connector' })).json();
        const privateRoot = join(dataRoot, 'private'); mkdirSync(privateRoot);
        const descriptor = join(privateRoot, 'broker.json');
        writeFileSync(descriptor, JSON.stringify({ contractVersion: 1, origin, workspaceId: record.id, dataRoot, workspacePath, token: capability.token, expiresAt: capability.expiresAt }), { mode: 0o600 });
        process.env.EZIL_BROKER_FILE = descriptor;
        let grantTrust: (() => void) | undefined;
        const mockWorkspace = { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', fsPath: workspacePath } }],
            onDidGrantWorkspaceTrust: (callback: () => void) => { grantTrust = callback; return { dispose() {} }; } };
        mock.module('vscode', () => ({
            workspace: mockWorkspace,
            window: {
                showInputBox: async () => '3000',
                showInformationMessage: (text: string) => { notifications.push(text); },
            },
            commands: { registerCommand: (name: string, callback: () => Promise<void>) => { commands.set(name, callback); return { dispose() {} }; } },
            lm: { registerLanguageModelChatProvider: (_vendor: string, provider: unknown) => { providers.push(provider); return { dispose() {} }; } },
            LanguageModelTextPart: TextPart,
            LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
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
        calls.length = 0; commands.clear(); mockWorkspace.isTrusted = false;
        await extension.activate({ subscriptions: [] } as never);
        expect(calls).toHaveLength(0); expect(commands.size).toBe(0);
        mockWorkspace.isTrusted = true; grantTrust!();
        for (let count = 0; count < 50 && !commands.has('ezil.registerPreview'); count++) await Bun.sleep(5);
        expect(calls[0]).toMatchObject({ op: 'editor.readiness', state: 'active' });
        expect(commands.has('ezil.registerPreview')).toBe(true);
        await extension.deactivate();
        calls.length = 0; commands.clear();
        delete process.env.EZIL_BROKER_FILE;
        process.env.EZIL_AI_BROKER_FILE = descriptor;
        writeFileSync(descriptor, JSON.stringify({ contractVersion: 1, url: origin,
            capability: randomBytes(32).toString('hex'), operations: ['models', 'chat'], formats: ['text/event-stream'] }));
        globalThis.fetch = (async (url, init) => {
            expect(new Headers(init?.headers).has('origin')).toBe(false);
            if (String(url) === origin + '/v1/models') {
                calls.push({ op: 'models' });
                return Response.json({ models: ['model-one'] });
            }
            expect(String(url)).toBe(origin + '/v1/chat');
            calls.push({ op: 'chat', body: JSON.parse(String(init?.body)) });
            return new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
        }) as typeof fetch;
        await extension.activate({ subscriptions: [] } as never);
        expect(calls).toHaveLength(0);
        expect(commands.has('ezil.registerPreview')).toBe(false);
        expect(providers).toHaveLength(1);
        await commands.get('ezil.listModels')!();
        expect(calls).toEqual([{ op: 'models' }]);
        const provider = providers[0] as { provideLanguageModelChatInformation: Function; provideLanguageModelChatResponse: Function };
        const cancellation = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
        const models = await provider.provideLanguageModelChatInformation({ silent: true }, cancellation);
        expect(models[0]).toMatchObject({ id: 'model-one', capabilities: { toolCalling: false } });
        const streamed: TextPart[] = [];
        await provider.provideLanguageModelChatResponse(models[0], [{ role: 1, content: [new TextPart('hi')] }], { toolMode: 1 }, { report: (part: TextPart) => streamed.push(part) }, cancellation);
        expect(streamed.map(part => part.value)).toEqual(['hello']);
        expect(calls.at(-1)).toMatchObject({ op: 'chat', body: { model: 'model-one', messages: [{ role: 'user', content: 'hi' }] } });
        globalThis.fetch = (async () => new Response(bedrockFrame('contentBlockDelta', { delta: { text: 'bedrock' }, contentBlockIndex: 0 }), { headers: { 'content-type': 'application/vnd.amazon.eventstream' } })) as typeof fetch;
        streamed.length = 0;
        await provider.provideLanguageModelChatResponse(models[0], [{ role: 1, content: [new TextPart('hi')] }], { toolMode: 1 }, { report: (part: TextPart) => streamed.push(part) }, cancellation);
        expect(streamed.map(part => part.value)).toEqual(['bedrock']);
    } finally {
        await extension?.deactivate(); globalThis.fetch = actualFetch;
        if (previousDescriptor === undefined) delete process.env.EZIL_BROKER_FILE; else process.env.EZIL_BROKER_FILE = previousDescriptor;
        if (previousAI === undefined) delete process.env.EZIL_AI_BROKER_FILE; else process.env.EZIL_AI_BROKER_FILE = previousAI;
        runtime.stop(); rmSync(root, { recursive: true, force: true });
    }
});
