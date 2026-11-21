/**
 * `POST /api/shell/code-preview-url` with `repository: {url}` for a git-qa interview address (contract §6).
 *
 * The interview gate (`@/server/interview/gate`) and the Works grant (`grantForWorksGitAddress`) are stubbed so this
 * file can drive each branch; the resolver (`@/server/git/repo-url`) and the folder helpers are real. What it proves:
 * the gate is evaluated BEFORE any mint or grant and a refusal is the whole answer; `none` (not an interview) and
 * `allow` both open; the grant's `not_found` is 404 `repo_not_found`; the Worker is asked on its binding (non-packet)
 * path with the canonical git-qa remote and the grant's ref and credential, NEVER a v2 privatePacket; and no secret
 * reaches the browser or a log.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('server-only', () => ({}));

const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const ID_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.retained-id-token.sig';
const WORKS_TOKEN = `egg_${'a'.repeat(40)}`;
const QA_URL = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const INTERVIEW = '7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13';
const MINTED = 'https://code-guac.preview.example/preview-bootstrap?token=t&folder=%2Fworkspace';

type GateResult =
    | { kind: 'none' }
    | { kind: 'allow'; interviewId: string }
    | { kind: 'refuse'; status: 404 | 409; code: 'repo_not_found' | 'interview_not_started' | 'interview_finished' };

const s = vi.hoisted(() => ({
    order: [] as string[], owned: true, identity: 'ok' as 'ok' | 'missing', aws: [false, false] as boolean[],
    preview: { ok: true } as Record<string, unknown>,
    gate: { kind: 'none' } as GateResult, gateCalls: [] as unknown[],
    grant: 'ok' as 'ok' | 'not_found' | 'identity_refused' | 'unavailable', grantCalls: [] as unknown[],
    opened: { ok: true } as Record<string, unknown>, openArgs: [] as unknown[], cleared: 0,
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
        return { token: ID_TOKEN, issuer: 'https://id.ezil.work/', subject: 'auth0|candidate', expiresAt: Date.now() + 3_600_000,
            userId: USER, sessionId: 'session-a', gitAuthor: { name: 'c', email: 'c@ezil.work' } };
    },
    clearProjectIdentity: async () => { s.cleared += 1; },
}));
vi.mock('@/server/interview/gate', () => ({ interviewOpenGate: async (input: unknown) => { s.order.push('gate'); s.gateCalls.push(input); return s.gate; } }));
vi.mock('@/server/git/access', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/git/access')>(),
    grantForWorksGitAddress: async (_identity: unknown, canonicalURL: string, computerId: string) => {
        s.order.push('grant'); s.grantCalls.push({ canonicalURL, computerId });
        const { GitAccessError } = await importOriginal<typeof import('@/server/git/access')>();
        if (s.grant !== 'ok') throw new GitAccessError(s.grant);
        return { canonicalURL, ref: 'refs/heads/main', git: { token: WORKS_TOKEN, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write' } };
    },
}));
vi.mock('@/server/lib/compute/aws-control-auth', () => ({ controlTargetFor: async () => {
    s.order.push('target');
    return (s.aws.shift() ?? false)
        ? { sandboxName: 'guac', auth: { kind: 'v2', claims: { sandboxId: 'guac', computerId: COMPUTER, userId: USER, provider: 'aws-ec2', store: '', generation: 3, leaseEpoch: 1 } } }
        : { sandboxName: 'guac', auth: { kind: 'v1' } };
} }));
vi.mock('@/server/lib/compute/repo-open', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/lib/compute/repo-open')>(),
    requestRepoOpen: async (_workerUrl: unknown, _secret: unknown, _target: unknown, _computer: unknown, req: Record<string, unknown>) => {
        s.order.push('worker'); s.openArgs.push(req);
        return s.opened.ok ? { ok: true, folder: `/workspace/projects/${req.repositoryId as string}`, head: 'b'.repeat(40) } : s.opened;
    },
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({
    newCorrelationId: () => 'correlation', resolveCloudflareGuacamoleConfig: () => ({ workerUrl: 'https://worker.example', isConfigured: true, hasHmacSecret: true }),
    CORRELATION_HEADER: 'x-ezil-correlation', deriveGuacamoleSandboxId: () => 'guac',
}));
vi.mock('@/server/feedback/repo-open-failure', () => ({
    repoOpenFailureResponse: () => new Response(JSON.stringify({ error: { code: 'repo_open_failed' } }), { status: 502, headers: { 'content-type': 'application/json' } }),
}));

import { POST } from './route';

let logs: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
    Object.assign(s, { order: [], owned: true, identity: 'ok', aws: [false, false], gate: { kind: 'none' }, gateCalls: [],
        grant: 'ok', grantCalls: [], opened: { ok: true }, openArgs: [], cleared: 0,
        preview: { ok: true, codePreviewUrl: MINTED, expiresAt: Date.now() + 300_000, provider: 'cloudflare-guacamole' } });
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'secret');
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work'); // os-staging: the staging gate is on
    logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
        vi.spyOn(console, 'error').mockImplementation(() => {}), vi.spyOn(console, 'info').mockImplementation(() => {})];
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const open = (url: unknown = QA_URL) => POST(new Request('https://os-staging.example/api/shell/code-preview-url', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ computerId: COMPUTER, intent: 'open', repository: { url } }) }));

async function expectNoSecrets(response: Response) {
    const text = await response.clone().text();
    const logged = JSON.stringify(logs.flatMap(l => l.mock.calls));
    for (const secret of [WORKS_TOKEN, 'egg_', ID_TOKEN, 'eyJ']) {
        expect(text).not.toContain(secret);
        expect(logged).not.toContain(secret);
    }
}

describe('opening an interview git-qa address in Code (contract §6)', () => {
    const idFor = async () => (await import('@/server/git/repo-url')).repositoryIdFor(QA_URL);

    it('gate none (not an interview): ownership, provider, identity, gate, mint, grant, Worker binding open; answers the folder URL', async () => {
        const id = await idFor();
        const response = await open();
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gate', 'codePreviewUrl', 'grant', 'target', 'worker']);
        // The gate is asked for `open` with the canonical URL and the caller's EZiL ID subject, before any mint or grant.
        expect(s.gateCalls[0]).toEqual({ canonicalURL: QA_URL, osUserId: USER, ezilIdSubject: 'auth0|candidate', computerId: COMPUTER, purpose: 'open' });
        // The Worker is asked on its binding (non-packet) path: canonical git-qa remote, the grant's ref and credential, NO privatePacket.
        const open0 = s.openArgs[0] as Record<string, unknown>;
        expect(open0).toMatchObject({ repositoryId: id, canonicalURL: QA_URL, ref: 'refs/heads/main',
            git: { token: WORKS_TOKEN, scope: 'write' } });
        expect(open0.privatePacket).toBeUndefined();
        expect(open0.gitAuthor).toBeUndefined();
        expect(open0.refreshOnly).toBeUndefined();
        expect(typeof open0.timeoutMs).toBe('number');
        const body = await response.clone().json();
        expect(body.repository).toEqual({ name: 'candidate-a/interview-1121', id });
        expect(new URL(body.url).searchParams.getAll('folder')).toEqual([`/workspace/projects/${id}`]);
        expect(body.url).toBe(body.codePreviewUrl);
        await expectNoSecrets(response);
    });

    it('gate allow (started, candidate) opens identically', async () => {
        s.gate = { kind: 'allow', interviewId: INTERVIEW };
        const response = await open();
        expect(response.status).toBe(200);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gate', 'codePreviewUrl', 'grant', 'target', 'worker']);
    });

    it.each([
        ['repo_not_found', 404],
        ['interview_not_started', 409],
        ['interview_finished', 409],
    ] as const)('gate refuse %s answers %i and stops before the mint and the grant (spies not called)', async (code, status) => {
        s.gate = { kind: 'refuse', status, code };
        const response = await open();
        expect(response.status).toBe(status);
        expect((await response.json()).error.code).toBe(code);
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gate']);
        expect(s.order).not.toContain('codePreviewUrl');
        expect(s.order).not.toContain('grant');
        expect(s.order).not.toContain('worker');
    });

    it("the grant's not_found is 404 repo_not_found, after the mint but before the Worker", async () => {
        s.grant = 'not_found';
        const response = await open();
        expect(response.status).toBe(404);
        expect((await response.json()).error.code).toBe('repo_not_found');
        expect(s.order).toEqual(['computer.get', 'target', 'identity', 'gate', 'codePreviewUrl', 'grant']);
        expect(s.order).not.toContain('worker');
    });

    it("the grant's identity_refused clears the retained token and asks for a refresh", async () => {
        s.grant = 'identity_refused';
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.cleared).toBe(1);
        expect(s.order).not.toContain('worker');
    });

    it('a missing retained identity asks for a refresh before the gate, mint or grant', async () => {
        s.identity = 'missing';
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('IDENTITY_REFRESH_REQUIRED');
        expect(s.order).toEqual(['computer.get', 'target', 'identity']);
        expect(s.order).not.toContain('gate');
    });

    it("another person's computer is NOT_FOUND before identity or the gate", async () => {
        s.owned = false;
        expect((await open()).status).toBe(404);
        expect(s.order).toEqual(['computer.get']);
        expect(s.gateCalls).toEqual([]);
    });

    it('an AWS computer cannot open git-qa: repo_open_unsupported_provider before identity or the gate', async () => {
        s.aws = [true];
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_open_unsupported_provider');
        expect(s.order).toEqual(['computer.get', 'target']);
        expect(s.gateCalls).toEqual([]);
    });

    it('with the staging gate off, a git-qa address is repo_url_unsupported before anything is read', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        const response = await open();
        expect(response.status).toBe(409);
        expect((await response.json()).error.code).toBe('repo_url_unsupported');
        expect(s.order).toEqual([]);
    });
});
