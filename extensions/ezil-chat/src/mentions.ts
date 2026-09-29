import * as vscode from 'vscode';
import { confinePath } from './paths';
import type { Mention } from './protocol';

/** Case-insensitive subsequence match; ranks shorter, earlier matches first. */
export function fuzzyScore(query: string, candidate: string): number {
    if (!query) return 1;
    const needle = query.toLowerCase(), hay = candidate.toLowerCase();
    let position = 0, score = 0;
    for (const char of needle) {
        const found = hay.indexOf(char, position);
        if (found === -1) return 0;
        score += found === position ? 3 : 1; // reward contiguous runs
        position = found + 1;
    }
    return score + (hay.includes(needle) ? 10 : 0) - candidate.length / 100;
}

export function rankFiles(query: string, files: string[], limit: number): string[] {
    return files
        .map(file => ({ file, score: fuzzyScore(query, file) }))
        .filter(item => item.score > 0)
        .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
        .slice(0, limit)
        .map(item => item.file);
}

/** Workspace file search for @-mentions; uses the editor's index and respects files.exclude. */
export async function searchWorkspaceFiles(query: string, limit: number): Promise<string[]> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return [];
    const uris = await vscode.workspace.findFiles('**/*', '{**/node_modules/**,**/.git/**,**/dist/**}', 2000);
    const files = uris.map(uri => vscode.workspace.asRelativePath(uri, false));
    return rankFiles(query, files, limit);
}

/** Current editor selection (or cursor line) as a mention chip. */
export function selectionMention(editor: vscode.TextEditor | undefined): Mention | undefined {
    if (!editor || editor.document.uri.scheme !== 'file') return undefined;
    const relative = vscode.workspace.asRelativePath(editor.document.uri, false);
    const start = editor.selection.start.line + 1;
    const end = editor.selection.isEmpty ? start : editor.selection.end.line + 1 - (editor.selection.end.character === 0 && editor.selection.end.line > editor.selection.start.line ? 1 : 0);
    return { path: relative, start, end, label: `${relative}:${start}${end !== start ? `-${end}` : ''}` };
}

/** Open `file` (relative to the workspace or absolute inside it); anything outside the folder is refused. */
export async function openWorkspaceFile(directory: string, file: string, line?: number): Promise<void> {
    const absolute = confinePath(directory, file);
    if (!absolute) throw new Error(`refusing to open ${file}: outside the workspace folder`);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(absolute));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    if (line !== undefined) {
        const position = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
    }
}
