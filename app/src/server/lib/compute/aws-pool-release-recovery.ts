import { randomUUID } from 'node:crypto';
import { reconcileAdoptRecovery } from './aws-pool-recovery';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import { awsSandboxId } from './aws-enroll';
import { isExecutionAbsent } from './aws-errors';
import { buildLifecycleWork, currentGenerationIntent, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isPoolMode, lifecycleExecutionArn, LifecycleReceiptSchema, POOL_RELEASED, startLifecycleJob,
    USAGE_OBSERVER, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { readCanaryComputer, writeLivePoolRecovery, type Placement } from './placement';

const PREFIX = 'pool_release_recovery:';
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
type Replay = { intent: LifecycleWork['intent']; stoppedAt: string | null; sourceJobId: string; error: string | null;
    basis?: 'ec2_state_transition' | 'recovery_success'; sourceStartedAt?: string };
function replay(p: Placement): Replay | null {
    try { return p.lastError?.startsWith(PREFIX) ? JSON.parse(p.lastError.slice(PREFIX.length)) : null; }
    catch { return null; }
}
export const isPoolReleaseRecovering = (p: Placement): boolean => p.state === 'RECOVERING' && !!replay(p)?.intent;

function boundedTime(at: Date | null | undefined, start: Date | null | undefined, now: Date): at is Date {
    return !!at && !!start && Number.isFinite(at.getTime()) && Number.isFinite(start.getTime())
        && at >= start && at <= now;
}

function executionWork(e: Execution): LifecycleWork | null {
    try {
        const envelope = JSON.parse(e.input ?? '');
        const work = buildLifecycleWork(JSON.parse(envelope.document));
        return envelope.schemaVersion === 1 && envelope.digest === work.digest
            && JSON.parse(work.input).document === envelope.document ? work : null;
    } catch { return null; }
}
function matches(p: Placement, work: LifecycleWork): boolean {
    const i = work.intent;
    return work.digest === p.lifecycleDigest && i.jobId === p.lifecycleJobId && i.computerId === p.computerId
        && i.targetGeneration === p.generation && i.leaseEpoch === p.leaseEpoch && i.fenceToken === p.fenceToken
        && i.providerInstanceId === p.instanceId && i.dataVolumeId === p.volumeId && i.instanceType === p.instanceType
        && i.deployment.region === p.region && i.deployment.zoneId === p.zoneId;
}
export { replay as poolReleaseReplay, matches as matchesPoolReleaseRecovery };
function executionMatches(e: Execution, work: LifecycleWork): boolean {
    return !e.stateMachineAliasArn && e.redriveCount === 0
        && e.executionArn === lifecycleExecutionArn(work.intent.deployment, work.intent.jobId)
        && e.stateMachineVersionArn === work.stateMachineArn;
}
function ownedTags(tags: Record<string, string> | undefined, p: Placement, d: LifecycleDeployment): boolean {
    if (!tags || tags['ezil:managed-by'] !== 'app-computer-platform' || tags['ezil:stage'] !== d.namespace
        || tags['ezil:generation'] !== String(p.generation)) return false;
    return ((tags['ezil:computer-id'] === p.computerId && tags['ezil:fence-token'] === p.fenceToken)
        || (tags['ezil:computer'] === p.computerId && tags['ezil:fence'] === p.fenceToken))
        && Object.entries({ 'ezil:computer-id': p.computerId, 'ezil:computer': p.computerId,
            'ezil:fence-token': p.fenceToken, 'ezil:fence': p.fenceToken }).every(([k, v]) => tags[k] === undefined || tags[k] === v);
}
async function resourceEvidence(deps: ReceiptDeps, p: Placement, d: LifecycleDeployment, released: boolean): Promise<{ error: string | null; stoppedAt?: Date | null }> {
    if (!deps.describer?.describeVolume) return { error: 'describer_missing' };
    const volume = await deps.describer.describeVolume(p.region!, p.volumeId!);
    if (!volume || volume.volumeId !== p.volumeId || !ownedTags(volume.tags, p, d)
        || volume.encrypted !== true || volume.kmsKeyId !== d.dataKeyArn || volume.zoneId !== p.zoneId) return { error: 'volume_identity' };
    if (released) return { error: volume.state === 'available' && volume.attachments?.length === 0 ? null : 'volume_not_available' };
    if (volume.state !== 'in-use' || volume.attachments?.length !== 1
        || volume.attachments[0].instanceId !== p.instanceId || volume.attachments[0].state !== 'attached') return { error: 'volume_attachment' };
    const host = await deps.describer.describeForEnrollment(p.region!, p.instanceId!);
    if (!host || host.instanceId !== p.instanceId || host.state !== 'stopped' || host.instanceType !== p.instanceType
        || host.availabilityZoneId !== p.zoneId || !ownedTags(host.tags, p, d) || host.tags['ezil:pool'] !== undefined) return { error: 'instance_identity' };
    const rootName = d.storage.rootDeviceName ?? '/dev/sda1';
    const root = host.volumes.filter(v => v.deviceName === rootName && v.volumeId !== p.volumeId && v.deleteOnTermination);
    const data = host.volumes.filter(v => v.volumeId === p.volumeId && !v.deleteOnTermination && v.deviceName !== rootName);
    return { error: host.rootDeviceName === rootName && host.volumes.length === 2 && root.length === 1 && data.length === 1 ? null : 'instance_disks',
        stoppedAt: host.stateTransitionAt };
}

/** Recover only positively identified, stopped resources of a terminally failed stop.
 * The replay document is written WITH the new job CAS, before StartExecution. It
 * contains no boot secret and survives process loss, deployment changes and retries.
 */
export async function reconcilePoolReleaseRecovery(deps: ReceiptDeps, p: Placement, d: LifecycleDeployment): Promise<boolean> {
    if (await reconcileAdoptRecovery(deps, p, d)) return true;
    if (p.provider !== 'aws-ec2' || !isPoolMode(d) || !['UNCONFIRMED', 'RECOVERING'].includes(p.state)) return false;
    if (p.state === 'UNCONFIRMED' && (!p.lifecycleJobId || !p.lifecycleDigest)) return false;
    const saved = replay(p);
    const now = deps.now ?? deps.clock ?? (() => new Date());
    if (p.state === 'RECOVERING' && !saved?.intent) return false; // Deleted/image recovery owns other RECOVERING rows.
    const computer = await readCanaryComputer(deps.db, p.computerId);
    if (!computer || computer.deleted || computer.userId !== p.ownerUserId) return false;
    const fail = async (error: string, to: 'UNCONFIRMED' | 'RECOVERING' = 'UNCONFIRMED') => {
        const lastError = PREFIX + JSON.stringify(saved?.intent ? { ...saved, error } : { error });
        if (p.state !== to || p.lastError !== lastError) await writeLivePoolRecovery(deps.db, p, to, { lastError });
        return true;
    };
    // Release and stop always name their host. A placement without one (a cold replace or provision,
    // whose admission cleared instance_id) belongs to the other recovery handlers.
    if (!p.instanceId && !saved?.intent) return false;
    if (!p.lifecycleJobId || !p.lifecycleDigest || !p.region || !p.instanceId || !p.volumeId || !p.fenceToken) return fail('placement_identity');
    if (!deps.executions) return fail('execution_reader_missing');
    let planned: LifecycleWork | null = null;
    if (saved?.intent) {
        try { planned = buildLifecycleWork(saved.intent); } catch { return fail('replay_invalid'); }
        if (planned.intent.operation !== 'release' || !matches(p, planned)
            || (saved.basis !== 'recovery_success' && !Number.isFinite(Date.parse(saved.stoppedAt ?? '')))) return fail('replay_identity');
    }
    let e: Execution;
    try {
        e = await deps.executions.describe(p.region, lifecycleExecutionArn(planned?.intent.deployment ?? d, p.lifecycleJobId));
    } catch (error) {
        if (p.state === 'RECOVERING' && planned && isExecutionAbsent(error)) {
            if (!deps.starter) return fail('starter_missing', 'RECOVERING');
            const outcome = await startLifecycleJob(deps.starter, p.region, planned, deps.sleep);
            if (outcome !== 'started') await fail('start_' + outcome, 'RECOVERING');
            return true;
        }
        return fail('execution_unavailable', p.state === 'RECOVERING' ? 'RECOVERING' : 'UNCONFIRMED');
    }
    const work = executionWork(e);
    // Leave other lifecycle operations to their existing recovery handlers.
    if (work && !['release', 'stop'].includes(work.intent.operation) && !saved?.intent) return false;
    if (!work || !matches(p, work)) return fail('execution_identity');
    if (!executionMatches(e, work)) return fail('execution_authority');
    if (p.state === 'RECOVERING') {
        if (e.status === 'RUNNING') return true;
        if (e.status !== 'SUCCEEDED') return fail('execution_' + e.status.toLowerCase());
        const receipt = LifecycleReceiptSchema.safeParse((() => { try { return JSON.parse(e.output ?? ''); } catch { return null; } })());
        if (!receipt.success) return fail('receipt_invalid');
        const r = receipt.data;
        if (r.jobId !== p.lifecycleJobId || r.digest !== p.lifecycleDigest || r.computerId !== p.computerId
            || r.generation !== p.generation || r.leaseEpoch !== p.leaseEpoch || r.fenceToken !== p.fenceToken
            || r.instanceId !== p.instanceId || r.volumeId !== p.volumeId || r.state !== 'retired' || r.instanceLost) return fail('receipt_identity');
        let error;
        try { ({ error } = await resourceEvidence(deps, p, work.intent.deployment, true)); }
        catch { return fail('describe_unavailable', 'RECOVERING'); }
        // A delayed available observation is retryable against this same successful receipt.
        if (error === 'volume_not_available') return fail(error, 'RECOVERING');
        if (error) return fail(error);
        // Legacy replay timestamps came from the FAILED execution and are not stop proof.
        const basis = saved!.basis === 'ec2_state_transition' ? 'ec2_state_transition' : 'recovery_success';
        const stoppedAt = basis === 'ec2_state_transition' ? new Date(saved!.stoppedAt!) : e.stopDate;
        if (basis === 'recovery_success' && !boundedTime(stoppedAt, e.startDate, now())) {
            return fail('recovery_success_time_missing_or_invalid', 'RECOVERING');
        }
        if (deps.tunnels) {
            const fenced = await deps.tunnels.deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId,
                sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch }).catch(() => ({ ok: false }));
            if (!fenced.ok) return true;
        }
        await deps.pool?.retireLease?.(deps.db, p);
        const result = await writeLivePoolRecovery(deps.db, p, 'STOPPED', {
            lifecycleJobId: null, lifecycleDigest: null, lastError: POOL_RELEASED, leaseUntil: null,
            enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
        }, { kind: 'close', observedBy: USAGE_OBSERVER, stoppedAt: stoppedAt! });
        if (result.ok) {
            console.info(JSON.stringify({ event: 'pool-recovery-usage-close', computer: p.computerId.slice(0, 8),
                basis, stoppedAt: stoppedAt!.toISOString() }));
            await recordComputeMeter(() => deps.meter?.stopped({ userId: p.ownerUserId,
                computerId: p.computerId, endedAt: stoppedAt!, reason: 'provider_stop' }));
        }
        return true;
    }
    if (!(saved?.intent ? ['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status) : e.status === 'FAILED')) return fail('execution_not_failed');
    if (!boundedTime(e.stopDate, e.startDate, now())) return fail('stop_time_missing_or_invalid');
    const source = work.intent.deployment;
    if (source.accountId !== d.accountId || source.namespace !== d.namespace || source.dataKeyArn !== d.dataKeyArn
        || source.region !== d.region || source.zoneId !== d.zoneId
        || (source.storage.rootDeviceName ?? '/dev/sda1') !== (d.storage.rootDeviceName ?? '/dev/sda1') || !isPoolMode(source)) return fail('deployment_identity');
    // One recovery attempt per lifecycle version: a failed recovery would otherwise start a
    // new release on every open and reconciler pass. Only a new deployment retries it.
    if (saved?.intent && saved.intent.deployment.stateMachineVersionArn === d.stateMachineVersionArn) return fail('recovery_retry_awaits_new_deployment');
    if (!deps.starter) return fail('starter_missing');
    let evidence;
    try { evidence = await resourceEvidence(deps, p, source, false); }
    catch { return fail('describe_unavailable'); }
    if (evidence.error) return fail(evidence.error);
    const sourceStartedAt = saved?.intent ? saved.sourceStartedAt : e.startDate!.toISOString();
    const proven = boundedTime(evidence.stoppedAt, sourceStartedAt ? new Date(sourceStartedAt) : null, now());
    let next: LifecycleWork;
    try {
        next = buildLifecycleWork({ ...currentGenerationIntent(p, 'stop', d, {
            jobId: randomUUID(), userData: null, leaseEpoch: p.leaseEpoch,
        }), operation: 'release' });
    } catch { return fail('release_intent_invalid'); }
    const context: Replay = { intent: next.intent, sourceStartedAt,
        basis: saved?.basis === 'ec2_state_transition' || proven ? 'ec2_state_transition' : 'recovery_success',
        stoppedAt: saved?.basis === 'ec2_state_transition' ? saved.stoppedAt : proven ? evidence.stoppedAt!.toISOString() : null,
        sourceJobId: saved?.sourceJobId ?? p.lifecycleJobId, error: null };
    const reserved = await writeLivePoolRecovery(deps.db, p, 'RECOVERING', {
        lifecycleJobId: next.intent.jobId, lifecycleDigest: next.digest, lastError: PREFIX + JSON.stringify(context),
        enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
    });
    if (!reserved.ok) return true;
    const outcome = await startLifecycleJob(deps.starter, p.region, next, deps.sleep);
    if (outcome !== 'started') await writeLivePoolRecovery(deps.db, reserved.placement, 'RECOVERING', {
        lastError: PREFIX + JSON.stringify({ ...context, error: 'start_' + outcome }),
    });
    return true;
}
