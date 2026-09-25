import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { computers, computerRuntimes, computerInstances, computerLifecycleIntents as intents,
    computerLifecycleJobs as jobs, computerLifecycleOutbox as outbox } from '@/server/db/schema';
import { canonicalConfiguration } from './computer-configuration';
import { hasCurrentOsAccess, type OsAccessMode } from './runtime-authority';
import { LifecycleAuthorityRequestSchema } from './lifecycle-authority-protocol';
import { LifecycleDeploymentSchema, LifecycleError, parseLifecycleWork, validateLifecycleReceipt,
    type LifecycleDeployment, type LifecycleIntent, type LifecycleReceipt, type LifecycleWork } from './lifecycle-protocol';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export interface LifecycleClaim { computerId: string; jobId: string; attempt: number }
export interface LifecycleConsumerOptions {
    database: typeof db; enabled: boolean; osAccessMode: OsAccessMode;
    /** Operator configuration, never a submitted manifest. Empty denies new work.
     * Keep historical entries available for observation and safe cleanup. */
    deployments: readonly LifecycleDeployment[];
    /** Submission/observation of the same version-pinned Standard execution.
     * A false allowStart permits observation only, including after revocation. */
    advance(work: LifecycleWork, allowStart: boolean, signal: AbortSignal): Promise<
        { state: 'pending' } | { state: 'observed'; receipt: LifecycleReceipt; observedAt: Date }>;
}
type BaseOptions = Omit<LifecycleConsumerOptions, 'advance'>;
const active = ['queued', 'running'] as const;
const starts = (i: LifecycleIntent) => ['provision', 'start', 'replace'].includes(i.operation);
const owns = (c: LifecycleClaim) => and(eq(outbox.jobId, c.jobId), eq(outbox.computerId, c.computerId),
    eq(outbox.attempts, c.attempt), isNull(outbox.deliveredAt), sql`${outbox.leaseUntil} > clock_timestamp()`);
const due = () => and(isNull(outbox.deliveredAt), sql`${outbox.availableAt} <= clock_timestamp()`,
    sql`(${outbox.leaseUntil} is null or ${outbox.leaseUntil} <= clock_timestamp())`, sql`${outbox.attempts} < 2147483647`);
async function timeouts(tx: Transaction) {
    await tx.execute(sql`set local lock_timeout = '2000ms'`);
    await tx.execute(sql`set local statement_timeout = '5000ms'`);
}

/** Claim an existing immutable intent, never synthesize one from a browser job.
 * Attempt numbers fence acknowledgments; they are not provider idempotency keys. */
export async function claimLifecycleWork(o: BaseOptions): Promise<LifecycleClaim | null> {
    if (!o.enabled) return null;
    try { return await o.database.transaction(async tx => {
        await timeouts(tx);
        const [candidate] = await tx.select({ computerId: computers.id, jobId: jobs.id }).from(computers)
            .innerJoin(jobs, eq(jobs.computerId, computers.id)).innerJoin(intents, eq(intents.jobId, jobs.id))
            .innerJoin(outbox, eq(outbox.jobId, jobs.id)).where(and(due(), inArray(jobs.status, active)))
            .orderBy(asc(outbox.availableAt), asc(jobs.id)).limit(1).for('update', { of: computers, skipLocked: true });
        if (!candidate) return null;
        const [event] = await tx.update(outbox).set({ attempts: sql`${outbox.attempts} + 1`,
            leaseUntil: sql`clock_timestamp() + interval '45 seconds'` })
            .where(and(eq(outbox.jobId, candidate.jobId), due())).returning();
        return event ? { ...candidate, attempt: event.attempts } : null;
    }); } catch { throw new LifecycleError('lifecycle_unavailable'); }
}

async function load(tx: Transaction, c: Pick<LifecycleClaim, 'computerId' | 'jobId'>) {
    const [computer] = await tx.select().from(computers).where(eq(computers.id, c.computerId)).limit(1).for('update');
    const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, c.computerId)).limit(1).for('update');
    const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, c.jobId), eq(jobs.computerId, c.computerId))).limit(1).for('update');
    const [row] = await tx.select({ digest: intents.digest, createdAt: intents.createdAt,
        document: sql<string>`public.ezil_lifecycle_intent_document(${intents})` })
        .from(intents).where(and(eq(intents.jobId, c.jobId), eq(intents.computerId, c.computerId))).limit(1);
    if (!computer || !runtime || !job || !row || !active.includes(job.status as typeof active[number])) return null;
    const intent = parseLifecycleWork(row);
    const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, c.computerId),
        isNull(computerInstances.fencedAt))).limit(1).for('update');
    // Immutable schema protects this identity too; check it at the consuming boundary.
    if (intent.jobId !== job.id || intent.computerId !== computer.id || intent.operation !== job.operation
        || intent.targetGeneration !== job.targetGeneration || computer.provider !== 'aws-ec2'
        || runtime.region !== intent.deployment.region
        || (runtime.availabilityZone !== null && runtime.availabilityZone !== intent.deployment.availabilityZone)) return null;
    const existing = intent.operation !== 'provision';
    if (existing && (runtime.dataVolumeId !== intent.dataVolumeId || !writer
        || writer.generation !== (intent.previousGeneration ?? intent.targetGeneration)
        || writer.providerInstanceId !== (intent.previousInstanceId ?? intent.providerInstanceId)
        || writer.fenceToken !== (intent.previousFenceToken ?? intent.fenceToken))) return null;
    if (!existing && (runtime.dataVolumeId !== null || writer)) return null;
    return { computer, runtime, job, work: row, intent, writer };
}
type Loaded = NonNullable<Awaited<ReturnType<typeof load>>>;
async function allowed(tx: Transaction, o: BaseOptions, s: Loaded) {
    if (!o.deployments.some(d => LifecycleDeploymentSchema.safeParse(d).success
        && canonicalConfiguration(d) === canonicalConfiguration(s.intent.deployment))) return false;
    const desired = s.intent.operation === 'retire' ? 'retired' : starts(s.intent) ? 'running' : 'stopped';
    if (s.runtime.desiredState !== desired) return false;
    // A trusted stop/retire intent remains usable after owner access revocation.
    if (!starts(s.intent)) return true;
    return !s.computer.deletedAt && s.job.requestedBy === s.computer.userId
        && await hasCurrentOsAccess(tx, s.computer.userId, o.osAccessMode);
}
async function defer(tx: Transaction, c: LifecycleClaim, code: string | null) {
    const [event] = await tx.update(outbox).set({ leaseUntil: null, availableAt: sql`clock_timestamp() + interval '5 seconds'` })
        .where(owns(c)).returning();
    if (!event) return 'stale' as const;
    await tx.update(jobs).set({ errorCode: code }).where(and(eq(jobs.id, c.jobId), inArray(jobs.status, active)));
    return 'waiting' as const;
}

/** The workflow calls this before mutations. Input names only an immutable
 * intent; a separately authenticated internal handler must guard this function.
 * The two-computer pilot reservation is the RUNNING lifecycle job itself. */
export async function authorizeLifecycleWork(o: BaseOptions, input: { computerId: string; jobId: string; digest: string }): Promise<boolean> {
    if (!o.enabled || !LifecycleAuthorityRequestSchema.safeParse({ schemaVersion: 1, ...input }).success) return false;
    try { return await o.database.transaction(async tx => {
        await timeouts(tx);
        const s = await load(tx, input);
        return Boolean(s && s.job.status === 'running' && s.work.digest === input.digest && await allowed(tx, o, s));
    }); } catch { throw new LifecycleError('lifecycle_unavailable'); }
}

/** No provider call runs while a database lock is held. Duplicate deliveries
 * use the same Standard execution; stale workers cannot write a receipt. */
export async function dispatchLifecycleClaim(o: LifecycleConsumerOptions, c: LifecycleClaim): Promise<'disabled' | 'stale' | 'waiting' | 'succeeded'> {
    if (!o.enabled) return 'disabled';
    try {
        const prepared = await o.database.transaction(async tx => {
            await timeouts(tx);
            // All admitting consumers take this before any computer lock.
            await tx.execute(sql`SELECT pg_advisory_xact_lock(73124, 1)`);
            const s = await load(tx, c);
            const [event] = await tx.select().from(outbox).where(owns(c)).limit(1).for('update');
            if (!s || !event) return 'stale' as const;
            const canStart = await allowed(tx, o, s);
            if (s.job.status === 'queued') {
                if (!canStart) return defer(tx, c, 'lifecycle_authority_denied');
                if (starts(s.intent)) {
                    // Retain uncertain, unobserved and expired-lease work in admission.
                    const held = await tx.execute<{ count: number }>(sql`SELECT count(DISTINCT computer_id)::int AS count FROM (
                        SELECT computer_id FROM ${computerInstances} WHERE fenced_at IS NULL AND observed_state <> 'stopped'
                        UNION SELECT computer_id FROM ${jobs} WHERE status='running' AND operation IN ('provision','start','replace')
                    ) reservations WHERE computer_id <> ${c.computerId}`);
                    if ((held[0]?.count ?? 2) >= 2) return defer(tx, c, 'lifecycle_capacity');
                }
                await tx.update(jobs).set({ status: 'running', startedAt: sql`clock_timestamp()`, errorCode: null }).where(eq(jobs.id, c.jobId));
            }
            return { work: s.work, canStart };
        });
        if (typeof prepared === 'string') return prepared;
        let result: Awaited<ReturnType<LifecycleConsumerOptions['advance']>> | null = null;
        let errorCode: string | null = null;
        try {
            // Promise deadline also bounds an adapter which ignores AbortSignal.
            const controller = new AbortController();
            let timer: ReturnType<typeof setTimeout> | undefined;
            try { result = await Promise.race([o.advance(prepared.work, prepared.canStart, controller.signal),
                new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
                    controller.abort(); reject(new LifecycleError('lifecycle_unconfirmed'));
                }, 20000); })]); } finally { clearTimeout(timer); }
        } catch (e) { errorCode = e instanceof LifecycleError ? e.code : 'lifecycle_unavailable'; }
        return await o.database.transaction(async tx => {
            await timeouts(tx);
            const s = await load(tx, c);
            const [event] = await tx.select().from(outbox).where(owns(c)).limit(1).for('update');
            if (!s || !event) return 'stale' as const;
            if (!result || result.state !== 'observed') return defer(tx, c, errorCode);
            const receipt = validateLifecycleReceipt(s.work, result.receipt);
            if (!(result.observedAt instanceof Date) || !Number.isFinite(result.observedAt.getTime())) {
                return defer(tx, c, 'lifecycle_unconfirmed');
            }
            const fresh = await tx.execute<{ fresh: boolean }>(sql`SELECT ${result.observedAt.toISOString()}::timestamptz
                BETWEEN clock_timestamp() - interval '30 seconds' AND clock_timestamp() + interval '5 seconds' AS fresh`);
            if (!fresh[0]?.fresh) return defer(tx, c, 'lifecycle_unconfirmed');
            // Do not certify a superseded start as successful. Its reservation
            // remains held for workflow cancellation/reconciliation.
            if (starts(s.intent) && !await allowed(tx, o, s)) return defer(tx, c, 'lifecycle_authority_denied');
            if (s.intent.operation === 'replace') {
                // The concrete adapter separately observed old instance TERMINATED
                // and the preserved disk attached only to this generation.
                await tx.update(computerInstances).set({ fencedAt: sql`clock_timestamp()`, observedState: 'stopped', observedAt: result.observedAt })
                    .where(and(eq(computerInstances.computerId, c.computerId), eq(computerInstances.generation, s.intent.previousGeneration!)));
            }
            if (s.intent.operation === 'provision' || s.intent.operation === 'replace') {
                await tx.update(computerRuntimes).set({ dataVolumeId: receipt.volumeId,
                    availabilityZone: s.intent.deployment.availabilityZone, updatedAt: sql`clock_timestamp()` })
                    .where(eq(computerRuntimes.computerId, c.computerId));
                await tx.insert(computerInstances).values({ computerId: c.computerId, generation: receipt.generation,
                    providerInstanceId: receipt.instanceId, fenceToken: receipt.fenceToken,
                    observedState: 'running', observedAt: result.observedAt });
            } else {
                await tx.update(computerInstances).set({ observedState: receipt.state === 'running' ? 'running' : 'stopped',
                    observedAt: result.observedAt, ...(receipt.state === 'retired' ? { fencedAt: sql`clock_timestamp()` } : {}) })
                    .where(and(eq(computerInstances.computerId, c.computerId), eq(computerInstances.generation, receipt.generation)));
            }
            await tx.update(jobs).set({ status: 'succeeded', errorCode: null, completedAt: sql`clock_timestamp()` }).where(eq(jobs.id, c.jobId));
            const [ack] = await tx.update(outbox).set({ deliveredAt: sql`clock_timestamp()`, leaseUntil: null }).where(owns(c)).returning();
            // Lease expiry during the transaction rolls back every state change.
            if (!ack) throw new LifecycleError('lifecycle_unconfirmed');
            return 'succeeded' as const;
        });
    } catch { throw new LifecycleError('lifecycle_unavailable'); }
}
