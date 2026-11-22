/**
 * Wiring for `GET /api/admin/interviews/:id` (contract §7.3, errata E4). Real env-driven gate; only
 * `createTRPCContext` and `@/server/db` are stubbed; the real service decides each status.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const ctx = vi.hoisted(() => ({ user: null as { id: string; email?: string } | null, calls: [] as Array<{ headers: Headers }> }));
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

import { GET } from './route';

const ADMIN = 'admin@ezil.work';
const ID = '7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13';
const CANONICAL = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const AT = '2026-11-22T09:00:00.000Z';
const pgRow = () => ({ interview_id: ID, canonical_url: CANONICAL, repository_id: '4211', handle: 'candidate-a',
    owner_ezil_id_subject: 'auth0|abc', works_account_id: '1187', state: 'consented', os_user_id: '3b9e2a71-0c4d-4f5e-8a6b-1d2c3e4f5a6b',
    ezil_id_subject: 'auth0|abc', notice_sha256: 'a'.repeat(64), registered_at: AT, consented_at: AT, started_at: null, finished_at: null });
const get = (headers: Record<string, string>) =>
    GET(new Request('https://os-staging.ezil.work/api/admin/interviews/' + ID, { headers }), { params: Promise.resolve({ id: ID }) });
const BEARER = { authorization: 'Bearer supabase-access-token' };

beforeEach(() => {
    ctx.user = null; ctx.calls = []; h.responses = []; h.i = 0;
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work');
    vi.stubEnv('TELEMETRY_ADMIN_EMAILS', ADMIN);
});

describe('GET /api/admin/interviews/:id', () => {
    it('gate off (env drives it) -> 404 not_found, even with an admin bearer', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work');
        ctx.user = { id: 'u', email: ADMIN };
        const res = await get(BEARER);
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe('not_found');
    });
    it('E4: a cookie-only request (no bearer) -> 401 unauthorized, never reaching createTRPCContext', async () => {
        const res = await get({ cookie: 'sb-access-token=abc' });
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('unauthorized');
        expect(ctx.calls).toHaveLength(0);
    });
    it('a bearer from a non-admin -> 403 forbidden', async () => {
        ctx.user = { id: 'u', email: 'stranger@ezil.work' };
        expect((await get(BEARER)).status).toBe(403);
        expect(ctx.calls).toHaveLength(1);
    });
    it('success: an admin bearer reads the registry row -> 200 with the identity tuple', async () => {
        ctx.user = { id: 'u', email: ADMIN };
        h.responses = [{ rows: [pgRow()] }];
        const res = await get(BEARER);
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ interviewId: ID, state: 'consented', identity: { ezilIdSubject: 'auth0|abc' } });
    });
});
