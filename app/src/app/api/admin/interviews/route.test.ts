/**
 * Wiring for `POST /api/admin/interviews` (contract §7.3, errata E4/E5). Mirrors the repo's thin-route test
 * convention (`ai-traces/route.test.ts`): the staging gate is the REAL env-driven `stagingGitQaAccepted`, only
 * `createTRPCContext` and `@/server/db` are stubbed. The real service decides every status below.
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

import { POST } from './route';

const ADMIN = 'admin@ezil.work';
const ID = '7c1f3f0e-5b8a-4c2d-9e41-0a6b2d9f8e13';
const CANONICAL = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const AT = '2026-11-22T09:00:00.000Z';
const body = { interviewId: ID, repositoryId: '4211', canonicalURL: CANONICAL, handle: 'candidate-a', ownerEzilIdSubject: 'auth0|abc', worksAccountId: '1187' };
const pgRow = () => ({ interview_id: ID, canonical_url: CANONICAL, repository_id: '4211', handle: 'candidate-a',
    owner_ezil_id_subject: 'auth0|abc', works_account_id: '1187', state: 'registered', os_user_id: null,
    ezil_id_subject: null, notice_sha256: null, registered_at: AT, consented_at: null, started_at: null, finished_at: null });
const post = (headers: Record<string, string>, b: unknown = body) =>
    POST(new Request('https://os-staging.ezil.work/api/admin/interviews', { method: 'POST', headers, body: JSON.stringify(b) }));
const BEARER = { authorization: 'Bearer supabase-access-token', 'content-type': 'application/json' };

beforeEach(() => {
    ctx.user = null; ctx.calls = []; h.responses = []; h.i = 0;
    vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work'); // gate on
    vi.stubEnv('TELEMETRY_ADMIN_EMAILS', ADMIN);
});

describe('POST /api/admin/interviews', () => {
    it('gate off (env drives it) -> 404 not_found, even with an admin bearer', async () => {
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai.ezil.work'); // not ai-staging -> gate off
        ctx.user = { id: 'u', email: ADMIN };
        const res = await post(BEARER);
        expect(res.status).toBe(404);
        expect((await res.json()).error.code).toBe('not_found');
    });
    it('E4: a cookie-only request (no bearer) -> 401 unauthorized, never reaching createTRPCContext', async () => {
        const res = await post({ cookie: 'sb-access-token=abc', 'content-type': 'application/json' });
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe('unauthorized');
        expect(ctx.calls).toHaveLength(0); // positive control for E4: the cookie fallback is never reached
    });
    it('a bearer from a non-admin -> 403 forbidden (the bearer reaches the isTelemetryAdmin check)', async () => {
        ctx.user = { id: 'u', email: 'stranger@ezil.work' };
        const res = await post(BEARER);
        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe('forbidden');
        expect(ctx.calls).toHaveLength(1);
    });
    it('success: an admin bearer registers -> 201 created', async () => {
        ctx.user = { id: 'u', email: ADMIN };
        h.responses = [{ rows: [] }, { rows: [] }, { rows: [] }, { rows: [pgRow()] }];
        const res = await post(BEARER);
        expect(res.status).toBe(201);
        expect(await res.json()).toMatchObject({ interviewId: ID, state: 'registered' });
    });
});
