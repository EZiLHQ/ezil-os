import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const s = vi.hoisted(() => ({
    signedIn: true, delegation: null as unknown, identities: [] as Array<Record<string, unknown> | null>, cleared: 0,
}));
vi.mock('@/server/api/trpc', () => ({
    createTRPCContext: async () => ({ user: s.signedIn ? { id: '11111111-1111-4111-8111-111111111111' } : null, delegation: s.delegation, db: {} }),
}));
vi.mock('@/server/auth/retained-identity', async () => {
    const { identity } = await import('@/server/git/assignment-enrollment.test-support');
    return {
        retainedIdentity: async () => { const next = s.identities.length ? s.identities.shift() : identity(); if (!next) throw new Error('IDENTITY_REFRESH_REQUIRED'); return next; },
        clearProjectIdentity: async () => { s.cleared += 1; },
    };
});
import { POST } from './route';
import { ATTEMPT, ENV, fakeWorld, GIT_TOKEN, ID_TOKEN, identity, REPO } from '@/server/git/assignment-enrollment.test-support';

let w: ReturnType<typeof fakeWorld>;
const SAME_ORIGIN = { 'sec-fetch-site': 'same-origin', 'x-ezil-assignment-enrollment': '1' };
const post = (body: unknown = { attemptId: ATTEMPT }, headers: Record<string, string> = SAME_ORIGIN) =>
    POST(new Request('https://os-staging.ezil.work/api/shell/assignment-enrollment', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
    }));
beforeEach(() => {
    Object.assign(s, { signedIn: true, delegation: null, identities: [], cleared: 0 });
    for (const [key, value] of Object.entries(ENV)) vi.stubEnv(key, value);
    w = fakeWorld();
    vi.stubGlobal('fetch', w.fetch);
});
afterEach(() => { w.cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('POST /api/shell/assignment-enrollment', () => {
    it('enrolls the signed-in QA participant and returns only the Code entry for the bound repository', async () => {
        const response = await post();
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ status: 'bound', attemptId: ATTEMPT, ref: 'refs/heads/main', baseSha: w.head(),
            codeUrl: `/app/code?${new URLSearchParams({ repo: REPO, assignment: ATTEMPT })}` });
        expect(text).not.toContain(GIT_TOKEN);
        expect(text).not.toContain(ID_TOKEN);
        expect(response.headers.get('cache-control')).toContain('no-store');
    });

    it('creates the canonical C2 repo for a normal authenticated participant only on the configured stage job', async () => {
        vi.stubEnv('EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS', '');
        vi.stubEnv('EZIL_ASSIGNMENT_ENROLLMENT_PILOT_JOB_IDS','10');
        expect((await post({attemptId:ATTEMPT,jobId:'10'})).status).toBe(400);
        expect(w.calls).toHaveLength(0);
        w.state.prepareJobId='9';
        expect((await post()).status).toBe(403);
        expect(w.calls).toHaveLength(1);
        expect(w.state.creates).toBe(0);
        w.state.prepareJobId=undefined;
        expect((await post()).status).toBe(403);
        expect(w.state.creates).toBe(0);
        w.state.prepareJobId='10';
        const response=await post();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({status:'bound',attemptId:ATTEMPT,
            codeUrl:'/app/code?'+new URLSearchParams({repo:REPO,assignment:ATTEMPT})});
        expect(w.git(['show','refs/heads/main:.ezil/assignment.json']).toString()).toContain('"port":5679');
        expect(w.state.creates).toBe(1);
    });

    it('never enables job enrollment in production or for malformed wildcard lists', async () => {
        vi.stubEnv('EZIL_ASSIGNMENT_ENROLLMENT_QA_SUBJECTS', '');
        for(const invalid of ['*','10,*','-10','01','',Array(66).fill('10').join(',')]){
            vi.stubEnv('EZIL_ASSIGNMENT_ENROLLMENT_PILOT_JOB_IDS',invalid);
            expect((await post()).status).toBe(404);
        }
        vi.stubEnv('EZIL_ASSIGNMENT_ENROLLMENT_PILOT_JOB_IDS','10');
        vi.stubEnv('BILLING_FUNDING_URL','https://ai.ezil.work');
        expect((await post()).status).toBe(404);
        expect(w.calls).toHaveLength(0);
    });

    it('refuses cross-site, header-less and non-page writes before any session lookup or request', async () => {
        for (const headers of <Array<Record<string, string>>>[
            { ...SAME_ORIGIN, 'sec-fetch-site': 'same-site' },
            { ...SAME_ORIGIN, 'sec-fetch-site': 'cross-site' },
            { 'x-ezil-assignment-enrollment': '1' },
            { 'sec-fetch-site': 'same-origin' },
            { 'x-ezil-assignment-enrollment': '1', origin: 'https://evil-app.ezil.org' },
        ]) {
            expect((await post(undefined, headers)).status).toBe(403);
        }
        expect(w.calls).toEqual([]);
    });

    it('is not found off os-staging', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        expect((await post()).status).toBe(404);
        expect(w.calls).toEqual([]);
    });

    it('requires a session, refuses delegation, and accepts only {attemptId}', async () => {
        s.signedIn = false;
        expect((await post()).status).toBe(401);
        s.signedIn = true;
        s.delegation = { kind: 'support' };
        expect((await post()).status).toBe(404);
        s.delegation = null;
        for (const body of [{ attemptId: ATTEMPT, repositoryUrl: REPO }, { attemptId: ATTEMPT, subject: 'auth0|x' }, { attemptId: 'nope' }, '{', []]) {
            expect((await post(body)).status).toBe(400);
        }
        expect(w.calls).toEqual([]);
    });

    it('asks for a fresh EZiL ID when none is retained, or when Universe refuses it', async () => {
        s.identities = [null];
        expect(await (await post()).json()).toMatchObject({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } });
        expect(w.calls).toEqual([]);
        w.state.prepareStatus = 401;
        const response = await post();
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } });
        expect(s.cleared).toBe(1);
    });

    it('does not hand the result to a session that changed meanwhile', async () => {
        s.identities = [identity(), identity({ sessionId: 'session-b' })];
        expect(await (await post()).json()).toMatchObject({ error: { code: 'IDENTITY_REFRESH_REQUIRED' } });
    });

    it('reports a pending repository as 202 without binding', async () => {
        w.state.exists = true;
        w.seedForeign();
        const response = await post();
        expect(response.status).toBe(202);
        expect(await response.json()).toEqual({ status: 'pending', attemptId: ATTEMPT, reason: 'repository_not_empty' });
        expect(w.state.completions).toBe(0);
    });

    it('answers a non-participant with the uniform refusal', async () => {
        w.state.prepareStatus = 403;
        const response = await post();
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({ error: { code: 'assignment_not_authorized' } });
    });
});
