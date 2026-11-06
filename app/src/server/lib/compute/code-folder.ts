/**
 * Per-tab Code folder continuity, the app's half: LEXICAL only, no filesystem, no network.
 *
 * An own-files shell tab sends `codeFolder: {v:1, path}` with its Code mint: the folder its own editor last
 * reported (shell/ezil/apps/code-folder.js). The app never trusts it as a folder and never fails the mint over
 * it: a hint that fails this check is not forwarded and the answer says `invalid`. A hint that passes is
 * forwarded to the Worker in the signed `/sandbox/preview` body, where it is planned against the COMPUTER's root
 * and walked on the computer with no symlink followed (worker/src/code-folder.ts). The answer passes through only
 * the Worker's `{v:1, outcome}`: a code, never a path.
 *
 * Same grammar as the shell and the Worker: docs/contracts/code-folder-v1.vectors.json.
 */

/** The longest folder path (UTF-8 bytes) any layer accepts. */
export const CODE_FOLDER_MAX_BYTES = 2048;
const MAX_SEGMENT_BYTES = 255;
const MAX_SEGMENTS = 64;
/** The shape of an outcome code the Worker may answer (a code, never a path). */
export const CODE_FOLDER_OUTCOME_RE = /^[a-z_]{1,32}$/;

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** No lone surrogate (String.prototype.isWellFormed is newer than this project's lib). */
function wellFormed(s: string): boolean {
    for (let i = 0; i < s.length; i += 1) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const n = s.charCodeAt(i + 1);
            if (!(n >= 0xdc00 && n <= 0xdfff)) return false;
            i += 1;
        } else if (c >= 0xdc00 && c <= 0xdfff) {
            return false;
        }
    }
    return true;
}

/** A plain absolute POSIX folder path, normalised (one trailing `/` dropped), or null. */
export function plainFolderPath(value: unknown): string | null {
    if (typeof value !== 'string' || value.length === 0 || value.length > CODE_FOLDER_MAX_BYTES) return null;
    if (!wellFormed(value)) return null;
    const path = value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value;
    if (!path.startsWith('/') || utf8Bytes(path) > CODE_FOLDER_MAX_BYTES) return null;
    for (let i = 0; i < path.length; i += 1) {
        const c = path.charCodeAt(i);
        if (c < 0x20 || c === 0x7f || c === 0x5c) return null;
    }
    if (path === '/') return path;
    const segments = path.slice(1).split('/');
    if (segments.length > MAX_SEGMENTS) return null;
    return segments.every((s) => s !== '' && s !== '.' && s !== '..' && utf8Bytes(s) <= MAX_SEGMENT_BYTES) ? path : null;
}

/** `{v:1, path}` exactly (an unknown key, another version or a non-plain path is refused), else null. */
export function parseCodeFolderAsk(value: unknown): { v: 1; path: string } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    // The caller sizes this object (`z.unknown()`): v1 has exactly two keys, so never sort more than that.
    const keys = Object.keys(value);
    if (keys.length !== 2 || keys.sort().join(',') !== 'path,v' || (value as { v?: unknown }).v !== 1) return null;
    const path = plainFolderPath((value as { path?: unknown }).path);
    return path ? { v: 1, path } : null;
}

/**
 * The answer's `codeFolder`: the Worker's outcome code when it gave a well-formed one; `invalid` when the shell
 * asked with a hint this app refused (nothing was forwarded); nothing when nothing was asked or an older Worker
 * ignored the ask (the shell then says "couldn't check" itself).
 */
export function codeFolderAnswer(workerAnswer: unknown, asked: unknown, parsed: { path: string } | null | undefined):
    { codeFolder?: { v: 1; outcome: string } } {
    const outcome = (workerAnswer as { outcome?: unknown } | null | undefined)?.outcome;
    if (parsed && typeof outcome === 'string' && CODE_FOLDER_OUTCOME_RE.test(outcome)) return { codeFolder: { v: 1, outcome } };
    return asked !== undefined && !parsed ? { codeFolder: { v: 1, outcome: 'invalid' } } : {};
}
