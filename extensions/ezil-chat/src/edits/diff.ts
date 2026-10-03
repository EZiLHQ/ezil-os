import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { errorMessage } from '../errors';
import type { FileDiff } from '../opencode/adapter';
import { confinePath } from '../paths';
import { applyUnifiedPatch } from './patch';
import { planRevert } from './revert';

const SCHEME = 'ezil-chat-before';

/**
 * Shows OpenCode's file edits in the native diff editor. The "before" side is
 * recovered by reverse-applying the patch OpenCode reported; when that no longer
 * applies, `git show HEAD:file` is shown as an approximation (display only). A
 * notification offers Keep / Revert; Revert recomputes from the file as it is at
 * click time and refuses when the edit cannot be undone on its own.
 */
export class DiffReviewer implements vscode.Disposable, vscode.TextDocumentContentProvider {
    private readonly before = new Map<string, string>();
    private readonly changed = new vscode.EventEmitter<vscode.Uri>();
    private readonly disposables: vscode.Disposable[] = [];
    /** Reviews open one at a time; a newer edit of the same file supersedes one still waiting. */
    private queue: Promise<void> = Promise.resolve();
    private readonly waiting = new Map<string, FileDiff>();

    constructor(private readonly directory: string, private readonly log: (line: string) => void = () => {}) {
        this.disposables.push(
            vscode.workspace.registerTextDocumentContentProvider(SCHEME, this),
            // The before-side text is only needed while its diff editor is open.
            vscode.workspace.onDidCloseTextDocument(document => { if (document.uri.scheme === SCHEME) this.before.delete(document.uri.toString()); }),
        );
    }

    readonly onDidChange = this.changed.event;

    provideTextDocumentContent(uri: vscode.Uri): string { return this.before.get(uri.toString()) ?? ''; }

    dispose(): void { for (const item of this.disposables) item.dispose(); this.changed.dispose(); this.before.clear(); }

    /** Absolute path of `file`, or an error when it is not inside the workspace folder. */
    resolve(file: string): string {
        const absolute = confinePath(this.directory, file);
        if (!absolute) throw new Error(`refusing to touch ${file}: outside the workspace folder`);
        return absolute;
    }

    private async currentContent(absolute: string): Promise<string | undefined> {
        try { return Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.file(absolute))).toString('utf8'); } catch { return undefined; }
    }

    /**
     * Open the before/after diff for one edit and (unless `offerRevert` is false) offer to keep or revert it.
     * Automatic reviews are queued so a burst of edits does not open a wall of editors at once.
     */
    async review(diff: FileDiff, options: { offerRevert?: boolean } = {}): Promise<void> {
        const absolute = this.resolve(diff.file);
        if (options.offerRevert === false) return this.open(absolute, diff, options); // explicit "Open diff" click
        this.waiting.set(absolute, diff);
        this.queue = this.queue.then(async () => {
            if (this.waiting.get(absolute) !== diff) return; // superseded by a later edit of the same file
            this.waiting.delete(absolute);
            await this.open(absolute, diff, options);
        }).catch(error => { this.log(`diff review failed for ${diff.file}: ${errorMessage(error)}`); });
        return this.queue;
    }

    private async open(absolute: string, diff: FileDiff, options: { offerRevert?: boolean }): Promise<void> {
        const current = await this.currentContent(absolute);
        const exact = diff.status === 'added' ? '' : current === undefined ? undefined : applyUnifiedPatch(current, diff.patch, { reverse: true });
        const before = exact ?? (await gitShowHead(this.directory, absolute)) ?? '';
        const beforeUri = vscode.Uri.from({ scheme: SCHEME, path: absolute, query: String(Date.now()) });
        this.before.set(beforeUri.toString(), before);
        this.changed.fire(beforeUri);
        const title = `${path.basename(absolute)} (EZiL: ${exact === undefined ? 'HEAD, approximate' : 'before'} ↔ after)`;
        await vscode.commands.executeCommand('vscode.diff', beforeUri, vscode.Uri.file(absolute), title, { preview: true });
        if (options.offerRevert === false) return;
        const summary = `EZiL edited ${diff.file} (+${diff.additions} −${diff.deletions})`;
        void vscode.window.showInformationMessage(summary, 'Keep', 'Revert').then(choice => {
            if (choice === 'Revert') return this.revert(absolute, diff);
            return undefined;
        }, error => { this.log(`revert prompt failed: ${errorMessage(error)}`); });
    }

    /** Undo one edit from the file as it is now; never writes content captured earlier or taken from git. */
    async revert(absolute: string, diff: FileDiff): Promise<void> {
        const plan = planRevert(await this.currentContent(absolute), diff);
        if (plan.action === 'refuse') {
            void vscode.window.showWarningMessage(`Not reverting ${diff.file}: ${plan.reason}.`);
            return;
        }
        const uri = vscode.Uri.file(absolute);
        if (plan.action === 'delete') await vscode.workspace.fs.delete(uri, { useTrash: true });
        else await vscode.workspace.fs.writeFile(uri, Buffer.from(plan.content, 'utf8'));
        void vscode.window.showInformationMessage(`Reverted ${diff.file}`);
    }
}

export function gitShowHead(cwd: string, absolute: string): Promise<string | undefined> {
    return new Promise(resolve => {
        execFile('git', ['show', `HEAD:${path.relative(cwd, absolute).split(path.sep).join('/')}`], { cwd, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
            resolve(error ? undefined : stdout);
        });
    });
}
