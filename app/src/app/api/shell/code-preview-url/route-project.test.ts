/**
 * `POST /api/shell/code-preview-url` with `project: {projectId, repoId}` (os-map-design §2, OS shell → OS server).
 *
 * The tRPC caller, the retained identity and the placement read are stubbed at their module boundaries; the Works
 * client (`@/server/works/project-repo`) and the Worker client (`@/server/lib/compute/repo-open`) are REAL, behind
 * one stubbed `fetch`, so these pin the exact bytes each one sends. What they prove:
 *  - ownership is checked before Works is asked anything, and Works before the Worker;
 *  - the git token reaches the Worker request body and nothing else: not the answer, not a log line;
 *  - an uppercase UUID never gets past the route, and a Works 403 never yields a `folder=`.
 */
import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '3333abcd-3333-4333-8333-33333333cdef';
const REPO = '44444444-4444-4444-8444-444444444444';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.private-retained-id-token.signature';
const GIT_TOKEN = `egg_${'f'.repeat(64)}`;
const SECRET = 'route-test-hmac-secret';
const WORKS = 'https://works-staging.example';
const WORKER = 'https://worker.example';
const SANDBOX = 'guac-1111111111114111-2222222222224222';
const MINTED = `https://code-${SANDBOX}.preview.example/preview-bootstrap?token=t&folder=%2Fworkspace`;

const s = vi.hoisted(() => ({
    order: [] as string[],
    owned: true,
    identity: 'ok' as 'ok' | 'missing',
    aws: [false, false] as boolean[],
    preview: { ok: true } as Record<string, unknown>,
    works: null as null | ((body: unknown) => Response),
    worker: null as null | ((body: string) => Response),
    requests: [] as { url: URL; init: RequestInit }[],
    cleared: 0,
}));

vi.mock('@/server/api/trpc', () => ({ createTRPCContext: async () => ({ user: { id: USER }, db: {}, headers: new Headers() }) }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({
    computer: { get: async ({ id }: { id: string }) => {
        s.order.push('computer.get');
        if (!s.owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        return { id };
    } },
    cloudflareGuacamole: { codePreviewUrl: async () => { s.order.push('codePreviewUrl'); return s.preview; } },
}) } }));
vi.mock('@/server/auth/retained-identity', () => ({
    retainedIdentity: async (userId: string) => {
        s.order.push('identity');
        if (s.identity === 'missing' || userId !== USER) throw new Error('IDENTITY_REFRESH_REQUIRED');
        return { token: ID_TOKEN, issuer: 'https://id.ezil.work/', subject: 'auth0|builder', expiresAt: Date.now() + 3_600_000, userId: USER, sessionId: 'session-a' };
    },
    clearProjectIdentity: async () => { s.cleared += 1; },
}));
vi.mock('@/server/lib/compute/aws-control-auth', () => ({ controlTargetFor: async () => {
    s.order.push('target');
    const aws = s.aws.shift() ?? false;
    return aws
        ? { sandboxName: SANDBOX, auth: { kind: 'v2', claims: { sandboxId: SANDBOX, computerId: COMPUTER, userId: USER, provider: 'aws-ec2', store: '', generation: 3, leaseEpoch: 1 } } }
        : { sandboxName: SANDBOX, auth: { kind: 'v1' } };
} }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/lib/cloudflare-guacamole-provider')>(),
    resolveCloudflareGuacamoleConfig: () => ({ workerUrl: WORKER, isConfigured: true, hasHmacSecret: true }),
}));

import { POST } from './route';

const grant = (over: Record<string, unknown> = {}) => ({
    binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main', bindingVersion: 'a'.repeat(64) },
    access: { role: 'builder' },
    git: { username: 'ezil', token: GIT_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'read' },
    ...over,
});

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
    Object.assign(s, { order: [], owned: true, identity: 'ok', aws: [false, false], requests: [], cleared: 0,
        preview: { ok: true, correlationId: 'c', codePreviewUrl: MINTED, expiresAt: Date.now() + 300_000, provider: 'cloudflare-guacamole' },
        works: () => Response.json(grant()),
        worker: () => Response.json({ folder: `/workspace/projects/${REPO}`, head: 'b'.repeat(40) }) });
    vi.stubEnv('EZIL_WORKS_PROJECT_REPO_ORIGIN', WORKS);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', SECRET);
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        s.requests.push({ url, init });
        if (url.origin === WORKS) { s.order.push('works'); return s.works!(JSON.parse(String(init.body))); }
        if (url.origin === WORKER) { s.order.push('worker'); return s.worker!(String(init.body)); }
        throw new Error(`unexpected fetch ${url.origin}`);
    }));
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (body: unknown) => POST(new Request('https://os-staging.example/api/shell/code-preview-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
const open = (project: unknown = { projectId: PROJECT, repoId: REPO }) => post({ computerId: COMPUTER, intent: 'open', project });

/** Neither secret may appear in what the browser receives or in anything logged. */
async function expectNoSecrets(response: Response) {
    const text = await response.clone().text();
    const logged = JSON.stringify(logs.flatMap(l => l.mock.calls));
    for (const secret of [GIT_TOKEN, 'egg_', ID_TOKEN, 'eyJ']) {
        expect(text).not.toContain(secret);
        expect(logged).not.toContain(secret);
    }
}

describe('opening a project in Code', () => {
    it('checks ownership, identity, provider and readiness, THEN Works, THEN the Worker, and answers the folder URL', async () => {
        const response = await open();
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'identity', 'target', 'codePreviewUrl', 'works', 'target', 'worker']);
        const body = await response.clone().json();
        expect(body.url).toBe(body.codePreviewUrl);
        const url = new URL(body.url);
        expect(url.searchParams.getAll('folder')).toEqual([`/workspace/projects/${REPO}`]);
        expect(url.searchParams.get('token')).toBe('t');
        expect(body).toMatchObject({ ok: true, provider: 'cloudflare-guacamole' });
        await expectNoSecrets(response);
    });

    it('asks Works with the retained ID token in the JSON body only, at the bare origin', async () => {
        await open();
        const { url, init } = s.requests.find(r => r.url.origin === WORKS)!;
        expect(url.toString()).toBe(`${WORKS}/internal/project-repositories/open`);
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        expect(init.headers).toEqual({ 'content-type': 'application/json' });
        expect(JSON.parse(String(init.body))).toStrictEqual({ userIdToken: ID_TOKEN, projectId: PROJECT, repositoryId: REPO });
    });

    it('hands the grant to the Worker in a v2-signed body (digest of the exact bytes), with no query string', async () => {
        await open();
        const { url, init } = s.requests.find(r => r.url.origin === WORKER)!;
        expect(url.pathname).toBe(`/sandbox/${SANDBOX}/repo-open`);
        expect(url.search).toBe('');
        const body = String(init.body);
        expect(JSON.parse(body)).toStrictEqual({ repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main',
            git: { token: GIT_TOKEN, expiresAt: expect.any(String) } });
        const auth = (init.headers as Record<string, string>)['x-ezil-auth'];
        const [v, claims64, sig] = auth.split('.');
        expect(v).toBe('v2');
        const c = JSON.parse(Buffer.from(claims64, 'base64url').toString());
        expect(c).toMatchObject({ sandboxId: SANDBOX, computerId: COMPUTER, userId: USER, provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0 });
        const payload = ['v2', c.ts, 'POST', url.pathname, c.sandboxId, c.computerId, c.userId, c.provider, c.store, c.generation, c.leaseEpoch,
            createHash('sha256').update(body).digest('hex')].join('|');
        expect(sig).toBe(createHmac('sha256', SECRET).update(payload).digest('hex'));
        expect(JSON.stringify(init.headers)).not.toContain(GIT_TOKEN);
    });

    it("another person's computer is NOT_FOUND, and Works, the identity and the mint are never reached", async () => {
        s.owned = false;
        const response = await open();
        expect(response.status).toBe(404);
        expect((await response.clone().json()).error.code).toBe('NOT_FOUND');
        expect(s.order).toEqual(['computer.get']);
        expect(s.requests).toEqual([]);
    });

    it.each([
        ['an uppercase project UUID', { projectId: PROJECT.toUpperCase(), repoId: REPO }],
        ['one uppercase hex digit', { projectId: PROJECT.replace('f', 'F'), repoId: REPO }],
        ['an uppercase repo UUID', { projectId: PROJECT, repoId: REPO.replace(/4/g, 'A').replace(/a/g, 'A') }],
        ['a non-canonical id', { projectId: PROJECT.replace(/-/g, ''), repoId: REPO }],
        ['a missing repo', { projectId: PROJECT }],
        ['a number', 7],
        ['an array', [PROJECT, REPO]],
    ])('%s is project_invalid (400) before anything is read', async (_name, project) => {
        const response = await open(project);
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('project_invalid');
        expect(s.order).toEqual([]);
        expect(s.requests).toEqual([]);
    });

    it('no retained identity is IDENTITY_REFRESH_REQUIRED (409) before the computer is started or Works asked', async () => {
        s.identity = 'missing';
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.order).toEqual(['computer.get', 'identity']);
        expect(s.requests).toEqual([]);
    });

    it('an AWS computer is repo_open_unsupported_provider (409) without starting it or asking Works', async () => {
        s.aws = [true];
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_unsupported_provider');
        expect(s.order).not.toContain('codePreviewUrl');
        expect(s.requests).toEqual([]);
    });

    it('a computer that became AWS during the mint is refused after Works, and the Worker is never signed for', async () => {
        s.aws = [false, true];
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_unsupported_provider');
        expect(s.order).not.toContain('worker');
    });

    it('a not-ready mint (still waking, billing) goes back unchanged and Works is NOT asked, so retries mint no grants', async () => {
        s.preview = { ok: false, error: 'sandbox_starting: waking', errorCode: 'sandbox_starting', provider: 'cloudflare-guacamole' };
        const response = await open();
        expect(await response.json()).toEqual(s.preview);
        expect(s.requests).toEqual([]);
    });

    it('Works 403 is project_not_authorized, with no folder, no URL and no Worker call', async () => {
        s.works = () => Response.json({ error: 'project_repo_not_authorized', message: 'Project repository request refused.' }, { status: 403 });
        const response = await open();
        expect(response.status).toBe(403);
        const body = await response.clone().json();
        expect(body).toEqual({ error: { code: 'project_not_authorized', message: expect.any(String) } });
        expect(JSON.stringify(body)).not.toContain('folder');
        expect(s.order).not.toContain('worker');
        await expectNoSecrets(response);
    });

    it('a grant for another project or repository is project_not_authorized too', async () => {
        s.works = () => Response.json(grant({ binding: { ...grant().binding, repositoryId: '55555555-5555-4555-8555-555555555555' } }));
        expect((await (await open()).json()).error.code).toBe('project_not_authorized');
        expect(s.order).not.toContain('worker');
    });

    it('Works 401 drops the retained token and asks for a refresh (409)', async () => {
        s.works = () => Response.json({ error: 'project_repo_invalid_identity', message: 'x' }, { status: 401 });
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.cleared).toBe(1);
    });

    it.each([
        ['a 503', () => Response.json({ error: 'project_repo_configuration_required' }, { status: 503 })],
        ['a write grant', () => Response.json(grant({ git: { ...grant().git, scope: 'write' } }))],
        ['a grant past five minutes', () => Response.json(grant({ git: { ...grant().git, expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }))],
        ['a foreign clone host', () => Response.json(grant({ binding: { ...grant().binding, canonicalURL: 'https://evil.example/acme/site.git' } }))],
        ['not JSON', () => new Response(`<html>${GIT_TOKEN}</html>`, { status: 200 })],
    ])('%s from Works is project_repo_unavailable (503) and nothing of it is echoed', async (_name, works) => {
        s.works = works;
        const response = await open();
        expect(response.status).toBe(503);
        expect((await response.clone().json()).error.code).toBe('project_repo_unavailable');
        expect(s.order).not.toContain('worker');
        await expectNoSecrets(response);
    });

    it('an unconfigured Works origin is project_repo_unavailable, never a 500', async () => {
        vi.stubEnv('EZIL_WORKS_PROJECT_REPO_ORIGIN', 'https://works.example/path');
        const response = await open();
        expect(response.status).toBe(503);
        expect(s.requests).toEqual([]);
    });

    it.each([
        ['the computer root', '/workspace'],
        ['another repository', '/workspace/projects/55555555-5555-4555-8555-555555555555'],
        ['a dot-dot escape', `/workspace/../projects/${REPO}`],
        ['a relative folder', `workspace/projects/${REPO}`],
        ['no folder', undefined],
    ])('a Worker answer with %s is repo_open_failed (502), never Code at another folder', async (_name, folder) => {
        s.worker = () => Response.json({ folder });
        const response = await open();
        expect(response.status).toBe(502);
        const body = await response.clone().json();
        expect(body.error.code).toBe('repo_open_failed');
        expect(body.url).toBeUndefined();
        await expectNoSecrets(response);
    });

    it('a Worker failure is logged by status and fixed code only, never its body', async () => {
        s.worker = () => Response.json({ ok: false, error: `clone failed for https://ezil:${GIT_TOKEN}@github.ezil.work` }, { status: 500 });
        const response = await open();
        expect(response.status).toBe(502);
        expect(logs[2].mock.calls).toContainEqual(['[repo-open] worker refused', expect.objectContaining({ status: 500, error: 'other' })]);
        await expectNoSecrets(response);
    });

    it("the Worker's own repo_open_unsupported_provider is passed on as 409", async () => {
        s.worker = () => Response.json({ ok: false, error: 'repo_open_unsupported_provider' }, { status: 409 });
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_unsupported_provider');
    });

    it("no project (or null) is exactly today's mint: no ownership pre-read, no identity, no Works", async () => {
        for (const body of [{ computerId: COMPUTER, intent: 'open' }, { computerId: COMPUTER, intent: 'open', project: null }]) {
            s.order = [];
            expect(await (await post(body)).json()).toEqual(s.preview);
            expect(s.order).toEqual(['codePreviewUrl']);
        }
        expect(s.requests).toEqual([]);
    });
});
