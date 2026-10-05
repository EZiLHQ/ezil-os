// Path confinement for anything the webview or the server names. No `vscode` import.
import * as path from 'node:path';

/**
 * Resolve `file` (relative to `directory`, or absolute) and return the absolute path only
 * when it stays inside `directory`. Rejects `..` escapes, absolute paths elsewhere and
 * empty input, so a forged webview message cannot open or rewrite files outside the workspace.
 */
export function confinePath(directory: string, file: string): string | undefined {
    if (!directory || !file || file.includes('\0')) return undefined;
    const root = path.resolve(directory);
    const absolute = path.resolve(root, file);
    if (absolute === root) return undefined;
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
    return absolute;
}
