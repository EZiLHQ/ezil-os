// Revert must only undo the exact edit; anything that no longer reverses cleanly is refused.
import { expect, test } from 'bun:test';
import { planRevert } from '../src/edits/revert';
import type { FileDiff } from '../src/opencode/adapter';

const patch = ['--- a/x.txt', '+++ b/x.txt', '@@ -1,3 +1,3 @@', ' a', '-b', '+B', ' c', ''].join('\n');
const edit: FileDiff = { file: 'x.txt', patch, additions: 1, deletions: 1, status: 'modified' };

test('a modified file reverts to the pre-edit content when the patch still reverses', () => {
    expect(planRevert('a\nB\nc\n', edit)).toEqual({ action: 'write', content: 'a\nb\nc\n' });
});

test('refuses when the file changed after the edit, or vanished', () => {
    // A later edit (or the user) touched the same lines: reversing would clobber that work.
    expect(planRevert('a\nBB\nc\n', edit)).toMatchObject({ action: 'refuse', reason: expect.stringContaining('changed after this edit') });
    expect(planRevert(undefined, edit)).toMatchObject({ action: 'refuse', reason: expect.stringContaining('no longer exists') });
    // A pre-existing uncommitted change elsewhere is fine: context still matches around the hunk.
    expect(planRevert('intro\na\nB\nc\n', edit)).toEqual({ action: 'write', content: 'intro\na\nb\nc\n' });
});

test('created files are deleted only while they hold exactly what OpenCode wrote', () => {
    const created: FileDiff = { file: 'new.txt', status: 'added', additions: 2, deletions: 0, patch: ['--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+one', '+two', ''].join('\n') };
    expect(planRevert('one\ntwo\n', created)).toEqual({ action: 'delete' });
    expect(planRevert('one\ntwo\nthree\n', created)).toMatchObject({ action: 'refuse' });
    expect(planRevert(undefined, created)).toMatchObject({ action: 'refuse' });
});

test('deleted files are restored from the patch, never while something took their place', () => {
    const deleted: FileDiff = { file: 'old.txt', status: 'deleted', additions: 0, deletions: 2, patch: ['--- a/old.txt', '+++ /dev/null', '@@ -1,2 +0,0 @@', '-one', '-two', ''].join('\n') };
    expect(planRevert(undefined, deleted)).toEqual({ action: 'write', content: 'one\ntwo\n' });
    expect(planRevert('something else\n', deleted)).toMatchObject({ action: 'refuse', reason: expect.stringContaining('recreated') });
    expect(planRevert(undefined, { ...deleted, patch: 'garbage' })).toMatchObject({ action: 'refuse' });
});
