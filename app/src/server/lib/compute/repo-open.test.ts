import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isRepositoryFolder, requestRepoOpen, withRepositoryFolder } from './repo-open';
import type { ControlTarget } from './aws-control-auth';

const REPO = '44444444-4444-4444-8444-44444444abcd';
const TOKEN = `egg_${'9'.repeat(64)}`;
const computer = { userId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222' };
const cloudflare: ControlTarget = { sandboxName: 'guac-a-b', auth: { kind: 'v1' } };
const aws: ControlTarget = { sandboxName: 'guac-a-b', auth: { kind: 'v2', claims: { sandboxId: 'guac-a-b', computerId: computer.computerId,
    userId: computer.userId, provider: 'aws-ec2', store: '', generation: 2, leaseEpoch: 4 } } };
const request = { repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main', git: { token: TOKEN, expiresAt: '2026-10-31T12:05:00.000Z' } };
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });
const run = (respond: () => Response | Promise<Response>, target = cloudflare, secret = 'secret') => {
    const fetcher = vi.fn(async () => respond());
    return { fetcher, result: requestRepoOpen('https://worker.example', secret, target, computer, request, { fetch: fetcher as unknown as typeof fetch }) };
};

describe('isRepositoryFolder', () => {
    it.each([`/workspace/projects/${REPO}`, `/home/neko/project/projects/${REPO}`, `/projects/${REPO}`])('accepts %s', f => expect(isRepositoryFolder(f, REPO)).toBe(true));
    it.each([`/workspace/projects/${REPO}/`, `/workspace/projects/${REPO.toUpperCase()}`, `/workspace/../projects/${REPO}`, `/./projects/${REPO}`,
        `//projects/${REPO}`, `workspace/projects/${REPO}`, `/workspace/project/${REPO}`, '/workspace', `/work space/projects/${REPO}`, 7, null])('refuses %j', f => {
        expect(isRepositoryFolder(f, REPO)).toBe(false);
    });
});

describe('withRepositoryFolder', () => {
    it('replaces the root folder and keeps the bootstrap token', () => {
        const url = new URL(withRepositoryFolder('https://code.example/preview-bootstrap?token=a%3Db&folder=%2Fworkspace', `/workspace/projects/${REPO}`));
        expect(url.searchParams.getAll('folder')).toEqual([`/workspace/projects/${REPO}`]);
        expect(url.searchParams.get('token')).toBe('a=b');
    });
});

describe('requestRepoOpen', () => {
    it('returns the folder and a well-formed head', async () => {
        const { result } = run(() => Response.json({ folder: `/workspace/projects/${REPO}`, head: 'a'.repeat(40) }));
        expect(await result).toEqual({ ok: true, folder: `/workspace/projects/${REPO}`, head: 'a'.repeat(40) });
        const odd = run(() => Response.json({ ok: true, folder: `/workspace/projects/${REPO}`, head: 'not-a-sha' }));
        expect(await odd.result).toEqual({ ok: true, folder: `/workspace/projects/${REPO}` });
    });
    it('never sends an AWS computer\'s request', async () => {
        const { fetcher, result } = run(() => Response.json({}), aws);
        expect(await result).toEqual({ ok: false, errorCode: 'repo_open_unsupported_provider' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('refuses without a signing secret and never sends unsigned', async () => {
        const { fetcher, result } = run(() => Response.json({}), cloudflare, ' ');
        expect(await result).toEqual({ ok: false, errorCode: 'repo_open_failed' });
        expect(fetcher).not.toHaveBeenCalled();
    });
    it.each([
        ['a 500', () => Response.json({ folder: `/workspace/projects/${REPO}` }, { status: 500 })],
        ['ok:false', () => Response.json({ ok: false, folder: `/workspace/projects/${REPO}` })],
        ['not JSON', () => new Response(`fatal: https://ezil:${TOKEN}@github.ezil.work`)],
        ['a transport error', () => { throw new Error(`connect ${TOKEN}`); }],
    ])('%s is repo_open_failed, logged without the body', async (_name, respond) => {
        const { result } = run(respond);
        expect(await result).toEqual({ ok: false, errorCode: 'repo_open_failed' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
    });
});
