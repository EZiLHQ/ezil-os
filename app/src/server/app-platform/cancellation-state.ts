import { and, asc, eq, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { computers, computerRuntimes, computerInstances, computerCancellations as cancellations,
    computerCancellationOutbox as deliveries, computerLifecycleJobs as jobs, computerLifecycleOutbox as outbox,
    computerLifecycleIntents as intents, computerRecoveryIntents as recoveries } from '@/server/db/schema';
import { parseComputerCancellation } from './computer-cancellation-protocol';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { lifecycleDeploymentApproved, type LifecycleApproval } from './lifecycle-approval';
import { CancellationAuthorityScopeSchema, CancellationWritersSchema, type CancellationAuthorityRequest } from './cancellation-authority-protocol';

export type CancellationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface CancellationOptions {
    database: typeof db; enabled: boolean; deployments: readonly LifecycleApproval[];
    workflows: Readonly<Record<string, string>>;
}
export async function cancellationTimeouts(tx: CancellationTransaction) {
    await tx.execute(sql`SET LOCAL lock_timeout='2000ms'`);
    await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);
}

/** Caller holds computer-first locks. Immutable prior authorization survives
 * owner access revocation; a current pending cancellation is the authority. */
export async function loadCancellation(tx: CancellationTransaction, o: CancellationOptions,
    input: Pick<CancellationAuthorityRequest, 'computerId' | 'cancellationId'>) {
    const [computer] = await tx.select().from(computers).where(eq(computers.id, input.computerId)).limit(1).for('update');
    const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, input.computerId)).limit(1).for('update');
    const [row] = await tx.select({ record: cancellations, document: sql<string>`public.ezil_computer_cancellation_document(${cancellations})` })
        .from(cancellations).where(and(eq(cancellations.id, input.cancellationId), eq(cancellations.computerId, input.computerId))).limit(1);
    if (!computer || computer.provider !== 'aws-ec2' || !runtime || !row) return null;
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, row.record.sourceJobId), eq(jobs.computerId, computer.id))).limit(1).for('update');
    if (!job || !['queued','running'].includes(job.status) || job.status !== row.record.sourceState || job.completedAt) return null;
    const table = row.record.sourceSchemaVersion === 1 ? intents : recoveries;
    const document = row.record.sourceSchemaVersion === 1 ? sql<string>`public.ezil_lifecycle_intent_document(${intents})`
        : sql<string>`public.ezil_computer_recovery_document(${recoveries})`;
    const [source] = await tx.select({ document, digest: table.digest, createdAt: table.createdAt }).from(table)
        .where(and(eq(table.jobId, job.id), eq(table.computerId, computer.id))).limit(1);
    if (!source) return null;
    const work = { document: row.document, digest: row.record.digest, createdAt: row.record.createdAt };
    const cancellation = parseComputerCancellation(work, source), intent = parseComputerLifecycleWork(source);
    if (intent.operation !== job.operation || intent.targetGeneration !== job.targetGeneration
        || !lifecycleDeploymentApproved(o.deployments, intent)
        || o.workflows[intent.deployment.stateMachineVersionArn] !== cancellation.workflowVersionArn
        || runtime.region !== intent.deployment.region
        || runtime.nextGeneration <= intent.targetGeneration
        || (['provision','replace','recover'].includes(intent.operation) && runtime.nextGeneration !== intent.targetGeneration + 1)
        || (runtime.availabilityZone !== null && runtime.availabilityZone !== intent.deployment.availabilityZone)
        || (intent.dataVolumeId !== null && runtime.dataVolumeId !== intent.dataVolumeId)) return null;
    const [original] = await tx.select().from(outbox).where(and(eq(outbox.jobId, job.id), eq(outbox.computerId, computer.id))).limit(1).for('update');
    const [delivery] = await tx.select().from(deliveries).where(eq(deliveries.cancellationId, cancellation.cancellationId)).limit(1).for('update');
    if (!original || original.deliveredAt || !delivery || delivery.deliveredAt) return null;
    const rows = await tx.select().from(computerInstances).where(eq(computerInstances.computerId, computer.id))
        .orderBy(asc(computerInstances.generation)).limit(129).for('update');
    const originalInstance = intent.schemaVersion === 1 ? intent.previousInstanceId ?? intent.providerInstanceId : null;
    const parsed = CancellationWritersSchema.safeParse(rows.map(w => ({ instanceId: w.providerInstanceId,
        generation: w.generation, fenceToken: w.fenceToken, observedState: w.observedState,
        observedAt: w.observedAt?.toISOString() ?? null, fencedAt: w.fencedAt?.toISOString() ?? null })));
    if (!parsed.success || (originalInstance && !rows.some(w => w.providerInstanceId === originalInstance))) return null;
    for (const w of rows) {
        const original = w.providerInstanceId === originalInstance;
        if (w.generation > intent.targetGeneration) return null;
        if (original && intent.schemaVersion === 1) {
            if (w.generation !== (intent.previousGeneration ?? intent.targetGeneration)
                || w.fenceToken !== (intent.previousFenceToken ?? intent.fenceToken)) return null;
        } else if (w.generation === intent.targetGeneration) {
            if (w.fenceToken !== intent.fenceToken) return null;
        } else if (!w.fencedAt || !w.observedAt || w.observedState !== 'stopped' || w.fenceToken === intent.fenceToken
            || w.fencedAt.getTime() > source.createdAt.getTime()) return null;
        if (w.fencedAt && (!w.observedAt || w.observedState !== 'stopped'
            || w.observedAt.getTime() > w.fencedAt.getTime() + 5000 || w.fencedAt.getTime() > Date.now() + 5000)) return null;
    }
    const scope = CancellationAuthorityScopeSchema.safeParse({ source: { schemaVersion: intent.schemaVersion, jobId: job.id, digest: source.digest },
        dataVolumeId: runtime.dataVolumeId, writers: parsed.data });
    return scope.success ? { computer, runtime, job, original, delivery, work, source, cancellation, intent, rows, scope: scope.data } : null;
}
