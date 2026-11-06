/**
 * Per-tab Code folder continuity, the Worker's lexical half, against the SHARED vectors in
 * docs/contracts/code-folder-v1.vectors.json (the shell's code-folder-test.mjs and the app's
 * code-folder.test.ts read the same file).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  CODE_BOOTSTRAP_PATH_REFUSED_KEYS,
  CODE_FOLDER_URL_MAX,
  codeBootstrapPathProblem,
  codeFolderAnswer,
  codeFolderMint,
  fitsCodeFolderUrl,
  parseCodeFolderAsk,
  plainFolderPath,
  planCodeFolder,
  settleCodeFolder,
} from './code-folder';

const V = JSON.parse(readFileSync(new URL('../../docs/contracts/code-folder-v1.vectors.json', import.meta.url), 'utf8'));
/** The vectors' generated inputs (documented as expressions in the JSON; built here without eval). */
const GENERATED: Record<string, string> = {
  SEGMENT_256_BYTES: `/workspace/${'a'.repeat(256)}`,
  PATH_2049_BYTES: `/${`${'b'.repeat(200)}/`.repeat(10)}${'c'.repeat(38)}`,
  SEGMENTS_65: `/${Array(65).fill('d').join('/')}`,
};

describe('code-folder v1 shared vectors', () => {
  it('every generated name has a generator, and each generator is what its name says', () => {
    expect(Object.keys(V.plainFolderPath.generated).sort()).toEqual(Object.keys(GENERATED).sort());
    expect(new TextEncoder().encode(GENERATED.PATH_2049_BYTES!).length).toBe(2049);
    expect(GENERATED.SEGMENTS_65!.split('/').length - 1).toBe(65);
  });

  it('plainFolderPath accepts and normalises exactly the accept table', () => {
    for (const [input, want] of V.plainFolderPath.accept as [string, string][]) expect(plainFolderPath(input)).toBe(want);
  });

  it('plainFolderPath refuses the whole reject table', () => {
    for (const raw of V.plainFolderPath.reject as string[]) expect(plainFolderPath(GENERATED[raw] ?? raw)).toBeNull();
    for (const other of [undefined, null, 1, {}, ['/workspace']]) expect(plainFolderPath(other)).toBeNull();
  });

  it('parseCodeFolderAsk accepts exactly {v:1, path}', () => {
    for (const [input, want] of V.ask.accept as [unknown, string][]) expect(parseCodeFolderAsk(input)).toEqual({ path: want });
    for (const input of V.ask.reject as unknown[]) expect(parseCodeFolderAsk(input)).toBeNull();
  });
  it('parseCodeFolderAsk refuses a caller-sized object without sorting its keys', () => {
    const big: Record<string, unknown> = { v: 1, path: '/workspace/a' };
    for (let i = 0; i < 10_000; i++) big[`k${i}`] = i;
    const sort = Array.prototype.sort;
    let sorts = 0;
    Array.prototype.sort = function (this: unknown[], ...args: Parameters<typeof sort>) { sorts++; return sort.apply(this, args); } as typeof sort;
    try { expect(parseCodeFolderAsk(big)).toBeNull(); } finally { Array.prototype.sort = sort; }
    expect(sorts).toBe(0);
  });

  it('planCodeFolder strips the SERVER root and refuses outside / not_allowed / invalid', () => {
    for (const c of V.plan as { root: string; path: string; expect: { resolve?: string; refused?: string } }[]) {
      const want = c.expect.resolve !== undefined ? { kind: 'resolve', rel: c.expect.resolve } : { kind: 'refused', outcome: c.expect.refused };
      expect({ case: c, got: planCodeFolder({ v: 1, path: c.path }, c.root) }).toEqual({ case: c, got: want as never });
    }
  });

  it('no ask is `none`; a malformed ask is `invalid` (never thrown)', () => {
    expect(planCodeFolder(undefined, '/workspace')).toEqual({ kind: 'none' });
    expect(planCodeFolder({ v: 1, path: '/workspace', extra: 1 }, '/workspace')).toEqual({ kind: 'refused', outcome: 'invalid' });
    expect(planCodeFolder({ v: 2, path: '/workspace' }, '/workspace')).toEqual({ kind: 'refused', outcome: 'invalid' });
    expect(planCodeFolder('/etc', '/workspace')).toEqual({ kind: 'refused', outcome: 'invalid' });
    expect(planCodeFolder(null, '/workspace')).toEqual({ kind: 'refused', outcome: 'invalid' });
  });

  it('the mint id grammar', () => {
    for (const m of V.mint.accept as string[]) expect(codeFolderMint(m)).toBe(m);
    for (const m of V.mint.reject as string[]) expect(codeFolderMint(m)).toBeNull();
    expect(codeFolderMint(null)).toBeNull();
  });

  it('the bootstrap path refusals are the shared list', () => {
    expect([...CODE_BOOTSTRAP_PATH_REFUSED_KEYS]).toEqual(V.bootstrapPathRefusedKeys);
    for (const k of V.bootstrapPathRefusedKeys as string[]) expect(codeBootstrapPathProblem(new URLSearchParams(`${k}=x`))).toBe(k);
    expect(codeBootstrapPathProblem(new URLSearchParams('a=1&tkn=2'))).toBeNull();
  });
});

describe('settleCodeFolder', () => {
  const ask = (path: string) => ({ v: 1, path });

  it('nothing asked: no outcome, no folder, the resolver is never called', async () => {
    let called = 0;
    expect(await settleCodeFolder(undefined, '/workspace', async () => { called += 1; return 'restored'; })).toEqual({});
    expect(called).toBe(0);
  });

  it('a refusal never reaches the resolver', async () => {
    let called = 0;
    const r = async () => { called += 1; return 'restored' as const; };
    expect(await settleCodeFolder(ask('/etc'), '/workspace', r)).toEqual({ outcome: 'outside' });
    expect(await settleCodeFolder(ask('/workspace/.ezil'), '/workspace', r)).toEqual({ outcome: 'not_allowed' });
    expect(await settleCodeFolder({ v: 1, path: '/workspace/../etc' }, '/workspace', r)).toEqual({ outcome: 'invalid' });
    expect(called).toBe(0);
  });

  it('no resolver wired (until e1cd418a ships code-folder-resolve.ts): `unverified`, never a folder', async () => {
    expect(await settleCodeFolder(ask('/workspace/sports/sports-web'), '/workspace')).toEqual({ outcome: 'unverified' });
  });

  it('the resolver gets the REMAINDER only, and only `restored` yields <root>/<rel>', async () => {
    const seen: string[] = [];
    const r = (answer: string) => async (rel: string) => { seen.push(rel); return answer as never; };
    expect(await settleCodeFolder(ask('/workspace/My Project/日本'), '/workspace', r('restored')))
      .toEqual({ outcome: 'restored', folder: '/workspace/My Project/日本' });
    expect(await settleCodeFolder(ask('/workspace'), '/workspace', r('restored'))).toEqual({ outcome: 'restored', folder: '/workspace' });
    expect(await settleCodeFolder(ask('/workspace/gone'), '/workspace', r('missing'))).toEqual({ outcome: 'missing' });
    expect(await settleCodeFolder(ask('/workspace/link'), '/workspace', r('symlink'))).toEqual({ outcome: 'symlink' });
    expect(seen).toEqual(['My Project/日本', '', 'gone', 'link']);
  });

  it('a throwing resolver or an unknown answer is `error`, never a folder', async () => {
    expect(await settleCodeFolder(ask('/workspace/a'), '/workspace', async () => { throw new Error('boom'); })).toEqual({ outcome: 'error' });
    expect(await settleCodeFolder(ask('/workspace/a'), '/workspace', async () => '/etc' as never)).toEqual({ outcome: 'error' });
  });
});

describe('answer and URL guard', () => {
  it('codeFolderAnswer carries a code only', () => {
    expect(codeFolderAnswer(undefined)).toEqual({});
    expect(codeFolderAnswer('missing')).toEqual({ codeFolder: { v: 1, outcome: 'missing' } });
  });

  it('fitsCodeFolderUrl is the 2000-character guard', () => {
    expect(CODE_FOLDER_URL_MAX).toBe(2000);
    expect(fitsCodeFolderUrl('x'.repeat(2000))).toBe(true);
    expect(fitsCodeFolderUrl('x'.repeat(2001))).toBe(false);
    expect(fitsCodeFolderUrl(null)).toBe(false);
  });
});
