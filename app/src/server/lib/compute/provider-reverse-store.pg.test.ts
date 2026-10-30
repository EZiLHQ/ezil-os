/** Opt-in disposable PostgreSQL (BILLING_TEST_DATABASE_URL); never uses the application connection. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { computeReverseMoves } from '../../db/schema/computers';
import type { PlacementDb, PlacementExecutor } from './placement';
import { createProviderMigrationStore, MigrationConflictError } from './provider-migrate-store';
import {
    createProviderReverseStore, EXPORT_CHUNK_BYTES,
    type ComputeReverseMove, type ReverseExportBoot, type ReverseExportHead,
} from './provider-reverse-store';

const PG = process.env.BILLING_TEST_DATABASE_URL;
const schema = `reverse_moves_test_${randomUUID().replaceAll('-', '')}`;
const C = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const C2 = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const start = new Date('2026-10-30T09:00:00Z');
const boot: ReverseExportBoot = { placementGeneration: 4, leaseEpoch: 7, volumeId: 'vol-0b1ffbc8f8cfa6384', jobId: null,
    instanceId: null, fsUuid: null, claimedAt: start.toISOString() };
const enrolled: ReverseExportBoot = { ...boot, jobId: JOB, instanceId: 'i-0123456789abcdef0', fsUuid: OTHER };
const headFor = (generation: string, sizes = [EXPORT_CHUNK_BYTES, EXPORT_CHUNK_BYTES, 1234]): ReverseExportHead => ({
    generation, sha256: 'f'.repeat(64), entries: 42, skipped: 2, bytes: sizes.reduce((a, b) => a + b, 0),
    chunks: sizes.map((size, i) => ({ i, size, sha256: String(i % 10).repeat(64) })),
});
const conflict = (reason: string) => expect.objectContaining({ reason, message: `reverse_move_conflict:${reason}` });

describe.skipIf(!PG)('reverse moves (0012) on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const executor = (c: { unsafe: (q: string, params: never[]) => PromiseLike<unknown> }): PlacementExecutor => ({ execute: async q => {
        const rendered = dialect.sqlToQuery(q); return c.unsafe(local(rendered.sql), rendered.params as never[]);
    } });
    const db: PlacementDb = { execute: q => executor(client!).execute(q), transaction: async fn =>
        client!.begin(async tx => fn(executor(tx))) as Promise<Awaited<ReturnType<typeof fn>>> };
    let clock = start;
    const reverse = createProviderReverseStore(db, { now: () => clock });
    const forward = createProviderMigrationStore(db);
    const q = (text: string) => client!.unsafe(text.replaceAll('$S', schema));
    const holding = async () => Number((await q(`SELECT
        (SELECT count(*) FROM $S.ezil_compute_reverse_moves WHERE state NOT IN ('committed', 'failed_reopened'))
      + (SELECT count(*) FROM $S.ezil_compute_migrations WHERE state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')) AS n`))[0]!.n);
    const create = (computerId = C, userId = U) => reverse.createOrGetActive({ computerId, userId, startedBy: 'user' });
    async function toCopying(): Promise<ComputeReverseMove> {
        let m = await create();
        m = await reverse.recordExportBoot(m, enrolled);
        m = await reverse.advance(m, 'exporting');
        return reverse.recordExportHead(m, headFor(m.generation));
    }
    async function toFlipping(): Promise<ComputeReverseMove> {
        let m = await toCopying();
        m = await reverse.recordImportProgress(m, m.exportHead!.chunks.map(chunk => chunk.i));
        return reverse.advance(await reverse.advance(m, 'checking'), 'flipping');
    }
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Supabase grants client roles ALL on new public tables by default; reproduce that here so the
        // grant test proves 0012's REVOKE, not an empty custom schema.
        await client!.unsafe(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${schema} GRANT ALL ON TABLES TO anon, authenticated`);
        for (const file of ['0006_compute_migrations.sql', '0010_migration_restore_progress.sql', '0012_compute_reverse_moves.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8')));
    });
    beforeEach(async () => {
        clock = start;
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_reverse_moves, ${schema}.ezil_compute_migrations`);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    it('concurrent creators share one requested row; another owner and bad input are refused', async () => {
        const results = await Promise.all(Array.from({ length: 12 }, () => create()));
        expect(new Set(results.map(m => m.id)).size).toBe(1);
        expect(results[0]).toMatchObject({ computerId: C, userId: U, startedBy: 'user', state: 'requested', attempts: 0, lastError: null,
            exportBoot: null, exportHead: null, importProgress: null, bytesTotal: null, skipped: null, awsVolumeId: null, retainUntil: null });
        expect(results[0]!.generation).toMatch(UUID);
        await expect(create(C, OTHER)).rejects.toEqual(conflict('owner_mismatch'));
        await expect(reverse.createOrGetActive({ computerId: 'not-a-uuid', userId: U, startedBy: 'user' })).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.createOrGetActive({ computerId: C2, userId: U, startedBy: 'operator' as never })).rejects.toEqual(conflict('invalid_input'));
        expect(await holding()).toBe(1);
    });

    it('one holding row per computer: committed and failed_reopened release it, failed_needs_operator holds it until an operator releases it', async () => {
        const first = await create();
        const stuck = await reverse.fail(first, 'failed_needs_operator', 'import_commit_unknown');
        expect((await create()).id).toBe(stuck.id);
        await expect(q(`INSERT INTO $S.ezil_compute_reverse_moves (computer_id, user_id, started_by) VALUES ('${C}', '${U}', 'cron')`))
            .rejects.toThrow(/ezil_compute_reverse_moves_one_active_per_computer/);
        const released = await reverse.fail(stuck, 'failed_reopened', 'operator_released');
        expect(released).toMatchObject({ state: 'failed_reopened', lastError: 'operator_released' });
        const next = await create();
        expect(next.id).not.toBe(first.id);
        expect(next.generation).not.toBe(first.generation);
        const done = await reverse.finish(await toFlippingFrom(next), { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null });
        expect(done.state).toBe('committed');
        expect((await create()).id).not.toBe(next.id);
    });
    async function toFlippingFrom(m: ComputeReverseMove): Promise<ComputeReverseMove> {
        m = await reverse.advance(await reverse.recordExportBoot(m, enrolled), 'exporting');
        m = await reverse.recordExportHead(m, headFor(m.generation));
        m = await reverse.recordImportProgress(m, [0, 1, 2]);
        return reverse.advance(await reverse.advance(m, 'checking'), 'flipping');
    }

    it('cross-direction exclusion both ways, including a failed forward move whose AWS provision is not released', async () => {
        const f = await forward.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' });
        await expect(create()).rejects.toEqual(conflict('forward_active'));
        expect(Number((await q(`SELECT count(*) AS n FROM $S.ezil_compute_reverse_moves`))[0]!.n)).toBe(0);
        // Released by the forward machine only once its AWS provision is released.
        await q(`UPDATE $S.ezil_compute_migrations SET state = 'failed_reopened', workspace_head = '{"_awsProvision":{"released":false}}' WHERE id = '${f.id}'`);
        await expect(create()).rejects.toEqual(conflict('forward_active'));
        await q(`UPDATE $S.ezil_compute_migrations SET workspace_head = '{"_awsProvision":{"released":true}}' WHERE id = '${f.id}'`);
        const r = await create();
        expect(r.state).toBe('requested');
        await expect(forward.createOrGetActive({ computerId: C, userId: U, toSize: 'premium' })).rejects.toBeInstanceOf(MigrationConflictError);
        expect(Number((await q(`SELECT count(*) AS n FROM $S.ezil_compute_migrations`))[0]!.n)).toBe(1);
        // Another computer is unaffected in both directions.
        expect((await forward.createOrGetActive({ computerId: C2, userId: U, toSize: 'standard' })).computerId).toBe(C2);
        // An operator-held reverse row still holds the computer against a forward move.
        const stuck = await reverse.fail(r, 'failed_needs_operator', 'export_unknown');
        await expect(forward.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' })).rejects.toBeInstanceOf(MigrationConflictError);
        await reverse.fail(stuck, 'failed_reopened', 'operator_released');
        expect((await forward.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' })).state).toBe('requested');
    });

    it('concurrent forward and reverse creates: exactly one direction wins every round', async () => {
        const winners = { forward: 0, reverse: 0 };
        for (let round = 0; round < 20; round++) {
            await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_reverse_moves, ${schema}.ezil_compute_migrations`);
            const [f, r] = await Promise.allSettled([
                forward.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' }), create()]);
            expect([f.status, r.status].filter(s => s === 'fulfilled')).toHaveLength(1);
            if (f.status === 'rejected') expect(f.reason).toBeInstanceOf(MigrationConflictError);
            if (r.status === 'rejected') expect(r.reason).toEqual(conflict('forward_active'));
            winners[f.status === 'fulfilled' ? 'forward' : 'reverse']++;
            expect(await holding()).toBe(1);
        }
        expect(winners.forward + winners.reverse).toBe(20);
    });

    it('CAS: one concurrent advance wins, a stale copy loses, illegal edges write nothing', async () => {
        const m = await create();
        const booted = await reverse.recordExportBoot(m, enrolled);
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => reverse.advance(booted, 'exporting')));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toEqual(conflict('lost_race'));
        await expect(reverse.advance(booted, 'exporting')).rejects.toEqual(conflict('lost_race'));
        const current = (await reverse.readById(m.id))!;
        expect(current.state).toBe('exporting');
        for (const attempt of [
            () => reverse.advance(current, 'copying'), () => reverse.advance(current, 'checking'),
            () => reverse.finish(current, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null }),
            () => reverse.recordImportProgress(current, [0]), () => reverse.recordExportBoot(current, enrolled),
        ]) await expect(attempt()).rejects.toEqual(conflict('illegal_transition'));
        expect((await reverse.readById(m.id))!.updatedAt).toBe(current.updatedAt);
        const done = await reverse.fail(current, 'failed_reopened', 'export_failed');
        await expect(reverse.fail(done, 'failed_needs_operator', 'x')).rejects.toEqual(conflict('illegal_transition'));
        await expect(reverse.recordRetry(done, 'x')).rejects.toEqual(conflict('illegal_transition'));
    });

    it('export boot: requested→booting records the claim; booting only completes the SAME claim', async () => {
        const m = await create();
        await expect(reverse.recordExportBoot(m, { ...boot, placementGeneration: 0 })).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.recordExportBoot(m, { ...boot, volumeId: 'vol-XYZ' })).rejects.toEqual(conflict('invalid_input'));
        const b1 = await reverse.recordExportBoot(m, boot);
        expect(b1).toMatchObject({ state: 'booting', exportBoot: boot });
        await expect(reverse.advance(b1, 'exporting')).rejects.toEqual(conflict('illegal_transition'));
        const b2 = await reverse.recordExportBoot(b1, enrolled);
        expect(b2.exportBoot).toEqual(enrolled);
        for (const changed of [{ placementGeneration: 5 }, { leaseEpoch: 8 }, { volumeId: 'vol-0123456789abcdef0' },
            { jobId: OTHER }, { instanceId: 'i-0fedcba9876543210' }, { claimedAt: new Date(start.getTime() + 1).toISOString() }]) {
            await expect(reverse.recordExportBoot(b2, { ...enrolled, ...changed })).rejects.toEqual(conflict('illegal_transition'));
        }
        expect((await reverse.advance(b2, 'exporting')).state).toBe('exporting');
    });

    it('export head is validated and bound to the move generation; checking needs every chunk imported', async () => {
        let m = await create();
        m = await reverse.advance(await reverse.recordExportBoot(m, enrolled), 'exporting');
        const head = headFor(m.generation);
        for (const bad of [
            { ...head, generation: OTHER }, headFor(m.generation, [EXPORT_CHUNK_BYTES, 1234, EXPORT_CHUNK_BYTES]),
            { ...head, bytes: head.bytes + 1 }, { ...head, chunks: head.chunks.map(c => ({ ...c, i: c.i + 1 })) },
            { ...head, entries: 100_001 }, { ...head, sha256: 'F'.repeat(64) }, headFor(m.generation, Array(513).fill(EXPORT_CHUNK_BYTES)),
            headFor(m.generation, [EXPORT_CHUNK_BYTES + 1]), { ...head, chunks: [] },
        ]) await expect(reverse.recordExportHead(m, bad as ReverseExportHead)).rejects.toEqual(conflict('invalid_input'));
        const copying = await reverse.recordExportHead(m, head);
        expect(copying).toMatchObject({ state: 'copying', exportHead: head, bytesTotal: 2 * EXPORT_CHUNK_BYTES + 1234, skipped: 2, importProgress: null });
        await expect(reverse.advance(copying, 'checking')).rejects.toEqual(conflict('illegal_transition'));
        const p1 = await reverse.recordImportProgress(copying, [2, 0, 2]);
        expect(p1.importProgress).toEqual({ bitmap: '05'.padEnd(128, '0'), bytes: EXPORT_CHUNK_BYTES + 1234, archiveSha256: head.sha256,
            first: start.toISOString(), last: start.toISOString() });
        expect(await reverse.recordImportProgress(p1, [0])).toBe(p1);
        await expect(reverse.recordImportProgress(p1, [3])).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.recordImportProgress(p1, [])).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.advance(p1, 'checking')).rejects.toEqual(conflict('illegal_transition'));
        clock = new Date(start.getTime() + 5_000);
        const p2 = await reverse.recordImportProgress(p1, [1]);
        expect(p2.importProgress).toMatchObject({ bitmap: '07'.padEnd(128, '0'), bytes: head.bytes, first: start.toISOString(), last: clock.toISOString() });
        await expect(reverse.recordImportProgress(p1, [1])).rejects.toEqual(conflict('lost_race'));
        const flipping = await reverse.advance(await reverse.advance(p2, 'checking'), 'flipping');
        expect(flipping.state).toBe('flipping');
    });

    it('retries are bounded at 5; progress and an advance reset them; the column refuses more', async () => {
        let m = await reverse.recordExportBoot(await create(), enrolled);
        for (let i = 1; i <= 5; i++) {
            const r = await reverse.recordRetry(m, 'enroll_timeout');
            expect(r).toMatchObject({ exhausted: false, move: { attempts: i, lastError: 'enroll_timeout', state: 'booting' } });
            m = r.move;
        }
        const exhausted = await reverse.recordRetry(m, 'enroll_timeout');
        expect(exhausted).toEqual({ move: m, exhausted: true });
        expect((await reverse.readById(m.id))!.updatedAt).toBe(m.updatedAt);
        await expect(reverse.recordRetry(m, 'Not A Code')).rejects.toEqual(conflict('invalid_input'));
        m = await reverse.advance(m, 'exporting');
        expect(m).toMatchObject({ attempts: 0, lastError: null });
        m = (await reverse.recordRetry(m, 'export_poll')).move;
        m = await reverse.recordExportHead(m, headFor(m.generation));
        m = (await reverse.recordRetry(m, 'pull_unavailable')).move;
        expect(m.attempts).toBe(1);
        expect(await reverse.recordImportProgress(m, [1])).toMatchObject({ attempts: 0, lastError: null });
        await expect(q(`UPDATE $S.ezil_compute_reverse_moves SET attempts = 6 WHERE id = '${m.id}'`)).rejects.toThrow(/attempts_check/);
    });

    it('finish retains the AWS volume (and snapshot) for 14 days on committed rows only', async () => {
        const f = await toFlipping();
        await expect(reverse.finish(f, { awsVolumeId: 'volume', awsFsUuid: null, awsSnapshotId: null })).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.finish(f, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: 'snapshot' })).rejects.toEqual(conflict('invalid_input'));
        const done = await reverse.finish(f, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: OTHER, awsSnapshotId: 'snap-02639db95fe545d4f' });
        expect(done).toMatchObject({ state: 'committed', awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: OTHER, awsSnapshotId: 'snap-02639db95fe545d4f' });
        const [span] = await q(`SELECT retain_until - updated_at AS span FROM $S.ezil_compute_reverse_moves WHERE id = '${done.id}'`);
        expect(String(span!.span)).toMatch(/^14 days(?: 00:00:00(?:\.\d+)?)?$|^13 days 23:59:59\.\d+$/);
        expect(done.retainUntil!.getTime() - Date.now()).toBeGreaterThan(13.9 * 86_400_000);
        await expect(reverse.fail(done, 'failed_reopened', 'x')).rejects.toEqual(conflict('illegal_transition'));
        const other = await create(C2);
        await expect(q(`UPDATE $S.ezil_compute_reverse_moves SET retain_until = now() WHERE id = '${other.id}'`)).rejects.toThrow(/retain_until_check/);
        await expect(q(`UPDATE $S.ezil_compute_reverse_moves SET aws_volume_id = 'vol-NOPE' WHERE id = '${other.id}'`)).rejects.toThrow(/aws_volume_id_check/);
        // Committed releases the computer for either direction.
        expect((await forward.createOrGetActive({ computerId: C, userId: U, toSize: 'standard' })).state).toBe('requested');
    });

    it('claimStale takes only in-flight rows idle for 30 s and bumps them', async () => {
        const a = await create();
        const b = await reverse.fail(await create(C2), 'failed_needs_operator', 'stuck');
        const third = '66666666-6666-4666-8666-666666666666';
        const c = await reverse.finish(await toFlippingFrom(await create(third)), { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null });
        expect(await reverse.claimStale(10)).toEqual([]);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET updated_at = updated_at - interval '1 minute'`);
        const claimed = await reverse.claimStale(10);
        expect(claimed.map(m => m.id)).toEqual([a.id]);
        expect(claimed[0]!.updatedAt).not.toBe(a.updatedAt);
        expect(await reverse.claimStale(10)).toEqual([]);
        expect([b.state, c.state]).toEqual(['failed_needs_operator', 'committed']);
        await expect(reverse.advance(a, 'exporting')).rejects.toEqual(conflict('illegal_transition'));
        await expect(reverse.recordExportBoot(a, boot)).rejects.toEqual(conflict('lost_race'));
        expect((await reverse.recordExportBoot(claimed[0]!, boot)).state).toBe('booting');
    });

    it('RLS is enabled with no policy, and no client role keeps any privilege (defaults granted ALL)', async () => {
        await q(`CREATE TABLE $S.grant_probe (id integer)`);
        try {
            expect((await q(`SELECT has_table_privilege('anon', '$S.grant_probe', 'SELECT') AS ok`))[0]!.ok).toBe(true);
        } finally { await q(`DROP TABLE $S.grant_probe`); }
        for (const role of ['anon', 'authenticated']) for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
            expect((await q(`SELECT has_table_privilege('${role}', '$S.ezil_compute_reverse_moves', '${privilege}') AS ok`))[0]!.ok, `${role} ${privilege}`).toBe(false);
        }
        const [rel] = await q(`SELECT c.relrowsecurity AS rls, (SELECT count(*) FROM aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) a
            WHERE a.grantee = 0) AS public_grants, (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
            FROM pg_class c WHERE c.oid = '$S.ezil_compute_reverse_moves'::regclass`);
        expect({ rls: rel!.rls, publicGrants: Number(rel!.public_grants), policies: Number(rel!.policies) }).toEqual({ rls: true, publicGrants: 0, policies: 0 });
    });

    it('the Drizzle model matches the applied table: columns, nullability, types, checks and indexes', async () => {
        const config = getTableConfig(computeReverseMoves);
        const columns = await q(`SELECT column_name, data_type, is_nullable FROM information_schema.columns
            WHERE table_schema = '$S' AND table_name = 'ezil_compute_reverse_moves' ORDER BY ordinal_position`);
        expect(columns.map(c => ({ name: c.column_name, type: c.data_type, notNull: c.is_nullable === 'NO' })))
            .toEqual(config.columns.map(c => ({ name: c.name, type: c.getSQLType(), notNull: c.notNull })));
        const checks = await q(`SELECT conname FROM pg_constraint WHERE conrelid = '$S.ezil_compute_reverse_moves'::regclass AND contype = 'c' ORDER BY conname`);
        expect(checks.map(c => c.conname)).toEqual(config.checks.map(c => c.name).sort());
        const indexes = await q(`SELECT indexname FROM pg_indexes WHERE schemaname = '$S' AND tablename = 'ezil_compute_reverse_moves' ORDER BY indexname`);
        expect(indexes.map(i => i.indexname)).toEqual([...config.indexes.map(i => i.config.name), 'ezil_compute_reverse_moves_pkey'].sort());
    });
});
