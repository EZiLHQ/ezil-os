import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { reconcileAdoptRecovery } from './aws-pool-recovery';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import { awsSandboxId } from './aws-enroll';
import { isExecutionAbsent } from './aws-errors';
import { proveFailedReleaseTermination } from './aws-failed-release-proof';
import { buildLifecycleWork, currentGenerationIntent, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isPoolMode, lifecycleExecutionArn, LifecycleReceiptSchema, POOL_RELEASED, startLifecycleJob,
    USAGE_OBSERVER, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { assertNoImageReservation, readCanaryComputer, readPlacement, writeLivePoolRecovery, type Placement } from './placement';

const PREFIX = 'pool_release_recovery:';
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
type Replay = { intent: LifecycleWork['intent']; stoppedAt: string | null; sourceJobId: string; error: string | null;
    basis?: 'ec2_state_transition' | 'recovery_success' | 'failed_release_termination'; sourceStartedAt?: string; sourceStoppedAt?: string;
    /** failed_release_termination: the validated failed release execution the witness came from (re-proven at settlement). */
    sourceExecutionArn?: string; sourceDigest?: string; sourceStateMachineVersionArn?: string };
/** Bases whose saved stop time was proven (and bounded) before the reservation CAS. */
const provenBasis = (basis: Replay['basis']) => basis === 'ec2_state_transition' || basis === 'failed_release_termination';
/** A saved failed-release termination time must still lie inside the failed execution's own interval, never in the future. */
function savedTerminationValid(saved: Replay, now: Date): boolean {
    if (saved.basis !== 'failed_release_termination') return true;
    if (![saved.sourceExecutionArn, saved.sourceDigest, saved.sourceStateMachineVersionArn, saved.sourceJobId].every(v => typeof v === 'string' && v.length > 0)) return false;
    const [start, at, stop] = [saved.sourceStartedAt, saved.stoppedAt, saved.sourceStoppedAt].map(v => typeof v === 'string' ? Date.parse(v) : NaN);
    return [start, at, stop].every(Number.isFinite) && start! <= at! && at! <= stop! && stop! <= now.getTime();
}
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
/** The failed source release's identity for this placement (its job/digest are not the placement's after the reservation),
 * under the same deployment authority (account, namespace, region, zone, data key) as the recovery's own deployment. */
function sameIdentity(p: Placement, work: LifecycleWork, d: LifecycleDeployment): boolean {
    const i = work.intent;
    return i.operation === 'release' && i.computerId === p.computerId && i.targetGeneration === p.generation && i.leaseEpoch === p.leaseEpoch
        && i.fenceToken === p.fenceToken && i.providerInstanceId === p.instanceId && i.dataVolumeId === p.volumeId && i.instanceType === p.instanceType
        && i.deployment.region === p.region && i.deployment.zoneId === p.zoneId && i.deployment.accountId === d.accountId
        && i.deployment.namespace === d.namespace && i.deployment.region === d.region && i.deployment.dataKeyArn === d.dataKeyArn;
}
function executionMatches(e: Execution, work: LifecycleWork): boolean {
    return !e.stateMachineAliasArn && e.redriveCount === 0
        && e.executionArn === lifecycleExecutionArn(work.intent.deployment, work.intent.jobId)
        && e.stateMachineVersionArn === work.stateMachineArn;
}
function ownedTags(tags: Record<string, string> | undefined, p: Placement, d: LifecycleDeployment): boolean {
    if (!tags || tags['ezil:managed-by'] !== 'app-computer-platform' || tags['ezil:stage'] !== d.namespace
        || tags['ezil:generation'] !== String(p.generation) || (tags['ezil:namespace'] !== undefined && tags['ezil:namespace'] !== d.namespace)) return false;
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

/** The failed release already terminated its host (and detached the disk): the owned data volume is free, the host is
 * positively `terminated` (exact id, type, zone, provenance and identity, every present alias agreeing, nothing but a
 * deleting root left mapped) or aged out of EC2, AND the failed release's own history witnesses the termination. The
 * witnessed TerminateInstances time is the physical end, never this recovery's time. `shutting-down` waits. */
async function terminatedReleaseEvidence(deps: ReceiptDeps, p: Placement, d: LifecycleDeployment, e: Execution, work: LifecycleWork):
    Promise<{ wait: true } | { error: string } | { terminatedAt: Date }> {
    if (!deps.describer?.describeVolume) return { error: 'describer_missing' };
    const host = await deps.describer.describeForEnrollment(p.region!, p.instanceId!);
    if (host && host.instanceId !== p.instanceId) return { error: 'instance_identity' };
    if (host?.state === 'shutting-down') return { wait: true }; // EC2 is still finishing the termination; its disk may still detach.
    // A host EC2 still lists outside termination is the stopped/attached branch's case: keep its diagnostic.
    if (host && host.state !== 'terminated' && host.state !== 'shutting-down') return { error: 'volume_attachment' };
    const volume = await deps.describer.describeVolume(p.region!, p.volumeId!);
    if (!volume || volume.volumeId !== p.volumeId || !ownedTags(volume.tags, p, d)
        || volume.encrypted !== true || volume.kmsKeyId !== d.dataKeyArn || volume.zoneId !== p.zoneId) return { error: 'volume_identity' };
    if (volume.state !== 'available' || !Array.isArray(volume.attachments) || volume.attachments.length !== 0) return { error: 'volume_attachment' };
    if (volume.volumeType !== 'gp3' || !Number.isInteger(volume.sizeGiB) || volume.sizeGiB! < d.storage.dataMinGiB
        || volume.sizeGiB! > d.storage.dataMaxGiB) return { error: 'volume_identity' };
    if (host) {
        const rootName = d.storage.rootDeviceName ?? '/dev/sda1';
        if (host.instanceType !== p.instanceType || host.availabilityZoneId !== p.zoneId
            || !ownedTags(host.tags, p, d) || host.tags['ezil:pool'] !== undefined
            || host.tags['aws:ec2launchtemplate:id'] !== d.launchTemplateId) return { error: 'instance_identity' };
        if (host.volumes.length > 1 || host.volumes.some(v => v.volumeId === p.volumeId || v.deviceName !== rootName || !v.deleteOnTermination)) return { error: 'instance_disks' };
    }
    if (!deps.executions?.history) return { error: 'history_reader_missing' };
    const proof = proveFailedReleaseTermination(e, await deps.executions.history(p.region!, e.executionArn!), work);
    return proof ? { terminatedAt: proof.terminatedAt } : { error: 'termination_not_proven' };
}

async function rewitness(deps: ReceiptDeps, p: Placement, saved: Replay, d: LifecycleDeployment): Promise<boolean> {
    if (!deps.executions?.history || !saved.sourceJobId || !saved.sourceExecutionArn) return false;
    // The saved source is this deployment machine's execution of the saved job, and the answer must be exactly that execution.
    const arn = saved.sourceExecutionArn;
    if (arn !== lifecycleExecutionArn(d, saved.sourceJobId)) return false;
    const source = await deps.executions.describe(p.region!, arn);
    if (source.executionArn !== arn || source.stateMachineVersionArn !== saved.sourceStateMachineVersionArn) return false;
    const work = executionWork(source);
    // The reconstructed source work must be the reserved one: same digest (document), same version, same job and authority.
    if (!work || work.digest !== saved.sourceDigest || work.stateMachineArn !== saved.sourceStateMachineVersionArn
        || work.intent.jobId !== saved.sourceJobId || !sameIdentity(p, work, d)) return false;
    const proof = proveFailedReleaseTermination(source, await deps.executions.history(p.region!, arn), work);
    return !!proof && proof.terminatedAt.toISOString() === saved.stoppedAt
        && source.startDate?.toISOString() === saved.sourceStartedAt && source.stopDate?.toISOString() === saved.sourceStoppedAt;
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
        if (planned.intent.operation !== 'release' || !matches(p, planned) || !savedTerminationValid(saved, now())
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
        const basis = provenBasis(saved!.basis) ? saved!.basis! : 'recovery_success';
        const stoppedAt = basis === 'recovery_success' ? e.stopDate : new Date(saved!.stoppedAt!);
        if (basis === 'failed_release_termination') {
            // The witnessed termination preceded this recovery's own replay, and is re-proven from the ORIGINAL failed release
            // (exact job, interval and witnessed time): a stale or altered saved context never bills.
            if (!(e.startDate instanceof Date && stoppedAt!.getTime() <= e.startDate.getTime())) return fail('replay_identity');
            let rewitnessed;
            try { rewitnessed = await rewitness(deps, p, saved!, work.intent.deployment); }
            catch { return fail('describe_unavailable', 'RECOVERING'); }
            if (!rewitnessed) return fail('replay_identity');
        }
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
    // A failed RELEASE whose disk is no longer attached: only the terminated-host branch may continue (never a retry).
    let terminatedAt: Date | null = null;
    if (evidence.error === 'volume_attachment' && work.intent.operation === 'release' && !saved?.intent) {
        let released;
        try { released = await terminatedReleaseEvidence(deps, p, source, e, work); }
        catch { return fail('describe_unavailable'); }
        if ('wait' in released) return true; // shutting-down: no start, no write.
        if ('error' in released) return fail(released.error);
        if (!boundedTime(released.terminatedAt, e.startDate, e.stopDate && e.stopDate < now() ? e.stopDate : now())) return fail('termination_time_invalid');
        terminatedAt = released.terminatedAt;
    } else if (evidence.error) return fail(evidence.error);
    const sourceStartedAt = saved?.intent ? saved.sourceStartedAt : e.startDate!.toISOString();
    const proven = !terminatedAt && boundedTime(evidence.stoppedAt, sourceStartedAt ? new Date(sourceStartedAt) : null, now());
    let next: LifecycleWork;
    try {
        next = buildLifecycleWork({ ...currentGenerationIntent(p, 'stop', d, {
            jobId: randomUUID(), userData: null, leaseEpoch: p.leaseEpoch,
        }), operation: 'release' });
    } catch { return fail('release_intent_invalid'); }
    const context: Replay = { intent: next.intent, sourceStartedAt,
        basis: terminatedAt ? 'failed_release_termination' : saved?.basis === 'ec2_state_transition' || proven ? 'ec2_state_transition' : 'recovery_success',
        stoppedAt: terminatedAt ? terminatedAt.toISOString() : saved?.basis === 'ec2_state_transition' ? saved.stoppedAt : proven ? evidence.stoppedAt!.toISOString() : null,
        ...(terminatedAt ? { sourceStoppedAt: e.stopDate!.toISOString(), sourceExecutionArn: e.executionArn!, sourceDigest: work.digest,
            sourceStateMachineVersionArn: work.stateMachineArn } : {}),
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

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** `reconcile-release` on the signed image-rebase operator route: run THIS recovery for one failed release. */
export const ReconcileReleaseRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('reconcile-release'),
    computerId: Uuid, expectedJobId: Uuid, releaseExecutionArn: z.string().min(1).max(300) }).strict();
export type ReconcileReleaseRequest = z.infer<typeof ReconcileReleaseRequestSchema>;
export type ReconcileReleaseOutcome = 'settled' | 'recovering' | 'waiting' | 'unconfirmed' | 'not_applicable' | 'source_not_proven';
export type ReconcileReleaseDeps = ReceiptDeps & { executions: LifecycleExecutionReader };

/** Operator entry for a failed pool release named by `expectedJobId` (the placement's own current job: the failed
 * release, or this recovery's reserved replay). The hint must be exactly that job's execution; nothing in the request
 * is trusted beyond selecting it. Only reconcilePoolReleaseRecovery runs, with the normal reservation CAS, ordinary
 * release replay and retired-receipt settlement: never replacement or image recovery, delete recovery, or a manual
 * placement write. The outcome is read back from the placement afterwards. */
export async function reconcileFailedRelease(deps: ReconcileReleaseDeps, deployments: Record<string, LifecycleDeployment>,
    request: ReconcileReleaseRequest): Promise<{ outcome: ReconcileReleaseOutcome; error: string | null }> {
    const none = (outcome: ReconcileReleaseOutcome, error: string | null = null) => ({ outcome, error });
    await assertNoImageReservation(deps.db, request.computerId);
    const computer = await readCanaryComputer(deps.db, request.computerId);
    const p = (await readPlacement(deps.db, request.computerId)).record;
    const d = p?.region ? deployments[p.region] : undefined;
    if (!computer || computer.deleted || !p || !d || p.ownerUserId !== computer.userId || p.provider !== 'aws-ec2' || !isPoolMode(d)
        || !['UNCONFIRMED', 'RECOVERING'].includes(p.state) || p.lifecycleJobId !== request.expectedJobId || !p.lifecycleDigest
        || !deps.executions.history) return none('not_applicable');
    if (request.releaseExecutionArn !== lifecycleExecutionArn(d, request.expectedJobId)) return none('source_not_proven');
    const saved = replay(p);
    if (p.state === 'RECOVERING') {
        if (!saved?.intent) return none('not_applicable');
    } else {
        const work = executionWork(await deps.executions.describe(p.region!, request.releaseExecutionArn));
        if (!work || work.intent.operation !== 'release' || !matches(p, work)) return none('not_applicable');
    }
    await reconcilePoolReleaseRecovery(deps, p, d);
    const after = (await readPlacement(deps.db, p.computerId)).record;
    if (!after) return none('not_applicable');
    if (after.state === 'STOPPED' && after.lastError === POOL_RELEASED) return none('settled');
    const error = replay(after)?.error ?? null;
    if (after.state === 'RECOVERING' && !error) return none('recovering');
    // Unchanged with no recorded error: a `shutting-down` host (or a RUNNING replay) is still being waited for.
    if (!error && after.state === p.state && after.lastError === p.lastError && after.lifecycleJobId === p.lifecycleJobId) return none('waiting');
    return none(error === 'termination_not_proven' || error === 'history_reader_missing' ? 'source_not_proven' : 'unconfirmed', error);
}
