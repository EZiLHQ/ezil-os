/**
 * aws-ec2 provider (docs/AWS-COMPUTERS.md C-1, C-3).
 *
 * Two shapes:
 * - `createAwsEc2StubProvider`: no database. Refuses `aws_disabled` with the
 *   flag off and throws `AwsProviderNotImplementedError` with it on.
 * - `createAwsEc2Provider`: the real lifecycle path. It reads and writes
 *   placements only through `placement.ts`/`admission.ts`, and starts
 *   lifecycle executions only through an injected `LifecycleStarter`. With a
 *   missing starter, tier source or enrollment URL it refuses BEFORE any
 *   write (`aws_lifecycle_unconfigured`, `aws_tier_unavailable`,
 *   `aws_enrollment_unavailable`), so a half-configured deployment never
 *   leaves a placement without an execution.
 *
 * C-6 enrollment material is issued HERE, for every boot that launches or
 * starts an instance: a one-time nonce whose sha256 and deadline are written
 * in the SAME statement as the placement change that admits the boot, and
 * whose plaintext goes only into that intent's user data (`aws-enroll.ts`).
 *
 * Persistence model: the computer's disk is a retained EBS data volume.
 * Stop/idle = instance stopped (no running services; EBS only). Wake = cold
 * boot of the same instance on the same volume. Running processes and RAM
 * are NOT preserved. A wake stays in the placement's region: a full region
 * answers `capacity_unavailable`, it never moves the computer.
 */

import { randomBytes as nodeRandomBytes, randomUUID } from 'node:crypto';

import { runAdmission, type AdmissionRefusal } from './admission';
import {
    AWS_TIER_DATA_GIB,
    instanceTypeForTier,
    isAwsComputersEnabled,
    readAwsAdmissionConfig,
    readAwsEnrollUrl,
    readAwsWakeMode,
    type AwsTier,
    type AwsWakeMode,
    type Env,
} from './aws-config';
import { buildEnrollmentUserData, EnrollmentUserDataError, issueEnrollmentNonce, type Ec2EnrollmentDescriber, type TunnelClient } from './aws-enroll';
import {
    buildLifecycleWork,
    currentGenerationIntent,
    LifecycleIntentInvalidError,
    readLifecycleDeployments,
    type LifecycleDeployment,
    type LifecycleIntent,
    type LifecycleOperation,
    type LifecycleWork,
} from './aws-intent';
import { ENROLLMENT_FAILED, INSTANCE_LOST, markLifecycleStartUnknown, PlacementOwnerError, readPlacement, renewPlacementLease, transitionPlacement, type Placement, type PlacementDb, type PlacementState } from './placement';
import type { Ec2ComputerResourceFinder, Ec2VolumeDescriber } from './aws-clients';
import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import { applyLifecycleReceipt, enforceSessionLimits, FLEET_RECONCILE_LIMIT, reconcileAwsFleet, reconcileGuestStop, sessionLimitCaps, settleUnconfirmedAwsPlacement, startLifecycleJob, type LifecycleExecutionReader, type SessionLimit } from './aws-receipts';
import type { ActivityResult, ComputeCtx, ComputeProvider, ComputeStatus, ComputerRef, EnsureResult, StopResult, TerminateResult } from './provider';
import { plusPlanIds, tierForEntitlement, type EntitlementRecord } from './tier';

export const AWS_DISABLED = 'aws_disabled';

export class AwsProviderNotImplementedError extends Error {
    constructor(operation: string) {
        super(`aws-ec2 provider is not implemented: ${operation}`);
        this.name = 'AwsProviderNotImplementedError';
    }
}

export function createAwsEc2StubProvider(readEnv: () => Env = () => process.env): ComputeProvider {
    const gate = (operation: string): void => {
        if (isAwsComputersEnabled(readEnv())) throw new AwsProviderNotImplementedError(operation);
    };
    return {
        kind: 'aws-ec2',
        ensure: async () => {
            gate('ensure');
            return { ok: false, error: AWS_DISABLED, errorCode: AWS_DISABLED, retryable: false };
        },
        status: async () => {
            gate('status');
            return { ok: false, error: AWS_DISABLED };
        },
        activity: async () => {
            gate('activity');
            return { ok: false, error: AWS_DISABLED };
        },
        restart: async () => {
            gate('restart');
            return { ok: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
        stop: async () => {
            gate('stop');
            return { ok: false, terminated: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
        terminate: async () => {
            gate('terminate');
            return { ok: false, terminated: false, outcome: AWS_DISABLED, error: AWS_DISABLED };
        },
    };
}

export const awsEc2StubProvider: ComputeProvider = createAwsEc2StubProvider();

// ── Real provider ────────────────────────────────────────────────────────

/** Starts one execution. Resolves only when AWS accepted it; throws otherwise. */
export interface LifecycleStarter {
    start(region: string, work: { stateMachineArn: string; name: string; input: string }): Promise<void>;
}

/** terminate: a retire job is recorded and running (or its receipt is pending). */
export const AWS_RETIRING = 'retiring';
/** terminate: a stop job is recorded; the background reconcile retires the computer once it is STOPPED. */
export const AWS_RETIRE_AFTER_STOP = 'retire_after_stop';
/** Outcomes after which `computer.delete` may soft-delete: a lifecycle job that ends the instance is durably recorded. */
export const AWS_RETIREMENT_UNDERWAY: readonly string[] = [AWS_RETIRING, AWS_RETIRE_AFTER_STOP];

export interface AwsProviderDeps {
    db: PlacementDb;
    meter?: ComputeMeter;
    env?: () => Env;
    now?: () => Date;
    /** Lower-case uuid v4. */
    newId?: () => string;
    starter?: LifecycleStarter;
    /** The caller's resolved record; null means the read found no entitlement. */
    entitlement?: EntitlementRecord | null;
    /** Legacy tier source for callers that do not supply a resolved record. */
    tierFor?: (userId: string) => Promise<AwsTier>;
    /** Source of the enrollment nonce's 32 bytes (tests make it deterministic). */
    randomBytes?: (n: number) => Buffer;
    /** Reads lifecycle executions so `status` can apply their receipts. Without it nothing is reconciled. */
    executions?: LifecycleExecutionReader;
    /** GW-1, to fence (delete) a stopped generation's tunnel. */
    tunnels?: TunnelClient;
    /**
     * Read-only EC2 describe (the enrollment describer). Catches a guest-initiated idle
     * stop (R9), which no lifecycle job reports. Without it such a stop is never seen.
     */
    describer?: Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'> & Partial<Ec2VolumeDescriber> & Partial<Ec2ComputerResourceFinder>;
    /** Lease length: set at provision and at every wake, renewed by the owner's presence. */
    leaseSeconds?: number;
    /** Backoff between StartExecution attempts whose answer was lost; tests inject an instant one. */
    sleep?: (ms: number) => Promise<void>;
}

/**
 * How recent the owner's presence must be to renew a lease: the shell's own
 * `ACTIVITY_FRESH_MS` (shell/ezil/activity-heartbeat.js, 30 min), past which it stops
 * heartbeating, and the value its release beat reports. Presence at least this old
 * renews nothing.
 */
export const AWS_PRESENCE_FRESH_MS = 30 * 60_000;

export type AwsComputerState = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
export interface AwsComputeStatus extends ComputeStatus {
    state?: AwsComputerState;
    placementState?: PlacementState;
    region?: string | null;
}

/** C-3 placement state → what the shell shows. Exhaustive. */
export const AWS_STATE_FOR: Readonly<Record<PlacementState, AwsComputerState>> = {
    PROVISIONING: 'starting', LEASED: 'starting', STARTING: 'starting', MOUNTING: 'starting',
    RUNNING: 'running',
    DRAINING: 'stopping', STOPPING: 'stopping',
    STOPPED: 'stopped',
    UNCONFIRMED: 'error', RECOVERING: 'error',
    RETIRING: 'error', RETIRED: 'error', PURGE_ELIGIBLE: 'error',
    WARMING: 'error', READY: 'error', CLAIMED: 'error',
};

/** Refusals a user can do nothing about but wait: the region (or fleet) is full. Never answered by moving regions. */
const CAPACITY_REFUSALS: readonly AdmissionRefusal[] = ['max_running', 'region_capacity'];

const notReady = (errorCode: string, retryable = false, error = errorCode): EnsureResult => ({ ok: false, error, errorCode, retryable });

export function createAwsEc2Provider(deps: AwsProviderDeps): ComputeProvider & { status(ctx: ComputeCtx, c: ComputerRef): Promise<AwsComputeStatus> } {
    const env = deps.env ?? (() => process.env);
    const now = deps.now ?? (() => new Date());
    const newId = deps.newId ?? (() => randomUUID());
    const leaseSeconds = deps.leaseSeconds ?? 3600;
    const randomBytes = deps.randomBytes ?? nodeRandomBytes;

    /** Flag, admission config and every configured region's deployment, or the refusal code. */
    const configured = ():
        | { ok: true; e: Env; deployments: Record<string, LifecycleDeployment>; enrollUrl: string | null; wakeMode: AwsWakeMode }
        | { ok: false; code: string } => {
        const e = env();
        if (!isAwsComputersEnabled(e)) return { ok: false, code: AWS_DISABLED };
        const config = readAwsAdmissionConfig(e);
        if (!config.enabled) return { ok: false, code: config.reason };
        const d = readLifecycleDeployments(e, config.regions.map((r) => r.name));
        if (!d.ok) return { ok: false, code: 'aws_config_invalid' };
        // `start` without the deployment's userData-nonce feature could never enroll: fail closed.
        const wake = readAwsWakeMode(e);
        if (!wake.ok) return { ok: false, code: 'aws_config_invalid' };
        return { ok: true, e, deployments: d.deployments, enrollUrl: readAwsEnrollUrl(e), wakeMode: wake.mode };
    };

    /** The caller's own aws-ec2 placement, or null when there is none. Another owner is NOT_FOUND upstream. */
    const ownPlacement = async (c: ComputerRef): Promise<Placement | null> => {
        const { record } = await readPlacement(deps.db, c.computerId);
        if (record && record.ownerUserId !== c.userId.toLowerCase()) throw new PlacementOwnerError(record.computerId);
        return record;
    };

    /** A start, stop or retire of the placement's CURRENT generation (`currentGenerationIntent`). */
    const sameGenerationIntent = (
        p: Placement,
        operation: Extract<LifecycleOperation, 'start' | 'stop' | 'retire'>,
        deployment: LifecycleDeployment,
        extra: { userData: string | null; leaseEpoch: number },
    ): LifecycleIntent => currentGenerationIntent(p, operation, deployment, { jobId: newId(), ...extra });

    /**
     * Wake or resize by REPLACE (C-3): a new instance of the requested type boots on the
     * retained data volume as generation + 1, with a fresh fence token. The old
     * generation's instance, generation and fence are handed on as `previous*`;
     * the helper stops and terminates it, never the volume. Its launch user data
     * carries this boot's enrollment nonce, so no attribute write is needed.
     */
    const replaceIntent = (
        p: Placement,
        deployment: LifecycleDeployment,
        next: { fenceToken: string; leaseEpoch: number; userData: string; instanceType: string },
    ): LifecycleIntent => ({
        schemaVersion: 1,
        jobId: newId(),
        computerId: p.computerId.toLowerCase(),
        revision: 1,
        operation: 'replace',
        targetGeneration: p.generation + 1,
        fenceToken: next.fenceToken,
        providerInstanceId: null,
        dataVolumeId: p.volumeId,
        previousGeneration: p.generation,
        previousInstanceId: p.instanceId,
        previousFenceToken: p.fenceToken,
        deployment,
        instanceType: next.instanceType,
        dataVolumeGiB: null,
        leaseEpoch: next.leaseEpoch,
        userData: next.userData,
    });

    /**
     * Build and start the job recorded on `p` (`startLifecycleJob`: idempotent retries).
     * - `started`: accepted.
     * - `failed`: AWS REFUSED it (nothing runs): undo the placement step that preceded it.
     * - `pending`: no attempt got an answer, so the execution may be running. The placement
     *   keeps its in-flight state and its job (the authority endpoint still authorizes it),
     *   marked `lifecycle_start_unknown:<undo>`: the receipt path follows the execution, or,
     *   once it is settled that none exists, moves it to `undo` (aws-receipts.ts).
     * A prebuilt `work` is started as is.
     */
    const launch = async (owner: string, p: Placement, intent: LifecycleIntent | LifecycleWork, undo: PlacementState): Promise<'started' | 'pending' | 'invalid' | 'failed'> => {
        const region = p.region!;
        let work: LifecycleWork;
        try {
            work = 'input' in intent ? intent : buildLifecycleWork(intent);
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
            await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: owner, expected: p, to: undo });
            return 'invalid';
        }
        const outcome = await startLifecycleJob(deps.starter!, region, work, deps.sleep);
        if (outcome === 'started') return 'started';
        if (outcome === 'refused') {
            await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: owner, expected: p, to: undo });
            return 'failed';
        }
        await markLifecycleStartUnknown(deps.db, { computerId: p.computerId, ownerUserId: owner, expected: p, undo });
        return 'pending';
    };

    const refusal = (reason: string): EnsureResult =>
        (CAPACITY_REFUSALS as readonly string[]).includes(reason) ? notReady('capacity_unavailable', false, reason) : notReady(reason);

    const reconcileDeps = () => ({ db: deps.db, executions: deps.executions, tunnels: deps.tunnels, describer: deps.describer, starter: deps.starter, newId, clock: now, now, sleep: deps.sleep, meter: deps.meter });

    /**
     * The caller's own placement, settled: its current receipt applied, then a
     * guest-initiated idle stop caught (aws-receipts.ts), then — unless `limits` is
     * off — a RUNNING one whose lease lapsed or whose hour cap is reached is stopped
     * (`enforceSessionLimits`). Returns it re-read, with the limit acted on.
     */
    const reconcileOwn = async (
        c: ComputerRef,
        p: Placement,
        deployments: Record<string, LifecycleDeployment>,
        e: Env,
        limits = true,
    ): Promise<{ placement: Placement; limit: SessionLimit | null }> => {
        const deployment = deployments[p.region ?? ''];
        if (!deployment || p.provider !== 'aws-ec2') return { placement: p, limit: null };
        await applyLifecycleReceipt(reconcileDeps(), p, deployment);
        let fresh = (await ownPlacement(c)) ?? p;
        if (await reconcileGuestStop(reconcileDeps(), fresh, deployment)) return { placement: (await ownPlacement(c)) ?? fresh, limit: null };
        if (!limits) return { placement: fresh, limit: null };
        const limit = await enforceSessionLimits(reconcileDeps(), fresh, deployment, { now: now(), caps: sessionLimitCaps(e) });
        if (limit) fresh = (await ownPlacement(c)) ?? fresh;
        return { placement: fresh, limit };
    };

    /**
     * Renew the lease of the caller's RUNNING placement from the owner's PRESENCE
     * (`presenceAt`): an explicit open, or an activity heartbeat whose presence is
     * fresher than `AWS_PRESENCE_FRESH_MS`. Never shortens a lease; writes only once
     * half of it is used, so a heartbeat a minute is not a write a minute. Returns the
     * placement as it now stands.
     */
    const renewLease = async (c: ComputerRef, p: Placement, presenceAt: Date): Promise<Placement> => {
        if (p.state !== 'RUNNING' || p.provider !== 'aws-ec2') return p;
        const t = now().getTime();
        if (t - presenceAt.getTime() >= AWS_PRESENCE_FRESH_MS) return p;
        const target = presenceAt.getTime() + leaseSeconds * 1000;
        const current = p.leaseUntil?.getTime() ?? -Infinity;
        if (current >= target || (current > t && current - t > (leaseSeconds * 1000) / 2)) return p;
        const r = await renewPlacementLease(deps.db, {
            computerId: p.computerId, ownerUserId: c.userId, expected: p, presenceAt, leaseUntil: new Date(Math.max(current, target)),
        });
        return r.ok ? r.placement : p;
    };

    /** A capacity refusal may be idle-stopped rows still counted as running: settle the fleet, then refuse. */
    const capacityRefusal = async (reason: string, deployments: Record<string, LifecycleDeployment>, e: Env): Promise<EnsureResult> => {
        if ((CAPACITY_REFUSALS as readonly string[]).includes(reason)) {
            await reconcileAwsFleet(reconcileDeps(), deployments, FLEET_RECONCILE_LIMIT, { now: now(), caps: sessionLimitCaps(e) });
        }
        return refusal(reason);
    };

    /** Stop the caller's RUNNING placement through the lifecycle. Not confirmed until its receipt marks it STOPPED. */
    const startStop = async (c: ComputerRef, p: Placement, deployment: LifecycleDeployment): Promise<StopResult> => {
        if (!p.instanceId || !p.volumeId || !p.fenceToken) return { ok: false, terminated: false, outcome: 'aws_placement_incomplete', error: 'aws_placement_incomplete' };
        let work: LifecycleWork;
        try {
            work = buildLifecycleWork(sameGenerationIntent(p, 'stop', deployment, { userData: null, leaseEpoch: p.leaseEpoch }));
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
            return { ok: false, terminated: false, outcome: 'aws_intent_invalid', error: 'aws_intent_invalid' };
        }
        // The stop's job and digest are recorded by the same compare-and-swap that starts draining.
        const draining = await transitionPlacement(deps.db, {
            computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'DRAINING',
            fields: { enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
        });
        if (!draining.ok) return { ok: false, terminated: false, outcome: 'cas_conflict' };
        const d = draining.placement;
        const r = await launch(c.userId, d, work, 'UNCONFIRMED');
        // Pending: the stop may be running; it stays DRAINING with its job for the receipt path.
        if (r === 'pending') return { ok: false, terminated: false, outcome: 'stopping' };
        if (r !== 'started') return { ok: false, terminated: false, outcome: r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed' };
        await transitionPlacement(deps.db, { computerId: d.computerId, ownerUserId: c.userId, expected: d, to: 'STOPPING' });
        return { ok: false, terminated: false, outcome: 'stopping' };
    };

    /**
     * Retire a STOPPED or RUNNING placement (§6, R11): the lifecycle stops a running
     * instance gracefully (OS shutdown, so the host flushes), terminates it and keeps
     * the data volume for the retention window. Not confirmed until its receipt marks it
     * RETIRED. A refused StartExecution puts it back to the state it came from.
     */
    const startRetire = async (c: ComputerRef, p: Placement, deployment: LifecycleDeployment): Promise<TerminateResult> => {
        if (!p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) {
            return { ok: false, terminated: false, outcome: 'aws_placement_incomplete', error: 'aws_placement_incomplete' };
        }
        let work: LifecycleWork;
        try {
            work = buildLifecycleWork(sameGenerationIntent(p, 'retire', deployment, { userData: null, leaseEpoch: p.leaseEpoch }));
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
            return { ok: false, terminated: false, outcome: 'aws_intent_invalid', error: 'aws_intent_invalid' };
        }
        const retiring = await transitionPlacement(deps.db, {
            computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'RETIRING',
            fields: { enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
        });
        if (!retiring.ok) return { ok: false, terminated: false, outcome: 'cas_conflict' };
        const r = await launch(c.userId, retiring.placement, work, p.state);
        // Pending counts as underway: the retire job is recorded and may be running.
        if (r !== 'started' && r !== 'pending') return { ok: false, terminated: false, outcome: r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed' };
        return { ok: false, terminated: false, outcome: AWS_RETIRING };
    };

    return {
        kind: 'aws-ec2',

        async ensure(_ctx, c) {
            const cfg = configured();
            if (!cfg.ok) return notReady(cfg.code);
            // Refuse before any write when a later step could not run.
            if (!deps.starter) return notReady('aws_lifecycle_unconfigured');
            const found = await ownPlacement(c);
            // Settle an existing placement first: a receipt may have landed, or its host idle-stopped itself.
            // An explicit open is the owner's presence: it renews the lease BEFORE the session limits
            // are checked, so only an hour cap (never a lapsed lease) can stop what the owner is opening.
            let placement = found && found.provider === 'aws-ec2' ? (await reconcileOwn(c, found, cfg.deployments, cfg.e, false)).placement : found;
            if (placement && placement.provider === 'aws-ec2' && placement.state === 'RUNNING') {
                placement = await renewLease(c, placement, now());
                const settled = await reconcileOwn(c, placement, cfg.deployments, cfg.e);
                if (settled.limit) return notReady(settled.limit);
                placement = settled.placement;
            }

            if (!placement) {
                if (deps.entitlement === undefined && !deps.tierFor) return notReady('aws_tier_unavailable');
                const enrollUrl = cfg.enrollUrl;
                if (!enrollUrl) return notReady('aws_enrollment_unavailable');
                let tier: AwsTier;
                try {
                    tier = deps.entitlement !== undefined
                        ? tierForEntitlement(deps.entitlement, plusPlanIds(cfg.e))
                        : await deps.tierFor!(c.userId);
                } catch {
                    return notReady('aws_tier_unavailable');
                }
                // Everything the provision's intent needs is known before the insert: an
                // AWS row starts at generation 1, lease epoch 1 (the provision is its first
                // lease; the first wake leases 2, C-3/C-4), and admission names the region.
                // So the intent is built INSIDE the admission transaction, and its job,
                // digest, fence and nonce hash are written by the same insert. An intent
                // the helper would refuse aborts the transaction: no row is ever written
                // without an execution to answer it.
                const computerId = c.computerId.toLowerCase();
                const fsUuid = newId();
                const fenceToken = newId();
                const nonce = issueEnrollmentNonce(now(), randomBytes);
                let work: LifecycleWork | undefined;
                let admitted;
                try {
                    admitted = await runAdmission(
                        deps.db,
                        {
                            kind: 'create',
                            userId: c.userId,
                            computerId: c.computerId,
                            tier,
                            fieldsFor: (region) => {
                                const deployment = cfg.deployments[region];
                                if (!deployment) throw new LifecycleIntentInvalidError();
                                const userData = buildEnrollmentUserData({
                                    computerId, volumeId: null, fsUuid, generation: 1, leaseEpoch: 1, nonce: nonce.nonce, provision: true, enrollUrl,
                                });
                                work = buildLifecycleWork({
                                    schemaVersion: 1, jobId: newId(), computerId, revision: 1, operation: 'provision', targetGeneration: 1, fenceToken,
                                    providerInstanceId: null, dataVolumeId: null, previousGeneration: null, previousInstanceId: null, previousFenceToken: null,
                                    deployment, instanceType: instanceTypeForTier(tier), dataVolumeGiB: AWS_TIER_DATA_GIB[tier], leaseEpoch: 1, userData,
                                });
                                return {
                                    zoneId: deployment.zoneId, fsUuid, fenceToken,
                                    enrollNonceHash: nonce.nonceHash, enrollExpiresAt: nonce.expiresAt, enrollConsumedHash: null,
                                    lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest,
                                    // The provision is the first lease: it has a deadline like every wake.
                                    leaseUntil: new Date(now().getTime() + leaseSeconds * 1000),
                                };
                            },
                        },
                        { env: cfg.e, now },
                    );
                } catch (error) {
                    if (error instanceof LifecycleIntentInvalidError || error instanceof EnrollmentUserDataError) return notReady('aws_intent_invalid');
                    throw error;
                }
                if (!admitted.admitted) return capacityRefusal(admitted.reason, cfg.deployments, cfg.e);
                const p = admitted.placement;
                // The row must be exactly what the intent was built for (generation 1, epoch 1).
                if (!work || p.generation !== 1 || p.leaseEpoch !== work.intent.leaseEpoch || p.lifecycleJobId !== work.intent.jobId) {
                    await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'UNCONFIRMED' });
                    return notReady('aws_intent_invalid');
                }
                const r = await launch(c.userId, p, work, 'UNCONFIRMED');
                return r === 'started' || r === 'pending'
                    ? notReady('computer_starting', true)
                    : notReady(r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed');
            }

            if (placement.provider !== 'aws-ec2') return notReady('provider_mismatch');
            let resizeTo: Exclude<AwsTier, 'free'> | undefined;
            if (placement.state === 'RUNNING' || placement.state === 'STOPPED' ||
                (placement.state === 'UNCONFIRMED' && placement.lastError === ENROLLMENT_FAILED)) {
                // Resolve the current paid plan on every open, including legacy callers
                // whose tier source is lazy. Missing/free entitlements do not resize AWS.
                try {
                    const tier = deps.entitlement !== undefined
                        ? tierForEntitlement(deps.entitlement, plusPlanIds(cfg.e))
                        : await deps.tierFor?.(c.userId);
                    if (tier && tier !== 'free' && instanceTypeForTier(tier) !== placement.instanceType) resizeTo = tier;
                } catch {
                    return notReady('aws_tier_unavailable');
                }
            }
            switch (placement.state) {
                case 'RUNNING':
                    if (!resizeTo) return { ok: true };
                    // The replace workflow gracefully stops the old running instance.
                    // Admission below credits its slot and reserves the new type atomically.
                    // falls through
                case 'UNCONFIRMED':
                case 'STOPPED': {
                    if (placement.state === 'UNCONFIRMED' && placement.lastError !== ENROLLMENT_FAILED) {
                        if (placement.lastError?.startsWith('capacity:')) return notReady('capacity_unavailable', false, placement.lastError);
                        return notReady('computer_recovering');
                    }
                    if (!placement.instanceId || !placement.volumeId || !placement.instanceType || !placement.region || !placement.fsUuid || !placement.fenceToken) {
                        return notReady('aws_placement_incomplete');
                    }
                    const enrollUrl = cfg.enrollUrl;
                    if (!enrollUrl) return notReady('aws_enrollment_unavailable');
                    // Region is sticky: the deployment is the placement's own region, never another.
                    const deployment = cfg.deployments[placement.region];
                    if (!deployment) return notReady('region_not_configured');
                    // A lost instance (INSTANCE_LOST: EC2 terminated it) can only come back as a REPLACE onto its volume.
                    const replace = resizeTo !== undefined || placement.lastError === ENROLLMENT_FAILED || placement.lastError === INSTANCE_LOST || cfg.wakeMode === 'replace';
                    const instanceType = resizeTo ? instanceTypeForTier(resizeTo) : placement.instanceType;
                    // The lease's compare-and-swap moves the epoch (and, for a replace, the
                    // generation) by exactly one, so this boot's intent is fully known BEFORE
                    // the lease and its job, digest, fence and nonce hash are written by that
                    // same statement. A lost race fails the CAS and nothing is started.
                    const leaseEpoch = placement.leaseEpoch + 1;
                    const generation = placement.generation + (replace ? 1 : 0);
                    const nonce = issueEnrollmentNonce(now(), randomBytes);
                    const fenceToken = replace ? newId() : placement.fenceToken;
                    let work: LifecycleWork;
                    try {
                        const userData = buildEnrollmentUserData({
                            computerId: placement.computerId, volumeId: placement.volumeId, fsUuid: placement.fsUuid, generation, leaseEpoch,
                            nonce: nonce.nonce, provision: false, enrollUrl,
                        });
                        work = buildLifecycleWork(
                            replace
                                ? replaceIntent(placement, deployment, { fenceToken, leaseEpoch, userData, instanceType })
                                : sameGenerationIntent(placement, 'start', deployment, { userData, leaseEpoch }),
                        );
                    } catch (error) {
                        if (error instanceof LifecycleIntentInvalidError || error instanceof EnrollmentUserDataError) return notReady('aws_intent_invalid');
                        throw error;
                    }
                    const leased = await runAdmission(
                        deps.db,
                        {
                            kind: 'lease',
                            userId: c.userId,
                            computerId: c.computerId,
                            expected: { generation: placement.generation, leaseEpoch: placement.leaseEpoch },
                            leaseUntil: new Date(now().getTime() + leaseSeconds * 1000),
                            replace,
                            resizeTo,
                            fields: {
                                fenceToken,
                                enrollNonceHash: nonce.nonceHash,
                                enrollExpiresAt: nonce.expiresAt,
                                enrollConsumedHash: null, // the previous epoch's proof never outlives it
                                lifecycleJobId: work.intent.jobId,
                                lifecycleDigest: work.digest,
                                lastError: null,
                            },
                        },
                        { env: cfg.e, now },
                    );
                    if (!leased.admitted) return leased.reason === 'cas_conflict'
                        ? notReady(resizeTo ? 'cas_conflict' : 'computer_starting', true)
                        : capacityRefusal(leased.reason, cfg.deployments, cfg.e);
                    const p = leased.placement;
                    // A replace cannot be undone by compare-and-swap (the generation already moved):
                    // a refused StartExecution leaves it for recovery (UNCONFIRMED). A start-in-place
                    // only moved the epoch, which a later wake simply raises again: back to STOPPED.
                    const undo: PlacementState = replace ? 'UNCONFIRMED' : 'STOPPED';
                    if (p.generation !== generation || p.leaseEpoch !== leaseEpoch || p.lifecycleJobId !== work.intent.jobId || p.instanceType !== instanceType) {
                        await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'UNCONFIRMED' });
                        return notReady('aws_intent_invalid');
                    }
                    const r = await launch(c.userId, p, work, undo);
                    if (resizeTo && (r === 'started' || r === 'pending')) await recordComputeMeter(() => deps.meter?.stopped({
                        userId: p.ownerUserId, computerId: p.computerId, endedAt: now(), reason: 'resize',
                    }));
                    // Pending: the boot may be running; it stays LEASED with its job for the receipt path.
                    if (r === 'pending') return notReady('computer_starting', true);
                    if (r !== 'started') return notReady(r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed');
                    await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'STARTING' });
                    return notReady('computer_starting', true);
                }
                default: {
                    const state = AWS_STATE_FOR[placement.state];
                    if (state === 'starting') return notReady('computer_starting', true);
                    if (state === 'stopping') return notReady('computer_stopping', true);
                    return notReady(placement.state === 'RECOVERING' ? 'computer_recovering' : 'computer_unavailable');
                }
            }
        },

        async status(_ctx, c) {
            const cfg = configured();
            if (!cfg.ok) return { ok: false, error: cfg.code };
            let p = await ownPlacement(c);
            if (!p || p.provider !== 'aws-ec2') return { ok: false, error: 'aws_placement_missing' };
            // A status poll is not presence: it renews nothing, and a lapsed lease or a reached cap stops here.
            p = (await reconcileOwn(c, p, cfg.deployments, cfg.e)).placement;
            const state = AWS_STATE_FOR[p.state];
            return { ok: state !== 'error', ...(state === 'error' ? { error: `placement_${p.state.toLowerCase()}` } : {}), state, placementState: p.state, region: p.region };
        },

        async stop(_ctx, c): Promise<StopResult> {
            const cfg = configured();
            if (!cfg.ok) return { ok: false, terminated: false, outcome: cfg.code, error: cfg.code };
            if (!deps.starter) return { ok: false, terminated: false, outcome: 'aws_lifecycle_unconfigured', error: 'aws_lifecycle_unconfigured' };
            const p = await ownPlacement(c);
            if (!p || p.provider !== 'aws-ec2') return { ok: false, terminated: false, outcome: 'aws_placement_missing', error: 'aws_placement_missing' };
            if (p.state === 'STOPPED') return { ok: true, terminated: false, outcome: 'already_stopped' };
            if (p.state !== 'RUNNING') return { ok: false, terminated: false, outcome: `placement_${p.state.toLowerCase()}` };
            const deployment = cfg.deployments[p.region ?? ''];
            if (!deployment) return { ok: false, terminated: false, outcome: 'region_not_configured', error: 'region_not_configured' };
            return startStop(c, p, deployment);
        },

        /**
         * The shell's activity heartbeat (`reportActivity`, every minute while the owner
         * is PRESENT: tab visible and focused). It is the control plane's lease renewal
         * source (GW-3: the host edge never renews leases): fresh presence renews the
         * lease, then the session limits are enforced, so an owner over the hour cap is
         * stopped within a beat. A release beat or stale presence renews nothing. The
         * host's own idle stop (600 s without gateway presence) is unchanged.
         */
        async activity(_ctx, c, s): Promise<ActivityResult> {
            const cfg = configured();
            if (!cfg.ok) return { ok: false, error: cfg.code };
            const found = await ownPlacement(c);
            if (!found || found.provider !== 'aws-ec2') return { ok: false, error: 'aws_placement_missing' };
            let p = (await reconcileOwn(c, found, cfg.deployments, cfg.e, false)).placement;
            if (p.state !== 'RUNNING') return { ok: false, error: `placement_${p.state.toLowerCase()}` };
            p = await renewLease(c, p, new Date(now().getTime() - s.lastInputAgoMs));
            const { limit } = await reconcileOwn(c, p, cfg.deployments, cfg.e);
            return limit ? { ok: false, error: limit } : { ok: true };
        },
        restart: async () => ({ ok: false, outcome: 'aws_not_supported', error: 'aws_not_supported' }),
        /**
         * computer.delete (§6, R11). ok only once nothing can still run: no placement
         * (never provisioned), or the placement RETIRED (instance terminated, volume
         * kept for the retention window). A RUNNING or STOPPED computer starts its
         * retire job here. `AWS_RETIREMENT_UNDERWAY` outcomes say a lifecycle job that
         * ends the instance is durably recorded on the placement: the delete may then
         * soft-delete, and the background reconcile (aws-receipts.ts
         * `reconcileDeletedAwsComputers`, run by the sandbox-reap cron) drives it to
         * RETIRED. An UNCONFIRMED/RECOVERING placement (a failed provision, a failed
         * job) is settled for the delete (`settleUnconfirmedAwsPlacement`): released when
         * EC2 shows it owns nothing (ok), or retired with a recorded job (retiring).
         * Every other state answers not-ready and the delete is refused.
         */
        async terminate(_ctx, c): Promise<TerminateResult> {
            const cfg = configured();
            if (!cfg.ok) return { ok: false, terminated: false, outcome: cfg.code, error: cfg.code };
            const found = await ownPlacement(c);
            if (!found) return { ok: true, terminated: true, outcome: 'no_placement' };
            if (found.provider !== 'aws-ec2') return { ok: false, terminated: false, outcome: 'provider_mismatch', error: 'provider_mismatch' };
            // A delete retires whatever the lease says: no session-limit stop first.
            const p = (await reconcileOwn(c, found, cfg.deployments, cfg.e, false)).placement;
            if (p.state === 'RETIRED' || p.state === 'PURGE_ELIGIBLE') return { ok: true, terminated: true, outcome: 'retired' };
            if (p.state === 'RUNNING' || p.state === 'STOPPED') {
                if (!deps.starter) return { ok: false, terminated: false, outcome: 'aws_lifecycle_unconfigured', error: 'aws_lifecycle_unconfigured' };
                const deployment = cfg.deployments[p.region ?? ''];
                if (!deployment) return { ok: false, terminated: false, outcome: 'region_not_configured', error: 'region_not_configured' };
                return startRetire(c, p, deployment);
            }
            if (p.state === 'UNCONFIRMED' || p.state === 'RECOVERING') {
                // Never soft-delete while an instance could still run with no job recorded:
                // released only on EC2's word that nothing exists, else a recorded retire job.
                const settled = await settleUnconfirmedAwsPlacement(reconcileDeps(), p, cfg.deployments[p.region ?? '']);
                if (settled === 'released') return { ok: true, terminated: true, outcome: 'released' };
                if (settled === 'retire_started') return { ok: false, terminated: false, outcome: AWS_RETIRING };
                return { ok: false, terminated: false, outcome: 'computer_recovering' };
            }
            const state = AWS_STATE_FOR[p.state];
            if (p.state === 'RETIRING' && p.lifecycleJobId) return { ok: false, terminated: false, outcome: AWS_RETIRING };
            // A recorded stop: once its receipt lands STOPPED, the reconcile retires a deleted computer.
            if ((p.state === 'DRAINING' || p.state === 'STOPPING') && p.lifecycleJobId) return { ok: false, terminated: false, outcome: AWS_RETIRE_AFTER_STOP };
            if (state === 'starting') return { ok: false, terminated: false, outcome: 'computer_starting' };
            if (state === 'stopping') return { ok: false, terminated: false, outcome: 'stopping' };
            return { ok: false, terminated: false, outcome: 'computer_unavailable' };
        },
    };
}
