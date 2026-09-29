import { expect, test } from 'bun:test';
import { confinePath } from '../src/paths';

test('relative and in-tree absolute paths resolve under the workspace folder', () => {
    expect(confinePath('/ws', 'src/a.ts')).toBe('/ws/src/a.ts');
    expect(confinePath('/ws/', './src/a.ts')).toBe('/ws/src/a.ts');
    expect(confinePath('/ws', '/ws/src/a.ts')).toBe('/ws/src/a.ts');
    expect(confinePath('/ws', 'src/../b.ts')).toBe('/ws/b.ts');
});

test('escapes, other absolute paths, the folder itself and junk are refused', () => {
    expect(confinePath('/ws', '../etc/passwd')).toBeUndefined();
    expect(confinePath('/ws', 'src/../../etc/passwd')).toBeUndefined();
    expect(confinePath('/ws', '/etc/passwd')).toBeUndefined();
    expect(confinePath('/ws', '/wsx/a.ts')).toBeUndefined(); // sibling folder sharing a prefix
    expect(confinePath('/ws', '/ws')).toBeUndefined();
    expect(confinePath('/ws', '')).toBeUndefined();
    expect(confinePath('', 'a.ts')).toBeUndefined();
    expect(confinePath('/ws', 'a\0.ts')).toBeUndefined();
});
