/**
 * App-error coverage on disposable PostgreSQL. Uses the real 0011 feedback SQL, the real compute migration,
 * demand and reverse-move SQL, and the documented placement DDL, all under production drizzle(postgres-js)
 * codecs. No app DB or credential imports. Skipped unless EZIL_PG_TEST_URL is set.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/server/db/schema';
import { feedbackAdminQueries } from './admin-queries';
import { ingestFeedback, type FeedbackDb } from './ingest';
import { captureServerContext, serverContextSchema } from './server-context';
import type { FeedbackSubmit } from './types';

const PG = process.env.EZIL_PG_TEST_URL;
const NOW = new Date('2026-11-09T12:00:00.000Z');
const ROOT = path.resolve(__dirname, '../../../..');
const read = (file: string) => readFileSync(path.join(ROOT, file), 'utf8');
/** The documented placement table only (`CREATE TABLE` through its closing `);`). */
const placementDdl = () => read('docs/aws-computers/sql/0001_compute_placement.sql.txt')
    .match(/CREATE TABLE public\.ezil_computer_placements \([\s\S]*?\n\);/)![0];
const DIAGNOSTICS = { deviceClass: 'desktop', fullscreen: false, fullbleed: false,
    recentEvents: [{ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'aws_unavailable',
        reason: 'user_has_aws_computer', correlationId: '6f1c2a8e-5b7d-4c3e-9a1f-2b3c4d5e6f70' }] };
const OMIT = Symbol('omit diagnostics');
/** The same drizzle instance, typed for the admin queries (as `ingest.pg.test.ts` does). */
const adminDb = (db: FeedbackDb) => db as unknown as Parameters<typeof feedbackAdminQueries>[0];
const input = (computerId: string | undefined, diagnostics: unknown = DIAGNOSTICS, clientRequestId = randomUUID()) =>
    ({ v: 1, clientRequestId, category: 'bug', description: '[synthetic app-error] pg test',
        ...(computerId ? { computerId } : {}), ...(diagnostics === OMIT ? {} : { diagnostics }) }) as FeedbackSubmit;

describe.skipIf(!PG)('feedback submission-time server context on PostgreSQL', () => {
    const admin = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const schemas: string[] = [];
    const clients: postgres.Sql[] = [];
    async function world(opts: { compute?: boolean; slowPlacements?: boolean; reverse?: boolean } = {}) {
        const name = `fbctx_${randomUUID().replaceAll('-', '')}`;
        schemas.push(name);
        await admin!.unsafe(`CREATE SCHEMA ${name}`);
        const local = (sql: string) => sql.replaceAll('public.', `${name}.`);
        await admin!.begin((tx) => tx.unsafe(local(read('app/drizzle/0011_feedback.sql') + '\n' + read('app/drizzle/0022_feedback_notifications.sql'))));
        await admin!.unsafe(`CREATE TABLE ${name}.ezil_computers (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz)`);
        if (opts.compute !== false) {
            // Production deliberately has no 0012 reverse-move table (`reverse: false`).
            for (const file of ['0006_compute_migrations.sql', '0009_capacity_demands.sql', '0010_migration_restore_progress.sql',
                ...(opts.reverse === false ? [] : ['0012_compute_reverse_moves.sql'])]) {
                await admin!.begin((tx) => tx.unsafe(local(read(`app/drizzle/${file}`))));
            }
            await admin!.begin((tx) => tx.unsafe(local(placementDdl())));
            if (opts.slowPlacements) {
                // Every read of placements now takes a second: the lookup must hit its statement deadline.
                await admin!.unsafe(`ALTER TABLE ${name}.ezil_computer_placements RENAME TO placements_base;
                    CREATE VIEW ${name}.ezil_computer_placements AS SELECT b.* FROM ${name}.placements_base b, LATERAL (SELECT pg_sleep(1)) s`);
            }
        }
        const client = postgres(PG!, { max: 4, prepare: false, onnotice: () => {}, connection: { search_path: name } });
        clients.push(client);
        return { name, db: drizzle(client, { schema }) as unknown as FeedbackDb, client };
    }
    beforeAll(async () => {
        await admin!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
    });
    afterAll(async () => {
        for (const client of clients) await client.end();
        for (const name of schemas) await admin!.unsafe(`DROP SCHEMA ${name} CASCADE`);
        await admin?.end();
    });

    const reservation = (region = 'ap-south-1', instanceType = 'm7i.large') =>
        JSON.stringify({ _awsProvision: { placement: { region, instanceType }, instanceId: 'i-0abc1234def567890', volumeId: 'vol-0abc1234def567890' } });
    async function seed(name: string, me: string, selected: string, other: string, foreign: string, foreignComputer: string) {
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computers (id, user_id) VALUES ($1, $2), ($3, $2), ($4, $5)`, [selected, me, other, foreignComputer, foreign]);
        // The selected computer: Cloudflare, stopped. The other one is mid Cloudflare-to-AWS migration with an
        // unreleased reservation (no AWS placement yet): the hidden row that refuses a second AWS computer.
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computer_placements (computer_id, owner_user_id, provider, generation, lease_epoch, state, updated_at)
            VALUES ($1, $2, 'cloudflare', 1, 1, 'STOPPED', now())`, [selected, me]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state, workspace_head)
            VALUES ($1, $2, 'cloudflare', 'aws-ec2', 'standard', 'provisioning', ($3::text)::jsonb)`, [me, other, reservation()]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_capacity_demands (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu,
                deployment_digest, state, expires_at)
            VALUES ($1, $2, $3, 'create', 'ap-south-1', 'aps1-az1', 'm7i.large', 2, $4, 'active', now() + interval '5 minutes')`,
            [randomUUID(), me, other, 'a'.repeat(64)]);
        // Someone else's AWS computer, reservation and demand: none of it may be counted or shown.
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computer_placements (computer_id, owner_user_id, provider, generation, lease_epoch, state, region, instance_id, updated_at)
            VALUES ($1, $2, 'aws-ec2', 1, 1, 'RUNNING', 'us-east-1', 'i-0fff1234def567890', now())`, [foreignComputer, foreign]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state, workspace_head)
            VALUES ($1, $2, 'cloudflare', 'aws-ec2', 'premium', 'provisioning', ($3::text)::jsonb)`, [foreign, randomUUID(), reservation('us-east-1')]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_capacity_demands (request_id, owner_user_id, computer_id, kind, region, zone_id, instance_type, vcpu,
                deployment_digest, state, expires_at)
            VALUES ($1, $2, $3, 'create', 'us-east-1', 'use1-az1', 'm7i.large', 2, $4, 'active', now() + interval '5 minutes')`,
            [randomUUID(), foreign, foreignComputer, 'b'.repeat(64)]);
    }
    async function stored(name: string, me: string) {
        return admin!.unsafe(`SELECT id, diagnostics FROM ${name}.ezil_feedback_reports WHERE user_id = $1 ORDER BY created_at, id`, [me]);
    }

    it('a consented report about the own computer carries a bounded, actor-scoped submission-time context', async () => {
        const { name, db } = await world();
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        const result = await ingestFeedback(db, me, input(selected), NOW);
        if (result.status !== 201) throw new Error(`expected 201, got ${result.status}`);
        const [row] = await stored(name, me);
        const context = (row!.diagnostics as { serverContext: unknown }).serverContext;
        expect(context).toEqual({
            capturedAt: NOW.toISOString(), outcome: 'captured',
            selected: { provider: 'cloudflare', state: 'STOPPED', migration: null, reverseMove: null },
            otherComputers: { awsPlacements: '0', unreleasedReservations: '1', activeDemands: '1' },
        });
        expect(serverContextSchema.safeParse(context).success).toBe(true);
        // No workspace head, region, instance, volume, foreign or own raw id leaves SQL.
        const text = JSON.stringify(context);
        for (const secret of ['ap-south-1', 'us-east-1', 'i-0', 'vol-', 'm7i', '_awsProvision', me, other, foreign, foreignComputer, selected]) {
            expect(text).not.toContain(secret);
        }

        // Admin: the client's diagnostics exactly as posted, the server context beside them.
        const queries = feedbackAdminQueries(adminDb(db));
        const report = await queries.findReport(result.created.id);
        expect(report!.diagnostics).toEqual(DIAGNOSTICS);
        expect(report!.serverContext).toEqual(context);
        const [listed] = await queries.listReports([result.created.id]);
        expect(listed!.diagnostics).toEqual(DIAGNOSTICS);
        expect(listed!.serverContext).toEqual(context);
    });

    it('the selected computer\'s own migration and its unreleased reservation are named', async () => {
        const { name, db } = await world();
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        // One more own AWS computer elsewhere, then a computer whose OWN migration holds an unreleased reservation.
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computer_placements (computer_id, owner_user_id, provider, generation, lease_epoch, state, updated_at)
            VALUES ($1, $2, 'aws-ec2', 1, 1, 'RUNNING', now())`, [randomUUID(), me]);
        const target = randomUUID();
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computers (id, user_id) VALUES ($1, $2)`, [target, me]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state, workspace_head)
            VALUES ($1, $2, 'cloudflare', 'aws-ec2', 'standard', 'provisioning', ($3::text)::jsonb)`, [me, target, reservation()]);
        expect((await ingestFeedback(db, me, input(target), NOW)).status).toBe(201);
        const rows = await stored(name, me);
        expect((rows.at(-1)!.diagnostics as { serverContext: unknown }).serverContext).toMatchObject({
            outcome: 'captured',
            selected: { provider: 'none', state: 'none', migration: { direction: 'cf_to_aws', state: 'provisioning', unreleasedReservation: true }, reverseMove: null },
            otherComputers: { awsPlacements: '1', unreleasedReservations: '1', activeDemands: '1' },
        });
    });

    it('production shape without the reverse-move table: everything else is still captured; the field is omitted', async () => {
        const { name, db } = await world({ reverse: false });
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        expect((await admin!.unsafe(`SELECT to_regclass('${name}.ezil_compute_reverse_moves') AS t`))[0]!.t).toBeNull();
        expect((await ingestFeedback(db, me, input(selected), NOW)).status).toBe(201);
        const [row] = await stored(name, me);
        const context = (row!.diagnostics as { serverContext: Record<string, unknown> }).serverContext;
        expect(context).toEqual({
            capturedAt: NOW.toISOString(), outcome: 'captured',
            selected: { provider: 'cloudflare', state: 'STOPPED', migration: null },
            otherComputers: { awsPlacements: '0', unreleasedReservations: '1', activeDemands: '1' },
        });
        expect(serverContextSchema.safeParse(context).success).toBe(true);
    });

    it('with the reverse-move table, the selected computer\'s own latest move is named; another person\'s is not', async () => {
        const { name, db } = await world();
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_reverse_moves (user_id, computer_id, started_by, state) VALUES ($1, $2, 'user', 'copying')`, [me, selected]);
        await admin!.unsafe(`INSERT INTO ${name}.ezil_compute_reverse_moves (user_id, computer_id, started_by, state, retain_until) VALUES ($1, $2, 'user', 'committed', now() + interval '1 day')`, [foreign, selected]);
        // Newer than the reporter's own row: only the owner filter keeps it out.
        await admin!.unsafe(`UPDATE ${name}.ezil_compute_reverse_moves SET created_at = now() + interval '1 minute' WHERE user_id = $1`, [foreign]);
        expect((await ingestFeedback(db, me, input(selected), NOW)).status).toBe(201);
        const [row] = await stored(name, me);
        expect((row!.diagnostics as { serverContext: { selected: unknown } }).serverContext.selected)
            .toMatchObject({ reverseMove: { direction: 'aws_to_cf', state: 'copying' } });
    });

    it('consent off: no server context, diagnostics stay null', async () => {
        const { name, db } = await world();
        const [me, selected] = [randomUUID(), randomUUID()];
        await seed(name, me, selected, randomUUID(), randomUUID(), randomUUID());
        expect((await ingestFeedback(db, me, input(selected, null), NOW)).status).toBe(201);
        expect((await ingestFeedback(db, me, input(selected, OMIT), NOW)).status).toBe(201);
        const rows = await stored(name, me);
        expect(rows.map((r) => r.diagnostics)).toEqual([null, null]);
        const report = await feedbackAdminQueries(adminDb(db)).findReport(String(rows[0]!.id));
        expect(report).toMatchObject({ diagnostics: null, serverContext: null });
    });

    it('a foreign or unknown computer gets no association and no lookup', async () => {
        const { name, db } = await world();
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        expect((await ingestFeedback(db, me, input(foreignComputer), NOW)).status).toBe(201);
        expect((await ingestFeedback(db, me, input(randomUUID()), NOW)).status).toBe(201);
        expect((await ingestFeedback(db, me, input(undefined), NOW)).status).toBe(201);
        const rows = await stored(name, me);
        expect(rows.map((r) => r.diagnostics)).toEqual([DIAGNOSTICS, DIAGNOSTICS, DIAGNOSTICS]);
    });

    it('missing compute tables: the report is still stored, the context says unavailable', async () => {
        const { name, db } = await world({ compute: false });
        const [me, selected] = [randomUUID(), randomUUID()];
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computers (id, user_id) VALUES ($1, $2)`, [selected, me]);
        expect((await ingestFeedback(db, me, input(selected), NOW)).status).toBe(201);
        const [row] = await stored(name, me);
        expect(row!.diagnostics).toEqual({ ...DIAGNOSTICS, serverContext: { capturedAt: NOW.toISOString(), outcome: 'unavailable' } });
    });

    it('a lookup past its deadline is cancelled by the server (57014); the report is still stored', async () => {
        const { name, db } = await world({ slowPlacements: true });
        const [me, selected] = [randomUUID(), randomUUID()];
        await admin!.unsafe(`INSERT INTO ${name}.ezil_computers (id, user_id) VALUES ($1, $2)`, [selected, me]);
        await admin!.unsafe(`INSERT INTO ${name}.placements_base (computer_id, owner_user_id, provider, generation, lease_epoch, state, updated_at)
            VALUES ($1, $2, 'cloudflare', 1, 1, 'STOPPED', now())`, [selected, me]);
        const started = Date.now();
        expect((await ingestFeedback(db, me, input(selected), NOW)).status).toBe(201);
        expect(Date.now() - started).toBeLessThan(5_000);
        const [row] = await stored(name, me);
        expect((row!.diagnostics as { serverContext: unknown }).serverContext).toEqual({ capturedAt: NOW.toISOString(), outcome: 'timeout' });
    });

    it('the statement timeout is restored before the report INSERT, after success and after failure', async () => {
        for (const opts of [{}, { compute: false }]) {
            const { client } = await world(opts);
            const db = drizzle(client, { schema });
            const seen = await db.transaction(async (tx) => {
                await tx.execute(sql`SET LOCAL statement_timeout = '7s'`);
                const context = await captureServerContext(tx as never, { userId: randomUUID(), computerId: randomUUID(), now: NOW });
                const [after] = await tx.execute(sql`SELECT current_setting('statement_timeout') AS t`) as unknown as { t: string }[];
                return { outcome: context.outcome, after: after!.t };
            });
            expect(seen).toEqual({ outcome: opts.compute === false ? 'unavailable' : 'captured', after: '7s' });
        }
    });

    it('a retry returns the original report and never recaptures the snapshot', async () => {
        const { name, db } = await world();
        const [me, selected, other, foreign, foreignComputer] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
        await seed(name, me, selected, other, foreign, foreignComputer);
        const body = input(selected);
        const first = await ingestFeedback(db, me, body, NOW);
        const [before] = await stored(name, me);
        // The state changes: the reservation is released and the demand closes.
        await admin!.unsafe(`UPDATE ${name}.ezil_compute_migrations SET workspace_head = jsonb_set(workspace_head, '{_awsProvision,released}', 'true') WHERE user_id = $1`, [me]);
        await admin!.unsafe(`UPDATE ${name}.ezil_compute_capacity_demands SET state = 'cancelled', closed_at = now() WHERE owner_user_id = $1`, [me]);
        const retry = await ingestFeedback(db, me, body, new Date(NOW.getTime() + 60_000));
        expect(retry).toEqual({ status: 200, created: first.status === 201 ? first.created : null });
        const after = await stored(name, me);
        expect(after).toHaveLength(1);
        expect(after[0]!.diagnostics).toEqual(before!.diagnostics);
        // A NEW report sees the new state.
        expect((await ingestFeedback(db, me, input(selected), NOW)).status).toBe(201);
        const latest = (await stored(name, me)).find((r) => r.id !== before!.id)!;
        expect((latest.diagnostics as { serverContext: { otherComputers: unknown } }).serverContext.otherComputers)
            .toEqual({ awsPlacements: '0', unreleasedReservations: '0', activeDemands: '0' });
    });
});
