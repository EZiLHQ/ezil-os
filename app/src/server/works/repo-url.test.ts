import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { defaultRefOf, parseRepositoryUrl, repositoryIdFor, resolvePublicGitHub } from './repo-url';

/** A git-upload-pack ref advertisement, as GitHub answers `info/refs?service=git-upload-pack`. */
const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const advertisement = (head: string | null, refs: string[] = ['refs/heads/main']) => Buffer.from(
    pkt('# service=git-upload-pack\n') + '0000'
    + refs.map((ref, i) => pkt(`${'a'.repeat(40)} ${i === 0 ? 'HEAD' : ref}${i === 0 ? `\0multi_ack thin-pack side-band${head ? ` symref=HEAD:${head}` : ''} agent=git/github-x\n` : '\n'}`)).join('')
    + '0000');

describe('parseRepositoryUrl: one canonical public github.com repository, or a refusal', () => {
    it.each([
        ['https://github.com/EZiLHQ/ezil-os.git', 'https://github.com/ezilhq/ezil-os.git', 'EZiLHQ/ezil-os'],
        ['https://github.com/EZiLHQ/ezil-os', 'https://github.com/ezilhq/ezil-os.git', 'EZiLHQ/ezil-os'],
        ['https://github.com/EZiLHQ/ezil-os/', 'https://github.com/ezilhq/ezil-os.git', 'EZiLHQ/ezil-os'],
        ['https://github.com/a-b/c.d_e-f', 'https://github.com/a-b/c.d_e-f.git', 'a-b/c.d_e-f'],
    ])('%s → %s', (raw, canonicalURL, displayName) => {
        expect(parseRepositoryUrl(raw)).toEqual({ ok: true, host: 'github.com', owner: displayName.split('/')[0], name: displayName.split('/')[1], canonicalURL, displayName });
    });
    it.each([
        'http://github.com/a/b.git', 'https://GitHub.com/a/b.git', 'https://www.github.com/a/b.git', 'https://github.com:443/a/b.git',
        'https://u:p@github.com/a/b.git', 'https://token@github.com/a/b.git', 'https://github.com/a/b.git?x=1', 'https://github.com/a/b.git#x',
        'https://github.com/a/b/c.git', 'https://github.com/a', 'https://github.com/', 'https://github.com/a/.b.git', 'https://github.com/a/b..c',
        'https://github.com/-a/b.git', 'https://github.com/a--b/c.git', 'https://github.com/a/b%2e', 'https://github.com/a/b%2Fc', 'https://github.com/a/b c',
        'https://github.com\\a\\b.git', 'https://github.com/a/b.git.git', 'https://github.com.evil.com/a/b.git', 'https://evil.com/github.com/a/b.git',
        'https://github.com./a/b.git', 'https://xn--github-cxa.com/a/b.git', 'https://github.com/a/b\u0000', 'https://github.com/ä/b',
        'file:///etc/passwd', 'ssh://git@github.com/a/b.git', 'git@github.com:a/b.git', 'javascript:alert(1)', '', 7, null, { url: 'x' },
        `https://github.com/a/${'b'.repeat(600)}`, 'https://gitlab.ezil.work/acme/site.git', 'https://ezil.work/acme/site.git',
    ])('refuses %j as invalid', raw => {
        expect(parseRepositoryUrl(raw)).toEqual({ ok: false, reason: 'invalid' });
    });
    it.each([
        'https://github.ezil.work/acme/site.git', 'https://git.ezil.work/acme/site.git',
        'https://git-staging.ezil.work/acme-qa/site.git', 'https://git-qa.ezil.work/acme-qa/site.git',
    ])(
        'recognises EZiL Git %s and refuses it for now (needs a Works grant by address)', raw => {
            expect(parseRepositoryUrl(raw)).toEqual({ ok: false, reason: 'unsupported_host' });
        });
});

describe('repositoryIdFor: the same folder on every reopen, never another repository\'s', () => {
    it('is a stable lowercase RFC 9562 v8 UUID, equal across spellings of one repository and different for another', () => {
        const id = repositoryIdFor('https://github.com/ezilhq/ezil-os.git');
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(repositoryIdFor('https://github.com/ezilhq/ezil-os.git')).toBe(id);
        const a = parseRepositoryUrl('https://github.com/EZiLHQ/ezil-os'), b = parseRepositoryUrl('https://github.com/ezilhq/EZIL-OS.git');
        expect(a.ok && b.ok && repositoryIdFor(a.canonicalURL) === repositoryIdFor(b.canonicalURL)).toBe(true);
        expect(repositoryIdFor('https://github.com/ezilhq/ezil-works.git')).not.toBe(id);
    });
});

describe('resolvePublicGitHub: one anonymous ref advertisement read', () => {
    const answer = (status: number, body: BodyInit | null = null, type = 'application/x-git-upload-pack-advertisement', headers: Record<string, string> = {}) =>
        vi.fn(async () => new Response(body, { status, headers: { 'content-type': type, ...headers } }));
    it('names the default branch from symref=HEAD:, sends no credential and follows no redirect', async () => {
        const fetcher = answer(200, advertisement('refs/heads/trunk', ['refs/heads/trunk', 'refs/heads/main']));
        await expect(resolvePublicGitHub('https://github.com/ezilhq/ezil-os.git', { fetch: fetcher as unknown as typeof fetch })).resolves.toEqual({ ok: true, ref: 'refs/heads/trunk' });
        const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
        expect(String(url)).toBe('https://github.com/ezilhq/ezil-os.git/info/refs?service=git-upload-pack');
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' });
        expect(Object.keys(init.headers as Record<string, string>).map(k => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
    });
    it.each([[401], [403], [404]])('%i (missing or private: indistinguishable on purpose) is not_found', async status => {
        await expect(resolvePublicGitHub('https://github.com/a/b.git', { fetch: answer(status, 'nope', 'text/plain') as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'not_found' });
    });
    it.each([[301], [302], [307], [308]])('%i (renamed or transferred) is moved, never followed', async status => {
        await expect(resolvePublicGitHub('https://github.com/a/b.git', { fetch: answer(status, null, 'text/html', { location: 'https://github.com/a/c.git' }) as unknown as typeof fetch }))
            .resolves.toEqual({ ok: false, reason: 'moved' });
    });
    it('an empty repository (no HEAD symref) is empty; anything else unclean is unavailable, never a guessed ref', async () => {
        await expect(resolvePublicGitHub('https://github.com/a/b.git', { fetch: answer(200, advertisement(null)) as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'empty' });
        for (const fetcher of [answer(500, 'x', 'text/plain'), answer(429, 'x', 'text/plain'), answer(200, advertisement('refs/heads/main'), 'text/html'),
            vi.fn(async () => { throw new TypeError('network'); })]) {
            await expect(resolvePublicGitHub('https://github.com/a/b.git', { fetch: fetcher as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        }
    });
    it('defaultRefOf refuses a ref git could read as an option or that Universe\'s ref rules refuse', () => {
        for (const head of ['refs/heads/-x', 'refs/heads/a..b', 'refs/tags/v1', 'refs/heads/.hidden', 'refs/heads/a.lock']) {
            expect(defaultRefOf(advertisement(head))).toBeNull();
        }
        expect(defaultRefOf(Buffer.from('garbage'))).toBeNull();
        expect(defaultRefOf(advertisement('refs/heads/feature/x'))).toBe('refs/heads/feature/x');
    });
});
