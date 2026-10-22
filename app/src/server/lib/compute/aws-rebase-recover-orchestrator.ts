import { randomUUID } from 'node:crypto';
import { LifecycleDeploymentSchema, buildLifecycleWork } from './aws-intent';
import { buildEnrollmentUserData, issueEnrollmentNonce } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { readAwsEnrollUrl } from './aws-config';
import { assertImageExecution, preparationFor, launchFor, verifyImageSnapshot, ImageLaunchReceiptSchema } from './aws-rebase-evidence';
import { buildImageRecovery, recoveryFor, ImageRestoreReceiptSchema } from './aws-rebase-recovery';
import { isDefiniteAwsRefusal, isExecutionAbsent, toAwsClientError } from './aws-errors';
import { parseRebaseJson } from './aws-rebase-json';
import type { ImageJob } from './aws-rebase-store';
import type { ImageRebaseDeps } from './aws-rebase-orchestrator';

/** Explicit recovery may start work; verify only adopts independently verified results. */
export async function resumeImageRecovery(deps: ImageRebaseDeps, initial: ImageJob, mutate: boolean): Promise<{ job: ImageJob; child?: ImageJob }> {
    let j = initial;
    const now = deps.now;
    const updated = () => new Date(Math.max(now().getTime(), Date.parse(j.updatedAt) + 1)).toISOString();
    const describe = async (w: { stateMachineArn: string; name: string; input: string }) => {
        const arn = w.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${w.name}`);
        try { const e = await deps.executions.describe(j.region, arn); assertImageExecution(e, w); return e; }
        catch (error) { if (isExecutionAbsent(error)) return null; throw error; }
    };
    const checkpoint = async () => {
        const w = preparationFor(j), e = await describe(w);
        if (!e) throw new Error('snapshot_missing');
        verifyImageSnapshot(j, e, await deps.describer.describeSnapshot(j.region, j.snapshotId!), now());
    };
    const start = async (w: { stateMachineArn: string; name: string; input: string }, phase: 'recovery' | 'rebind') => {
        if (!await deps.store.authority({ computerId: j.computerId, imageJobId: j.jobId, imageJobPhase: phase,
            jobId: phase === 'recovery' ? j.recoveryJobId! : j.rebindJobId!, leaseEpoch: phase === 'recovery' ? j.sourceLeaseEpoch : j.rebindLeaseEpoch!,
            digest: phase === 'recovery' ? j.recoveryDigest! : j.rebindDigest! }, now())) throw new Error('authority_revoked');
        try { await deps.starter.start(j.region, w); return true; }
        catch (error) {
            j = await deps.store.transition(j, { ...j, phase: isDefiniteAwsRefusal(error) && !toAwsClientError(error).retryable ? 'failed' : 'unconfirmed',
                failureCode: phase === 'recovery' ? 'restore_failed' : 'rebind_failed', updatedAt: updated() }); return false;
        }
    };
    if (!j.recoveryDocument) {
        if (!mutate || !j.launchDocument || j.hostEvidence || !['failed', 'unconfirmed'].includes(j.phase)) throw new Error('operator_required');
        // Nullable legacy source records cannot authorize recovery or maintenance rebind (A1/A3).
        const source = LifecycleDeploymentSchema.safeParse(preparationFor(j).intent.sourceDeployment);
        if (!source.success || !source.data.recoveryStateMachineVersionArn || !source.data.preparationStateMachineVersionArn
            || j.sourceRelease.agentCommit !== j.targetRelease.agentCommit) throw new Error('operator_required');
        await checkpoint();
        const failed = await describe(launchFor(j));
        if (!failed || failed.status === 'RUNNING') throw new Error('writer_not_fenced');
        const work = buildImageRecovery({ schemaVersion: 1, jobId: (deps.newId ?? randomUUID)(), imageJobId: j.jobId,
            sourceExecutionArn: j.launchExecutionArn!, rebasePreparation: { v: 1, preparationJobId: j.jobId,
                executionArn: j.preparationExecutionArn!, digest: j.preparationDigest }, computerId: j.computerId,
            originalVolumeId: j.sourceVolumeId, fsUuid: j.fsUuid, sourceGeneration: j.sourceGeneration, sourceLeaseEpoch: j.sourceLeaseEpoch,
            sourceFenceToken: j.sourceFenceToken, fromDigest: j.fromDigest, snapshotId: j.snapshotId!, deployment: source.data, createdAt: now().toISOString() });
        j = await deps.store.admitRecovery(j, work, failed, now());
    }
    if (!j.rebindDocument) {
        const w = recoveryFor(j); let e = await describe(w);
        if (!e && mutate) { await checkpoint(); if (!await start(w, 'recovery')) return { job: j }; e = await describe(w); }
        if (!e) return { job: j };
        if (['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)) {
            if (j.phase !== 'failed') j = await deps.store.transition(j, { ...j, phase: e.error === 'EbsRestoreUnconfirmed' ? 'unconfirmed' : 'failed',
                failureCode: 'restore_failed', updatedAt: updated() });
            return { job: j };
        }
        if (j.phase === 'recovery_pending' || j.phase === 'unconfirmed') j = await deps.store.observeRecovery(j, e, now());
        if (e.status !== 'SUCCEEDED') return { job: j };
        const r = ImageRestoreReceiptSchema.parse(parseRebaseJson(e.output ?? '', 8192));
        await checkpoint();
        const [volume, original] = await Promise.all([deps.describer.describeVolume(j.region, r.volumeId), deps.describer.describeVolume(j.region, j.sourceVolumeId)]);
        j = await deps.store.observeRestore(j, { execution: e, volume, original }, now());
        if (!mutate) return { job: j };
        const placement = (await deps.store.inspect(j.computerId)).placement!;
        const enrollUrl = readAwsEnrollUrl(deps.env); if (!enrollUrl || !placement.instanceType) throw new Error('operator_required');
        const nonce = issueEnrollmentNonce(now()), jobId = (deps.newId ?? randomUUID)(), fenceToken = (deps.newId ?? randomUUID)();
        const generation = Math.max(j.sourceGeneration, j.targetGeneration!) + 1, leaseEpoch = Math.max(j.sourceLeaseEpoch, j.targetLeaseEpoch!, placement.leaseEpoch) + 1;
        const userData = buildEnrollmentUserData({ computerId: j.computerId, volumeId: j.restoredVolumeId!, fsUuid: j.fsUuid,
            generation, leaseEpoch, nonce: nonce.nonce, provision: false, enrollUrl, ebsRestore: { v: 1, preparationJobId: j.jobId,
                recoveryJobId: j.recoveryJobId!, launchJobId: jobId, snapshotId: j.snapshotId!, originalVolumeId: j.sourceVolumeId,
                volumeId: j.restoredVolumeId!, computerId: j.computerId, fsUuid: j.fsUuid, fromDigest: j.fromDigest,
                sourceGeneration: j.sourceGeneration, sourceLeaseEpoch: j.sourceLeaseEpoch, generation, leaseEpoch, fenceToken,
                issuedAt: now().toISOString(), expiresAt: nonce.expiresAt.toISOString(), maintenance: true } });
        const work = buildLifecycleWork({ schemaVersion: 1, jobId, computerId: j.computerId, revision: 1, operation: 'replace', targetGeneration: generation,
            fenceToken, providerInstanceId: null, dataVolumeId: j.restoredVolumeId, previousGeneration: j.sourceGeneration,
            previousInstanceId: j.sourceInstanceId, previousFenceToken: j.sourceFenceToken, deployment: w.intent.deployment,
            instanceType: placement.instanceType, dataVolumeGiB: null, leaseEpoch, userData, rebasePreparation: w.intent.rebasePreparation });
        j = await deps.store.admitRebind(j, work, now());
    }
    const w = launchFor(j, 'rebind'); let e = await describe(w);
    if (!e && mutate) {
        const lease = parseEnrollmentUserData(w.intent.userData!);
        if (Date.parse(lease.ebsRestore!.expiresAt) - now().getTime() <= 120000) throw new Error('enrollment_time_insufficient');
        await checkpoint(); if (!await start(w, 'rebind')) return { job: j }; e = await describe(w);
    }
    if (e && j.phase === 'unconfirmed' && ['RUNNING', 'SUCCEEDED'].includes(e.status)) j = await deps.store.resumeLaunch(j, e, 'rebind', now());
    if (!e || e.status === 'RUNNING') return { job: j };
    if (e.status !== 'SUCCEEDED') {
        if (j.phase !== 'failed') j = await deps.store.transition(j, { ...j, phase: 'failed', failureCode: 'rebind_failed', updatedAt: updated() });
        return { job: j };
    }
    const r = ImageLaunchReceiptSchema.parse(parseRebaseJson(e.output ?? '', 8192));
    const [host, volume] = await Promise.all([deps.describer.describeForEnrollment(j.region, r.instanceId), deps.describer.describeVolume(j.region, j.restoredVolumeId!)]);
    j = await deps.store.observeRebind(j, { execution: e, host, volume }, now());
    if (!j.hostEvidence?.ebsRestore || !mutate) return { job: j };
    const transfer = await deps.store.transferRecovered(j, { execution: e, host, volume }, (deps.newId ?? randomUUID)(), now());
    return { job: transfer.recovered, child: transfer.child };
}
