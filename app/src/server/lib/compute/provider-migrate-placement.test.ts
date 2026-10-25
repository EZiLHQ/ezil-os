import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { flipPlacementToAws, type PlacementDb } from './placement';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { MIGRATION_STATES } from './provider-migrate';

const C = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const input = { computerId: C, ownerUserId: U, migrationId: C,
    fields: { region: 'ap-south-1' as const, instanceId: 'i-restored', volumeId: 'vol-restored', fsUuid: C } };
const original = () => placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2', state: 'RUNNING' });
const migration = { state: 'restored', computer_id: C, user_id: U, to_provider: 'aws-ec2' };
function setup(options: { migration?: Record<string, unknown> | null; source?: Record<string, unknown>[]; failInsert?: boolean } = {}) {
    const f = createFakePlacementDb({ placements: options.source ?? [original()] });
    const dialect = new PgDialect();
    const queries: string[] = [];
    const db: PlacementDb = {
        execute: f.db.execute,
        async transaction(fn) {
            const before = structuredClone(f.placements);
            try {
                return await f.db.transaction(tx => fn({ execute: async query => {
                    const q = dialect.sqlToQuery(query); queries.push(q.sql);
                    if (q.sql.includes('FROM public.ezil_compute_migrations')) {
                        expect(q.sql).toContain('FOR UPDATE');
                        return { rows: [options.migration === undefined ? migration : options.migration].filter(Boolean) };
                    }
                    if (q.sql.includes('placement:migration-remove')) {
                        expect(q.sql).toMatch(/computer_id = [\s\S]*owner_user_id = [\s\S]*provider = 'cloudflare' AND state = 'RETIRED' AND generation = [\s\S]*lease_epoch =/);
                        const removed = f.placements.splice(0);
                        return { rows: removed };
                    }
                    if (options.failInsert && q.sql.includes('placement:insert')) throw new Error('insert_failed');
                    return tx.execute(query);
                } }));
            } catch (error) { f.placements.splice(0, f.placements.length, ...before); throw error; }
        },
    };
    return { ...f, db, queries };
}
describe('migration placement publication', () => {
    it.each(MIGRATION_STATES.filter(s => s !== 'restored'))('refuses migration state %s without touching source', async state => {
        const f = setup({ migration: { ...migration, state } });
        await expect(flipPlacementToAws(f.db, input)).rejects.toThrow('migration_not_restored');
        expect(f.placements).toEqual([original()]);
        expect(f.queries.some(q => /placement:(cas|insert|migration-remove)/.test(q))).toBe(false);
    });
    it.each([null, { ...migration, user_id: C }, { ...migration, computer_id: U }, { ...migration, to_provider: 'cloudflare' }, { ...migration, last_error: 'recovery:reopen:commit' }])('rejects missing or mismatched migration %j', async m => {
        await expect(flipPlacementToAws(setup({ migration: m }).db, input)).rejects.toThrow('migration_not_restored');
    });
    it('retires and replaces under global and computer locks in one transaction', async () => {
        const f = setup();
        const p = await flipPlacementToAws(f.db, input);
        expect(p).toMatchObject({ provider: 'aws-ec2', store: 'ebs', state: 'RUNNING', generation: 1, leaseEpoch: 1, instanceId: 'i-restored' });
        expect(f.placements).toHaveLength(1);
        expect(f.queries[0]).toContain('placement:lock-admission');
        expect(f.queries[1]).toContain('placement:lock-computer');
        const states = f.statements.filter(q => q.sql.includes('placement:cas')).map(q => q.params[0]);
        expect(states).toEqual(['RETIRING', 'RETIRED']);
        expect(f.statements.filter(q => q.sql === 'BEGIN')).toHaveLength(1);
        expect(f.statements.at(-1)?.sql).toBe('COMMIT');
    });
    it('also replaces implicit Cloudflare placement', async () => {
        const f = setup({ source: [] });
        expect((await flipPlacementToAws(f.db, input)).provider).toBe('aws-ec2');
    });
    it('rolls retirement and deletion back if AWS creation fails', async () => {
        const f = setup({ failInsert: true });
        await expect(flipPlacementToAws(f.db, input)).rejects.toThrow('insert_failed');
        expect(f.placements).toEqual([original()]);
        expect(f.statements.at(-1)?.sql).toBe('ROLLBACK');
    });
    it.each([{ owner_user_id: C }, { provider: 'aws-ec2', workspace_store: 'ebs' }, { state: 'PROVISIONING' }])('rejects incompatible source %j', async patch => {
        await expect(flipPlacementToAws(setup({ source: [{ ...original(), ...patch }] }).db, input)).rejects.toThrow();
    });
    it.each([{ region: 'us-east-1' }, { instanceId: '' }, { volumeId: '' }, { fsUuid: '' }])('rejects incomplete Mumbai receipt %j', async fields => {
        await expect(flipPlacementToAws(setup().db, { ...input, fields: { ...input.fields, ...fields } } as typeof input)).rejects.toThrow('migration_aws_receipt_invalid');
    });
});


describe('publication replay and the commit barrier', () => {
    it('repeating the same restored-host publication does not replace the host', async () => {
        const f = setup(); const first = await flipPlacementToAws(f.db, input);
        const second = await flipPlacementToAws(f.db, input);
        expect(second).toEqual(first); expect(f.placements).toHaveLength(1);
        expect(f.statements.filter(q => q.sql.includes('placement:insert'))).toHaveLength(1);
    });
    it('keeps a migrated host provisioning until the first normal receipt after commit', async () => {
        const f = setup(); const pending = { ...input, pendingReady: true,
            fields: { ...input.fields, lastError: `migration_pending:${C}` } };
        const p = await flipPlacementToAws(f.db, pending);
        expect(p.state).toBe('PROVISIONING'); expect(p.lastError).toBe(`migration_pending:${C}`);
        expect((await flipPlacementToAws(f.db, pending)).instanceId).toBe(p.instanceId);
    });
    it('rejects a different restored host during replay', async () => {
        const f = setup(); await flipPlacementToAws(f.db, input);
        await expect(flipPlacementToAws(f.db, { ...input, fields: { ...input.fields, instanceId: 'i-other' } })).rejects.toThrow('migration_source_mismatch');
    });
});
