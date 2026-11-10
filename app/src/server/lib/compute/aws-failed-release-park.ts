import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { awsSandboxId } from './aws-enroll';
import { isExecutionAbsent } from './aws-errors';
import { buildLifecycleWork, currentGenerationIntent, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { boundedTime, executionMatches, executionWork, matchesPoolReleaseRecovery, poolReleaseReplay, sameIdentity } from './aws-pool-release-recovery';
import type { RebaseSnapshotDescriber } from './aws-rebase-evidence';
import { isPoolMode, lifecycleExecutionArn, LifecycleReceiptSchema, startLifecycleJob, USAGE_OBSERVER,
    type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { assertNoImageReservation, readCanaryComputer, readPlacement, writeLivePoolRecovery, writeParkedStopReservation, type Placement } from './placement';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';

/**
 * Park a failed pool release: a failed `release` whose host is already (gracefully) STOPPED with the data volume still attached is
 * settled to STOPPED through an ordinary STOP job, WITHOUT detach, terminate or release.
 *
 * Why its own durable prefix and handler (not STOPPING, not the release recovery):
 *  - UNCONFIRMED -> STOPPING is not an allowed edge, and the generic unknown-start path rebuilds a stop through sessionEndWork,
 *    which maps STOP to RELEASE for the pool deployment. Here the explicit STOP intent is SAVED in the row and only ever re-started
 *    from that saved document: a lost StartExecution can never become a release.
 *  - the pool release recovery requires a saved `release` intent and builds a release.
 * The reservation is the existing full-identity CAS (UNCONFIRMED -> RECOVERING, `writeLivePoolRecovery`); nothing about the transition
 * table, `ownedTags` or the adopted-host checks is loosened. The only tolerance is the cold-volume one the lifecycle helper already
 * has: a stale legacy `ezil:fence` alias on this cold data volume may differ while every canonical field agrees.
 */
export const POOL_PARK_RECOVERY_PREFIX = 'pool_park_recovery:';
export const PARKED_FAILED_RELEASE = 'parked_failed_release';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
export type ParkDescriber = NonNullable<ReceiptDeps['describer']> & Partial<RebaseSnapshotDescriber>;
export type ParkDeps = Omit<ReceiptDeps, 'describer' | 'executions'> & { executions: LifecycleExecutionReader; describer?: ParkDescriber; newId?: () => string };

/** The durable replay document: the SAVED stop intent plus the audit of the failed release and the proven backup. */
export interface ParkReplay {
    v: 1;
    /** The explicit `stop` intent (never rebuilt from the placement; never a release). */
    intent: LifecycleWork['intent'];
    snapshotId: string;
    /** The proven EC2 stop transition of the host before the reservation (the usage close time). */
    hostStoppedAt: string;
    sourceJobId: string;
    sourceExecutionArn: string;
    sourceDigest: string;
    sourceStateMachineVersionArn: string;
    sourceStartedAt: string;
    sourceStoppedAt: string;
    /** The failed release's last error as found on the placement. */
    sourceError: string | null;
    /** The latest diagnostic of this park (the row stays RECOVERING). */
    error: string | null;
}

export function parkReplay(p: Placement): ParkReplay | null {
    if (!p.lastError?.startsWith(POOL_PARK_RECOVERY_PREFIX)) return null;
    try {
        const v = JSON.parse(p.lastError.slice(POOL_PARK_RECOVERY_PREFIX.length)) as Partial<ParkReplay> | null;
        if (!v || v.v !== 1 || !v.intent) return null;
        const text = [v.snapshotId, v.hostStoppedAt, v.sourceJobId, v.sourceExecutionArn, v.sourceDigest, v.sourceStateMachineVersionArn, v.sourceStartedAt, v.sourceStoppedAt];
        return text.every(x => typeof x === 'string' && x.length > 0) ? v as ParkReplay : null;
    } catch { return null; }
}
export const isParkedStopRecovering = (p: Placement): boolean => p.state === 'RECOVERING' && !!parkReplay(p);

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** `park-failed-release` on the signed image-rebase operator route. Nothing in it is trusted beyond selecting records. */
export const ParkFailedReleaseRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('park-failed-release'),
    computerId: Uuid, expectedJobId: Uuid, releaseExecutionArn: z.string().min(1).max(300), snapshotId: z.string().regex(/^snap-[0-9a-f]{8,17}$/) }).strict();
export type ParkFailedReleaseRequest = z.infer<typeof ParkFailedReleaseRequestSchema>;
export type ParkOutcome = 'reserved' | 'already_reserved' | 'refused';

/** The cold-volume tag rule: every canonical field agrees; the legacy computer alias (if present) agrees; ONLY the legacy `ezil:fence`
 * alias may differ (the lifecycle helper's cold-disk tolerance). Any pool marker or other disagreeing alias refuses. */
function coldVolumeTags(tags: Readonly<Record<string, string>> | undefined, p: Placement, d: LifecycleDeployment): boolean {
    if (!tags || tags['ezil:managed-by'] !== 'app-computer-platform' || tags['ezil:stage'] !== d.namespace
        || tags['ezil:computer-id'] !== p.computerId || tags['ezil:generation'] !== String(p.generation) || tags['ezil:fence-token'] !== p.fenceToken
        || tags['ezil:pool'] !== undefined) return false;
    return Object.entries({ 'ezil:namespace': d.namespace, 'ezil:computer': p.computerId })
        .every(([k, v]) => tags[k] === undefined || tags[k] === v);
}

/** A COLD-canonical host: canonical identity only (computer-id and fence-token for this generation). Any legacy computer/fence alias or
 * pool/claim marker means a legacy-only, adopted or claimed host: out of scope here, and not one the ordinary stop would accept for it.
 * `ownedTags` is deliberately NOT used for the host (it allows those shapes) and is not changed. */
function coldHostTags(tags: Readonly<Record<string, string>> | undefined, p: Placement, d: LifecycleDeployment): boolean {
    if (!tags || tags['ezil:managed-by'] !== 'app-computer-platform' || tags['ezil:stage'] !== d.namespace || tags['ezil:computer-id'] !== p.computerId
        || tags['ezil:generation'] !== String(p.generation) || tags['ezil:fence-token'] !== p.fenceToken) return false;
    if (tags['ezil:namespace'] !== undefined && tags['ezil:namespace'] !== d.namespace) return false;
    return ['ezil:computer', 'ezil:fence', 'ezil:pool', 'ezil:pool-host'].every(k => tags[k] === undefined);
}

type Evidence = { error: string } | { hostStoppedAt: Date };
/** The physical proof, re-read at reservation and again at settlement. */
async function parkEvidence(deps: ParkDeps, p: Placement, d: LifecycleDeployment, snapshotId: string, now: Date): Promise<Evidence> {
    const describer = deps.describer;
    if (!describer?.describeVolume || !describer.describeSnapshot) return { error: 'describer_missing' };
    const volume = await describer.describeVolume(p.region!, p.volumeId!);
    if (!volume || volume.volumeId !== p.volumeId || !coldVolumeTags(volume.tags, p, d) || volume.encrypted !== true
        || volume.kmsKeyId !== d.dataKeyArn || volume.zoneId !== p.zoneId || volume.volumeType !== 'gp3'
        || !Number.isInteger(volume.sizeGiB) || volume.sizeGiB! < d.storage.dataMinGiB || volume.sizeGiB! > d.storage.dataMaxGiB) return { error: 'volume_identity' };
    if (volume.state !== 'in-use' || volume.attachments?.length !== 1
        || volume.attachments[0].instanceId !== p.instanceId || volume.attachments[0].state !== 'attached') return { error: 'volume_attachment' };
    const host = await describer.describeForEnrollment(p.region!, p.instanceId!);
    if (!host || host.instanceId !== p.instanceId || host.state !== 'stopped' || host.instanceType !== p.instanceType
        || host.availabilityZoneId !== p.zoneId || !coldHostTags(host.tags, p, d)) return { error: 'instance_identity' };
    const rootName = d.storage.rootDeviceName ?? '/dev/sda1';
    const root = host.volumes.filter(v => v.deviceName === rootName && v.volumeId !== p.volumeId && v.deleteOnTermination);
    const data = host.volumes.filter(v => v.volumeId === p.volumeId && !v.deleteOnTermination && v.deviceName !== rootName);
    if (host.rootDeviceName !== rootName || host.volumes.length !== 2 || root.length !== 1 || data.length !== 1) return { error: 'instance_disks' };
    const stoppedAt = host.stateTransitionAt;
    if (!(stoppedAt instanceof Date) || !Number.isFinite(stoppedAt.getTime()) || stoppedAt > now) return { error: 'stop_time_unknown' };
    // The backup must be a fresh, COMPLETED, quiescent one of exactly this volume: started after the host's stop transition.
    // The older routine snapshots never substitute.
    const snapshot = await describer.describeSnapshot(p.region!, snapshotId);
    if (!snapshot || snapshot.snapshotId !== snapshotId || snapshot.ownerId !== d.accountId || snapshot.volumeId !== p.volumeId || snapshot.state !== 'completed'
        || snapshot.encrypted !== true || snapshot.kmsKeyId !== d.dataKeyArn || snapshot.volumeGiB !== volume.sizeGiB) return { error: 'snapshot_not_proven' };
    if (!(snapshot.startedAt instanceof Date) || snapshot.startedAt < stoppedAt || snapshot.startedAt > now) return { error: 'snapshot_not_post_stop' };
    return { hostStoppedAt: stoppedAt };
}

/** The failed release the reservation names: the placement's own current job, an exact FAILED execution of the current tuple. */
function failedSource(p: Placement, e: Execution, d: LifecycleDeployment): { error: string } | { work: LifecycleWork } {
    const work = executionWork(e);
    if (!work || work.intent.operation !== 'release' || !matchesPoolReleaseRecovery(p, work) || !sameIdentity(p, work, d)) return { error: 'execution_identity' };
    if (e.status !== 'FAILED') return { error: 'execution_not_failed' };
    // The failed release matches ITS OWN saved intent (state-machine version included). The new stop may run on a newer version
    // (the current deployment) as long as account, namespace, data key, region, zone and the root-device authority are the same.
    if (!executionMatches(e, work)) return { error: 'execution_authority' };
    if (work.intent.deployment.zoneId !== d.zoneId || (work.intent.deployment.storage.rootDeviceName ?? '/dev/sda1') !== (d.storage.rootDeviceName ?? '/dev/sda1')) return { error: 'deployment_identity' };
    return { work };
}

export interface ParkDeployments { [region: string]: LifecycleDeployment }

/** Reserve the park: prove everything, then ONE CAS UNCONFIRMED -> RECOVERING carrying the saved STOP intent, then start that job only. */
export async function reserveParkedStop(deps: ParkDeps, deployments: ParkDeployments, request: ParkFailedReleaseRequest):
    Promise<{ outcome: ParkOutcome; error: string | null }> {
    const refuse = (error: string) => ({ outcome: 'refused' as const, error });
    await assertNoImageReservation(deps.db, request.computerId);
    const computer = await readCanaryComputer(deps.db, request.computerId);
    const p = (await readPlacement(deps.db, request.computerId)).record;
    const d = p?.region ? deployments[p.region] : undefined;
    if (!computer || computer.deleted || !p || !d || p.ownerUserId !== computer.userId || p.provider !== 'aws-ec2' || !isPoolMode(d)) return refuse('not_applicable');
    const saved = parkReplay(p);
    if (saved && p.state === 'RECOVERING') return saved.sourceJobId === request.expectedJobId && saved.snapshotId === request.snapshotId
        ? { outcome: 'already_reserved', error: saved.error } : refuse('park_in_progress');
    if (p.state !== 'UNCONFIRMED' || p.lifecycleJobId !== request.expectedJobId || !p.lifecycleDigest || poolReleaseReplay(p)?.intent) return refuse('not_applicable');
    if (request.releaseExecutionArn !== lifecycleExecutionArn(d, request.expectedJobId)) return refuse('source_not_proven');
    if (!p.region || !p.zoneId || !p.instanceId || !p.volumeId || !p.fenceToken || !p.instanceType) return refuse('placement_identity');
    if (!deps.starter) return refuse('starter_missing');
    const now = (deps.now ?? deps.clock ?? (() => new Date()))();
    // No live writer: the placement holds no unexpired lease (the host itself is proven stopped below).
    if (p.leaseUntil && p.leaseUntil > now) return refuse('writer_lease_active');
    let source: Execution;
    try { source = await deps.executions.describe(p.region, request.releaseExecutionArn); }
    catch { return refuse('execution_unavailable'); }
    const failed = failedSource(p, source, d);
    if ('error' in failed) return refuse(failed.error);
    if (!boundedTime(source.stopDate, source.startDate, now)) return refuse('stop_time_missing_or_invalid');
    let evidence: Evidence;
    try { evidence = await parkEvidence(deps, p, d, request.snapshotId, now); }
    catch { return refuse('describe_unavailable'); }
    if ('error' in evidence) return refuse(evidence.error);
    if (evidence.hostStoppedAt < source.startDate!) return refuse('stop_time_invalid');
    let next: LifecycleWork;
    try {
        // Explicit STOP on the CURRENT deployment (never sessionEndWork, which would map stop to release for the pool deployment).
        next = buildLifecycleWork(currentGenerationIntent(p, 'stop', d, { jobId: (deps.newId ?? randomUUID)(), userData: null, leaseEpoch: p.leaseEpoch }));
    } catch { return refuse('stop_intent_invalid'); }
    const doc: ParkReplay = { v: 1, intent: next.intent, snapshotId: request.snapshotId, hostStoppedAt: evidence.hostStoppedAt.toISOString(),
        sourceJobId: request.expectedJobId, sourceExecutionArn: source.executionArn!, sourceDigest: failed.work.digest,
        sourceStateMachineVersionArn: failed.work.stateMachineArn, sourceStartedAt: source.startDate!.toISOString(),
        sourceStoppedAt: source.stopDate!.toISOString(), sourceError: p.lastError, error: null };
    // One transaction under admission -> computer -> row locks that also excludes every other possible writer (see the helper).
    const reserved = await writeParkedStopReservation(deps.db, p, {
        lifecycleJobId: next.intent.jobId, lifecycleDigest: next.digest, lastError: POOL_PARK_RECOVERY_PREFIX + JSON.stringify(doc),
        enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
    });
    if (!reserved.ok) return refuse(reserved.reason === 'blocked' ? 'blocked_' + reserved.blocker : 'cas_conflict');
    const outcome = await startLifecycleJob(deps.starter, p.region, next, deps.sleep);
    if (outcome !== 'started') await writeLivePoolRecovery(deps.db, reserved.placement, 'RECOVERING', {
        lastError: POOL_PARK_RECOVERY_PREFIX + JSON.stringify({ ...doc, error: 'start_' + outcome }),
    });
    return { outcome: 'reserved', error: null };
}

/** Receipt-pass handler for a RECOVERING row that carries a park document. Returns true when it owns the row. */
export async function reconcileParkedStop(deps: ParkDeps, p: Placement, d: LifecycleDeployment): Promise<boolean> {
    const saved = parkReplay(p);
    if (p.state !== 'RECOVERING' || p.provider !== 'aws-ec2' || !saved) return false;
    const fail = async (error: string) => {
        const lastError = POOL_PARK_RECOVERY_PREFIX + JSON.stringify({ ...saved, error });
        if (p.lastError !== lastError) await writeLivePoolRecovery(deps.db, p, 'RECOVERING', { lastError });
        return true;
    };
    const computer = await readCanaryComputer(deps.db, p.computerId);
    if (!computer || computer.deleted || computer.userId !== p.ownerUserId) return false;
    if (!p.lifecycleJobId || !p.lifecycleDigest || !p.region || !p.instanceId || !p.volumeId || !p.fenceToken || !isPoolMode(d)) return fail('placement_identity');
    let planned: LifecycleWork;
    try { planned = buildLifecycleWork(saved.intent); } catch { return fail('replay_invalid'); }
    // The saved document is a STOP of exactly this placement's tuple; anything else is never executed.
    if (planned.intent.operation !== 'stop' || !matchesPoolReleaseRecovery(p, planned)) return fail('replay_identity');
    let e: Execution;
    try { e = await deps.executions.describe(p.region, lifecycleExecutionArn(planned.intent.deployment, p.lifecycleJobId)); }
    catch (error) {
        if (!isExecutionAbsent(error)) return fail('execution_unavailable');
        if (!deps.starter) return fail('starter_missing');
        // An unknown start is re-started FROM THE SAVED STOP DOCUMENT (same job id: idempotent by execution name).
        const outcome = await startLifecycleJob(deps.starter, p.region, planned, deps.sleep);
        if (outcome !== 'started') await fail('start_' + outcome);
        return true;
    }
    const work = executionWork(e);
    if (!work || work.intent.operation !== 'stop' || work.digest !== planned.digest || !matchesPoolReleaseRecovery(p, work)) return fail('execution_identity');
    if (!executionMatches(e, work)) return fail('execution_authority');
    if (e.status === 'RUNNING') return true;
    if (e.status !== 'SUCCEEDED') return fail('execution_' + e.status.toLowerCase());
    const receipt = LifecycleReceiptSchema.safeParse((() => { try { return JSON.parse(e.output ?? ''); } catch { return null; } })());
    if (!receipt.success) return fail('receipt_invalid');
    const r = receipt.data;
    if (r.jobId !== p.lifecycleJobId || r.digest !== p.lifecycleDigest || r.computerId !== p.computerId || r.generation !== p.generation
        || r.leaseEpoch !== p.leaseEpoch || r.fenceToken !== p.fenceToken || r.instanceId !== p.instanceId || r.volumeId !== p.volumeId
        || r.state !== 'stopped' || r.instanceLost) return fail('receipt_identity');
    // The NEW job's own interval and receipt close this park; the failed release's time is never reused.
    const now = (deps.now ?? deps.clock ?? (() => new Date()))();
    // Re-prove the ORIGINAL failed release from its own execution (exact job, digest, version, interval).
    if (saved.sourceExecutionArn !== lifecycleExecutionArn(d, saved.sourceJobId)) return fail('source_identity');
    let source: Execution;
    try { source = await deps.executions.describe(p.region, saved.sourceExecutionArn); }
    catch { return fail('source_unavailable'); }
    const sourceWork = executionWork(source);
    if (!sourceWork || sourceWork.digest !== saved.sourceDigest || sourceWork.stateMachineArn !== saved.sourceStateMachineVersionArn
        || sourceWork.intent.jobId !== saved.sourceJobId || sourceWork.intent.operation !== 'release' || source.status !== 'FAILED'
        || source.startDate?.toISOString() !== saved.sourceStartedAt || source.stopDate?.toISOString() !== saved.sourceStoppedAt
        || !executionMatches(source, sourceWork)
        || sourceWork.intent.computerId !== p.computerId || sourceWork.intent.targetGeneration !== p.generation || sourceWork.intent.leaseEpoch !== p.leaseEpoch
        || sourceWork.intent.fenceToken !== p.fenceToken || sourceWork.intent.providerInstanceId !== p.instanceId || sourceWork.intent.dataVolumeId !== p.volumeId) return fail('source_identity');
    // Still no writer at apply time: the placement holds no unexpired lease and the host is re-proven stopped below.
    if (p.leaseUntil && p.leaseUntil > now) return fail('writer_lease_active');
    let evidence: Evidence;
    try { evidence = await parkEvidence(deps, p, d, saved.snapshotId, now); }
    catch { return fail('describe_unavailable'); }
    if ('error' in evidence) return fail(evidence.error);
    // The host must not have been started and stopped again since the reservation: the stop time is the one that was proven.
    if (evidence.hostStoppedAt.toISOString() !== saved.hostStoppedAt) return fail('host_changed');
    if (!boundedTime(evidence.hostStoppedAt, new Date(saved.sourceStartedAt), now)) return fail('stop_time_invalid');
    if (deps.tunnels) {
        const fenced = await deps.tunnels.deleteTunnel({ userId: p.ownerUserId }, { computerId: p.computerId,
            sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch }).catch(() => ({ ok: false }));
        if (!fenced.ok) return true;
    }
    await deps.pool?.retireLease?.(deps.db, p);
    const result = await writeLivePoolRecovery(deps.db, p, 'STOPPED', {
        lifecycleJobId: null, lifecycleDigest: null, lastError: PARKED_FAILED_RELEASE, leaseUntil: null,
        enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null,
    }, { kind: 'close', observedBy: USAGE_OBSERVER, stoppedAt: evidence.hostStoppedAt });
    if (result.ok) {
        console.info(JSON.stringify({ event: 'pool-park-settled', computer: p.computerId.slice(0, 8), sourceJob: saved.sourceJobId.slice(0, 8),
            stopJob: p.lifecycleJobId.slice(0, 8), snapshot: saved.snapshotId, stoppedAt: evidence.hostStoppedAt.toISOString() }));
        await recordComputeMeter(() => deps.meter?.stopped({ userId: p.ownerUserId, computerId: p.computerId,
            endedAt: evidence.hostStoppedAt, reason: 'provider_stop' }));
    }
    return true;
}
