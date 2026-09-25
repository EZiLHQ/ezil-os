import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { db } from '@/server/db';
import { appAdmins, appAuditEvents, computers, computerRuntimes, computerCancellations as cancellations,
    computerCancellationOutbox as deliveries, computerLifecycleJobs as jobs, computerLifecycleIntents as intents,
    computerRecoveryIntents as recoveries } from '@/server/db/schema';
import { hasCurrentOsAccess, type OsAccessMode } from './runtime-authority';
import { lifecycleDeploymentApproved, type LifecycleApproval } from './lifecycle-approval';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { parseComputerCancellation } from './computer-cancellation-protocol';
import { LifecycleError } from './lifecycle-protocol';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
const inputSchema = z.object({ computerId: uuid }).strict();
export interface ComputerCancellationOptions {
    database: typeof db; enabled: boolean; osAccessMode: OsAccessMode;
    /** Keep historical approved pins for scoped cleanup after access revocation. */
    deployments: readonly LifecycleApproval[];
    /** Operator-owned exact source version -> cancellation version mapping.
     * Never accept this mapping or provider IDs from a browser/publisher. */
    workflows: Readonly<Record<string, string>>;
}
export type ComputerCancellationResult = { state: 'disabled' | 'inactive' } | { state: 'pending'; cancellationId: string };

/** Caller must supply requesterId from a verified server session, not request
 * JSON. These producers perform no network/provider calls or settlement. */
export async function requestComputerStopCancellation(o: ComputerCancellationOptions, requesterId: string, input: unknown) {
    if (o.enabled && !uuid.safeParse(requesterId).success) throw new LifecycleError('lifecycle_invalid');
    return request(o, input, requesterId);
}

/** Internal reconciliation only. A missing/failed lookup is not revocation;
 * this verifies explicit current desired-state, identity and OS-access records. */
export function requestRevokedComputerCancellation(o: ComputerCancellationOptions, input: unknown) {
    return request(o, input, null);
}

async function request(o: ComputerCancellationOptions, input: unknown, requesterId: string | null): Promise<ComputerCancellationResult> {
    if (!o.enabled) return { state: 'disabled' };
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success || (requesterId !== null && !uuid.safeParse(requesterId).success)) throw new LifecycleError('lifecycle_invalid');
    try { return await o.database.transaction(async tx => {
        await tx.execute(sql`SET LOCAL lock_timeout='2000ms'`);
        await tx.execute(sql`SET LOCAL statement_timeout='5000ms'`);
        const [computer] = await tx.select().from(computers).where(eq(computers.id, parsed.data.computerId)).limit(1).for('update');
        if (!computer || computer.provider !== 'aws-ec2') throw new LifecycleError('lifecycle_conflict');
        if (requesterId !== null) {
            if (requesterId !== computer.userId) {
                const [admin] = await tx.select().from(appAdmins).where(and(eq(appAdmins.userId, requesterId), isNull(appAdmins.revokedAt))).limit(1).for('share');
                if (!admin) throw new LifecycleError('lifecycle_conflict');
            }
            if (!await hasCurrentOsAccess(tx, requesterId, o.osAccessMode)) throw new LifecycleError('lifecycle_conflict');
        }
        const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, computer.id)).limit(1).for('update');
        if (!runtime) throw new LifecycleError('lifecycle_conflict');
        const active = await tx.select().from(jobs).where(and(eq(jobs.computerId, computer.id),
            inArray(jobs.status, ['queued','running']), inArray(jobs.operation, ['provision','start','replace','recover'])))
            .limit(2).for('update');
        if (active.length === 0) return { state: 'inactive' };
        if (active.length !== 1) throw new LifecycleError('lifecycle_conflict');
        const job = active[0]!;
        const table = job.operation === 'recover' ? recoveries : intents;
        const document = job.operation === 'recover' ? sql<string>`public.ezil_computer_recovery_document(${recoveries})`
            : sql<string>`public.ezil_lifecycle_intent_document(${intents})`;
        const [source] = await tx.select({ document, digest: table.digest, createdAt: table.createdAt }).from(table)
            .where(and(eq(table.jobId, job.id), eq(table.computerId, computer.id))).limit(1);
        if (!source) throw new LifecycleError('lifecycle_conflict');
        const intent = parseComputerLifecycleWork(source);
        if (intent.computerId !== computer.id || intent.jobId !== job.id || intent.operation !== job.operation
            || intent.targetGeneration !== job.targetGeneration || runtime.region !== intent.deployment.region
            || !lifecycleDeploymentApproved(o.deployments, intent)) throw new LifecycleError('lifecycle_conflict');
        const workflow = o.workflows[intent.deployment.stateMachineVersionArn];
        if (!workflow) throw new LifecycleError('lifecycle_conflict');
        const [existing] = await tx.select({ document: sql<string>`public.ezil_computer_cancellation_document(${cancellations})`,
            digest: cancellations.digest, createdAt: cancellations.createdAt }).from(cancellations).where(eq(cancellations.sourceJobId, job.id)).limit(1);
        if (existing) {
            const c = parseComputerCancellation(existing, source);
            if (c.workflowVersionArn !== workflow) throw new LifecycleError('lifecycle_conflict');
            return { state: 'pending', cancellationId: c.cancellationId };
        }
        if (requesterId === null && !computer.deletedAt && runtime.desiredState === 'running'
            && job.requestedBy === computer.userId && await hasCurrentOsAccess(tx, computer.userId, o.osAccessMode)) {
            return { state: 'inactive' };
        }
        const reason = requesterId === null ? 'authority_revoked' : 'stop_requested';
        const [row] = await tx.insert(cancellations).values({ computerId: computer.id, sourceJobId: job.id,
            sourceSchemaVersion: intent.schemaVersion, sourceDigest: source.digest,
            requestedBy: requesterId, reason, workflowVersionArn: workflow }).returning();
        if (!row) throw new LifecycleError('lifecycle_conflict');
        await tx.insert(deliveries).values({ cancellationId: row.id });
        await tx.update(computerRuntimes).set({ desiredState: runtime.desiredState === 'retired' ? 'retired' : 'stopped',
            updatedAt: sql`clock_timestamp()` }).where(eq(computerRuntimes.computerId, computer.id));
        await tx.insert(appAuditEvents).values({ actorUserId: requesterId, computerId: computer.id,
            action: 'computer.cancellation_requested', reasonCode: reason });
        return { state: 'pending', cancellationId: row.id };
    }); } catch (error) {
        if (error instanceof LifecycleError) throw error;
        throw new LifecycleError('lifecycle_unavailable');
    }
}
