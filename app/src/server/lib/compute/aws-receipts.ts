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

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { AWS_TIERS, type AwsTier } from './aws-config';
import type { LifecycleStarter } from './aws-ec2';
import { awsSandboxId, type Ec2EnrollmentDescriber, type TunnelClient } from './aws-enroll';
import { buildLifecycleWork, currentGenerationIntent, LifecycleIntentInvalidError, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import {
    ENROLLMENT_SUCCEEDED,
    listAwsPlacementsToReconcile,
    PlacementIntegrityError,
    readPlacement,
    transitionPlacementAsReconciler,
    type Placement,
    type PlacementDb,
    type PlacementFields,
    type PlacementState,
    type UsageEffect,
} from './placement';

/** Read-only `DescribeExecution` in the placement's region (Step Functions). */
export interface LifecycleExecutionReader {
    describe(
        region: string,
        executionArn: string,
    ): Promise<{ status: string; output?: string | null; error?: string | null; cause?: string | null; startDate?: Date | null }>;
}

/** Who recorded a usage row (`observed_by`). */
export const USAGE_OBSERVER = 'lifecycle-receipt';

/** `arn:aws:states:<region>:<account>:execution:<machine>:computer-<jobId>`: executions live under the machine, not the version. */
export function lifecycleExecutionArn(d: LifecycleDeployment, jobId: string): string {
    const machine = d.stateMachineVersionArn.slice(0, d.stateMachineVersionArn.lastIndexOf(':')).split(':').at(-1) ?? '';
    return `arn:aws:states:${d.region}:${d.accountId}:execution:${machine}:computer-${jobId}`;
}

/** Infra `LifecycleReceiptSchema` (intent.ts): the workflow's success output. */
const LifecycleReceiptSchema = z
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
    })
    .strict();

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

export interface ReceiptDeps {
    db: PlacementDb;
    /** Without it nothing is read and nothing changes. */
    executions?: LifecycleExecutionReader;
    /** GW-1, to fence (delete) a stopped generation's tunnel. */
    tunnels?: TunnelClient;
}

/**
 * Apply the CURRENT job's outcome (C-3). Only the execution named by the
 * placement's own job id is read, and its receipt must match that job, its
 * digest, the generation, epoch and fence; anything else is a conflict and
 * the placement goes UNCONFIRMED. A boot is RUNNING only once BOTH the
 * provider receipt arrived AND GW-1 enrollment explicitly succeeded.
 */
export async function applyLifecycleReceipt(deps: ReceiptDeps, p0: Placement, deployment: LifecycleDeployment): Promise<void> {
    const step = async (p: Placement, to: PlacementState, fields: PlacementFields = {}, usage?: UsageEffect): Promise<Placement | null> => {
        const r = await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: p, to, fields, usage });
        return r.ok ? r.placement : null;
    };
    const close: UsageEffect = { kind: 'close', observedBy: USAGE_OBSERVER };
    let p: Placement | null = p0;
    const enrolled = (x: Placement) => x.lastError === ENROLLMENT_SUCCEEDED && x.enrollNonceHash === null && x.instanceId !== null;
    // A receipt already applied (job cleared): MOUNTING waits only for the host's enrollment.
    if (p.state === 'MOUNTING' && p.lifecycleJobId === null) {
        if (enrolled(p)) await step(p, 'RUNNING');
        return;
    }
    const waiting: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RETIRING'];
    if (!deps.executions || !p.lifecycleJobId || !p.lifecycleDigest || !waiting.includes(p.state)) return;
    let e;
    try {
        e = await deps.executions.describe(p.region!, lifecycleExecutionArn(deployment, p.lifecycleJobId));
    } catch {
        return; // Unknown: report the current state, try again on the next poll.
    }
    if (e.status === 'RUNNING') return;
    if (e.status !== 'SUCCEEDED') {
        if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)) await step(p, 'UNCONFIRMED', { lastError: lifecycleFailureCode(e, p.instanceType) });
        return;
    }
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
        r.state !== (stopping ? 'stopped' : retiring ? 'retired' : 'running') ||
        (p.volumeId !== null && r.volumeId !== p.volumeId) ||
        // Any recorded instance belongs to this generation; a receipt cannot replace its identity.
        ((stopping || retiring || p.instanceId !== null) && r.instanceId !== p.instanceId);
    if (conflict) {
        await step(p, 'UNCONFIRMED', { lastError: 'receipt_conflict' });
        return;
    }
    const done: PlacementFields = {
        instanceId: r.instanceId, volumeId: r.volumeId, lifecycleJobId: null, lifecycleDigest: null, lastError: stopping || retiring ? null : p.lastError,
    };
    // The retire terminated the instance and kept the volume (R11). It starts only from
    // STOPPED, whose stop already fenced the tunnel and closed the usage row; the close
    // here is idempotent belt and braces.
    if (retiring) {
        await step(p, 'RETIRED', done, close);
        return;
    }
    // A confirmed running instance opens its usage row, dated from the job's start (the
    // instance ran from then on: counting it is the safe direction for a cap).
    const open: UsageEffect = {
        kind: 'open', instanceId: r.instanceId, instanceType: p.instanceType ?? 'unknown', startedAt: e.startDate ?? null, observedBy: USAGE_OBSERVER,
    };
    if (stopping) {
        if (p.state === 'DRAINING') p = await step(p, 'STOPPING');
        if (!p) return;
        // Keep the stop pending until GW-1 confirms fencing, so failures can be retried.
        // No tunnel client = nothing to fence: the stop still completes.
        if (deps.tunnels) {
            const fenced = await deps.tunnels
                .deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId.toLowerCase(), sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch })
                .catch(() => ({ ok: false }));
            if (!fenced.ok) return;
        }
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

// ── Guest-initiated idle stop (R9) ───────────────────────────────────────

export interface GuestStopDeps extends ReceiptDeps {
    /** Read-only EC2 describe in the placement's region (the app caller's enrollment describer). */
    describer?: Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'>;
    starter?: LifecycleStarter;
    /** Lower-case uuid v4. */
    newId?: () => string;
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
    if (!view || (view.state !== 'stopping' && view.state !== 'stopped')) return false;
    let work: LifecycleWork;
    try {
        work = buildLifecycleWork(currentGenerationIntent(p, 'stop', deployment, { jobId: (deps.newId ?? randomUUID)(), userData: null, leaseEpoch: p.leaseEpoch }));
    } catch (error) {
        if (error instanceof LifecycleIntentInvalidError) return false;
        throw error;
    }
    // Same order as a user stop: the job is recorded first, so the authority check finds it.
    const draining = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: p, to: 'DRAINING', fields: { lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
    });
    if (!draining.ok) return false;
    try {
        await deps.starter.start(p.region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
    } catch {
        await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: draining.placement, to: 'UNCONFIRMED', fields: { lastError: 'guest_stop_start_failed' } });
        return false;
    }
    await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: draining.placement, to: 'STOPPING' });
    return true;
}

/** Most placements one fleet pass looks at (each RUNNING one costs a DescribeInstances). */
export const FLEET_RECONCILE_LIMIT = 20;

/**
 * Settle every aws-ec2 placement that may hold running capacity: apply its current
 * receipt, then catch a guest-initiated stop. Run when admission is refused for
 * capacity, so a fleet of idle-stopped rows cannot exhaust the cohort. One bad row
 * never blocks the rest. Returns how many stops it started.
 */
export async function reconcileAwsFleet(
    deps: GuestStopDeps,
    deployments: Readonly<Record<string, LifecycleDeployment>>,
    limit = FLEET_RECONCILE_LIMIT,
): Promise<{ checked: number; stopsStarted: number }> {
    let checked = 0;
    let stopsStarted = 0;
    for (const { computerId } of await listAwsPlacementsToReconcile(deps.db, limit)) {
        try {
            const { record } = await readPlacement(deps.db, computerId);
            const deployment = record && record.provider === 'aws-ec2' ? deployments[record.region ?? ''] : undefined;
            if (!record || !deployment) continue;
            checked += 1;
            await applyLifecycleReceipt(deps, record, deployment);
            const { record: now } = await readPlacement(deps.db, computerId);
            if (now && (await reconcileGuestStop(deps, now, deployment))) stopsStarted += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError)) throw error;
        }
    }
    return { checked, stopsStarted };
}
