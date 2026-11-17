import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { record, validateDoc, validateMintReply } from './contract';
import { SelectionContext } from './context';
import { previewHtml } from './html';
import { persistedState, safePath, transportUrl, viewport, type PreviewState } from './state';

export const MINT_TIMEOUT_MS = 240_000;
const token = () => randomBytes(16).toString('base64url');

export class PreviewPanel implements vscode.Disposable {
    private state: PreviewState;
    private origin = '';
    private expiresAt = 0;
    private ready = false;
    private minting = false;
    private disposed = false;
    private status = { type: 'status', text: 'Starting preview…', retry: false };
    private readonly contexts: SelectionContext;
    private readonly subscriptions: vscode.Disposable[] = [];
    private cancelMint: (() => void) | undefined;

    constructor(readonly panel: vscode.WebviewPanel, state?: unknown) {
        this.state = persistedState(state);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        this.contexts = new SelectionContext(token, async attachment =>
            (await vscode.commands.executeCommand('_ezil.chatAddContext', attachment)) === true,
        text => this.showStatus(text));
        this.subscriptions.push(panel.webview.onDidReceiveMessage(message => { void this.receive(message); }), panel.onDidDispose(() => this.dispose()));
        this.html();
    }
    private html(mintedUrl = ''): void {
        this.panel.webview.html = previewHtml(this.panel.webview.cspSource, token(), this.state, this.origin, mintedUrl);
    }
    private post(message: unknown): void {
        if (!this.disposed) void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => {});
    }
    private showStatus(text: string, retry = false): void { this.status = { type: 'status', text, retry }; this.post(this.status); }
    private invalidate(): void { this.ready = false; this.contexts.reset(); this.post({ type: 'invalidate' }); }
    async start(): Promise<void> { await this.mint(); }
    private async mint(): Promise<void> {
        if (this.minting || this.disposed) return;
        this.minting = true;
        this.invalidate();
        this.showStatus('Starting preview…');
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
            const expiry = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => reject(new Error('timeout')), MINT_TIMEOUT_MS);
                this.cancelMint = () => reject(new Error('disposed'));
            });
            const reply: unknown = await Promise.race([vscode.commands.executeCommand('_ezil.previewMint', { v: 1, id: token() }), expiry]);
            if (this.disposed) return;
            if (!validateMintReply(reply)) { this.showStatus('Invalid preview mint reply.', true); return; }
            if ('error' in reply) { this.showStatus(reply.error, true); return; }
            if (reply.expiresAt <= Date.now()) { this.showStatus('Preview authorization expired.', true); return; }
            const origin = new URL(reply.url).origin;
            if (this.origin && origin !== this.origin) {
                this.showStatus('Preview origin changed. Close and reopen the preview to use it.', true);
                return;
            }
            const first = !this.origin;
            this.origin = origin;
            this.expiresAt = reply.expiresAt;
            const url = new URL(reply.url);
            // Bootstrap authenticates the frame, then redirects to the restored, sanitized app path.
            if (url.pathname === '/preview-bootstrap') url.searchParams.set('path', this.state.path);
            this.status = { type: 'status', text: 'Loading preview…', retry: false };
            if (first) this.html(url.href);
            else this.post({ type: 'load', url: url.href });
        } catch (error) {
            if (!this.disposed) this.showStatus(error instanceof Error && error.message === 'timeout' ? 'Preview request timed out.' : 'Preview hook unavailable.', true);
        } finally {
            clearTimeout(timeout);
            this.cancelMint = undefined;
            this.minting = false;
        }
    }
    /** Only fixed UI actions and the five validated inspector message types have effects. */
    async receive(message: unknown): Promise<void> {
        if (this.disposed || !record(message)) return;
        switch (message.type) {
            case 'boot': this.post(this.status); return;
            case 'mode': this.contexts.selecting = message.mode === 'select'; return;
            case 'loading': this.ready = false; this.contexts.reset(); return;
            case 'viewport': this.state.viewport = viewport(message.viewport); return;
            case 'select': await this.contexts.select(message.sel); return;
            case 'ready': case 'changed': case 'navigate':
                if (!validateDoc(message.doc) || (message.type !== 'ready' && !this.ready)) return;
                this.state.path = message.doc.path;
                if (message.type === 'ready') { this.ready = true; this.showStatus('Preview ready.'); }
                await this.contexts.observe(message.doc);
                return;
            case 'state':
                if (typeof message.state !== 'string' || !/^[a-z_]{1,40}$/.test(message.state)) return;
                this.ready = false; this.contexts.reset(); this.showStatus(message.state, true); return;
            case 'retry': case 'reload':
                if (this.minting) return;
                if (!this.ready || this.expiresAt <= Date.now() + 1000) await this.mint();
                else { this.invalidate(); this.showStatus('Loading preview…'); this.post({ type: 'load', url: transportUrl(this.origin, this.state.path) }); }
                return;
            case 'history':
                if (!this.origin || this.minting) return;
                this.state.path = safePath(message.path);
                if (this.expiresAt <= Date.now() + 1000 || !this.ready) await this.mint();
                else { this.invalidate(); this.post({ type: 'load', url: transportUrl(this.origin, this.state.path) }); }
                return;
            case 'copy': case 'external':
                if (!this.origin) return;
                try {
                    const url = transportUrl(this.origin, this.state.path);
                    if (message.type === 'copy') { await vscode.env.clipboard.writeText(url); this.showStatus('Safe preview URL copied.'); }
                    else this.showStatus(await vscode.env.openExternal(vscode.Uri.parse(url)) ? 'Opened preview in browser.' : 'Could not open the preview in a browser.');
                } catch { this.showStatus('Could not open or copy the safe preview URL.'); }
                return;
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelMint?.();
        this.contexts.dispose();
        for (const subscription of this.subscriptions) subscription.dispose();
    }
}

export function registerPreview(context: vscode.ExtensionContext): void {
    let current: PreviewPanel | undefined;
    let opening: Promise<void> | undefined;
    const restoreLayout = async () => {
        // VS Code exposes no public extension API for reading the auxiliaryBarMaximized context key.
        try { await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar'); } catch { /* Older hosts may lack it. */ }
    };
    const adopt = (panel: vscode.WebviewPanel, state?: unknown) => {
        const preview = new PreviewPanel(panel, state);
        current = preview;
        panel.onDidDispose(() => { if (current === preview) current = undefined; }, undefined, context.subscriptions);
        return preview;
    };
    context.subscriptions.push(vscode.commands.registerCommand('ezil.preview.open', () => {
        if (opening) return opening;
        opening = (async () => {
            await restoreLayout();
            if (current) { current.panel.reveal(vscode.ViewColumn.Active, true); return; }
            const panel = vscode.window.createWebviewPanel('ezil.preview', 'App Preview', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
            await adopt(panel).start();
        })().finally(() => { opening = undefined; });
        return opening;
    }));
    context.subscriptions.push(vscode.window.registerWebviewPanelSerializer('ezil.preview', {
        async deserializeWebviewPanel(panel, state) {
            await restoreLayout();
            await adopt(panel, state).start();
        },
    }));
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
    status.text = '$(browser) App Preview';
    status.tooltip = 'EZiL: Open App Preview';
    status.command = 'ezil.preview.open';
    status.show();
    context.subscriptions.push(status, { dispose: () => current?.dispose() });
}
