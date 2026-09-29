import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import type { FileDiff } from '../opencode/adapter';
import { applyUnifiedPatch } from './patch';

const SCHEME = 'ezil-chat-before';

/**
 * Shows OpenCode's file edits in the native diff editor. The "before" side is
 * recovered by reverse-applying the patch OpenCode reported (falling back to
 * `git show HEAD:file`), and a notification offers Keep / Revert.
 */
export class DiffReviewer implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private readonly before = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    private readonly registration: vscode.Disposable;

    constructor(private readonly directory: string) {
        this.registration = vscode.workspace.registerTextDocumentContentProvider(SCHEME, this);
    }

    readonly onDidChange = this.changed.event;

    provideTextDocumentContent(uri: vscode.Uri): string { return this.before.get(uri.toString()) ?? ''; }

    dispose(): void { this.registration.dispose(); this.changed.dispose(); }

    resolve(file: string): string { return path.isAbsolute(file) ? file : path.join(this.directory, file); }

    private async currentContent(absolute: string): Promise<string | undefined> {
        try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(absolute))).toString('utf8'); } catch { return undefined; }
    }

    async beforeContent(absolute: string, diff: FileDiff): Promise<string> {
        if (diff.status === 'added') return '';
        const after = await this.currentContent(absolute);
        if (after !== undefined) {
            const reversed = applyUnifiedPatch(after, diff.patch, { reverse: true });
            if (reversed !== undefined) return reversed;
        }
        return (await gitShowHead(this.directory, absolute)) ?? '';
    }

    /** Open the before/after diff for one edit and offer to keep or revert it. */
    async review(diff: FileDiff, options: { offerRevert?: boolean } = {}): Promise<void> {
        const absolute = this.resolve(diff.file);
        const before = await this.beforeContent(absolute, diff);
        const beforeUri = vscode.Uri.from({ scheme: SCHEME, path: absolute, query: String(Date.now()) });
        this.before.set(beforeUri.toString(), before);
        this.changed.fire(beforeUri);
        const title = `${path.basename(absolute)} (EZiL: before ↔ after)`;
        await vscode.commands.executeCommand('vscode.diff', beforeUri, vscode.Uri.file(absolute), title, { preview: true });
        if (options.offerRevert === false) return;
        const summary = `EZiL edited ${diff.file} (+${diff.additions} −${diff.deletions})`;
        void vscode.window.showInformationMessage(summary, 'Keep', 'Revert').then(async choice => {
            if (choice !== 'Revert') return;
            if (diff.status === 'added') {
                await vscode.workspace.fs.delete(vscode.Uri.file(absolute), { useTrash: true });
            } else {
                await vscode.workspace.fs.writeFile(vscode.Uri.file(absolute), Buffer.from(before, 'utf8'));
            }
            void vscode.window.showInformationMessage(`Reverted ${diff.file}`);
        });
    }
}

export function gitShowHead(cwd: string, absolute: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['show', `HEAD:${path.relative(cwd, absolute).split(path.sep).join('/')}`], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? undefined : stdout);
        });
    });
}
