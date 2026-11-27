/**
 * `POST /api/shell/code-preview-url` with `repository: {url}` (founder 547ed35a: `/app/code?repo=<https URL>`).
 *
 * Same boundaries as route-project.test.ts: the tRPC caller and the placement read are stubbed; the resolver
 * (`@/server/git/repo-url`) and the Worker client (`@/server/lib/compute/repo-open`) are REAL behind one stubbed
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
const PRIVATE_GIT_TOKEN = 'opaque-gateway-credential';
const EZIL_URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
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
    sessionId: 'session-a',
    swapSessionOnMint: false,
    aws: [false, false] as boolean[],
    migration: null as null | { id: string; state: string; userId: string; computerId: string;
        fromProvider: string; toProvider: string; updatedAt?: string },
    preview: { ok: true } as Record<string, unknown>,
    /** How long the stubbed Code mint takes, ms of `Date.now()`. */
    mintTakes: 0,
    skew: 0,
    universe: null as null | ((body: unknown) => Response),
    worker: null as null | ((body: string) => Response),
    github: null as null | ((url: URL, init: RequestInit) => Response),
    gateway: null as null | ((scope: 'read' | 'write') => Response),
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
        s.order.push('codePreviewUrl'); s.mintInputs.push(input); s.skew += s.mintTakes;
        if (s.swapSessionOnMint) s.sessionId = 'session-b';
        return s.preview;
    } },
}) } }));
vi.mock('@/server/auth/retained-identity', () => ({
    retainedIdentity: async (userId: string) => {
        s.order.push('identity');
        if (s.identity === 'missing' || userId !== USER) throw new Error('IDENTITY_REFRESH_REQUIRED');
        return { token: ID_TOKEN, issuer: 'https://id.ezil.work/', subject: 'auth0|builder', expiresAt: Date.now() + 3_600_000, userId: USER, sessionId: s.sessionId,
            gitAuthor: { name: 'contact', email: 'contact@ezil.work' } };
    },
    clearProjectIdentity: async () => { s.cleared += 1; },
}));
vi.mock('@/server/lib/compute/provider-migrate-store', () => ({
    createProviderMigrationStore: () => ({ readByComputer: async () => s.migration }),
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
const standalonePacket = (scope: 'read' | 'write') => ({ version: 2,
    repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: EZIL_URL, ref: 'refs/heads/main' },
    identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|builder' },
    git: { username: 'ezil', token: PRIVATE_GIT_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope } });

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
    Object.assign(s, { order: [], owned: true, identity: 'ok', sessionId: 'session-a', swapSessionOnMint: false,
        aws: [false, false], migration: null, requests: [], cleared: 0, mintTakes: 0, skew: 0, mintInputs: [],
        preview: { ok: true, correlationId: 'c', codePreviewUrl: MINTED, expiresAt: Date.now() + 300_000, provider: 'cloudflare-guacamole' },
        universe: () => Response.json(grant()),
        worker: () => Response.json({ folder: `/workspace/projects/${REPO}`, head: 'b'.repeat(40) }),
        gateway: (scope: 'read' | 'write') => Response.json(standalonePacket(scope)),
        github: () => new Response(advertisement('refs/heads/main'), { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement' } }) });
    vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', UNIVERSE);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', SECRET);
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work'); // os-staging: the Worker opens public github.com
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init: RequestInit = {}) => {
        const url = new URL(String(input));
        s.requests.push({ url, init });
        if (url.origin === UNIVERSE || (url.origin === 'https://universe-staging.ezil.work' || url.origin === 'https://universe.ezil.work')) { s.order.push('universe'); return s.universe!(JSON.parse(String(init.body))); }
        if (url.origin === WORKER) { s.order.push('worker'); return s.worker!(String(init.body)); }
        if (url.origin === 'https://github.com') { s.order.push('github'); return s.github!(url, init); }
        if (url.origin === 'https://github.ezil.work') { s.order.push('gateway'); return s.gateway!(JSON.parse(String(init.body)).scope); }
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
    for (const secret of [GIT_TOKEN, PRIVATE_GIT_TOKEN, 'art_v1_', 'egg_', ID_TOKEN, 'eyJ', ACCOUNT, 'artifacts.cloudflare.net']) {
        expect(text).not.toContain(secret);
        expect(logged).not.toContain(secret);
    }
}


const GH = 'https://github.com/EZiLHQ/ezil-os.git';
const CANONICAL = 'https://github.com/ezilhq/ezil-os.git';
const openUrl = (url: unknown = GH) => post({ computerId: COMPUTER, intent: 'open', repository: { url } });

describe('opening a repository from its address in Code', () => {
    it('ownership, provider, GitHub, mint, Worker: in that order; answers the folder URL and the name, nothing secret', async () => {
        const { repositoryIdFor } = await import('@/server/git/repo-url');
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
        // Built on a literal origin from the parsed parts: nothing the caller typed names the scheme, host, userinfo or port.
        expect([gh.url.protocol, gh.url.hostname, gh.url.username, gh.url.password, gh.url.port]).toEqual(['https:', 'github.com', '', '', '']);
        expect(s.requests.filter(r => r.url.origin === 'https://github.com')).toHaveLength(1);
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

    it('production (the canonical production funding root) opens anonymously through the same ownership, provider, mint and signed Worker path', async () => {
        const { repositoryIdFor } = await import('@/server/git/repo-url');
        const id = repositoryIdFor(CANONICAL);
        s.worker = () => Response.json({ folder: `/workspace/projects/${id}`, head: 'b'.repeat(40) });
        for (const funding of ['https://ai.ezil.work', 'https://ai.ezil.work/']) {
            vi.stubEnv('BILLING_FUNDING_URL', funding);
            Object.assign(s, { order: [], requests: [], mintInputs: [], aws: [false, false] });
            const response = await openUrl();
            expect(response.status).toBe(200);
            expect(s.order).toEqual(['computer.get', 'target', 'github', 'codePreviewUrl', 'target', 'worker']);
            expect(s.mintInputs).toEqual([{ computerId: COMPUTER, intent: 'open' }]);
            const gh = s.requests.find(r => r.url.origin === 'https://github.com')!;
            expect(JSON.stringify(gh.init.headers).toLowerCase()).not.toContain('authorization');
            const worker = s.requests.find(r => r.url.origin === WORKER)!;
            expect(JSON.parse(String(worker.init.body))).toStrictEqual({ repositoryId: id, canonicalURL: CANONICAL, ref: 'refs/heads/main', timeoutMs: 130_000 });
            const [, claims64, sig] = (worker.init.headers as Record<string, string>)['x-ezil-auth'].split('.');
            const c = JSON.parse(Buffer.from(claims64, 'base64url').toString());
            const payload = ['v2', c.ts, 'POST', worker.url.pathname, c.sandboxId, c.computerId, c.userId, c.provider, c.store, c.generation, c.leaseEpoch,
                createHash('sha256').update(String(worker.init.body)).digest('hex')].join('|');
            expect(sig).toBe(createHmac('sha256', SECRET).update(payload).digest('hex'));
            await expectNoSecrets(response);
        }
        // Production keeps the ownership and AWS refusals before GitHub, the mint or the Worker.
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        Object.assign(s, { order: [], requests: [], owned: false });
        expect((await openUrl()).status).toBe(404);
        expect(s.order).toEqual(['computer.get']);
        expect(s.requests).toEqual([]);
        Object.assign(s, { order: [], requests: [], owned: true, aws: [true] });
        expect((await (await openUrl()).json()).error.code).toBe('repo_open_unsupported_provider');
        expect(s.requests).toEqual([]);
    });

    it('any other funding value (missing, malformed, a path, port, userinfo, http, padding, look-alike) is repo_url_not_enabled (409) with nothing read or woken', async () => {
        for (const funding of ['', ' https://ai.ezil.work', 'https://ai.ezil.work ', 'https://ai.ezil.work//', 'https://ai.ezil.work/v1',
            'https://ai.ezil.work?x', 'https://ai.ezil.work#x', 'https://ai.ezil.work:443', 'https://ai-staging.ezil.work:443', 'https://u@ai.ezil.work',
            'http://ai.ezil.work', 'https://AI.EZIL.WORK', 'https://ai.ezil.work.evil.com', 'https://xai.ezil.work', 'not a url', undefined]) {
            vi.stubEnv('BILLING_FUNDING_URL', funding);
            s.order = []; s.requests = [];
            const response = await openUrl();
            expect({ funding, status: response.status }).toEqual({ funding, status: 409 });
            expect((await response.json()).error.code).toBe('repo_url_not_enabled');
            expect(s.order).toEqual([]);
            expect(s.requests).toEqual([]);
        }
        // The same gate refuses a private EZiL Git address before identity or the Gateway grant.
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work:443');
        s.order = []; s.requests = [];
        expect((await (await openUrl(EZIL_URL)).json()).error.code).toBe('repo_url_not_enabled');
        expect(s.order).toEqual([]);
        expect(s.requests).toEqual([]);
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

    it('allows capability-enabled standalone AWS only with matching preview and final placement', async () => {
        vi.stubEnv('AWS_STANDALONE_REPO_OPEN_ENABLED', 'true');
        s.aws = [true, true, true, true];
        s.preview = { ...s.preview, computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 3, leaseEpoch: 1 };
        s.worker = body => Response.json({ ok: true, folder: `/workspace/projects/${JSON.parse(body).repositoryId}`, status: 'cloned' });
        const response = await post({ computerId: COMPUTER, repository: { url: EZIL_URL } });
        expect(response.status).toBe(200);
        expect(s.order).toContain('worker');
        expect(s.order).not.toContain('github');
    });
    it.each([
        { computeProvider: 'cloudflare' },
        { computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 2, leaseEpoch: 1 },
        { computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 3, leaseEpoch: 2 },
    ])('refuses a preview minted for another provider or epoch before AWS repo-open: %j', async preview => {
        vi.stubEnv('AWS_STANDALONE_REPO_OPEN_ENABLED', 'true');
        s.aws = [true, true];
        s.preview = { ...s.preview, ...preview };
        const response = await post({ computerId: COMPUTER, repository: { url: EZIL_URL } });
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_computer_changed');
        expect(s.order).not.toContain('worker');
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

describe('standalone EZiL Git URL open', () => {
    it('grants before Code wakes and sends v2 CLI packet for the owned Cloudflare computer', async () => {
        const { repositoryIdFor } = await import('@/server/git/repo-url');
        const checkout = repositoryIdFor(EZIL_URL);
        s.worker = body => Response.json({ ok: true, folder: `/workspace/projects/${JSON.parse(body).repositoryId}` });
        const response = await openUrl(EZIL_URL);
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gateway', 'identity', 'codePreviewUrl', 'identity', 'target', 'worker']);
        // An EZiL Git address never reaches the public GitHub resolver.
        expect(s.requests.some(r => r.url.origin === 'https://github.com')).toBe(false);
        const gateway = s.requests.find(r => r.url.origin === 'https://github.ezil.work')!;
        expect(gateway.url.toString()).toBe('https://github.ezil.work/v2/git/grant');
        expect(JSON.parse(String(gateway.init.body))).toEqual({ repoURL: EZIL_URL, scope: 'write' });
        expect(new Headers(gateway.init.headers).get('authorization')).toBe(`Bearer ${ID_TOKEN}`);
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(JSON.parse(String(worker.init.body))).toMatchObject({ repositoryId: checkout,
            gitAuthor: { name: 'contact', email: 'contact@ezil.work' },
            privatePacket: { version: 2, repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: EZIL_URL, ref: 'refs/heads/main' } } });
        expect(JSON.parse(String(worker.init.body)).repositoryId).not.toBe(JSON.parse(String(worker.init.body)).privatePacket.repository.id);
        await expectNoSecrets(response);
        const answer = await response.json();
        expect(answer.repository).toEqual({ name: 'default/os-code-url-20261110-a', id: checkout });
        expect(new URL(answer.codePreviewUrl).searchParams.getAll('folder')).toEqual([`/workspace/projects/${checkout}`]);
        expect(s.requests.some(r => r.url.origin === UNIVERSE)).toBe(false);
    });
    it('production: a private EZiL Git address keeps the identity, grant, session and signed private-packet path', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work/');
        s.worker = body => Response.json({ ok: true, folder: `/workspace/projects/${JSON.parse(body).repositoryId}` });
        const response = await openUrl(EZIL_URL);
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gateway', 'identity', 'codePreviewUrl', 'identity', 'target', 'worker']);
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(JSON.parse(String(worker.init.body))).toMatchObject({ privatePacket: { version: 2, repository: { canonicalURL: EZIL_URL } } });
        await expectNoSecrets(response);
        Object.assign(s, { order: [], requests: [], swapSessionOnMint: true, sessionId: 'session-a' });
        expect((await openUrl(EZIL_URL)).status).toBe(409);
        expect(s.requests.some(r => r.url.origin === WORKER)).toBe(false);
    });
    it('uses an actual read grant only after a write 403', async () => {
        s.gateway = scope => scope === 'write' ? new Response(null, { status: 403 }) : Response.json(standalonePacket('read'));
        s.worker = body => Response.json({ ok: true, folder: `/workspace/projects/${JSON.parse(body).repositoryId}` });
        expect((await openUrl(EZIL_URL)).status).toBe(200);
        expect(s.requests.filter(r => r.url.origin === 'https://github.ezil.work').map(r => JSON.parse(String(r.init.body)).scope)).toEqual(['write', 'read']);
        const worker = s.requests.find(r => r.url.origin === WORKER)!;
        expect(JSON.parse(String(worker.init.body)).privatePacket.git.scope).toBe('read');
    });
    it('a 401 requests OAuth refresh before Code wakes; an unowned computer reaches no grant', async () => {
        s.gateway = () => new Response(null, { status: 401 });
        const response = await openUrl(EZIL_URL);
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gateway']);
        expect(s.cleared).toBe(1);
        s.order = []; s.requests = []; s.owned = false;
        expect((await openUrl(EZIL_URL)).status).toBe(404);
        expect(s.order).toEqual(['computer.get']);
        expect(s.requests).toEqual([]);
    });
    it('a session switch during Code wake sends no credential to the Worker', async () => {
        s.swapSessionOnMint = true;
        const response = await openUrl(EZIL_URL);
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gateway', 'identity', 'codePreviewUrl', 'identity']);
        expect(s.requests.some(r => r.url.origin === WORKER)).toBe(false);
    });
    it('refreshes a grant made short by Code wake, preserving provider ID and ref', async () => {
        s.mintTakes = 90_000;
        s.gateway = scope => Response.json({ ...standalonePacket(scope), git: { ...standalonePacket(scope).git,
            expiresAt: new Date(Date.now() + 150_000).toISOString() } });
        s.worker = body => Response.json({ ok: true, folder: `/workspace/projects/${JSON.parse(body).repositoryId}` });
        expect((await openUrl(EZIL_URL)).status).toBe(200);
        expect(s.order.filter(event => event === 'gateway')).toHaveLength(2);
        const body = JSON.parse(String(s.requests.find(r => r.url.origin === WORKER)!.init.body));
        expect(Date.parse(body.privatePacket.git.expiresAt) - Date.now()).toBeGreaterThan(body.timeoutMs);
    });
});


describe('the enrolled checkout signals the protected top-level shell only after the private preload acknowledges', () => {
    it.each(['staging','production'])('releases a managed preparation\'s editor without starting its work hour at the mint on %s', async realm => {
        const { expectedRepositoryURL } = await import('@/server/git/assignment-enrollment');
        const { makeChallenge, readOpen } = await import('@/server/assignment-video/repo-open');
        const attemptId = 'ecb246af-f1b8-4c72-8e6d-414c814de821';
        const production = realm === 'production';
        const origin = production ? 'https://os.ezil.work' : 'https://os-staging.ezil.work';
        if (production) {
            vi.stubEnv('BILLING_FUNDING_URL','https://ai.ezil.work');
            vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED','1');
        }
        const subject = 'auth0|builder';
        const repositoryUrl = expectedRepositoryURL(subject, 'a-' + attemptId);
        const now = Date.now();
        const signingKey = 'test-only-repo-open-key-material'.repeat(2);
        vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN',production ? 'https://universe.ezil.work' : 'https://universe-staging.ezil.work');
        vi.stubEnv('UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET',signingKey);
        const captureSessionId = '00000000-0000-4000-8000-000000000099';
        const recordingId = '00000000-0000-4000-8000-000000000098';
        let managed: boolean | undefined = true, unlocked = false, repositoryOpenReceiptId = recordingId;
        s.universe = () => {
            const path = s.requests.at(-1)?.url.pathname;
            // Universe would refuse it here anyway: nothing in this mint may depend on the answer.
            if (path?.endsWith('/editor-ready')) return new Response(null, {status: 503});
            return Response.json(path?.endsWith('/status')
                ? {captureSessionId,recordingId,repositoryOpenReceiptId,status:'recording',revoked:false,stopRequestedAt:null,
                    startedAt:new Date(now-1000).toISOString(), deadlineAt:new Date(now+3839000).toISOString(),
                    firstFrameAt:new Date(now-1000).toISOString(),phaseReady:unlocked,workspaceUnlocked:unlocked}
                : {status:'eligible',attemptId,jobId:'9',repositoryUrl,ref:'refs/heads/main',
                    manifestSha256:makeChallenge(attemptId,repositoryUrl).manifestSha256, providerId:'fg1wtcrexaf7acl0',
                    windowStartedAt:null, deadlineAt:null, expiresAt:new Date(now+120000).toISOString(),
                    ...(managed === undefined ? {} : {editorReadySupported:managed})});
        };
        s.gateway = scope => {const packet=standalonePacket(scope);packet.repository.canonicalURL=repositoryUrl;return Response.json(packet);};
        s.worker = body => {
            const request = JSON.parse(body), challenge = request.assignmentPreload;
            const folder = '/workspace/projects/'+request.repositoryId;
            return Response.json({ok:true,folder,checkoutFolder:folder+'/'+repositoryUrl.split('/').at(-1)!.slice(0,-4),
                ...(challenge ? {assignmentPreload:{eventId:challenge.eventId,nonce:challenge.nonce,port:5679,status:'acknowledged'}} : {})});
        };
        const open = (assignment?: object) => POST(new Request(origin+'/api/shell/code-preview-url',{method:'POST',
            headers:{origin,host:new URL(origin).host,'sec-fetch-site':'same-origin','content-type':'application/json'},
            body:JSON.stringify({computerId:COMPUTER,intent:'open',repository:{url:repositoryUrl},assignment})}));
        const readyCalls = () => s.requests.filter(request => request.url.pathname.endsWith('/editor-ready')).length;
        const prepared = await open({attemptId,phase:'prepare'});
        expect(prepared.status).toBe(200);
        const body = await prepared.json();
        const actor = {userId:USER,issuer:'https://id.ezil.work/',subject,sessionId:s.sessionId,expiresAt:now+600000};
        const enter = {attemptId,phase:'open',repoOpenProof:body.assignmentOpen.proof,captureSessionId};
        repositoryOpenReceiptId = readOpen(body.assignmentOpen.proof,actor,attemptId,Date.now(),signingKey).eventId;
        // Every check before the release still applies: an unconfirmed, still locked capture gets no URL.
        expect((await open(enter)).status).toBe(409);
        unlocked = true;
        const released = await open(enter);
        expect(released.status).toBe(200);
        expect(new URL((await released.json()).codePreviewUrl).searchParams.get('folder')).toBe(body.repository.workspaceFolder);
        expect(readyCalls()).toBe(0);
        // Only Universe's own exact `true` moves the commit: an absent or false flag keeps production's eager
        // `editor-ready`, whose refusal here still withholds the URL.
        for (const value of [false, undefined]) {
            managed = value;
            const before = readyCalls();
            const refused = await open(enter);
            expect(refused.status).toBe(503);
            expect(await refused.text()).not.toContain('preview-bootstrap');
            expect(readyCalls()).toBe(before + 1);
        }
    });

    it.each(['staging','production'])('binds the same-session owner, private 5679 and signed checkout on %s', async realm => {
        const { expectedRepositoryURL } = await import('@/server/git/assignment-enrollment');
        const { makeChallenge, readOpen } = await import('@/server/assignment-video/repo-open');
        const attemptId = 'ecb246af-f1b8-4c72-8e6d-414c814de821';
        const production = realm === 'production';
        const origin = production ? 'https://os.ezil.work' : 'https://os-staging.ezil.work';
        if (production) {
            vi.stubEnv('BILLING_FUNDING_URL','https://ai.ezil.work');
            vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED','1');
        }
        const subject = 'auth0|builder';
        const repositoryUrl = expectedRepositoryURL(subject, 'a-' + attemptId);
        const now = Date.now();
        const signingKey = 'test-only-repo-open-key-material'.repeat(2);
        const enrolled = {status:'eligible',attemptId,jobId:'9',repositoryUrl,ref:'refs/heads/main',
            manifestSha256:makeChallenge(attemptId,repositoryUrl).manifestSha256, providerId:'fg1wtcrexaf7acl0',
            windowStartedAt:new Date(now-12000).toISOString(), deadlineAt:new Date(now+3480000).toISOString(),
            expiresAt:new Date(now+120000).toISOString()};
        vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN',production ? 'https://universe.ezil.work' : 'https://universe-staging.ezil.work');
        vi.stubEnv('UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET',signingKey);
        const captureSessionId = '00000000-0000-4000-8000-000000000099';
        const recordingId = '00000000-0000-4000-8000-000000000098';
        let ready = false;
        let repositoryOpenReceiptId = recordingId;
        let boundProvider = enrolled.providerId;
        let clockReady = false;
        s.universe = () => {
            const path = s.requests.at(-1)?.url.pathname;
            if (path?.endsWith('/editor-ready')) {
                return clockReady ? Response.json({serverNow:new Date(now).toISOString(), startedAt:new Date(now-1000).toISOString(),
                    deadlineAt:new Date(now+3400000).toISOString(), revision:1, remainingMs:3400000, pausedAt:null, pauseReason:null})
                    : new Response(null, {status: 503});
            }
            return Response.json(path?.endsWith('/status')
                ? {captureSessionId,recordingId,repositoryOpenReceiptId,status:'recording',revoked:false,stopRequestedAt:null,
                    startedAt:new Date(now-1000).toISOString(), deadlineAt:new Date(now+3400000).toISOString(),
                    firstFrameAt:ready ? new Date(now-1000).toISOString() : null,phaseReady:ready,workspaceUnlocked:ready}
                : {...enrolled,providerId:boundProvider,windowStartedAt:null,deadlineAt:null});
        };
        s.gateway = scope => {const packet=standalonePacket(scope);packet.repository.canonicalURL=repositoryUrl;return Response.json(packet);};
        let ack: 'good'|'missing'|'wrong'|'wrong-folder' = 'good';
        s.worker = body => {
            const request = JSON.parse(body), challenge = request.assignmentPreload;
            const folder = '/workspace/projects/'+request.repositoryId;
            return Response.json({ok:true,folder,checkoutFolder:folder+'/'+(ack === 'wrong-folder' ? 'repository' : repositoryUrl.split('/').at(-1)!.slice(0,-4)),
                ...(challenge && ack !== 'missing' ? {assignmentPreload:{eventId:challenge.eventId,nonce:ack === 'wrong' ? '1'.repeat(64) : challenge.nonce,
                    port:5679,status:'acknowledged'}} : {})});
        };
        const open = (assignment?: object) => POST(new Request(origin+'/api/shell/code-preview-url',{method:'POST',
            headers:{origin,host:new URL(origin).host,'sec-fetch-site':'same-origin','content-type':'application/json'},
            body:JSON.stringify({computerId:COMPUTER,intent:'open',repository:{url:repositoryUrl},assignment})}));
        const prep = {attemptId,phase:'prepare'};
        const locked = async (response: Response) => {
            expect(response.status).toBe(409);
            expect(await response.text()).not.toContain('preview-bootstrap');
        };
        await locked(await open());
        const first = await open(prep);
        expect(first.status).toBe(200);
        const body = await first.json();
        expect(body.codePreviewUrl).toBeUndefined();
        expect(body.url).toBeUndefined();
        expect(body.repository.checkoutFolder).toBe(body.repository.workspaceFolder+'/'+repositoryUrl.split('/').at(-1)!.slice(0,-4));
        const proof = body.assignmentOpen;
        expect(proof).toMatchObject({attemptId,deadlineAt:null,windowStartedAt:null});
        const actor = {userId:USER,issuer:'https://id.ezil.work/',subject,sessionId:s.sessionId,expiresAt:now+600000};
        expect(readOpen(proof.proof,actor,attemptId,Date.now(),signingKey)).toMatchObject({repositoryUrl,providerId:enrolled.providerId,manifestSha256:enrolled.manifestSha256});
        const enter = {attemptId,phase:'open',repoOpenProof:proof.proof,captureSessionId};
        await locked(await open(enter));
        ready=true;
        await locked(await open({...enter,repoOpenProof:'A'.repeat(80)}));
        await locked(await open({...enter,captureSessionId:recordingId}));
        await locked(await open(enter));
        expect(s.requests.some(request => request.url.pathname.endsWith('/editor-ready'))).toBe(false);
        repositoryOpenReceiptId=readOpen(proof.proof,actor,attemptId,Date.now(),signingKey).eventId;
        const unavailable = await open(enter);
        expect(unavailable.status).toBe(503);
        expect(await unavailable.text()).not.toContain('preview-bootstrap');
        clockReady = true;
        const confirmed=await open(enter);
        expect(confirmed.status).toBe(200);
        const unlocked=await confirmed.json();
        expect(new URL(unlocked.codePreviewUrl).searchParams.get('folder')).toBe(body.repository.workspaceFolder);
        expect(unlocked.repository).toEqual(body.repository);
        for (const response of ['missing','wrong','wrong-folder'] as const) {
            ack=response;
            await locked(await open(prep));
            await locked(await open(enter));
        }
        ack='good';
        boundProvider='different';
        await locked(await open(prep));
    });
});

describe('a reserved assignment repository whose computer or Universe is not ready yet', () => {
    const attemptId = 'ecb246af-f1b8-4c72-8e6d-414c814de821';
    const subject = 'auth0|builder';
    const origin = 'https://os.ezil.work';
    const signingKey = 'test-only-repo-open-key-material'.repeat(2);
    const captureSessionId = '00000000-0000-4000-8000-000000000099';
    const recordingId = '00000000-0000-4000-8000-000000000098';
    async function enrolledFixture() {
        const { expectedRepositoryURL } = await import('@/server/git/assignment-enrollment');
        const { makeChallenge } = await import('@/server/assignment-video/repo-open');
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        vi.stubEnv('EZIL_ASSIGNMENT_PRODUCTION_ENABLED', '1');
        vi.stubEnv('UNIVERSE_PROJECT_REPO_ORIGIN', 'https://universe.ezil.work');
        vi.stubEnv('UNIVERSE_ASSIGNMENT_REPO_OPEN_SECRET', signingKey);
        const repositoryUrl = expectedRepositoryURL(subject, 'a-' + attemptId);
        const now = Date.now();
        const enrolled = { status: 'eligible', attemptId, jobId: '9', repositoryUrl, ref: 'refs/heads/main',
            manifestSha256: makeChallenge(attemptId, repositoryUrl).manifestSha256, providerId: 'fg1wtcrexaf7acl0',
            windowStartedAt: null, deadlineAt: null, expiresAt: new Date(now + 120000).toISOString() };
        const universe = { preflight: () => Response.json(enrolled) as Response, status: () => Response.json({}) as Response,
            ready: () => new Response(null, {status: 503}) };
        s.universe = () => {
            const path = s.requests.at(-1)?.url.pathname;
            return (path?.endsWith('/status') ? universe.status : path?.endsWith('/editor-ready') ? universe.ready : universe.preflight)();
        };
        s.gateway = scope => { const packet = standalonePacket(scope); packet.repository.canonicalURL = repositoryUrl; return Response.json(packet); };
        s.worker = body => {
            const request = JSON.parse(body), challenge = request.assignmentPreload;
            const folder = '/workspace/projects/' + request.repositoryId;
            return Response.json({ ok: true, folder, checkoutFolder: folder + '/' + repositoryUrl.split('/').at(-1)!.slice(0, -4),
                ...(challenge ? { assignmentPreload: { eventId: challenge.eventId, nonce: challenge.nonce, port: 5679, status: 'acknowledged' } } : {}) });
        };
        const open = (assignment?: object) => POST(new Request(origin + '/api/shell/code-preview-url', { method: 'POST',
            headers: { origin, host: new URL(origin).host, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
            body: JSON.stringify({ computerId: COMPUTER, intent: 'open', repository: { url: repositoryUrl }, assignment }) }));
        return { open, universe, enrolled, repositoryUrl, prep: { attemptId, phase: 'prepare' }, now };
    }

    it('prepares a migrated AWS assignment only with exact trusted upgrade, placement and private host evidence', async () => {
        const { open, prep, universe, enrolled, repositoryUrl, now } = await enrolledFixture();
        const { readOpen, workspaceIdentity } = await import('@/server/assignment-video/repo-open');
        vi.stubEnv('AWS_STANDALONE_REPO_OPEN_ENABLED', '1');
        const operation = '99999999-9999-4999-8999-999999999999';
        const verified = { ...enrolled, upgradedWorkspaceId: workspaceIdentity(USER, COMPUTER, SANDBOX), upgradeOperationId: operation };
        s.migration = { id: operation, state: 'committed', userId: USER, computerId: COMPUTER,
            fromProvider: 'cloudflare', toProvider: 'aws-ec2' };
        Object.assign(s.preview, {computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 3, leaseEpoch: 1});
        const prepare = () => { s.aws = Array<boolean>(6).fill(true); return open(prep); };
        for (const enrollment of [enrolled, {...verified, upgradedWorkspaceId: '0'.repeat(64)},
            {...verified, upgradeOperationId: COMPUTER}]) {
            universe.preflight = () => Response.json(enrollment);
            s.order = [];
            const response = await prepare();
            expect(response.status).toBe(409);
            expect(s.order).not.toContain('codePreviewUrl');
            expect(s.order).not.toContain('worker');
        }
        universe.preflight = () => Response.json(verified);
        s.worker = body => {
            const { repositoryId, assignmentPreload } = JSON.parse(body);
            const folder = '/workspace/projects/' + repositoryId;
            return Response.json({ok: true, status: 'fetched', folder,
                checkoutFolder: folder + '/' + repositoryUrl.split('/').at(-1)!.slice(0, -4),
                assignmentPreload: { eventId: assignmentPreload.eventId, nonce: assignmentPreload.nonce,
                    port: 5679, status: 'acknowledged' }});
        };
        const prepared = await prepare();
        expect(prepared.status).toBe(200);
        const preparation = await prepared.json();
        expect(preparation).toMatchObject({ok: true, assignmentOpen: {attemptId}});
        expect(preparation.codePreviewUrl).toBeUndefined();
        const proof = preparation.assignmentOpen.proof;
        const actor = { userId: USER, issuer: 'https://id.ezil.work/', subject, sessionId: s.sessionId, expiresAt: now + 600000 };
        const receipt = readOpen(proof, actor, attemptId, Date.now(), signingKey).eventId;
        universe.status = () => Response.json({captureSessionId, recordingId, repositoryOpenReceiptId: receipt, status: 'recording',
            revoked: false, stopRequestedAt: null, startedAt: new Date(now-1000).toISOString(),
            deadlineAt: new Date(now+3480000).toISOString(), firstFrameAt: new Date(now-1000).toISOString(),
            phaseReady: true, workspaceUnlocked: true});
        universe.ready = () => Response.json({startedAt: new Date(now).toISOString(), deadlineAt: new Date(now+3480000).toISOString(),
            serverNow: new Date(now).toISOString(), revision: 2, remainingMs: 3480000, pausedAt: null, pauseReason: null});
        s.aws = Array<boolean>(6).fill(true);
        const reopened = await open({phase: 'open', attemptId, captureSessionId, repoOpenProof: proof});
        expect(reopened.status).toBe(200);
        expect(new URL((await reopened.json()).codePreviewUrl).searchParams.get('folder')).toBe(preparation.repository.workspaceFolder);
        expect(s.requests.at(-1)?.url.pathname).toBe('/internal/assignment-video/editor-ready');
        // Old host results never mint proof or expose the preloaded Code URL.
        s.worker = body => Response.json({ ok: true, status: 'fetched',
            folder: '/workspace/projects/' + JSON.parse(body).repositoryId });
        const blocked = await prepare();
        expect(blocked.ok).toBe(false);
        expect(await blocked.text()).not.toContain('preview-bootstrap');
    });

    it('starts a direct AWS assignment only from Universe\'s bound workspace on the current placement, and keeps Cloudflare and migration as they were', async () => {
        const { open, prep, universe, enrolled, repositoryUrl, now } = await enrolledFixture();
        const { readOpen, sealOpen, workspaceIdentity } = await import('@/server/assignment-video/repo-open');
        const foreign = '0'.repeat(64);
        // Cloudflare ignores the field entirely: the same prepare as before the field existed.
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: foreign });
        const onCloudflare = await open(prep);
        expect(onCloudflare.status).toBe(200);
        expect(await onCloudflare.json()).toMatchObject({ ok: true, assignmentOpen: { attemptId } });

        vi.stubEnv('AWS_STANDALONE_REPO_OPEN_ENABLED', '1');
        Object.assign(s.preview, { computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 3, leaseEpoch: 1 });
        const workspace = workspaceIdentity(USER, COMPUTER, SANDBOX);
        const prepare = (aws = Array<boolean>(6).fill(true)) => { s.aws = aws; return open(prep); };
        const started = { windowStartedAt: new Date(now - 1000).toISOString(), deadlineAt: new Date(now + 3480000).toISOString() };
        const operation = '99999999-9999-4999-8999-999999999999';
        const committed = { id: operation, state: 'committed', userId: USER, computerId: COMPUTER, fromProvider: 'cloudflare', toProvider: 'aws-ec2' };
        const refused = async (enrollment: object, migration: typeof s.migration = null) => {
            universe.preflight = () => Response.json(enrollment);
            s.migration = migration; s.order = [];
            const response = await prepare();
            expect(response.status).toBe(409);
            expect((await response.json()).error.code).toBe('assignment_aws_unverified');
            expect(s.order).not.toContain('codePreviewUrl');
            expect(s.order).not.toContain('worker');
        };
        await refused(enrolled); // an older Universe: the field is absent
        await refused({ ...enrolled, boundWorkspaceId: 'not-a-workspace' });
        await refused({ ...enrolled, boundWorkspaceId: foreign });
        await refused({ ...enrolled, boundWorkspaceId: foreign, ...started });
        await refused({ ...enrolled, boundWorkspaceId: null, ...started }); // null is a first opening only
        await refused({ ...enrolled, boundWorkspaceId: null }, { ...committed, state: 'exported' });
        await refused({ ...enrolled, boundWorkspaceId: workspace, ...started }, { ...committed, state: 'provisioning' });
        // A committed migration still has to name this workspace, and a foreign binding cannot ride along with it.
        const migrated = { ...enrolled, upgradedWorkspaceId: workspace, upgradeOperationId: operation };
        await refused({ ...migrated, boundWorkspaceId: foreign }, committed);
        await refused({ ...migrated, upgradedWorkspaceId: foreign }, committed);
        await refused({ ...enrolled, boundWorkspaceId: null }, { ...committed, state: 'failed_needs_operator' });
        // A move that committed DURING the running assignment is not a plain AWS computer: only verified upgrade metadata opens it.
        const pg = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', '+00');
        const bound = { ...enrolled, boundWorkspaceId: workspace, ...started };
        for (const updatedAt of [pg(now - 500), pg(now - 1000), new Date(now - 500).toISOString(), 'yesterday', '', undefined])
            await refused(bound, { ...committed, updatedAt });
        const earlier = { ...committed, updatedAt: pg(now - 60000) };
        // The binding is read again after the mint: one that changed meanwhile never reaches the Worker.
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: s.order.includes('codePreviewUrl') ? foreign : null });
        s.migration = null; s.order = [];
        const raced = await prepare();
        expect(raced.status).toBe(409);
        expect(s.order).toContain('codePreviewUrl');
        expect(s.order).not.toContain('worker');

        // The first opening: Universe has bound nothing and started no clock.
        s.migration = null;
        s.worker = body => {
            const { repositoryId, assignmentPreload } = JSON.parse(body);
            const folder = '/workspace/projects/' + repositoryId;
            return Response.json({ ok: true, status: 'fetched', folder, checkoutFolder: folder + '/' + repositoryUrl.split('/').at(-1)!.slice(0, -4),
                assignmentPreload: { eventId: assignmentPreload.eventId, nonce: assignmentPreload.nonce, port: 5679, status: 'acknowledged' } });
        };
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: null });
        const prepared = await prepare();
        expect(prepared.status).toBe(200);
        const preparation = await prepared.json();
        expect(preparation).toMatchObject({ ok: true, assignmentOpen: { attemptId, windowStartedAt: null, deadlineAt: null } });
        expect(preparation.codePreviewUrl).toBeUndefined();
        const proof = preparation.assignmentOpen.proof;
        const actor = { userId: USER, issuer: 'https://id.ezil.work/', subject, sessionId: s.sessionId, expiresAt: now + 600000 };
        const receipt = readOpen(proof, actor, attemptId, Date.now(), signingKey).eventId;
        const editorReady = () => s.requests.filter(request => request.url.pathname.endsWith('/editor-ready')).length;
        universe.status = () => Response.json({ captureSessionId, recordingId, repositoryOpenReceiptId: receipt, status: 'recording',
            revoked: false, stopRequestedAt: null, startedAt: new Date(now - 1000).toISOString(),
            deadlineAt: new Date(now + 3480000).toISOString(), firstFrameAt: new Date(now - 1000).toISOString(),
            phaseReady: true, workspaceUnlocked: true });
        universe.ready = () => Response.json({ startedAt: new Date(now).toISOString(), deadlineAt: new Date(now + 3480000).toISOString(),
            serverNow: new Date(now).toISOString(), revision: 2, remainingMs: 3480000, pausedAt: null, pauseReason: null });
        const enter = { phase: 'open', attemptId, captureSessionId, repoOpenProof: proof };
        const enterOpen = (assignment: object = enter, aws?: boolean[]) => { s.aws = aws ?? Array<boolean>(6).fill(true); return open(assignment); };

        // A proof sealed for another workspace never starts the editor or the clock.
        const elsewhere = sealOpen(actor, enrolled as never, COMPUTER, 'guac-9999999999994999-8888888888884888', receipt, Date.now(), signingKey).proof;
        expect((await enterOpen({ ...enter, repoOpenProof: elsewhere })).status).toBe(409);
        expect(editorReady()).toBe(0);
        // The computer moved or was replaced between the proof and the open: refused before the Worker or the clock.
        s.preview.sandboxId = 'guac-3333333333334333-4444444444444444';
        s.order = [];
        expect((await enterOpen()).status).toBe(409);
        expect(s.order).not.toContain('worker');
        s.preview.sandboxId = SANDBOX;
        s.order = [];
        expect((await enterOpen(enter, [true, false, false, false, false, false])).status).toBe(409);
        expect(s.order).not.toContain('worker');
        expect(editorReady()).toBe(0);

        const reopened = await enterOpen();
        expect(reopened.status).toBe(200);
        expect(new URL((await reopened.json()).codePreviewUrl).searchParams.get('folder')).toBe(preparation.repository.workspaceFolder);
        expect(editorReady()).toBe(1);

        // The same attempt again, now that its clock runs and Universe bound this workspace: the same window, not a new one.
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: workspace, ...started });
        const retried = await prepare();
        expect(retried.status).toBe(200);
        expect(await retried.json()).toMatchObject({ ok: true, assignmentOpen: { attemptId, ...started } });
        // ...also when the computer moved to AWS strictly before that window began.
        s.migration = earlier;
        expect((await prepare()).status).toBe(200);
        // A fresh attempt on a computer that moved to AWS earlier is eligible: nothing was running during the move.
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: null });
        s.migration = { ...committed, updatedAt: pg(now + 1000) };
        expect((await prepare()).status).toBe(200);

        // A committed migration of this workspace keeps working, whenever it committed.
        universe.preflight = () => Response.json(migrated);
        s.migration = committed;
        expect((await prepare()).status).toBe(200);
        universe.preflight = () => Response.json({ ...migrated, ...started });
        s.migration = { ...committed, updatedAt: pg(now - 500) };
        expect((await prepare()).status).toBe(200);

        // An old host that cannot acknowledge the private nonce never mints a proof or a Code URL.
        s.worker = body => Response.json({ ok: true, status: 'fetched', folder: '/workspace/projects/' + JSON.parse(body).repositoryId });
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: null });
        s.migration = null;
        const old = await prepare();
        expect(old.ok).toBe(false);
        expect(await old.text()).not.toContain('preview-bootstrap');
    });

    it('seals a Universe-workspace-started AWS attempt only at its first prepare, inside its valid running window', async () => {
        const { open, prep, universe, enrolled, repositoryUrl, now } = await enrolledFixture();
        const { readOpen, workspaceIdentity } = await import('@/server/assignment-video/repo-open');
        vi.stubEnv('AWS_STANDALONE_REPO_OPEN_ENABLED', '1');
        Object.assign(s.preview, { computeProvider: 'aws-ec2', sandboxId: SANDBOX, generation: 3, leaseEpoch: 1 });
        const workspace = workspaceIdentity(USER, COMPUTER, SANDBOX), foreign = '0'.repeat(64);
        const iso = (ms: number) => new Date(ms).toISOString();
        const started = { windowStartedAt: iso(now - 30000), deadlineAt: iso(now + 3570000) };
        const fresh = { ...enrolled, boundWorkspaceId: null, ...started, startMode: 'workspace' };
        const operation = '99999999-9999-4999-8999-999999999999';
        const committed = { id: operation, state: 'committed', userId: USER, computerId: COMPUTER, fromProvider: 'cloudflare', toProvider: 'aws-ec2' };
        const pg = (ms: number) => iso(ms).replace('T', ' ').replace('Z', '+00');
        const run = (assignment: object) => { s.aws = Array<boolean>(6).fill(true); return open(assignment); };
        const refused = async (enrollment: object, migration: typeof s.migration = null, assignment: object = prep) => {
            universe.preflight = () => Response.json(enrollment);
            s.migration = migration; s.order = [];
            const response = await run(assignment);
            expect(response.status).toBe(409);
            expect((await response.json()).error.code).toBe('assignment_aws_unverified');
            expect(s.order).not.toContain('codePreviewUrl');
            expect(s.order).not.toContain('worker');
        };
        // The existing refusal is untouched: a running window with no binding and no mode, or any other mode.
        await refused({ ...enrolled, boundWorkspaceId: null, ...started });
        await refused({ ...fresh, startMode: 'tab' });
        await refused({ ...fresh, startMode: 'Workspace' });
        await refused({ ...fresh, startMode: true });
        // The mode never widens a binding: an older Universe (no field), a foreign or malformed one stay refused.
        const { boundWorkspaceId: _absent, ...older } = fresh;
        await refused(older);
        await refused({ ...fresh, boundWorkspaceId: foreign });
        await refused({ ...fresh, boundWorkspaceId: 'not-a-workspace' });
        // Only a valid running window: not paused, not ended, not yet to begin, not longer than an unextended hour.
        await refused({ ...fresh, pausedAt: iso(now - 1000), pauseReason: 'system_upgrade', revision: 1, remainingMs: 3000000, serverNow: iso(now) });
        await refused({ ...fresh, deadlineAt: iso(now - 1) });
        await refused({ ...fresh, windowStartedAt: iso(now + 60000) });
        await refused({ ...fresh, deadlineAt: iso(now + 3 * 3600000) });
        await refused({ ...fresh, windowStartedAt: null });
        await refused({ ...fresh, deadlineAt: null });
        // The settled-migration safeguards hold: an unfinished move, an operator hold, or a move during the running window.
        await refused(fresh, { ...committed, state: 'provisioning' });
        await refused(fresh, { ...committed, state: 'failed_needs_operator' });
        for (const updatedAt of [pg(now - 5000), pg(now - 30000), 'yesterday', undefined]) await refused(fresh, { ...committed, updatedAt });
        // Upgrade metadata keeps its own exact rule and gains nothing from the mode.
        await refused({ ...fresh, upgradedWorkspaceId: foreign, upgradeOperationId: operation }, committed);

        s.worker = body => {
            const { repositoryId, assignmentPreload } = JSON.parse(body);
            const folder = '/workspace/projects/' + repositoryId;
            return Response.json({ ok: true, status: 'fetched', folder, checkoutFolder: folder + '/' + repositoryUrl.split('/').at(-1)!.slice(0, -4),
                assignmentPreload: { eventId: assignmentPreload.eventId, nonce: assignmentPreload.nonce, port: 5679, status: 'acknowledged' } });
        };
        // The binding is read again after the mint: a workspace Universe bound elsewhere meanwhile never reaches the Worker.
        universe.preflight = () => Response.json(s.order.includes('codePreviewUrl') ? { ...fresh, boundWorkspaceId: foreign } : fresh);
        s.migration = null; s.order = [];
        const raced = await run(prep);
        expect(raced.status).toBe(409);
        expect(s.order).toContain('codePreviewUrl');
        expect(s.order).not.toContain('worker');

        // The first prepare of the workspace-started attempt: sealed for this workspace, carrying Universe's own window.
        universe.preflight = () => Response.json(fresh);
        s.migration = { ...committed, updatedAt: pg(now - 60000) }; // moved to AWS strictly before the window began
        const prepared = await run(prep);
        expect(prepared.status).toBe(200);
        const preparation = await prepared.json();
        expect(preparation).toMatchObject({ ok: true, assignmentOpen: { attemptId, ...started } });
        expect(preparation.codePreviewUrl).toBeUndefined();
        expect(preparation.url).toBeUndefined();
        const proof = preparation.assignmentOpen.proof;
        const actor = { userId: USER, issuer: 'https://id.ezil.work/', subject, sessionId: s.sessionId, expiresAt: now + 600000 };
        const opened = readOpen(proof, actor, attemptId, Date.now(), signingKey);
        expect(opened.workspaceId).toBe(workspace);

        // The mode opens nothing by itself: the editor still needs the workspace `begin` bound, the recorded first frame
        // and `editor-ready`, which answers with the window Universe started, never a new one.
        const editorReady = () => s.requests.filter(request => request.url.pathname.endsWith('/editor-ready')).length;
        universe.status = () => Response.json({ captureSessionId, recordingId, repositoryOpenReceiptId: opened.eventId, status: 'recording',
            revoked: false, stopRequestedAt: null, ...{ startedAt: started.windowStartedAt, deadlineAt: started.deadlineAt },
            firstFrameAt: iso(now - 1000), phaseReady: true, workspaceUnlocked: true });
        universe.ready = () => Response.json({ startedAt: started.windowStartedAt, deadlineAt: started.deadlineAt,
            serverNow: iso(now), revision: 0, remainingMs: 3570000, pausedAt: null, pauseReason: null });
        const enter = { phase: 'open', attemptId, captureSessionId, repoOpenProof: proof };
        await refused(fresh, null, enter);
        expect(editorReady()).toBe(0);
        universe.preflight = () => Response.json({ ...enrolled, boundWorkspaceId: workspace, ...started });
        s.migration = null;
        const entered = await run(enter);
        expect(entered.status).toBe(200);
        expect(new URL((await entered.json()).codePreviewUrl).searchParams.get('folder')).toBe(preparation.repository.workspaceFolder);
        expect(editorReady()).toBe(1);
    });

    it('a cold computer answers its wake fields only (no Universe, no Worker, no URL, no capability), so the wake loop waits', async () => {
        const { open, prep } = await enrolledFixture();
        s.preview = { ok: false, errorCode: 'sandbox_starting', error: 'sandbox_starting', retryable: true, retryAfterMs: 2000,
            provider: 'cloudflare-guacamole', computeProvider: 'cloudflare', computeLaunching: true, computePreparing: 'yes',
            reason: 'sandbox_starting', correlationId: 'srv_0123456789ab',
            codePreviewUrl: `https://code-${SANDBOX}.preview.example/preview-bootstrap?token=t`, url: MINTED, sandboxId: SANDBOX,
            assignmentOpen: { attemptId, proof: 'p'.repeat(60) }, repository: { id: 'x', checkoutFolder: '/w/x', workspaceFolder: '/w' } };
        const response = await open(prep);
        expect(response.status).toBe(200);
        await expectNoSecrets(response);
        const text = await response.clone().text();
        expect(await response.json()).toEqual({ ok: false, errorCode: 'sandbox_starting', error: 'sandbox_starting', retryable: true,
            retryAfterMs: 2000, provider: 'cloudflare-guacamole', computeProvider: 'cloudflare', computeLaunching: true,
            reason: 'sandbox_starting', correlationId: 'srv_0123456789ab' });
        for (const leak of ['preview-bootstrap', 'https://', SANDBOX, 'proof', 'assignmentOpen', 'workspaceFolder']) expect(text).not.toContain(leak);
        expect(s.order).toContain('codePreviewUrl');
        expect(s.order).not.toContain('universe');
        expect(s.order).not.toContain('worker');
    });

    it('a billing refusal passes through the same way; a free-text worker error never does; ok without a URL stays locked', async () => {
        const { open, prep } = await enrolledFixture();
        s.preview = { ok: false, error: 'billing_concurrent_limit', errorCode: 'billing_concurrent_limit', billingRefusal: 'concurrent_limit',
            provider: 'cloudflare-guacamole' };
        expect(await (await open(prep)).json()).toEqual({ ok: false, error: 'billing_concurrent_limit', errorCode: 'billing_concurrent_limit',
            provider: 'cloudflare-guacamole' });
        s.preview = { ok: false, errorCode: 'sandbox_starting', error: `Desktop ${WORKER}/sandbox/${SANDBOX} is still starting`,
            reason: 'https://worker.example', correlationId: 'not a correlation id' };
        expect(await (await open(prep)).json()).toEqual({ ok: false, errorCode: 'sandbox_starting' });
        s.preview = { ok: true };
        const locked = await open(prep);
        expect(locked.status).toBe(409);
        expect((await locked.json()).error.code).toBe('assignment_recording_required');
        expect(s.order).not.toContain('worker');
    });

    it('a failed Universe preflight is the retryable assignment_open_unavailable before any clone; a Universe refusal is not', async () => {
        const { open, prep, universe } = await enrolledFixture();
        for (const answer of [() => { throw new TypeError('fetch failed'); }, () => new Response('upstream', { status: 502 }),
            () => new Response('{', { status: 200, headers: { 'content-type': 'application/json' } })]) {
            universe.preflight = answer as () => Response;
            s.order = [];
            const response = await open(prep);
            expect(response.status).toBe(503);
            expect((await response.json()).error.code).toBe('assignment_open_unavailable');
            expect(s.order).toContain('universe');
            expect(s.order).not.toContain('worker');
        }
        universe.preflight = () => new Response(null, { status: 404 });
        s.order = [];
        const refused = await open(prep);
        expect(refused.status).toBe(409);
        expect((await refused.json()).error.code).toBe('assignment_checkout_unverified');
    });

    it('an open-phase status blip is assignment_open_unavailable; a paused phase stays assignment_recording_required', async () => {
        const { open, prep, universe, now } = await enrolledFixture();
        const { readOpen } = await import('@/server/assignment-video/repo-open');
        const prepared = await open(prep);
        expect(prepared.status).toBe(200);
        const proof = (await prepared.json()).assignmentOpen.proof;
        const actor = { userId: USER, issuer: 'https://id.ezil.work/', subject, sessionId: s.sessionId, expiresAt: now + 600000 };
        const receipt = readOpen(proof, actor, attemptId, Date.now(), signingKey).eventId;
        const enter = { attemptId, phase: 'open', repoOpenProof: proof, captureSessionId };
        universe.status = () => { throw new TypeError('fetch failed'); };
        let response = await open(enter);
        expect(response.status).toBe(503);
        expect(await response.clone().text()).not.toContain('preview-bootstrap');
        expect((await response.json()).error.code).toBe('assignment_open_unavailable');
        universe.status = () => Response.json({ captureSessionId, recordingId, repositoryOpenReceiptId: receipt, status: 'paused', revoked: false,
            stopRequestedAt: null, startedAt: new Date(now - 1000).toISOString(), deadlineAt: new Date(now + 3400000).toISOString(),
            firstFrameAt: new Date(now - 1000).toISOString(), phaseReady: false, workspaceUnlocked: false });
        response = await open(enter);
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('assignment_recording_required');
    });
});
