/**
 * code-folder-resolve.test.ts — the Cloudflare walk (`./code-folder-resolve.ts`): the result parser,
 * the exec it makes, and the constant script run by real shells against real temp trees (symlinks
 * first, middle and last, dangling; files; missing; spaces, Unicode, glob characters and a leading
 * `-` in names; the root itself), then end to end through `settleCodeFolder`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { settleCodeFolder } from './code-folder';
import {
  CODE_FOLDER_REL_ENV,
  CODE_FOLDER_RESOLVE_SCRIPT,
  CODE_FOLDER_RESOLVE_TIMEOUT_MS,
  CODE_FOLDER_ROOT_ENV,
  CODE_FOLDER_WALK_OUTCOMES,
  cloudflareCodeFolderResolver,
  codeFolderWalkOutcome,
} from './code-folder-resolve';
import type { RepoOpenExec } from './repo-open';

describe('codeFolderWalkOutcome: exit 0 and exactly one known result line, else error', () => {
  it('reads each walk outcome, with or without the trailing newline', () => {
    for (const code of CODE_FOLDER_WALK_OUTCOMES) {
      expect(codeFolderWalkOutcome(0, `ezil-code-folder:${code}\n`)).toBe(code);
      expect(codeFolderWalkOutcome(0, `ezil-code-folder:${code}`)).toBe(code);
    }
  });
  it('refuses everything else', () => {
    for (const [exit, out] of [
      [1, 'ezil-code-folder:restored\n'], // a non-zero exit
      [124, 'ezil-code-folder:restored\n'], // the SDK's timeout exit
      [0, undefined],
      [0, ''],
      [0, 'ezil-code-folder:restored\nezil-code-folder:restored\n'], // two lines
      [0, 'noise\nezil-code-folder:restored\n'],
      [0, 'ezil-code-folder:restored\r\n'],
      [0, ' ezil-code-folder:restored\n'],
      [0, 'ezil-code-folder:outside\n'], // the planner's codes are not the walk's
      [0, 'ezil-code-folder:not_allowed\n'],
      [0, 'ezil-code-folder:unverified\n'],
      [0, 'ezil-code-folder:too_long\n'],
      [0, 'ezil-code-folder:invalid\n'],
      [0, 'ezil-code-folder:/workspace/a\n'], // never a path
    ] as const) {
      expect([exit, out, codeFolderWalkOutcome(exit, out)]).toEqual([exit, out, 'error']);
    }
  });
});

describe('cloudflareCodeFolderResolver: one bounded exec of the constant script', () => {
  it('passes the root and rel in env only, with the timeout and internal origin', async () => {
    const calls: Array<{ command: string; options: Parameters<RepoOpenExec>[1] }> = [];
    const exec: RepoOpenExec = async (command, options) => {
      calls.push({ command, options });
      return { exitCode: 0, stdout: 'ezil-code-folder:restored\n' };
    };
    const rel = "my folder/$(touch pwned)/`id`/a'b\"c";
    expect(await cloudflareCodeFolderResolver(exec, '/workspace')(rel)).toBe('restored');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe(CODE_FOLDER_RESOLVE_SCRIPT);
    expect(calls[0]!.command.includes('pwned')).toBe(false);
    expect(calls[0]!.options).toEqual({
      env: { [CODE_FOLDER_ROOT_ENV]: '/workspace', [CODE_FOLDER_REL_ENV]: rel },
      timeout: CODE_FOLDER_RESOLVE_TIMEOUT_MS,
      origin: 'internal',
    });
  });
  it('answers error for a refused exec, a timeout or stray output, and never throws', async () => {
    const throwing: RepoOpenExec = async () => { throw new Error('container gone'); };
    expect(await cloudflareCodeFolderResolver(throwing, '/workspace')('a')).toBe('error');
    const timedOut: RepoOpenExec = async () => ({ exitCode: 124, stdout: '' });
    expect(await cloudflareCodeFolderResolver(timedOut, '/workspace')('a')).toBe('error');
    const stray: RepoOpenExec = async () => ({ exitCode: 0, stdout: 'hello\n' });
    expect(await cloudflareCodeFolderResolver(stray, '/workspace')('a')).toBe('error');
  });
});

const which = (bin: string) => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
const SHELLS = ['bash', 'sh', 'dash'].filter(which);

describe('the walk script in real shells', () => {
  let dir = '';
  let root = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ezil-code-folder-'));
    root = join(dir, 'workspace');
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    mkdirSync(join(root, 'my folder', 'ünï cødé'), { recursive: true });
    mkdirSync(join(root, 'g*'));
    mkdirSync(join(root, 'xa'));
    mkdirSync(join(root, '-n'));
    mkdirSync(join(root, '-e', 'x'), { recursive: true });
    mkdirSync(join(dir, 'outside', 'deep'), { recursive: true });
    writeFileSync(join(root, 'a', 'file.txt'), 'x');
    symlinkSync(join(root, 'a'), join(root, 'link')); // first component
    symlinkSync('..', join(root, 'a', 'mid')); // middle component, back into a
    symlinkSync(join(dir, 'outside'), join(root, 'a', 'b', 'last')); // last component, outside the root
    symlinkSync(join(root, 'nope'), join(root, 'a', 'dang')); // dangling
    symlinkSync(join(root, 'a', 'file.txt'), join(root, 'a', 'flink')); // to a file
    symlinkSync(root, join(dir, 'rootlink')); // the root itself through a symlink
    writeFileSync(join(dir, 'rootfile'), 'x');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const walk = (shell: string, r: string, rel: string) => {
    const p = Bun.spawnSync([shell, '-c', CODE_FOLDER_RESOLVE_SCRIPT], {
      env: { PATH: process.env.PATH!, [CODE_FOLDER_ROOT_ENV]: r, [CODE_FOLDER_REL_ENV]: rel },
    });
    return codeFolderWalkOutcome(p.exitCode, p.stdout.toString());
  };

  it('has at least bash and sh to run', () => {
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toContain('sh');
  });

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('restores the root itself and real directories at any depth', () => {
        expect(walk(shell, root, '')).toBe('restored');
        expect(walk(shell, `${root}/`, '')).toBe('restored');
        expect(walk(shell, root, 'a')).toBe('restored');
        expect(walk(shell, root, 'a/b/c')).toBe('restored');
      });
      it('answers symlink for a symlink at the first, middle or last component, and a dangling one', () => {
        expect(walk(shell, root, 'link')).toBe('symlink');
        expect(walk(shell, root, 'link/b')).toBe('symlink');
        expect(walk(shell, root, 'a/mid/b')).toBe('symlink');
        expect(walk(shell, root, 'a/b/last')).toBe('symlink');
        expect(walk(shell, root, 'a/b/last/deep')).toBe('symlink');
        expect(walk(shell, root, 'a/dang')).toBe('symlink');
        expect(walk(shell, root, 'a/flink')).toBe('symlink');
      });
      it('answers not_directory for a file, and missing for what is not there', () => {
        expect(walk(shell, root, 'a/file.txt')).toBe('not_directory');
        expect(walk(shell, root, 'a/file.txt/x')).toBe('not_directory');
        expect(walk(shell, root, 'a/nope')).toBe('missing');
        expect(walk(shell, root, 'a/nope/x')).toBe('missing');
      });
      it('keeps spaces, Unicode, glob characters and a leading - literal', () => {
        expect(walk(shell, root, 'my folder/ünï cødé')).toBe('restored');
        expect(walk(shell, root, 'g*')).toBe('restored');
        expect(walk(shell, root, 'x*')).toBe('missing'); // a glob would have matched xa
        expect(walk(shell, root, 'x?')).toBe('missing');
        expect(walk(shell, root, '-n')).toBe('restored');
        expect(walk(shell, root, '-e/x')).toBe('restored');
      });
      it('checks the root: missing, a file, relative; a root reached through a symlink is the server\'s choice', () => {
        expect(walk(shell, join(dir, 'gone'), '')).toBe('missing');
        expect(walk(shell, join(dir, 'rootfile'), 'a')).toBe('not_directory');
        expect(walk(shell, 'workspace', 'a')).toBe('error');
        expect(walk(shell, '', 'a')).toBe('error');
        expect(walk(shell, join(dir, 'rootlink'), 'a/b')).toBe('restored');
        expect(walk(shell, join(dir, 'rootlink'), 'link')).toBe('symlink');
      });
    });
  }

  it('settles end to end: only a walked real directory becomes the folder', async () => {
    const exec: RepoOpenExec = async (command, options) => {
      const p = Bun.spawnSync(['bash', '-c', command], { env: { PATH: process.env.PATH!, ...options.env } });
      return { exitCode: p.exitCode, stdout: p.stdout.toString() };
    };
    const resolve = cloudflareCodeFolderResolver(exec, root);
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/b` }, root, resolve)).toEqual({ outcome: 'restored', folder: `${root}/a/b` });
    expect(await settleCodeFolder({ v: 1, path: root }, root, resolve)).toEqual({ outcome: 'restored', folder: root });
    expect(await settleCodeFolder({ v: 1, path: `${root}/link/b` }, root, resolve)).toEqual({ outcome: 'symlink' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/b/last` }, root, resolve)).toEqual({ outcome: 'symlink' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/file.txt` }, root, resolve)).toEqual({ outcome: 'not_directory' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/my folder/ünï cødé` }, root, resolve)).toEqual({ outcome: 'restored', folder: `${root}/my folder/ünï cødé` });
    // the planner's refusals never reach the walk
    expect(await settleCodeFolder({ v: 1, path: `${dir}/outside` }, root, resolve)).toEqual({ outcome: 'outside' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/projects/00000000-0000-4000-8000-000000000000/repository` }, root, resolve)).toEqual({ outcome: 'not_allowed' });
  });
});
