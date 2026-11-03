/**
 * Per-tab Code folder continuity, the app's lexical check, against the SHARED vectors in
 * docs/contracts/code-folder-v1.vectors.json (worker/src/code-folder.test.ts and the shell's
 * code-folder-test.mjs read the same file).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { CODE_FOLDER_OUTCOME_RE, codeFolderAnswer, parseCodeFolderAsk, plainFolderPath } from './code-folder';

const V = JSON.parse(readFileSync(path.resolve(__dirname, '../../../../../docs/contracts/code-folder-v1.vectors.json'), 'utf8'));
const GENERATED: Record<string, string> = {
    SEGMENT_256_BYTES: `/workspace/${'a'.repeat(256)}`,
    PATH_2049_BYTES: `/${`${'b'.repeat(200)}/`.repeat(10)}${'c'.repeat(38)}`,
    SEGMENTS_65: `/${Array(65).fill('d').join('/')}`,
};

describe('code-folder v1 shared vectors (app)', () => {
    it('every generated name has a generator', () => {
        expect(Object.keys(V.plainFolderPath.generated).sort()).toEqual(Object.keys(GENERATED).sort());
    });
    it('plainFolderPath: the accept table, normalised', () => {
        for (const [input, want] of V.plainFolderPath.accept as [string, string][]) expect(plainFolderPath(input)).toBe(want);
    });
    it('plainFolderPath: the whole reject table', () => {
        for (const raw of V.plainFolderPath.reject as string[]) expect(plainFolderPath(GENERATED[raw] ?? raw)).toBeNull();
    });
    it('parseCodeFolderAsk: exactly {v:1, path}', () => {
        for (const [input, want] of V.ask.accept as [unknown, string][]) expect(parseCodeFolderAsk(input)).toEqual({ v: 1, path: want });
        for (const input of V.ask.reject as unknown[]) expect(parseCodeFolderAsk(input)).toBeNull();
    });
});

describe('parseCodeFolderAsk: a caller-sized object', () => {
    it('more keys than v1 has is refused before any sort, and answers `invalid` like any malformed hint', () => {
        const big: Record<string, unknown> = { v: 1, path: '/workspace/a' };
        for (let i = 0; i < 10_000; i += 1) big[`k${i}`] = i;
        const sort = vi.spyOn(Array.prototype, 'sort');
        let parsed: ReturnType<typeof parseCodeFolderAsk> | undefined;
        let sorts = -1;
        try {
            parsed = parseCodeFolderAsk(big);
        } finally {
            sorts = sort.mock.calls.length;
            sort.mockRestore();
        }
        expect(parsed).toBeNull();
        expect(sorts).toBe(0);
        expect(codeFolderAnswer(undefined, big, parsed)).toEqual({ codeFolder: { v: 1, outcome: 'invalid' } });
    });
});

describe('codeFolderAnswer', () => {
    const asked = { v: 1, path: '/workspace/a' };
    it('passes a well-formed Worker code through, and only when this app forwarded a hint', () => {
        expect(codeFolderAnswer({ v: 1, outcome: 'restored' }, asked, { path: '/workspace/a' })).toEqual({ codeFolder: { v: 1, outcome: 'restored' } });
        expect(codeFolderAnswer({ v: 1, outcome: 'restored' }, undefined, undefined)).toEqual({});
    });
    it('a refused hint says `invalid`; nothing asked says nothing; an older Worker\'s silence stays silent', () => {
        expect(codeFolderAnswer(undefined, { v: 9 }, null)).toEqual({ codeFolder: { v: 1, outcome: 'invalid' } });
        expect(codeFolderAnswer(undefined, undefined, undefined)).toEqual({});
        expect(codeFolderAnswer(undefined, asked, { path: '/workspace/a' })).toEqual({});
    });
    it('a Worker answer that is not a plain code is never passed through (no path can leak)', () => {
        for (const odd of [{ outcome: '/etc' }, { outcome: 'RESTORED' }, { outcome: 'a'.repeat(33) }, { outcome: 1 }, 'restored', null]) {
            expect(codeFolderAnswer(odd, asked, { path: '/workspace/a' })).toEqual({});
        }
        expect(CODE_FOLDER_OUTCOME_RE.test('not_directory')).toBe(true);
    });
});
