/**
 * `POST /api/shell/code-repo-snapshot` (os-map-design §5 fallback). The session and the retained identity are
 * stubbed; the Works client is real behind a stubbed `fetch`; the git fetcher is the pluggable boundary
 * (`@/server/works/git-smart-http`), replaced here so the route is pinned without a git server.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const PROJECT = '3333abcd-3333-4333-8333-33333333cdef';
const REPO = '44444444-4444-4444-8444-44444444abcd';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.private-retained-id-token.signature';
const GIT_TOKEN = `egg_${'3'.repeat(64)}`;
const WORKS = 'https://works-staging.example';

const s = vi.hoisted(() => ({
    signedIn: true,
    identity: true,
    works: null as null | (() => Response),
    tree: null as null | (() => Promise<unknown>),
    fetched: [] as unknown[],
    order: [] as string[],
    cleared: 0,
}));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: async () => ({ user: s.signedIn ? { id: USER } : null, db: {}, headers: new Headers() }) }));
vi.mock('@/server/auth/retained-identity', () => ({
    retainedIdentity: async () => {
        s.order.push('identity');
        if (!s.identity) throw new Error('IDENTITY_REFRESH_REQUIRED');
        return { token: ID_TOKEN, issuer: 'https://id.ezil.work/', subject: 'auth0|client', expiresAt: Date.now() + 3_600_000, userId: USER, sessionId: 'a' };
    },
    clearProjectIdentity: async () => { s.cleared += 1; },
}));
vi.mock('@/server/works/git-smart-http', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/works/git-smart-http')>(),
    fetchRepositoryTree: async (request: unknown) => { s.order.push('git'); s.fetched.push(request); return s.tree!(); },
}));

import { GitFetchError } from '@/server/works/git-smart-http';
import { POST } from './route';

const grant = () => ({
    binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main', bindingVersion: 'a'.repeat(64) },
    access: { role: 'client' },
    git: { username: 'ezil', token: GIT_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'read' },
});
let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
    Object.assign(s, { signedIn: true, identity: true, fetched: [], order: [], cleared: 0,
        works: () => Response.json(grant()),
        tree: async () => ({ head: 'c'.repeat(40), entries: [{ path: 'README.md', kind: 'file', mode: '100644', size: 3, content: Buffer.from('hi\n') }] }) });
    vi.stubEnv('EZIL_WORKS_PROJECT_REPO_ORIGIN', WORKS);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
        if (new URL(String(input)).origin !== WORKS) throw new Error('unexpected fetch');
        s.order.push('works');
        return s.works!();
    }));
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (body: unknown) => POST(new Request('https://os-staging.example/api/shell/code-repo-snapshot', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const snapshot = (project: unknown = { projectId: PROJECT, repoId: REPO }) => post({ project });
async function expectNoSecrets(response: Response) {
    const text = await response.clone().text();
    const logged = JSON.stringify(logs.flatMap(l => l.mock.calls));
    for (const secret of [GIT_TOKEN, 'egg_', ID_TOKEN, 'eyJ']) { expect(text).not.toContain(secret); expect(logged).not.toContain(secret); }
}

describe('POST /api/shell/code-repo-snapshot', () => {
    it('authorizes with Works, fetches on the server with the grant, and answers only the tree and text', async () => {
        const response = await snapshot();
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toContain('no-store');
        expect(await response.clone().json()).toEqual({ ok: true, snapshot: {
            projectId: PROJECT, repositoryId: REPO, ref: 'refs/heads/main', head: 'c'.repeat(40), role: 'client', truncated: false,
            entries: [{ path: 'README.md', kind: 'file', size: 3, text: 'hi\n' }] } });
        expect(s.order).toEqual(['identity', 'works', 'git']);
        expect(s.fetched[0]).toMatchObject({ canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main', username: 'ezil', token: GIT_TOKEN });
        await expectNoSecrets(response);
    });

    it('signed out is 401 before the body is read', async () => {
        s.signedIn = false;
        expect((await snapshot()).status).toBe(401);
        expect(s.order).toEqual([]);
    });

    it.each([
        ['an uppercase UUID', { projectId: PROJECT.toUpperCase(), repoId: REPO }],
        ['a null project', null],
        ['a string', `${PROJECT}/${REPO}`],
    ])('%s is project_invalid (400) with nothing fetched', async (_name, project) => {
        const response = await snapshot(project);
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('project_invalid');
        expect(s.order).toEqual([]);
    });

    it('a body that is not JSON is a 400', async () => {
        expect((await post('{nope')).status).toBe(400);
        expect(s.order).toEqual([]);
    });

    it('no retained identity is IDENTITY_REFRESH_REQUIRED (409) and Works is not asked', async () => {
        s.identity = false;
        const response = await snapshot();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.order).toEqual(['identity']);
    });

    it('Works 403 is project_not_authorized and nothing is fetched', async () => {
        s.works = () => Response.json({ error: 'project_repo_not_authorized', message: 'x' }, { status: 403 });
        const response = await snapshot();
        expect(response.status).toBe(403);
        expect((await response.clone().json()).error.code).toBe('project_not_authorized');
        expect(s.order).not.toContain('git');
        await expectNoSecrets(response);
    });

    it('Works 401 drops the retained token and asks for a refresh', async () => {
        s.works = () => Response.json({ error: 'project_repo_invalid_identity', message: 'x' }, { status: 401 });
        expect((await (await snapshot()).json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.cleared).toBe(1);
    });

    it.each([
        ['a gateway refusal', () => Promise.reject(new GitFetchError('unauthorized'))],
        ['an unexpected error carrying the token', () => Promise.reject(new Error(`fatal: ${GIT_TOKEN}`))],
    ])('%s is repo_snapshot_failed (502), logged by fixed code only', async (_name, tree) => {
        s.tree = tree;
        const response = await snapshot();
        expect(response.status).toBe(502);
        expect((await response.clone().json()).error.code).toBe('repo_snapshot_failed');
        await expectNoSecrets(response);
    });
});
