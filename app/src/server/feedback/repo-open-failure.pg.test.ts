/** Real existing telemetry + feedback writers on disposable PG; no new schema is required by this feature. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { resetRateLimitForTests } from '@/server/telemetry/rate-limit';
import { setLoadShedCacheForTests } from '@/server/telemetry/load-shed';
import { repoOpenFailureResponse } from './repo-open-failure';
import { ingestFeedback, type FeedbackDb } from './ingest';
import { FEEDBACK_MIGRATION_SQL } from './migration-sql';
vi.mock('server-only', () => ({}));
vi.mock('next/server', () => ({ after: vi.fn() }));
const PG = process.env.EZIL_PG_TEST_URL;
const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const REQUEST = '33333333-3333-4333-8333-333333333333';

describe.skipIf(!PG)('repository failure survives app restart and joins a stored feedback report', () => {
    const name = `repofb_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const client = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const fresh = PG ? postgres(PG, { max: 1, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    afterAll(async () => { await client?.end(); await fresh?.end(); await admin?.unsafe(`DROP SCHEMA IF EXISTS ${name} CASCADE`); await admin?.end(); });
    it('uses the existing telemetry DDL and feedback JSON to retain exact bounded cause/id after a fresh connection', async () => {
        await admin!.unsafe(`CREATE SCHEMA ${name}; CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY,user_id uuid NOT NULL,deleted_at timestamptz);
            INSERT INTO ${name}.ezil_computers VALUES ('${COMPUTER}','${USER}',NULL);
            DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        // Full documented existing column/index/FK DDL. Policy expressions are outside this service-writer test.
        const doc = readFileSync(path.resolve(__dirname, '../../../../docs/telemetry-design.md'), 'utf8');
        const ddl = doc.slice(doc.indexOf('CREATE TABLE "ezil_error_fingerprints"')).split('```')[0]
            .replace(/CREATE POLICY[\s\S]*?;/g, '').replaceAll('"public".', `"${name}".`);
        await client!.unsafe(ddl);
        await client!.unsafe(FEEDBACK_MIGRATION_SQL.replaceAll('public.', `${name}.`));
        resetRateLimitForTests(); setLoadShedCacheForTests(0);
        const pending: (() => Promise<void>)[] = [];
        const response = repoOpenFailureResponse(drizzle(client!, { schema }), USER, COMPUTER,
            { refusalReason: 'repo_open:worker_http_502:clone_failed', correlationId: REQUEST }, 'Could not open the repository.', w => pending.push(w));
        await pending[0]!();
        const answer = await response.json();
        // Lose all producer connection state, as an app refresh does. Only the DB record and response remain.
        await client!.end();
        const [event] = await fresh!.unsafe(`SELECT source,detail,correlation_id,attrs FROM ${name}.ezil_error_events WHERE correlation_id=$1`, [REQUEST]);
        expect(event).toEqual({ source: 'app', detail: answer.refusalReason, correlation_id: REQUEST, attrs: { status: 502 } });
        const db = drizzle(fresh!, { schema }) as unknown as FeedbackDb;
        const result = await ingestFeedback(db, USER, { v: 1, clientRequestId: randomUUID(), computerId: COMPUTER, category: 'bug', description: '',
            diagnostics: { recentEvents: [{ eventClass: 'api_failure', site: 'ezil-os:apps/code#project', code: 'repo_open_failed',
                reason: answer.refusalReason, correlationId: REQUEST }] } });
        expect(result.status).toBe(201);
        const [report] = await fresh!.unsafe(`SELECT diagnostics FROM ${name}.ezil_feedback_reports`);
        expect(report!.diagnostics.recentEvents[0]).toMatchObject({ reason: event!.detail, correlationId: event!.correlation_id });
    });
});
