/**
 * The in-memory smart-HTTP client, against the real thing: every request is answered by `git upload-pack
 * --stateless-rpc` (what `git http-backend` runs) on a repository built here, so the framing, the shallow section,
 * side-band, OFS/REF deltas and the tree walk are all real git output. Skipped only where no `git` binary exists.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync, chmodSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { fetchRepositoryTree, gitAuthorization, GitFetchError, parseAdvertisement, parseUploadPackResult, readPack, walkTree } from './git-smart-http';

const hasGit = spawnSync('git', ['--version']).status === 0;
const TOKEN = `egg_${'7'.repeat(64)}`;
const URL_ = 'https://github.ezil.work/acme/site.git';
/** Universe's remote and an opaque Artifacts repo token. */
const ACCOUNT = '0123456789abcdef'.repeat(2);
const ARTIFACTS = `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/p-3333abcd-3333-4333-8333-33333333cdef.git`;
const ART_TOKEN = 'art_v1_0123456789abcdefABCDEF-_.~+/=';
let dir: string;
let repo: string;
const git = (args: string[], cwd = repo, input?: Buffer) => execFileSync('git', args, { cwd, input, env: { ...process.env,
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
    GIT_CONFIG_NOSYSTEM: '1', HOME: dir }, maxBuffer: 256 << 20 });
const pkt = (s: string) => `${(Buffer.byteLength(s) + 4).toString(16).padStart(4, '0')}${s}`;

/** A fetch that is EZiL Git: info/refs and git-upload-pack served by `git upload-pack --stateless-rpc`. */
function gitServer(path = repo, { status = 200, contentType, base = URL_ }: { status?: number; contentType?: string; base?: string } = {}) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = String(input);
        calls.push({ url, init });
        if (status !== 200) return new Response('denied', { status });
        if (url === `${base}/info/refs?service=git-upload-pack` && init.method === 'GET') {
            const body = Buffer.concat([Buffer.from(`${pkt('# service=git-upload-pack\n')}0000`), git(['upload-pack', '--stateless-rpc', '--advertise-refs', path], dir)]);
            return new Response(body, { headers: { 'content-type': contentType ?? 'application/x-git-upload-pack-advertisement' } });
        }
        if (url === `${base}/git-upload-pack` && init.method === 'POST') {
            const body = git(['upload-pack', '--stateless-rpc', path], dir, Buffer.from(init.body as Uint8Array));
            return new Response(body, { headers: { 'content-type': 'application/x-git-upload-pack-result' } });
        }
        return new Response('not found', { status: 404 });
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
}
const request = (over: Record<string, unknown> = {}) => ({ canonicalURL: URL_, ref: 'refs/heads/main', username: 'ezil', token: TOKEN, ...over });
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e instanceof GitFetchError ? e.code : `other:${String(e)}`);

beforeAll(() => {
    if (!hasGit) return;
    dir = mkdtempSync(join(tmpdir(), 'ezil-git-snapshot-'));
    repo = join(dir, 'site');
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main']);
    // Several revisions of large, similar files: real packs then carry deltas between them.
    const big = (n: number) => Array.from({ length: 4000 }, (_, i) => `line ${i} ${i % 97 === 0 ? `rev ${n}` : 'same'}\n`).join('');
    for (let rev = 0; rev < 6; rev++) {
        mkdirSync(join(repo, 'src/lib'), { recursive: true });
        writeFileSync(join(repo, 'src/lib/big.txt'), big(rev));
        writeFileSync(join(repo, 'src/lib/big-copy.txt'), big(rev + 100));
        writeFileSync(join(repo, 'README.md'), `# Site rev ${rev}\n`);
        git(['add', '-A']); git(['commit', '-q', '-m', `rev ${rev}`]);
    }
    writeFileSync(join(repo, 'run.sh'), '#!/bin/sh\necho hi\n'); chmodSync(join(repo, 'run.sh'), 0o755);
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
    symlinkSync('README.md', join(repo, 'link.md'));
    git(['add', '-A']); git(['commit', '-q', '-m', 'final']);
    git(['branch', 'other', 'HEAD~2']);
    mkdirSync(join(dir, 'empty')); git(['init', '-q', '-b', 'main'], join(dir, 'empty'));
});
afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!hasGit)('fetchRepositoryTree against git upload-pack', () => {
    it('returns the branch tip\'s exact tree and file bytes, at depth 1', async () => {
        const { fetcher, calls } = gitServer();
        const tree = await fetchRepositoryTree(request(), fetcher);
        expect(tree.head).toBe(git(['rev-parse', 'refs/heads/main']).toString().trim());
        const listed = git(['ls-tree', '-r', '-t', '--format=%(objectmode) %(path)', 'HEAD']).toString().trim().split('\n')
            .map(line => { const [mode, ...path] = line.split(' '); return `${mode.replace(/^0+/, '')} ${path.join(' ')}`; });
        expect(tree.entries.map(e => `${e.mode} ${e.path}`).sort()).toEqual(listed.sort());
        for (const entry of tree.entries.filter(e => e.kind === 'file')) {
            expect(Buffer.from(entry.content!).equals(readFileSync(join(repo, entry.path)))).toBe(true);
        }
        expect(tree.entries.find(e => e.path === 'link.md')).toEqual({ path: 'link.md', kind: 'symlink', mode: '120000' });
        expect(tree.entries.find(e => e.path === 'run.sh')?.mode).toBe('100755');
        // Depth 1: the request deepened by one commit.
        expect(Buffer.from(calls[1].init.body as Uint8Array).toString()).toContain('deepen 1');
    });

    it('sends the grant only as Basic auth in a header, never in a URL, and refuses redirects', async () => {
        const { fetcher, calls } = gitServer();
        await fetchRepositoryTree(request(), fetcher);
        expect(calls).toHaveLength(2);
        for (const { url, init } of calls) {
            expect(url).not.toContain(TOKEN);
            expect(init.redirect).toBe('error');
            expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`ezil:${TOKEN}`).toString('base64')}`);
        }
        expect(Buffer.from(calls[1].init.body as Uint8Array).toString()).not.toContain(TOKEN);
    });

    it('🔴 a Cloudflare Artifacts remote gets the token as Bearer, exactly as the git gateway sends it upstream, never Basic or in a URL', async () => {
        const { fetcher, calls } = gitServer(repo, { base: ARTIFACTS });
        const tree = await fetchRepositoryTree(request({ canonicalURL: ARTIFACTS, token: ART_TOKEN }), fetcher);
        expect(tree.head).toBe(git(['rev-parse', 'refs/heads/main']).toString().trim());
        expect(calls.map(c => c.url)).toEqual([`${ARTIFACTS}/info/refs?service=git-upload-pack`, `${ARTIFACTS}/git-upload-pack`]);
        for (const { url, init } of calls) {
            expect(url).not.toContain(ART_TOKEN);
            expect(init.redirect).toBe('error');
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${ART_TOKEN}`);
        }
        expect(Buffer.from(calls[1].init.body as Uint8Array).toString()).not.toContain(ART_TOKEN);
    });

    it('fetches another branch by its ref', async () => {
        const tree = await fetchRepositoryTree(request({ ref: 'refs/heads/other' }), gitServer().fetcher);
        expect(tree.head).toBe(git(['rev-parse', 'refs/heads/other']).toString().trim());
        expect(tree.entries.some(e => e.path === 'run.sh')).toBe(false);
    });

    it.each([
        ['a foreign host', { canonicalURL: 'https://github.com/acme/site.git' }, 'unsupported'],
        ['credentials in the URL', { canonicalURL: `https://ezil:${TOKEN}@github.ezil.work/acme/site.git` }, 'unsupported'],
        ['a query string', { canonicalURL: `${URL_}?x=1` }, 'unsupported'],
        ['an unsafe ref', { ref: 'HEAD' }, 'unsupported'],
        ['a 31-hex Artifacts account', { canonicalURL: ARTIFACTS.replace(ACCOUNT, ACCOUNT.slice(1)) }, 'unsupported'],
        ['an uppercase-hex Artifacts account', { canonicalURL: ARTIFACTS.replace(ACCOUNT, ACCOUNT.toUpperCase()) }, 'unsupported'],
        ['a lookalike Artifacts host', { canonicalURL: ARTIFACTS.replace('.net/', '.net.evil.test/') }, 'unsupported'],
        ['userinfo on the Artifacts host', { canonicalURL: ARTIFACTS.replace('https://', 'https://ezil:x@') }, 'unsupported'],
        ['a port on the Artifacts host', { canonicalURL: ARTIFACTS.replace('.net/', '.net:443/') }, 'unsupported'],
        ['an Artifacts query', { canonicalURL: `${ARTIFACTS}?x=1` }, 'unsupported'],
        ['a dot-dot Artifacts name', { canonicalURL: ARTIFACTS.replace('/p-', '/a..p-') }, 'unsupported'],
        ['a token with a newline (header injection)', { canonicalURL: ARTIFACTS, token: `${ART_TOKEN}\nX-Evil: 1` }, 'unsupported'],
        ['a token with a space', { canonicalURL: ARTIFACTS, token: 'a b' }, 'unsupported'],
        ['an empty token', { token: '' }, 'unsupported'],
    ])('refuses %s before any request', async (_name, over, expected) => {
        const { fetcher, calls } = gitServer();
        expect(await code(fetchRepositoryTree(request(over), fetcher))).toBe(expected);
        expect(calls).toEqual([]);
    });

    it('maps refusals, a missing ref, an empty repository and a dumb server to fixed codes without the token', async () => {
        expect(await code(fetchRepositoryTree(request(), gitServer(repo, { status: 401 }).fetcher))).toBe('unauthorized');
        expect(await code(fetchRepositoryTree(request(), gitServer(repo, { status: 403 }).fetcher))).toBe('unauthorized');
        expect(await code(fetchRepositoryTree(request(), gitServer(repo, { status: 404 }).fetcher))).toBe('not_found');
        expect(await code(fetchRepositoryTree(request({ ref: 'refs/heads/missing' }), gitServer().fetcher))).toBe('ref_not_found');
        expect(await code(fetchRepositoryTree(request(), gitServer(join(dir, 'empty')).fetcher))).toBe('empty_repository');
        expect(await code(fetchRepositoryTree(request(), gitServer(repo, { contentType: 'text/plain' }).fetcher))).toBe('protocol');
        const err = await fetchRepositoryTree(request(), (async () => { throw new Error(TOKEN); }) as unknown as typeof fetch).catch((e: Error) => e);
        expect(err).toBeInstanceOf(GitFetchError);
        expect((err as Error).message).toBe('git_fetch_transport');
    });
});

describe('gitAuthorization', () => {
    it('is Bearer for Artifacts, Basic for EZiL Git, nothing for anything else', () => {
        expect(gitAuthorization({ canonicalURL: ARTIFACTS, username: 'ezil', token: ART_TOKEN })).toBe(`Bearer ${ART_TOKEN}`);
        expect(gitAuthorization({ canonicalURL: URL_, username: 'ezil', token: TOKEN })).toBe(`Basic ${Buffer.from(`ezil:${TOKEN}`).toString('base64')}`);
        expect(gitAuthorization({ canonicalURL: 'https://github.com/acme/site.git', username: 'ezil', token: TOKEN })).toBeNull();
        expect(gitAuthorization({ canonicalURL: ARTIFACTS, username: 'ezil', token: 'x'.repeat(4097) })).toBeNull();
    });
});

describe.skipIf(!hasGit)('readPack', () => {
    const packOf = (args: string[], revs: string) => git(['pack-objects', '--stdout', ...args], repo, Buffer.from(revs));
    /** Prove the fixture really has delta chains: index the pack and ask git. */
    const chains = (pack: Buffer) => {
        const p = join(dir, `t-${Math.random().toString(36).slice(2)}.pack`);
        writeFileSync(p, pack);
        git(['index-pack', p], dir);
        return git(['verify-pack', '-v', p.replace(/\.pack$/, '.idx')], dir).toString();
    };
    const all = () => git(['rev-list', '--objects', '--all']).toString().split('\n').filter(Boolean).map(l => l.split(' ')[0]).sort();

    it.each([['OFS_DELTA', ['--delta-base-offset']], ['REF_DELTA', []]])('resolves %s chains to every object git has', (_kind, flags) => {
        const pack = packOf(['--all', ...flags], '');
        expect(chains(pack)).toMatch(/chain length = [1-9]/);
        const objects = readPack(pack);
        expect([...objects.keys()].sort()).toEqual([...new Set(all())].sort());
        const head = git(['rev-parse', 'HEAD']).toString().trim();
        const files = walkTree(objects, head).filter(e => e.kind === 'file');
        for (const f of files) expect(Buffer.from(f.content!).equals(git(['cat-file', 'blob', `HEAD:${f.path}`]))).toBe(true);
    });

    it('refuses a thin pack (a delta base it does not carry)', () => {
        // rev 5 against rev 4: big.txt's new blob is a delta on a blob only rev 4 has.
        const thin = packOf(['--revs', '--thin'], 'HEAD~1\n^HEAD~2\n');
        expect(() => readPack(thin)).toThrow(expect.objectContaining({ code: 'unsupported' }));
    });

    it('refuses a pack whose checksum does not match', () => {
        const pack = Buffer.from(packOf(['--revs'], 'HEAD\n'));
        pack[pack.length - 30] ^= 0xff;
        expect(() => readPack(pack)).toThrow(expect.objectContaining({ code: 'protocol' }));
    });

    afterAll(() => { for (const f of readdirSync(dir)) if (f.startsWith('t-')) rmSync(join(dir, f)); });
});

describe('protocol framing', () => {
    it('refuses a sha256 repository and a v2-only answer', () => {
        const oid = 'a'.repeat(40);
        expect(() => parseAdvertisement(Buffer.from(`${pkt(`${oid} refs/heads/main\0side-band-64k object-format=sha256\n`)}0000`)))
            .toThrow(expect.objectContaining({ code: 'unsupported' }));
        expect(() => parseAdvertisement(Buffer.from(`${pkt('version 2\n')}${pkt('ls-refs\n')}0000`))).toThrow(expect.objectContaining({ code: 'unsupported' }));
    });
    it('refuses a malformed pkt-line and an ERR line', () => {
        expect(() => parseAdvertisement(Buffer.from('zzzz'))).toThrow(expect.objectContaining({ code: 'protocol' }));
        expect(() => parseAdvertisement(Buffer.from(`${pkt('ERR access denied\n')}0000`))).toThrow(expect.objectContaining({ code: 'protocol' }));
    });
    it('a side-band fatal message (channel 3) is a protocol failure, not data', () => {
        const fatal = Buffer.concat([Buffer.from(`0000${pkt('NAK\n')}`), Buffer.from('000a'), Buffer.from([3]), Buffer.from('boom\n'), Buffer.from('0000')]);
        expect(() => parseUploadPackResult(fatal, { shallow: true, sideband: true })).toThrow(expect.objectContaining({ code: 'protocol' }));
    });
});
