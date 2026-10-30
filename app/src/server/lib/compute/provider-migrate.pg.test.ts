/** Opt-in disposable PostgreSQL; never uses the application connection. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProviderMigrationStore } from './provider-migrate-store';
import { createPlacement, flipPlacementToAws, readPlacement, type PlacementDb, type PlacementExecutor } from './placement';

const PG = process.env.BILLING_TEST_DATABASE_URL;
const schema = `migration_test_${randomUUID().replaceAll('-', '')}`;
const C = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
describe.skipIf(!PG)('migration store on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const executor = (c: { unsafe: (q: string, params: never[]) => PromiseLike<unknown> }): PlacementExecutor => ({ execute: async q => {
        const rendered = dialect.sqlToQuery(q); return c.unsafe(local(rendered.sql), rendered.params as never[]);
    } });
    const db: PlacementDb = { execute: q => executor(client!).execute(q), transaction: async fn =>
        client!.begin(async tx => fn(executor(tx))) as Promise<Awaited<ReturnType<typeof fn>>> };
    const store = createProviderMigrationStore(db);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Same RLS setup as the repository's disposable billing DB tests.
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0006_compute_migrations.sql'), 'utf8')));
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
    });
    beforeEach(async () => { await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_migrations, ${schema}.ezil_computer_placements`); });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });
    const create = () => store.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' });
    async function exported() {
        let m = await create();
        m = (await store.applyTransition(m, { type: 'fenced', etag: 'source', systemEtag: null, generation: C })).migration;
        return (await store.applyTransition(m, { type: 'exported', workspaceHead: { generation: C }, systemHead: null })).migration;
    }
    it('readByComputer returns the newest row (ORDER BY is unambiguous with the text-cast columns)', async () => {
        expect(await store.readByComputer(C)).toBeNull();
        const m = await create();
        expect((await store.readByComputer(C))?.id).toBe(m.id);
    });

    it('concurrent create returns one active row', async () => {
        const results = await Promise.all(Array.from({ length: 12 }, create));
        expect(new Set(results.map(m => m.id)).size).toBe(1);
    });
    it('only one concurrent transition can consume a timestamp', async () => {
        const m = await exported();
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.applyTransition(m, { type: 'provisioned' })));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    });
    it('rotation invalidates the old capability and commit prevents reuse', async () => {
        let m = await exported();
        const first = await store.mintRestoreToken(m);
        m = (await store.readById(m.id))!;
        const second = await store.mintRestoreToken(m);
        expect(await store.verifyRestoreToken(C, C, first)).toBe(false);
        expect(await store.verifyRestoreToken(C, C, second)).toBe(true);
        m = (await store.readById(m.id))!;
        m = (await store.applyTransition(m, { type: 'provisioned' })).migration;
        m = (await store.applyTransition(m, { type: 'host_restored', generation: C })).migration;
        await store.applyTransition(m, { type: 'committed', migratedEtag: 'new' });
        expect(await store.verifyRestoreToken(C, C, second)).toBe(false);
        expect((await create()).id).not.toBe(m.id);
    });
    it('real transaction rolls source retirement back on failed insert', async () => {
        let m = await exported();
        m = (await store.applyTransition(m, { type: 'provisioned' })).migration;
        m = (await store.applyTransition(m, { type: 'host_restored', generation: C })).migration;
        await createPlacement(db, { computerId: C, ownerUserId: U, provider: 'cloudflare', state: 'RUNNING' });
        const fields = { region: 'ap-south-1' as const, instanceId: 'i-restored', volumeId: 'vol-restored', fsUuid: 'invalid-uuid' };
        await expect(flipPlacementToAws(db, { computerId: C, ownerUserId: U, migrationId: m.id, fields })).rejects.toThrow();
        expect((await readPlacement(db, C)).record).toMatchObject({ provider: 'cloudflare', state: 'RUNNING' });
        const result = await flipPlacementToAws(db, { computerId: C, ownerUserId: U, migrationId: m.id, fields: { ...fields, fsUuid: C } });
        expect(result).toMatchObject({ provider: 'aws-ec2', store: 'ebs', state: 'RUNNING' });
    });
});
