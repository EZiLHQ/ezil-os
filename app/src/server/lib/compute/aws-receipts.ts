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

import { z } from 'zod';

import { AWS_TIERS, type AwsTier } from './aws-config';
import { awsSandboxId, type TunnelClient } from './aws-enroll';
import type { LifecycleDeployment } from './aws-intent';
import { transitionPlacementAsReconciler, type Placement, type PlacementDb, type PlacementFields, type PlacementState } from './placement';

/** Read-only `DescribeExecution` in the placement's region (Step Functions). */
export interface LifecycleExecutionReader {
    describe(region: string, executionArn: string): Promise<{ status: string; output?: string | null; error?: string | null; cause?: string | null }>;
}

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
 * provider receipt arrived AND its host enrolled (the nonce was consumed).
 */
export async function applyLifecycleReceipt(deps: ReceiptDeps, p0: Placement, deployment: LifecycleDeployment): Promise<void> {
    const step = async (p: Placement, to: PlacementState, fields: PlacementFields = {}): Promise<Placement | null> => {
        const r = await transitionPlacementAsReconciler(deps.db, { computerId: p.computerId, expected: p, to, fields });
        return r.ok ? r.placement : null;
    };
    let p: Placement | null = p0;
    const enrolled = (x: Placement) => x.enrollNonceHash === null && x.instanceId !== null;
    // A receipt already applied (job cleared): MOUNTING waits only for the host's enrollment.
    if (p.state === 'MOUNTING' && p.lifecycleJobId === null) {
        if (enrolled(p)) await step(p, 'RUNNING');
        return;
    }
    const waiting: readonly PlacementState[] = ['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING'];
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
        r.state !== (stopping ? 'stopped' : 'running') ||
        (p.volumeId !== null && r.volumeId !== p.volumeId) ||
        // A stop names the generation's own instance; a boot the host already enrolled names the instance it proved.
        ((stopping || enrolled(p)) && r.instanceId !== p.instanceId);
    if (conflict) {
        await step(p, 'UNCONFIRMED', { lastError: 'receipt_conflict' });
        return;
    }
    const done: PlacementFields = { instanceId: r.instanceId, volumeId: r.volumeId, lifecycleJobId: null, lifecycleDigest: null, lastError: null };
    if (stopping) {
        if (p.state === 'DRAINING') p = await step(p, 'STOPPING');
        if (p) p = await step(p, 'STOPPED', done);
        // Fence: the stopped generation's tunnel goes (GW-1 DELETE). A later epoch also fences it first.
        if (p && deps.tunnels) {
            await deps.tunnels
                .deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId.toLowerCase(), sandboxId: awsSandboxId(p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch })
                .catch(() => ({ ok: false }));
        }
        return;
    }
    if (p.state === 'PROVISIONING') {
        // PROVISIONING has no MOUNTING edge: the first boot goes RUNNING once its host enrolled.
        if (enrolled(p)) await step(p, 'RUNNING', done);
        return;
    }
    if (p.state === 'LEASED') p = await step(p, 'STARTING');
    if (p && p.state === 'STARTING') p = await step(p, 'MOUNTING', done);
    if (p && p.state === 'MOUNTING' && enrolled(p)) await step(p, 'RUNNING', p.lifecycleJobId === null ? {} : done);
}
