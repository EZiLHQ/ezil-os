/**
 * Wiring for `POST /api/shell/interview-consent` (contract §7.3). Real env-driven gate; only `createTRPCContext`
 * and `@/server/db` are stubbed. The route resolves the candidate through the shell-http caller (x-trpc-source),
 * so a signed-out caller is 401; the real service decides every status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const ctx = vi.hoisted(() => ({ user: null as { id: string } | null, calls: [] as Array<{ headers: Headers }> }));
vi.mock('@/server/api/trpc', () => ({
    createTRPCContext: (opts: { headers: Headers }) => { ctx.calls.push(opts); return Promise.resolve({ user: ctx.user, db: {} }); },
}));
const h = vi.hoisted(() => ({ responses: [] as Array<{ rows: Record<string, unknown>[] }>, i: 0 }));
vi.mock('@/server/db', () => {
    const db: { execute: () => Promise<unknown>; transaction: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> } = {
        execute: () => Promise.resolve(h.responses[h.i++] ?? { rows: [] }),
        transaction: (fn) => fn(db),
    };
    return { db };
});

import { POST } from './route';

const OS_USER = '3b9e2a71-0c4d-4f5e-8a6b-1d2c3e4f5a6b';
const ID = '7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13';
const CANONICAL = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const AT = '2026-11-22T09:00:00.000Z';
const pgRow = () => ({ interview_id: ID, canonical_url: CANONICAL, repository_id: '4211', handle: 'candidate-a',
    owner_ezil_id_subject: 'auth0|abc', works_account_id: '1187', state: 'consented', os_user_id: OS_USER,
    ezil_id_subject: 'auth0|abc', notice_sha256: 'a'.repeat(64), registered_at: AT, consented_at: AT, started_at: null, finished_at: null });
const post = (b: unknown) =>
    POST(new Request('https://os-staging.ezil.work/api/shell/interview-consent', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }));
const status = { action: 'status', repository: { url: CANONICAL } };

beforeEach(() => {
    ctx.user = null; ctx.calls = []; h.responses = []; h.i = 0;
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work');
});

describe('POST /api/shell/interview-consent', () => {
    it('gate off (env drives it) -> 404 not_found', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        ctx.user = { id: OS_USER };
        const res = await post(status);
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe('not_found');
    });
    it('resolves the user through the shell-http caller and is 401 when signed out', async () => {
        ctx.user = null; // signed out
        const res = await post(status);
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('UNAUTHORIZED');
        expect(ctx.calls[0]!.headers.get('x-trpc-source')).toBe('shell-http');
    });
    it('success: the bound candidate status request returns the interview and notice', async () => {
        ctx.user = { id: OS_USER };
        h.responses = [{ rows: [pgRow()] }]; // getInterviewByUrl -> consented row bound to this OS user
        const res = await post(status);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ interview: { interviewId: ID, state: 'consented', notice: { version: 1 } } });
        expect(ctx.calls[0]!.headers.get('x-trpc-source')).toBe('shell-http');
    });
});
