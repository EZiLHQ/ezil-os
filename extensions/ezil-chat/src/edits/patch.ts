// Minimal unified-diff application. OpenCode reports each edit as a patch
// against the pre-edit file; applying it in reverse to the current content
// gives us the "before" side for `vscode.diff` without touching git.

interface Hunk { oldStart: number; newStart: number; lines: Array<{ op: ' ' | '-' | '+'; text: string }> }

export function parseUnifiedDiff(patch: string): Hunk[] {
    const hunks: Hunk[] = [];
    let current: Hunk | undefined;
    // Remaining old/new line counts from the `@@` header: once both hit zero the hunk is complete, so a
    // following `--- a/file` (next file in a multi-file patch) is a header, not the removal of "-- a/file".
    let oldLeft = 0, newLeft = 0;
    const rawLines = patch.split('\n');
    if (rawLines[rawLines.length - 1] === '') rawLines.pop(); // trailing newline, not an empty context line
    for (const rawLine of rawLines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
        if (header) {
            current = { oldStart: Number(header[1]), newStart: Number(header[3]), lines: [] };
            oldLeft = header[2] === undefined ? 1 : Number(header[2]);
            newLeft = header[4] === undefined ? 1 : Number(header[4]);
            hunks.push(current);
            continue;
        }
        if (!current) continue;
        if (line.startsWith('\\')) continue; // "\ No newline at end of file"
        if (oldLeft <= 0 && newLeft <= 0) { current = undefined; continue; } // hunk complete: trailing metadata
        const op = line.charAt(0);
        if (op === ' ' || op === '-' || op === '+') current.lines.push({ op, text: line.slice(1) });
        else if (line === '') current.lines.push({ op: ' ', text: '' });
        else { current = undefined; continue; } // malformed line ends the hunk
        if (op !== '+') oldLeft -= 1;
        if (op !== '-') newLeft -= 1;
    }
    return hunks;
}

/**
 * Apply `patch` to `source`. With `reverse`, additions are removed and
 * deletions restored, i.e. it recovers the file as it was before the patch.
 * Returns undefined when context lines do not match.
 */
export function applyUnifiedPatch(source: string, patch: string, options: { reverse?: boolean } = {}): string | undefined {
    const hunks = parseUnifiedDiff(patch);
    if (!hunks.length) return undefined;
    const reverse = options.reverse === true;
    const trailingNewline = source.endsWith('\n');
    const lines = source.split('\n');
    if (trailingNewline) lines.pop();
    const out: string[] = [];
    let cursor = 0;
    for (const hunk of hunks) {
        const removeOp = reverse ? '+' : '-';
        const expected = hunk.lines.filter(line => line.op === ' ' || line.op === removeOp).map(line => line.text);
        const hinted = (reverse ? hunk.newStart : hunk.oldStart) - 1;
        const at = locate(lines, expected, Math.max(cursor, hinted), cursor);
        if (at === -1) return undefined;
        out.push(...lines.slice(cursor, at));
        for (const line of hunk.lines) {
            if (line.op === ' ') out.push(line.text);
            else if (line.op === removeOp) continue;
            else out.push(line.text);
        }
        cursor = at + expected.length;
    }
    out.push(...lines.slice(cursor));
    return out.join('\n') + (trailingNewline ? '\n' : '');
}

function matchesAt(lines: string[], expected: string[], index: number): boolean {
    if (index < 0 || index + expected.length > lines.length) return false;
    for (let offset = 0; offset < expected.length; offset++) if (lines[index + offset] !== expected[offset]) return false;
    return true;
}

/** Try the hinted position first, then search outward but never before `floor`. */
function locate(lines: string[], expected: string[], hint: number, floor: number): number {
    if (expected.length === 0) return Math.min(hint, lines.length);
    if (matchesAt(lines, expected, hint)) return hint;
    for (let distance = 1; distance <= lines.length; distance++) {
        const before = hint - distance, after = hint + distance;
        if (before >= floor && matchesAt(lines, expected, before)) return before;
        if (matchesAt(lines, expected, after)) return after;
        if (before < floor && after >= lines.length) break;
    }
    return -1;
}
