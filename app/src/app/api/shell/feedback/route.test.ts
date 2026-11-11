import { after } from 'next/server';
import { drainFeedbackNotifications } from '@/server/feedback/notifications';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/server', () => ({ after: vi.fn() }));
vi.mock('@/server/feedback/notifications', () => ({ drainFeedbackNotifications: vi.fn() }));

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
    vi.mocked(after).mockReset();
    vi.mocked(drainFeedbackNotifications).mockReset();
    vi.stubEnv('FEEDBACK_SMTP2GO_API_KEY', '');
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


describe('new feedback quick notification delivery', () => {
    it('schedules a post-response drain only after report and queue commit', async () => {
        vi.stubEnv('FEEDBACK_SMTP2GO_API_KEY', 'synthetic-provider-key');
        expect((await post()).status).toBe(201);
        expect(state.statements.some(s => s.sql.includes('INSERT INTO ezil_feedback_notifications'))).toBe(true);
        expect(after).toHaveBeenCalledTimes(1);
        expect(drainFeedbackNotifications).not.toHaveBeenCalled();
        const callback = vi.mocked(after).mock.calls[0]![0] as () => Promise<void>;
        await callback();
        expect(drainFeedbackNotifications).toHaveBeenCalledTimes(1);
    });
    it('a failed post-response drain cannot undo the accepted feedback', async () => {
        vi.stubEnv('FEEDBACK_SMTP2GO_API_KEY', 'synthetic-provider-key');
        vi.mocked(drainFeedbackNotifications).mockRejectedValue(new Error('secret-provider-error'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            expect((await post()).status).toBe(201);
            await (vi.mocked(after).mock.calls[0]![0] as () => Promise<void>)();
            expect(warn).toHaveBeenCalledExactlyOnceWith('[feedback] notification delivery deferred');
        } finally { warn.mockRestore(); }
    });
    it('does not schedule delivery without a server mail credential', async () => {
        expect((await post()).status).toBe(201);
        expect(after).not.toHaveBeenCalled();
    });
});
