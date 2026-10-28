import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ statements: [] as { sql: string; params: unknown[] }[] }));
const USER = { id: '550e8400-e29b-41d4-a716-446655440000', email: 'alice@example.com' };
const ID = '550e8400-e29b-41d4-a716-446655440001';
const SHA = '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90';

// The real handler and ingest run against a recording pg-proxy; only the
// session context is stubbed, so the route's own deps wiring is under test.
vi.mock('@/server/api/trpc', async () => {
    const { drizzle: proxyDrizzle } = await import('drizzle-orm/pg-proxy');
    const dbSchema = await import('@/server/db/schema');
    const proxy = proxyDrizzle(async (sql, params) => {
        state.statements.push({ sql, params });
        if (sql.includes('count(*)') || sql.includes('sum(')) return { rows: [[0, 0]] };
        return { rows: [] };
    }, { schema: dbSchema });
    const db = { select: proxy.select.bind(proxy), transaction: (cb: (tx: typeof proxy) => Promise<unknown>) => cb(proxy) };
    return { createTRPCContext: async () => ({ user: USER, db }) };
});

import { POST } from './route';

const post = () => POST(new Request('https://example.test/api/shell/feedback', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ v: 1, clientRequestId: ID, category: 'bug', description: 'The button is stuck.' }) }));
const insertedReport = () => state.statements.find((s) => s.sql.startsWith('insert into "ezil_feedback_reports"'));

beforeEach(() => {
    state.statements.length = 0;
    vi.stubEnv('EZIL_OS_FEEDBACK', '1');
    vi.stubEnv('FEEDBACK_PILOT_EMAILS', '');
    vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('POST /api/shell/feedback stamps the deployed commit (F6 wiring)', () => {
    it('stores the image EZIL_GIT_SHA on the inserted report row', async () => {
        vi.stubEnv('EZIL_GIT_SHA', SHA);
        expect((await post()).status).toBe(201);
        const insert = insertedReport();
        expect(insert?.sql).toContain('"deploy_sha"');
        expect(insert?.params).toContain(SHA);
    });

    it('stores null, not the raw value, when the env is not a commit SHA', async () => {
        vi.stubEnv('EZIL_GIT_SHA', 'not-a-sha');
        expect((await post()).status).toBe(201);
        const insert = insertedReport();
        expect(insert?.sql).toContain('"deploy_sha"');
        expect(insert?.params).not.toContain('not-a-sha');
    });
});
