/** Opt-in disposable PostgreSQL; never uses the application connection. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProviderMigrationStore } from './provider-migrate-store';

const PG = process.env.BILLING_TEST_DATABASE_URL;
const schema = `restore_progress_test_${randomUUID().replaceAll('-', '')}`;
const C = '11111111-1111-4111-8111-111111111111', G = '22222222-2222-4222-8222-222222222222';
const start = new Date('2026-10-26T10:00:00Z');
describe.skipIf(!PG)('restore accounting on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const local = (query: string) => query.replaceAll('public.', `${schema}.`);
    let servedAt = start, created = false;
    const store = createProviderMigrationStore({ execute: async query => {
        const rendered = dialect.sqlToQuery(query);
        return client!.unsafe(local(rendered.sql), rendered.params as never[]);
    } }, { now: () => servedAt });
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0006_compute_migrations.sql', '0010_migration_restore_progress.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8')));
    });
    beforeEach(async () => { servedAt = start; await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_migrations`); });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });
    async function exported() {
        let m = await store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' });
        m = (await store.applyTransition(m, { type: 'fenced', etag: 'source', systemEtag: 'system', generation: G })).migration;
        return (await store.applyTransition(m, { type: 'exported',
            workspaceHead: { generation: G, chunks: Array.from({ length: 512 }, (_, index) => ({ size: 100 + index })) },
            systemHead: { generation: C, chunks: Array.from({ length: 512 }, (_, index) => ({ size: 10 + index })) },
        })).migration;
    }
    it('counts the same chunk once, keeps first fixed, advances last and preserves the lifecycle timestamp', async () => {
        const m = await exported();
        await store.recordRestoreChunk(m, 'workspace', 2);
        servedAt = new Date(start.getTime() + 1000);
        await store.recordRestoreChunk(m, 'workspace', 2);
        const current = (await store.readById(m.id))!;
        expect(current.restoreProgress).toEqual({ workspace: '04'.padEnd(128, '0'), system: '0'.repeat(128), bytes: 102,
            first: start.toISOString(), last: servedAt.toISOString() });
        expect(current.updatedAt).toBe(m.updatedAt);
        expect((await store.applyTransition(m, { type: 'provisioned' })).accepted).toBe(true);
    });
    it('preserves out-of-order indices across byte boundaries and the highest bit', async () => {
        const m = await exported();
        for (const index of [511, 8, 0, 255, 7, 8]) await store.recordRestoreChunk(m, 'workspace', index);
        const progress = (await store.readById(m.id))!.restoreProgress!;
        const bits = Buffer.alloc(64); bits[0] = 129; bits[1] = 1; bits[31] = 128; bits[63] = 128;
        expect(progress.workspace).toBe(bits.toString('hex'));
        expect(progress.bytes).toBe(5 * 100 + 511 + 8 + 255 + 7);
    });
    it('serializes concurrent distinct and duplicate indices without losing increments', async () => {
        const m = await exported(), indices = [511, 0, 31, 255, 7, 31, 0, 511, 8, 9];
        await Promise.all(indices.map(index => store.recordRestoreChunk(m, 'workspace', index)));
        const progress = (await store.readById(m.id))!.restoreProgress!;
        expect(progress.bytes).toBe([...new Set(indices)].reduce((sum, index) => sum + 100 + index, 0));
        const bits = Buffer.alloc(64);
        for (const index of indices) bits[Math.floor(index / 8)]! |= 1 << (index % 8);
        expect(progress.workspace).toBe(bits.toString('hex'));
    });
    it('counts system separately from the same workspace indices, including concurrent replays', async () => {
        const m = await exported();
        await Promise.all(['workspace', 'system', 'system', 'workspace'].map(kind => store.recordRestoreChunk(m, kind as 'workspace' | 'system', 0)));
        expect((await store.readById(m.id))!.restoreProgress).toMatchObject({ workspace: '01'.padEnd(128, '0'), system: '01'.padEnd(128, '0'), bytes: 110 });
    });
    it('does not regress last when an older request finishes later, and fences the migration generation', async () => {
        const m = await exported();
        await store.recordRestoreChunk(m, 'workspace', 0);
        servedAt = new Date(start.getTime() - 1000);
        await store.recordRestoreChunk(m, 'workspace', 1);
        await store.recordRestoreChunk({ ...m, generation: C }, 'workspace', 2);
        expect((await store.readById(m.id))!.restoreProgress).toMatchObject({ bytes: 201, first: start.toISOString(), last: start.toISOString() });
    });
});
