import { randomUUID } from 'node:crypto';
import type { Env } from './aws-config';
import { awsSandboxId } from './aws-enroll';
import { isExecutionAbsent } from './aws-errors';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isPoolMode, lifecycleExecutionArn, LifecycleReceiptSchema, sessionEndWork, startLifecycleJob, type ReceiptDeps } from './aws-receipts';
import { ENROLLMENT_FAILED, failStalledPoolEnrollment, readCanaryComputer, withAdmission, writeLivePoolRecovery, type Placement, type PlacementDb } from './placement';
import { hasFailedPoolLease, isStalledPoolLease, markPoolHost, retirePoolLease } from './ready-pool';

export const ADOPT_STALL_MS = 180_000;
type Execution = Awaited<ReturnType<NonNullable<ReceiptDeps['executions']>['describe']>>;

function boundWork(p: Placement, e: Execution): LifecycleWork | null {
    try {
        const envelope = JSON.parse(e.input ?? '');
        const w = buildLifecycleWork(JSON.parse(envelope.document)), i = w.intent;
        return envelope.schemaVersion === 1 && JSON.parse(w.input).document === envelope.document
            && envelope.digest === w.digest && w.digest === p.lifecycleDigest && e.executionArn === lifecycleExecutionArn(i.deployment, i.jobId)
            && e.stateMachineVersionArn === w.stateMachineArn && !e.stateMachineAliasArn
            && i.jobId === p.lifecycleJobId && i.computerId === p.computerId && i.targetGeneration === p.generation
            && i.leaseEpoch === p.leaseEpoch && i.fenceToken === p.fenceToken && i.providerInstanceId === p.instanceId
            && (i.dataVolumeId === p.volumeId || (i.operation === 'adopt' && i.dataVolumeId === null && i.dataVolumeGiB !== null))
            && i.instanceType === p.instanceType
            && i.deployment.region === p.region && i.deployment.zoneId === p.zoneId && isPoolMode(i.deployment) ? w : null;
    } catch { return null; }
}

/** Called only after a successful, matching attach receipt, before session-ready. */
export async function failStalledPoolAdopt(deps: ReceiptDeps, p: Placement, e: Execution): Promise<boolean> {
    if (!deps.pool || !p.volumeId) return false;
    const work = boundWork(p, e);
    if (e.status !== 'SUCCEEDED' || work?.intent.operation !== 'adopt') return false;
    const at = (deps.now ?? deps.clock ?? (() => new Date()))();
    const id = work.intent.poolHostId!;
    if (!await isStalledPoolLease(deps.db, id, p, at, ADOPT_STALL_MS)) return false;
    const result = await failStalledPoolEnrollment(deps.db, p,
        tx => isStalledPoolLease(tx, id, p, at, ADOPT_STALL_MS, true),
        async tx => {
            if (!await markPoolHost(tx, id, ['leased'], 'retiring', at)) throw new Error('pool_stall_conflict');
        });
    return result.ok;
}

export async function isStalledPoolAdoptPending(deps: Pick<ReceiptDeps, 'db'>, p: Placement): Promise<boolean> {
    return p.state === 'UNCONFIRMED' && p.lastError === ENROLLMENT_FAILED
        && await hasFailedPoolLease(deps.db, p, 'retiring');
}

/** Adopted hosts carry claim tags: ordinary replacement accepts them only AFTER release.
 * Reserve one release under the existing enrollment-failure CAS; keep its job until
 * the receipt proves the retained volume detached. Missing starts replay the same job. */
export async function reconcileStalledPoolAdopt(deps: ReceiptDeps, p: Placement, d: LifecycleDeployment): Promise<boolean> {
    if (!await isStalledPoolAdoptPending(deps, p)) return false;
    if (!deps.pool || !deps.executions || !deps.starter || !p.lifecycleJobId || !p.lifecycleDigest || !p.region || !isPoolMode(d)) return true;
    let execution: Execution;
    try { execution = await deps.executions.describe(p.region, lifecycleExecutionArn(d, p.lifecycleJobId)); }
    catch (error) {
        if (!isExecutionAbsent(error)) return true;
        const work = sessionEndWork(p, d, p.lifecycleJobId, deps.pool);
        if (work.digest !== p.lifecycleDigest) return true;
        // One retry per observed revision; StartExecution also deduplicates by name/input.
        const retry = await writeLivePoolRecovery(deps.db, p, 'UNCONFIRMED', {});
        if (retry.ok) await startLifecycleJob(deps.starter, p.region, work, deps.sleep);
        return true;
    }
    const work = boundWork(p, execution);
    if (!work) return true;
    if (work.intent.operation === 'adopt' && execution.status === 'SUCCEEDED') {
        const release = sessionEndWork(p, d, randomUUID(), deps.pool);
        const reserved = await writeLivePoolRecovery(deps.db, p, 'UNCONFIRMED', {
            lifecycleJobId: release.intent.jobId, lifecycleDigest: release.digest,
        });
        if (reserved.ok) await startLifecycleJob(deps.starter, p.region, release, deps.sleep);
        return true;
    }
    if (work.intent.operation !== 'release' || execution.status !== 'SUCCEEDED') return true;
    let receipt;
    try { receipt = LifecycleReceiptSchema.parse(JSON.parse(execution.output ?? '')); } catch { return true; }
    if (receipt.jobId !== p.lifecycleJobId || receipt.digest !== p.lifecycleDigest || receipt.computerId !== p.computerId
        || receipt.generation !== p.generation || receipt.leaseEpoch !== p.leaseEpoch || receipt.fenceToken !== p.fenceToken
        || receipt.instanceId !== p.instanceId || receipt.volumeId !== p.volumeId || receipt.state !== 'retired') return true;
    if (deps.tunnels) {
        const fenced = await deps.tunnels.deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId,
            sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch }).catch(() => ({ ok: false }));
        if (!fenced.ok) return true;
    }
    await withAdmission(deps.db, async tx => {
        const scoped: PlacementDb = { execute: query => tx.execute(query), transaction: fn => fn(tx) };
        const settled = await writeLivePoolRecovery(scoped, p, 'UNCONFIRMED', { lifecycleJobId: null, lifecycleDigest: null });
        if (settled.ok) await retirePoolLease(tx, p);
    });
    return true;
}

/** The minute fleet pass retries admission even after a previous capacity refusal. */
export async function replaceStalledPoolAdopt(deps: ReceiptDeps, p: Placement, env: Env): Promise<void> {
    if (p.state !== 'UNCONFIRMED' || p.lastError !== ENROLLMENT_FAILED || p.lifecycleJobId !== null
        || !await hasFailedPoolLease(deps.db, p, 'retired')) return;
    const computer = await readCanaryComputer(deps.db, p.computerId);
    if (!computer || computer.deleted || computer.userId !== p.ownerUserId) return;
    const { createAwsEc2Provider } = await import('./aws-ec2');
    await createAwsEc2Provider({ ...deps, env: () => env, now: deps.now ?? deps.clock,
        recoveryExpected: { generation: p.generation, leaseEpoch: p.leaseEpoch } }).ensure(
        { correlationId: 'pool-adopt-stall' }, { computerId: p.computerId, userId: p.ownerUserId },
        { sessionId: 'pool-adopt-stall', desktopMode: 'neko' });
}
