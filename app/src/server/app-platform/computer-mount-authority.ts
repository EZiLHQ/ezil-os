import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { db } from '@/server/db';
import { computers, computerRuntimes, computerInstances, computerLifecycleJobs as jobs,
    computerLifecycleIntents as intents, computerRecoveryIntents as recoveries,
    computerDataMountAuthorizations as grants } from '@/server/db/schema';
import { hasCurrentOsAccess } from './runtime-authority';
import { lifecycleDeploymentApproved } from './lifecycle-approval';
import { parseComputerLifecycleWork, validateComputerLifecycleReceipt } from './computer-lifecycle-work';
import { loadRecoveryWriters, type FencedWriters } from './computer-recovery-authority';
import type { LifecycleConsumerOptions } from './lifecycle-consumer';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type MountAuthorityOptions = Pick<LifecycleConsumerOptions, 'database' | 'enabled' | 'osAccessMode' | 'deployments'>;
type Options = MountAuthorityOptions & Pick<LifecycleConsumerOptions, 'advance'>;
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const Input = z.object({ computerId: uuid, jobId: uuid }).strict();
type Input = z.infer<typeof Input>;
type Grant = typeof grants.$inferSelect;

/** The host's strict v1 wire records, derived only from immutable DB columns. */
export function mountAuthorityRecords(a: Grant) {
    const scope = { computerId: a.computerId, computerGeneration: a.computerGeneration, fenceToken: a.fenceToken,
        providerInstanceId: a.providerInstanceId, dataVolumeId: a.dataVolumeId };
    return { authorization: { schemaVersion: 1 as const, authorizationId: a.id, scope, filesystemUuid: a.filesystemUuid,
        mode: a.mode, digest: a.digest, issuedAt: a.issuedAt.getTime() / 1000, expiresAt: a.expiresAt.getTime() / 1000 },
    plan: { computerId: a.computerId, filesystemUuid: a.filesystemUuid, mode: a.mode,
        schemaVersion: 1 as const, volumeId: a.dataVolumeId } };
}

/** Current database authority only. Callers must lock through commit and must
 * independently observe the provider before authorizing host effects. */
export async function loadCurrentMountAuthority(tx: Transaction, o: MountAuthorityOptions, input: Input) {
    if (!o.enabled) return null;
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`); await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [computer] = await tx.select().from(computers).where(eq(computers.id, input.computerId)).limit(1).for('update');
    const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, input.computerId)).limit(1).for('update');
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.computerId, input.computerId))).limit(1).for('update');
    if (!computer || !runtime?.dataFilesystemUuid || !runtime.dataVolumeId || job?.status !== 'succeeded' || !job.completedAt
        || computer.provider !== 'aws-ec2' || computer.deletedAt || job.requestedBy !== computer.userId
        || !['provision', 'start', 'replace', 'recover'].includes(job.operation)) return null;
    const table = job.operation === 'recover' ? recoveries : intents;
    const document = job.operation === 'recover' ? sql<string>`public.ezil_computer_recovery_document(${recoveries})`
        : sql<string>`public.ezil_lifecycle_intent_document(${intents})`;
    const [work] = await tx.select({ document, digest: table.digest, createdAt: table.createdAt }).from(table)
        .where(and(eq(table.jobId, job.id), eq(table.computerId, computer.id))).limit(1);
    if (!work) return null;
    const intent = parseComputerLifecycleWork(work);
    if (!lifecycleDeploymentApproved(o.deployments, intent) || !await hasCurrentOsAccess(tx, computer.userId, o.osAccessMode)) return null;
    const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, computer.id),
        eq(computerInstances.generation, intent.targetGeneration))).limit(1).for('update');
    if (!writer?.providerInstanceId) return null;
    const fields = { computerId: computer.id, computerGeneration: writer.generation, lifecycleJobId: job.id,
        fenceToken: writer.fenceToken, providerInstanceId: writer.providerInstanceId, dataVolumeId: runtime.dataVolumeId,
        filesystemUuid: runtime.dataFilesystemUuid, mode: intent.operation === 'provision' ? 'initialize' as const : 'mount' as const };
    const record = { computer_id: fields.computerId, computer_generation: fields.computerGeneration, lifecycle_job_id: fields.lifecycleJobId,
        fence_token: fields.fenceToken, provider_instance_id: fields.providerInstanceId, data_volume_id: fields.dataVolumeId,
        filesystem_uuid: fields.filesystemUuid, mode: fields.mode };
    const result = await tx.execute<{ current: boolean }>(sql`SELECT public.ezil_data_mount_current(
        jsonb_populate_record(NULL::public.ezil_computer_data_mount_authorizations,${JSON.stringify(record)}::jsonb)) AS current`);
    if (!result[0]?.current) return null;
    const fencedWriters: FencedWriters | null = intent.schemaVersion === 2
        ? await loadRecoveryWriters(tx, intent, writer.providerInstanceId) : [];
    if (!fencedWriters) return null;
    const [existing] = await tx.select({ grant: grants, active: sql<boolean>`${grants.revokedAt} IS NULL AND ${grants.expiresAt}>clock_timestamp()` })
        .from(grants).where(eq(grants.lifecycleJobId, job.id)).limit(1).for('update');
    if (!o.enabled || (existing && (!existing.active
        || Object.entries(fields).some(([key, value]) => existing.grant[key as keyof typeof fields] !== value)))) return null;
    return { work, fields, fencedWriters, existing: existing?.grant, owner: computer.userId };
}

/** Internal trusted producer, not a browser endpoint. Pass the real AWS
 * lifecycle transport; it is ALWAYS invoked with allowStart=false. Provider
 * observation runs outside SQL locks; authority is rechecked before issuance.
 * This issues/enqueues authority only, without S3/SSM dispatch or readiness. */
export async function issueComputerDataMount(o: Options, input: unknown) {
    if (!o.enabled) return { state: 'disabled' as const };
    const parsed = Input.safeParse(input);
    if (!parsed.success) return { state: 'denied' as const };
    try {
        const before = await o.database.transaction(tx => loadCurrentMountAuthority(tx, o, parsed.data));
        if (!before) return { state: 'denied' as const };
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        let observed: Awaited<ReturnType<Options['advance']>>;
        try {
            observed = await Promise.race([o.advance(before.work, false, controller.signal, { fencedWriters: before.fencedWriters }),
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
                    controller.abort(); reject(new Error('mount_observation_timeout'));
                }, 20000); })]);
        } catch { return { state: 'unconfirmed' as const }; }
        finally { clearTimeout(timer); }
        if (observed.state !== 'observed' || !(observed.observedAt instanceof Date) || !Number.isFinite(observed.observedAt.getTime())) {
            return { state: 'unconfirmed' as const };
        }
        const receipt = validateComputerLifecycleReceipt(before.work, observed.receipt);
        if (receipt.state !== 'running' || receipt.instanceId !== before.fields.providerInstanceId
            || receipt.volumeId !== before.fields.dataVolumeId) return { state: 'unconfirmed' as const };
        return await o.database.transaction(async tx => {
            const after = await loadCurrentMountAuthority(tx, o, parsed.data);
            if (!after || before.owner !== after.owner || before.work.document !== after.work.document || before.work.digest !== after.work.digest
                || JSON.stringify(before.fields) !== JSON.stringify(after.fields)
                || JSON.stringify(before.fencedWriters) !== JSON.stringify(after.fencedWriters)) return { state: 'denied' as const };
            const fresh = await tx.execute<{ fresh: boolean }>(sql`SELECT ${observed.observedAt.toISOString()}::timestamptz
                BETWEEN clock_timestamp()-interval '29 seconds' AND clock_timestamp()+interval '4 seconds' AS fresh`);
            if (!fresh[0]?.fresh) return { state: 'unconfirmed' as const };
            const grant = after.existing ?? (await tx.insert(grants).values({ ...after.fields, providerObservedAt: observed.observedAt }).returning())[0];
            if (!grant) throw new Error('mount_authority_unavailable');
            return { state: 'issued' as const, ...mountAuthorityRecords(grant) };
        });
    } catch { throw new Error('mount_authority_unavailable'); }
}
