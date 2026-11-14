/** NULL-lower attestation on disposable PostgreSQL: the real 0004 DDL, the real store, the ordinary image reservation it fences. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createImageJobStore, newReservedImageJob } from './aws-rebase-store';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { rebaseEnv } from './aws-rebase.test-support';
import { assertNoImageReservation, type PlacementDb, type PlacementExecutor } from './placement';
import { buildAttestCommand, createLowerAttestationStore, LOWER_ATTESTATION_FAILURE_CODES, LOWER_ATTESTATION_TTL_MS, LowerAttestationRefusal,
    verifyLowerAttestation, type InstanceProvenance, type LowerAttestationRecord } from './aws-lower-attestation';
import { CERT, COMMAND_ID, commandInput, CREATED, DEPLOYMENT, MARKER, MEASURED, NOW, observations, OWNER, PINS, receipt, registryEntry, RESERVE,
    SOURCE_RELEASE } from './aws-lower-attestation.test-support';
import type { ImagePlacement } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `attest_test_${randomUUID().replaceAll('-', '')}`;
const repository = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop';
const prep = fixtureRebasePreparation();
const rebaseJob = () => newReservedImageJob({ preparation: prep, ownerUserId: OWNER,
    sourceRelease: fixtureRebaseRelease(prep.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(prep.intent.deployment) });
const LEGACY_MARKER = Object.fromEntries(Object.entries(MARKER).filter(([k]) => k !== 'instanceId'));

/** The verifier on observations built for this row's own challenge: the real proof, not a stub. */
const realProof = (marker: Record<string, unknown> = MARKER) => (a: LowerAttestationRecord, p: ImagePlacement, provenance: InstanceProvenance) =>
    verifyLowerAttestation(a, p, COMMAND_ID, observations({ command: { ...observations().command!, commands: buildAttestCommand(commandInput({ challenge: a.challenge })) } },
        receipt({ challenge: a.challenge }, marker) + '\n'), registryEntry(), CERT, PINS, NOW, provenance);

describe.skipIf(!PG)('NULL-lower attestation on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn => production!.transaction(tx => fn(executor(tx))) };
    const store = createLowerAttestationStore(db);
    const images = createImageJobStore(db, rebaseEnv);
    const q = (text: string, params: unknown[] = []) => client!.unsafe(local(text), params as never[]);
    const placementRow = async () => (await q(`SELECT * FROM public.ezil_computer_placements WHERE computer_id = $1`, [RESERVE.computerId]))[0]!;
    const without = (row: Record<string, unknown>, ...keys: string[]) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
    const reserve = (over: Partial<typeof RESERVE> = {}) => store.reserve({ ...RESERVE, ...over }, new Date(CREATED));
    let created = false;

    beforeAll(async () => {
        await client!.unsafe(['anon', 'authenticated', 'service_role'].map(r =>
            `DO $$ BEGIN CREATE ROLE ${r}; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`).join('\n'));
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt', '0002_image_rebase.sql.txt', '0004_lower_attestations.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        for (const file of ['0008_pool_dispatch.sql', '0009_capacity_demands.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid, user_id uuid, deleted_at timestamptz)`);
        // The real migration DDL (the committed-migration binding reads from_provider/to_provider/workspace_head under its CHECKs).
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0006_compute_migrations.sql'), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0010_migration_restore_progress.sql'), 'utf8')));
    });
    beforeEach(async () => {
        // The audit table refuses TRUNCATE and DELETE by design; only this disposable fixture's owner lifts that, between cases.
        await client!.unsafe(`ALTER TABLE ${schema}.ezil_computer_lower_attestations DISABLE TRIGGER USER;
            TRUNCATE ${schema}.ezil_computer_lower_attestations; ALTER TABLE ${schema}.ezil_computer_lower_attestations ENABLE TRIGGER USER;`);
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_usage, ${schema}.ezil_computer_image_jobs, ${schema}.ezil_computer_placements, ${schema}.ezil_compute_migrations,
            ${schema}.ezil_computers, ${schema}.ezil_compute_capacity_demands, ${schema}.ezil_compute_pool_hosts`);
        await q(`INSERT INTO public.ezil_computers VALUES ($1,$2,NULL)`, [RESERVE.computerId, OWNER]);
        await q(`INSERT INTO public.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id,
            instance_id, instance_type, volume_id, fs_uuid, fence_token, lower_image_digest, lower_digest_observed_at, updated_at)
            VALUES ($1,$2,'aws-ec2','ebs',$3,$4,'STOPPED',$5,$6,$7,'m6i.large',$8,$9,$10,NULL,NULL,$11)`,
        [RESERVE.computerId, OWNER, RESERVE.sourceGeneration, RESERVE.sourceLeaseEpoch, RESERVE.region, RESERVE.zoneId, RESERVE.sourceInstanceId,
            RESERVE.sourceVolumeId, RESERVE.fsUuid, RESERVE.sourceFenceToken, '2026-10-21T00:00:00.000Z']);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    it('the reviewed DDL: key, one live reservation per computer, sealed shape, retention and backend-only access', async () => {
        const a = await reserve();
        await expect(q(`INSERT INTO public.ezil_computer_lower_attestations SELECT * FROM public.ezil_computer_lower_attestations`)).rejects.toThrow();
        await expect(q(`INSERT INTO public.ezil_computer_lower_attestations (attestation_id, computer_id, owner_user_id, region, zone_id, source_instance_id,
            source_volume_id, fs_uuid, source_generation, source_lease_epoch, source_fence_token, reserved_row_sha256, request_sha256, challenge, phase,
            created_at, updated_at) SELECT gen_random_uuid(), computer_id, owner_user_id, region, zone_id, source_instance_id, source_volume_id, fs_uuid,
            source_generation, source_lease_epoch, source_fence_token, reserved_row_sha256, request_sha256, challenge, 'reserved', created_at, updated_at
            FROM public.ezil_computer_lower_attestations`)).rejects.toThrow(/unique|duplicate/);
        await expect(q(`UPDATE public.ezil_computer_lower_attestations SET phase = 'adopted'`)).rejects.toThrow(/sealed_check/);
        await expect(q(`UPDATE public.ezil_computer_lower_attestations SET challenge = $1`, ['d'.repeat(64)])).rejects.toThrow(/immutable/);
        await expect(q(`DELETE FROM public.ezil_computer_lower_attestations`)).rejects.toThrow(/retained/);
        await expect(q(`TRUNCATE public.ezil_computer_lower_attestations`)).rejects.toThrow(/retained/);
        await store.refuse(a.attestationId, a.computerId, NOW);
        await expect(q(`UPDATE public.ezil_computer_lower_attestations SET failure_code = 'release_mismatch'`)).rejects.toThrow(/sealed lower attestation is immutable/);
        for (const role of ['anon', 'authenticated', 'service_role'])
            for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE'])
                expect((await q(`SELECT has_table_privilege('${role}', '${schema}.ezil_computer_lower_attestations', '${privilege}') AS ok`))[0]!.ok).toBe(false);
        const codes = /failure_code IN \(([^)]*)\)/.exec(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql/0004_lower_attestations.sql.txt'), 'utf8'))![1]!;
        expect(codes.replace(/\s+/g, ' ').split(',').map(c => c.trim().replaceAll("'", ''))).toEqual([...LOWER_ATTESTATION_FAILURE_CODES]);
    });

    it('reserve fences the exact NULL row and changes nothing else; replay is exact; ordinary admission and rebase are refused', async () => {
        const before = await placementRow();
        const a = await reserve();
        const after = await placementRow();
        expect(after.image_upgrade_job_id).toBe(a.attestationId);
        expect(without(after, 'image_upgrade_job_id', 'updated_at')).toEqual(without(before, 'image_upgrade_job_id', 'updated_at'));
        expect(a.challenge).toMatch(/^[0-9a-f]{64}$/);
        expect(await reserve()).toEqual(a);
        await expect(reserve({ sourceLeaseEpoch: 4 })).rejects.toThrow('image_job_conflict');
        await expect(assertNoImageReservation(db, RESERVE.computerId)).rejects.toThrow('image_job_conflict');
        await expect(images.reserve(rebaseJob(), repository)).rejects.toThrow('image_job_conflict');
        await expect(images.inspect(RESERVE.computerId)).rejects.toThrow('image_job_conflict');
        await expect(reserve({ attestationId: '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a' })).rejects.toThrow('image_job_conflict');
    });

    it.each([
        ['a recorded lower', `UPDATE public.ezil_computer_placements SET lower_image_digest = '${MEASURED}', lower_digest_observed_at = now()`],
        ['a running placement', `UPDATE public.ezil_computer_placements SET state = 'RUNNING'`],
        ['another fence', `UPDATE public.ezil_computer_placements SET fence_token = gen_random_uuid()`],
        ['a lifecycle job', `UPDATE public.ezil_computer_placements SET lifecycle_job_id = gen_random_uuid()`],
        ['an open migration', `INSERT INTO public.ezil_compute_migrations (user_id, computer_id, from_provider, to_provider, to_size, state)
            VALUES ('${OWNER}', '${RESERVE.computerId}', 'cloudflare', 'aws-ec2', 'standard', 'provisioning')`],
        ['a deleted computer', `UPDATE public.ezil_computers SET deleted_at = now()`],
    ])('reserve refuses %s and writes nothing', async (_name, mutation) => {
        await q(mutation);
        const before = await placementRow();
        await expect(reserve()).rejects.toThrow('image_job_conflict');
        expect(await placementRow()).toEqual(before);
        expect((await q(`SELECT count(*)::int AS n FROM public.ezil_computer_lower_attestations`))[0]!.n).toBe(0);
    });

    it('adopt sets only the measured lower, its observation time and the fence, exactly once; ordinary rebase then applies', async () => {
        const a = await reserve();
        const before = await placementRow();
        const adopted = await store.adopt(a.attestationId, a.computerId, realProof(), NOW);
        expect(adopted).toMatchObject({ phase: 'adopted', measuredDigest: MEASURED, measuredAt: '2026-10-22T11:30:00.000Z', commandId: COMMAND_ID, failureCode: null });
        const after = await placementRow();
        expect(after.lower_image_digest).toBe(MEASURED);
        expect(new Date(after.lower_digest_observed_at).toISOString()).toBe('2026-10-22T11:30:00.000Z');
        expect(after.image_upgrade_job_id).toBeNull();
        expect(without(after, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'))
            .toEqual(without(before, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'));
        // Replay answers with the sealed row and writes nothing.
        expect(await store.adopt(a.attestationId, a.computerId, () => { throw new Error('never re-proved'); }, NOW)).toEqual(adopted);
        expect(await placementRow()).toEqual(after);
        await expect(store.refuse(a.attestationId, a.computerId, NOW)).resolves.toEqual(adopted);
        // Ordinary rules now: the existing operator rebase reservation admits from the measured lower.
        await expect(images.reserve(rebaseJob(), repository)).resolves.toMatchObject({ phase: 'reserved', fromDigest: MEASURED });
    });

    it('concurrent adopts: one compare-and-set, one sealed row, the same answer', async () => {
        const a = await reserve();
        const [x, y] = await Promise.all([store.adopt(a.attestationId, a.computerId, realProof(), NOW), store.adopt(a.attestationId, a.computerId, realProof(), NOW)]);
        expect(x).toEqual(y);
        expect(x.phase).toBe('adopted');
        expect((await placementRow()).lower_image_digest).toBe(MEASURED);
        expect((await q(`SELECT count(*)::int AS n FROM public.ezil_computer_lower_attestations`))[0]!.n).toBe(1);
    });

    it('concurrent adopt and abort end in exactly one consistent terminal state', async () => {
        const a = await reserve();
        const [x, y] = await Promise.all([store.adopt(a.attestationId, a.computerId, realProof(), NOW), store.refuse(a.attestationId, a.computerId, NOW)]);
        expect(x).toEqual(y);
        const p = await placementRow();
        expect(p.image_upgrade_job_id).toBeNull();
        expect(p.lower_image_digest).toBe(x.phase === 'adopted' ? MEASURED : null);
    });

    it.each([
        ['row drift', `UPDATE public.ezil_computer_placements SET last_error = 'drift'`],
        ['owner change', `UPDATE public.ezil_computers SET user_id = gen_random_uuid()`],
        ['computer deletion', `UPDATE public.ezil_computers SET deleted_at = now()`],
    ])('%s seals placement_changed, clears only its own fence and never writes the lower', async (_name, mutation) => {
        const a = await reserve();
        await q(mutation);
        const sealed = await store.adopt(a.attestationId, a.computerId, () => { throw new Error('never proved after drift'); }, NOW);
        expect(sealed).toMatchObject({ phase: 'refused', failureCode: 'placement_changed' });
        const p = await placementRow();
        expect(p.image_upgrade_job_id).toBeNull();
        expect(p.lower_image_digest).toBeNull();
    });

    it('a proof refusal or expiry seals refused and releases the fence; the lower stays NULL', async () => {
        const a = await reserve();
        const before = await placementRow();
        const refused = await store.adopt(a.attestationId, a.computerId, () => { throw new LowerAttestationRefusal('release_mismatch'); }, NOW);
        expect(refused).toMatchObject({ phase: 'refused', failureCode: 'release_mismatch', measuredDigest: null });
        expect(without(await placementRow(), 'image_upgrade_job_id', 'updated_at')).toEqual(without(before, 'image_upgrade_job_id', 'updated_at'));
        expect((await placementRow()).image_upgrade_job_id).toBeNull();
        const b = await reserve({ attestationId: '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a' });
        const late = new Date(Date.parse(CREATED) + LOWER_ATTESTATION_TTL_MS + 1);
        expect(await store.adopt(b.attestationId, b.computerId, realProof(), late)).toMatchObject({ phase: 'refused', failureCode: 'reservation_expired' });
        expect((await placementRow()).lower_image_digest).toBeNull();
    });

    it('a transient reader or programming error throws before any write', async () => {
        const a = await reserve();
        const before = await placementRow();
        await expect(store.adopt(a.attestationId, a.computerId, () => { throw new Error('aws_error'); }, NOW)).rejects.toThrow('aws_error');
        expect(await placementRow()).toEqual(before);
        expect((await store.inspect(a.attestationId, a.computerId))!.phase).toBe('reserved');
    });

    it('abort never clears a fence it does not own', async () => {
        const a = await reserve();
        const other = randomUUID();
        await q(`UPDATE public.ezil_computer_placements SET image_upgrade_job_id = $1`, [other]);
        expect(await store.refuse(a.attestationId, a.computerId, NOW)).toMatchObject({ phase: 'refused', failureCode: 'operator_abandoned' });
        expect((await placementRow()).image_upgrade_job_id).toBe(other);
    });

    /** The retired, settled claim row of exactly this allocation (computer, region, zone, generation, epoch, fence, volume). */
    const claim = (over: Record<string, unknown> = {}) => {
        const c = { instance: RESERVE.sourceInstanceId, generation: RESERVE.sourceGeneration, epoch: RESERVE.sourceLeaseEpoch, fence: RESERVE.sourceFenceToken,
            volume: RESERVE.sourceVolumeId.replace('-', ''), state: 'retired', dispatch: 'settled', ...over };
        return q(`INSERT INTO public.ezil_compute_pool_hosts (id, region, zone_id, instance_id, instance_type, state, health, generation, leased_computer_id,
            created_at, updated_at, claim_generation, claim_lease_epoch, claim_fence, claim_volume_serial, lifecycle_job_id, lifecycle_digest, lifecycle_input, dispatch_status)
            VALUES (gen_random_uuid(), $1, $2, $3, 'm6i.large', $4, 'unknown', 1, $5, now(), now(), $6, $7, $8, $9, gen_random_uuid(), $10, '{}', $11)`,
        [RESERVE.region, RESERVE.zoneId, c.instance, c.state, RESERVE.computerId, c.generation, c.epoch, c.fence, c.volume, 'd'.repeat(64), c.dispatch]);
    };
    const session = (instance: string, started: string, stopped: string | null) => q(`INSERT INTO public.ezil_compute_usage
        (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, observed_by, updated_at) VALUES ($1,$2,$3,'m6i.large',$4,$5,'test',$4)`,
    [RESERVE.computerId, OWNER, instance, started, stopped]);

    it('a marker without instanceId on a current placement adopts only with the complete claim-row binding', async () => {
        const a = await reserve();
        expect(await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW)).toMatchObject({ phase: 'refused', failureCode: 'instance_provenance_missing' });
        expect((await placementRow()).lower_image_digest).toBeNull();
        await claim();
        // The fixture's AWS evidence names RESERVE.attestationId; a second reservation is proved as that one.
        const b = await reserve({ attestationId: '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a' });
        const as = (x: LowerAttestationRecord, p: ImagePlacement, provenance: InstanceProvenance) =>
            realProof(LEGACY_MARKER)({ ...x, attestationId: RESERVE.attestationId }, p, provenance);
        await expect(store.adopt(b.attestationId, b.computerId, as, NOW)).resolves.toMatchObject({ failureCode: null, phase: 'adopted', measuredDigest: MEASURED });
    });

    /** A committed CF→AWS row persisting exactly this allocation's provision (the actual QA and production incident shape). */
    const committed = (over: { instanceId?: string; leaseEpoch?: number; state?: string } = {}) => q(`INSERT INTO public.ezil_compute_migrations
        (user_id, computer_id, from_provider, to_provider, to_size, state, workspace_head) VALUES ($1, $2, 'cloudflare', 'aws-ec2', 'standard', $3, $4::text::jsonb)`,
    [OWNER, RESERVE.computerId, over.state ?? 'committed', JSON.stringify({ _awsProvision: { placement: { computerId: RESERVE.computerId, ownerUserId: OWNER,
        provider: 'aws-ec2', store: 'ebs', generation: RESERVE.sourceGeneration, leaseEpoch: over.leaseEpoch ?? RESERVE.sourceLeaseEpoch, state: 'STARTING',
        region: RESERVE.region, zoneId: RESERVE.zoneId, instanceId: over.instanceId ?? RESERVE.sourceInstanceId, volumeId: RESERVE.sourceVolumeId,
        fsUuid: RESERVE.fsUuid, fenceToken: RESERVE.sourceFenceToken }, deployment: { ...DEPLOYMENT, amiId: SOURCE_RELEASE.amiId,
        launchTemplateId: SOURCE_RELEASE.launchTemplateId, launchTemplateVersion: SOURCE_RELEASE.launchTemplateVersion }, source: null, reservedAt: '2026-10-20T07:59:00.000Z' } })]);

    describe('zero claim rows, one committed CF→AWS migration (the actual QA and production incident shape)', () => {
        it('current instance non-null (terminated) and a marker without instanceId adopt through the committed migration', async () => {
            await committed();
            const before = await placementRow();
            const a = await reserve();
            const adopted = await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW);
            expect(adopted).toMatchObject({ phase: 'adopted', measuredDigest: MEASURED });
            expect(adopted.evidence).toMatchObject({ instanceProvenance: 'committed-migration', placementInstance: 'current', poolClaimNamesSource: false });
            expect((adopted.evidence as { committedMigration: { provisionSha256: string } }).committedMigration.provisionSha256).toMatch(/^[0-9a-f]{64}$/);
            const after = await placementRow();
            expect(without(after, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'))
                .toEqual(without(before, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'));
        });

        it('a released placement reserves and adopts through the committed migration alone', async () => {
            await q(`UPDATE public.ezil_computer_placements SET instance_id = NULL`);
            await expect(reserve()).rejects.toThrow('image_job_conflict');
            await committed();
            const a = await reserve();
            expect(await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW)).toMatchObject({ phase: 'adopted', measuredDigest: MEASURED });
        });

        it('a migration naming another instance for this allocation is a contradiction: reserve refuses and writes nothing', async () => {
            await committed({ instanceId: 'i-77777777777777777' });
            const before = await placementRow();
            await expect(reserve()).rejects.toThrow('image_job_conflict');
            expect(await placementRow()).toEqual(before);
        });

        it.each([
            ['is two rows for the same allocation (ambiguous)', async () => { await committed(); await committed(); }, 'instance_provenance_missing'],
            ['is another lease epoch (not this allocation)', async () => { await committed({ leaseEpoch: RESERVE.sourceLeaseEpoch - 1 }); }, 'instance_provenance_missing'],
        ])('a migration that %s never binds; the lower stays NULL', async (_name, history, code) => {
            await history();
            const a = await reserve();
            expect(await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW)).toMatchObject({ phase: 'refused', failureCode: code });
            const p = await placementRow();
            expect(p.lower_image_digest).toBeNull();
            expect(p.image_upgrade_job_id).toBeNull();
        });

        it('a released placement refuses to reserve on a contradicting or ambiguous migration and writes nothing', async () => {
            await q(`UPDATE public.ezil_computer_placements SET instance_id = NULL`);
            for (const history of [() => committed({ instanceId: 'i-77777777777777777' }), () => committed()]) {
                await history();
                const before = await placementRow();
                await expect(reserve()).rejects.toThrow('image_job_conflict');
                expect(await placementRow()).toEqual(before);
            }
        });

        it('lineage that changes after the reservation (a contradicting row appears) seals instance_provenance_missing', async () => {
            await committed();
            const a = await reserve();
            await committed({ instanceId: 'i-77777777777777777' });
            expect(await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW)).toMatchObject({ phase: 'refused', failureCode: 'instance_provenance_missing' });
            expect((await placementRow()).lower_image_digest).toBeNull();
        });
    });

    describe('a released placement (instance_id NULL) with retired claim rows', () => {
        beforeEach(async () => { await q(`UPDATE public.ezil_computer_placements SET instance_id = NULL`); });

        it('reserves and adopts only through the claim row of exactly this allocation; the NULL instance is frozen, compared and kept', async () => {
            await expect(reserve()).rejects.toThrow('image_job_conflict');                    // no history: the request alone never names it
            await session(RESERVE.sourceInstanceId, '2026-10-20T08:01:00Z', '2026-10-21T00:00:00Z');
            await expect(reserve()).rejects.toThrow('image_job_conflict');                    // usage alone never binds
            await claim();
            const before = await placementRow();
            const a = await reserve();
            expect(a.currentInstanceId).toBeNull();
            expect(a.sourceInstanceId).toBe(RESERVE.sourceInstanceId);
            const adopted = await store.adopt(a.attestationId, a.computerId, realProof(LEGACY_MARKER), NOW);
            expect(adopted).toMatchObject({ phase: 'adopted', measuredDigest: MEASURED });
            expect(adopted.evidence).toMatchObject({ placementInstance: 'released', poolClaimNamesSource: true, instanceProvenance: 'pool-claim', usageLedger: 'corroborates' });
            const after = await placementRow();
            expect(after.instance_id).toBeNull();
            expect(without(after, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'))
                .toEqual(without(before, 'lower_image_digest', 'lower_digest_observed_at', 'image_upgrade_job_id', 'updated_at'));
        });

        it.each([
            ['a claim row for another instance', async () => { await claim({ instance: 'i-77777777777777777' }); }],
            ['a claim row of another generation', async () => { await claim({ generation: RESERVE.sourceGeneration + 1 }); }],
            ['a claim row of another fence', async () => { await claim({ fence: randomUUID() }); }],
            ['a claim row of another volume', async () => { await claim({ volume: 'vol77777777777777777' }); }],
            ['an unsettled claim row', async () => { await claim({ dispatch: 'pending' }); }],
            ['a claim row still leased', async () => { await claim({ state: 'leased' }); }],
            ['two claim rows', async () => { await claim(); await claim({ instance: 'i-77777777777777777' }); }],
            ['conflicting usage', async () => { await claim(); await session('i-77777777777777777', '2026-10-20T08:01:00Z', '2026-10-21T00:00:00Z'); }],
            ['an open usage session', async () => { await claim(); await session(RESERVE.sourceInstanceId, '2026-10-20T08:01:00Z', null); }],
        ])('refuses to reserve with %s and writes nothing', async (_name, history) => {
            await history();
            const before = await placementRow();
            await expect(reserve()).rejects.toThrow('image_job_conflict');
            expect(await placementRow()).toEqual(before);
        });

        it('lineage that changes after the reservation seals instance_provenance_missing and clears only its own fence', async () => {
            await claim();
            const a = await reserve();
            await session('i-77777777777777777', '2026-10-21T01:00:00Z', '2026-10-21T02:00:00Z');
            expect(await store.adopt(a.attestationId, a.computerId, realProof(), NOW)).toMatchObject({ phase: 'refused', failureCode: 'instance_provenance_missing' });
            const p = await placementRow();
            expect(p.lower_image_digest).toBeNull();
            expect(p.image_upgrade_job_id).toBeNull();
            expect(p.instance_id).toBeNull();
        });

        it('a current instance appearing after the reservation seals placement_changed', async () => {
            await claim();
            const a = await reserve();
            await q(`UPDATE public.ezil_computer_placements SET instance_id = $1`, [RESERVE.sourceInstanceId]);
            expect(await store.adopt(a.attestationId, a.computerId, realProof(), NOW)).toMatchObject({ phase: 'refused', failureCode: 'placement_changed' });
            expect((await placementRow()).lower_image_digest).toBeNull();
        });
    });
});
