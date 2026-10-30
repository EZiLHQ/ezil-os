import { equal, LAUNCH_ACTIONS, tagList, tagsFor, token } from './contract.js';
import type { LifecycleIntent } from './intent.js';
import { assertOnlyExpectedDisks, assertAttached, launchParameters, tagged } from './helper.js';
import { assertQuarantinedVolume, assertRestoredVolume, verifyImageRecoverySource } from './image-recovery-evidence.js';
import { ImageRecoveryEventSchema, ImageRecoveryReceiptSchema, imageRecoveryPhases, machineArn, parseImageRecoveryInput,
    recoveryAuthority, restoreTags, restoreToken, type RecoverySettings } from './recovery-contract.js';
import type { RecoveryDependencies } from './recovery-aws.js';

/** Read-only observer. The fixed graph alone fences and creates a clone. */
export function createImageRecoveryHelper(settings: RecoverySettings, deps: RecoveryDependencies) {
    return async (input: unknown): Promise<Record<string, unknown>> => {
        let attempted = false;
        try {
            const e = ImageRecoveryEventSchema.parse(input), control = { ...e.control }, d = settings.lifecycle.deployment;
            attempted = control.createAttempted;
            if (!deps.snapshots || !deps.imageAuthority || !deps.image || !deps.template || !deps.restoredVolumes
                || !d.recoveryStateMachineVersionArn) throw new Error('restore_failed');
            const reads = { ...deps, image: deps.image, template: deps.template };
            const machine = machineArn(settings.recoveryVersionArn);
            if (!e.executionArn.startsWith(machine.replace(':stateMachine:', ':execution:') + ':computer-')) throw new Error('restore_failed');
            const execution = await deps.execution(e.executionArn), now = deps.now();
            if (execution.executionArn !== e.executionArn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== settings.recoveryVersionArn
                || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.status !== 'RUNNING'
                || !execution.input || !execution.startDate) throw new Error('restore_failed');
            const { envelope, document: i } = parseImageRecoveryInput(execution.input), began = execution.startDate.getTime();
            if (execution.name !== 'computer-' + i.jobId || e.executionArn !== machine.replace(':stateMachine:', ':execution:') + ':' + execution.name
                || (['accountId', 'region', 'namespace', 'zoneId', 'dataKeyArn', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const).some(k => i.deployment[k] !== d[k])
                || !Number.isFinite(began) || began < Date.parse(i.createdAt) || began > now || now - began >= 7200000) throw new Error('restore_failed');
            const authorize = async () => { if (!await deps.imageAuthority!(recoveryAuthority(i, envelope.digest))) throw new Error('authority_revoked'); };
            await authorize();
            const emit = (decision: string, extra: object = {}) => ({ decision, phase: e.phase, control, ...extra });
            const action = async (decision: string, parameters: object) => {
                await authorize();
                if (deps.now() - began >= 7170000) throw new Error('restore_failed');
                return emit(decision, { parameters });
            };
            const failed = await verifyImageRecoverySource(i, reads), p = failed.preparation.document;
            if (!equal(p.deployment, d)) throw new Error('restore_lineage_mismatch');
            if (now - failed.source.stopDate!.getTime() < 60000) return emit('wait');
            const history = await deps.history(i.sourceExecutionArn);
            const lastType = { FAILED: 'ExecutionFailed', ABORTED: 'ExecutionAborted', TIMED_OUT: 'ExecutionTimedOut' }[failed.source.status as 'FAILED'];
            if (!history.length || history.length > 4000 || history[0]?.type !== 'ExecutionStarted' || history.at(-1)?.type !== lastType
                || history.some((h, index) => h.id !== index + 1 || !h.timestamp || !Number.isFinite(h.timestamp.getTime())
                    || h.timestamp.getTime() < failed.source.startDate!.getTime() || h.timestamp.getTime() > failed.source.stopDate!.getTime()
                    || (index > 0 && h.timestamp.getTime() < history[index - 1]!.timestamp!.getTime())
                    || (h.type === 'TaskStateEntered' && !h.stateEnteredEventDetails?.name))) throw new Error('restore_lineage_mismatch');
            const launched = history.some(h => h.type === 'TaskStateEntered' && LAUNCH_ACTIONS.includes(h.stateEnteredEventDetails?.name as never));
            const originals = await deps.volumes([i.originalVolumeId]);
            if (originals.length !== 1) throw new Error('restore_lineage_mismatch');
            const original = originals[0]!;
            assertQuarantinedVolume(original, i, failed, false);
            const sources = await deps.instances([p.sourceInstanceId]);
            if (sources.length > 1 || sources.some(row => row.owner !== d.accountId || row.instance.InstanceId !== p.sourceInstanceId
                || row.instance.State?.Name !== 'terminated' || !tagged(row.instance.Tags, tagsFor(failed.launch, p.sourceGeneration, p.sourceFenceToken))))
                throw new Error('writer_not_fenced');
            // A successful preparation is positive evidence for an aged-out original.
            const targets = await deps.instances({ token: token(failed.envelope.digest, 'instance') });
            if (targets.length > 1 || (!targets.length && launched && !control.fencedAt)) throw new Error('writer_not_fenced');
            const target = targets[0]?.instance;
            if (target) {
                if (!launched || targets[0]!.owner !== d.accountId || !/^i-[0-9a-f]{17}$/.test(target.InstanceId ?? '')
                    || target.InstanceId === p.sourceInstanceId || target.ClientToken !== token(failed.envelope.digest, 'instance')
                    || !tagged(target.Tags, tagsFor(failed.launch)) || target.Tags?.some(t => t.Key === 'ezil:pool')
                    || (target.SubnetId !== undefined && target.SubnetId !== d.subnetId)
                    || (target.Placement?.AvailabilityZoneId !== undefined && target.Placement.AvailabilityZoneId !== d.zoneId)) throw new Error('restore_lineage_mismatch');
                if (original.Attachments!.some(a => a.InstanceId !== target.InstanceId || a.VolumeId !== original.VolumeId)) throw new Error('restore_lineage_mismatch');
                const state = target.State?.Name;
                if (state !== 'terminated') {
                    if (control.fencedAt || control.createAttempted) throw new Error('writer_not_fenced');
                    if (['pending', 'stopping', 'shutting-down'].includes(state ?? '')) return emit('wait');
                    if (!['running', 'stopped'].includes(state ?? '')) throw new Error('writer_not_fenced');
                    if (imageRecoveryPhases.indexOf(e.phase) >= imageRecoveryPhases.indexOf('target-terminated')) return emit('wait');
                    assertOnlyExpectedDisks(target, original, d.storage.rootDeviceName);
                    const mapped = target.BlockDeviceMappings?.some(m => m.Ebs?.VolumeId === original.VolumeId);
                    if (mapped || original.Attachments!.length) assertAttached(target, original, target.InstanceId!);
                    if (state === 'stopped') return await action('terminate-target', { InstanceIds: [target.InstanceId] });
                    if (e.phase !== 'initial') return emit('wait');
                    return await action('stop-target', { InstanceIds: [target.InstanceId], Force: false, Hibernate: false, SkipOsShutdown: false });
                }
            }
            if (original.State !== 'available' || original.Attachments!.length) return emit('wait');
            assertQuarantinedVolume(original, i, failed);
            control.fencedAt ??= new Date(now).toISOString();
            if (Date.parse(control.fencedAt) < began || Date.parse(control.fencedAt) > now) throw new Error('writer_not_fenced');
            // Validate the pinned source-lower maintenance deployment before cloning.
            await launchParameters({ ...failed.launch, deployment: i.deployment } as LifecycleIntent, envelope.digest, reads);
            const volumes = control.volumeId ? await deps.volumes([control.volumeId]) : await deps.restoredVolumes(restoreTags(i));
            if (volumes.length > 1) throw new Error('restore_lineage_mismatch');
            if (!volumes.length) {
                if (control.volumeId) return emit('wait');
                // EC2 exposes no volume ClientToken in DescribeVolumes. Replay
                // the identical token/request to resolve a lost response; never
                // mint another token or infer absence from a partial tag scan.
                return await action('createVolume', { SnapshotId: i.snapshotId, AvailabilityZoneId: i.deployment.zoneId, Size: p.volumeGiB,
                    VolumeType: 'gp3', Iops: 3000, Throughput: 125, Encrypted: true, KmsKeyId: i.deployment.dataKeyArn,
                    ClientToken: restoreToken(i), TagSpecifications: [{ ResourceType: 'volume', Tags: tagList(restoreTags(i)) }] });
            }
            const v = volumes[0]!;
            assertRestoredVolume(v, i, p.volumeGiB, now);
            if (!control.createAttempted || (control.volumeId && v.VolumeId !== control.volumeId)
                || v.CreateTime!.getTime() < Date.parse(control.fencedAt)) throw new Error('restore_lineage_mismatch');
            control.volumeId = v.VolumeId!;
            if (v.State === 'creating') return emit('wait');
            if (v.State !== 'available' || v.Attachments!.length) throw new Error('restore_lineage_mismatch');
            await authorize();
            if (deps.now() - began >= 7200000) throw new Error('restore_failed');
            const receipt = ImageRecoveryReceiptSchema.parse({ schemaVersion: 1, jobId: i.jobId, digest: envelope.digest,
                imageJobId: i.imageJobId, state: 'restore_volume_ready', sourceExecutionArn: i.sourceExecutionArn,
                snapshotId: i.snapshotId, originalVolumeId: i.originalVolumeId, volumeId: v.VolumeId, fsUuid: i.fsUuid,
                sourceGeneration: i.sourceGeneration, sourceLeaseEpoch: i.sourceLeaseEpoch, sourceFenceToken: i.sourceFenceToken,
                fromDigest: i.fromDigest, verifiedAt: new Date(deps.now()).toISOString() });
            return emit('success', { receipt });
        } catch (error) {
            const code = error instanceof Error && ['authority_revoked', 'restore_lineage_mismatch', 'writer_not_fenced'].includes(error.message)
                ? error.message : 'restore_failed';
            return { decision: attempted || code === 'writer_not_fenced' ? 'unconfirmed' : 'failed', code };
        }
    };
}
