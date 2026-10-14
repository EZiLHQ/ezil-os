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
import { buildEnrollmentUserData, EnrollmentUserDataError, issueEnrollmentNonce, type TunnelClient } from './aws-enroll';
import {
    buildLifecycleWork,
    LifecycleIntentInvalidError,
    readLifecycleDeployments,
    type LifecycleDeployment,
    type LifecycleIntent,
    type LifecycleOperation,
    type LifecycleWork,
} from './aws-intent';
import { ENROLLMENT_FAILED, PlacementOwnerError, readPlacement, transitionPlacement, type Placement, type PlacementDb, type PlacementState } from './placement';
import { applyLifecycleReceipt, type LifecycleExecutionReader } from './aws-receipts';
import type { ComputeCtx, ComputeProvider, ComputeStatus, ComputerRef, EnsureResult, StopResult } from './provider';

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

export interface AwsProviderDeps {
    db: PlacementDb;
    env?: () => Env;
    now?: () => Date;
    /** Lower-case uuid v4. */
    newId?: () => string;
    starter?: LifecycleStarter;
    /** The user's entitlement (free / plus). Never defaulted. */
    tierFor?: (userId: string) => Promise<AwsTier>;
    /** Source of the enrollment nonce's 32 bytes (tests make it deterministic). */
    randomBytes?: (n: number) => Buffer;
    /** Reads lifecycle executions so `status` can apply their receipts. Without it nothing is reconciled. */
    executions?: LifecycleExecutionReader;
    /** GW-1, to fence (delete) a stopped generation's tunnel. */
    tunnels?: TunnelClient;
    /** Lease length on a wake. */
    leaseSeconds?: number;
}

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

    /**
     * A start or stop of the placement's CURRENT generation. Its fence token is the
     * one that generation's instance and volume are tagged with (`fenceToken`):
     * the helper refuses any other (`lifecycle_volume_invalid`), so it is never
     * re-minted here.
     */
    const sameGenerationIntent = (
        p: Placement,
        operation: Extract<LifecycleOperation, 'start' | 'stop'>,
        deployment: LifecycleDeployment,
        extra: { userData: string | null; leaseEpoch: number },
    ): LifecycleIntent => ({
        schemaVersion: 1,
        jobId: newId(),
        computerId: p.computerId.toLowerCase(),
        revision: 1,
        operation,
        targetGeneration: p.generation,
        fenceToken: p.fenceToken!,
        providerInstanceId: p.instanceId,
        dataVolumeId: p.volumeId,
        previousGeneration: null,
        previousInstanceId: null,
        previousFenceToken: null,
        deployment,
        instanceType: p.instanceType ?? '',
        dataVolumeGiB: null,
        leaseEpoch: extra.leaseEpoch,
        userData: extra.userData,
    });

    /**
     * Wake by REPLACE (C-3): a new instance of the placement's type boots on the
     * retained data volume as generation + 1, with a fresh fence token. The old
     * generation's instance, generation and fence are handed on as `previous*`;
     * the helper stops and terminates it, never the volume. Its launch user data
     * carries this boot's enrollment nonce, so no attribute write is needed.
     */
    const replaceIntent = (
        p: Placement,
        deployment: LifecycleDeployment,
        next: { fenceToken: string; leaseEpoch: number; userData: string },
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
        instanceType: p.instanceType ?? '',
        dataVolumeGiB: null,
        leaseEpoch: next.leaseEpoch,
        userData: next.userData,
    });

    /** Build and start; on any failure undo the placement step that preceded it. A prebuilt `work` is started as is. */
    const launch = async (owner: string, p: Placement, intent: LifecycleIntent | LifecycleWork, undo: PlacementState): Promise<'started' | 'invalid' | 'failed'> => {
        const region = p.region!;
        let work: LifecycleWork;
        try {
            work = 'input' in intent ? intent : buildLifecycleWork(intent);
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
            await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: owner, expected: p, to: undo });
            return 'invalid';
        }
        try {
            await deps.starter!.start(region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
        } catch {
            await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: owner, expected: p, to: undo });
            return 'failed';
        }
        return 'started';
    };

    const refusal = (reason: string): EnsureResult =>
        (CAPACITY_REFUSALS as readonly string[]).includes(reason) ? notReady('capacity_unavailable', false, reason) : notReady(reason);

    return {
        kind: 'aws-ec2',

        async ensure(_ctx, c) {
            const cfg = configured();
            if (!cfg.ok) return notReady(cfg.code);
            // Refuse before any write when a later step could not run.
            if (!deps.starter) return notReady('aws_lifecycle_unconfigured');
            const placement = await ownPlacement(c);

            if (!placement) {
                if (!deps.tierFor) return notReady('aws_tier_unavailable');
                const enrollUrl = cfg.enrollUrl;
                if (!enrollUrl) return notReady('aws_enrollment_unavailable');
                let tier: AwsTier;
                try {
                    tier = await deps.tierFor(c.userId);
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
                                    enrollNonceHash: nonce.nonceHash, enrollExpiresAt: nonce.expiresAt,
                                    lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest,
                                };
                            },
                        },
                        { env: cfg.e, now },
                    );
                } catch (error) {
                    if (error instanceof LifecycleIntentInvalidError || error instanceof EnrollmentUserDataError) return notReady('aws_intent_invalid');
                    throw error;
                }
                if (!admitted.admitted) return refusal(admitted.reason);
                const p = admitted.placement;
                // The row must be exactly what the intent was built for (generation 1, epoch 1).
                if (!work || p.generation !== 1 || p.leaseEpoch !== work.intent.leaseEpoch || p.lifecycleJobId !== work.intent.jobId) {
                    await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'UNCONFIRMED' });
                    return notReady('aws_intent_invalid');
                }
                const r = await launch(c.userId, p, work, 'UNCONFIRMED');
                return r === 'started' ? notReady('computer_starting', true) : notReady(r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed');
            }

            if (placement.provider !== 'aws-ec2') return notReady('provider_mismatch');
            switch (placement.state) {
                case 'RUNNING':
                    return { ok: true };
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
                    const replace = placement.lastError === ENROLLMENT_FAILED || cfg.wakeMode === 'replace';
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
                                ? replaceIntent(placement, deployment, { fenceToken, leaseEpoch, userData })
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
                            fields: {
                                fenceToken,
                                enrollNonceHash: nonce.nonceHash,
                                enrollExpiresAt: nonce.expiresAt,
                                lifecycleJobId: work.intent.jobId,
                                lifecycleDigest: work.digest,
                                lastError: null,
                            },
                        },
                        { env: cfg.e, now },
                    );
                    if (!leased.admitted) return leased.reason === 'cas_conflict' ? notReady('computer_starting', true) : refusal(leased.reason);
                    const p = leased.placement;
                    // A replace cannot be undone by compare-and-swap (the generation already moved):
                    // a refused StartExecution leaves it for recovery (UNCONFIRMED). A start-in-place
                    // only moved the epoch, which a later wake simply raises again: back to STOPPED.
                    const undo: PlacementState = replace ? 'UNCONFIRMED' : 'STOPPED';
                    if (p.generation !== generation || p.leaseEpoch !== leaseEpoch || p.lifecycleJobId !== work.intent.jobId) {
                        await transitionPlacement(deps.db, { computerId: p.computerId, ownerUserId: c.userId, expected: p, to: 'UNCONFIRMED' });
                        return notReady('aws_intent_invalid');
                    }
                    const r = await launch(c.userId, p, work, undo);
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
            const deployment = cfg.deployments[p.region ?? ''];
            if (deployment) {
                await applyLifecycleReceipt({ db: deps.db, executions: deps.executions, tunnels: deps.tunnels }, p, deployment);
                p = (await ownPlacement(c)) ?? p;
            }
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
            if (!p.instanceId || !p.volumeId || !p.fenceToken) return { ok: false, terminated: false, outcome: 'aws_placement_incomplete', error: 'aws_placement_incomplete' };
            const deployment = cfg.deployments[p.region ?? ''];
            if (!deployment) return { ok: false, terminated: false, outcome: 'region_not_configured', error: 'region_not_configured' };
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
                fields: { lifecycleJobId: work.intent.jobId, lifecycleDigest: work.digest, lastError: null },
            });
            if (!draining.ok) return { ok: false, terminated: false, outcome: 'cas_conflict' };
            const d = draining.placement;
            const r = await launch(c.userId, d, work, 'UNCONFIRMED');
            if (r !== 'started') return { ok: false, terminated: false, outcome: r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed' };
            await transitionPlacement(deps.db, { computerId: d.computerId, ownerUserId: c.userId, expected: d, to: 'STOPPING' });
            // Not confirmed until the execution's receipt marks the placement STOPPED.
            return { ok: false, terminated: false, outcome: 'stopping' };
        },

        // Presence on AWS is reported by the host agent through the tunnel (P5); the
        // reaper never stops an AWS computer (the host idle-stops itself).
        activity: async () => ({ ok: false, error: 'aws_not_supported' }),
        restart: async () => ({ ok: false, outcome: 'aws_not_supported', error: 'aws_not_supported' }),
        // Retire keeps the volume (§6); it lands with the retire intent and the retention flow.
        terminate: async () => ({ ok: false, terminated: false, outcome: 'aws_not_supported', error: 'aws_not_supported' }),
    };
}
