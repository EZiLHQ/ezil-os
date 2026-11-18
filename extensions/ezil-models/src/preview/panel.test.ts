import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import type * as vscode from 'vscode';
import vectors from '../../../../docs/contracts/code-preview-v1.vectors.json';
import { fakeVscode } from '../../tests/fixtures/fake-vscode';
import { previewHtml } from './html';
import { persistedState } from './state';

mock.module('vscode', () => fakeVscode);
const { PreviewPanel, registerPreview, MINT_TIMEOUT_MS } = await import('./panel');
const origin = 'https://3002-guac-u1-c1-app.ezil.org';
const minted = () => ({ url: `${origin}/preview-bootstrap?token=PRIVATE`, expiresAt: Date.now() + 60_000 });
const doc = vectors.selection.accept[0]!.sel.doc;
const sel = vectors.selection.accept[0]!.sel;

class FakePanel {
    disposed = false;
    messages: any[] = [];
    listeners: ((value: unknown) => unknown)[] = [];
    closes: (() => void)[] = [];
    reveals: unknown[][] = [];
    webview = {
        html: '', cspSource: 'https://webview.test', options: {},
        asWebviewUri: (uri: URL) => uri,
        postMessage: async (value: unknown) => { this.messages.push(value); return true; },
        onDidReceiveMessage: (listener: (value: unknown) => unknown) => { this.listeners.push(listener); return { dispose: () => { this.listeners = this.listeners.filter(value => value !== listener); } }; },
    };
    onDidDispose = (listener: () => void) => { this.closes.push(listener); return { dispose: () => { this.closes = this.closes.filter(value => value !== listener); } }; };
    reveal = (...args: unknown[]) => { this.reveals.push(args); };
    dispose(): void { if (this.disposed) return; this.disposed = true; for (const listener of [...this.closes]) listener(); }
}
const window = fakeVscode.window as Record<string, any>;
const commands = fakeVscode.commands as Record<string, any>;
const env = fakeVscode.env as Record<string, any>;
let saved: Record<string, any>[];
let sent: any[][], copied: string[], external: string[];
let reply: () => unknown;
let registered: Map<string, () => Promise<void>>, serializer: vscode.WebviewPanelSerializer;
let panels: FakePanel[], creation: unknown[][], statuses: Record<string, unknown>[];
const extensions: InstanceType<typeof PreviewPanel>[] = [];
const subscriptions: { dispose(): void }[] = [];

beforeEach(() => {
    saved = [{ ...window }, { ...commands }, { ...env }];
    sent = []; copied = []; external = []; panels = []; creation = []; statuses = []; registered = new Map(); reply = minted;
    Object.assign(commands, {
        executeCommand: async (...args: any[]) => { sent.push(args); return args[0] === '_ezil.previewMint' ? await reply() : true; },
        registerCommand: (id: string, handler: () => Promise<void>) => { registered.set(id, handler); return { dispose: () => { registered.delete(id); } }; },
    });
    Object.assign(window, {
        createStatusBarItem: () => { const status = { show() {}, dispose() {} }; statuses.push(status); return status; },
        registerWebviewPanelSerializer: (_: string, value: vscode.WebviewPanelSerializer) => { serializer = value; return { dispose() {} }; },
        createWebviewPanel: (...args: unknown[]) => { creation.push(args); const panel = new FakePanel(); panels.push(panel); return panel; },
    });
    Object.assign(env, { clipboard: { writeText: async (text: string) => copied.push(text) }, openExternal: async (uri: URL) => { external.push(uri.href); return true; } });
});
afterEach(() => {
    for (const preview of extensions.splice(0)) preview.dispose();
    for (const item of subscriptions.splice(0)) item.dispose();
    for (const [i, target] of [window, commands, env].entries()) { for (const key of Object.keys(target)) delete target[key]; Object.assign(target, saved[i]); }
});
function create(state?: unknown) {
    const panel = new FakePanel();
    const preview = new PreviewPanel(panel as unknown as vscode.WebviewPanel, state);
    extensions.push(preview);
    return { panel, preview };
}
function register() { registerPreview({ subscriptions, extensionUri: new URL('file:///extension') } as unknown as vscode.ExtensionContext); }

for (const failure of ['command', 'serializer', 'status creation', 'status text', 'status tooltip', 'status command', 'status show']) {
    test(`preview registration rolls back ${failure} without publishing partial resources`, async () => {
        let serializerActive = false, statusDisposed = false;
        let resumeLayout!: () => void;
        const layout = new Promise<void>(resolve => { resumeLayout = resolve; });
        commands.executeCommand = (...args: any[]) => { sent.push(args); return layout; };
        const existing = { dispose: mock(() => {}) };
        subscriptions.push(existing);
        const assertPrivate = () => expect(subscriptions).toEqual([existing]);
        const fail = () => { assertPrivate(); throw new Error('PRIVATE registration failure'); };
        const restored = new FakePanel();
        let restoring: PromiseLike<void> | undefined;
        let opening: Promise<void> | undefined;
        const registerCommand = commands.registerCommand;
        commands.registerCommand = (...args: any[]) => {
            assertPrivate();
            if (failure === 'command') fail();
            return registerCommand(...args);
        };
        window.registerWebviewPanelSerializer = (_: string, value: vscode.WebviewPanelSerializer) => {
            assertPrivate();
            opening = registered.get('ezil.preview.open')!();
            restoring = value.deserializeWebviewPanel(restored as unknown as vscode.WebviewPanel, { path: '/saved' });
            if (failure === 'serializer') fail();
            serializerActive = true;
            return { dispose: () => { serializerActive = false; } };
        };
        window.createStatusBarItem = () => {
            assertPrivate();
            if (failure === 'status creation') fail();
            return {
                set text(_: string) { if (failure === 'status text') fail(); },
                set tooltip(_: string) { if (failure === 'status tooltip') fail(); },
                set command(_: string) { if (failure === 'status command') fail(); },
                show: () => { if (failure === 'status show') fail(); },
                dispose: () => { statusDisposed = true; },
            };
        };
        expect(register).toThrow('PRIVATE registration failure');
        expect(subscriptions).toEqual([existing]); expect(existing.dispose).not.toHaveBeenCalled();
        expect(registered.size).toBe(0); expect(serializerActive).toBe(false);
        expect(statusDisposed).toBe(failure.startsWith('status ') && failure !== 'status creation');
        if (failure !== 'command') expect(restored.disposed).toBe(true);
        resumeLayout(); await restoring; await opening;
        expect(panels).toHaveLength(0);
        expect(sent.every(([id]) => id === 'workbench.action.restoreAuxiliaryBar')).toBe(true);
        expect(restored.listeners).toHaveLength(0); expect(restored.closes).toHaveLength(0);
    });
}

test('registration disposal closes the active panel, cancels mint and removes command and serializer', async () => {
    let serializerActive = false;
    window.registerWebviewPanelSerializer = (_: string, value: vscode.WebviewPanelSerializer) => { serializer = value; serializerActive = true; return { dispose: () => { serializerActive = false; } }; };
    let finish!: (value: unknown) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    register(); const open = registered.get('ezil.preview.open')!;
    const pending = open();
    while (!panels.length) await Promise.resolve();
    for (const subscription of subscriptions) subscription.dispose();
    await pending;
    const panel = panels[0]!, html = panel.webview.html, count = panel.messages.length;
    finish(minted()); await open();
    expect(panel.disposed).toBe(true); expect(registered.size).toBe(0); expect(serializerActive).toBe(false);
    expect(panel.webview.html).toBe(html); expect(panel.messages).toHaveLength(count); expect(panels).toHaveLength(1);
    expect(sent.filter(([id]) => id === '_ezil.previewMintCancel')).toEqual([['_ezil.previewMintCancel', sent[1]![1]]]);
    const late = new FakePanel(), calls = [...sent];
    await serializer.deserializeWebviewPanel(late as unknown as vscode.WebviewPanel, {});
    expect(late.disposed).toBe(true); expect(sent).toEqual(calls);
});

test('rollback continues disposing resources if a disposer throws and preserves the setup error', () => {
    const registerCommand = commands.registerCommand;
    commands.registerCommand = (...args: any[]) => {
        const command = registerCommand(...args);
        return { dispose() { command.dispose(); throw new Error('PRIVATE disposal'); } };
    };
    const disposeSerializer = mock(() => {}), disposeStatus = mock(() => {});
    window.registerWebviewPanelSerializer = () => ({ dispose: disposeSerializer });
    window.createStatusBarItem = () => ({ show() { throw new Error('PRIVATE setup'); }, dispose: disposeStatus });
    expect(register).toThrow('PRIVATE setup');
    expect(registered.size).toBe(0); expect(subscriptions).toHaveLength(0);
    expect(disposeSerializer).toHaveBeenCalledTimes(1); expect(disposeStatus).toHaveBeenCalledTimes(1);
});

test('command restores layout, preserves focus, retains context, and only explicit open recreates a closed panel', async () => {
    register();
    expect(panels).toHaveLength(0);
    expect(statuses[0]).toMatchObject({ command: 'ezil.preview.open' });
    await registered.get('ezil.preview.open')!();
    expect(sent[0]![0]).toBe('workbench.action.restoreAuxiliaryBar');
    expect(creation).toEqual([['ezil.preview', 'App Preview', { viewColumn: -1, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true }]]);
    await registered.get('ezil.preview.open')!();
    expect(panels).toHaveLength(1); expect(panels[0]!.reveals).toEqual([[-1, true]]);
    panels[0]!.dispose(); await Promise.resolve(); expect(panels).toHaveLength(1);
    await registered.get('ezil.preview.open')!(); expect(panels).toHaveLength(2);
    expect(sent.every(([id]) => ['workbench.action.restoreAuxiliaryBar', '_ezil.previewMint'].includes(id))).toBe(true);
    const ids = sent.filter(([id]) => id === '_ezil.previewMint').map(([, request]) => request.id);
    expect(ids[0]).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(ids[0]).not.toBe(ids[1]);
});

test('extension validates selections and generations, marks stale once, and invokes only authorized hooks and safe APIs', async () => {
    const { panel, preview } = create(); await preview.start();
    await preview.receive({ type: 'mode', mode: 'select' });
    await preview.receive({ type: 'ready', doc });
    await preview.receive({ type: 'select', sel: { ...sel, doc: { ...doc, gen: 'BBBBBBBBBBBBBBBBBBBBBB' } } });
    expect(sent.filter(([id]) => id === '_ezil.chatAddContext')).toHaveLength(0);
    await preview.receive({ type: 'select', sel });
    await preview.receive({ type: 'changed', doc: { ...doc, mut: 4 } });
    await preview.receive({ type: 'navigate', doc: { ...doc, mut: 5, path: '/next?tab=2' } });
    for (const type of ['executeCommand', 'workbench.action.chat.submit', 'query', 'open', 'setState']) await preview.receive({ type, command: 'workbench.action.chat.submit' });
    const attachments = sent.filter(([id]) => id === '_ezil.chatAddContext').map(([, value]) => value);
    expect(attachments).toHaveLength(2); expect(attachments[0].id).toBe(attachments[1].id); expect(attachments[1].stale).toBe(true);
    await preview.receive({ type: 'copy', url: 'https://evil.test/?token=PRIVATE' }); await preview.receive({ type: 'external' });
    expect(copied).toEqual([]); expect(new URL(external[0]!).searchParams.get('path')).toBe('/next?tab=2');
    expect(new URL(external[0]!).pathname).toBe('/preview-bootstrap');
    expect(JSON.stringify(copied)).not.toMatch(/PRIVATE|token=/);
    expect(sent.every(([id]) => ['_ezil.previewMint', '_ezil.chatAddContext'].includes(id))).toBe(true);
    expect(panel.messages.some(message => message.text === 'Selection added to chat.')).toBe(true);
});

test('serializer re-mints and restores only the sanitized path and viewport', async () => {
    register(); const panel = new FakePanel();
    await serializer.deserializeWebviewPanel(panel as unknown as vscode.WebviewPanel, { open: true, path: '/saved?token=OLD&tab=2', viewport: '768x1024', url: 'https://evil.test/?token=OLD' });
    expect(sent.map(([id]) => id)).toEqual(['workbench.action.restoreAuxiliaryBar', '_ezil.previewMint']);
    expect(panel.webview.html).toContain('data-path="/saved?tab=2"');
    expect(panel.webview.html).toContain('data-viewport="768x1024"');
    expect(panel.webview.html).toContain('path=%2Fsaved%3Ftab%3D2');
    expect(panel.webview.html).not.toContain('OLD');
});

test('each reload gets fresh authorization even while the previous mint is valid', async () => {
    let generation = 0;
    reply = () => ({ ...minted(), url: `${origin}/preview-bootstrap?token=PRIVATE${++generation}` });
    const { panel, preview } = create(); await preview.start(); await preview.receive({ type: 'ready', doc });
    await preview.receive({ type: 'reload' });
    expect(sent).toHaveLength(2);
    expect(new URL(panel.messages.at(-1).url).searchParams.get('token')).toBe('PRIVATE2');
    expect(new URL(panel.messages.at(-1).url).searchParams.get('path')).toBe('/pricing');
});

for (const host of [origin, 'https://aws-3002-guac-u1-c1-aws.ezil.org']) {
    test(`reload, history and external rebootstrap; legacy copy has no authority on ${host}`, async () => {
        reply = () => ({ ...minted(), url: `${host}/preview-bootstrap?token=PRIVATE` });
        const { panel, preview } = create(); await preview.start();
        for (const path of ['/pricing?tab=2', '/', '/pricing?tab=2']) {
            await preview.receive({ type: 'ready', doc });
            await preview.receive({ type: 'history', path: `${path}${path.includes('?') ? '&' : '?'}ezil_pv=PRIVATE#/details?token=PRIVATE&tab=2` });
            const bootstrap = new URL(panel.messages.at(-1).url);
            expect(bootstrap.origin).toBe(host); expect(bootstrap.pathname).toBe('/preview-bootstrap');
            expect(bootstrap.searchParams.get('path')).toBe(path);
            expect(bootstrap.hash).toBe('#/details?tab=2');
            await preview.receive({ type: 'copy' }); await preview.receive({ type: 'external', url: 'https://evil.test', port: 9223 });
            expect(copied).toEqual([]);
            expect(external.at(-1)).toBe(bootstrap.href);
            await preview.receive({ type: 'ready', doc: { ...doc, path } });
            await preview.receive({ type: 'reload' });
            expect(new URL(panel.messages.at(-1).url).searchParams.get('path')).toBe(path);
        }
        expect(sent.filter(([id]) => id === '_ezil.previewMint')).toHaveLength(10);
        expect(sent.every(([, request]) => Object.keys(request).sort().join() === 'id,v')).toBe(true);
    });
}

test('legacy copy messages cannot write the clipboard, mint, launch or change preview state', async () => {
    const { panel, preview } = create();
    for (const initialized of [false, true]) {
        if (initialized) { await preview.start(); await preview.receive({ type: 'ready', doc }); }
        const html = panel.webview.html, messages = [...panel.messages], calls = [...sent];
        await preview.receive({ type: 'copy', url: 'https://evil.test/?token=PRIVATE', path: '/other', command: '_ezil.previewMint', port: 9223 });
        expect(copied).toEqual([]); expect(external).toEqual([]); expect(sent).toEqual(calls);
        expect(panel.webview.html).toBe(html); expect(panel.messages).toEqual(messages);
    }
});

test('external mint preserves the displayed document and pending selection', async () => {
    const { panel, preview } = create(); await preview.start();
    await preview.receive({ type: 'mode', mode: 'select' }); await preview.receive({ type: 'ready', doc });
    await preview.receive({ type: 'select', sel });
    const html = panel.webview.html, count = panel.messages.length;
    let finish!: (value: unknown) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    const pending = preview.receive({ type: 'external' });
    await preview.receive({ type: 'navigate', doc: { ...doc, path: '/later', mut: doc.mut + 1 } });
    await preview.receive({ type: 'external' }); // one mint/launch per gesture in flight
    finish(minted()); await pending;
    expect(new URL(external[0]!).searchParams.get('path')).toBe(doc.path);
    expect(external).toHaveLength(1); expect(panel.webview.html).toBe(html);
    expect(panel.messages.slice(count).every(message => !['load', 'invalidate'].includes(message.type))).toBe(true);
    expect(sent.filter(([id]) => id === '_ezil.chatAddContext').at(-1)![1].stale).toBe(true);
});

for (const kind of ['expired', 'origin changed', 'not bootstrap', 'hook failure']) test(`external refuses ${kind} without copying or exposing authorization`, async () => {
    const { panel, preview } = create(); await preview.start(); await preview.receive({ type: 'ready', doc });
    const html = panel.webview.html;
    reply = () => {
        if (kind === 'hook failure') throw new Error('PRIVATE');
        if (kind === 'expired') return { ...minted(), expiresAt: 1 };
        return { ...minted(), url: kind === 'origin changed' ? 'https://3002-other-app.ezil.org/preview-bootstrap?token=PRIVATE' : `${origin}/preview/` };
    };
    await preview.receive({ type: 'external' });
    expect(external).toHaveLength(0); expect(copied).toHaveLength(0);
    expect(panel.webview.html).toBe(html); expect(JSON.stringify(panel.messages)).not.toContain('PRIVATE');
});

test('later origin changes are refused without changing CSP or navigating the frame', async () => {
    const { panel, preview } = create(); await preview.start();
    const html = panel.webview.html;
    reply = () => ({ ...minted(), url: 'https://3002-other-app.ezil.org/preview-bootstrap?token=OTHER' });
    await preview.receive({ type: 'retry' });
    expect(panel.webview.html).toBe(html);
    expect(panel.messages.at(-1).text).toContain('origin changed');
    expect(panel.messages.every(message => !message.url)).toBe(true);
});

for (const kind of ['cold', 'hook missing', 'invalid', 'expired', 'timeout']) test(`${kind} shows Retry and can recover without exposing errors`, async () => {
    let timer: ReturnType<typeof spyOn> | undefined;
    if (kind === 'cold') reply = () => ({ error: 'app_preview_unavailable' });
    if (kind === 'hook missing') reply = () => { throw new Error('PRIVATE token=secret'); };
    if (kind === 'invalid') reply = () => ({ url: 'https://evil.test/?token=PRIVATE', expiresAt: Date.now() + 1000 });
    if (kind === 'expired') reply = () => ({ ...minted(), expiresAt: 1 });
    if (kind === 'timeout') {
        reply = () => new Promise(() => {});
        const schedule = globalThis.setTimeout;
        timer = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms: number) => schedule(fn, ms === MINT_TIMEOUT_MS ? 1 : ms)) as typeof setTimeout);
    }
    const { panel, preview } = create();
    try { await preview.start(); } finally { timer?.mockRestore(); }
    expect(panel.messages.at(-1).retry).toBe(true); expect(JSON.stringify(panel.messages)).not.toMatch(/PRIVATE|token=/);
    if (kind === 'timeout') expect(sent.filter(([id]) => id === '_ezil.previewMintCancel')).toEqual([['_ezil.previewMintCancel', sent[0]![1]]]);
    reply = minted; await preview.receive({ type: 'retry' }); expect(panel.webview.html).toContain(origin);
});

test('closing during a pending mint cancels panel work and never recreates it', async () => {
    let finish!: (value: unknown) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    const { panel, preview } = create();
    const pending = preview.start(); panel.dispose(); await pending;
    const html = panel.webview.html, count = panel.messages.length; finish(minted()); await Promise.resolve();
    expect(panel.webview.html).toBe(html); expect(panel.messages).toHaveLength(count);
    expect(sent.filter(([id]) => id === '_ezil.previewMintCancel')).toEqual([['_ezil.previewMintCancel', sent[0]![1]]]);
});

test('CSP allows exactly the minted origin, and controls are accessible', () => {
    const html = previewHtml('https://webview.test', 'AAAAAAAAAAAAAAAAAAAAAA', persistedState({}), origin, minted().url);
    const csp = html.match(/Content-Security-Policy" content="([^"]+)/)![1]!;
    expect(csp).toContain('default-src &#39;none&#39;'); expect(csp).toContain('frame-src ' + origin + ';');
    expect(csp).not.toMatch(/frame-src (?:https:;|\*)/); expect(csp).toContain('script-src &#39;nonce-AAAAAAAAAAAAAAAAAAAAAA&#39;');
    expect(html).toContain('role="status"'); expect(html).toContain('aria-pressed="false"'); expect(html).toContain('min-height:32px');
    expect(html).not.toContain('autofocus'); expect(html).not.toContain('allow-top-navigation');
    expect(html).not.toContain('id="copy"'); expect(html).not.toContain('Copy safe URL');
});

for (const throws of [false, true]) test(`external disposal cancels the same renderer ID even when cancel throws: ${throws}`, async () => {
    const { panel, preview } = create(); await preview.start();
    let finish!: (value: unknown) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    if (throws) {
        const execute = commands.executeCommand;
        commands.executeCommand = (...args: any[]) => {
            if (args[0] === '_ezil.previewMintCancel') { sent.push(args); throw new Error('PRIVATE'); }
            return execute(...args);
        };
    }
    const pending = preview.receive({ type: 'external' }); panel.dispose(); await pending;
    finish(minted()); await Promise.resolve();
    expect(external).toHaveLength(0);
    expect(sent.filter(([id]) => id === '_ezil.previewMintCancel')).toEqual([['_ezil.previewMintCancel', sent[1]![1]]]);
});
