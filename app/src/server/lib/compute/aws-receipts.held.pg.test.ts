/** Disposable PostgreSQL only; never imports the app DB or reads credentials. Round 6 R1-01: the held bound's read. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readRunningAwsPlacements } from './aws-receipts';
import type { PlacementExecutor } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `held_read_test_${randomUUID().replaceAll('-', '')}`;
const owner = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;

describe.skipIf(!PG)('readRunningAwsPlacements on production Drizzle PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 4, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const db: PlacementExecutor = { execute: q => production!.execute(scoped(q)) };
    const row = async (n: number, fields: { provider?: string; state?: string; job?: string | null; image?: string | null; lastError?: string | null; updatedAt: string }) =>
        client!.unsafe(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, lifecycle_job_id, image_upgrade_job_id, last_error, updated_at)
            VALUES ($1, $2, $3, $4, 1, 1, $5, $6, $7, $8, $9)`, [id(n), owner, fields.provider ?? 'aws-ec2', fields.provider === 'cloudflare' ? 'r2' : 'ebs',
            fields.state ?? 'RUNNING', fields.job ?? null, fields.image ?? null, fields.lastError ?? null, fields.updatedAt]);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
    });
    beforeEach(async () => { await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_placements`); });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    it('lists only idle RUNNING aws-ec2 rows, oldest write first, with the exact write time', async () => {
        await row(1, { updatedAt: '2026-10-30T05:42:01.123Z' });
        await row(2, { updatedAt: '2026-10-30T04:00:00.000Z', lastError: 'enrollment_succeeded' });
        await row(3, { updatedAt: '2026-10-30T03:00:00.000Z', job: randomUUID() }); // a lifecycle job in flight
        await row(4, { updatedAt: '2026-10-30T03:00:00.000Z', image: randomUUID() }); // an image job holds it
        await row(5, { updatedAt: '2026-10-30T03:00:00.000Z', lastError: 'migration_pending:1234' });
        await row(6, { updatedAt: '2026-10-30T03:00:00.000Z', state: 'STARTING' });
        await row(7, { updatedAt: '2026-10-30T03:00:00.000Z', state: 'STOPPED' });
        await row(8, { updatedAt: '2026-10-30T03:00:00.000Z', provider: 'cloudflare' });
        await row(9, { updatedAt: '2026-10-30T03:00:00.000Z', lastError: 'migrationXpending:1' }); // only the exact prefix is skipped
        const listed = await readRunningAwsPlacements(db, 10);
        expect(listed).toEqual([
            { userId: owner, computerId: id(9), since: new Date('2026-10-30T03:00:00.000Z') },
            { userId: owner, computerId: id(2), since: new Date('2026-10-30T04:00:00.000Z') },
            { userId: owner, computerId: id(1), since: new Date('2026-10-30T05:42:01.123Z') },
        ]);
        expect(await readRunningAwsPlacements(db, 1)).toEqual([listed[0]]);
        expect(await readRunningAwsPlacements(db, 0)).toEqual([]);
    });

    it('a database without the placement table reads as none', async () => {
        const missing: PlacementExecutor = { execute: q => production!.execute(sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
            ? sql.raw(chunk.value.join('').replaceAll('public.', `${schema}_absent.`)) : chunk), sql.empty())) };
        expect(await readRunningAwsPlacements(missing, 10)).toEqual([]);
    });
});
