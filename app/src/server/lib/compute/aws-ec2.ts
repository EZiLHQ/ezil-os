/**
 * aws-ec2 provider (docs/AWS-COMPUTERS.md C-1, C-3).
 *
 * Two shapes:
 * - `createAwsEc2StubProvider`: no database. Refuses `aws_disabled` with the
 *   flag off and throws `AwsProviderNotImplementedError` with it on.
 * - `createAwsEc2Provider`: the real lifecycle path. It reads and writes
 *   placements only through `placement.ts`/`admission.ts`, and starts
 *   lifecycle executions only through an injected `LifecycleStarter`. With a
 *   missing starter, tier source or enrollment issuer it refuses BEFORE any
 *   write (`aws_lifecycle_unconfigured`, `aws_tier_unavailable`,
 *   `aws_enrollment_unavailable`), so a half-configured deployment never
 *   leaves a placement without an execution.
 *
 * Persistence model: the computer's disk is a retained EBS data volume.
 * Stop/idle = instance stopped (no running services; EBS only). Wake = cold
 * boot of the same instance on the same volume. Running processes and RAM
 * are NOT preserved. A wake stays in the placement's region: a full region
 * answers `capacity_unavailable`, it never moves the computer.
 */

import { randomUUID } from 'node:crypto';

import { runAdmission, type AdmissionRefusal } from './admission';
import { AWS_TIER_DATA_GIB, isAwsComputersEnabled, readAwsAdmissionConfig, type AwsTier, type Env } from './aws-config';
import { buildLifecycleWork, LifecycleIntentInvalidError, readLifecycleDeployments, type LifecycleDeployment, type LifecycleIntent, type LifecycleOperation } from './aws-intent';
import { PlacementOwnerError, readPlacement, transitionPlacement, type Placement, type PlacementDb, type PlacementState } from './placement';
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

/** C-6 one-time enrollment material for a launch (host agent `enroll.py`). Lane A3. */
export interface EnrollmentIssuer {
    issue(placement: Placement): Promise<{ userData: string }>;
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
    enrollment?: EnrollmentIssuer;
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

    /** Flag, admission config and every configured region's deployment, or the refusal code. */
    const configured = (): { ok: true; e: Env; deployments: Record<string, LifecycleDeployment> } | { ok: false; code: string } => {
        const e = env();
        if (!isAwsComputersEnabled(e)) return { ok: false, code: AWS_DISABLED };
        const config = readAwsAdmissionConfig(e);
        if (!config.enabled) return { ok: false, code: config.reason };
        const d = readLifecycleDeployments(e, config.regions.map((r) => r.name));
        if (!d.ok) return { ok: false, code: 'aws_config_invalid' };
        return { ok: true, e, deployments: d.deployments };
    };

    /** The caller's own aws-ec2 placement, or null when there is none. Another owner is NOT_FOUND upstream. */
    const ownPlacement = async (c: ComputerRef): Promise<Placement | null> => {
        const { record } = await readPlacement(deps.db, c.computerId);
        if (record && record.ownerUserId !== c.userId.toLowerCase()) throw new PlacementOwnerError(record.computerId);
        return record;
    };

    const intentFor = (
        p: Placement,
        operation: LifecycleOperation,
        deployment: LifecycleDeployment,
        extra: { userData: string | null; dataVolumeGiB: number | null; leaseEpoch: number },
    ): LifecycleIntent => ({
        schemaVersion: 1,
        jobId: newId(),
        computerId: p.computerId.toLowerCase(),
        revision: 1,
        operation,
        targetGeneration: p.generation,
        fenceToken: newId(),
        providerInstanceId: operation === 'provision' ? null : p.instanceId,
        dataVolumeId: operation === 'provision' ? null : p.volumeId,
        previousGeneration: null,
        previousInstanceId: null,
        previousFenceToken: null,
        deployment,
        instanceType: p.instanceType ?? '',
        dataVolumeGiB: extra.dataVolumeGiB,
        leaseEpoch: extra.leaseEpoch,
        userData: extra.userData,
    });

    /** Build and start; on any failure undo the placement step that preceded it. */
    const launch = async (p: Placement, intent: LifecycleIntent, undo: PlacementState): Promise<'started' | 'invalid' | 'failed'> => {
        const region = p.region!;
        let work;
        try {
            work = buildLifecycleWork(intent);
        } catch (error) {
            if (!(error instanceof LifecycleIntentInvalidError)) throw error;
            await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: undo });
            return 'invalid';
        }
        try {
            await deps.starter!.start(region, { stateMachineArn: work.stateMachineArn, name: work.name, input: work.input });
        } catch {
            await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: undo });
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
                if (!deps.tierFor || !deps.enrollment) return notReady(deps.tierFor ? 'aws_enrollment_unavailable' : 'aws_tier_unavailable');
                let tier: AwsTier;
                try {
                    tier = await deps.tierFor(c.userId);
                } catch {
                    return notReady('aws_tier_unavailable');
                }
                const admitted = await runAdmission(deps.db, { kind: 'create', userId: c.userId, computerId: c.computerId, tier }, { env: cfg.e, now });
                if (!admitted.admitted) return refusal(admitted.reason);
                const p = admitted.placement;
                let userData: string;
                try {
                    ({ userData } = await deps.enrollment.issue(p));
                } catch {
                    await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: 'UNCONFIRMED' });
                    return notReady('aws_enrollment_unavailable');
                }
                // A provision is the computer's first lease: the row was created at epoch 1 and the
                // intent carries exactly the row's epoch, so the first wake leases 2 (C-3/C-4).
                const intent = intentFor(p, 'provision', cfg.deployments[p.region!]!, { userData, dataVolumeGiB: AWS_TIER_DATA_GIB[tier], leaseEpoch: p.leaseEpoch });
                const r = await launch(p, intent, 'UNCONFIRMED');
                return r === 'started' ? notReady('computer_starting', true) : notReady(r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed');
            }

            if (placement.provider !== 'aws-ec2') return notReady('provider_mismatch');
            switch (placement.state) {
                case 'RUNNING':
                    return { ok: true };
                case 'STOPPED': {
                    if (!placement.instanceId || !placement.volumeId || !placement.instanceType || !placement.region) return notReady('aws_placement_incomplete');
                    const leased = await runAdmission(
                        deps.db,
                        {
                            kind: 'lease',
                            userId: c.userId,
                            computerId: c.computerId,
                            expected: { generation: placement.generation, leaseEpoch: placement.leaseEpoch },
                            leaseUntil: new Date(now().getTime() + leaseSeconds * 1000),
                        },
                        { env: cfg.e, now },
                    );
                    if (!leased.admitted) return leased.reason === 'cas_conflict' ? notReady('computer_starting', true) : refusal(leased.reason);
                    const p = leased.placement;
                    // Region is sticky: the deployment is the placement's own region, never another.
                    const deployment = cfg.deployments[p.region!];
                    if (!deployment) {
                        await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: 'STOPPED' });
                        return notReady('region_not_configured');
                    }
                    const r = await launch(p, intentFor(p, 'start', deployment, { userData: null, dataVolumeGiB: null, leaseEpoch: p.leaseEpoch }), 'STOPPED');
                    if (r !== 'started') return notReady(r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed');
                    await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: 'STARTING' });
                    return notReady('computer_starting', true);
                }
                default: {
                    const state = AWS_STATE_FOR[placement.state];
                    if (state === 'starting') return notReady('computer_starting', true);
                    if (state === 'stopping') return notReady('computer_stopping', true);
                    return notReady(placement.state === 'UNCONFIRMED' || placement.state === 'RECOVERING' ? 'computer_recovering' : 'computer_unavailable');
                }
            }
        },

        async status(_ctx, c) {
            const cfg = configured();
            if (!cfg.ok) return { ok: false, error: cfg.code };
            const p = await ownPlacement(c);
            if (!p || p.provider !== 'aws-ec2') return { ok: false, error: 'aws_placement_missing' };
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
            const draining = await transitionPlacement(deps.db, { computerId: p.computerId, expected: p, to: 'DRAINING' });
            if (!draining.ok) return { ok: false, terminated: false, outcome: 'cas_conflict' };
            const d = draining.placement;
            const r = await launch(d, intentFor(d, 'stop', deployment, { userData: null, dataVolumeGiB: null, leaseEpoch: d.leaseEpoch }), 'UNCONFIRMED');
            if (r !== 'started') return { ok: false, terminated: false, outcome: r === 'invalid' ? 'aws_intent_invalid' : 'aws_lifecycle_start_failed' };
            await transitionPlacement(deps.db, { computerId: d.computerId, expected: d, to: 'STOPPING' });
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
