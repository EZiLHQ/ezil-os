import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { record, sameDoc, validToken, validateAgentResult, validateDoc, validateMintReply, type AgentAction, type AgentResult, type PreviewDoc } from './contract';
import { SelectionContext } from './context';
import { previewHtml } from './html';
import { persistedState, safePath, viewport, type PreviewState } from './state';

export const MINT_TIMEOUT_MS = 240_000;
const token = () => randomBytes(16).toString('base64url');
const AGENT_TIMEOUT_MS = 5_000;
type AgentOutcome = AgentResult | { error: string };

export class PreviewPanel implements vscode.Disposable {
    private state: PreviewState;
    private origin = '';
    private ready = false;
    private minting = false;
    private disposed = false;
    private status = { type: 'status', text: 'Starting preview…', retry: false };
    private readonly contexts: SelectionContext;
    private readonly subscriptions: vscode.Disposable[] = [];
    private cancelMint: (() => void) | undefined;
    private agentDoc: PreviewDoc | undefined;
    private shared = false;
    private readonly agentRefs = new Set<string>();
    private agentPending: { id: string; action: AgentAction['action']; doc: PreviewDoc; finish(result: AgentOutcome, cancel?: boolean): void } | undefined;

    constructor(readonly panel: vscode.WebviewPanel, state?: unknown,
        private readonly canShare: () => boolean = () => false, private readonly sharingChanged: (shared: boolean) => void = () => {}) {
        this.state = persistedState(state);
        panel.webview.options = { enableScripts: true, localResourceRoots: [] };
        this.contexts = new SelectionContext(token, async attachment =>
            (await vscode.commands.executeCommand('_ezil.chatAddContext', attachment)) === true,
        text => this.showStatus(text));
        this.subscriptions.push(panel.webview.onDidReceiveMessage(message => { void this.receive(message); }), panel.onDidDispose(() => this.dispose()));
        if (panel.onDidChangeViewState) this.subscriptions.push(panel.onDidChangeViewState(({ webviewPanel }) => {
            if (!webviewPanel.visible) this.revokeAgent();
        }));
        this.html();
    }
    private html(mintedUrl = ''): void {
        this.panel.webview.html = previewHtml(this.panel.webview.cspSource, token(), this.state, this.origin, mintedUrl, this.canShare());
    }
    private post(message: unknown): void {
        if (!this.disposed) void Promise.resolve(this.panel.webview.postMessage(message)).catch(() => {});
    }
    private showStatus(text: string, retry = false): void { this.status = { type: 'status', text, retry }; this.post(this.status); }
    private invalidate(): void { this.ready = false; this.agentDoc = undefined; this.revokeAgent(); this.contexts.reset(); this.post({ type: 'invalidate' }); }
    refreshAgentAvailability(): void { this.post({ type: 'agent-available', available: this.canShare() }); }
    private clearAgentRequests(): void {
        this.agentRefs.clear();
        this.agentPending?.finish({ error: 'stale' }, true);
    }
    private revokeAgent(): void {
        this.clearAgentRequests();
        if (!this.shared) return;
        this.shared = false;
        this.sharingChanged(false);
        this.post({ type: 'agent-share', enabled: false });
    }
    private receiveShare(message: Record<string, unknown>): void {
        if (message.enabled === false) { this.revokeAgent(); return; }
        if (message.enabled !== true || !validToken(message.id)) return;
        if (Object.keys(message).length !== 4 || !this.ready || !this.origin || this.panel.visible === false || !this.canShare()
            || !validateDoc(message.doc) || !sameDoc(this.agentDoc, message.doc)) {
            this.revokeAgent();
            this.post({ type: 'agent-share', enabled: false });
            return;
        }
        this.shared = true;
        this.sharingChanged(true);
        this.post({ type: 'agent-share', enabled: true, id: message.id, doc: message.doc });
    }
    private receiveAgentResult(message: Record<string, unknown>): void {
        const pending = this.agentPending;
        if (!this.shared || !pending || Object.keys(message).length !== 4 || message.id !== pending.id || !validateDoc(message.doc)
            || !sameDoc(this.agentDoc, message.doc) || !sameDoc(pending.doc, message.doc) || !validateAgentResult(message.result)) return;
        const result = message.result;
        if ('controls' in result) {
            if (pending.action !== 'read') return;
            for (const item of result.controls) this.agentRefs.add(item.ref);
        } else if ('clicked' in result && pending.action !== 'click') return;
        pending.finish(result);
    }
    runAgent(action: AgentAction, cancellationToken: vscode.CancellationToken): Promise<AgentOutcome> {
        const doc = this.agentDoc;
        if (this.disposed || !this.shared || !this.ready || !doc || this.panel.visible === false || !this.canShare()) {
            return Promise.resolve({ error: 'Share the current App Preview with Agent first.' });
        }
        if (cancellationToken.isCancellationRequested) return Promise.resolve({ error: 'Cancelled.' });
        if (this.agentPending) return Promise.resolve({ error: 'Another preview request is pending.' });
        if (action.action === 'click' && !this.agentRefs.has(action.ref)) {
            return Promise.resolve({ error: 'Read the current App Preview to get fresh control references.' });
        }
        this.agentRefs.clear();
        const id = token();
        return new Promise(resolve => {
            let cancellation: vscode.Disposable | undefined;
            const finish = (result: AgentOutcome, cancel = false) => {
                if (this.agentPending?.id !== id) return;
                this.agentPending = undefined;
                clearTimeout(timeout);
                cancellation?.dispose();
                if (cancel) this.post({ type: 'agent-cancel', id });
                resolve(result);
            };
            const timeout = setTimeout(() => finish({ error: 'Preview request timed out.' }, true), AGENT_TIMEOUT_MS);
            this.agentPending = { id, doc, action: action.action, finish };
            cancellation = cancellationToken.onCancellationRequested(() => finish({ error: 'Cancelled.' }, true));
            if (cancellationToken.isCancellationRequested) finish({ error: 'Cancelled.' }, true);
            else if (this.agentPending?.id === id) this.post({ type: 'agent', id, doc, ...action });
        });
    }
    async start(): Promise<void> { await this.mint(); }
    private async mint(target: 'frame' | 'external' = 'frame'): Promise<void> {
        if (this.minting || this.disposed) return;
        this.minting = true;
        const path = this.state.path;
        if (target === 'frame') this.invalidate();
        this.showStatus(target === 'frame' ? 'Starting preview…' : 'Authorizing browser preview…');
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const id = token();
        // Return the renderer's pending slot on disposal/timeout, including on older hosts lacking cancel.
        const release = () => {
            try { void Promise.resolve(vscode.commands.executeCommand('_ezil.previewMintCancel', { v: 1, id })).catch(() => {}); }
            catch { /* Optional renderer hook; never strand the local cancellation. */ }
        };
        try {
            const expiry = new Promise<never>((_, reject) => {
                timeout = setTimeout(() => { release(); reject(new Error('timeout')); }, MINT_TIMEOUT_MS);
                this.cancelMint = () => { release(); reject(new Error('disposed')); };
            });
            const reply: unknown = await Promise.race([vscode.commands.executeCommand('_ezil.previewMint', { v: 1, id }), expiry]);
            clearTimeout(timeout);
            this.cancelMint = undefined;
            if (this.disposed) return;
            if (!validateMintReply(reply)) { this.showStatus('Invalid preview mint reply.', true); return; }
            if ('error' in reply) { this.showStatus(reply.error, true); return; }
            if (reply.expiresAt <= Date.now()) { this.showStatus('Preview authorization expired.', true); return; }
            const origin = new URL(reply.url).origin;
            if (this.origin && origin !== this.origin) {
                this.showStatus('Preview origin changed. Close and reopen the preview to use it.', true);
                return;
            }
            // Only the fixed mint hook supplies authorization, never a frame message or persisted URL.
            const minted = new URL(reply.url);
            if (minted.pathname !== '/preview-bootstrap' || !minted.searchParams.get('token')) {
                this.showStatus('Preview bootstrap unavailable.', true); return;
            }
            const url = new URL('/preview-bootstrap', origin);
            url.searchParams.set('token', minted.searchParams.get('token')!);
            // Both bridges omit fragments from Location; browsers inherit the bootstrap fragment on redirect.
            const hash = path.indexOf('#');
            url.searchParams.set('path', hash < 0 ? path : path.slice(0, hash));
            url.hash = hash < 0 ? '' : path.slice(hash);
            if (target === 'external') {
                const opened = await vscode.env.openExternal(vscode.Uri.parse(url.href));
                if (!this.disposed) this.showStatus(opened ? 'Opened preview in browser.' : 'Could not open the preview in a browser.');
                return;
            }
            const first = !this.origin;
            this.origin = origin;
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
            case 'loading': this.ready = false; this.agentDoc = undefined; this.revokeAgent(); this.contexts.reset(); return;
            case 'viewport': this.state.viewport = viewport(message.viewport); return;
            case 'agent-share': this.receiveShare(message); return;
            case 'agent-result': this.receiveAgentResult(message); return;
            case 'select': await this.contexts.select(message.sel); return;
            case 'ready': case 'changed': case 'navigate':
                if (!validateDoc(message.doc) || (message.type !== 'ready' && !this.ready)) return;
                if (message.type === 'navigate' || (this.agentDoc && (message.doc.gen !== this.agentDoc.gen || message.doc.path !== this.agentDoc.path))) {
                    this.revokeAgent();
                } else if (!sameDoc(this.agentDoc, message.doc)) this.clearAgentRequests();
                this.agentDoc = message.doc;
                this.state.path = message.doc.path;
                if (message.type === 'ready') { this.ready = true; this.showStatus('Preview ready.'); }
                await this.contexts.observe(message.doc);
                return;
            case 'state':
                if (typeof message.state !== 'string' || !/^[a-z_]{1,40}$/.test(message.state)) return;
                this.ready = false; this.agentDoc = undefined; this.revokeAgent(); this.contexts.reset(); this.showStatus(message.state, true); return;
            case 'retry': case 'reload':
                await this.mint();
                return;
            case 'history':
                if (!this.origin || this.minting) return;
                this.state.path = safePath(message.path);
                await this.mint();
                return;
            case 'external':
                if (this.origin) await this.mint('external');
                return;
        }
    }
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.revokeAgent();
        this.cancelMint?.();
        this.contexts.dispose();
        for (const subscription of this.subscriptions) subscription.dispose();
    }
}

export function registerPreview(context: vscode.ExtensionContext): void {
    let current: PreviewPanel | undefined;
    let opening: Promise<void> | undefined;
    let disposed = false;
    let toolsAvailable = false;
    const canShare = () => toolsAvailable && vscode.workspace?.isTrusted === true;
    const updateContext = (shared: boolean) => {
        void Promise.resolve(vscode.commands.executeCommand('setContext', 'ezil.previewShared', shared)).catch(() => {});
    };
    // Own panel cleanup before registering anything that can open or restore a panel.
    const subscriptions: vscode.Disposable[] = [{ dispose: () => {
        const preview = current;
        if (preview) {
            try { preview.dispose(); } finally { preview.panel.dispose(); }
        }
        current = undefined;
    } }];
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        for (const subscription of subscriptions.splice(0)) {
            try { subscription.dispose(); } catch { /* Continue releasing the other optional preview resources. */ }
        }
    };
    const restoreLayout = async () => {
        // VS Code exposes no public extension API for reading the auxiliaryBarMaximized context key.
        try { await vscode.commands.executeCommand('workbench.action.restoreAuxiliaryBar'); } catch { /* Older hosts may lack it. */ }
    };
    const adopt = (panel: vscode.WebviewPanel, state?: unknown) => {
        if (disposed) { panel.dispose(); return; }
        if (current) { current.dispose(); current.panel.dispose(); }
        const preview = new PreviewPanel(panel, state, canShare, shared => {
            if (current === preview) updateContext(shared);
        });
        current = preview;
        subscriptions.push(panel.onDidDispose(() => { if (current === preview) current = undefined; }));
        return preview;
    };
    try {
        subscriptions.push(vscode.commands.registerCommand('ezil.preview.open', () => {
            if (disposed) return;
            if (opening) return opening;
            opening = (async () => {
                await restoreLayout();
                if (disposed) return;
                if (current) { current.panel.reveal(vscode.ViewColumn.Active, true); return; }
                const panel = vscode.window.createWebviewPanel('ezil.preview', 'App Preview', { viewColumn: vscode.ViewColumn.Active, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
                await adopt(panel)?.start();
            })().finally(() => { opening = undefined; });
            return opening;
        }));
        subscriptions.push(vscode.window.registerWebviewPanelSerializer('ezil.preview', {
            async deserializeWebviewPanel(panel, state) {
                // Take ownership before awaiting layout, including restores during registration.
                const preview = adopt(panel, state);
                if (!preview) return;
                await restoreLayout();
                await preview.start();
            },
        }));
        const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
        subscriptions.push(status);
        status.text = '$(browser) App Preview';
        status.tooltip = 'EZiL: Open App Preview';
        status.command = 'ezil.preview.open';
        status.show();
        if (typeof vscode.lm?.registerTool === 'function') {
            const register = (name: string, parse: (input: unknown) => AgentAction | undefined) => vscode.lm.registerTool(name, {
                async invoke(options, cancellationToken) {
                    const action = parse(options.input);
                    const preview = current;
                    const result = !action ? { error: 'Invalid preview tool input.' } : preview
                        ? await preview.runAgent(action, cancellationToken) : { error: 'Open App Preview and share it with Agent first.' };
                    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(JSON.stringify(result))]);
                },
            });
            let readTool: vscode.Disposable | undefined;
            try {
                readTool = register('ezil_preview_read', input => record(input) && Object.keys(input).length === 0 ? { action: 'read' } : undefined);
                const clickTool = register('ezil_preview_click', input => record(input) && Object.keys(input).length === 1 && validToken(input.ref)
                    ? { action: 'click', ref: input.ref } : undefined);
                subscriptions.push(readTool, clickTool);
                toolsAvailable = true;
                updateContext(false);
                current?.refreshAgentAvailability();
            } catch { readTool?.dispose(); }
            if (toolsAvailable) subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => current?.refreshAgentAvailability()));
        }
        // Publish only the completed registration; the bag also owns later panel listeners.
        context.subscriptions.push({ dispose });
    } catch (error) {
        dispose();
        throw error;
    }
}
