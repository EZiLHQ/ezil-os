import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';

vi.mock('server-only', () => ({}));
const s = vi.hoisted(() => ({
    signedIn: true, owned: true, aws: false, awsEnabled: true,
    identities: [] as Array<Record<string, unknown> | null>, grantError: null as Error | null,
    openOk: true, scope: 'write', order: [] as string[], opened: [] as unknown[], cleared: 0, moveDuringGrant: false,
}));
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const URL = 'https://github.ezil.work/default/example.git';
const identity = () => ({ token: 'private-id-token', issuer: 'https://id.ezil.work/', subject: 'auth0|contact',
    userId: USER, sessionId: 'session-a', expiresAt: Date.now() + 3600_000,
    gitAuthor: { name: 'contact', email: 'contact@ezil.work' } });
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: async () => ({ user: s.signedIn ? { id: USER } : null, db: {} }) }));
vi.mock('@/server/api/root', () => ({ appRouter: { createCaller: () => ({ computer: { get: async () => {
    s.order.push('owned'); if (!s.owned) throw new TRPCError({ code: 'NOT_FOUND' }); return { id: COMPUTER };
} }, cloudflareGuacamole: { codePreviewUrl: () => { throw new Error('Renewal must not mint or wake'); } } }) } }));
vi.mock('@/server/auth/retained-identity', () => ({ retainedIdentity: async () => {
    s.order.push('identity'); const next = s.identities.length ? s.identities.shift() : identity();
    if (!next) throw new Error('identity'); return next;
}, clearProjectIdentity: async () => { s.cleared += 1; } }));
// The REAL funding-root gate (`standaloneGitUrlEnabled`, from BILLING_FUNDING_URL); only the AWS capability is stubbed.
vi.mock('@/server/git/staging', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/git/staging')>(), awsStandaloneGitEnabled: () => s.awsEnabled,
}));
vi.mock('@/server/git/access', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/git/access')>(),
    grantForStandaloneGit: async () => {
        s.order.push('grant'); if (s.grantError) throw s.grantError;
        if (s.moveDuringGrant) s.aws = true;
        return { version: 2, repository: { id: 'provider1', canonicalURL: URL, ref: 'refs/heads/main' },
            identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|contact' },
            git: { username: 'ezil', token: 'private-git-token', expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: s.scope } };
    },
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({
    newCorrelationId: () => 'correlation', resolveCloudflareGuacamoleConfig: () => ({ workerUrl: 'https://worker.example' }),
}));
vi.mock('@/server/lib/compute/aws-control-auth', () => ({ controlTargetFor: async () => {
    s.order.push('target'); return { sandboxName: 'sandbox', auth: s.aws ? { kind: 'v2', claims: { provider: 'aws-ec2' } } : { kind: 'v1' } };
} }));
vi.mock('@/server/lib/compute/repo-open', () => ({ requestRepoOpen: async (...args: unknown[]) => {
    s.order.push('renew'); s.opened.push(args); return s.openOk ? { ok: true, folder: '/workspace/projects/id' } : { ok: false };
} }));
import { POST } from './route';
import { GitAccessError } from '@/server/git/access';
const post = (body: unknown = { computerId: COMPUTER, repository: { url: URL } }) => POST(new Request('https://os-staging.ezil.work/api/shell/code-git-access', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body),
}));
beforeEach(() => {
    Object.assign(s, { signedIn: true, owned: true, aws: false, awsEnabled: true, identities: [],
        grantError: null, openOk: true, scope: 'write', order: [], opened: [], cleared: 0, moveDuringGrant: false });
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'secret');
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work');
});
describe('renewing an open standalone Git checkout', () => {
    it('authenticates before parsing and reveals no body validation to an anonymous caller', async () => {
        s.signedIn = false;
        expect((await post('not-json')).status).toBe(401);
        expect(s.order).toEqual([]);
    });
    it('refuses malformed, foreign-host and extra inputs before touching a computer', async () => {
        for (const body of [{}, { computerId: COMPUTER, repository: { url: 'https://github.com/owner/repo.git' } },
            { computerId: COMPUTER, repository: { url: URL }, intent: 'open' }]) expect((await post(body)).status).toBe(400);
        expect(s.order).toEqual([]);
    });
    it('checks computer ownership before identity or gateway and never mints Code', async () => {
        s.owned = false;
        expect((await post()).status).toBe(404);
        expect(s.order).toEqual(['owned']);
    });
    it('sends existing-checkout-only signed renewal and only returns scope and expiry', async () => {
        const response = await post();
        expect(response.status).toBe(200);
        const answer = await response.json();
        expect(Object.keys(answer).sort()).toEqual(['expiresAt', 'ok', 'scope']);
        expect(JSON.stringify(answer)).not.toMatch(/private-id-token|private-git-token|contact@/);
        expect(s.opened[0]).toEqual(expect.arrayContaining([expect.objectContaining({
            refreshOnly: true, timeoutMs: 50_000, canonicalURL: URL, gitAuthor: identity().gitAuthor,
        })]));
        expect(s.order.indexOf('owned')).toBeLessThan(s.order.indexOf('grant'));
    });
    it('production: the canonical production funding root renews with the same ownership, session and signed refresh-only path', async () => {
        for (const funding of ['https://ai.ezil.work', 'https://ai.ezil.work/']) {
            vi.stubEnv('BILLING_FUNDING_URL', funding);
            s.order = []; s.opened = [];
            const response = await post();
            expect(response.status).toBe(200);
            expect(Object.keys(await response.json()).sort()).toEqual(['expiresAt', 'ok', 'scope']);
            expect(s.order).toEqual(['owned', 'target', 'identity', 'grant', 'identity', 'target', 'renew', 'target']);
            expect(s.opened[0]).toEqual(expect.arrayContaining([expect.objectContaining({ refreshOnly: true, canonicalURL: URL })]));
        }
        // Production keeps every other refusal: another person's computer, a switched session.
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        s.owned = false; s.order = []; s.opened = [];
        expect((await post()).status).toBe(404);
        expect(s.order).toEqual(['owned']);
        s.owned = true; s.identities = [identity(), { ...identity(), sessionId: 'session-b' }];
        expect(await (await post()).json()).toMatchObject({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } });
        expect(s.opened).toEqual([]);
    });
    it('any other funding value fails closed after ownership, before identity, grant or runtime', async () => {
        for (const funding of ['', ' https://ai.ezil.work', 'https://ai.ezil.work//', 'https://ai.ezil.work/v1', 'https://ai.ezil.work?x',
            'https://ai.ezil.work#x', 'https://ai.ezil.work:443', 'https://u@ai.ezil.work', 'http://ai.ezil.work', 'https://ai.ezil.work.evil.com',
            'https://AI.EZIL.WORK', 'not a url']) {
            vi.stubEnv('BILLING_FUNDING_URL', funding);
            s.order = []; s.opened = [];
            const response = await post();
            expect({ funding, status: response.status }).toEqual({ funding, status: 409 });
            expect(await response.json()).toMatchObject({ error: { code: 'repo_url_not_enabled' } });
            expect(s.order).toEqual(['owned', 'target']);
            expect(s.opened).toEqual([]);
        }
        vi.stubEnv('BILLING_FUNDING_URL', undefined);
        s.order = [];
        expect((await post()).status).toBe(409);
        expect(s.order).toEqual(['owned', 'target']);
    });
    it('surfaces read access accurately without claiming push permission', async () => {
        s.scope = 'read';
        expect(await (await post()).json()).toMatchObject({ ok: true, scope: 'read' });
    });
    it('refuses a placement change during the gateway call before touching the old runtime', async () => {
        s.moveDuringGrant = true;
        expect(await (await post()).json()).toMatchObject({ error: { code: 'repo_access_not_renewed' } });
        expect(s.opened).toEqual([]);
    });
    it('requests explicit sign-in recovery for a missing or switched session', async () => {
        s.identities = [null];
        expect((await post()).status).toBe(409);
        expect(s.opened).toEqual([]);
        s.identities = [identity(), { ...identity(), sessionId: 'session-b' }];
        expect(await (await post()).json()).toMatchObject({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } });
        expect(s.opened).toEqual([]);
    });
    it('clears refused identity, and revoked repository access never reaches the runtime', async () => {
        s.grantError = new GitAccessError('identity_refused');
        expect((await post()).status).toBe(409);
        expect(s.cleared).toBe(1);
        s.grantError = new GitAccessError('not_found');
        expect((await post()).status).toBe(403);
        expect(s.opened).toEqual([]);
    });
    it('refuses an unavailable AWS capability or failed/stopped/absent runtime', async () => {
        s.aws = true; s.awsEnabled = false;
        expect((await post()).status).toBe(409);
        expect(s.order).not.toContain('grant');
        s.aws = false; s.openOk = false;
        expect(await (await post()).json()).toMatchObject({ error: { code: 'repo_access_not_renewed' } });
    });
});
