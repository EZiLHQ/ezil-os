import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import { recordComputeMeter } from '@/server/billing/v2/compute-meter-observation';
import { resumeImageRecovery } from './aws-rebase-recover-orchestrator';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { isAwsComputersEnabled, readAwsEnrollUrl, meteredSizeForInstanceType, type Env } from './aws-config';
import { buildEnrollmentUserData, issueEnrollmentNonce, type Ec2EnrollmentDescriber, type Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeDescriber } from './aws-clients';
import type { LifecycleStarter } from './aws-ec2';
import type { LifecycleExecutionReader } from './aws-receipts';
import { buildLifecycleWork, LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleDeployment } from './aws-intent';
import { buildRebasePreparation, validateRebaseSnapshotReceipt } from './aws-rebase-preparation';
import { parseRebaseJson, RebaseHash, RebaseUuid } from './aws-rebase-json';
import { rebaseManifestSha256, rebaseReleaseCandidates, resolveRebaseReleases, sourceDeploymentFor } from './aws-rebase-release';
import { readReleasedPoolHostProof, readRetiredSourceProof } from './aws-historical-source';
import { readReleasedDedicatedHostProof } from './aws-dedicated-source';
import { createImageJobStore, IMAGE_JOB_FAILURE_CODES, isTerminalImageJob, newReservedImageJob, type ImageJob } from './aws-rebase-store';
import { assertImageExecution, preparationFor, launchFor, verifyImageSnapshot, ImageLaunchReceiptSchema, type RebaseSnapshotDescriber, type Execution } from './aws-rebase-evidence';
import { isDefiniteAwsRefusal, isExecutionAbsent, toAwsClientError } from './aws-errors';
import { ImageJobConflictError, type ImagePlacement } from './placement';
import { isRetainedRebaseJob, readRetainedRebaseApproval, retainedRebaseJobId } from './aws-retained-rebase';

/** `sourceRetirementExecutionArn`: plan/prepare only, a lookup hint for the release of a released pool host (DESIGN R, a) or of
 * an aged-out regular host (R2); nothing in it is trusted (aws-historical-source readReleasedPoolHostProof/readRetiredSourceProof). */
export const ImageRebaseRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.enum(['plan', 'prepare', 'launch', 'verify', 'recover']),
    computerId: RebaseUuid.nullable(), jobId: RebaseUuid.nullable(), sourceRetirementExecutionArn: z.string().min(1).max(300).optional(),
    retainedTargetManifestSha256: RebaseHash.optional() }).strict()
    .refine(r => (r.operation === 'recover' ? r.jobId !== null : r.computerId !== null)
        && (r.sourceRetirementExecutionArn === undefined || ['plan', 'prepare'].includes(r.operation))
        && (r.retainedTargetManifestSha256 === undefined || r.sourceRetirementExecutionArn !== undefined));
export type ImageRebaseRequest = z.infer<typeof ImageRebaseRequestSchema>;
export interface ImageRebaseDeps {
    store: ReturnType<typeof createImageJobStore>; env: Env; now: () => Date;
    starter: LifecycleStarter; executions: LifecycleExecutionReader;
    describer: Ec2EnrollmentDescriber & Ec2VolumeDescriber & RebaseSnapshotDescriber;
    desktopHealthy: (p: ImagePlacement) => Promise<boolean>;
    newId?: () => string;
    meter?: ComputeMeter;
    /** Set only by the authenticated workflow operator route. */
    allowRetainedTarget?: true;
}
type Code = typeof IMAGE_JOB_FAILURE_CODES[number];
export type ImageRebaseResponse = { status: number; body: { schemaVersion: 1; computerId: string; jobId: string | null;
    phase: ImageJob['phase'] | null; eligible: boolean; failureCode: Code | null } };
const failure = (error: unknown): Code | null => error instanceof Error && (IMAGE_JOB_FAILURE_CODES as readonly string[]).includes(error.message) ? error.message as Code : null;

/** Resumes only immutable named work. No DB transaction is held across a provider call. */
interface AutomaticOpen {
    ownerUserId: string;
    allowStart: boolean;
    canBoot: (p: ImagePlacement) => Promise<boolean>;
}

// The name survives app restarts and distinguishes open-driven jobs from the
// operator's randomly named repairs. Bind it to the retained source epoch and target.
function automaticJobId(fields: Pick<ImageJob, 'computerId' | 'sourceGeneration' | 'sourceLeaseEpoch'>, amiId: string): string {
    const hex = createHash('sha256').update(JSON.stringify([
        'aws-image-update-on-open-v1', fields.computerId, fields.sourceGeneration, fields.sourceLeaseEpoch, amiId,
    ])).digest('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function isAutomaticImageJob(job: ImageJob) {
    return job.jobId === automaticJobId(job, job.targetRelease.amiId);
}

export async function handleImageRebase(deps: ImageRebaseDeps, raw: unknown, automatic?: AutomaticOpen): Promise<ImageRebaseResponse> {
    let input = ImageRebaseRequestSchema.parse(raw);
    let j: ImageJob | null = null;
    let computerId = input.computerId;
    const reply = (status: number, eligible: boolean, code: Code | null = j?.failureCode ?? null): ImageRebaseResponse => ({ status,
        body: { schemaVersion: 1, computerId: computerId!, jobId: j?.jobId ?? null, phase: j?.phase ?? null, eligible, failureCode: code } });
    const at = () => new Date(Math.max(deps.now().getTime(), j ? Date.parse(j.updatedAt) + 1 : 0)).toISOString();
    const failJob = async (code: Code, uncertain = false) => {
        j = await deps.store.transition(j!, { ...j!, phase: uncertain ? 'unconfirmed' : 'failed', failureCode: code, updatedAt: at() });
    };
    try {
        if (input.operation === 'recover') {
            j = await deps.store.read(input.jobId!);
            if (!j || (computerId && j.computerId !== computerId)) throw new ImageJobConflictError();
            computerId = j.computerId;
        }
        const inspected = await deps.store.inspect(computerId!);
        const p = inspected.placement;
        if (!p || p.provider !== 'aws-ec2' || !p.region) return reply(409, false, 'source_identity_mismatch');
        const retainedPin = input.retainedTargetManifestSha256;
        if (retainedPin && (automatic || !deps.allowRetainedTarget)) return reply(409, false, 'operator_required');
        const approval = retainedPin ? readRetainedRebaseApproval(deps.env, p, retainedPin) : undefined;
        const deploymentEntry = () => (parseRebaseJson(deps.env[LIFECYCLE_DEPLOYMENTS_ENV] ?? '{}', 65536) as Record<string, unknown>)[p.region!];
        if (automatic) {
            if (p.ownerUserId !== automatic.ownerUserId || input.operation !== 'prepare'
                || input.jobId !== null || input.sourceRetirementExecutionArn !== undefined) return reply(409, false);
            const job = inspected.job;
            if (job) {
                if (!isAutomaticImageJob(job) || job.recoveryDocument || job.phase === 'failed') return reply(409, false);
                if (job.launchDocument) {
                    // Billing can prevent a new dispatch, but verification must settle an already launched computer.
                    const canDispatch = job.phase !== 'unconfirmed' && await automatic.canBoot(p);
                    input = { ...input, operation: canDispatch ? 'launch' : 'verify' };
                } else {
                    const canDispatch = job.phase !== 'unconfirmed' && await automatic.canBoot(p);
                    if (job.phase === 'snapshot_ready') {
                        if (!canDispatch) return reply(409, false);
                        input = { ...input, operation: 'launch' };
                    } else if (!canDispatch) input = { ...input, operation: 'verify' };
                }
            } else {
                if (!automatic.allowStart || p.state !== 'STOPPED' || p.lifecycleJobId || !await automatic.canBoot(p))
                    return reply(409, false);
            }
        }
        if (input.operation !== 'recover') j = inspected.job;
        if (input.jobId && j?.jobId !== input.jobId) {
            const terminal = await deps.store.read(input.jobId);
            if (terminal?.computerId === computerId && isTerminalImageJob(terminal.phase) && ['plan', 'verify'].includes(input.operation)
                && !retainedPin && (deps.allowRetainedTarget || !isRetainedRebaseJob(terminal))) {
                j = terminal; return reply(200, terminal.phase === 'succeeded', terminal.failureCode);
            }
            throw new ImageJobConflictError();
        }
        if (j) {
            const retainedJob = isRetainedRebaseJob(j);
            if (retainedJob || approval) {
                if (!retainedJob || !deps.allowRetainedTarget) throw new ImageJobConflictError();
                if (input.operation === 'plan' || input.operation === 'prepare') {
                    const intent = preparationFor(j).intent;
                    const proof = intent.releasedPoolHost ?? intent.retiredSource ?? intent.releasedDedicatedHost;
                    if (!approval || rebaseManifestSha256(j.targetRelease) !== retainedPin
                        || proof?.releaseExecutionArn !== input.sourceRetirementExecutionArn
                        || !isDeepStrictEqual(rebaseReleaseCandidates(deploymentEntry(), p.lowerImageDigest, approval).deployment, intent.deployment)) {
                        throw new ImageJobConflictError();
                    }
                } else if (input.jobId !== j.jobId) throw new ImageJobConflictError();
            }
        }
        if (!isAwsComputersEnabled(deps.env)) return reply(503, false, 'operator_required');
        if (input.operation === 'recover') {
            if (j?.phase === 'recovered') return reply(200, true, null);
            if (!j || inspected.job?.jobId !== j.jobId || !['failed', 'unconfirmed', 'recovery_pending', 'restore_pending', 'rebind_pending'].includes(j.phase)) throw new ImageJobConflictError();
            const result = await resumeImageRecovery(deps, j, true); j = result.job;
            if (result.child) await handleImageRebase(deps, { schemaVersion: 1, operation: 'prepare', computerId, jobId: result.child.jobId });
            return reply(isTerminalImageJob(j.phase) || j.phase === 'failed' ? 200 : 202, j.failureCode === null);
        }
        // Automatic open accepts no client hint. Its trusted allocation record is only a lookup.
        const retirementHint = automatic ? p.retiredHostReleaseArn : input.sourceRetirementExecutionArn;
        /** DESIGN R: a STOPPED computer's released warm-pool host. Its retired claim row switches the source evidence to the
         * provision (b) and release (a) proofs; no row, no change. EC2 must no longer list the host: launch, recovery and
         * maintenance accept an absent source but refuse a listed claim, after the snapshot. Retry once it ages out. */
        const releasedSource = async (d: LifecycleDeployment) => {
            const found = await deps.store.releasedPoolHost(p.computerId);
            if (!found.row) return null;
            if (!isDeepStrictEqual(p, found.placement)) throw new ImageJobConflictError();
            const proof = await readReleasedPoolHostProof(deps.executions, p, d, found.row, retirementHint, deps.now());
            if (!proof || await deps.describer.describeForEnrollment(p.region!, p.instanceId!)) throw new Error('source_identity_mismatch');
            // Observations are outside the lock: never use them for a placement or row that changed meanwhile.
            if (!isDeepStrictEqual(found, await deps.store.releasedPoolHost(p.computerId))) throw new ImageJobConflictError();
            return proof;
        };
        /** DESIGN R2: a STOPPED computer whose regular (non-pool) host EC2 no longer lists. The preparation helper can fence only
         * a listed source, so an aged-out one is eligible only with the operator-named normal release proving it was retired and
         * terminated (aws-historical-source proveRetiredSource); without it, refuse before any reservation. A listed host keeps
         * the existing path. A release is not evidence of the host's AMI (release drains older AMIs), so an aged-out host of a
         * shared lower stays unresolvable, as before. */
        let observed: { host: Ec2EnrollmentView | null } | undefined;
        /** One EC2 observation of the placement's own source, shared by R2 and the shared-lower AMI disambiguation. */
        const observe = async () => (observed ??= { host: await deps.describer.describeForEnrollment(p.region!, p.instanceId!) }).host;
        const retiredSource = async (d: LifecycleDeployment, shared: boolean) => {
            if (!p.instanceId || await observe()) return null;
            // Only a STOPPED placement can have a retired source; any other unlisted source is never reserved blind.
            if (p.state !== 'STOPPED' || shared) throw new Error('source_identity_mismatch');
            const proof = await readRetiredSourceProof(deps.executions, p, d, retirementHint, deps.now());
            if (!proof) throw new Error('source_identity_mismatch');
            // Observations are outside the lock: still the same placement, and still no claim row.
            const fresh = await deps.store.releasedPoolHost(p.computerId);
            if (fresh.row || !isDeepStrictEqual(p, fresh.placement)) throw new ImageJobConflictError();
            return proof;
        };
        /** Dedicated source, chosen ONLY for a shared registry lower (a release is no AMI evidence there; a unique lower stays
         * R2 whatever archive exists). A listed host keeps the existing AMI observation. Otherwise the archived job whose own
         * launch/rebind enrolled this exact instance must be strict (any partial, duplicate or nonterminal archive fails closed
         * in the store) and its launch AMI and retirement proven; never R2 after a failure. No archive: MAIN's shared refusal. */
        const dedicatedSource = async (d: LifecycleDeployment) => {
            if (!p.instanceId || await observe()) return null;
            const found = await deps.store.releasedDedicatedHost(p.computerId);
            if (!isDeepStrictEqual(p, found.placement)) throw new ImageJobConflictError();
            if (!found.row) return null;
            const proof = await readReleasedDedicatedHostProof(deps.executions, p, d, found.row, retirementHint, deps.now());
            if (!proof) throw new Error('source_identity_mismatch');
            // Observations are outside the lock: still the same placement and archive, and still no claim row.
            if (!isDeepStrictEqual(found, await deps.store.releasedDedicatedHost(p.computerId))
                || (await deps.store.releasedPoolHost(p.computerId)).row) throw new ImageJobConflictError();
            return proof;
        };
        const resolve = async () => {
            const entry = deploymentEntry();
            let candidates: ReturnType<typeof rebaseReleaseCandidates>;
            try { candidates = rebaseReleaseCandidates(entry, p.lowerImageDigest, approval); }
            catch (error) { throw new Error(failure(error) ?? 'release_mismatch'); }
            // Proof kind from trusted inputs only, before any kind-specific proof: a pool claim row, else the registry's source
            // count for the placement's recorded lower (unique => R2 only; shared => dedicated only). The request hint never selects it.
            const shared = candidates.sources.length > 1;
            const released = await releasedSource(candidates.deployment);
            const dedicated = released || !shared ? null : await dedicatedSource(candidates.deployment);
            const retired = released || shared ? null : await retiredSource(candidates.deployment, false);
            if (approval && !released && !retired && !dedicated) throw new Error('source_identity_mismatch');
            let imageId: string | undefined;
            if (!released && !dedicated && !retired && shared) {
                if (!p.instanceId) throw new Error('source_identity_mismatch');
                const host = await observe();
                // Observation is outside the lock. Never use it for a placement that changed meanwhile.
                const fresh = await deps.store.inspect(p.computerId);
                if (!isDeepStrictEqual(p, fresh.placement)) throw new ImageJobConflictError();
                const namespace = (entry as { namespace: string }).namespace;
                const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': namespace,
                    'ezil:computer-id': p.computerId, 'ezil:generation': String(p.generation), 'ezil:fence-token': p.fenceToken };
                if (!host || host.instanceId !== p.instanceId || !['running', 'stopped'].includes(host.state)
                    || host.availabilityZoneId !== p.zoneId || Object.entries(tags).some(([k, v]) => host.tags[k] !== v))
                    throw new Error('source_identity_mismatch');
                imageId = host.imageId;
            }
            try { return { ...resolveRebaseReleases(entry, p.lowerImageDigest, imageId, (released ?? dedicated)?.provisioned, approval), released, dedicated, retired }; }
            catch (error) { throw new Error(failure(error) ?? 'release_mismatch'); }
        };
        if (input.operation === 'plan') {
            if (j) return reply(200, !['failed', 'unconfirmed'].includes(j.phase));
            await resolve();
            if (p.lifecycleJobId || !['STOPPED', 'RUNNING'].includes(p.state)) return reply(200, false, 'image_job_conflict');
            return reply(200, true, null);
        }
        if (!j) {
            if (input.operation === 'verify') return reply(200, false, null);
            if (input.operation !== 'prepare') throw new ImageJobConflictError();
            const r = await resolve();
            if (!p.instanceId || !p.volumeId || !p.fsUuid || !p.fenceToken || !p.instanceType) return reply(409, false, 'source_identity_mismatch');
            const volume = await deps.describer.describeVolume(p.region, p.volumeId);
            if (!volume || !volume.sizeGiB) return reply(503, false, 'volume_not_available');
            const allocation = { computerId: p.computerId, sourceGeneration: p.generation,
                sourceLeaseEpoch: p.leaseEpoch, sourceFenceToken: p.fenceToken };
            const id = retainedPin ? retainedRebaseJobId(allocation, retainedPin)
                : automatic ? automaticJobId(allocation, r.target.amiId) : (deps.newId ?? randomUUID)();
            const prep = buildRebasePreparation({ schemaVersion: 1, jobId: id, computerId: p.computerId,
                sourceInstanceId: p.instanceId, sourceVolumeId: p.volumeId, fsUuid: p.fsUuid, sourceGeneration: p.generation,
                sourceLeaseEpoch: p.leaseEpoch, sourceFenceToken: p.fenceToken, fromDigest: r.source.lowerImageDigest,
                toDigest: r.target.lowerImageDigest, volumeGiB: volume.sizeGiB, sourceDeployment: sourceDeploymentFor(r.deployment, r.source),
                deployment: r.deployment, createdAt: deps.now().toISOString(), ...(r.released ? { releasedPoolHost: { poolHostId: r.released.poolHostId,
                    lifecycleDigest: r.released.lifecycleDigest, releaseExecutionArn: r.released.releaseExecutionArn } }
                    : r.retired ? { retiredSource: { releaseExecutionArn: r.retired.releaseExecutionArn } }
                    : r.dedicated ? { releasedDedicatedHost: { imageJobId: r.dedicated.imageJobId, provisionDigest: r.dedicated.provisionDigest,
                        provisionExecutionArn: r.dedicated.provisionExecutionArn, releaseExecutionArn: r.dedicated.releaseExecutionArn } } : {}) });
            j = await deps.store.reserve(newReservedImageJob({ preparation: prep, ownerUserId: p.ownerUserId,
                sourceRelease: r.source, targetRelease: r.target }), r.repository, Boolean(automatic), retainedPin);
        }
        if (isTerminalImageJob(j.phase)) return reply(200, j.phase === 'succeeded');
        if (j.recoveryDocument) {
            if (input.operation !== 'verify') throw new ImageJobConflictError();
            j = (await resumeImageRecovery(deps, j, false)).job; return reply(j.phase === 'failed' ? 200 : 202, j.failureCode === null);
        }
        if (j.phase === 'failed') return reply(input.operation === 'verify' ? 200 : 409, false);
        const describe = async (work: { input: string; stateMachineArn: string; name: string }): Promise<Execution | null> => {
            const arn = work.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${work.name}`);
            try { const e = await deps.executions.describe(j!.region, arn); assertImageExecution(e, work); return e; }
            catch (error) { if (isExecutionAbsent(error)) return null; throw error; }
        };
        const start = async (work: { input: string; stateMachineArn: string; name: string }, mode: 'preparation' | 'launch') => {
            if (!await deps.store.authority({ computerId: j!.computerId, imageJobId: j!.jobId, imageJobPhase: mode,
                jobId: mode === 'preparation' ? j!.jobId : j!.launchJobId!, leaseEpoch: mode === 'preparation' ? j!.sourceLeaseEpoch : j!.targetLeaseEpoch!,
                digest: mode === 'preparation' ? j!.preparationDigest : j!.launchDigest! }, deps.now())) throw new Error('authority_revoked');
            try { await deps.starter.start(j!.region, work); }
            catch (error) { await failJob(mode === 'preparation' ? 'preparation_failed' : 'launch_unconfirmed', (!isDefiniteAwsRefusal(error) || toAwsClientError(error).retryable)); }
        };
        if (!j.launchDocument) {
            const work = preparationFor(j);
            let execution = await describe(work);
            if (!execution && input.operation === 'prepare') {
                if (j.phase === 'reserved') j = await deps.store.transition(j, { ...j, phase: 'fencing', updatedAt: at() });
                await start(work, 'preparation');
                if (j.phase === 'failed' || j.phase === 'unconfirmed') return reply(202, false);
                execution = await describe(work);
            }
            if (execution?.status === 'SUCCEEDED') {
                const receipt = validateRebaseSnapshotReceipt(parseRebaseJson(execution.output ?? '', 8192), work, deps.now());
                const verified = verifyImageSnapshot(j, execution, await deps.describer.describeSnapshot(j.region, receipt.snapshotId), deps.now());
                if (j.phase === 'fencing') j = await deps.store.transition(j, { ...j, phase: 'snapshot_pending', updatedAt: at() });
                if (j.phase !== 'snapshot_ready') j = await deps.store.reconcilePreparation(j, verified, deps.now());
                await recordComputeMeter(() => deps.meter?.stopped({ userId: j!.ownerUserId, computerId: j!.computerId,
                    endedAt: new Date(verified.fencedAt), reason: 'provider_stop' }));
            } else if (execution && execution.status !== 'RUNNING') {
                const code = execution.status === 'TIMED_OUT' ? 'preparation_timeout' : failure(new Error(execution.cause ?? '')) ?? 'preparation_failed';
                await failJob(code, execution.error === 'RebasePreparationUnconfirmed'); return reply(200, false);
            } else return reply(input.operation === 'launch' ? 409 : 202, input.operation !== 'launch', input.operation === 'launch' ? 'snapshot_pending' : j.failureCode);
            if (input.operation !== 'launch') return reply(200, true, null);
            const enrollUrl = readAwsEnrollUrl(deps.env);
            if (!enrollUrl || !p.instanceType) return reply(503, false, 'operator_required');
            const now = deps.now(), nonce = issueEnrollmentNonce(now), jobId = (deps.newId ?? randomUUID)(), fenceToken = (deps.newId ?? randomUUID)();
            const generation = j.sourceGeneration + 1, epoch = Math.max(p.leaseEpoch, j.sourceLeaseEpoch) + 1;
            const permit = { v: 1 as const, preparationJobId: j.jobId, launchJobId: jobId, computerId: j.computerId, fsUuid: j.fsUuid,
                generation, leaseEpoch: epoch, fenceToken, issuedAt: now.toISOString(), expiresAt: nonce.expiresAt.toISOString() };
            const workLaunch = buildLifecycleWork({ schemaVersion: 1, jobId, computerId: j.computerId, revision: 1, operation: 'replace',
                targetGeneration: generation, fenceToken, providerInstanceId: null, dataVolumeId: j.sourceVolumeId,
                previousGeneration: j.sourceGeneration, previousInstanceId: j.sourceInstanceId, previousFenceToken: j.sourceFenceToken,
                deployment: work.intent.deployment, instanceType: p.instanceType, dataVolumeGiB: null, leaseEpoch: epoch,
                userData: buildEnrollmentUserData({ computerId: j.computerId, volumeId: j.sourceVolumeId, fsUuid: j.fsUuid, generation,
                    leaseEpoch: epoch, nonce: nonce.nonce, provision: false, enrollUrl, rebase: { snapshotId: j.snapshotId!, volumeId: j.sourceVolumeId,
                        fromDigest: j.fromDigest, toDigest: j.toDigest }, rebasePermit: permit }),
                rebasePreparation: { v: 1, preparationJobId: j.jobId, executionArn: j.preparationExecutionArn!, digest: j.preparationDigest } });
            j = await deps.store.admitLaunch(j, workLaunch, now);
        }
        const work = launchFor(j);
        const permitExpiresAt = () => {
            const lease = JSON.parse(Buffer.from(work.intent.userData!, 'base64').toString('utf8')) as { rebasePermit: { expiresAt: string } };
            return Date.parse(lease.rebasePermit.expiresAt);
        };
        let execution = await describe(work);
        if (!execution && input.operation === 'launch') {
            if (permitExpiresAt() - deps.now().getTime() <= 120000) {
                await failJob('enrollment_time_insufficient', true); return reply(200, false);
            }
            // Recheck the original execution AND the completed snapshot on every launch retry.
            const prep = preparationFor(j), e = await describe(prep);
            if (!e) throw new Error('snapshot_missing');
            verifyImageSnapshot(j, e, await deps.describer.describeSnapshot(j.region, j.snapshotId!), deps.now());
            await start(work, 'launch');
            if (j.phase === 'failed' || j.phase === 'unconfirmed') return reply(202, false);
            execution = await describe(work);
        }
        if (execution && j.phase === 'unconfirmed' && ['RUNNING', 'SUCCEEDED'].includes(execution.status)) j = await deps.store.resumeLaunch(j, execution, 'launch', deps.now());
        if (!execution && isAutomaticImageJob(j) && permitExpiresAt() <= deps.now().getTime()) {
            if (j.phase !== 'unconfirmed') await failJob('enrollment_time_insufficient', true);
            return reply(409, false);
        }
        if (!execution || execution.status === 'RUNNING') return reply(202, true);
        if (execution.status !== 'SUCCEEDED') { await failJob('launch_failed'); return reply(200, false); }
        const receipt = ImageLaunchReceiptSchema.parse(parseRebaseJson(execution.output ?? '', 8192));
        const [host, volume] = await Promise.all([deps.describer.describeForEnrollment(j.region, receipt.instanceId), deps.describer.describeVolume(j.region, j.sourceVolumeId)]);
        const evidence = { execution, host, volume };
        j = await deps.store.observeLaunch(j, evidence, deps.now());
        const fresh = await deps.store.inspect(j.computerId);
        j = fresh.job!;
        if (!j.hostEvidence || fresh.placement?.lastError !== 'enroll_succeeded') {
            if (!j.hostEvidence && fresh.placement?.enrollExpiresAt && fresh.placement.enrollExpiresAt.getTime() <= deps.now().getTime()) {
                await failJob('enrollment_failed'); return reply(200, false);
            }
            return reply(202, true, null);
        }
        if (!await deps.desktopHealthy(fresh.placement)) {
            // Failed automatic launches retain their snapshot and evidence for the existing recovery operator.
            if (isAutomaticImageJob(j) && permitExpiresAt() <= deps.now().getTime()) {
                await failJob('desktop_unhealthy'); return reply(200, false);
            }
            return reply(202, false, 'desktop_unhealthy');
        }
        j = await deps.store.succeed(j, { ...evidence, desktopHealthy: true }, deps.now());
        const size = meteredSizeForInstanceType(fresh.placement.instanceType);
        if (size) await recordComputeMeter(() => deps.meter?.ready({ userId: j!.ownerUserId, computerId: j!.computerId,
            size, readyAt: deps.now(), overheadSeconds: execution.startDate ? Math.max(0, Math.floor((deps.now().getTime() - execution.startDate.getTime()) / 1000)) : 0 }));
        return reply(200, true, null);
    } catch (error) {
        if (!computerId) throw new ImageJobConflictError();
        if (error instanceof ImageJobConflictError) return reply(409, false, 'image_job_conflict');
        const code = failure(error);
        if (j && input.operation !== 'plan') {
            try {
                j = await deps.store.read(j.jobId) ?? j;
                if (code && !['operator_required', 'image_job_conflict', 'unsupported_predecessor', 'release_mismatch'].includes(code)
                    && !isTerminalImageJob(j.phase) && j.phase !== 'failed') await failJob(code, true);
            } catch { /* A lost evidence CAS leaves custody with the newer row. */ }
        }
        if (code) return reply(input.operation === 'plan' || input.operation === 'verify' ? 200 : 409, false, code);
        // An uncoded failure is otherwise invisible to the operator (seen live 2026-10-22: prepare
        // answered 503 with no job and no log). Error class and a short message only; no request body.
        console.error('[image-rebase] unexpected failure', { operation: input.operation, computerId, jobId: j?.jobId ?? null,
            name: error instanceof Error ? error.name : typeof error, message: (error instanceof Error ? error.message : String(error)).slice(0, 300) });
        return reply(503, false, 'operator_required');
    }
}
