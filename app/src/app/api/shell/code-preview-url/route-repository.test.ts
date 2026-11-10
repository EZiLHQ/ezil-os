/**
 * `POST /api/shell/code-preview-url` with `repository: {url}` (founder 547ed35a: `/app/code?repo=<https URL>`).
 *
 * Same boundaries as route-project.test.ts: the tRPC caller and the placement read are stubbed; the resolver
 * (`@/server/works/repo-url`) and the Worker client (`@/server/lib/compute/repo-open`) are REAL behind one stubbed
 * `fetch`, with github.com answering a real git-upload-pack advertisement. What they prove: nothing is read for an
 * address that is not one; ownership, then the provider, then GitHub, then the mint, then the Worker; a missing or
 * private repository is "This repository doesn't exist." before the computer is woken; the Worker is asked
 * anonymously (no git object) for the canonical remote, into a folder that is the same on every reopen.
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
/** An opaque Cloudflare Artifacts repo token, as Universe hands it out. */
const GIT_TOKEN = `art_v1_${'f'.repeat(64)}`;
const SECRET = 'route-test-hmac-secret';
const ACCOUNT = '0123456789abcdef'.repeat(2);
const ARTIFACTS = `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/p-${PROJECT}.git`;
const UNIVERSE = 'https://universe-staging.example';
const WORKER = 'https://worker.example';
const SANDBOX = 'guac-1111111111114111-2222222222224222';
const MINTED = `https://code-${SANDBOX}.preview.example/preview-bootstrap?token=t&folder=%2Fworkspace`;

const s = vi.hoisted(() => ({
    order: [] as string[],
    owned: true,
    identity: 'ok' as 'ok' | 'missing',
    aws: [false, false] as boolean[],
    preview: { ok: true } as Record<string, unknown>,
    /** How long the stubbed Code mint takes, ms of `Date.now()`. */
    mintTakes: 0,
    skew: 0,
    universe: null as null | ((body: unknown) => Response),
    works: null as null | ((body: unknown) => Response),
    worker: null as null | ((body: string) => Response),
    github: null as null | ((url: URL, init: RequestInit) => Response),
    requests: [] as { url: URL; init: RequestInit }[],
    cleared: 0,
    /** What the route handed the Code mint (per-tab folder continuity: never a `codeFolder` with a project). */
    mintInputs: [] as unknown[],
}));

vi.mock('@/server/api/trpc', () => ({ createTRPCContext: async () => ({ user: { id: USER }, db: {}, headers: new Headers() }) }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({
    computer: { get: async ({ id }: { id: string }) => {
        s.order.push('computer.get');
        if (!s.owned) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        return { id };
    } },
    cloudflareGuacamole: { codePreviewUrl: async (input: unknown) => {
        s.order.push('codePreviewUrl'); s.mintInputs.push(input); s.skew += s.mintTakes; return s.preview;
    } },
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


const pkt = (line: string) => `${(Buffer.byteLength(line) + 4).toString(16).padStart(4, '0')}${line}`;
const advertisement = (head: string | null) => Buffer.from(pkt('# service=git-upload-pack\n') + '0000'
    + pkt(`${'a'.repeat(40)} HEAD\0multi_ack${head ? ` symref=HEAD:${head}` : ''} agent=git/github-x\n`) + '0000');

import { POST } from './route';

const grant = (over: Record<string, unknown> = {}) => ({
    binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: ARTIFACTS, ref: 'refs/heads/main', bindingVersion: '1' },
    access: { role: 'builder' },
    git: { username: 'ezil', token: GIT_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write' },
    ...over,
});

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
    Object.assign(s, { order: [], owned: true, identity: 'ok', aws: [false, false], requests: [], cleared: 0, mintTakes: 0, skew: 0, mintInputs: [],
        preview: { ok: true, correlationId: 'c', codePreviewUrl: MINTED, expiresAt: Date.now() + 300_000, provider: 'cloudflare-guacamole' },
        universe: () => Response.json(grant()),
        works: () => Response.json({ username: 'ezil', token: `egg_${'a'.repeat(64)}`,
            expiresAt: new Date(Date.now() + 240_000).toISOString(), cloneUrl: 'https://github.ezil.work/acme/site.git',
            repositoryId: REPO,
            binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git',
                ref: 'refs/heads/main', bindingVersion: 'b'.repeat(64) },
            identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|builder' },
            routeName: 'acme/site', handle: 'acme', name: 'site', scope: 'write', defaultBranch: 'main', class: 'project' }, { status: 201 }),
        worker: () => Response.json({ folder: `/workspace/projects/${REPO}`, head: 'b'.repeat(40) }),
        github: () => new Response(advertisement('refs/heads/main'), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }) });
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', UNIVERSE);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', SECRET);
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work'); // os-staging: the Worker opens public github.com
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        s.requests.push({ url, init });
        if (url.origin === UNIVERSE) { s.order.push('universe'); return s.universe!(JSON.parse(String(init.body))); }
        if (url.origin === 'https://api.ezil.work') { s.order.push('works'); return s.works!(JSON.parse(String(init.body))); }
        if (url.origin === WORKER) { s.order.push('worker'); return s.worker!(String(init.body)); }
        if (url.origin === 'https://github.com') { s.order.push('github'); return s.github!(url, init); }
        throw new Error(`unexpected fetch ${url.origin}`);
    }));
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {}),
        vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + s.skew);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = (body: unknown) => POST(new Request('https://os-staging.example/api/shell/code-preview-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));

/** Neither secret, nor the Artifacts remote (it names the Cloudflare account), may appear in what the browser receives or in anything logged. */
async function expectNoSecrets(response: Response) {
    const text = await response.clone().text();
    const logged = JSON.stringify(logs.flatMap(l => l.mock.calls));
    for (const secret of [GIT_TOKEN, 'art_v1_', 'egg_', ID_TOKEN, 'eyJ', ACCOUNT, 'artifacts.cloudflare.net']) {
        expect(text).not.toContain(secret);
        expect(logged).not.toContain(secret);
    }
}


const GH = 'https://github.com/EZiLHQ/ezil-os.git';
const CANONICAL = 'https://github.com/ezilhq/ezil-os.git';
const openUrl = (url: unknown = GH) => post({ computerId: COMPUTER, intent: 'open', repository: { url } });

describe('opening a repository from its address in Code', () => {
    it('uses an owned computer, the exact production Works address grant, and the Worker folder for EZiL Git', async () => {
        s.worker = body => Response.json({ folder: `/workspace/projects/${JSON.parse(body).repositoryId}` });
        const response = await openUrl('https://github.ezil.work/acme/site.git');
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'works', 'codePreviewUrl', 'target', 'worker']);
        const works = s.requests.find(r => r.url.origin === 'https://api.ezil.work')!;
        expect(works.url.pathname).toBe('/v1/builder/selfserve-repositories/os-grant');
        expect(JSON.parse(String(works.init.body))).toMatchObject({ class: 'project', url: 'https://github.ezil.work/acme/site.git' });
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(JSON.parse(String(worker.init.body))).toMatchObject({ repositoryId: REPO,
            canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main',
            git: { token: `egg_${'a'.repeat(64)}`, scope: 'write' },
            privateBinding: { projectId: PROJECT, bindingVersion: 'b'.repeat(64),
                issuer: 'https://id.ezil.work/', subject: 'auth0|builder' } });
        const body = await response.clone().json();
        expect(body.repository).toEqual({ name: 'acme/site', id: REPO });
        expect(new URL(body.codePreviewUrl).searchParams.getAll('folder')).toEqual([`/workspace/projects/${REPO}`]);
        await expectNoSecrets(response);
    });

    it('keeps missing or unauthorized EZiL Git addresses indistinguishable before Worker open', async () => {
        for (const status of [403, 404]) {
            s.works = () => new Response('private producer detail', { status });
            s.order = []; s.requests = [];
            const response = await openUrl('https://github.ezil.work/acme/site.git');
            expect(response.status).toBe(404);
            expect((await response.json()).error).toMatchObject({ code: 'repo_not_found', message: "This repository doesn't exist." });
            expect(s.order).not.toContain('codePreviewUrl');
            expect(s.order).not.toContain('worker');
        }
    });

    it('refuses an incomplete Works packet before Code can wake the computer', async () => {
        s.works = () => Response.json({ repositoryId: REPO }, { status: 201 });
        const response = await openUrl('https://github.ezil.work/acme/site.git');
        expect(response.status).toBe(503);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'works']);
    });

    it('measures the Worker deadline after the Works grant response', async () => {
        s.mintTakes = 80_000;
        const original = s.works!;
        s.works = body => { const response = original(body); s.skew += 10_000; return response; };
        const response = await openUrl('https://github.ezil.work/acme/site.git');
        expect(response.status).toBe(200);
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        const timeoutMs = JSON.parse(String(worker.init.body)).timeoutMs as number;
        expect(timeoutMs).toBeGreaterThan(104_000);
        expect(timeoutMs).toBeLessThanOrEqual(105_000);
    });

    it('refuses to send an expired Worker budget after a slow Works grant response', async () => {
        s.mintTakes = 170_000;
        const original = s.works!;
        s.works = body => { const response = original(body); s.skew += 10_000; return response; };
        const response = await openUrl('https://github.ezil.work/acme/site.git');
        expect(response.status).toBe(504);
        expect((await response.json()).error.code).toBe('repo_open_timeout');
        expect(s.order).not.toContain('worker');
    });

    it('renews an address grant after a slow Code mint and sends only the fresh grant to Worker', async () => {
        s.mintTakes = 100_000;
        const original = s.works!;
        let issued = 0;
        s.works = body => {
            issued += 1;
            const response = original(body);
            // The first grant has too little lifetime after the slow mint.
            return Response.json({ username: 'ezil', token: `egg_${String(issued).repeat(64)}`,
                expiresAt: new Date(Date.now() + (issued === 1 ? 120_000 : 240_000)).toISOString(),
                cloneUrl: 'https://github.ezil.work/acme/site.git', repositoryId: REPO,
                binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git',
                    ref: 'refs/heads/main', bindingVersion: 'b'.repeat(64) },
                identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|builder' },
                routeName: 'acme/site', handle: 'acme', name: 'site', scope: 'write', defaultBranch: 'main', class: 'project' },
            { status: response.status });
        };
        const response = await openUrl('https://github.ezil.work/acme/site.git');
        expect(response.status).toBe(200);
        expect(issued).toBe(2);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'works', 'codePreviewUrl', 'works', 'target', 'worker']);
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(JSON.parse(String(worker.init.body)).git.token).toBe(`egg_${'2'.repeat(64)}`);
    });

    it('ownership, provider, GitHub, mint, Worker: in that order; answers the folder URL and the name, nothing secret', async () => {
        const { repositoryIdFor } = await import('@/server/works/repo-url');
        const id = repositoryIdFor(CANONICAL);
        s.worker = () => Response.json({ folder: `/workspace/projects/${id}`, head: 'b'.repeat(40) });
        const response = await openUrl();
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'github', 'codePreviewUrl', 'target', 'worker']);
        const body = await response.clone().json();
        expect(body.repository).toEqual({ name: 'EZiLHQ/ezil-os', id });
        expect(new URL(body.url).searchParams.getAll('folder')).toEqual([`/workspace/projects/${id}`]);
        expect(body.url).toBe(body.codePreviewUrl);
        // The Code mint is the plain one: same wake loop, Free policy and billing gates; no codeFolder with a repository.
        expect(s.mintInputs).toEqual([{ computerId: COMPUTER, intent: 'open' }]);
        // GitHub: one anonymous read of the canonical remote's advertisement.
        const gh = s.requests.find(r => r.url.origin === 'https://github.com')!;
        expect(gh.url.toString()).toBe(`${CANONICAL}/info/refs?service=git-upload-pack`);
        expect(JSON.stringify(gh.init.headers).toLowerCase()).not.toContain('authorization');
        // The Worker: the canonical remote, the advertised branch, the stable folder id, and NO git object at all.
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(worker.url.pathname).toBe(`/sandbox/${SANDBOX}/repo-open`);
        expect(JSON.parse(String(worker.init.body))).toStrictEqual({ repositoryId: id, canonicalURL: CANONICAL, ref: 'refs/heads/main', timeoutMs: 130_000 });
        const auth = (worker.init.headers as Record<string, string>)['x-ezil-auth'];
        const [, claims64, sig] = auth.split('.');
        const c = JSON.parse(Buffer.from(claims64, 'base64url').toString());
        const payload = ['v2', c.ts, 'POST', worker.url.pathname, c.sandboxId, c.computerId, c.userId, c.provider, c.store, c.generation, c.leaseEpoch,
            createHash('sha256').update(String(worker.init.body)).digest('hex')].join('|');
        expect(sig).toBe(createHmac('sha256', SECRET).update(payload).digest('hex'));
        await expectNoSecrets(response);
    });

    it('a reopen in another spelling targets the same folder (the Worker then fetches only and keeps uncommitted work)', async () => {
        const ids = new Set<string>();
        s.worker = body => { const id = JSON.parse(body).repositoryId as string; ids.add(id); return Response.json({ folder: `/workspace/projects/${id}` }); };
        for (const url of [GH, 'https://github.com/ezilhq/ezil-os', 'https://github.com/EZiLHQ/EZIL-OS/']) expect((await openUrl(url)).status).toBe(200);
        expect(ids.size).toBe(1);
    });

    it.each([
        ['http://github.com/a/b.git'], ['https://u:p@github.com/a/b.git'], ['https://github.com/a/b.git?x=1'], ['https://evil.example/a/b.git'],
        ['https://github.com/a/../b.git'], ['file:///etc/passwd'], [42], [null],
    ])('%j is repo_url_invalid (400) before ANYTHING is read', async url => {
        const response = await post({ computerId: COMPUTER, intent: 'open', repository: url === null ? { url: null } : { url } });
        expect(response.status).toBe(400);
        expect((await response.json()).error.code).toBe('repo_url_invalid');
        expect(s.order).toEqual([]);
        expect(s.requests).toEqual([]);
    });

    it('a repository object with extra keys is invalid; a project and a repository together are refused', async () => {
        expect((await post({ computerId: COMPUTER, intent: 'open', repository: { url: GH, folder: '/etc' } })).status).toBe(400);
        const both = await post({ computerId: COMPUTER, intent: 'open', repository: { url: GH }, project: { projectId: PROJECT, repoId: REPO } });
        expect(both.status).toBe(400);
        expect((await both.json()).error.code).toBe('repo_url_invalid');
        expect(s.order).toEqual([]);
    });

    it('an EZiL Git address is repo_url_unsupported (409) before anything is read', async () => {
        const response = await openUrl('https://git-qa.ezil.work/acme-qa/site.git');
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_url_unsupported');
        expect(s.order).toEqual([]);
    });

    it('outside os-staging (any other funding origin, or none) it is repo_url_not_enabled (409) with nothing read or woken', async () => {
        for (const funding of ['https://ai.ezil.work', '']) {
            vi.stubEnv('BILLING_FUNDING_URL', funding);
            s.order = []; s.requests = [];
            const response = await openUrl();
            expect(response.status).toBe(409);
            expect((await response.json()).error.code).toBe('repo_url_not_enabled');
            expect(s.order).toEqual([]);
            expect(s.requests).toEqual([]);
        }
    });

    it("another person's computer is NOT_FOUND, and GitHub, the mint and the Worker are never reached", async () => {
        s.owned = false;
        expect((await openUrl()).status).toBe(404);
        expect(s.order).toEqual(['computer.get']);
        expect(s.requests).toEqual([]);
    });

    it('an AWS computer is repo_open_unsupported_provider (409) before GitHub or the mint (contract §8: no host op yet)', async () => {
        s.aws = [true];
        const response = await openUrl();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_unsupported_provider');
        expect(s.order).toEqual(['computer.get', 'target']);
        expect(s.requests).toEqual([]);
    });

    it.each([[404], [401], [403]])("GitHub %i: \"This repository doesn't exist.\" (404) and the computer is never woken for it", async status => {
        s.github = () => new Response('Repository not found.', { status, headers: { 'content-type': 'text/plain' } });
        const response = await openUrl();
        expect(response.status).toBe(404);
        const body = await response.json();
        expect(body.error).toMatchObject({ code: 'repo_not_found', message: "This repository doesn't exist." });
        expect(s.order).toEqual(['computer.get', 'target', 'github']);
    });

    it.each([
        ['moved', () => new Response(null, { status: 301, headers: { location: 'https://github.com/a/c.git' } }), 409, 'repo_url_moved'],
        ['empty', () => new Response(advertisement(null), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }), 409, 'repo_url_empty'],
        ['unreachable', () => new Response('busy', { status: 503, headers: { 'content-type': 'text/plain' } }), 503, 'repo_url_unavailable'],
    ] as const)('GitHub %s is %s/%s, distinguishable from a missing repository, and never wakes the computer', async (_name, answer, status, code) => {
        s.github = answer;
        const response = await openUrl();
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
        expect(s.order).not.toContain('codePreviewUrl');
    });

    it('a not-ready computer answers the mint unchanged (the shell\'s wake loop retries), and the Worker is not asked', async () => {
        s.preview = { ok: false, errorCode: 'sandbox_starting', retryAfterMs: 2000 };
        const response = await openUrl();
        expect(await response.json()).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
        expect(s.order).not.toContain('worker');
    });

    it('a Worker folder for another repository, or a failed open, never yields a folder= URL', async () => {
        s.worker = () => Response.json({ folder: `/workspace/projects/${REPO}` });
        let response = await openUrl();
        expect(response.status).toBe(502);
        expect((await response.json()).error.code).toBe('repo_open_failed');
        s.worker = () => Response.json({ ok: false, error: 'repo_open_auth_failed' }, { status: 409 });
        response = await openUrl();
        expect(response.status).toBe(502);
        expect(JSON.stringify(await response.json())).not.toContain('folder=');
    });

    it('a computer that moved to AWS between the mint and the open is refused, never signed for as Cloudflare', async () => {
        s.aws = [false, true];
        const response = await openUrl();
        expect(response.status).toBe(409);
        expect(s.order).toEqual(['computer.get', 'target', 'github', 'codePreviewUrl', 'target']);
    });
});
