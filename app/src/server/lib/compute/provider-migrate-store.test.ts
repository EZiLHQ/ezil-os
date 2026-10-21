import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import { createProviderMigrationStore, restoreTokenMatches, type ComputeMigration } from './provider-migrate-store';
import { MIGRATION_STATES } from './provider-migrate';

vi.mock('node:crypto', async original => {
    const actual = await original<typeof import('node:crypto')>();
    return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});
import { timingSafeEqual } from 'node:crypto';

const C = '11111111-1111-4111-8111-111111111111', G = '22222222-2222-4222-8222-222222222222';
const now = new Date('2026-10-20T12:00:00Z');
const token = Buffer.alloc(32, 7).toString('base64url');
const row = {
    id: G, user_id: G, computer_id: C, from_provider: 'cloudflare', to_provider: 'aws-ec2', to_size: 'standard',
    state: 'exported', generation: G, workspace_head: { generation: G }, system_head: null, source_etag: 'old', source_system_etag: null,
    migrated_etag: null, attempts: 0, last_error: null, restore_token_sha256: createHash('sha256').update(token).digest('hex'),
    restore_token_expires_at: new Date(now.getTime() + 900_000).toISOString(), created_at: now.toISOString(), updated_at: '2026-10-20 12:00:00.000001+00',
};
const dialect = new PgDialect();
function setup(results: unknown[] = [[row]]) {
    const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
    const store = createProviderMigrationStore({ execute: async query => {
        queries.push(dialect.sqlToQuery(query));
        return results.shift() ?? [];
    } }, { now: () => now });
    return { store, queries };
}
async function migration(): Promise<ComputeMigration> { return (await setup().store.readById(G))!; }

describe('restore tokens', () => {
    it('accepts only the right computer, generation, secret and unexpired capability', async () => {
        const m = await migration();
        expect(restoreTokenMatches(m, C, G, token, now)).toBe(true);
        for (const [computer, generation, secret, time] of [
            [G, G, token, now], [C, C, token, now], [C, G, token + 'x', now],
            [C, G, token, new Date(now.getTime() + 900_000)], [C, G, token, new Date(now.getTime() + 900_001)],
        ] as const) expect(restoreTokenMatches(m, computer, generation, secret, time)).toBe(false);
        expect(restoreTokenMatches({ ...m, restoreTokenExpiresAt: null }, C, G, token, now)).toBe(false);
        expect(restoreTokenMatches({ ...m, lastError: 'recovery:abort:export' }, C, G, token, now)).toBe(false);
    });
    it.each(MIGRATION_STATES)('state %s gates token reuse including after commit', async state => {
        expect(restoreTokenMatches({ ...await migration(), state }, C, G, token, now)).toBe(['exported', 'provisioning'].includes(state));
    });
    it('uses timingSafeEqual on exactly 32 bytes even for missing or corrupt records', async () => {
        const m = await migration();
        for (const candidate of [m, null, { ...m, restoreTokenSha256: 'bad' }, { ...m, restoreTokenSha256: null }]) {
            vi.mocked(timingSafeEqual).mockClear();
            restoreTokenMatches(candidate, C, G, 'wrong length', now);
            expect(timingSafeEqual).toHaveBeenCalledOnce();
            const [a, b] = vi.mocked(timingSafeEqual).mock.calls[0]!;
            expect(a.byteLength).toBe(32); expect(b.byteLength).toBe(32);
        }
    });
    it('mints 32 random bytes, stores only hash with 15 minute expiry, and CAS guards rotation', async () => {
        const m = await migration();
        const f = setup([[row], [row]]);
        const first = await f.store.mintRestoreToken(m), second = await f.store.mintRestoreToken(m);
        expect(first).not.toBe(second);
        expect(Buffer.from(first, 'base64url')).toHaveLength(32);
        const q = f.queries[0]!;
        expect(q.params).not.toContain(first);
        expect(q.params).toContain(createHash('sha256').update(first).digest('hex'));
        expect(q.params).toContain('2026-10-20T12:15:00.000Z');
        expect(q.sql).toMatch(/computer_id = [\s\S]*generation =/);
        expect(q.sql).toMatch(/state = [\s\S]*state IN \('exported', 'provisioning'\)[\s\S]*updated_at::text =/);
        expect(q.params).toContain(m.updatedAt);
        await expect(setup([[]]).store.mintRestoreToken(m)).rejects.toThrow('migration_conflict');
    });
    it('refuses mint before export and during compensation', async () => {
        const m = await migration();
        for (const patch of [{ state: 'requested' as const }, { generation: null }, { workspaceHead: null }, { generation: C }, { lastError: 'recovery:reopen:commit' }])
            await expect(setup().store.mintRestoreToken({ ...m, ...patch })).rejects.toThrow('migration_not_exported');
    });
    it('verification reads the requested active computer', async () => {
        const f = setup();
        expect(await f.store.verifyRestoreToken(C, G, token)).toBe(true);
        expect(f.queries[0]!.params).toEqual([C]);
        expect(f.queries[0]!.sql).toContain("state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')");
    });
});

describe('migration persistence', () => {
    it('create or get is constrained by the partial unique index, owner and target', async () => {
        const f = setup([[], [row]]);
        expect((await f.store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).id).toBe(G);
        expect(f.queries[0]!.sql).toMatch(/ON CONFLICT \(computer_id\) WHERE state NOT IN .* DO NOTHING/);
        await expect(setup().store.createOrGetActive({ computerId: C, userId: C, toSize: 'standard' })).rejects.toThrow('migration_conflict');
        await expect(setup().store.createOrGetActive({ computerId: C, userId: G, toSize: 'premium' })).rejects.toThrow('migration_conflict');
        await expect(setup([]).store.createOrGetActive({ computerId: C, userId: G, toSize: 'standard' })).rejects.toThrow('migration_conflict');
    });
    it('preserves timestamp precision, compares state and timestamp, and reports lost races', async () => {
        const m = await migration();
        expect(m.updatedAt).toBe(row.updated_at);
        const f = setup();
        await f.store.applyTransition(m, { type: 'provisioned' });
        // Compared as text: a timestamptz-cast parameter is re-encoded by the driver and never matches.
        expect(f.queries[0]!.sql).toMatch(/WHERE id = [\s\S]* AND state = [\s\S]* AND updated_at::text = /);
        expect(f.queries[0]!.sql).toMatch(/workspace_head = \([\s\S]*::text\)::jsonb/);
        expect(f.queries[0]!.sql).toContain("updated_at + interval '1 microsecond'");
        expect(f.queries[0]!.params).toContain(row.updated_at);
        await expect(setup([]).store.applyTransition(m, { type: 'provisioned' })).rejects.toThrow('migration_conflict');
    });
    it('illegal events do not write; compensation invalidates the stored capability', async () => {
        const m = await migration(), f = setup();
        expect((await f.store.applyTransition(m, { type: 'committed', migratedEtag: 'x' })).accepted).toBe(false);
        expect(f.queries).toHaveLength(0);
        const r = await f.store.applyTransition(m, { type: 'error', step: 'export', retryable: false });
        expect(r.effect).toBe('abort');
        expect(f.queries[0]!.params).not.toContain(row.restore_token_sha256);
        expect(f.queries[0]!.params).not.toContain(row.restore_token_expires_at);
    });
});

describe('stale migration claims and server status', () => {
    it.each([-1, 0, 2, 10, 99, NaN])('bounds claim %s and locks only stale nonterminal rows', async limit => {
        const f = setup(); await f.store.claimStale(limit);
        const q = f.queries[0]!;
        expect(q.params).toEqual([Number.isFinite(limit) ? Math.max(0, Math.min(10, limit)) : 0]);
        expect(q.sql).toContain("updated_at < clock_timestamp() - interval '30 seconds'");
        expect(q.sql).toContain('FOR UPDATE SKIP LOCKED');
        expect(q.sql).toContain("state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')");
        expect(q.sql).toContain('UPDATE public.ezil_compute_migrations');
    });
    it.each(MIGRATION_STATES)('reports %s without exposing operational detail', async state => {
        expect(await setup([[{ state }]]).store.statusFor(G)).toBe(state === 'committed' ? null : state.startsWith('failed_') ? 'failed' : 'preparing');
    });
    it('has no hint without a migration', async () => { expect(await setup([[]]).store.statusFor(G)).toBeNull(); });
});
