import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { computers, computerRuntimes, computerInstances, computerLifecycleJobs as jobs,
    computerLifecycleOutbox as outbox, computerLifecycleIntents as intents,
    computerRecoveryIntents as recoveries } from '@/server/db/schema';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { lifecycleDeploymentApproved, type LifecycleApproval } from './lifecycle-approval';
import { hasCurrentOsAccess, type OsAccessMode } from './runtime-authority';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export class ApplicationComputerStartError extends Error {
    constructor(readonly code: 'computer_start_denied' | 'computer_lifecycle_in_progress' | 'computer_recovery_required') { super(code); }
}
const deny = (code: ApplicationComputerStartError['code']): never => { throw new ApplicationComputerStartError(code); };

/** Called inside the authorized app-command transaction, after locking its
 * computer and installation. These IDs come from that transaction, never from
 * a service-map request. No provider effects occur here. An accepted request
 * commits its app command, lifecycle intent, outboxes and audit together.
 * Existing writers retain their original deployment; new operator pins do not
 * silently relocate an existing computer or its disk. */
export async function prepareApplicationComputerStart(tx: Transaction, o: {
    userId: string; computerId: string; computerGeneration: number; appJobId: string;
    deployments: readonly LifecycleApproval[]; osAccessMode: OsAccessMode;
}) {
    await tx.execute(sql`SET LOCAL lock_timeout='2s'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5s'`);
    const [computer] = await tx.select().from(computers).where(eq(computers.id, o.computerId)).limit(1).for('update');
    if (!computer || computer.userId !== o.userId || computer.deletedAt || computer.provider !== 'aws-ec2'
        || !await hasCurrentOsAccess(tx, o.userId, o.osAccessMode)) deny('computer_start_denied');
    const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, o.computerId)).limit(1).for('update');
    const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, o.computerId),
        isNull(computerInstances.fencedAt))).limit(1).for('update');
    if (!runtime?.dataVolumeId || !runtime.availabilityZone || runtime.desiredState === 'retired'
        || !writer?.providerInstanceId || writer.generation !== o.computerGeneration
        || !['stopped', 'starting', 'running'].includes(writer.observedState)) deny('computer_recovery_required');

    const pending = await tx.select().from(jobs).where(and(eq(jobs.computerId, o.computerId),
        inArray(jobs.status, ['queued', 'running']))).for('update');
    if (pending.some(j => j.operation !== 'start')) deny('computer_lifecycle_in_progress');
    if (pending.length > 1) deny('computer_recovery_required');

    // Recovery has its own immutable v2 document. Read both histories through
    // their canonical SQL serializers; no stored digest is synthesized here.
    const [source] = await tx.select({ job: jobs, deliveredAt: outbox.deliveredAt, document: sql<string>`CASE WHEN ${jobs.operation}='recover'
        THEN public.ezil_computer_recovery_document(${recoveries}) ELSE public.ezil_lifecycle_intent_document(${intents}) END`,
    digest: sql<string>`coalesce(${intents.digest},${recoveries.digest})`,
    createdAt: sql`coalesce(${intents.createdAt},${recoveries.createdAt})`.mapWith(intents.createdAt) }).from(jobs)
        .innerJoin(outbox, eq(outbox.jobId, jobs.id))
        .leftJoin(intents, eq(intents.jobId, jobs.id)).leftJoin(recoveries, eq(recoveries.jobId, jobs.id))
        .where(and(eq(jobs.computerId, o.computerId),
            or(sql`${intents.jobId} IS NOT NULL`, sql`${recoveries.jobId} IS NOT NULL`)))
        .orderBy(desc(sql`coalesce(${intents.revision},${recoveries.revision})`)).limit(1);
    if (!source || (pending[0] && pending[0].id !== source.job.id)) deny('computer_recovery_required');
    const intent = parseComputerLifecycleWork(source);
    if (intent.jobId !== source.job.id || intent.computerId !== o.computerId || intent.operation !== source.job.operation
        || source.job.targetGeneration !== writer.generation || intent.targetGeneration !== writer.generation
        || intent.fenceToken !== writer.fenceToken || intent.deployment.region !== runtime.region
        || intent.deployment.availabilityZone !== runtime.availabilityZone
        || (intent.dataVolumeId !== null && intent.dataVolumeId !== runtime.dataVolumeId)
        || (intent.schemaVersion === 1 && intent.providerInstanceId !== null && intent.providerInstanceId !== writer.providerInstanceId)
        || (pending.length && source.deliveredAt !== null)
        || (!pending.length && (source.job.status !== 'succeeded' || !source.job.completedAt || !source.deliveredAt
            || intent.operation === 'retire'))) deny('computer_recovery_required');
    if (!lifecycleDeploymentApproved(o.deployments, intent)) deny('computer_start_denied');
    if (pending[0] && (pending[0].requestedBy !== o.userId || pending[0].targetGeneration !== writer.generation)) {
        deny('computer_start_denied');
    }
    if (!pending.length && writer.observedState !== 'running') {
        if (writer.observedState !== 'stopped') deny('computer_recovery_required');
        const key = `application:${o.appJobId}`;
        const [previous] = await tx.select({ id: jobs.id }).from(jobs)
            .where(and(eq(jobs.computerId, o.computerId), eq(jobs.idempotencyKey, key))).limit(1);
        // A spent job cannot be replayed, renewed or requeued by another Open.
        if (previous) deny('computer_recovery_required');
        // V1 lifecycle and v2 recovery share a single revision ledger.
        const revision = intent.revision + 1;
        if (revision > 2147483647) deny('computer_recovery_required');
        const [job] = await tx.insert(jobs).values({ computerId: o.computerId, targetGeneration: writer.generation,
            requestedBy: o.userId, operation: 'start', idempotencyKey: key }).returning();
        if (!job) throw new Error('computer_job_not_recorded');
        await tx.insert(outbox).values({ jobId: job.id, computerId: o.computerId });
        await tx.insert(intents).values({ jobId: job.id, computerId: o.computerId, revision, operation: 'start',
            targetGeneration: writer.generation, fenceToken: writer.fenceToken, providerInstanceId: writer.providerInstanceId,
            dataVolumeId: runtime.dataVolumeId, deployment: JSON.stringify(intent.deployment) });
    }
    await tx.update(computerRuntimes).set({ desiredState: 'running', updatedAt: sql`clock_timestamp()` })
        .where(eq(computerRuntimes.computerId, o.computerId));
}
