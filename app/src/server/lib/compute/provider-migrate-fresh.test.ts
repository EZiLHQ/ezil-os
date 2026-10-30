import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { finishFreshProvision, type PlacementDb } from './placement';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { createProviderMigrationStore } from './provider-migrate-store';
import { reduceMigration } from './provider-migrate';
const C = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
function fixture(patch: Record<string, unknown> = {}, loseCas = false) {
    let row = { id: C, user_id: U, computer_id: C, from_provider: 'cloudflare', to_provider: 'aws-ec2', to_size: 'standard',
        state: 'requested', generation: null, workspace_head: null, system_head: null, source_etag: null, source_system_etag: null,
        migrated_etag: null, attempts: 0, last_error: null as string | null, restore_token_sha256: null, restore_token_expires_at: null,
        created_at: '2026-10-01', updated_at: '2026-10-01' };
    const f = createFakePlacementDb({ placements: [placementRow({ computer_id: C, owner_user_id: U,
        provider: 'cloudflare', workspace_store: 'r2', state: 'STOPPED', ...patch })] });
    const queries: string[] = [], dialect = new PgDialect();
    const execute: PlacementDb['execute'] = async q => {
        const query = dialect.sqlToQuery(q); queries.push(query.sql);
        if (query.sql.includes('SELECT') && query.sql.includes('ezil_compute_migrations')) return [row];
        if (query.sql.includes('UPDATE public.ezil_compute_migrations')) {
            if (loseCas) return [];
            row = { ...row, state: String(query.params[0]), last_error: 'fresh_provision' }; return [row];
        }
        if (query.sql.includes('placement:fresh-remove')) {
            expect(query.sql).toMatch(/owner_user_id = [\s\S]*provider = 'cloudflare' AND state = 'STOPPED'[\s\S]*generation = [\s\S]*lease_epoch =/);
            return f.placements.splice(0);
        }
        return f.db.execute(q);
    };
    const db: PlacementDb = { execute, transaction: async run => {
        const before = structuredClone(f.placements), beforeRow = structuredClone(row);
        try { return await f.db.transaction(tx => run({ execute: async q => {
            const text = dialect.sqlToQuery(q).sql;
            if (/ezil_compute_migrations|placement:fresh-remove/.test(text)) return execute(q);
            queries.push(text); return tx.execute(q);
        } })); }
        catch (error) { f.placements.splice(0, f.placements.length, ...before); row = beforeRow; throw error; }
    } };
    return { ...f, db, queries, migration: () => createProviderMigrationStore(db).readById(C) };
}
describe('empty workspace placement transaction', () => {
    it('rechecks emptiness under the computer lock and atomically commits fresh_provision', async () => {
        const f = fixture(), m = (await f.migration())!;
        const proof = vi.fn(async () => { expect(f.queries.some(q => q.includes('placement:lock-computer'))).toBe(true); return true; });
        await finishFreshProvision(f.db, m, proof);
        expect(proof).toHaveBeenCalledOnce(); expect(f.placements).toEqual([]);
        expect(await f.migration()).toMatchObject({ state: 'committed', lastError: 'fresh_provision' });
    });
    it('retains the pin if the second emptiness check fails', async () => {
        const f = fixture(); await expect(finishFreshProvision(f.db, (await f.migration())!, async () => false)).rejects.toThrow('migration_conflict');
        expect(f.placements).toHaveLength(1); expect((await f.migration())?.state).toBe('requested');
    });
    it('rolls deletion back on a migration CAS loss', async () => {
        const f = fixture({}, true); await expect(finishFreshProvision(f.db, (await f.migration())!, async () => true)).rejects.toThrow('migration_conflict');
        expect(f.placements).toHaveLength(1);
    });
    it.each([{ state: 'RUNNING' }, { owner_user_id: C }, { provider: 'aws-ec2', workspace_store: 'ebs' }])('rejects an incompatible pin %j', async patch => {
        const f = fixture(patch), proof = vi.fn(async () => true);
        await expect(finishFreshProvision(f.db, (await f.migration())!, proof)).rejects.toThrow('migration_conflict');
        expect(f.placements).toHaveLength(1); expect(proof).not.toHaveBeenCalled();
    });
    it.each([{ userId: C }, { computerId: U }, { updatedAt: 'stale' }])('rejects stale or mismatched migration identity %j', async patch => {
        const f = fixture(), m = (await f.migration())!;
        await expect(finishFreshProvision(f.db, { ...m, ...patch }, async () => true)).rejects.toThrow('migration_conflict');
        expect(f.placements).toHaveLength(1);
    });
    it.each([{ workspaceHead: { generation: C } }, { sourceEtag: 'old' }, { generation: C }, { state: 'fenced' as const }])('refuses existing migration evidence %j even with an empty proof', async patch => {
        const f = fixture(), m = (await f.migration())!;
        expect(reduceMigration({ ...m, ...patch }, { type: 'fresh_provision' }).accepted).toBe(false);
        expect(reduceMigration(m, { type: 'fresh_provision' }).migration).toMatchObject({ state: 'committed', lastError: 'fresh_provision' });
    });
});
