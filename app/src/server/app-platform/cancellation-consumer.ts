import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { computers, computerRuntimes, computerInstances, computerCancellations as cancellations,
    computerCancellationOutbox as deliveries, computerLifecycleJobs as jobs, computerLifecycleOutbox as outbox } from '@/server/db/schema';
import { cancellationTimeouts, loadCancellation, type CancellationOptions, type CancellationTransaction } from './cancellation-state';
import { CancellationAuthorityRequestSchema, validateCancellationReceipt,
    type CancellationAuthorityRequest, type CancellationAuthorityScope, type CancellationReceipt } from './cancellation-authority-protocol';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';

export interface CancellationClaim { computerId: string; cancellationId: string; attempt: number }
export interface CancellationConsumerOptions extends CancellationOptions {
    /** Must submit the same immutable execution and independently verify AWS
     * history/resources. No endpoint health or workflow output alone is proof. */
    advance(work: LifecycleWork, source: LifecycleWork, scope: CancellationAuthorityScope, signal: AbortSignal): Promise<
        { state: 'pending' } | { state: 'observed'; receipt: CancellationReceipt; observedAt: Date }>;
}
const due = () => and(isNull(deliveries.deliveredAt), sql`${deliveries.availableAt} <= clock_timestamp()`,
    sql`(${deliveries.leaseUntil} IS NULL OR ${deliveries.leaseUntil} <= clock_timestamp())`, sql`${deliveries.attempts}<2147483647`);
const owns = (c: CancellationClaim) => and(eq(deliveries.cancellationId, c.cancellationId), eq(deliveries.attempts, c.attempt),
    isNull(deliveries.deliveredAt), sql`${deliveries.leaseUntil}>clock_timestamp()`, sql`EXISTS (
        SELECT 1 FROM ${cancellations} WHERE ${cancellations.id}=${deliveries.cancellationId} AND ${cancellations.computerId}=${c.computerId})`);
export async function claimCancellation(o: CancellationOptions): Promise<CancellationClaim | null> {
    if (!o.enabled) return null;
    try { return await o.database.transaction(async tx => {
        await cancellationTimeouts(tx);
        const [candidate] = await tx.select({ computerId: computers.id, cancellationId: cancellations.id }).from(computers)
            .innerJoin(cancellations, eq(cancellations.computerId, computers.id))
            .innerJoin(jobs, eq(jobs.id, cancellations.sourceJobId)).innerJoin(deliveries, eq(deliveries.cancellationId, cancellations.id))
            .where(and(due(), inArray(jobs.status, ['queued','running']))).orderBy(asc(deliveries.availableAt), asc(cancellations.id))
            .limit(1).for('update', { of: computers, skipLocked: true });
        if (!candidate) return null;
        const [event] = await tx.update(deliveries).set({ attempts: sql`${deliveries.attempts}+1`, leaseUntil: sql`clock_timestamp()+interval '45 seconds'` })
            .where(and(eq(deliveries.cancellationId, candidate.cancellationId), due())).returning();
        return event ? { ...candidate, attempt: event.attempts } : null;
    }); } catch { throw new LifecycleError('lifecycle_unavailable'); }
}
export async function authorizeCancellation(o: CancellationOptions, input: CancellationAuthorityRequest): Promise<CancellationAuthorityScope | null> {
    if (!o.enabled || !CancellationAuthorityRequestSchema.safeParse(input).success) return null;
    try { return await o.database.transaction(async tx => {
        await cancellationTimeouts(tx);
        const s = await loadCancellation(tx, o, input);
        return s && s.work.digest === input.digest ? s.scope : null;
    }); } catch { throw new LifecycleError('lifecycle_unavailable'); }
}
async function defer(tx: CancellationTransaction, c: CancellationClaim, code: string | null) {
    const [row] = await tx.update(deliveries).set({ leaseUntil: null, availableAt: sql`clock_timestamp()+interval '5 seconds'`, errorCode: code })
        .where(owns(c)).returning();
    return row ? 'waiting' as const : 'stale' as const;
}
async function settle(tx: CancellationTransaction, c: CancellationClaim, jobId: string, code: 'lifecycle_cancelled' | 'lifecycle_recovered') {
    const [job] = await tx.update(jobs).set({ status: 'cancelled', errorCode: code, completedAt: sql`clock_timestamp()` })
        .where(and(eq(jobs.id, jobId), eq(jobs.computerId, c.computerId), inArray(jobs.status, ['queued','running']))).returning();
    const [original] = await tx.update(outbox).set({ deliveredAt: sql`clock_timestamp()`, leaseUntil: null })
        .where(and(eq(outbox.jobId, jobId), eq(outbox.computerId, c.computerId), isNull(outbox.deliveredAt))).returning();
    const [delivery] = await tx.update(deliveries).set({ deliveredAt: sql`clock_timestamp()`, leaseUntil: null, errorCode: null }).where(owns(c)).returning();
    if (!job || !original || !delivery) throw new LifecycleError('lifecycle_unconfirmed');
    return 'cancelled' as const;
}

export async function dispatchCancellation(o: CancellationConsumerOptions, c: CancellationClaim): Promise<'disabled' | 'stale' | 'waiting' | 'cancelled'> {
    if (!o.enabled) return 'disabled';
    try {
        const prepared = await o.database.transaction(async tx => {
            await cancellationTimeouts(tx);
            const s = await loadCancellation(tx, o, c);
            const [event] = await tx.select().from(deliveries).where(owns(c)).limit(1);
            if (!event) return 'stale' as const;
            if (!s) return defer(tx, c, 'lifecycle_conflict');
            if (s.cancellation.source.stateAtRequest === 'queued' && s.intent.operation === 'provision'
                && !s.job.startedAt && s.original.attempts === 0 && !s.original.leaseUntil && !s.runtime.dataVolumeId && s.rows.length === 0) {
                return settle(tx, c, s.job.id, 'lifecycle_cancelled');
            }
            return { work: s.work, source: s.source, scope: s.scope };
        });
        if (typeof prepared === 'string') return prepared;
        let result: Awaited<ReturnType<CancellationConsumerOptions['advance']>> | null = null, code: string | null = null;
        const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            result = await Promise.race([o.advance(prepared.work, prepared.source, prepared.scope, controller.signal),
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new LifecycleError('lifecycle_unconfirmed')); }, 20000); })]);
        } catch (e) { code = e instanceof LifecycleError ? e.code : 'lifecycle_unavailable'; }
        finally { clearTimeout(timer); }
        return await o.database.transaction(async tx => {
            await cancellationTimeouts(tx);
            const s = await loadCancellation(tx, o, c);
            const [event] = await tx.select().from(deliveries).where(owns(c)).limit(1);
            if (!event) return 'stale' as const;
            if (!s || JSON.stringify(s.scope) !== JSON.stringify(prepared.scope)) return defer(tx, c, 'lifecycle_conflict');
            if (!result || result.state === 'pending') return defer(tx, c, code);
            if (!(result.observedAt instanceof Date) || !Number.isFinite(result.observedAt.getTime())) return defer(tx, c, 'lifecycle_unconfirmed');
            const [fresh] = await tx.execute<{ fresh: boolean }>(sql`SELECT ${result.observedAt.toISOString()}::timestamptz
                BETWEEN clock_timestamp()-interval '30 seconds' AND clock_timestamp()+interval '5 seconds' AS fresh`);
            if (!fresh?.fresh) return defer(tx, c, 'lifecycle_unconfirmed');
            const receipt = validateCancellationReceipt(s.work, s.source, result.receipt).source;
            if (s.runtime.dataVolumeId && s.runtime.dataVolumeId !== receipt.volumeId) return defer(tx, c, 'lifecycle_conflict');
            for (const r of receipt.instances) {
                const old = s.rows.find(w => w.generation === r.generation);
                if (old && (old.providerInstanceId !== r.instanceId || old.fenceToken !== r.fenceToken)) return defer(tx, c, 'lifecycle_conflict');
            }
            if (s.rows.some(w => !w.fencedAt && !receipt.instances.some(r => r.instanceId === w.providerInstanceId))) return defer(tx, c, 'lifecycle_unconfirmed');
            for (const r of receipt.instances) {
                const old = s.rows.find(w => w.generation === r.generation);
                if (!old) await tx.insert(computerInstances).values({ computerId: c.computerId, generation: r.generation,
                    providerInstanceId: r.instanceId, fenceToken: r.fenceToken, observedState: 'stopped', observedAt: result.observedAt,
                    fencedAt: sql`clock_timestamp()` });
                else if (!old.fencedAt) await tx.update(computerInstances).set({ observedState: 'stopped', observedAt: result.observedAt, fencedAt: sql`clock_timestamp()` })
                    .where(and(eq(computerInstances.computerId, c.computerId), eq(computerInstances.generation, r.generation)));
            }
            if (receipt.volumeId) await tx.update(computerRuntimes).set({ dataVolumeId: receipt.volumeId,
                availabilityZone: s.intent.deployment.availabilityZone, updatedAt: sql`clock_timestamp()` }).where(eq(computerRuntimes.computerId, c.computerId));
            return settle(tx, c, s.job.id, 'lifecycle_recovered');
        });
    } catch { throw new LifecycleError('lifecycle_unavailable'); }
}
