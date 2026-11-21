/** Durable pool work uses the same immutable input/name and authority as computer work. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { instanceVcpu, type Env } from './aws-config';
import { isExecutionAbsent } from './aws-errors';
import { buildLifecycleWork, LifecycleIntentSchema, readLifecycleDeployments, type LifecycleWork } from './aws-intent';
import { lifecycleExecutionArn, startLifecycleJob, type LifecycleExecutionReader } from './aws-receipts';
import type { LifecycleStarter } from './aws-ec2';
import { ADMISSION_LOCK_NAMESPACE, readPoolMigrationReservations, type PlacementDb, type PlacementExecutor } from './placement';
import { readPoolDemand, poolHostFromRow, POOL_TYPES } from './ready-pool';
import type { PoolDispatchStore } from './aws-pool-replenish';
import { poolGuard } from './aws-pool-errors';
import { parseRebaseJson } from './aws-rebase-json';
import { proveFailedBeforeObservation } from './aws-failed-release-proof';
import { provePoolLaunchDenied } from './aws-pool-provision-failure-proof';
import { PollDeadline } from './poll-wait';
const rows = (r: unknown): Record<string, unknown>[] => Array.isArray(r) ? r : (r as { rows: Record<string, unknown>[] }).rows;
export function storedPoolWork(row: Record<string, unknown>): LifecycleWork {
    const envelope = parseRebaseJson(String(row.lifecycle_input), 20000) as { document: string; digest: string };
    const work = buildLifecycleWork(LifecycleIntentSchema.parse(parseRebaseJson(envelope.document, 16384)));
    poolGuard('dispatch_work_binding', work.input === row.lifecycle_input && work.digest === row.lifecycle_digest
        && work.intent.jobId === row.lifecycle_job_id && work.intent.poolHostId === row.id
        && work.intent.poolGeneration === Number(row.generation) && work.intent.deployment.region === row.region
        && work.intent.deployment.zoneId === row.zone_id && work.intent.instanceType === row.instance_type, 503);
    return work;
}
/** Replays and authority must use current eligibility and the current validated release.
 * A failed/unknown read is a refusal, never permission to discard a reservation. */
async function provisionEligible(db: PlacementExecutor, work: LifecycleWork, env: Env): Promise<boolean> {
    try {
        if (env.EZIL_AWS_KILL_SWITCH === '1') return false;
        const i=work.intent, configs=readLifecycleDeployments(env,[i.deployment.region]);
        if (!configs.ok) return false;
        const deployment=configs.deployments[i.deployment.region];
        if (!deployment || buildLifecycleWork({...i,deployment}).input !== work.input) return false;
        const demand=await readPoolDemand(db,{region:deployment.region,zoneId:deployment.zoneId,
            instanceType:i.instanceType as typeof POOL_TYPES[number],deployment},new Date());
        return !demand.killSwitch && demand.activeStandard+demand.activePremium>0;
    } catch { return false; }
}
export async function poolJobAuthority(db: PlacementExecutor, a: { computerId: string; jobId: string; digest: string;
    leaseEpoch: number; poolHostId: string; poolGeneration: number; operation: string }, env: Env): Promise<boolean> {
    const found = rows(await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts WHERE id = ${a.poolHostId}::uuid`));
    if (found.length !== 1) return false;
    const row = found[0]!;
    const w = storedPoolWork(row), i = w.intent;
    return a.computerId === i.computerId && a.jobId === i.jobId && a.digest === w.digest
        && a.leaseEpoch === i.leaseEpoch && a.poolGeneration === i.poolGeneration && a.operation === i.operation
        && (a.operation === 'pool-provision' ? row.state === 'booting' && env.EZIL_AWS_KILL_SWITCH !== '1'
            : a.operation === 'pool-retire' && row.state === 'retiring' && row.instance_id === i.providerInstanceId)
        && row.leased_computer_id === null
        && (i.operation !== 'pool-provision' || await provisionEligible(db,w,env));
}
/** How long after a FAILED execution stopped an unreadable history keeps its row unsettled for another proof attempt.
 * Reconcile runs on each pool-replenish pass (staging timer: every minute, deploy/aws/os-staging/cron), so this is
 * many retries; past it the row settles `failed` and cannot starve the window. */
export const HISTORY_RETRY_MS = 15 * 60_000;
const LAUNCH_STATES = new Set(['runInstances', 'runBurstableInstances']);
/** `proven` only when the complete history proves EC2 created nothing for this job. The lifecycle helper never mutates,
 * and every provider call is its own later task state, so either:
 * - the graph entered no task state other than `Observe-initial` (the 1.0.16/1.0.26 lifecycle_invalid failures), or
 * - it entered exactly Observe-initial, one launch, Observe-instance and ended in `Refused`: the helper refuses only
 *   on a capacity or quota error from the previous EC2 task, a definite refusal that created nothing (infra errors.ts C-3).
 * An unexpected history is `unproven` (the row stays `failed`); a read failure is `unread` so the caller may retry. */
export async function neverLaunched(executions: LifecycleExecutionReader, region: string, executionArn: string): Promise<'proven' | 'unproven' | 'unread'> {
    if (!executions.history) return 'unproven';
    let events;
    try { events = await executions.history(region, executionArn); } catch { return 'unread'; }
    const entered = events.filter(e => e.type === 'TaskStateEntered').map(e => e.stateEnteredEventDetails?.name);
    const failed = events.filter(e => e.type === 'ExecutionFailed').at(-1);
    if (!failed || entered.length === 0) return 'unproven';
    if (entered.every(name => name === 'Observe-initial')) return 'proven';
    return failed.executionFailedEventDetails?.error === 'LifecycleRefused' && entered.length === 3
        && entered[0] === 'Observe-initial' && LAUNCH_STATES.has(entered[1] ?? '') && entered[2] === 'Observe-instance'
        ? 'proven' : 'unproven';
}

// Both the inventory and the final CAS exclude any instance, enrollment or lease evidence.
const UNBOUND_FAILED_PROVISION = sql`state = 'failed' AND dispatch_status = 'settled'
    AND instance_id IS NULL AND enrolled_at IS NULL AND ready_at IS NULL AND editor_ready_at IS NULL AND session_ready_at IS NULL
    AND leased_computer_id IS NULL AND leased_generation IS NULL AND lease_token IS NULL AND leased_at IS NULL
    AND claim_generation IS NULL AND claim_lease_epoch IS NULL AND claim_fence IS NULL AND claim_volume_serial IS NULL`;

const SETTLED_PROOF_ATTEMPT_MS = 2_000;
async function retireUnlaunchedSettledProvisions(db: PlacementDb, executions: LifecycleExecutionReader, before: string,
    deadline: PollDeadline): Promise<void> {
    const readHistory = executions.history;
    if (!readHistory) return;
    // Give later rows a chance even if some histories are permanently unreadable. Newly settled work waits for the next pass.
    let failed;
    try {
        failed = rows(await deadline.read(() => db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts
            WHERE ${UNBOUND_FAILED_PROVISION} AND updated_at < ${before}::timestamptz
                AND lifecycle_job_id IS NOT NULL AND lifecycle_digest IS NOT NULL AND lifecycle_input IS NOT NULL
            ORDER BY random() LIMIT 8`)));
    } catch { return; }
    for (const row of failed) {
        const budget = Math.min(deadline.remaining(), SETTLED_PROOF_ATTEMPT_MS);
        if (budget <= 0) break;
        // The SDK receives cancellation as well as the caller's hard elapsed deadline.
        const abort = new AbortController();
        const attempt = new PollDeadline(budget, abort.signal);
        const timer = setTimeout(() => abort.abort(), budget);
        let work: LifecycleWork;
        try {
            work = storedPoolWork(row);
            const i = work.intent;
            if (i.operation !== 'pool-provision' || i.providerInstanceId !== null || i.dataVolumeId !== null) continue;
            const region = i.deployment.region;
            const arn = lifecycleExecutionArn(i.deployment, i.jobId);
            const execution = await attempt.read(() => executions.describe(region, arn, abort.signal));
            if (execution.status !== 'FAILED' || execution.executionArn !== arn || execution.input !== work.input
                || execution.stateMachineVersionArn !== work.stateMachineArn || execution.stateMachineAliasArn
                || execution.redriveCount !== 0) continue;
            const history = await attempt.read(() => readHistory.call(executions, region, arn, abort.signal));
            if (!proveFailedBeforeObservation(execution, history, work) && !provePoolLaunchDenied(execution, history, work)) continue;
            deadline.check();
        } catch {
            // A missing execution, malformed stored work or incomplete provider read does not release capacity.
            continue;
        } finally {
            clearTimeout(timer);
            abort.abort();
        }
        const i = work.intent;
        await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'retired', updated_at = now()
            WHERE id = ${i.poolHostId}::uuid AND generation = ${i.poolGeneration}
                AND region = ${i.deployment.region} AND zone_id = ${i.deployment.zoneId} AND instance_type = ${i.instanceType}
                AND lifecycle_job_id = ${i.jobId}::uuid AND lifecycle_digest = ${work.digest} AND lifecycle_input = ${work.input}
                AND ${UNBOUND_FAILED_PROVISION}`);
    }
}

export function createPoolDispatchStore(db: PlacementDb, env: Env,
    sdk: { starter?: LifecycleStarter; executions?: LifecycleExecutionReader }): PoolDispatchStore {
    const store: PoolDispatchStore = {
        async prepare(tx, c, operation, build, candidate) {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${ADMISSION_LOCK_NAMESPACE}::int4, 0)`);
            let host = candidate;
            if (operation === 'pool-provision') {
                const demand = await readPoolDemand(tx, c, new Date());
                // Pending migrations have no regional placement yet: reserve conservatively in each region.
                const migrations = await readPoolMigrationReservations(tx);
                poolGuard('dispatch_capacity', env.EZIL_AWS_KILL_SWITCH !== '1' && !demand.killSwitch
                    && demand.activeStandard + demand.activePremium > 0
                    && c.region === 'ap-south-1' && POOL_TYPES.includes(c.instanceType)
                    && Number.isSafeInteger(migrations) && migrations >= 0
                    && demand.vcpuInUse + (demand.demandVcpu ?? 0) + migrations * 2 + instanceVcpu(c.instanceType) <= demand.regionVcpuCap, 503);
                const id = randomUUID();
                const inserted = rows(await tx.execute(sql`INSERT INTO public.ezil_compute_pool_hosts
                    (id, generation, region, zone_id, instance_type, state, health, created_at, updated_at)
                    VALUES (${id}::uuid, 1, ${c.region}, ${c.zoneId}, ${c.instanceType}, 'booting', 'unknown', now(), now()) RETURNING *`));
                poolGuard('dispatch_reserved', inserted.length === 1, 503);
                host = poolHostFromRow(inserted[0]!);
            }
            poolGuard('dispatch_host', host && host.state === (operation === 'pool-provision' ? 'booting' : 'retiring')
                && host.leasedComputerId === null && (operation !== 'pool-retire' || host.instanceId), 503);
            const work = build(host);
            poolGuard('dispatch_operation', work.intent.operation === operation && work.intent.poolHostId === host.poolHostId
                && work.intent.poolGeneration === host.poolGeneration, 503);
            const saved = rows(await tx.execute(sql`UPDATE public.ezil_compute_pool_hosts SET
                lifecycle_job_id = ${work.intent.jobId}::uuid, lifecycle_digest = ${work.digest}, lifecycle_input = ${work.input},
                dispatch_status = 'pending', updated_at = now()
                WHERE id = ${host.poolHostId}::uuid AND generation = ${host.poolGeneration} AND state = ${host.state}
                  AND leased_computer_id IS NULL AND (lifecycle_job_id IS NULL OR dispatch_status = 'settled') RETURNING id`));
            poolGuard('dispatch_saved', saved.length === 1, 503);
            return work;
        },
        async outcome(work, outcome) {
            await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET dispatch_status = ${outcome === 'refused' ? 'settled' : outcome},
                state = CASE WHEN ${outcome} = 'refused' THEN CASE WHEN ${work.intent.operation} = 'pool-provision' THEN 'retired' ELSE 'failed' END ELSE state END,
                updated_at = now() WHERE id = ${work.intent.poolHostId}::uuid AND lifecycle_job_id = ${work.intent.jobId}::uuid
                AND lifecycle_digest = ${work.digest} AND dispatch_status IN ('pending', 'unknown', 'started')`);
        },
        async reconcile() {
            if (!sdk.executions || !sdk.starter) return;
            const pending = rows(await db.execute(sql`SELECT * FROM public.ezil_compute_pool_hosts
                WHERE dispatch_status IN ('pending', 'unknown', 'started') ORDER BY created_at LIMIT 32`));
            for (const row of pending) {
                const work = storedPoolWork(row), i = work.intent;
                const arn = lifecycleExecutionArn(i.deployment, i.jobId);
                let execution;
                try { execution = await sdk.executions.describe(i.deployment.region, arn); }
                catch (error) {
                    if (isExecutionAbsent(error)) {
                        if (i.operation === 'pool-provision' && !await poolJobAuthority(db,{
                            computerId:i.computerId,jobId:i.jobId,digest:work.digest,leaseEpoch:i.leaseEpoch,
                            poolHostId:i.poolHostId!,poolGeneration:i.poolGeneration!,operation:i.operation,
                        },env).catch(()=>false)) continue;
                        await store.outcome(work, await startLifecycleJob(sdk.starter, i.deployment.region, work));
                    }
                    continue;
                }
                poolGuard('dispatch_execution', execution.executionArn === arn && execution.input === work.input
                    && execution.stateMachineVersionArn === work.stateMachineArn && !execution.stateMachineAliasArn, 503);
                if (execution.status === 'RUNNING') continue;
                if (execution.status === 'SUCCEEDED') {
                    const r = parseRebaseJson(execution.output ?? '', 16384) as Record<string, unknown>;
                    poolGuard('dispatch_receipt', r.schemaVersion === 1 && r.jobId === i.jobId && r.digest === work.digest
                        && r.computerId === i.computerId && r.generation === i.targetGeneration && r.leaseEpoch === i.leaseEpoch
                        && r.fenceToken === i.fenceToken && r.poolHostId === i.poolHostId && r.poolGeneration === i.poolGeneration
                        && r.volumeId === null && typeof r.instanceId === 'string' && /^i-[a-f0-9]{17}$/.test(r.instanceId)
                        && (row.instance_id === null || row.instance_id === r.instanceId)
                        && (i.providerInstanceId === null || i.providerInstanceId === r.instanceId)
                        && r.state === (i.operation === 'pool-retire' ? 'retired' : 'running'), 503);
                    await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET instance_id = ${r.instanceId as string},
                        state = CASE WHEN ${i.operation} = 'pool-retire' THEN 'retired' ELSE state END,
                        dispatch_status = 'settled', updated_at = now() WHERE id = ${i.poolHostId}::uuid
                        AND lifecycle_job_id = ${i.jobId}::uuid AND lifecycle_digest = ${work.digest}`);
                } else if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status)) {
                    // A failed execution may have launched. Keep consuming capacity until its bound instance is retired,
                    // unless its history proves EC2 created nothing (see neverLaunched): then a failed row would hold
                    // phantom vCPU against the region cap forever (every 1.0.26 pool-provision failed at Observe-initial).
                    // A pool-retire never qualifies: its instance exists until the retire succeeds.
                    let settled: 'retired' | 'failed' = 'failed';
                    if (i.operation === 'pool-provision' && execution.status === 'FAILED') {
                        const proof = await neverLaunched(sdk.executions, i.deployment.region, arn);
                        // An unreadable history is retried on later passes, bounded by the stop time.
                        if (proof === 'unread' && execution.stopDate && Date.now() - execution.stopDate.getTime() < HISTORY_RETRY_MS) continue;
                        if (proof === 'proven') settled = 'retired';
                    }
                    await db.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = ${settled}, dispatch_status = 'settled', updated_at = now()
                        WHERE id = ${i.poolHostId}::uuid AND lifecycle_job_id = ${i.jobId}::uuid AND lifecycle_digest = ${work.digest}
                        AND leased_computer_id IS NULL`);
                }
            }
        },
        async reconcileSettledFailures(before, budget) {
            if (sdk.executions && budget > 0) {
                await retireUnlaunchedSettledProvisions(db, sdk.executions, before.toISOString(), new PollDeadline(budget));
            }
        },
        async canRetire(tx, id) {
            const found = rows(await tx.execute(sql`SELECT instance_id, lifecycle_job_id, dispatch_status FROM public.ezil_compute_pool_hosts
                WHERE id = ${id}::uuid AND leased_computer_id IS NULL
                    AND claim_generation IS NULL AND claim_lease_epoch IS NULL AND claim_fence IS NULL AND claim_volume_serial IS NULL
                FOR UPDATE`));
            return found.length === 1 && found[0]!.instance_id !== null
                && (found[0]!.lifecycle_job_id === null || found[0]!.dispatch_status === 'settled');
        },
        async retirementCandidates(tx, c, state) {
            return rows(await tx.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
                WHERE region = ${c.region} AND zone_id = ${c.zoneId} AND instance_type = ${c.instanceType}
                    AND leased_computer_id IS NULL
                    AND state = ${state} AND claim_generation IS NULL AND claim_lease_epoch IS NULL
                    AND claim_fence IS NULL AND claim_volume_serial IS NULL
                    AND instance_id IS NOT NULL AND (lifecycle_job_id IS NULL OR dispatch_status = 'settled')
                ORDER BY created_at, id`)).map(r => String(r.id));
        },
    };
    return store;
}
