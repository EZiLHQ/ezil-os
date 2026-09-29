import { expect, test } from 'bun:test';
import { applyUnifiedPatch, parseUnifiedDiff } from '../src/edits/patch';

const before = 'a\nb\nc\nd\ne\n';
const after = 'a\nB\nc\nd\ne\nf\n';
const patch = [
    '--- a/x.txt', '+++ b/x.txt',
    '@@ -1,5 +1,6 @@', ' a', '-b', '+B', ' c', ' d', ' e', '+f', '',
].join('\n');

test('parses hunks and applies forward and in reverse', () => {
    expect(parseUnifiedDiff(patch)).toHaveLength(1);
    expect(applyUnifiedPatch(before, patch)).toBe(after);
    expect(applyUnifiedPatch(after, patch, { reverse: true })).toBe(before);
});

test('tolerates shifted line numbers and rejects mismatched context', () => {
    const shifted = `intro\nintro2\n${after}`;
    expect(applyUnifiedPatch(shifted, patch, { reverse: true })).toBe(`intro\nintro2\n${before}`);
    expect(applyUnifiedPatch('totally\ndifferent\n', patch, { reverse: true })).toBeUndefined();
    expect(applyUnifiedPatch(before, 'not a patch')).toBeUndefined();
});

test('handles multiple hunks and files without a trailing newline', () => {
    const source = Array.from({ length: 12 }, (_, index) => `line${index + 1}`).join('\n');
    const multi = [
        '@@ -1,3 +1,3 @@', ' line1', '-line2', '+LINE2', ' line3',
        '@@ -10,3 +10,3 @@', ' line10', '-line11', '+LINE11', ' line12',
    ].join('\n');
    const result = applyUnifiedPatch(source, multi);
    expect(result?.endsWith('\n')).toBe(false);
    expect(result?.split('\n')[1]).toBe('LINE2');
    expect(result?.split('\n')[10]).toBe('LINE11');
    expect(applyUnifiedPatch(result ?? '', multi, { reverse: true })).toBe(source);
});

test('a multi-file patch: the next file header after a complete hunk is not a removed line, and short hunks are honoured', () => {
    const multi = [
        '--- a/first.txt', '+++ b/first.txt',
        '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
        '--- a/second.txt', '+++ b/second.txt',
        '@@ -1 +1 @@', '-x', '+y', '',
    ].join('\n');
    const hunks = parseUnifiedDiff(multi);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines).toEqual([{ op: ' ', text: 'keep' }, { op: '-', text: 'old' }, { op: '+', text: 'new' }]);
    expect(hunks[1]?.lines).toEqual([{ op: '-', text: 'x' }, { op: '+', text: 'y' }]);
    // Applying only the first file's hunk to its file still works because the stray header no longer poisons it.
    expect(applyUnifiedPatch('keep\nold\n', [multi.split('\n').slice(0, 6).join('\n'), '--- a/second.txt', ''].join('\n'))).toBe('keep\nnew\n');
});
