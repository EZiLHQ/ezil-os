// The header notice for a compacted request: a transient progress bar on the chat view while the turn runs, and an icon
// in the chat view's title bar (accessible name: its command title in package.json) that stays a few seconds after the
// turn and explains what was compacted. Nothing is added to the chat itself: a note there would be saved as part of the
// conversation and sent back to the model on every later turn.
import * as vscode from 'vscode';
import type { CompactionInfo } from './compact';

export const CHAT_VIEW = 'workbench.panel.chat.view.copilot';
export const COMPACTING_CONTEXT = 'ezilModels.compacting';
export const NOTICE_LINGER_MS = 10_000;

const bytes = (value: number) => value.toLocaleString('en-US');

export function compactionText(model: string, info: CompactionInfo): string {
    const what = [info.folded ? `${info.folded} earlier messages summarized` : '', info.shortened ? `${info.shortened} long outputs or replies shortened` : '']
        .filter(Boolean).join(', ');
    const why = info.cause === 'remote' ? ' after EZiL AI refused its size' : '';
    return `EZiL compacted this conversation to fit ${model}${why}${what ? `: ${what}` : ''} (${bytes(info.toBytes)} bytes sent, `
        + `${bytes(info.fromBytes)} before, limit ${bytes(info.limitBytes)}). The full conversation is still saved in this chat, and a model with a larger input limit gets more of it.`;
}

export class CompactionNotice implements vscode.Disposable {
    private last: string | undefined;
    private generation = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;

    constructor(private readonly log: (line: string) => void, private readonly lingerMs = NOTICE_LINGER_MS) {}

    show(model: string, info: CompactionInfo, finished: Promise<void>): void {
        this.last = compactionText(model, info);
        const generation = ++this.generation;
        clearTimeout(this.timer);
        this.log(`[compact] ${model}: ${JSON.stringify(info)}`);
        void Promise.resolve(vscode.commands.executeCommand('setContext', COMPACTING_CONTEXT, true)).catch(() => {});
        // A view that is not open (or not registered) refuses view progress: the title-bar icon still shows.
        void Promise.resolve(vscode.window.withProgress({ location: { viewId: CHAT_VIEW }, title: `Compacting the conversation for ${model}` }, () => finished)).catch(() => {});
        void finished.then(() => {
            if (generation !== this.generation) return;
            this.timer = setTimeout(() => {
                if (generation === this.generation) void Promise.resolve(vscode.commands.executeCommand('setContext', COMPACTING_CONTEXT, false)).catch(() => {});
            }, this.lingerMs);
        });
    }

    /** The title-bar icon's command: the window's latest compaction (one at a time; the icon is per window too). */
    async explain(): Promise<void> {
        const choice = await vscode.window.showInformationMessage(this.last ?? 'EZiL has not compacted a conversation in this window.', 'Show AI Status');
        if (choice === 'Show AI Status') await vscode.commands.executeCommand('ezil-models.showStatus');
    }

    dispose(): void { clearTimeout(this.timer); }
}
