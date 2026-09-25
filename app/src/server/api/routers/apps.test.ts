import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
    process.env.SUPABASE_DATABASE_URL ??= 'postgres://marketplace-test@127.0.0.1:5432/none';
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= 'https://marketplace-test.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??= 'marketplace-test-anon';
    process.env.EZIL_APP_MARKETPLACE_API_ENABLED = 'true';
    process.env.EZIL_APP_SUBMISSION_INTAKE_ENABLED = 'true';
    delete process.env.EZIL_APP_INSTALL_ENABLED;
});

import { TRPCError } from '@trpc/server';
import type { User } from '@supabase/supabase-js';
import { drizzle } from 'drizzle-orm/pg-proxy';

import { env } from '@/env';
import { appRouter } from '@/server/api/root';
import { buildTRPCContext } from '@/server/api/trpc';
import * as schema from '@/server/db/schema';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const SUBMISSION = '33333333-3333-4333-8333-333333333333';
const JOB = '44444444-4444-4444-8444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';
const COMMIT = '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19';
const URL = 'https://github.com/reticlehq/reticle';
const request = { schemaVersion: 1 as const, repositoryUrl: URL, requestedCommitSha: COMMIT,
    clientRequestId: '66666666-6666-4666-8666-666666666666' };

type Statement = { sql: string; params: unknown[] };
function fixture(userId: string | null, answer: (statement: Statement) => unknown[][] = () => []) {
    const statements: Statement[] = [];
    const db = drizzle(async (sql, params) => {
        const statement = { sql, params };
        statements.push(statement);
        return { rows: answer(statement) };
    }, { schema });
    // The pg-proxy driver has no transaction primitive. For these tests the
    // callback runs against the same SQL-generating database; the real
    // PostgreSQL migration suite separately checks constraints and races.
    Object.assign(db, { transaction: async (fn: (value: typeof db) => Promise<unknown>) => fn(db) });
    const ctx = buildTRPCContext({
        db: db as unknown as Parameters<typeof buildTRPCContext>[0]['db'],
        user: userId ? { id: userId, email: 'test@example.com' } as User : null,
        headers: new Headers(), mode: 'open',
    });
    return { caller: appRouter.createCaller(ctx), statements };
}
function failureCode(error: unknown): string {
    expect(error).toBeInstanceOf(TRPCError);
    return (error as TRPCError).code;
}

describe('marketplace API gates and scope', () => {
    it('leaves the API closed before migrations are enabled', async () => {
        const before = env.EZIL_APP_MARKETPLACE_API_ENABLED;
        env.EZIL_APP_MARKETPLACE_API_ENABLED = 'false';
        try {
            const { caller, statements } = fixture(USER);
            const error = await caller.apps.catalog().catch((value: unknown) => value);
            expect(failureCode(error)).toBe('PRECONDITION_FAILED');
            expect(statements).toEqual([]);
        } finally {
            env.EZIL_APP_MARKETPLACE_API_ENABLED = before;
        }
    });

    it('requires OS access even for public catalog metadata', async () => {
        const { caller, statements } = fixture(null);
        expect(failureCode(await caller.apps.catalog().catch((value: unknown) => value))).toBe('UNAUTHORIZED');
        expect(statements).toEqual([]);
    });

    it('queries only approved publications from active publishers and visible grants', async () => {
        const { caller, statements } = fixture(USER);
        await expect(caller.apps.catalog()).resolves.toEqual([]);
        expect(statements).toHaveLength(1);
        const { sql, params } = statements[0]!;
        expect(sql).toMatch(/ezil_app_publications/);
        expect(sql).toMatch(/ezil_app_releases/);
        expect(sql).toMatch(/ezil_app_grants/);
        expect(sql).toMatch(/ezil_app_publishers/);
        expect(sql).toMatch(/"status" =/);
        expect(sql).toMatch(/"visibility" =/);
        expect(sql).toMatch(/"revoked_at" is null/);
        expect(params).toContain(USER);
        expect(params).toContain('approved');
        expect(params).toContain('active');
    });

    it('does not reveal an application detail without a visible publication', async () => {
        const { caller, statements } = fixture(USER);
        const error = await caller.apps.details({ appId: APP }).catch((value: unknown) => value);
        expect(failureCode(error)).toBe('NOT_FOUND');
        expect(statements).toHaveLength(1);
        expect(statements[0]!.params).toContain(APP);
        expect(statements[0]!.params).toContain(USER);
    });

    it('hides installations on another user’s computer', async () => {
        const { caller, statements } = fixture(USER);
        const error = await caller.apps.installed({ computerId: OTHER }).catch((value: unknown) => value);
        expect(failureCode(error)).toBe('NOT_FOUND');
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/ezil_computers/);
        expect(statements[0]!.sql).toMatch(/"deleted_at" is null/);
        expect(statements[0]!.params).toContain(USER);
        expect(statements[0]!.params).toContain(OTHER);
    });

    it('keeps Install closed until a supervisor consumes installation jobs', async () => {
        const { caller, statements } = fixture(USER);
        const error = await caller.apps.install({ computerId: OTHER, appId: APP,
            clientRequestId: request.clientRequestId }).catch((value: unknown) => value);
        expect(failureCode(error)).toBe('PRECONDITION_FAILED');
        expect(statements).toEqual([]);
    });

    it('accepts no repository intake from an uninvited publisher', async () => {
        const { caller, statements } = fixture(USER);
        const error = await caller.appSubmissions.create(request).catch((value: unknown) => value);
        expect(failureCode(error)).toBe('FORBIDDEN');
        expect(statements.map((item) => item.sql).join('\n')).not.toMatch(/insert into/);
    });

    it('does not enqueue an unconsumed inspection when intake is disabled', async () => {
        const before = env.EZIL_APP_SUBMISSION_INTAKE_ENABLED;
        env.EZIL_APP_SUBMISSION_INTAKE_ENABLED = 'false';
        try {
            const { caller, statements } = fixture(USER);
            const error = await caller.appSubmissions.create(request).catch((value: unknown) => value);
            expect(failureCode(error)).toBe('PRECONDITION_FAILED');
            expect(statements).toEqual([]);
        } finally {
            env.EZIL_APP_SUBMISSION_INTAKE_ENABLED = before;
        }
    });

    it('records one inspect job, outbox event and audit fact for an authorized publisher', async () => {
        const { caller, statements } = fixture(USER, ({ sql }) => {
            if (/select .*ezil_app_publishers/.test(sql)) return [[SUBMISSION]];
            if (/insert into "ezil_app_submissions"/.test(sql)) return [[SUBMISSION, 'queued']];
            if (/insert into "ezil_app_jobs"/.test(sql)) return [[JOB]];
            return [];
        });
        await expect(caller.appSubmissions.create(request)).resolves.toEqual({
            id: SUBMISSION, status: 'queued', jobId: JOB,
        });
        const writes = statements.filter((item) => /^insert into/.test(item.sql));
        expect(writes.map((item) => item.sql)).toEqual([
            expect.stringContaining('"ezil_app_submissions"'),
            expect.stringContaining('"ezil_app_jobs"'),
            expect.stringContaining('"ezil_app_outbox"'),
            expect.stringContaining('"ezil_app_audit_events"'),
        ]);
        expect(writes[0]!.params).toContain(USER);
        expect(writes[0]!.params).toContain(URL);
        expect(writes[0]!.params).toContain(COMMIT);
        expect(writes[1]!.params).toContain(SUBMISSION);
        expect(writes[2]!.params).toContain(JOB);
    });

    it('does not let a different user read or cancel a submission', async () => {
        const { caller, statements } = fixture(USER);
        expect(failureCode(await caller.appSubmissions.status({ id: SUBMISSION })
            .catch((value: unknown) => value))).toBe('NOT_FOUND');
        expect(failureCode(await caller.appSubmissions.cancel({ id: SUBMISSION })
            .catch((value: unknown) => value))).toBe('NOT_FOUND');
        expect(statements.map((item) => item.sql).join('\n')).not.toMatch(/update "ezil_app_submissions"/);
    });
});
