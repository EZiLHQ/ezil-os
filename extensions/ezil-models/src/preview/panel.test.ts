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
    messages: any[] = [];
    listeners: ((value: unknown) => unknown)[] = [];
    closes: (() => void)[] = [];
    reveals: unknown[][] = [];
    webview = {
        html: '', cspSource: 'https://webview.test', options: {},
        asWebviewUri: (uri: URL) => uri,
        postMessage: async (value: unknown) => { this.messages.push(value); return true; },
        onDidReceiveMessage: (listener: (value: unknown) => unknown) => { this.listeners.push(listener); return { dispose() {} }; },
    };
    onDidDispose = (listener: () => void) => { this.closes.push(listener); return { dispose() {} }; };
    reveal = (...args: unknown[]) => { this.reveals.push(args); };
    dispose(): void { for (const listener of this.closes) listener(); }
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
        registerCommand: (id: string, handler: () => Promise<void>) => { registered.set(id, handler); return { dispose() {} }; },
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
    expect(copied).toEqual([`${origin}/preview/next?tab=2`]); expect(external).toEqual(copied);
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

test('a working frame reloads without minting; expiry only triggers mint when navigation is requested', async () => {
    const { panel, preview } = create(); await preview.start(); await preview.receive({ type: 'ready', doc });
    await preview.receive({ type: 'reload' });
    expect(sent).toHaveLength(1); expect(panel.messages.at(-1)).toEqual({ type: 'load', url: `${origin}/preview/pricing` });
    await preview.receive({ type: 'ready', doc });
    const now = spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    try {
        expect(sent).toHaveLength(1);
        await preview.receive({ type: 'reload' });
        expect(sent).toHaveLength(2); expect(panel.messages.at(-1).url).toContain('/preview-bootstrap?token=PRIVATE');
    } finally { now.mockRestore(); }
});

for (const [host, prefix] of [[origin, '/preview'], ['https://aws-3002-guac-u1-c1-aws.ezil.org', '']]) {
    test(`reload, back/forward, copy and external use credential-free transport URLs on ${host}`, async () => {
        reply = () => ({ ...minted(), url: `${host}/preview-bootstrap?token=PRIVATE` });
        const { panel, preview } = create(); await preview.start();
        for (const path of ['/pricing?tab=2', '/', '/pricing?tab=2']) {
            await preview.receive({ type: 'ready', doc });
            await preview.receive({ type: 'history', path: `${path}${path.includes('?') ? '&' : '?'}ezil_pv=PRIVATE#/details?token=PRIVATE&tab=2` });
            const safe = `${host}${prefix}${path}#/details?tab=2`;
            expect(panel.messages.at(-1)).toEqual({ type: 'load', url: safe });
            await preview.receive({ type: 'copy' }); await preview.receive({ type: 'external' });
            expect(copied.at(-1)).toBe(safe); expect(external.at(-1)).toBe(safe);
            await preview.receive({ type: 'ready', doc: { ...doc, path } });
            await preview.receive({ type: 'reload' });
            expect(panel.messages.at(-1)).toEqual({ type: 'load', url: `${host}${prefix}${path}` });
        }
        expect(sent.filter(([id]) => id === '_ezil.previewMint')).toHaveLength(1);
    });
}

test('closing the panel during a pending mint releases that exact renderer request', async () => {
    reply = () => new Promise(() => {});
    const { preview } = create(); const started = preview.start();
    await Promise.resolve();
    preview.dispose(); await started;
    const [mint] = sent.filter(([id]) => id === '_ezil.previewMint');
    expect(sent.filter(([id]) => id === '_ezil.previewMintCancel')).toEqual([['_ezil.previewMintCancel', { v: 1, id: mint![1].id }]]);
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
    reply = minted; await preview.receive({ type: 'retry' }); expect(panel.webview.html).toContain(origin);
});

test('closing during a pending mint cancels panel work and never recreates it', async () => {
    let finish!: (value: unknown) => void;
    reply = () => new Promise(resolve => { finish = resolve; });
    const { panel, preview } = create();
    const pending = preview.start(); panel.dispose(); await pending;
    const html = panel.webview.html; finish(minted()); await Promise.resolve();
    expect(panel.webview.html).toBe(html);
});

test('CSP allows exactly the minted origin, and controls are accessible', () => {
    const html = previewHtml('https://webview.test', 'AAAAAAAAAAAAAAAAAAAAAA', persistedState({}), origin, minted().url);
    const csp = html.match(/Content-Security-Policy" content="([^"]+)/)![1]!;
    expect(csp).toContain('default-src &#39;none&#39;'); expect(csp).toContain('frame-src ' + origin + ';');
    expect(csp).not.toMatch(/frame-src (?:https:;|\*)/); expect(csp).toContain('script-src &#39;nonce-AAAAAAAAAAAAAAAAAAAAAA&#39;');
    expect(html).toContain('role="status"'); expect(html).toContain('aria-pressed="false"'); expect(html).toContain('min-height:32px');
    expect(html).not.toContain('autofocus'); expect(html).not.toContain('allow-top-navigation');
});
