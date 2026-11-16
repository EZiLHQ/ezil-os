/**
 * Disposable PostgreSQL only: a repository-open failure survives an app restart in the EXISTING telemetry table and
 * joins a consented feedback report. Applies the real `0001_telemetry.sql` + `0024_telemetry_alerts.sql` and
 * `0011_feedback.sql` + `0022_feedback_notifications.sql` into one isolated schema; no new DDL is required.
 * Main's durable notification queue is exercised as-is: a new report enqueues once, a replay enqueues nothing,
 * and the owner delete removes the queued row.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { resetRateLimitForTests } from '@/server/telemetry/rate-limit';
import { setLoadShedCacheForTests } from '@/server/telemetry/load-shed';
import { repoOpenFailureResponse } from './repo-open-failure';
import { deleteFeedback, ingestFeedback, type FeedbackDb } from './ingest';
import type { FeedbackSubmit } from './types';
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: vi.fn() }));

const PG = process.env.EZIL_PG_TEST_URL;
if (PG) {
    const url = new URL(PG);
    if (process.env.EZIL_PG_TEST_DISPOSABLE !== '1' || !['postgres:', 'postgresql:'].includes(url.protocol)
        || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.search || url.hash) {
        throw new Error('Repository diagnostic PG tests require explicit disposable opt-in and a loopback database without URL options');
    }
}
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';
const MESSAGE = 'Could not open the repository.';

describe.skipIf(!PG)('repository failure survives app restart and joins a stored feedback report', () => {
    const name = `repofb_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const fresh = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    let created = false;

    beforeAll(async () => {
        // Disposable fixtures only so the REAL migrations parse: roles, auth.role() for the telemetry policies,
        // and the computer row read by both the telemetry FK and the feedback ownership check.
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            CREATE SCHEMA IF NOT EXISTS auth;
            DO $$ BEGIN IF to_regprocedure('auth.role()') IS NULL THEN
                CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS 'SELECT current_user::text'; END IF; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz);
            INSERT INTO ${name}.ezil_computers VALUES ('${COMPUTER}', '${USER}', NULL)`);
        const isolate = (sql: string) => sql.replaceAll('"public".', `"${name}".`).replaceAll('public.', `${name}.`);
        for (const file of ['0001_telemetry.sql', '0024_telemetry_alerts.sql', '0011_feedback.sql', '0022_feedback_notifications.sql']) {
            const migration = isolate(readFileSync(new URL(`../../../drizzle/${file}`, import.meta.url), 'utf8'));
            await admin!.begin(tx => tx.unsafe(`SET LOCAL search_path TO ${name}; ${migration}`));
        }
    });
    afterAll(async () => {
        await client?.end(); await fresh?.end();
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await admin?.end();
    });

    it('retains only the closed cause and request ID after a fresh connection and joins consented feedback once', async () => {
        resetRateLimitForTests(); setLoadShedCacheForTests(0);
        const pending: (() => Promise<void>)[] = [];
        const response = repoOpenFailureResponse(drizzle(client!, { schema }), USER, COMPUTER,
            { refusalReason: 'repo_open:worker_http_502:clone_failed', correlationId: REQUEST }, MESSAGE, w => pending.push(w));
        // The response is the plain 502 copy and never waits for persistence.
        expect(response.status).toBe(502);
        expect(pending).toHaveLength(1);
        const answer = await response.json();
        expect(answer).toEqual({ error: { code: 'repo_open_failed', message: MESSAGE },
            refusalReason: 'repo_open:worker_http_502:clone_failed', correlationId: REQUEST });
        await pending[0]!();
        // Lose all producer connection state, as an app refresh does. Only the DB record and response remain.
        await client!.end();

        const events = await fresh!.unsafe(`SELECT event_class, source, site, code, outcome, detail, correlation_id, computer_id, attrs
            FROM ${name}.ezil_error_events`);
        expect(events).toEqual([{ event_class: 'api_failure', source: 'app', site: 'ezil-os:repo-open#transport',
            code: 'repo_open_failed', outcome: 'error', detail: answer.refusalReason, correlation_id: REQUEST,
            computer_id: COMPUTER, attrs: { status: 502 } }]);
        expect(JSON.stringify(events)).not.toContain(MESSAGE);

        const db = drizzle(fresh!, { schema }) as unknown as FeedbackDb;
        const body: FeedbackSubmit = { v: 1, clientRequestId: randomUUID(), computerId: COMPUTER, category: 'bug', description: '',
            diagnostics: { recentEvents: [{ eventClass: 'api_failure', site: 'ezil-os:apps/code#project', code: 'repo_open_failed',
                reason: answer.refusalReason, correlationId: REQUEST }] } };
        const result = await ingestFeedback(db, USER, body);
        expect(result.status).toBe(201);
        const [report] = await fresh!.unsafe(`SELECT id, diagnostics FROM ${name}.ezil_feedback_reports`);
        expect(report!.diagnostics.recentEvents[0]).toMatchObject({ reason: events[0]!.detail, correlationId: events[0]!.correlation_id });
        const queued = () => fresh!.unsafe(`SELECT report_id FROM ${name}.ezil_feedback_notifications`);
        expect(await queued()).toEqual([{ report_id: report!.id }]);

        // Main's replay guard: the same clientRequestId answers 200 and enqueues nothing more.
        expect((await ingestFeedback(db, USER, body)).status).toBe(200);
        expect(await fresh!.unsafe(`SELECT count(*)::int AS n FROM ${name}.ezil_feedback_reports`)).toEqual([{ n: 1 }]);
        expect(await queued()).toEqual([{ report_id: report!.id }]);

        // Main's owner delete removes the report and its queued notification.
        expect(await deleteFeedback(db, USER, report!.id)).toBe(true);
        expect(await queued()).toEqual([]);
    });

    it('stores no arbitrary provider text and replaces an invalid request ID', async () => {
        resetRateLimitForTests(); setLoadShedCacheForTests(0);
        const writer = postgres(PG!, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: name } });
        try {
            const pending: (() => Promise<void>)[] = [];
            const answer = await repoOpenFailureResponse(drizzle(writer, { schema }), USER, COMPUTER,
                { refusalReason: 'repo_open:transport:fatal: https://x-access-token:secret@example.test/repo', correlationId: 'not a request id' },
                MESSAGE, w => pending.push(w)).json();
            await pending[0]!();
            expect(answer.refusalReason).toBe('repo_open:transport:other');
            expect(answer.correlationId).toMatch(/^[0-9a-f-]{36}$/);
            const rows = await fresh!.unsafe(`SELECT detail, correlation_id, attrs FROM ${name}.ezil_error_events WHERE correlation_id = $1`, [answer.correlationId]);
            expect(rows).toEqual([{ detail: 'repo_open:transport:other', correlation_id: answer.correlationId, attrs: null }]);
            expect(JSON.stringify(rows)).not.toContain('secret');
        } finally {
            await writer.end();
        }
    });
});
