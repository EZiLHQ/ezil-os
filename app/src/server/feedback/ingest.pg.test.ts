/** Disposable PostgreSQL, production drizzle(postgres-js) codecs, the real 0011 SQL; no app DB/credential imports. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/server/db/schema';
import { deleteFeedback, ingestFeedback, listFeedback, type FeedbackDb } from './ingest';
import { FEEDBACK_LIMITS, type FeedbackSubmit } from './types';

const PG = process.env.EZIL_PG_TEST_URL;
const NOW = new Date('2026-10-28T12:00:00.000Z');
const SHA = '46698745a1b2c3d4e5f60718293a4b5c6d7e8f90';
const input = (clientRequestId = randomUUID()): FeedbackSubmit => ({ v: 1, clientRequestId, category: 'bug', description: '[synthetic r3] pg test' });

describe.skipIf(!PG)('feedback ingest on PostgreSQL with app/drizzle/0011_feedback.sql', () => {
    const name = `feedback_${randomUUID().replaceAll('-', '')}`;
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    // Unqualified Drizzle table names resolve in the per-run schema.
    const client = PG ? postgres(PG, { max: 8, prepare: false, onnotice: () => {}, connection: { search_path: name } }) : null;
    const db = (client ? drizzle(client, { schema }) : null) as unknown as FeedbackDb;
    let created = false;
    beforeAll(async () => {
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await admin!.unsafe(`CREATE SCHEMA ${name}`); created = true;
        const sql = readFileSync(path.resolve(__dirname, '../../../drizzle/0011_feedback.sql'), 'utf8');
        await admin!.begin((tx) => tx.unsafe(sql.replaceAll('public.', `${name}.`)));
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz)`);
    });
    afterAll(async () => {
        if (created) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await client?.end(); await admin?.end();
    });

    it('creates the three tables with RLS on and nothing granted to client roles', async () => {
        const rows = await admin!.unsafe(`SELECT c.relname, c.relrowsecurity,
                has_table_privilege('anon', c.oid, 'select') AS anon, has_table_privilege('authenticated', c.oid, 'select') AS authed
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'r' AND c.relname LIKE 'ezil_feedback%' ORDER BY 1`, [name]);
        expect(rows.map((r) => [r.relname, r.relrowsecurity, r.anon, r.authed])).toEqual([
            ['ezil_feedback_access_log', true, false, false],
            ['ezil_feedback_attachments', true, false, false],
            ['ezil_feedback_reports', true, false, false],
        ]);
    });

    it('a concurrent replay of one clientRequestId stores ONE row, stamped with the deploy SHA', async () => {
        const user = randomUUID(); const body = input();
        const results = await Promise.all([ingestFeedback(db, user, body, NOW, SHA), ingestFeedback(db, user, body, NOW, SHA), ingestFeedback(db, user, body, NOW, SHA)]);
        expect(results.map((r) => r.status).sort()).toEqual([200, 200, 201]);
        const rows = await admin!.unsafe(`SELECT deploy_sha, client_request_id FROM ${name}.ezil_feedback_reports WHERE user_id = $1`, [user]);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ deploy_sha: SHA, client_request_id: body.clientRequestId });
    });

    it('the 11th report in an hour is 429; a replay of an accepted one still answers 200', async () => {
        const user = randomUUID(); const first = input();
        expect((await ingestFeedback(db, user, first, NOW)).status).toBe(201);
        for (let i = 1; i < FEEDBACK_LIMITS.perUserPerHour; i++) expect((await ingestFeedback(db, user, input(), NOW)).status).toBe(201);
        expect((await ingestFeedback(db, user, input(), NOW)).status).toBe(429);
        expect((await ingestFeedback(db, user, first, NOW)).status).toBe(200);
    });

    it('lists and deletes only the caller\'s own reports', async () => {
        const alice = randomUUID(); const bob = randomUUID();
        const created = await ingestFeedback(db, alice, input(), NOW);
        if (created.status === 429) throw new Error('unexpected 429');
        expect((await listFeedback(db, alice)).map((r) => r.id)).toEqual([created.created.id]);
        expect(await listFeedback(db, bob)).toEqual([]);
        expect(await deleteFeedback(db, bob, created.created.id)).toBe(false);
        expect(await deleteFeedback(db, alice, created.created.id)).toBe(true);
        expect(await listFeedback(db, alice)).toEqual([]);
    });
});
