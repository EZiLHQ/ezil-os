/** Disposable PostgreSQL only (EZIL_PG_TEST_URL, one throwaway schema per run); never resolves the app connection or credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { newReservedImageJob } from './aws-rebase-store';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { readPlacement, writeParkedStopReservation, type Placement, type PlacementDb, type PlacementExecutor } from './placement';
import { ImageJobConflictError } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `park_test_${randomUUID().replaceAll('-', '')}`;
const prep = fixtureRebasePreparation();
const job = () => newReservedImageJob({ preparation: prep, ownerUserId: '33333333-3333-4333-8333-333333333333',
    sourceRelease: fixtureRebaseRelease(prep.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(prep.intent.deployment) });
const FAILED_ERROR = 'failed:LifecycleUnconfirmed';

describe.skipIf(!PG)('park reservation on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    // Rewrite SQL identifiers only; bound values and the real Drizzle executor/transaction are untouched.
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn => production!.transaction(tx => fn(executor(tx))) };
    let created = false;
    const j = job();
    const jobIds = Array.from({ length: 8 }, () => randomUUID());
    const fields = (jobId = jobIds[0]!) => ({ lifecycleJobId: jobId, lifecycleDigest: 'd'.repeat(64), lastError: 'pool_park_recovery:{"v":1}',
        enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });

    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // The registered placement SQL plus the ready-pool SQL: it carries the writer-lease and pool-host tables, as where 0002 is registered.
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0008_pool_dispatch.sql'), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0009_capacity_demands.sql'), 'utf8')));
        // The computer double carries created_at because `readCanaryComputer` (the reservation's owner check) selects it.
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid, user_id uuid, deleted_at timestamptz, created_at timestamptz DEFAULT now())`);
        // Local migration double used only for the active-migration exclusion query.
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_compute_migrations (id uuid, computer_id uuid, state text, user_id uuid, workspace_head jsonb)`);
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0010_migration_restore_progress.sql'), 'utf8')));
    });
    /** The failed release's row: UNCONFIRMED, its job and digest kept, NO placement lease (lease_until NULL). */
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_usage, ${schema}.ezil_computer_image_jobs, ${schema}.ezil_computer_placements,
            ${schema}.ezil_compute_migrations, ${schema}.ezil_compute_writer_leases, ${schema}.ezil_computers`);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computers (id, user_id, deleted_at) VALUES ($1,$2,NULL)`, [j.computerId, j.ownerUserId]);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id, instance_id, instance_type,
             volume_id, fs_uuid, fence_token, lifecycle_job_id, lifecycle_digest, last_error, lease_until, updated_at)
            VALUES ($1,$2,'aws-ec2','ebs',$3,$4,'UNCONFIRMED',$5,$6,$7,'m6i.large',$8,$9,$10,$11,$12,$13,NULL,$14)`,
        [j.computerId, j.ownerUserId, j.sourceGeneration, j.sourceLeaseEpoch, j.region, j.zoneId, j.sourceInstanceId, j.sourceVolumeId, j.fsUuid,
            j.sourceFenceToken, randomUUID(), 'a'.repeat(64), FAILED_ERROR, j.createdAt]);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    const placement = async (): Promise<Placement> => (await readPlacement(db, j.computerId)).record!;
    const row = async () => (await client!.unsafe(`SELECT state, lifecycle_job_id::text AS job, last_error FROM ${schema}.ezil_computer_placements WHERE computer_id = $1`, [j.computerId]))[0]!;
    const untouched = async (before: Placement) => expect(await row()).toMatchObject({ state: 'UNCONFIRMED', job: before.lifecycleJobId, last_error: FAILED_ERROR });

    it('reserves UNCONFIRMED -> RECOVERING with the saved document in one transaction (generation, lease epoch and fence preserved)', async () => {
        const before = await placement();
        const result = await writeParkedStopReservation(db, before, fields());
        expect(result.ok).toBe(true);
        expect(await row()).toMatchObject({ state: 'RECOVERING', job: jobIds[0], last_error: 'pool_park_recovery:{"v":1}' });
        expect(await placement()).toMatchObject({ generation: before.generation, leaseEpoch: before.leaseEpoch, fenceToken: before.fenceToken,
            instanceId: before.instanceId, volumeId: before.volumeId, lifecycleDigest: 'd'.repeat(64) });
    });

    it('refuses on a writer-lease ROW even though the placement lease_until is NULL, and writes nothing', async () => {
        const before = await placement();
        expect(before.leaseUntil).toBeNull();
        await client!.unsafe(`INSERT INTO ${schema}.ezil_compute_writer_leases (computer_id, region, generation, holder, expires_at)
            VALUES ($1,$2,$3,'h', now() + interval '1 hour')`, [j.computerId, j.region, before.generation]);
        expect(await writeParkedStopReservation(db, before, fields())).toEqual({ ok: false, reason: 'blocked', blocker: 'writer_lease' });
        await untouched(before);
        // ANY row blocks, even an expired or fenced one.
        await client!.unsafe(`UPDATE ${schema}.ezil_compute_writer_leases SET expires_at = now() - interval '1 day', fenced_at = now()`);
        expect(await writeParkedStopReservation(db, before, fields())).toMatchObject({ ok: false, blocker: 'writer_lease' });
        await untouched(before);
        // With the row gone the same proof reserves.
        await client!.unsafe(`DELETE FROM ${schema}.ezil_compute_writer_leases`);
        expect((await writeParkedStopReservation(db, before, fields())).ok).toBe(true);
    });

    // The canonical forward-machine semantics (`forwardMoveBusy`): active rows hold; committed and failed history does not; a failed row
    // still holds only while its AWS provision is recorded and not released; an unknown state fails closed.
    const migration = async (state: string, head: object, computer = j.computerId) => client!.unsafe(
        `INSERT INTO ${schema}.ezil_compute_migrations (id, computer_id, state, user_id, workspace_head) VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [randomUUID(), computer, state, j.ownerUserId, JSON.stringify(head)]);
    const provision = (released?: boolean) => ({ _awsProvision: released === undefined ? {} : { released } });
    it.each<[string, string, object]>([
        ['an active requested row', 'requested', {}], ['an active exported row', 'exported', {}], ['an active provisioning row', 'provisioning', {}],
        ['an unknown future state (fails closed)', 'brand_new_state', {}],
        ['failed_reopened with an unreleased AWS provision', 'failed_reopened', provision(false)],
        ['failed_needs_operator with an AWS provision whose release is not recorded', 'failed_needs_operator', provision()],
    ])('refuses while a migration holds the computer: %s', async (_name, state, head) => {
        const before = await placement();
        await migration(state, head);
        expect(await writeParkedStopReservation(db, before, fields())).toEqual({ ok: false, reason: 'blocked', blocker: 'migration' });
        await untouched(before);
    });
    it.each<[string, string, object]>([
        ['a committed row', 'committed', {}], ['a committed row with a provision record', 'committed', provision(false)],
        ['failed_reopened history', 'failed_reopened', {}], ['failed_needs_operator history', 'failed_needs_operator', {}],
        ['failed_reopened with its AWS provision released', 'failed_reopened', provision(true)],
        ['failed_needs_operator with its AWS provision released', 'failed_needs_operator', provision(true)],
    ])('reserves despite terminal migration history: %s', async (_name, state, head) => {
        const before = await placement();
        await migration(state, head);
        expect((await writeParkedStopReservation(db, before, fields())).ok).toBe(true);
        expect(await row()).toMatchObject({ state: 'RECOVERING', job: jobIds[0] });
    });
    it('only the computer\'s own migrations count, and one active row among terminal history still holds', async () => {
        const before = await placement();
        await migration('requested', {}, randomUUID()); // another computer's active move
        await migration('failed_reopened', {}); await migration('committed', {});
        expect((await writeParkedStopReservation(db, before, fields())).ok).toBe(true);
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET state = 'UNCONFIRMED', last_error = $2, lifecycle_job_id = $3 WHERE computer_id = $1`,
            [j.computerId, FAILED_ERROR, before.lifecycleJobId]);
        await migration('provisioning', {});
        expect(await writeParkedStopReservation(db, await placement(), fields(jobIds[1]))).toEqual({ ok: false, reason: 'blocked', blocker: 'migration' });
    });

    it('rejects an orphaned image reservation marker (ImageJobConflictError) and writes nothing', async () => {
        const before = await placement();
        // A placement carrying an image-upgrade job marker with no job row at all: the whole request fails closed.
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET image_upgrade_job_id = $1 WHERE computer_id = $2`, [randomUUID(), j.computerId]);
        await expect(writeParkedStopReservation(db, before, fields())).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(await row()).toMatchObject({ state: 'UNCONFIRMED', last_error: FAILED_ERROR });
        // Cleared, the same proof reserves.
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET image_upgrade_job_id = NULL WHERE computer_id = $1`, [j.computerId]);
        expect((await writeParkedStopReservation(db, before, fields())).ok).toBe(true);
    });

    it('a stale expectation (the placement changed since the proof) loses the CAS: refused, nothing written', async () => {
        const stale = await placement();
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET last_error = 'failed:Other', updated_at = now() WHERE computer_id = $1`, [j.computerId]);
        expect(await writeParkedStopReservation(db, stale, fields())).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(await row()).toMatchObject({ state: 'UNCONFIRMED', last_error: 'failed:Other' });
    });

    it('is exclusive under concurrency: eight simultaneous reservations yield exactly one winner and one durable job', async () => {
        const before = await placement();
        const results = await Promise.all(jobIds.map(id => writeParkedStopReservation(db, before, fields(id))));
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.filter(r => !r.ok).every(r => !r.ok && r.reason === 'cas_conflict')).toBe(true);
        const winner = await row();
        expect(winner.state).toBe('RECOVERING');
        expect(jobIds).toContain(winner.job);
        // A replay of the same expectation after the win is refused: nothing starts a second job.
        expect(await writeParkedStopReservation(db, before, fields(jobIds[3]))).toEqual({ ok: false, reason: 'cas_conflict' });
        expect((await row()).job).toBe(winner.job);
    });

    it('refuses a deleted computer and a foreign owner before writing', async () => {
        const before = await placement();
        await client!.unsafe(`UPDATE ${schema}.ezil_computers SET deleted_at = now()`);
        expect(await writeParkedStopReservation(db, before, fields())).toEqual({ ok: false, reason: 'cas_conflict' });
        await client!.unsafe(`UPDATE ${schema}.ezil_computers SET deleted_at = NULL, user_id = $1`, [randomUUID()]);
        expect(await writeParkedStopReservation(db, before, fields())).toEqual({ ok: false, reason: 'cas_conflict' });
        await untouched(before);
    });
});
