import { reconcilePoolReleaseRecovery } from './aws-pool-release-recovery';
import { failStalledPoolAdopt, reconcileStalledPoolAdopt, replaceStalledPoolAdopt } from './aws-pool-adopt-stall';
import { replacementNeverLaunched, replacementWorkFromExecution, settleReplacementGeneration } from './aws-rebase-generation';
import { failPoolOpenRelease, isPoolOpenRelease, POOL_OPEN_RELEASE_FAILED, recoverRefusedAdopt } from './aws-pool-recovery';
import { createProviderMigrationStore } from './provider-migrate-store';
/**
 * Lifecycle receipts: the RECONCILER path (docs/AWS-COMPUTERS.md C-3).
 *
 * Applies the outcome of a placement's CURRENT lifecycle job, read from Step
 * Functions (`DescribeExecution`, injected), to the placement through
 * `transitionPlacementAsReconciler` (no owner predicate: the outcome is AWS's,
 * not a user's request). User-facing modules never name that entry
 * (placement.test.ts scans them); the provider calls `applyLifecycleReceipt`
 * only for a placement whose owner it already checked, and a scheduled
 * reconciler may call it for any placement.
 */

import { createHash, randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import type { EpochEndReason } from '@/server/billing/v2/contract';
import type { Ec2ComputerResourceFinder, Ec2VolumeDescriber, Ec2ReplacementDescriber } from './aws-clients';
import { AWS_TIERS, isAwsComputersEnabled, readAwsAdmissionConfig, readAwsRegions, meteredSizeForInstanceType, type AwsAdmissionCaps, type AwsTier, type Env } from './aws-config';
import type { LifecycleStarter } from './aws-ec2';
import { awsSandboxId, type Ec2EnrollmentDescriber, type TunnelClient } from './aws-enroll';
import { isExecutionAbsent, toAwsClientError } from './aws-errors';
import { buildLifecycleWork, currentGenerationIntent, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleDeployment, type LifecycleIntent, type LifecycleWork } from './aws-intent';
import {
    ENROLLMENT_SUCCEEDED,
    failUnenrolledPlacement,
    INSTANCE_LOST,
    INSTANCE_LOST_VOLUME_MISSING,
    LIFECYCLE_START_FAILED,
    lifecycleStartUnknownUndo,
    markLifecycleStartUnknown,
    claimAwsPlacementsPendingRetire,
    claimAwsPlacementsToReconcile,
    PlacementIntegrityError,
    ImageJobConflictError,
    readCanaryComputer,
    RELEASED_NO_RESOURCES,
    readMonthUsage,
    readPlacement,
    publishAttachedPoolClaim,
    type PlacementExecutor,
    transitionPlacementAsReconciler,
    type Placement,
    type PlacementDb,
    type PlacementFields,
    type PlacementState,
    type UsageEffect,
} from './placement';
import { usageFor, utcMonthStart, type MonthUsage } from './usage';

/** Read-only `DescribeExecution` in the placement's region (Step Functions). */
export interface LifecycleExecutionReader {
    /** Complete, bounded execution history, read with the same regional caller. */
    history?(region: string, executionArn: string): Promise<import("@aws-sdk/client-sfn").HistoryEvent[]>;
    describe(
        region: string,
        executionArn: string,
    ): Promise<{ status: string; output?: string | null; error?: string | null; cause?: string | null; startDate?: Date | null; stopDate?: Date | null; input?: string; executionArn?: string; stateMachineVersionArn?: string; stateMachineAliasArn?: string; redriveCount?: number }>;
}

/** Who recorded a usage row (`observed_by`). */
export const USAGE_OBSERVER = 'lifecycle-receipt';

/** `arn:aws:states:<region>:<account>:execution:<machine>:computer-<jobId>`: executions live under the machine, not the version. */
export function lifecycleExecutionArn(d: LifecycleDeployment, jobId: string): string {
    const machine = d.stateMachineVersionArn.slice(0, d.stateMachineVersionArn.lastIndexOf(':')).split(':').at(-1) ?? '';
    return `arn:aws:states:${d.region}:${d.accountId}:execution:${machine}:computer-${jobId}`;
}

/** Infra `LifecycleReceiptSchema` (intent.ts): the workflow's success output. */
export const LifecycleReceiptSchema = z
    .object({
        schemaVersion: z.literal(1),
        jobId: z.string().regex(/^[a-f0-9-]{36}$/),
        digest: z.string().regex(/^[a-f0-9]{64}$/),
        computerId: z.string().regex(/^[a-f0-9-]{36}$/),
        generation: z.number().int().min(1),
        leaseEpoch: z.number().int().min(1),
        fenceToken: z.string().regex(/^[a-f0-9-]{36}$/),
        instanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
        volumeId: z.string().regex(/^vol-[a-f0-9]{17}$/),
        state: z.enum(['running', 'stopped', 'retired']),
        /** Infra: only on `stopped` — the instance was already gone; the next wake must REPLACE. */
        instanceLost: z.literal(true).optional(),
    })
    .strict()
    .refine((r) => !r.instanceLost || r.state === 'stopped', { message: 'instance_lost_on_stop_only' });

/** Infra `CAPACITY_CODES` (lifecycle/errors.ts): a definite refusal, EC2 created nothing for that request. */
export const LIFECYCLE_CAPACITY_CODES: readonly string[] = [
    'InsufficientInstanceCapacity', 'VcpuLimitExceeded', 'InstanceLimitExceeded', 'InsufficientVolumeCapacity', 'VolumeLimitExceeded', 'MaxIOPSLimitExceeded',
];

/** `capacity:<code>:<instanceType>` for a capacity refusal, else `failed:<error>`; recorded as `last_error`. */
export function lifecycleFailureCode(e: { status: string; error?: string | null; cause?: string | null }, instanceType: string | null): string {
    const cause = (e.cause ?? '').trim();
    if (e.error === 'LifecycleRefused' && LIFECYCLE_CAPACITY_CODES.includes(cause)) return `capacity:${cause}:${instanceType ?? 'unknown'}`;
    const err = (e.error ?? e.status).replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 64) || 'unknown';
    return `failed:${err}`;
}

/**
 * The tier's next instance type after a capacity refusal of `failedType`
 * (free: t3a.medium → t3.medium), or null when the tier has no other type.
 * 🔴 Not used by ensure yet: re-provisioning or re-replacing after a capacity
 * refusal needs the infra recovery to prove nothing was launched and to keep
 * the volume's previous generation tags (LIFECYCLE.md, "Capacity refusals and
 * recovery", future work). Until then a refused computer stays UNCONFIRMED and
 * answers `capacity_unavailable`.
 */
export function nextInstanceTypeAfterCapacity(tier: AwsTier, failedType: string): string | null {
    const types = AWS_TIERS[tier] as readonly string[];
    const i = types.indexOf(failedType);
    return i >= 0 && i + 1 < types.length ? types[i + 1]! : null;
}

export type { PoolClass, PoolHostRow } from './ready-pool';
import type { PoolClass } from './ready-pool';
export interface PoolDeps {
    readyAt?: typeof import('./ready-pool').readPoolSessionReadyAt;
    /** Throws PoolCapacityPressure when only capacity refuses; consumes the computer's own demand once it fits. */
    validateCapacity?(tx: PlacementExecutor, p: Placement, lock: import('./placement').AdmissionLock,
        own?: import('./capacity-demand').CapacityDemand | null): Promise<void>;
    /** Lock this computer's active demand and return it only if live (DB clock) and bound to this exact open. */
    claimDemand?(tx: PlacementExecutor, p: Placement, lock: import('./placement').AdmissionLock,
        binding: { kind: 'create' | 'wake'; source: { generation: number; leaseEpoch: number } | null; deploymentDigest: string }): Promise<import('./capacity-demand').CapacityDemand | null>;
    /** After a PoolCapacityPressure rollback: reserve durable demand, or report why not (never launches). */
    reserveDemand?(request: import('./aws-pool-demand').DemandRequest): Promise<import('./aws-pool-demand').DemandOutcome>;
    leasePoolHost: typeof import('./ready-pool').leasePoolHost;
    retireLease?: typeof import('./ready-pool').retirePoolLease;
    publishPoolClaim: typeof import('./ready-pool').publishPoolClaim;
    buildWork: typeof buildLifecycleWork;
    replenish(c: PoolClass, now: Date): Promise<void>;
}

/** No deployment pool flag exists in v1. No new environment variable. */
export function isPoolMode(deployment: Pick<LifecycleDeployment, 'region' | 'namespace'>): boolean {
    return deployment.region === 'ap-south-1' && deployment.namespace === 'mum';
}
export const POOL_RELEASED = 'pool_released';

export function sessionEndWork(p: Placement, deployment: LifecycleDeployment, jobId: string,
    pool?: PoolDeps): LifecycleWork {
    const intent = currentGenerationIntent(p, 'stop', deployment, { jobId, userData: null, leaseEpoch: p.leaseEpoch });
    if (!isPoolMode(deployment)) return buildLifecycleWork(intent);
    if (!pool) throw new LifecycleIntentInvalidError();
    return pool.buildWork({ ...intent, operation: 'release' });
}

/** Only the execution's digest-bound input identifies a pool operation. */
function executionIntent(input: string | undefined, digest: string): LifecycleIntent | null {
    try {
        const envelope = JSON.parse(input ?? '');
        if (envelope.digest !== digest || createHash('sha256').update(envelope.document).digest('hex') !== digest) return null;
        const intent = JSON.parse(envelope.document);
        if (['provision', 'replace', 'start', 'stop', 'retire', 'release'].includes(intent.operation)
            || (intent.operation === 'adopt' && /^[a-f0-9-]{36}$/.test(intent.poolHostId))) return intent;
    } catch { /* Missing or malformed execution input supplies no authority. */ }
    return null;
}

export interface ReceiptDeps {
    pool?: PoolDeps;
    db: PlacementDb;
    meter?: ComputeMeter;
    now?: () => Date;
    describer?: Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'> & Partial<Ec2VolumeDescriber & Ec2ReplacementDescriber & Ec2ComputerResourceFinder>;
    /** Without it nothing is read and nothing changes. */
    executions?: LifecycleExecutionReader;
    /** GW-1, to fence (delete) a stopped generation's tunnel. */
    tunnels?: TunnelClient;
    /** Re-starts a recorded stop/retire whose start never reached Step Functions (`settleUnknownStart`). */
    starter?: LifecycleStarter;
    /** Clock for the settle window of an unknown start; tests inject it. */
    clock?: () => Date;
    /** Backoff between StartExecution attempts; tests inject an instant one. */
    sleep?: (ms: number) => Promise<void>;
}

// ── Starting a recorded job (StartExecution) ─────────────────────────────

/** StartExecution attempts per start (the first plus retries) when the answer is lost. */
export const START_ATTEMPTS = 3;
const START_BACKOFF_MS = [250, 1000] as const;
/**
 * How long a recorded job may stay unknown to DescribeExecution before its start is KNOWN
 * never to have reached Step Functions (a lost request, not a lost answer).
 */
export const START_SETTLE_MS = 5 * 60_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * StartExecution of a RECORDED job. Its name is `computer-<jobId>` and its input is
 * fixed by the job's digest, so repeating it is idempotent: Step Functions returns the
 * running execution, or the starter treats `ExecutionAlreadyExists` as success.
 * - `started`: it was accepted (on some attempt).
 * - `refused`: AWS answered with a PERMANENT refusal (a definite, non-retryable error:
 *   access, validation, capacity): nothing runs and retrying cannot help.
 * - `unknown`: no attempt got an answer (5xx, timeout, connection lost), so the execution
 *   may be running, OR every attempt was THROTTLED (an answered 400 ThrottlingException,
 *   429, RequestLimitExceeded, incl. the OIDC credential fetch): known not started, but
 *   transient. Either way the job stays recorded and pending — never undone as a refusal:
 *   the receipt path follows the execution or, once it is settled that none exists,
 *   re-starts a stop/retire (`settleUnknownStart`), so a mandatory lease or cap stop is
 *   retried rather than dropped.
 */
export async function startLifecycleJob(
    starter: LifecycleStarter,
    region: string,
    work: Pick<LifecycleWork, 'stateMachineArn' | 'name' | 'input'>,
    sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<'started' | 'refused' | 'unknown'> {
    for (let attempt = 1; ; attempt++) {
        try {
            await starter.start(region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
            return 'started';
        } catch (error) {
            const e = toAwsClientError(error);
            // A throttle is definite (nothing ran) but transient: retry it like a lost answer.
            if (e.definite && !e.retryable) return 'refused';
            if (attempt >= START_ATTEMPTS) return 'unknown';
            await sleep(START_BACKOFF_MS[Math.min(attempt - 1, START_BACKOFF_MS.length - 1)]!);
        }
    }
}

/**
 * Apply the CURRENT job's outcome (C-3). Only the execution named by the
 * placement's own job id is read, and its receipt must match that job, its
 * digest, the generation, epoch and fence; anything else is a conflict and
 * the placement goes UNCONFIRMED. A boot is RUNNING only once BOTH the
 * provider receipt arrived AND GW-1 enrollment explicitly succeeded.
 * `terminalOnly` leaves every describe failure pending, bypassing unknown-start
 * recovery for the frequent stop-settlement pass.
 */
export async function applyLifecycleReceipt(deps: ReceiptDeps, p0: Placement, deployment: LifecycleDeployment, options: { terminalOnly?: boolean } = {}): Promise<void> {
    if (!options.terminalOnly && await reconcileStalledPoolAdopt(deps, p0, deployment)) return;
    if (!options.terminalOnly && await reconcilePoolReleaseRecovery(deps, p0, deployment)) return;
    // Migration provision receipts restore a host, but cannot open a normal epoch before commit.
    let migrationCommitted = false;
    if (p0.lastError?.startsWith('migration_pending:')) {
        const m = await createProviderMigrationStore(deps.db).readById(p0.lastError.slice('migration_pending:'.length));
        if (!m || m.state !== 'committed' || m.computerId !== p0.computerId || m.userId !== p0.ownerUserId) return;
        migrationCommitted = true;
    }
    let claimReadyAt: Date | null = null;
    let startDate: Date | null = null;
    let stopDate: Date | null = null;
    let endReason: EpochEndReason = 'provider_stop';
    const step = async (p: Placement, to: PlacementState, fields: PlacementFields = {}, usage?: UsageEffect): Promise<Placement | null> => {
        const at = (deps.now ?? deps.clock ?? (() => new Date()))();
        const r = await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: p, to, fields, usage });
        // Billing tables are not installed in production: deliberately write epochs AFTER
        // the placement transaction commits, never in that transaction. Metering cannot roll it back.
        if (r.ok && to === 'RUNNING') {
            const size = meteredSizeForInstanceType(p.instanceType);
            if (size === null) {
                console.error('[billing.meter] unknown instance type, epoch not opened', { computerId: p.computerId });
            } else {
                const metered = await recordComputeMeter(() => deps.meter?.ready({
                    userId: p.ownerUserId, computerId: p.computerId, size, readyAt: claimReadyAt ?? at,
                    overheadSeconds: !migrationCommitted && startDate ? Math.max(0, Math.floor(((claimReadyAt ?? at).getTime() - startDate.getTime()) / 1000)) : 0,
                }));
                // TODO(lane C): stop the AWS loser of a concurrent ready race; the start gate cannot close this residual race.
                if (metered === 'concurrent') console.info('[billing.epoch] concurrent AWS ready', {
                    userId: p.ownerUserId, computerId: p.computerId,
                });
            }
        }
        if (r.ok && usage?.kind === 'close') await recordComputeMeter(() => deps.meter?.stopped({
            userId: p.ownerUserId, computerId: p.computerId, endedAt: stopDate ?? at, reason: endReason,
        }));
        return r.ok ? r.placement : null;
    };
    const close: UsageEffect = { kind: 'close', observedBy: USAGE_OBSERVER };
    let p: Placement | null = p0;
    const enrolled = (x: Placement) => (x.lastError === ENROLLMENT_SUCCEEDED || (migrationCommitted && x.lastError === p0.lastError)) && x.enrollNonceHash === null && x.instanceId !== null;
    // A receipt already applied (job cleared): bound the wait for the host's enrollment.
    if (p.state === 'MOUNTING' && p.lifecycleJobId === null) {
        if (enrolled(p)) await step(p, 'RUNNING');
        else if (!options.terminalOnly) {
            const observedAt = (deps.now ?? deps.clock ?? (() => new Date()))();
            const result = await failUnenrolledPlacement(deps.db, p, observedAt);
            if (result.ok) console.warn('[enroll-timeout]', {
                computerId: p.computerId, instanceId: p.instanceId, generation: p.generation, leaseEpoch: p.leaseEpoch,
                enrollExpiresAt: p.enrollExpiresAt, observedAt,
            });
        }
        return;
    }
    const waiting: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING', 'UNCONFIRMED'];
    if (!deps.executions || !p.lifecycleJobId || !p.lifecycleDigest || !waiting.includes(p.state)) return;
    let e;
    try {
        e = await deps.executions.describe(p.region!, lifecycleExecutionArn(deployment, p.lifecycleJobId));
    } catch (error) {
        // No such execution, for a job whose start got no answer: once that is settled, the
        // request never reached Step Functions (`settleUnknownStart`). Otherwise unknown:
        // report the current state, try again on the next poll.
        if (!options.terminalOnly && isExecutionAbsent(error)) await settleUnknownStart(deps, p, deployment);
        return;
    }
    if (e.status === 'RUNNING') return;
    if (e.status !== 'SUCCEEDED') {
        if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)) {
            const poolIntent = executionIntent(e.input, p.lifecycleDigest);
            if (poolIntent?.operation === 'release' && isPoolOpenRelease(p)) {
                await failPoolOpenRelease(deps, p);
                return;
            }
            if (await recoverRefusedAdopt(deps, p, poolIntent, e)) return;
            const work = replacementWorkFromExecution(p, deployment, e);
            const outcome = work ? await settleReplacementGeneration(deps, p, work, false, await replacementNeverLaunched(deps, p, work, e)) : 'unconfirmed';
            if (outcome === 'settled') return;
            if (p.state !== 'UNCONFIRMED') await step(p, 'UNCONFIRMED', {
                lastError: outcome === 'generation_drift' ? 'generation_drift' : lifecycleFailureCode(e, p.instanceType),
                enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
            });
        }
        return;
    }
    if (p.state === 'UNCONFIRMED') return;
    const poolWork = executionIntent(e.input, p.lifecycleDigest);
    // Pool jobs cannot be interpreted as cold jobs when their input is unavailable.
    if (isPoolMode(deployment) && !poolWork) return;
    const adopting = poolWork?.operation === 'adopt';
    const releasing = poolWork?.operation === 'release';
    const stopping = p.state === 'DRAINING' || p.state === 'STOPPING';
    const retiring = p.state === 'RETIRING';
    let receipt: z.infer<typeof LifecycleReceiptSchema>;
    try {
        const parsed = LifecycleReceiptSchema.safeParse(JSON.parse(e.output ?? ''));
        if (!parsed.success) throw new Error('receipt');
        receipt = parsed.data;
    } catch {
        await step(p, 'UNCONFIRMED', { lastError: 'receipt_invalid' });
        return;
    }
    const r = receipt;
    const conflict =
        r.jobId !== p.lifecycleJobId || r.digest !== p.lifecycleDigest || r.computerId !== p.computerId.toLowerCase() ||
        r.generation !== p.generation || r.leaseEpoch !== p.leaseEpoch || r.fenceToken !== p.fenceToken ||
        r.state !== (releasing || retiring ? 'retired' : stopping ? 'stopped' : 'running') ||
        (p.volumeId !== null && r.volumeId !== p.volumeId) ||
        // Any recorded instance belongs to this generation; a receipt cannot replace its identity.
        ((stopping || retiring || p.instanceId !== null) && r.instanceId !== p.instanceId);
    if (conflict) {
        await step(p, 'UNCONFIRMED', { lastError: 'receipt_conflict' });
        return;
    }
    startDate = e.startDate ?? null;
    stopDate = e.stopDate ?? null;
    // Use the same provider evidence as stop-settlement epochs for pool release usage.
    if (releasing) {
        if (stopDate && startDate && Number.isFinite(stopDate.getTime()) && Number.isFinite(startDate.getTime())
            && stopDate >= startDate && stopDate <= (deps.now ?? deps.clock ?? (() => new Date()))()) close.stoppedAt = stopDate;
        else stopDate = null; // Invalid evidence uses the existing DB-clock close and observation-time meter.
    }
    // Session limits keep their reason in lastError. An unknown StartExecution
    // overwrites it, so those ambiguous stops conservatively use provider_stop too.
    const providerStop = ['lease_expired', 'user_hours_cap', 'global_hours_cap'].includes(p.lastError ?? '')
        || lifecycleStartUnknownUndo(p) !== null;
    endReason = r.instanceLost ? 'platform_failure' : stopping && !providerStop ? 'user_stop' : 'provider_stop';
    const done: PlacementFields = {
        instanceId: r.instanceId, volumeId: r.volumeId, lifecycleJobId: null, lifecycleDigest: null,
        // A stop that found its instance already gone (`instanceLost`): STOPPED with INSTANCE_LOST,
        // so the next open is a REPLACE onto the retained volume even in start mode (aws-ec2.ts).
        lastError: stopping ? (releasing ? POOL_RELEASED : r.instanceLost ? INSTANCE_LOST : null) : retiring ? null : migrationCommitted ? ENROLLMENT_SUCCEEDED : p.lastError,
    };
    // Fence GW-1 before a stop or retire is final: the tunnel must not outlive the instance.
    // Pending until the Worker confirms, so a failure is retried on the next look. No tunnel
    // client = nothing to fence. Idempotent: a stopped computer's tunnel is already gone.
    const fence = async (x: Placement): Promise<boolean> => {
        if (!deps.tunnels) return true;
        const fenced = await deps.tunnels
            .deleteTunnel({ userId: x.ownerUserId }, { computerId: x.computerId.toLowerCase(), sandboxId: awsSandboxId(x.ownerUserId, x.computerId), generation: x.generation, leaseEpoch: x.leaseEpoch })
            .catch(() => ({ ok: false }));
        return fenced.ok;
    };
    // The retire terminated the instance and kept the volume (R11). It may start from
    // RUNNING (the retire stops the instance first), so it fences the tunnel and closes
    // the usage row here; both are idempotent after a stop already did them.
    if (retiring) {
        if (!(await fence(p))) return;
        await step(p, 'RETIRED', done, close);
        return;
    }
    if (adopting) {
        if (!deps.pool) return;
        const enrollmentReadyAt = p.updatedAt;
        if (p.state === 'LEASED') p = await step(p, 'STARTING');
        if (!p) return;
        // A successful attach only publishes a claim. Enrollment after mount and
        // desktop readiness is the claim completion and the tenant billing boundary.
        if (enrolled(p)) {
            claimReadyAt = deps.pool.readyAt ? await deps.pool.readyAt(deps.db, poolWork.poolHostId!, p) : enrollmentReadyAt;
            if (!claimReadyAt) return;
            const usage: UsageEffect = { kind: 'open', instanceId: r.instanceId,
                instanceType: p.instanceType!, startedAt: claimReadyAt, observedBy: USAGE_OBSERVER };
            if (p.state === 'STARTING') p = await step(p, 'MOUNTING');
            if (p) await step(p, 'RUNNING', done, usage);
        } else {
            if (!options.terminalOnly && await failStalledPoolAdopt(deps, p, e)) return;
            await publishAttachedPoolClaim(deps.db, p, r.volumeId, tx => deps.pool!.publishPoolClaim(tx,
                poolWork.poolHostId!, { computerId: p!.computerId, generation: p!.generation,
                    leaseEpoch: p!.leaseEpoch, fence: p!.fenceToken!, volumeSerial: r.volumeId.replace('-', '') },
                (deps.now ?? (() => new Date()))()));
        }
        return;
    }
    // A confirmed running instance opens its usage row, dated from the job's start (the
    // instance ran from then on: counting it is the safe direction for a cap).
    const open: UsageEffect = {
        kind: 'open', instanceId: r.instanceId, instanceType: p.instanceType ?? 'unknown', startedAt: migrationCommitted ? (deps.now ?? (() => new Date()))() : e.startDate ?? null, observedBy: USAGE_OBSERVER,
    };
    if (stopping) {
        if (p.state === 'DRAINING') p = await step(p, 'STOPPING');
        if (!p) return;
        if (!(await fence(p))) return;
        if (releasing) await deps.pool?.retireLease?.(deps.db, p);
        await step(p, 'STOPPED', done, close);
        return;
    }
    if (p.state === 'PROVISIONING') {
        // PROVISIONING has no MOUNTING edge: the first boot goes RUNNING once its host enrolled.
        if (enrolled(p)) await step(p, 'RUNNING', done, open);
        return;
    }
    if (p.state === 'LEASED') p = await step(p, 'STARTING');
    if (p && p.state === 'STARTING') p = await step(p, 'MOUNTING', done, open);
    if (p && p.state === 'MOUNTING' && enrolled(p)) {
        // The job is still recorded only when this call applies the receipt itself.
        await step(p, 'RUNNING', p.lifecycleJobId === null ? {} : done, p.lifecycleJobId === null ? undefined : open);
    }
}

/**
 * The recorded job of an in-flight placement whose start got no answer
 * (`lifecycle_start_unknown:<undo>`, `markLifecycleStartUnknown`) and which Step Functions
 * does not know (`ExecutionDoesNotExist`). Before `START_SETTLE_MS` a start may still
 * appear: nothing changes. After it, the start is known not to have happened:
 * - a stop or retire carries no secret, so its exact job is rebuilt from the placement
 *   (digest-checked: the same name and input) and started again; still no answer re-marks
 *   it (a new settle window); a refusal falls through to the undo;
 * - a provision or wake carries its boot's enrollment nonce, which is never stored, so it
 *   cannot be rebuilt: the placement goes to the recorded undo state, job cleared, exactly
 *   where a refused StartExecution would have left it.
 */
async function settleUnknownStart(deps: ReceiptDeps, p: Placement, deployment: LifecycleDeployment): Promise<void> {
    const undo = lifecycleStartUnknownUndo(p);
    if (!undo || !p.lifecycleJobId || !p.lifecycleDigest || !p.region) return;
    if ((deps.clock ?? (() => new Date()))().getTime() - p.updatedAt.getTime() < START_SETTLE_MS) return;
    const operation = p.state === 'DRAINING' || p.state === 'STOPPING' ? 'stop' : p.state === 'RETIRING' ? 'retire' : null;
    if (operation && deps.starter) {
        let work: LifecycleWork | null = null;
        try {
            const rebuilt = operation === 'stop' ? sessionEndWork(p, deployment, p.lifecycleJobId, deps.pool)
                : buildLifecycleWork(currentGenerationIntent(p, operation, deployment, { jobId: p.lifecycleJobId, userData: null, leaseEpoch: p.leaseEpoch }));
            if (rebuilt.digest === p.lifecycleDigest) work = rebuilt;
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
        }
        if (work) {
            const outcome = await startLifecycleJob(deps.starter, p.region, work, deps.sleep);
            if (outcome === 'started') return; // The next look follows the execution.
            if (outcome === 'unknown') {
                await markLifecycleStartUnknown(deps.db, { computerId: p.computerId, expected: p, undo });
                return;
            }
        }
    }
    const unresolvedReplacement = undo === 'UNCONFIRMED' && ['LEASED', 'STARTING', 'MOUNTING'].includes(p.state);
    await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: p, to: undo, fields: {
            // Retain the failed replacement identity for a delayed execution readback.
            // Absence cannot reconstruct its authorized source pair or justify generation-1.
            ...(unresolvedReplacement ? {} : { lifecycleJobId: null, lifecycleDigest: null }),
            enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
            lastError: isPoolOpenRelease(p) ? POOL_OPEN_RELEASE_FAILED : LIFECYCLE_START_FAILED,
        },
    });
}

// ── Guest-initiated idle stop (R9) ───────────────────────────────────────

export interface GuestStopDeps extends ReceiptDeps {
    /** Supplied only by background reconciliation, for an admitted retry of a stalled open. */
    recoveryEnv?: Env;
    /**
     * Read-only EC2 describe in the placement's region (the app caller's enrollment describer).
     * `describeVolume` lets a lost instance be recovered onto its retained volume; without it a
     * lost instance is left for the next look rather than recorded without that check.
     */
    describer?: Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'> & Partial<Ec2VolumeDescriber> & Partial<Ec2ComputerResourceFinder & Ec2ReplacementDescriber>;
    /** Lower-case uuid v4. */
    newId?: () => string;
    /** Set when the pass's time budget ran out: stop before the next placement. */
    signal?: AbortSignal;
}

/**
 * The host stops its OWN instance after its idle window (R9, guest-initiated:
 * InstanceInitiatedShutdownBehavior=stop) without any lifecycle job, so its placement
 * would stay RUNNING: an open never wakes it and it keeps holding running capacity.
 *
 * This reads the instance's EC2 state and, when it is stopping or stopped, runs the
 * ORDINARY stop through the lifecycle. The helper answers `stopped` at once for an
 * instance that is already stopped; the receipt path then fences the tunnel, closes
 * the usage row and marks the placement STOPPED. The EC2 observation itself never
 * writes STOPPED. Returns true when a stop was started.
 */
export async function reconcileGuestStop(deps: GuestStopDeps, p: Placement, deployment: LifecycleDeployment): Promise<boolean> {
    if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2' || !deps.describer || !deps.starter) return false;
    if (!p.region || !p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return false;
    let view;
    try {
        view = await deps.describer.describeForEnrollment(p.region, p.instanceId);
    } catch {
        return false; // Unknown: leave it, try again on the next look.
    }
    if (!view || LOST_INSTANCE_STATES.has(view.state)) return recoverLostInstance(deps, p, view?.stateTransitionAt);
    if (view.state !== 'stopping' && view.state !== 'stopped') return false;
    const endedAt = view.stateTransitionAt ?? (deps.now ?? deps.clock ?? (() => new Date()))();
    const started = await startStopAsReconciler(deps, p, deployment, null);
    // EC2 has already observed the guest shutdown. Close after the placement work
    // commits; the later stop receipt is idempotent and cannot replace idle_sleep.
    if (started) await recordComputeMeter(() => deps.meter?.stopped({
        userId: p.ownerUserId, computerId: p.computerId, endedAt, reason: 'idle_sleep',
    }));
    return started;
}

/** EC2 states of an instance that is gone for good (terminate is not reversible). */
const LOST_INSTANCE_STATES: ReadonlySet<string> = new Set(['shutting-down', 'terminated']);

/**
 * A RUNNING placement whose instance EC2 no longer has, or is terminating (an external
 * terminate, an EC2 failure): nothing will ever send a receipt for it, so without this the
 * row stays RUNNING, every open "succeeds" onto a dead host, and its usage row and
 * running-capacity slot stay charged forever.
 *
 * In order, each step idempotent so an interrupted pass converges on the next look:
 *  1. the retained data volume is described (an unknown answer changes nothing);
 *  2. the epoch's tunnel is fenced (GW-1), so nothing can still reach this generation;
 *  3. ONE compare-and-swap, guarded on the same instance, closes the usage row and moves
 *     RUNNING → STOPPED with `INSTANCE_LOST` (the next open REPLACES onto the volume;
 *     aws-ec2.ts forces `replace` for it), or, when the volume itself is gone, RUNNING →
 *     UNCONFIRMED with `INSTANCE_LOST_VOLUME_MISSING`: there is nothing to boot onto.
 * Returns true when the placement was moved.
 */
async function recoverLostInstance(deps: GuestStopDeps, p: Placement, stateTransitionAt?: Date | null): Promise<boolean> {
    if (!deps.describer?.describeVolume || !p.region || !p.volumeId) return false;
    let volume;
    try {
        volume = await deps.describer.describeVolume(p.region, p.volumeId);
    } catch {
        return false; // Unknown: leave it, try again on the next look.
    }
    if (deps.tunnels) {
        const fenced = await deps.tunnels
            .deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId.toLowerCase(), sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch })
            .catch(() => ({ ok: false }));
        if (!fenced.ok) return false;
    }
    const usable = volume !== null && !['deleting', 'deleted', 'error'].includes(volume.state);
    const cleared: PlacementFields = { lifecycleJobId: null, lifecycleDigest: null, enrollConsumedHash: null, enrollExpiresAt: null };
    const r = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId,
        expected: { generation: p.generation, leaseEpoch: p.leaseEpoch, state: 'RUNNING', instanceId: p.instanceId },
        to: usable ? 'STOPPED' : 'UNCONFIRMED',
        fields: { ...cleared, lastError: usable ? INSTANCE_LOST : INSTANCE_LOST_VOLUME_MISSING },
        usage: { kind: 'close', observedBy: 'reconcile:instance_lost' },
    });
    if (r.ok) await recordComputeMeter(() => deps.meter?.stopped({
        userId: p.ownerUserId, computerId: p.computerId,
        endedAt: stateTransitionAt ?? (deps.now ?? deps.clock ?? (() => new Date()))(), reason: 'platform_failure',
    }));
    return r.ok;
}

/**
 * The ORDINARY lifecycle stop of a RUNNING placement, started by the reconciler (a
 * guest idle stop, a lapsed lease, an hour cap). The helper stops the instance with
 * an OS shutdown, so the host quiesces and flushes exactly as for a user stop; the
 * receipt path then fences the tunnel, closes the usage row and marks it STOPPED.
 * The job is recorded first (DRAINING), so the authority check finds it; `lastError`
 * says why it stopped. Returns true when a stop was started.
 */
async function startStopAsReconciler(deps: GuestStopDeps, p: Placement, deployment: LifecycleDeployment, reason: string | null): Promise<boolean> {
    if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2' || !deps.starter) return false;
    if (!p.region || !p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return false;
    let work: LifecycleWork;
    try {
        work = sessionEndWork(p, deployment, (deps.newId ?? randomUUID)(), deps.pool);
    } catch (error) {
        if (error instanceof LifecycleIntentInvalidError) return false;
        throw error;
    }
    // Same order as a user stop: the job is recorded first, so the authority check finds it.
    const draining = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: p, to: 'DRAINING', fields: { enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: reason },
    });
    if (!draining.ok) return false;
    const outcome = await startLifecycleJob(deps.starter, p.region, work, deps.sleep);
    if (outcome === 'refused') {
        await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: draining.placement, to: 'UNCONFIRMED', fields: { lastError: 'guest_stop_start_failed' } });
        return false;
    }
    if (outcome === 'unknown') {
        // It may be running: stay DRAINING with the job, the receipt path follows or settles it.
        await markLifecycleStartUnknown(deps.db, { computerId: p.computerId, expected: draining.placement, undo: 'UNCONFIRMED' });
        return true;
    }
    await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: draining.placement, to: 'STOPPING' });
    return true;
}

// ── Session limits: lease deadline and monthly hour caps (R9, §4) ─────────

/**
 * Why a RUNNING computer must stop now, or null.
 * - `lease_expired`: `lease_until` has passed. The lease is set at provision and at
 *   every wake, and renewed only by the AUTHENTICATED owner's presence (aws-ec2.ts:
 *   the shell's activity heartbeat and an explicit open). A RUNNING row with no lease
 *   is treated as lapsed: fail closed, an instance nobody can account for costs money.
 * - `user_hours_cap` / `global_hours_cap`: the month's usage (usage.ts, open rows count
 *   up to now) reached the configured cap. Admission refuses the next wake with the
 *   same codes. Egress caps cannot bind yet (egress is not measured, usage.ts).
 */
export type SessionLimit = 'lease_expired' | 'user_hours_cap' | 'global_hours_cap';

export interface SessionLimitPolicy {
    now: Date;
    /** Hour caps from the admission config; null when they cannot be read (then only the lease binds). */
    caps: Pick<AwsAdmissionCaps, 'userMonthlyHours' | 'globalMonthlyHours'> | null;
    /** This month's usage totals, when the caller already read them (a fleet pass reads once). */
    usage?: MonthUsage;
    /** Internal (default true). The fleet pass (`reconcileAwsFleet`, every caller: capacity refusal, daily reap, minute
     * reconcile) always passes false: it observes and settles guest stops but never stops a still-running guest solely
     * because its technical lease lapsed, so one user's open can never end another user's session (incident 2026-10-25,
     * ROOT-FLEET-LEASE-INCIDENT-118; terminal/load/flush holds keep the guest up). Weighted hour caps still bind.
     * The owner's own status/ensure/heartbeat keep the default. */
    enforceLeaseExpiry?: boolean;
}

export function sessionLimitFor(p: Placement, policy: SessionLimitPolicy, usage: MonthUsage | null): SessionLimit | null {
    if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2') return null;
    if (policy.enforceLeaseExpiry !== false && (!p.leaseUntil || p.leaseUntil.getTime() <= policy.now.getTime())) return 'lease_expired';
    if (policy.caps && usage) {
        const totals = usageFor(usage, p.ownerUserId);
        if (totals.user.weightedSeconds >= policy.caps.userMonthlyHours * 3_600) return 'user_hours_cap';
        if (totals.global.weightedSeconds >= policy.caps.globalMonthlyHours * 3_600) return 'global_hours_cap';
    }
    return null;
}

/** The hour caps from `env`, or null when admission is off or misconfigured (only the lease then binds). */
export function sessionLimitCaps(env: Env): SessionLimitPolicy['caps'] {
    const config = readAwsAdmissionConfig(env);
    return config.enabled ? { userMonthlyHours: config.caps.userMonthlyHours, globalMonthlyHours: config.caps.globalMonthlyHours } : null;
}

/**
 * Stop a RUNNING placement whose lease lapsed or whose hour cap is reached, through
 * the ordinary lifecycle stop (flushes like any stop), recording the reason in
 * `last_error`. Run on every status and ensure, on every activity heartbeat, and by the
 * fleet pass (the sandbox-reap cron, a capacity refusal). Returns the limit it acted
 * on, or null when none applies or the stop could not be started (the next pass retries).
 */
export async function enforceSessionLimits(
    deps: GuestStopDeps,
    p: Placement,
    deployment: LifecycleDeployment,
    policy: SessionLimitPolicy,
): Promise<SessionLimit | null> {
    if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2') return null;
    const usage = policy.caps ? policy.usage ?? (await readMonthUsage(deps.db, policy.now, utcMonthStart(policy.now))) : null;
    const limit = sessionLimitFor(p, policy, usage);
    if (!limit) return null;
    return (await startStopAsReconciler(deps, p, deployment, limit)) ? limit : null;
}

/** Most placements one fleet pass looks at (each RUNNING one costs a DescribeInstances). */
export const FLEET_RECONCILE_LIMIT = 20;

/**
 * Cheap minute pass: only settle recorded stops/retires through the ordinary receipt
 * path. Reuse the placement writer's rotating claim (including other fleet states),
 * then filter before any AWS read. At most 20 claims/describes per pass; larger fleets
 * rotate across minute ticks. No guest probes, usage-cap scans, or lifecycle starts.
 * Missing executions remain pending, even after the unknown-start settle window.
 */
export async function runAwsStopSettlement(
    env: Env,
    deps: Pick<ReceiptDeps, 'db' | 'executions' | 'tunnels' | 'meter' | 'now' | 'clock'> & { signal?: AbortSignal },
): Promise<{ ok: true; skipped: string } | { ok: true; checked: number; settled: number }> {
    if (!isAwsComputersEnabled(env)) return { ok: true, skipped: 'aws_disabled' };
    const regions = readAwsRegions(env);
    if (!regions.ok) return { ok: true, skipped: 'aws_config_invalid' };
    const d = readLifecycleDeployments(env, regions.regions.map(r => r.name));
    if (!d.ok) return { ok: true, skipped: 'aws_config_invalid' };
    if (!deps.executions) return { ok: true, skipped: 'aws_executions_unconfigured' };
    let checked = 0;
    let settled = 0;
    if (deps.signal?.aborted) return { ok: true, checked, settled };
    for (const { computerId } of await claimAwsPlacementsToReconcile(deps.db, FLEET_RECONCILE_LIMIT)) {
        if (deps.signal?.aborted) break;
        try {
            const { record } = await readPlacement(deps.db, computerId);
            if (!record || record.provider !== 'aws-ec2' || !['STOPPING', 'RETIRING'].includes(record.state)
                || !record.lifecycleJobId || !record.lifecycleDigest) continue;
            const deployment = d.deployments[record.region ?? ''];
            if (!deployment) continue;
            checked += 1;
            await applyLifecycleReceipt(deps, record, deployment, { terminalOnly: true });
            const { record: current } = await readPlacement(deps.db, computerId);
            if (current && ['STOPPED', 'RETIRED'].includes(current.state) && current.lifecycleJobId === null) settled += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError || error instanceof ImageJobConflictError)) throw error;
        }
    }
    return { ok: true, checked, settled };
}

/**
 * Settle aws-ec2 placements that may hold running capacity: apply the current receipt,
 * catch a guest-initiated stop, then stop a RUNNING one whose lease lapsed or whose
 * hour cap is reached (`policy`). Run when admission is refused for capacity and by the
 * sandbox-reap cron. The pass ROTATES (`claimAwsPlacementsToReconcile`): repeated passes
 * cover every row, not the oldest `limit` forever. One bad row never blocks the rest.
 */
export async function reconcileAwsFleet(
    deps: GuestStopDeps,
    deployments: Readonly<Record<string, LifecycleDeployment>>,
    limit = FLEET_RECONCILE_LIMIT,
    policy?: SessionLimitPolicy,
): Promise<{ checked: number; stopsStarted: number; limitStops: number }> {
    let checked = 0;
    let stopsStarted = 0;
    let limitStops = 0;
    const claimed = await claimAwsPlacementsToReconcile(deps.db, limit);
    // One usage read per pass, only when caps can bind and a row may be RUNNING.
    const usage = policy?.caps && claimed.length > 0 ? policy.usage ?? (await readMonthUsage(deps.db, policy.now, utcMonthStart(policy.now))) : undefined;
    for (const { computerId } of claimed) {
        if (deps.signal?.aborted) break; // Out of budget: the rest rotate to the next pass.
        try {
            const { record } = await readPlacement(deps.db, computerId);
            const deployment = record && record.provider === 'aws-ec2' ? deployments[record.region ?? ''] : undefined;
            if (!record || !deployment) continue;
            checked += 1;
            await applyLifecycleReceipt(deps, record, deployment);
            const { record: now } = await readPlacement(deps.db, computerId);
            if (!now) continue;
            if (deps.recoveryEnv) await replaceStalledPoolAdopt(deps, now, deps.recoveryEnv);
            if (await reconcileGuestStop(deps, now, deployment)) {
                stopsStarted += 1;
                continue;
            }
            // Caps only: a lapsed technical lease alone never stops a running guest from the fleet pass (see enforceLeaseExpiry).
            if (policy && (await enforceSessionLimits(deps, now, deployment, { ...policy, usage, enforceLeaseExpiry: false }))) limitStops += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError || error instanceof ImageJobConflictError)) throw error;
        }
    }
    return { checked, stopsStarted, limitStops };
}

// ── Background retirement of deleted computers (§6, R11) ─────────────────

/**
 * Start the lifecycle `retire` of a RUNNING or STOPPED placement as the reconciler (no
 * session: the computer is deleted). Same order as a user retire: the job is recorded
 * by the CAS first, so the authority check finds it; a refused StartExecution returns
 * the placement to the state it came from. Returns true when a retire was started.
 */
export async function startRetireAsReconciler(deps: GuestStopDeps, p: Placement, deployment: LifecycleDeployment): Promise<boolean> {
    if ((p.state !== 'RUNNING' && p.state !== 'STOPPED') || p.provider !== 'aws-ec2' || !deps.starter) return false;
    if (!p.region || !p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return false;
    let work: LifecycleWork;
    try {
        work = buildLifecycleWork(currentGenerationIntent(p, 'retire', deployment, { jobId: (deps.newId ?? randomUUID)(), userData: null, leaseEpoch: p.leaseEpoch }));
    } catch (error) {
        if (error instanceof LifecycleIntentInvalidError) return false;
        throw error;
    }
    const retiring = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: p, to: 'RETIRING', fields: { enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
    });
    if (!retiring.ok) return false;
    const outcome = await startLifecycleJob(deps.starter, p.region, work, deps.sleep);
    if (outcome === 'refused') {
        await transitionPlacementAsReconciler(deps.db, {
            computerId: p.computerId, expected: retiring.placement, to: p.state, fields: { lifecycleJobId: null, lifecycleDigest: null, lastError: 'retire_start_failed' },
        });
        return false;
    }
    if (outcome === 'unknown') await markLifecycleStartUnknown(deps.db, { computerId: p.computerId, expected: retiring.placement, undo: p.state });
    return true;
}

/** Most deleted computers one background pass settles. */
export const RETIRE_RECONCILE_LIMIT = 20;

/**
 * Settle an UNCONFIRMED (or RECOVERING) placement so its computer can be deleted: the user's
 * own `computer.delete` (aws-ec2.ts `terminate`) and the background pass for a computer
 * already deleted (`recoverDeletedAwsPlacement`) share it. Nothing is ever released while an
 * instance could still run:
 *
 * - **Nothing recorded** (no instance id, no volume id: a provision that failed before any id
 *   was recorded): only a tag search that finds NO instance and NO volume of this computer
 *   (`findComputerResources`) releases it; anything found is `stuck` for an operator.
 * - **Recorded instance gone** (EC2 no longer has it, or it is terminated): its retained
 *   volume decides. Gone too → released. `available` → retired like any other (the retire
 *   job accepts an absent source once the volume is available and unattached). Anything
 *   else (`in-use` elsewhere, `error`) is `stuck`; `creating`/`deleting` waits.
 * - **Recorded instance present**: UNCONFIRMED → RECOVERING → RETIRING with a recorded retire
 *   job; the retire job resolves any instance state. A refused start returns it to
 *   UNCONFIRMED (`retire_start_failed`); an unknown or throttled start stays RETIRING.
 *
 * `released`: the placement is RETIRED (then PURGE_ELIGIBLE: nothing is retained), the epoch's
 * tunnel fenced and the usage row closed. `retire_started`: a job that ends the instance is
 * durably recorded, so a delete may soft-delete (`AWS_RETIREMENT_UNDERWAY`). `skipped`: an
 * unknown answer or a lost race, try again. `stuck`: only an operator can settle it.
 */
export async function settleUnconfirmedAwsPlacement(
    deps: GuestStopDeps,
    p: Placement,
    deployment: LifecycleDeployment | undefined,
): Promise<'retire_started' | 'released' | 'skipped' | 'stuck'> {
    if ((p.state !== 'UNCONFIRMED' && p.state !== 'RECOVERING') || p.provider !== 'aws-ec2' || !deps.describer) return 'skipped';
    if (!p.region) return 'stuck';
    if (!p.instanceId && !p.volumeId) {
        if (!deps.describer.findComputerResources) return 'stuck';
        let found;
        try {
            found = await deps.describer.findComputerResources(p.region, p.computerId.toLowerCase());
        } catch {
            return 'skipped'; // Unknown: try again.
        }
        if (found.instances.length > 0 || found.volumes.length > 0) return 'stuck';
        return (await releaseWithoutResources(deps, p)) ? 'released' : 'skipped';
    }
    if (!p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return 'stuck';
    let view;
    try {
        view = await deps.describer.describeForEnrollment(p.region, p.instanceId);
    } catch {
        return 'skipped'; // Unknown: try again on the next pass.
    }
    if (!view || view.state === 'terminated') {
        if (!deps.describer.describeVolume) return 'stuck';
        let volume;
        try {
            volume = await deps.describer.describeVolume(p.region, p.volumeId);
        } catch {
            return 'skipped';
        }
        if (volume === null || volume.state === 'deleted') return (await releaseWithoutResources(deps, p)) ? 'released' : 'skipped';
        if (volume.state === 'creating' || volume.state === 'deleting') return 'skipped';
        if (volume.state !== 'available') return 'stuck';
    }
    if (!deps.starter || !deployment) return 'skipped';
    let work: LifecycleWork;
    try {
        work = buildLifecycleWork(currentGenerationIntent(p, 'retire', deployment, { jobId: (deps.newId ?? randomUUID)(), userData: null, leaseEpoch: p.leaseEpoch }));
    } catch (error) {
        if (error instanceof LifecycleIntentInvalidError) return 'stuck';
        throw error;
    }
    let current = p;
    if (current.state === 'UNCONFIRMED') {
        const recovering = await transitionPlacementAsReconciler(deps.db, {
            computerId: p.computerId, expected: current, to: 'RECOVERING', fields: { lastError: 'deleted_recovery' },
        });
        if (!recovering.ok) return 'skipped';
        current = recovering.placement;
    }
    const retiring = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: current, to: 'RETIRING', fields: { enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
    });
    if (!retiring.ok) return 'skipped';
    const outcome = await startLifecycleJob(deps.starter, p.region, work, deps.sleep);
    if (outcome === 'refused') {
        await transitionPlacementAsReconciler(deps.db, {
            computerId: p.computerId, expected: retiring.placement, to: 'UNCONFIRMED', fields: { lifecycleJobId: null, lifecycleDigest: null, lastError: 'retire_start_failed' },
        });
        return 'skipped';
    }
    if (outcome === 'unknown') await markLifecycleStartUnknown(deps.db, { computerId: p.computerId, expected: retiring.placement, undo: 'UNCONFIRMED' });
    return 'retire_started';
}

/**
 * The release of a placement EC2 shows owns nothing: fence the epoch's tunnel (idempotent;
 * a failure changes nothing), then ONE compare-and-swap guarded on the same instance id
 * moves it to RETIRED (`RELEASED_NO_RESOURCES`) and closes any open usage row, then on to
 * PURGE_ELIGIBLE: no volume is retained, so the user's AWS-computer allowance is freed.
 */
async function releaseWithoutResources(deps: GuestStopDeps, p: Placement): Promise<boolean> {
    if (deps.tunnels) {
        const fenced = await deps.tunnels
            .deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId.toLowerCase(), sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch })
            .catch(() => ({ ok: false }));
        if (!fenced.ok) return false;
    }
    const retired = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId,
        expected: { generation: p.generation, leaseEpoch: p.leaseEpoch, state: p.state, instanceId: p.instanceId },
        to: 'RETIRED',
        fields: { lifecycleJobId: null, lifecycleDigest: null, enrollConsumedHash: null, enrollExpiresAt: null, lastError: RELEASED_NO_RESOURCES },
        usage: { kind: 'close', observedBy: 'reconcile:released' },
    });
    if (!retired.ok) return false;
    await recordComputeMeter(() => deps.meter?.stopped({
        userId: p.ownerUserId, computerId: p.computerId,
        endedAt: (deps.now ?? deps.clock ?? (() => new Date()))(), reason: 'platform_failure',
    }));
    await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: retired.placement, to: 'PURGE_ELIGIBLE' });
    return true;
}

/**
 * A DELETED computer whose stop or retire failed (UNCONFIRMED) or whose recovery was left
 * RECOVERING: nothing else will ever retry it (the user cannot see it any more), so the
 * background pass settles it (`settleUnconfirmedAwsPlacement`). A live computer's
 * placement is never touched here: only its owner's own delete settles it.
 */
export async function recoverDeletedAwsPlacement(
    deps: GuestStopDeps,
    p: Placement,
    deployment: LifecycleDeployment,
): Promise<'retire_started' | 'released' | 'skipped' | 'stuck'> {
    if ((p.state !== 'UNCONFIRMED' && p.state !== 'RECOVERING') || p.provider !== 'aws-ec2' || !deps.describer) return 'skipped';
    const computer = await readCanaryComputer(deps.db, p.computerId);
    if (computer && !computer.deleted) return 'skipped';
    return settleUnconfirmedAwsPlacement(deps, p, deployment);
}

/**
 * Drive every deleted computer's placement to RETIRED: apply its current receipt (a
 * recorded stop or retire), then start the retire of one that is RUNNING or STOPPED, or
 * recover one left UNCONFIRMED/RECOVERING by a failed job (`recoverDeletedAwsPlacement`).
 * `computer.delete` soft-deletes as soon as such a job is recorded, so one user delete
 * completes without the user returning. The pass rotates (`claimAwsPlacementsPendingRetire`)
 * and one bad row never blocks the rest; `stuck` counts rows only an operator can settle.
 */
export async function reconcileDeletedAwsComputers(
    deps: GuestStopDeps,
    deployments: Readonly<Record<string, LifecycleDeployment>>,
    limit = RETIRE_RECONCILE_LIMIT,
): Promise<{ checked: number; retiresStarted: number; retired: number; stuck: number }> {
    let checked = 0;
    let retiresStarted = 0;
    let retired = 0;
    let stuck = 0;
    for (const { computerId } of await claimAwsPlacementsPendingRetire(deps.db, limit)) {
        if (deps.signal?.aborted) break; // Out of budget: the rest rotate to the next pass.
        try {
            const { record } = await readPlacement(deps.db, computerId);
            const deployment = record && record.provider === 'aws-ec2' ? deployments[record.region ?? ''] : undefined;
            if (!record || !deployment) continue;
            checked += 1;
            await applyLifecycleReceipt(deps, record, deployment);
            const { record: now } = await readPlacement(deps.db, computerId);
            if (!now) continue;
            if (now.state === 'RETIRED') retired += 1;
            else if (now.state === 'UNCONFIRMED' || now.state === 'RECOVERING') {
                const outcome = await recoverDeletedAwsPlacement(deps, now, deployment);
                if (outcome === 'retire_started') retiresStarted += 1;
                else if (outcome === 'released') retired += 1;
                else if (outcome === 'stuck') stuck += 1;
            } else if (await startRetireAsReconciler(deps, now, deployment)) retiresStarted += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError || error instanceof ImageJobConflictError)) throw error;
        }
    }
    return { checked, retiresStarted, retired, stuck };
}

/**
 * The cron job (cron/sandbox-reap): with AWS on and every configured region's
 * deployment readable, settle deleted computers, then the live fleet (receipts and
 * guest idle stops, `reconcileAwsFleet`). AWS off answers `skipped`, no statement.
 */
export async function runAwsBackgroundReconcile(
    env: Env,
    deps: GuestStopDeps,
): Promise<{ ok: true; skipped: string } | { ok: true; deleted: Awaited<ReturnType<typeof reconcileDeletedAwsComputers>>; fleet: Awaited<ReturnType<typeof reconcileAwsFleet>> }> {
    if (!isAwsComputersEnabled(env)) return { ok: true, skipped: 'aws_disabled' };
    const regions = readAwsRegions(env);
    if (!regions.ok) return { ok: true, skipped: 'aws_config_invalid' };
    const d = readLifecycleDeployments(env, regions.regions.map((r) => r.name));
    if (!d.ok) return { ok: true, skipped: 'aws_config_invalid' };
    const deleted = await reconcileDeletedAwsComputers(deps, d.deployments);
    // Reached hour caps are stopped here too, for computers nobody touches (a lapsed lease alone is not: reconcileAwsFleet).
    const fleet = deps.signal?.aborted
        ? { checked: 0, stopsStarted: 0, limitStops: 0 }
        : await reconcileAwsFleet({ ...deps, recoveryEnv: env }, d.deployments, FLEET_RECONCILE_LIMIT, { now: (deps.clock ?? (() => new Date()))(), caps: sessionLimitCaps(env) });
    return { ok: true, deleted, fleet };
}

/** Migration boot evidence, deliberately separate from normal ready/usage writes. */
export async function readMigrationReadyReceipt(executions: LifecycleExecutionReader, p: Placement, deployment: LifecycleDeployment): Promise<boolean> {
    if (!p.lifecycleJobId || !p.lifecycleDigest || p.region !== 'ap-south-1') throw new Error('migration_intent_invalid');
    const execution = await executions.describe(p.region, lifecycleExecutionArn(deployment, p.lifecycleJobId));
    if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status) || p.lastError === 'enroll_tunnel_failed') throw new Error('migration_host_failed');
    if (execution.status !== 'SUCCEEDED') return false;
    const parsed = LifecycleReceiptSchema.safeParse(JSON.parse(execution.output ?? 'null'));
    if (!parsed.success) throw new Error('migration_receipt_invalid');
    const r = parsed.data;
    if (r.jobId !== p.lifecycleJobId || r.digest !== p.lifecycleDigest || r.computerId !== p.computerId
        || r.generation !== p.generation || r.leaseEpoch !== p.leaseEpoch || r.fenceToken !== p.fenceToken
        || r.state !== 'running' || (p.instanceId !== null && r.instanceId !== p.instanceId)
        || (p.volumeId !== null && r.volumeId !== p.volumeId)) throw new Error('migration_receipt_conflict');
    return p.lastError === ENROLLMENT_SUCCEEDED && p.enrollNonceHash === null && p.enrollConsumedHash !== null
        && p.instanceId === r.instanceId && p.volumeId === r.volumeId;
}
