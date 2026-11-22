import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { defaultRefOf, parseRepositoryUrl, publicGitHubAdvertisementUrl, repositoryIdFor, resolvePublicGitHub } from './repo-url';
import type { PublicGitHubRepository } from './repo-url';

/** A git-upload-pack ref advertisement, as GitHub answers `info/refs?service=git-upload-pack`. */
const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const advertisement = (head: string | null, refs: string[] = ['refs/heads/main']) => Buffer.from(
    pkt('# service=git-upload-pack\n') + '0000'
    + refs.map((ref, i) => pkt(`${'a'.repeat(40)} ${i === 0 ? 'HEAD' : ref}${i === 0 ? `\0multi_ack thin-pack side-band${head ? ` symref=HEAD:${head}` : ''} agent=git/github-x\n` : '\n'}`)).join('')
    + '0000');

describe('parseRepositoryUrl: one canonical public github.com repository, or a refusal', () => {
    it.each([
        ['https://github.ezil.work/acme/site.git', 'site'],
        ['https://github.ezil.work/acme/site', 'site'],
    ])('accepts the exact EZiL Git route %s', (raw, name) => {
        expect(parseRepositoryUrl(raw)).toEqual({ ok: true, host: 'github.ezil.work', owner: 'acme', name,
            canonicalURL: 'https://github.ezil.work/acme/site.git', displayName: 'acme/site' });
    });
    it.each([
        'https://GitHub.ezil.work/acme/site.git', 'https://github.ezil.work:443/acme/site.git',
        'https://u@github.ezil.work/acme/site.git', 'https://github.ezil.work/acme/site.git?token=x',
        'https://github.ezil.work/acme/site.git.git', 'https://github.ezil.work/acme/si..te.git',
        'https://github.ezil.work/acme/Site.git', 'https://github.ezil.work/acme/site.git/',
        'https://github.ezil.work/acme/./site.git', 'https://github.ezil.work/acme/ignored/../site.git',
        'https://github.ezil.work/acme/%2e/site.git', 'https://github.ezil.work/acme/%2e%2e/site.git',
        'https://github.ezil.work/acme/ignored/%2E%2E/site.git',
    ])('refuses noncanonical EZiL Git address %s', raw => {
        expect(parseRepositoryUrl(raw)).toEqual({ ok: false, reason: 'invalid' });
    });
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
        'https://git.ezil.work/acme/site.git',
        'https://git-staging.ezil.work/acme-qa/site.git', 'https://git-qa.ezil.work/acme-qa/site.git',
    ])(
        'recognises a nonproduction EZiL Git host %s and refuses it', raw => {
            expect(parseRepositoryUrl(raw)).toEqual({ ok: false, reason: 'unsupported_host' });
        });
});

describe('parseRepositoryUrl: git-qa.ezil.work only under the staging opt-in (contract §6)', () => {
    it.each([
        ['https://git-qa.ezil.work/acme-qa/site.git', 'acme-qa', 'site'],
        ['https://git-qa.ezil.work/acme-qa/site', 'acme-qa', 'site'],
        ['https://git-qa.ezil.work/candidate-a/interview-1121.git', 'candidate-a', 'interview-1121'],
        ['https://git-qa.ezil.work/a0/b.c_d-e', 'a0', 'b.c_d-e'],
    ])('with the opt-in, accepts and canonicalises %s exactly like github.ezil.work', (raw, owner, name) => {
        expect(parseRepositoryUrl(raw, { stagingGitQa: true })).toEqual({ ok: true, host: 'git-qa.ezil.work', owner, name,
            canonicalURL: `https://git-qa.ezil.work/${owner}/${name}.git`, displayName: `${owner}/${name}` });
    });
    it('without the opt-in (default, or false) a well-formed git-qa address is unsupported_host, as today', () => {
        expect(parseRepositoryUrl('https://git-qa.ezil.work/acme-qa/site.git')).toEqual({ ok: false, reason: 'unsupported_host' });
        expect(parseRepositoryUrl('https://git-qa.ezil.work/acme-qa/site.git', { stagingGitQa: false })).toEqual({ ok: false, reason: 'unsupported_host' });
    });
    it.each([
        'https://GIT-QA.ezil.work/acme/site.git', 'https://git-qa.ezil.work:443/acme/site.git', 'https://u@git-qa.ezil.work/acme/site.git',
        'https://git-qa.ezil.work/acme/site.git?token=x', 'https://git-qa.ezil.work/acme/site.git#f', 'https://git-qa.ezil.work/acme/site.git.git',
        'https://git-qa.ezil.work/acme/si..te.git', 'https://git-qa.ezil.work/acme/Site.git', 'https://git-qa.ezil.work/acme/site.git/',
        'https://git-qa.ezil.work/acme/./site.git', 'https://git-qa.ezil.work/acme/ignored/../site.git', 'https://git-qa.ezil.work/acme/%2e%2e/site.git',
        'https://git-qa.ezil.work/a/b/c.git', 'https://git-qa.ezil.work/acme', 'https://git-qa.ezil.work/-acme/site.git',
        'https://git-qa.ezil.work/acme/.site.git', 'https://git-qa.ezil.work\\acme\\site.git',
    ])('with the opt-in, a malformed git-qa address %s is invalid (never a canonical remote)', raw => {
        expect(parseRepositoryUrl(raw, { stagingGitQa: true })).toEqual({ ok: false, reason: 'invalid' });
    });
    it('the opt-in widens nothing else: github.com and github.ezil.work unchanged; git.ezil.work and git-staging stay unsupported', () => {
        // positive controls: the opt-in changes no other host's parse.
        expect(parseRepositoryUrl('https://github.ezil.work/acme/site.git', { stagingGitQa: true })).toEqual({ ok: true, host: 'github.ezil.work',
            owner: 'acme', name: 'site', canonicalURL: 'https://github.ezil.work/acme/site.git', displayName: 'acme/site' });
        expect(parseRepositoryUrl('https://github.com/EZiLHQ/ezil-os.git', { stagingGitQa: true })).toMatchObject({ ok: true, host: 'github.com' });
        for (const raw of ['https://git.ezil.work/acme/site.git', 'https://git-staging.ezil.work/acme-qa/site.git']) {
            expect(parseRepositoryUrl(raw, { stagingGitQa: true })).toEqual({ ok: false, reason: 'unsupported_host' });
        }
    });
});

describe('repositoryIdFor: the same folder on every reopen, never another repository\'s', () => {
    it('is a stable lowercase RFC 9562 v8 UUID, equal across spellings of one repository and different for another', () => {
        const id = repositoryIdFor('https://github.com/ezilhq/ezil-os.git');
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(repositoryIdFor('https://github.com/ezilhq/ezil-os.git')).toBe(id);
        const a = parseRepositoryUrl('https://github.com/EZiLHQ/ezil-os'), b = parseRepositoryUrl('https://github.com/ezilhq/EZIL-OS.git');
        expect(a.ok && b.ok && repositoryIdFor(a.canonicalURL) === repositoryIdFor(b.canonicalURL)).toBe(true);
        expect(repositoryIdFor('https://github.com/ezilhq/other-repo.git')).not.toBe(id);
    });
});

describe('resolvePublicGitHub: one anonymous ref advertisement read', () => {
    const answer = (status: number, body: BodyInit | null = null, type = 'application/x-git-upload-pack-advertisement', headers: Record<string, string> = {}) =>
        vi.fn(async () => new Response(body, { status, headers: { 'content-type': type, ...headers } }));
    const EZIL_OS = { host: 'github.com' as const, owner: 'EZiLHQ', name: 'ezil-os' };
    const AB = { host: 'github.com' as const, owner: 'a', name: 'b' };
    it('names the default branch from symref=HEAD:, sends no credential and follows no redirect', async () => {
        const fetcher = answer(200, advertisement('refs/heads/trunk', ['refs/heads/trunk', 'refs/heads/main']));
        await expect(resolvePublicGitHub(EZIL_OS, { fetch: fetcher as unknown as typeof fetch })).resolves.toEqual({ ok: true, ref: 'refs/heads/trunk' });
        const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
        expect(String(url)).toBe('https://github.com/ezilhq/ezil-os.git/info/refs?service=git-upload-pack');
        // The origin is literal: scheme, host, userinfo and port never come from the caller.
        expect(url).toBeInstanceOf(URL);
        expect([url.protocol, url.hostname, url.username, url.password, url.port, url.hash]).toEqual(['https:', 'github.com', '', '', '', '']);
        expect(url.pathname).toBe('/ezilhq/ezil-os.git/info/refs');
        expect(url.search).toBe('?service=git-upload-pack');
        expect(init).toMatchObject({ method: 'GET', redirect: 'manual', cache: 'no-store' });
        expect(Object.keys(init.headers as Record<string, string>).map(k => k.toLowerCase()).sort()).toEqual(['accept', 'user-agent']);
    });
    it('the parsed github.com address is what the resolver takes: the same request the canonical URL names', () => {
        const parsed = parseRepositoryUrl('https://github.com/EZiLHQ/ezil-os');
        if (!parsed.ok || parsed.host !== 'github.com') throw new Error('parse');
        expect(String(publicGitHubAdvertisementUrl(parsed))).toBe(`${parsed.canonicalURL}/info/refs?service=git-upload-pack`);
    });
    it('malformed parts, a .git name, or an EZiL route are refused without a fetch', async () => {
        const gh = (owner: string, name: string) => ({ host: 'github.com' as const, owner, name });
        const ezil = parseRepositoryUrl('https://github.ezil.work/default/os-code-url-20261110-a.git');
        if (!ezil.ok) throw new Error('parse');
        const bad = [gh('a/b', 'c'), gh('a@b', 'c'), gh('a', '..'), gh('a', 'b:1'), gh('a', 'b?x=1'), gh('a', 'b#f'), gh('a', 'b%2e%2e'),
            gh('a', 'b.git'), gh('-a', 'b'), gh('a', '.b'), gh('evil.example/', 'b'), gh('a', 'b/../../c'),
            ezil as unknown as PublicGitHubRepository];
        for (const repo of bad) {
            const fetcher = answer(200, advertisement('refs/heads/main'));
            expect(publicGitHubAdvertisementUrl(repo)).toBeNull();
            await expect(resolvePublicGitHub(repo, { fetch: fetcher as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' });
            expect(fetcher).not.toHaveBeenCalled();
        }
    });
    it.each([[401], [403], [404]])('%i (missing or private: indistinguishable on purpose) is not_found', async status => {
        await expect(resolvePublicGitHub(AB, { fetch: answer(status, 'nope', 'text/plain') as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'not_found' });
    });
    it.each([[301], [302], [307], [308]])('%i (renamed or transferred) is moved, never followed', async status => {
        const fetcher = answer(status, null, 'text/html', { location: 'https://github.com/a/c.git' });
        await expect(resolvePublicGitHub(AB, { fetch: fetcher as unknown as typeof fetch }))
            .resolves.toEqual({ ok: false, reason: 'moved' });
        expect(fetcher).toHaveBeenCalledTimes(1); // the Location is never requested
    });
    it('an empty repository (no HEAD symref) is empty; anything else unclean is unavailable, never a guessed ref', async () => {
        await expect(resolvePublicGitHub(AB, { fetch: answer(200, advertisement(null)) as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'empty' });
        for (const fetcher of [answer(500, 'x', 'text/plain'), answer(429, 'x', 'text/plain'), answer(200, advertisement('refs/heads/main'), 'text/html'),
            vi.fn(async () => { throw new TypeError('network'); })]) {
            await expect(resolvePublicGitHub(AB, { fetch: fetcher as unknown as typeof fetch })).resolves.toEqual({ ok: false, reason: 'unavailable' });
        }
    });
    it('defaultRefOf refuses a ref git could read as an option or that the Worker refuses', () => {
        for (const head of ['refs/heads/-x', 'refs/heads/a..b', 'refs/tags/v1', 'refs/heads/.hidden', 'refs/heads/a.lock']) {
            expect(defaultRefOf(advertisement(head))).toBeNull();
        }
        expect(defaultRefOf(Buffer.from('garbage'))).toBeNull();
        expect(defaultRefOf(advertisement('refs/heads/feature/x'))).toBe('refs/heads/feature/x');
    });
});
