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
    createProviderReverseStore, EXPORT_CHUNK_BYTES, REVERSE_RETENTION_LIST_MAX, REVERSE_SNAPSHOT_LIST_MAX, reverseMovesTablePresent,
    type ComputeReverseMove, type ReverseExportBoot, type ReverseExportHead,
} from './provider-reverse-store';

const PG = process.env.BILLING_TEST_DATABASE_URL;
const schema = `reverse_moves_test_${randomUUID().replaceAll('-', '')}`;
const C = '11111111-1111-4111-8111-111111111111', U = '22222222-2222-4222-8222-222222222222';
const C2 = '33333333-3333-4333-8333-333333333333', OTHER = '44444444-4444-4444-8444-444444444444';
const JOB = '55555555-5555-4555-8555-555555555555';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `to_jsonb(timestamptz)`: ISO 8601 with an offset, which Date.parse reads. */
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}:\d{2}|Z)$/;
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
    const reverse = createProviderReverseStore(db);
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
        // first/last are the DB clock (r3, contract §5.4), one statement's time on the first write.
        expect(p1.importProgress).toEqual({ bitmap: '05'.padEnd(128, '0'), bytes: EXPORT_CHUNK_BYTES + 1234, archiveSha256: head.sha256,
            first: expect.stringMatching(ISO), last: p1.importProgress!.first });
        expect(await reverse.recordImportProgress(p1, [0])).toBe(p1);
        await expect(reverse.recordImportProgress(p1, [3])).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.recordImportProgress(p1, [])).rejects.toEqual(conflict('invalid_input'));
        await expect(reverse.advance(p1, 'checking')).rejects.toEqual(conflict('illegal_transition'));
        const p2 = await reverse.recordImportProgress(p1, [1]);
        expect(p2.importProgress).toMatchObject({ bitmap: '07'.padEnd(128, '0'), bytes: head.bytes, first: p1.importProgress!.first });
        const [moved] = await q(`SELECT '${p2.importProgress!.last}'::timestamptz > '${p1.importProgress!.last}'::timestamptz AS ok`);
        expect(moved!.ok).toBe(true);
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

    it('recordSnapshot sets the D21 snapshot once, on committed rows only', async () => {
        const f = await toFlipping();
        await expect(reverse.recordSnapshot(f, 'snap-02639db95fe545d4f')).rejects.toEqual(conflict('illegal_transition'));
        const done = await reverse.finish(f, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null });
        await expect(reverse.recordSnapshot(done, 'vol-0b1ffbc8f8cfa6384')).rejects.toEqual(conflict('invalid_input'));
        const snapped = await reverse.recordSnapshot(done, 'snap-02639db95fe545d4f');
        expect(snapped).toMatchObject({ state: 'committed', awsSnapshotId: 'snap-02639db95fe545d4f', retainUntil: done.retainUntil });
        await expect(reverse.recordSnapshot(snapped, 'snap-053333a158f9cc895')).rejects.toEqual(conflict('illegal_transition'));
        await expect(reverse.recordSnapshot(done, 'snap-053333a158f9cc895')).rejects.toEqual(conflict('lost_race'));
        expect((await reverse.readById(done.id))!.awsSnapshotId).toBe('snap-02639db95fe545d4f');
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

    it('point of no return: checking→flipping stamps commit_sent_at; flipping never reopens; operator release follows the marker', async () => {
        let m = await toCopying();
        m = await reverse.recordImportProgress(m, m.exportHead!.chunks.map(chunk => chunk.i));
        const checking = await reverse.advance(m, 'checking');
        expect(checking.commitSentAt).toBeNull();
        const flipping = await reverse.advance(checking, 'flipping');
        expect(flipping.commitSentAt).not.toBeNull();
        const [stamps] = await q(`SELECT commit_sent_at >= state_entered_at - interval '1 second' AND commit_sent_at <= clock_timestamp() AS ok
            FROM $S.ezil_compute_reverse_moves WHERE id = '${flipping.id}'`);
        expect(stamps!.ok).toBe(true);
        // The commit may have landed: the AWS computer is never reopened, whatever the reason.
        for (const reason of ['entitlement_paid', 'kill_switch', 'flip_retries'])
            await expect(reverse.fail(flipping, 'failed_reopened', reason)).rejects.toEqual(conflict('illegal_transition'));
        // Retries in flipping are bounded by time, not attempts: never exhausted, and they keep both stamps.
        let f = flipping;
        for (let i = 0; i < 7; i++) {
            const r = await reverse.recordRetry(f, 'commit_unavailable');
            expect(r.exhausted).toBe(false);
            f = r.move;
        }
        expect(f).toMatchObject({ state: 'flipping', attempts: 5, commitSentAt: flipping.commitSentAt, stateEnteredAt: flipping.stateEnteredAt });
        const stuck = await reverse.fail(f, 'failed_needs_operator', 'flip_stuck');
        expect(stuck.commitSentAt).toBe(flipping.commitSentAt);
        await expect(reverse.fail(stuck, 'failed_reopened', 'operator_released')).rejects.toEqual(conflict('illegal_transition'));
        await expect(q(`UPDATE $S.ezil_compute_reverse_moves SET state = 'failed_reopened' WHERE id = '${stuck.id}'`))
            .rejects.toThrow(/ezil_compute_reverse_moves_commit_sent_at_check/);
        // An operator finishes the stuck flip instead (the same flip transaction, contract §5.6).
        const done = await reverse.finish(stuck, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null });
        expect(done).toMatchObject({ state: 'committed', commitSentAt: flipping.commitSentAt });
        // A row that never sent its commit cannot be finished; an operator may reopen it.
        const other = await reverse.fail(await create(C2), 'failed_needs_operator', 'abort_unconfirmed');
        expect(other.commitSentAt).toBeNull();
        await expect(reverse.finish(other, { awsVolumeId: 'vol-0b1ffbc8f8cfa6384', awsFsUuid: null, awsSnapshotId: null }))
            .rejects.toEqual(conflict('illegal_transition'));
        expect((await reverse.fail(other, 'failed_reopened', 'operator_released')).state).toBe('failed_reopened');
        // No other state may carry the marker.
        const fresh = await create(C2);
        await expect(q(`UPDATE $S.ezil_compute_reverse_moves SET commit_sent_at = now() WHERE id = '${fresh.id}'`))
            .rejects.toThrow(/ezil_compute_reverse_moves_commit_sent_at_check/);
    });

    it('state_entered_at moves on a state change only, never on claimStale, a retry, progress or a claim completion', async () => {
        const m = await create();
        expect(m.stateEnteredAt).toBe(m.createdAt);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET updated_at = updated_at - interval '1 minute',
            state_entered_at = state_entered_at - interval '1 minute' WHERE id = '${m.id}'`);
        const backdated = (await reverse.readById(m.id))!.stateEnteredAt;
        const [claimed] = await reverse.claimStale(10);
        expect(claimed).toMatchObject({ id: m.id, stateEnteredAt: backdated });
        const b1 = await reverse.recordExportBoot(claimed!, boot);
        expect(b1.stateEnteredAt).not.toBe(backdated);
        const entered = async (id: string) => (await q(`SELECT state_entered_at::text AS t FROM $S.ezil_compute_reverse_moves WHERE id = '${id}'`))[0]!.t;
        const sameState = [
            (x: ComputeReverseMove) => reverse.recordRetry(x, 'enroll_wait').then(r => r.move),
            (x: ComputeReverseMove) => reverse.recordExportBoot(x, enrolled),
        ];
        let x = b1;
        for (const write of sameState) {
            x = await write(x);
            expect(x.stateEnteredAt).toBe(b1.stateEnteredAt);
            expect(await entered(x.id)).toBe(b1.stateEnteredAt);
        }
        x = await reverse.recordExportHead(await reverse.advance(x, 'exporting'), headFor(x.generation));
        const copyingEntered = x.stateEnteredAt;
        x = await reverse.recordImportProgress(x, [0]);
        expect(x.stateEnteredAt).toBe(copyingEntered);
        const [later] = await q(`SELECT '${copyingEntered}'::timestamptz > '${b1.stateEnteredAt}'::timestamptz AS ok`);
        expect(later!.ok).toBe(true);
    });

    it('readByExportBoot: the non-committed row that claimed this placement generation, lease epoch and volume', async () => {
        const g = boot.placementGeneration, e = boot.leaseEpoch, v = boot.volumeId;
        const m = await reverse.recordExportBoot(await create(), boot);
        expect((await reverse.readByExportBoot(C, g, e, v))!.id).toBe(m.id);
        expect(await reverse.readByExportBoot(C, g + 1, e, v)).toBeNull();
        expect(await reverse.readByExportBoot(C, g, e + 1, v)).toBeNull();
        expect(await reverse.readByExportBoot(C, g, e, 'vol-0123456789abcdef0')).toBeNull();
        expect(await reverse.readByExportBoot(C2, g, e, v)).toBeNull();
        // A released row still owns its boot, so the receipts path keeps that boot out of RUNNING.
        await reverse.fail(m, 'failed_reopened', 'boot_timeout');
        expect(await reverse.readByExportBoot(C, g, e, v)).toMatchObject({ id: m.id, state: 'failed_reopened' });
        // The same row's next move claims N+2/E+2; each boot maps to its own row.
        const next = await reverse.recordExportBoot(await create(), { ...boot, placementGeneration: g + 2, leaseEpoch: e + 2 });
        expect((await reverse.readByExportBoot(C, g + 2, e + 2, v))!.id).toBe(next.id);
        expect((await reverse.readByExportBoot(C, g, e, v))!.id).toBe(m.id);
        // A committed move never matches: a later aws-ec2 row (forward onto a fresh volume) may reach the same counters.
        let f = await reverse.advance(await reverse.recordExportBoot(next, { ...next.exportBoot!, jobId: JOB, instanceId: 'i-0123456789abcdef0' }), 'exporting');
        f = await reverse.recordExportHead(f, headFor(f.generation));
        f = await reverse.recordImportProgress(f, [0, 1, 2]);
        const done = await reverse.finish(await reverse.advance(await reverse.advance(f, 'checking'), 'flipping'),
            { awsVolumeId: v, awsFsUuid: null, awsSnapshotId: null });
        expect(done.state).toBe('committed');
        expect(await reverse.readByExportBoot(C, g + 2, e + 2, v)).toBeNull();
        for (const bad of [[1.5, e, v], [g, Number.NaN, v], [g, e, 'vol-NOPE']] as const)
            await expect(reverse.readByExportBoot(C, bad[0], bad[1], bad[2])).rejects.toEqual(conflict('invalid_input'));
    });

    // ── r3 (G4, clocks, operator runbook) ─────────────────────────────────────
    const C3 = '66666666-6666-4666-8666-666666666666', C4 = '77777777-7777-4777-8777-777777777777';
    const C5 = '88888888-8888-4888-8888-888888888888';
    const VOL = 'vol-0b1ffbc8f8cfa6384';
    const commit = async (computerId: string) => reverse.finish(await toFlippingFrom(await create(computerId)),
        { awsVolumeId: VOL, awsFsUuid: null, awsSnapshotId: null });
    /** Committed rows straight into the table (bounds tests): retain_until is `retain` from now. */
    const insertCommitted = (n: number, retain: string) => q(`INSERT INTO $S.ezil_compute_reverse_moves
        (computer_id, user_id, started_by, state, commit_sent_at, aws_volume_id, retain_until)
        SELECT gen_random_uuid(), '${U}', 'user', 'committed', now(), '${VOL}', clock_timestamp() + interval '${retain}' FROM generate_series(1, ${n})`);

    it('ages are computed by PostgreSQL from DB-written anchors only; import_progress first/last are the DB clock and last never moves back', async () => {
        const m = await create();
        expect(m.ages).toMatchObject({ commitSent: null, lastChunk: null });
        expect(m.ages.created).toBeGreaterThanOrEqual(0);
        expect(m.ages.created).toBeLessThan(60);
        // Backdating the DB anchors moves the ages: nothing on the app side does.
        await q(`UPDATE $S.ezil_compute_reverse_moves SET created_at = created_at - interval '11 minutes',
            state_entered_at = state_entered_at - interval '10 minutes' WHERE id = '${m.id}'`);
        const aged = (await reverse.readById(m.id))!;
        expect(aged.ages.created).toBeGreaterThanOrEqual(660);
        expect(aged.ages.stateEntered).toBeGreaterThanOrEqual(600);
        expect(aged.ages.stateEntered).toBeLessThan(660);
        // booting's deadline anchor is the claim's own state change; completing the claim never moves it.
        const b1 = await reverse.recordExportBoot(aged, boot);
        expect(b1.ages.stateEntered).toBeLessThan(60);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET state_entered_at = state_entered_at - interval '16 minutes' WHERE id = '${m.id}'`);
        const b2 = await reverse.recordExportBoot((await reverse.readById(m.id))!, enrolled);
        expect(b2.ages.stateEntered).toBeGreaterThanOrEqual(960);
        // copying: the stall clock is import_progress.last, written by PostgreSQL.
        let x = await reverse.recordExportHead(await reverse.advance(b2, 'exporting'), headFor(b2.generation));
        expect(x.ages.lastChunk).toBeNull();
        x = await reverse.recordImportProgress(x, [0]);
        expect(x.importProgress).toMatchObject({ first: expect.stringMatching(ISO), last: expect.stringMatching(ISO) });
        const [db1] = await q(`SELECT '${x.importProgress!.last}'::timestamptz BETWEEN clock_timestamp() - interval '1 minute' AND clock_timestamp() AS ok`);
        expect(db1!.ok).toBe(true);
        expect(x.ages.lastChunk).toBeGreaterThanOrEqual(0);
        expect(x.ages.lastChunk).toBeLessThan(60);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET import_progress = jsonb_set(import_progress, '{last}',
            to_jsonb(clock_timestamp() - interval '10 minutes')) WHERE id = '${m.id}'`);
        expect((await reverse.readById(m.id))!.ages.lastChunk).toBeGreaterThanOrEqual(600);
        // A later DB-written `last` is kept over this statement's time; `first` stays the archive's first chunk.
        await q(`UPDATE $S.ezil_compute_reverse_moves SET import_progress = jsonb_set(import_progress, '{last}',
            to_jsonb(clock_timestamp() + interval '1 hour')) WHERE id = '${m.id}'`);
        const ahead = (await reverse.readById(m.id))!;
        const kept = await reverse.recordImportProgress(ahead, [1]);
        expect(kept.importProgress).toMatchObject({ first: x.importProgress!.first, last: ahead.importProgress!.last });
        expect(kept.ages.lastChunk).toBeLessThan(0);
        // A hand-edited, non-ISO `last` never breaks a read; it only has no age, and the next chunk rewrites it.
        await q(`UPDATE $S.ezil_compute_reverse_moves SET import_progress = jsonb_set(import_progress, '{last}', '"yesterday"') WHERE id = '${m.id}'`);
        const odd = (await reverse.readById(m.id))!;
        expect(odd.ages.lastChunk).toBeNull();
        expect((await reverse.recordImportProgress(odd, [2])).importProgress!.last).toMatch(ISO);
        // flipping: commit_sent_at is the flip_stuck anchor.
        const f = await toFlippingFrom(await create(C2));
        expect(f.ages.commitSent).toBeGreaterThanOrEqual(0);
        // claimStale's RETURNING carries the same ages.
        await q(`UPDATE $S.ezil_compute_reverse_moves SET commit_sent_at = commit_sent_at - interval '31 minutes',
            updated_at = updated_at - interval '1 minute' WHERE id = '${f.id}'`);
        const [claimed] = await reverse.claimStale(10);
        expect(claimed).toMatchObject({ id: f.id, state: 'flipping' });
        expect(claimed!.ages.commitSent).toBeGreaterThanOrEqual(1860);
    });

    it('recordSnapshot is a CAS on aws_snapshot_id IS NULL: one of two ids wins, a replayed id returns the row, the commit time stays', async () => {
        const done = await commit(C);
        const results = await Promise.allSettled([reverse.recordSnapshot(done, 'snap-02639db95fe545d4f'), reverse.recordSnapshot(done, 'snap-053333a158f9cc895')]);
        const won = results.filter((r): r is PromiseFulfilledResult<ComputeReverseMove> => r.status === 'fulfilled');
        expect(won).toHaveLength(1);
        for (const r of results) if (r.status === 'rejected') expect(r.reason).toEqual(conflict('lost_race'));
        const snapped = won[0]!.value;
        expect(snapped).toMatchObject({ state: 'committed', stateEnteredAt: done.stateEnteredAt, retainUntil: done.retainUntil });
        // A lost response: the executor replays its own id with its stale copy and gets the recorded row back, unchanged.
        const replay = await reverse.recordSnapshot(done, snapped.awsSnapshotId!);
        expect(replay).toMatchObject({ id: done.id, awsSnapshotId: snapped.awsSnapshotId, updatedAt: snapped.updatedAt });
        expect(await reverse.recordSnapshot(snapped, snapped.awsSnapshotId!)).toBe(snapped);
        expect((await reverse.readById(done.id))!.updatedAt).toBe(snapped.updatedAt);
        // Only committed rows; the in-flight and failed rows of another computer are refused before any write.
        const failed = await reverse.fail(await create(C2), 'failed_reopened', 'boot_timeout');
        await expect(reverse.recordSnapshot(failed, 'snap-02639db95fe545d4f')).rejects.toEqual(conflict('illegal_transition'));
    });

    it('listUnsnapshotted: committed rows with no snapshot, oldest commit first, bounded; the age filter is the DB clock', async () => {
        const [a, b, c] = [await commit(C), await commit(C2), await commit(C3)];
        await reverse.recordSnapshot(await commit(C4), 'snap-02639db95fe545d4f');
        await reverse.fail(await create(C5), 'failed_needs_operator', 'boot_unsettled');
        await create(C);
        // Commit times: a 2 h ago, b 30 min ago, c now (state_entered_at of a committed row is its commit).
        await q(`UPDATE $S.ezil_compute_reverse_moves SET state_entered_at = state_entered_at - interval '2 hours' WHERE id = '${a.id}'`);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET state_entered_at = state_entered_at - interval '30 minutes' WHERE id = '${b.id}'`);
        expect((await reverse.listUnsnapshotted(10)).map(m => m.id)).toEqual([a.id, b.id, c.id]);
        expect((await reverse.listUnsnapshotted(10, 3600)).map(m => m.id)).toEqual([a.id]);
        expect((await reverse.listUnsnapshotted(10, 1200)).map(m => m.id)).toEqual([a.id, b.id]);
        expect((await reverse.listUnsnapshotted(2)).map(m => m.id)).toEqual([a.id, b.id]);
        for (const limit of [0, -5, Number.NaN]) expect(await reverse.listUnsnapshotted(limit)).toEqual([]);
        await insertCommitted(12, '14 days');
        expect(await reverse.listUnsnapshotted(1000)).toHaveLength(REVERSE_SNAPSHOT_LIST_MAX);
        expect(REVERSE_SNAPSHOT_LIST_MAX).toBe(10);
    });

    it('listRetentionExpired: committed rows whose retain_until passed on the DB clock, oldest first, bounded at 100', async () => {
        const live = await commit(C);
        const [old, older] = [await commit(C2), await commit(C3)];
        await q(`UPDATE $S.ezil_compute_reverse_moves SET retain_until = clock_timestamp() - interval '1 day' WHERE id = '${old.id}'`);
        await q(`UPDATE $S.ezil_compute_reverse_moves SET retain_until = clock_timestamp() - interval '3 days' WHERE id = '${older.id}'`);
        await create(C4);
        const expired = await reverse.listRetentionExpired(10);
        expect(expired.map(m => m.id)).toEqual([older.id, old.id]);
        expect(expired.map(m => m.id)).not.toContain(live.id);
        expect(await reverse.listRetentionExpired(1)).toHaveLength(1);
        for (const limit of [0, Number.NaN]) expect(await reverse.listRetentionExpired(limit)).toEqual([]);
        await insertCommitted(105, '-1 hour');
        expect(await reverse.listRetentionExpired(1000)).toHaveLength(REVERSE_RETENTION_LIST_MAX);
        expect(REVERSE_RETENTION_LIST_MAX).toBe(100);
    });

    it('reverseMovesTablePresent: true with 0012, false on a schema without it (production), and the probe itself never fails', async () => {
        expect(await reverseMovesTablePresent(db)).toBe(true);
        const bareSchema = `${schema}_bare`;
        await client!.unsafe(`CREATE SCHEMA ${bareSchema}`);
        try {
            const bare: PlacementExecutor = { execute: async query => {
                const rendered = dialect.sqlToQuery(query); return client!.unsafe(rendered.sql.replaceAll('public.', `${bareSchema}.`), rendered.params as never[]);
            } };
            expect(await reverseMovesTablePresent(bare)).toBe(false);
            await expect(createProviderReverseStore(bare).readByComputer(C)).rejects.toThrow(/does not exist/);
        } finally { await client!.unsafe(`DROP SCHEMA ${bareSchema} CASCADE`); }
    });

    it('CAS checks the state too: a hand-written state change that keeps updated_at still refuses a stale writer', async () => {
        const stuck = await reverse.fail(await create(), 'failed_needs_operator', 'abort_unconfirmed');
        // A careless operator statement (not the runbook's, which bumps updated_at) changes only the state.
        await q(`UPDATE $S.ezil_compute_reverse_moves SET state = 'failed_reopened', last_error = 'operator_released' WHERE id = '${stuck.id}'`);
        expect((await reverse.readById(stuck.id))!.updatedAt).toBe(stuck.updatedAt);
        await expect(reverse.fail(stuck, 'failed_reopened', 'operator_released')).rejects.toEqual(conflict('lost_race'));
        await expect(reverse.fail(stuck, 'failed_reopened', 'abort_unconfirmed')).rejects.toEqual(conflict('lost_race'));
        expect((await reverse.readById(stuck.id))!).toMatchObject({ state: 'failed_reopened', lastError: 'operator_released', updatedAt: stuck.updatedAt });
    });

    const runbook: Record<string, string> = Object.fromEntries([...readFileSync(path.resolve(__dirname, '../../../../../docs/compute/REVERSE-MOVE-CONTRACT.md'), 'utf8')
        .matchAll(/```sql\n-- runbook: ([a-z_]+)\n([\s\S]*?)```/g)].map(m => [m[1]!, m[2]!]));
    const runbookSql = (name: string, id: string, snapshotId = 'snap-0a1b2c3d4e5f60718') => q(runbook[name]!.replaceAll('public.', '$S.')
        .replaceAll('<move-id>', id).replaceAll('<snapshot-id>', snapshotId));

    it('the contract\'s operator runbook SQL (§5.5.1, §7.1) runs on 0012: each statement is guarded and bumps updated_at', async () => {
        expect(Object.keys(runbook).sort()).toEqual(['clear_commit_sent', 'operator_cleared', 'operator_released', 'operator_snapshot']);
        // operator_released: failed_needs_operator with no commit_sent_at → failed_reopened; a stale writer then loses.
        const a = await reverse.fail(await create(), 'failed_needs_operator', 'abort_unconfirmed');
        expect(await runbookSql('operator_released', a.id)).toEqual([expect.objectContaining({ state: 'failed_reopened', last_error: 'operator_released' })]);
        const released = (await reverse.readById(a.id))!;
        expect(released.updatedAt).not.toBe(a.updatedAt);
        expect(released.stateEnteredAt).not.toBe(a.stateEnteredAt);
        await expect(reverse.fail(a, 'failed_reopened', 'abort_unconfirmed')).rejects.toEqual(conflict('lost_race'));
        // Never with commit_sent_at: the flip may have landed. Clearing it is its own guarded statement.
        const f = await reverse.fail(await toFlippingFrom(await create(C2)), 'failed_needs_operator', 'flip_stuck');
        expect(await runbookSql('operator_released', f.id)).toHaveLength(0);
        expect(await runbookSql('clear_commit_sent', f.id)).toEqual([expect.objectContaining({ state: 'failed_needs_operator', commit_sent_at: null })]);
        expect(await runbookSql('clear_commit_sent', f.id)).toHaveLength(0);
        expect(await runbookSql('operator_released', f.id)).toEqual([expect.objectContaining({ state: 'failed_reopened' })]);
        expect(await runbookSql('clear_commit_sent', (await create(C3)).id)).toHaveLength(0);
        // operator_cleared: only the computer's newest row, only failed_reopened with a reopen_final code.
        const final = await reverse.fail(await create(C4), 'failed_reopened', 'head_moved');
        expect(await runbookSql('operator_cleared', final.id)).toEqual([expect.objectContaining({ state: 'failed_reopened', last_error: 'operator_cleared' })]);
        expect(await runbookSql('operator_cleared', final.id)).toHaveLength(0);
        const ordinary = await reverse.fail(await create(C4), 'failed_reopened', 'boot_timeout');
        expect(await runbookSql('operator_cleared', ordinary.id)).toHaveLength(0);
        const older = await reverse.fail(await create(C5), 'failed_reopened', 'boot_refused');
        await reverse.fail(await create(C5), 'failed_reopened', 'export_failed');
        expect(await runbookSql('operator_cleared', older.id)).toHaveLength(0);
        expect((await reverse.readById(older.id))!.lastError).toBe('boot_refused');
        // operator_snapshot (§7.1): committed rows with no snapshot only; an executor holding the old copy then replays as a no-op.
        const done = await commit(C);
        expect(await runbookSql('operator_snapshot', done.id)).toEqual([expect.objectContaining({ state: 'committed', aws_snapshot_id: 'snap-0a1b2c3d4e5f60718' })]);
        expect(await runbookSql('operator_snapshot', done.id, 'snap-053333a158f9cc895')).toHaveLength(0);
        expect(await runbookSql('operator_snapshot', (await create(C3)).id)).toHaveLength(0);
        await expect(reverse.recordSnapshot(done, 'snap-02639db95fe545d4f')).rejects.toEqual(conflict('lost_race'));
        expect((await reverse.recordSnapshot(done, 'snap-0a1b2c3d4e5f60718')).awsSnapshotId).toBe('snap-0a1b2c3d4e5f60718');
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
