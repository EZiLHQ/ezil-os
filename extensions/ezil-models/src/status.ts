import * as vscode from 'vscode';
import type { ResolvedProvider } from './config';
import { readAIStatus, statusView, type AIStatus } from './status-data';

/** Gateway status is refreshed at startup, on config changes, after usage, and once a minute. */
export class EZiLAIStatus implements vscode.Disposable {
    private readonly item: vscode.StatusBarItem;
    private readonly timer: ReturnType<typeof setInterval>;
    private state?: AIStatus;
    private request?: AbortController;
    private disposed = false;

    constructor(private readonly provider: () => ResolvedProvider | undefined, private readonly doFetch: typeof fetch = fetch, private readonly ui: typeof vscode = vscode) {
        this.item = ui.window.createStatusBarItem('ezil-models.aiStatus', ui.StatusBarAlignment.Right, 101);
        this.item.name = 'EZiL AI';
        this.item.command = 'ezil-models.showStatus';
        this.render();
        this.item.show();
        this.timer = setInterval(() => { void this.refresh(); }, 60_000);
        this.timer.unref?.();
    }

    private render(): void {
        const view = statusView(this.state);
        this.item.text = view.text;
        this.item.tooltip = view.lines.join('\n');
        this.item.accessibilityInformation = { label: view.lines.join('. ') };
    }

    async refresh(): Promise<void> {
        if (this.disposed) return;
        this.request?.abort();
        const request = this.request = new AbortController();
        this.state = undefined;
        this.render();
        const state = await readAIStatus(this.provider(), this.doFetch, request.signal);
        if (this.disposed || this.request !== request) return;
        this.state = state;
        this.render();
    }

    /** A keyboard-accessible click popover; hovering also exposes the same plain-text snapshot. */
    async show(): Promise<void> {
        await this.refresh();
        if (this.disposed) return;
        const view = statusView(this.state);
        await this.ui.window.showQuickPick(view.lines.slice(1).map(label => ({ label })), { title: 'EZiL AI', placeHolder: 'Credits and recent Gateway usage' });
    }

    dispose(): void {
        this.disposed = true;
        clearInterval(this.timer);
        this.request?.abort();
        this.item.dispose();
    }
}
