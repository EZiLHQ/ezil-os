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

import { AWS_TIERS, isAwsComputersEnabled, readAwsAdmissionConfig, readAwsRegions, type AwsAdmissionCaps, type AwsTier, type Env } from './aws-config';
import type { LifecycleStarter } from './aws-ec2';
import { awsSandboxId, type Ec2EnrollmentDescriber, type TunnelClient } from './aws-enroll';
import { buildLifecycleWork, currentGenerationIntent, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import {
    ENROLLMENT_SUCCEEDED,
    claimAwsPlacementsPendingRetire,
    claimAwsPlacementsToReconcile,
    PlacementIntegrityError,
    readCanaryComputer,
    readMonthUsage,
    readPlacement,
    transitionPlacementAsReconciler,
    type Placement,
    type PlacementDb,
    type PlacementFields,
    type PlacementState,
    type UsageEffect,
    type UsageRow,
} from './placement';
import { summarizeUsage, utcMonthStart } from './usage';

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
    // A confirmed running instance opens its usage row, dated from the job's start (the
    // instance ran from then on: counting it is the safe direction for a cap).
    const open: UsageEffect = {
        kind: 'open', instanceId: r.instanceId, instanceType: p.instanceType ?? 'unknown', startedAt: e.startDate ?? null, observedBy: USAGE_OBSERVER,
    };
    if (stopping) {
        if (p.state === 'DRAINING') p = await step(p, 'STOPPING');
        if (!p) return;
        if (!(await fence(p))) return;
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
    /** The background pass's clock (session limits); tests inject it. */
    clock?: () => Date;
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
    return startStopAsReconciler(deps, p, deployment, null);
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
        work = buildLifecycleWork(currentGenerationIntent(p, 'stop', deployment, { jobId: (deps.newId ?? randomUUID)(), userData: null, leaseEpoch: p.leaseEpoch }));
    } catch (error) {
        if (error instanceof LifecycleIntentInvalidError) return false;
        throw error;
    }
    // Same order as a user stop: the job is recorded first, so the authority check finds it.
    const draining = await transitionPlacementAsReconciler(deps.db, {
        computerId: p.computerId, expected: p, to: 'DRAINING', fields: { lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: reason },
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
    /** This month's usage rows, when the caller already read them (a fleet pass reads once). */
    usage?: readonly UsageRow[];
}

export function sessionLimitFor(p: Placement, policy: SessionLimitPolicy, usage: readonly UsageRow[] | null): SessionLimit | null {
    if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2') return null;
    if (!p.leaseUntil || p.leaseUntil.getTime() <= policy.now.getTime()) return 'lease_expired';
    if (policy.caps && usage) {
        const totals = summarizeUsage(usage, p.ownerUserId.toLowerCase(), policy.now);
        if (totals.user.hours >= policy.caps.userMonthlyHours) return 'user_hours_cap';
        if (totals.global.hours >= policy.caps.globalMonthlyHours) return 'global_hours_cap';
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
        try {
            const { record } = await readPlacement(deps.db, computerId);
            const deployment = record && record.provider === 'aws-ec2' ? deployments[record.region ?? ''] : undefined;
            if (!record || !deployment) continue;
            checked += 1;
            await applyLifecycleReceipt(deps, record, deployment);
            const { record: now } = await readPlacement(deps.db, computerId);
            if (!now) continue;
            if (await reconcileGuestStop(deps, now, deployment)) {
                stopsStarted += 1;
                continue;
            }
            if (policy && (await enforceSessionLimits(deps, now, deployment, { ...policy, usage }))) limitStops += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError)) throw error;
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
        computerId: p.computerId, expected: p, to: 'RETIRING', fields: { lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
    });
    if (!retiring.ok) return false;
    try {
        await deps.starter.start(p.region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
    } catch {
        await transitionPlacementAsReconciler(deps.db, {
            computerId: p.computerId, expected: retiring.placement, to: p.state, fields: { lifecycleJobId: null, lifecycleDigest: null, lastError: 'retire_start_failed' },
        });
        return false;
    }
    return true;
}

/** Most deleted computers one background pass settles. */
export const RETIRE_RECONCILE_LIMIT = 20;

/**
 * Recover a DELETED computer's stuck placement (UNCONFIRMED after a failed, timed-out or
 * aborted stop/retire, or RECOVERING left by an interrupted recovery) by retiring it:
 * UNCONFIRMED → RECOVERING → RETIRING with a recorded retire job, then StartExecution.
 * The lifecycle retire resolves any instance state itself (stops a running one, waits
 * on stopping/shutting-down, terminates a stopped one, finishes on a terminated one once
 * the volume is detached), so this does not choose between stop and retire.
 *
 * 🔴 Only a deleted (or vanished) computer: the computer row is re-read here, and a live
 * computer's UNCONFIRMED placement is left alone (it is the owner's to recover). The
 * instance must still be visible to EC2 describe: an unknown answer (describe failed)
 * waits for the next pass; an instance EC2 no longer knows cannot be verified by the
 * retire and is reported `stuck` (operator purge) instead of failing a job every pass.
 * A refused StartExecution returns the placement to UNCONFIRMED (`retire_start_failed`),
 * so the next pass tries again.
 */
export async function recoverDeletedAwsPlacement(
    deps: GuestStopDeps,
    p: Placement,
    deployment: LifecycleDeployment,
): Promise<'retire_started' | 'skipped' | 'stuck'> {
    if ((p.state !== 'UNCONFIRMED' && p.state !== 'RECOVERING') || p.provider !== 'aws-ec2' || !deps.starter || !deps.describer) return 'skipped';
    const computer = await readCanaryComputer(deps.db, p.computerId);
    if (computer && !computer.deleted) return 'skipped';
    if (!p.region || !p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return 'stuck';
    let view;
    try {
        view = await deps.describer.describeForEnrollment(p.region, p.instanceId);
    } catch {
        return 'skipped'; // Unknown: try again on the next pass.
    }
    if (!view) return 'stuck';
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
        computerId: p.computerId, expected: current, to: 'RETIRING', fields: { lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
    });
    if (!retiring.ok) return 'skipped';
    try {
        await deps.starter.start(p.region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
    } catch {
        await transitionPlacementAsReconciler(deps.db, {
            computerId: p.computerId, expected: retiring.placement, to: 'UNCONFIRMED', fields: { lifecycleJobId: null, lifecycleDigest: null, lastError: 'retire_start_failed' },
        });
        return 'skipped';
    }
    return 'retire_started';
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
                else if (outcome === 'stuck') stuck += 1;
            } else if (await startRetireAsReconciler(deps, now, deployment)) retiresStarted += 1;
        } catch (error) {
            if (!(error instanceof PlacementIntegrityError)) throw error;
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
    // Lapsed leases and reached hour caps are stopped here too, for computers nobody touches.
    const fleet = await reconcileAwsFleet(deps, d.deployments, FLEET_RECONCILE_LIMIT, { now: (deps.clock ?? (() => new Date()))(), caps: sessionLimitCaps(env) });
    return { ok: true, deleted, fleet };
}
