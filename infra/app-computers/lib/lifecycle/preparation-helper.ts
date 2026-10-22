import { z } from 'zod';
import { awsDependencies, type Dependencies } from './aws.js';
import { SettingsSchema, equal, tagList, type Settings } from './contract.js';
import { assertAttached, assertOnlyExpectedDisks, launchParameters, tagged } from './helper.js';
import { parsePreparationInput, preparationAuthority, preparationSourceTags, preparationTags, REBASE_PREPARATION_TIMEOUT_SECONDS } from './preparation-contract.js';
import { assertSnapshot, preparationReceipt } from './preparation-evidence.js';
import { SNAP, TIME } from './strict-json.js';
import { NO_ERROR, RecordedErrorSchema } from './errors.js';
import type { LifecycleIntent } from './intent.js';

export const PreparationControlSchema = z.object({
    fencedAt: TIME.nullable(), snapshotId: SNAP.nullable(), snapshotCompletedAt: TIME.nullable(),
    createAttempted: z.boolean(), lastError: RecordedErrorSchema,
}).strict();
export const preparationControl = { fencedAt: null, snapshotId: null, snapshotCompletedAt: null, createAttempted: false, lastError: NO_ERROR };
export const preparationPhases = ['initial', 'stopped', 'terminated', 'snapshot'] as const;
const Event = z.object({ executionArn: z.string().max(300), phase: z.enum(preparationPhases), control: PreparationControlSchema }).strict();

export function createPreparationHelper(settings: Settings, deps: Dependencies) {
    return async (input: unknown): Promise<Record<string, unknown>> => {
        let uncertain = false;
        try {
            const e = Event.parse(input), control = { ...e.control }, d = settings.deployment;
            const version = d.preparationStateMachineVersionArn;
            if (!version || !deps.imageAuthority || !deps.snapshots) throw new Error('preparation_failed');
            const machine = version.replace(/:[1-9][0-9]*$/, '');
            if (!e.executionArn.startsWith(machine.replace(':stateMachine:', ':execution:') + ':computer-')) throw new Error('preparation_failed');
            const execution = await deps.execution(e.executionArn), now = deps.now();
            if (execution.executionArn !== e.executionArn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== version
                || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.status !== 'RUNNING'
                || !execution.input || !execution.startDate) throw new Error('preparation_failed');
            const { document: i, envelope } = parsePreparationInput(execution.input);
            const began = execution.startDate.getTime();
            if (execution.name !== `computer-${i.jobId}` || e.executionArn !== machine.replace(':stateMachine:', ':execution:') + ':' + execution.name
                || !equal(i.deployment, d) || !Number.isFinite(began) || began < Date.parse(i.createdAt) || began > now)
                throw new Error('preparation_failed');
            if (now - began >= REBASE_PREPARATION_TIMEOUT_SECONDS * 1000) throw new Error('preparation_timeout');
            const authorized = async () => {
                if (!await deps.imageAuthority!(preparationAuthority(i, envelope.digest))) throw new Error('authority_revoked');
            };
            await authorized();
            const emit = (decision: string, extra: object = {}) => ({ decision, phase: e.phase, control, ...extra });
            const action = async (decision: string, parameters: object) => {
                await authorized();
                if (deps.now() - began >= (REBASE_PREPARATION_TIMEOUT_SECONDS - 30) * 1000) throw new Error('preparation_timeout');
                return emit(decision, { parameters });
            };
            // Source release semantics are validated by the input parser and
            // the source instance's AMI below. Validate the target live template.
            await launchParameters({ deployment: d, instanceType: d.instanceTypes[0]!,
                operation: 'replace', userData: '', computerId: i.computerId, targetGeneration: i.sourceGeneration,
                fenceToken: i.sourceFenceToken } as LifecycleIntent, envelope.digest, deps);
            const volumes = await deps.volumes([i.sourceVolumeId]);
            const v = volumes[0];
            if (volumes.length !== 1 || v?.VolumeId !== i.sourceVolumeId || !tagged(v.Tags, preparationSourceTags(i))
                || v.Tags?.some(t => t.Key === 'ezil:pool') || v.VolumeType !== 'gp3' || v.Size !== i.volumeGiB
                || v.Encrypted !== true || v.KmsKeyId !== d.dataKeyArn || v.AvailabilityZoneId !== d.zoneId
                || v.MultiAttachEnabled !== false || !Array.isArray(v.Attachments)) throw new Error('source_identity_mismatch');
            const rows = await deps.instances([i.sourceInstanceId]), source = rows[0]?.instance;
            if (rows.length > 1 || (source && (rows[0]!.owner !== d.accountId || source.InstanceId !== i.sourceInstanceId)))
                throw new Error('source_identity_mismatch');
            if (source) {
                const { 'ezil:backup': ignored, ...tags } = preparationSourceTags(i);
                if (!tagged(source.Tags, tags) || source.Tags?.some(t => t.Key === 'ezil:pool')
                    || source.ImageId !== i.sourceDeployment.amiId
                    || (source.Placement?.AvailabilityZoneId !== undefined && source.Placement.AvailabilityZoneId !== d.zoneId)
                    || (source.SubnetId !== undefined && source.SubnetId !== i.sourceDeployment.subnetId)) throw new Error('source_identity_mismatch');
                const state = source.State?.Name;
                if (state !== 'terminated') {
                    if (control.fencedAt || control.createAttempted) throw new Error('writer_not_fenced');
                    if (state === 'stopping' || state === 'shutting-down') return emit('wait');
                    if (state === 'stopped') {
                        if (!['initial', 'stopped'].includes(e.phase)) return emit('wait');
                        assertAttached(source, v, i.sourceInstanceId); assertOnlyExpectedDisks(source, v, i.sourceDeployment.storage.rootDeviceName);
                        return await action('terminateInstances', { InstanceIds: [i.sourceInstanceId] });
                    }
                    if (!['running', 'pending'].includes(state ?? '')) throw new Error('source_identity_mismatch');
                    if (e.phase !== 'initial') return emit('wait');
                    assertAttached(source, v, i.sourceInstanceId);
                    return await action('stopInstances', { InstanceIds: [i.sourceInstanceId], Force: false, Hibernate: false, SkipOsShutdown: false });
                }
            } else if (!control.fencedAt) throw new Error('writer_not_fenced');
            if (v.State !== 'available' || v.Attachments.length) return emit('wait');
            control.fencedAt ??= new Date(now).toISOString();
            if (Date.parse(control.fencedAt) < began || Date.parse(control.fencedAt) > now) throw new Error('snapshot_not_fresh');
            if (!control.snapshotId && !control.createAttempted)
                return await action('createSnapshot', { VolumeId: i.sourceVolumeId, Description: 'EZiL pre-rebase checkpoint',
                    TagSpecifications: [{ ResourceType: 'snapshot', Tags: tagList(preparationTags(i)) }] });
            uncertain = !control.snapshotId;
            const snapshots = await deps.snapshots(control.snapshotId ? [control.snapshotId] : { tags: preparationTags(i) });
            if (snapshots.length > 1) throw new Error('snapshot_ambiguous');
            if (!snapshots.length) throw new Error(uncertain ? 'snapshot_create_unconfirmed' : 'snapshot_missing');
            const snapshot = snapshots[0]!;
            if (control.snapshotId && snapshot.SnapshotId !== control.snapshotId) throw new Error('snapshot_identity_mismatch');
            assertSnapshot(snapshot, i, control.fencedAt, now, false);
            control.snapshotId = snapshot.SnapshotId!;
            if (snapshot.State !== 'completed') return emit('wait');
            control.snapshotCompletedAt ??= new Date(now).toISOString();
            if (Date.parse(control.snapshotCompletedAt) < snapshot.StartTime!.getTime() || Date.parse(control.snapshotCompletedAt) > now)
                throw new Error('snapshot_not_fresh');
            await authorized();
            if (deps.now() - began >= REBASE_PREPARATION_TIMEOUT_SECONDS * 1000) throw new Error('preparation_timeout');
            const receipt = preparationReceipt(i, envelope.digest, snapshot, control.fencedAt, control.snapshotCompletedAt, new Date(deps.now()).toISOString());
            if (Buffer.byteLength(JSON.stringify(receipt)) > 8192) throw new Error('preparation_failed');
            return emit('success', { receipt });
        } catch (error) {
            const codes = ['authority_revoked', 'source_identity_mismatch', 'writer_not_fenced', 'volume_not_available', 'preparation_timeout',
                'snapshot_create_unconfirmed', 'snapshot_missing', 'snapshot_error', 'snapshot_ambiguous', 'snapshot_identity_mismatch', 'snapshot_not_fresh'];
            const code = error instanceof Error && codes.includes(error.message) ? error.message : 'preparation_failed';
            return { decision: uncertain || code === 'snapshot_create_unconfirmed' ? 'unconfirmed' : 'failed', code };
        }
    };
}
let helper: ReturnType<typeof createPreparationHelper> | undefined;
export async function handler(input: unknown) {
    if (!helper) { const settings = SettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_SETTINGS ?? ''));
        helper = createPreparationHelper(settings, awsDependencies(settings)); }
    return helper(input);
}
