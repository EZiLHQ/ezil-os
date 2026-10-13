import type { Instance, Volume } from '@aws-sdk/client-ec2';
import { z } from 'zod';
import { EnvelopeSchema, equal, tagsFor, token, writerProfile } from './contract.js';
import { parseLifecycleWork } from './intent.js';
import { tagged } from './helper.js';
import { RecoveryInputSchema, RecoverySettingsSchema, machineArn, recoveryPhases,
    type RecoverySettings, type RecoveryReceipt } from './recovery-contract.js';
import { recoveryDependencies, type RecoveryDependencies } from './recovery-aws.js';

const Event = z.object({ executionArn: z.string().max(300), phase: z.enum(recoveryPhases) }).strict();
const fail = (): never => { throw new Error('lifecycle_recovery_unconfirmed'); };
const terminal = ['FAILED', 'ABORTED', 'TIMED_OUT'];

/** Recovery can preserve/stop/terminate only exact historical writers. It has
 * no launch, attach, retag, detach, delete or current-authority capability. */
export function createRecoveryHelper(settings: RecoverySettings, deps: RecoveryDependencies) {
    return async (input: unknown): Promise<Record<string, unknown>> => {
        const e = Event.parse(input), d = settings.lifecycle.deployment;
        const recoveryMachine = machineArn(settings.recoveryVersionArn), sourceMachine = machineArn(d.stateMachineVersionArn);
        if (!e.executionArn.startsWith(recoveryMachine.replace(':stateMachine:', ':execution:') + ':cleanup-computer-')) return fail();
        const execution = await deps.execution(e.executionArn), now = deps.now();
        if (execution.executionArn !== e.executionArn || execution.stateMachineArn !== recoveryMachine
            || execution.stateMachineVersionArn !== settings.recoveryVersionArn || execution.stateMachineAliasArn
            || execution.redriveCount !== 0 || execution.status !== 'RUNNING' || !execution.startDate || !execution.input
            || Buffer.byteLength(execution.input) > 1024) return fail();
        const began = execution.startDate.getTime();
        if (!Number.isFinite(began) || began > now || now - began >= 600000) return fail();
        const { sourceExecutionArn } = RecoveryInputSchema.parse(JSON.parse(execution.input));
        if (!sourceExecutionArn.startsWith(sourceMachine.replace(':stateMachine:', ':execution:') + ':computer-')) return fail();
        const source = await deps.execution(sourceExecutionArn);
        if (source.executionArn !== sourceExecutionArn || source.stateMachineArn !== sourceMachine
            || source.stateMachineVersionArn !== d.stateMachineVersionArn || source.stateMachineAliasArn || source.redriveCount !== 0
            || !terminal.includes(source.status ?? '') || !source.input || Buffer.byteLength(source.input) > 20000
            || !source.startDate || !source.stopDate || !Number.isFinite(source.stopDate.getTime())
            || source.stopDate.getTime() > began || source.stopDate.getTime() < source.startDate.getTime()
            || now - source.startDate.getTime() > 86400000) return fail();
        const envelope = EnvelopeSchema.parse(JSON.parse(source.input));
        const i = parseLifecycleWork({ ...envelope, createdAt: source.startDate });
        const { instanceProfileArn, ...pins } = i.deployment;
        if (!equal(pins, d) || instanceProfileArn !== writerProfile(settings.lifecycle, i)
            || source.name !== `computer-${i.jobId}` || sourceExecutionArn !== sourceMachine.replace(':stateMachine:', ':execution:') + ':' + source.name
            || execution.name !== `cleanup-computer-${i.jobId}`
            || e.executionArn !== recoveryMachine.replace(':stateMachine:', ':execution:') + ':' + execution.name) return fail();
        const wait = () => ({ decision: 'wait', phase: e.phase });
        // Let interrupted SDK tasks settle before reading terminal evidence.
        // This delay alone is never evidence that an allocation did not happen.
        if (now - source.stopDate.getTime() < 60000) return wait();
        const history = await deps.history(sourceExecutionArn);
        if (!history.length || history.length > 4000 || history[0]?.type !== 'ExecutionStarted'
            || history.at(-1)?.type !== ({ FAILED: 'ExecutionFailed', ABORTED: 'ExecutionAborted', TIMED_OUT: 'ExecutionTimedOut' } as Record<string, string>)[source.status!]
            || history.some((h, index) => h.id !== index + 1 || !h.timestamp || !Number.isFinite(h.timestamp.getTime())
                || (h.type === 'TaskStateEntered' && !h.stateEnteredEventDetails?.name))) return fail();
        const entered = (name: string) => history.some(h => h.type === 'TaskStateEntered' && h.stateEnteredEventDetails?.name === name);
        const volumes = await deps.volumes(i.dataVolumeId ? [i.dataVolumeId] : { token: token(envelope.digest, 'volume') });
        if (volumes.length > 1) return fail();
        const v = volumes[0], currentTags = tagsFor(i), oldTags = tagsFor(i, i.previousGeneration ?? i.targetGeneration, i.previousFenceToken ?? i.fenceToken);
        if (v) {
            if (!/^vol-[a-f0-9]{17}$/.test(v.VolumeId ?? '') || (i.dataVolumeId && v.VolumeId !== i.dataVolumeId)
                || v.Encrypted !== true || v.KmsKeyId !== d.dataKeyArn || v.VolumeType !== 'gp3' || v.Size !== 50
                || v.MultiAttachEnabled !== false || v.AvailabilityZone !== d.availabilityZone || !Array.isArray(v.Attachments) || v.Attachments.length > 1
                || (!tagged(v.Tags, currentTags) && !tagged(v.Tags, oldTags))
                || (i.operation === 'provision' && (!entered('createVolume')
                    || !tagged(v.Tags, { 'ezil:allocation': token(envelope.digest, 'volume') })))) return fail();
        } else if (i.dataVolumeId || entered('createVolume') || entered('runInstances')) return wait();
        const targets: { role: 'old' | 'target'; instance: Instance; generation: number; fenceToken: string }[] = [];
        const originalId = i.previousInstanceId ?? i.providerInstanceId;
        if (originalId) {
            const rows = await deps.instances([originalId]);
            if (rows.length !== 1 || rows[0]?.owner !== d.accountId || rows[0].instance.InstanceId !== originalId
                || !tagged(rows[0].instance.Tags, oldTags)) return fail();
            targets.push({ role: 'old', instance: rows[0].instance, generation: i.previousGeneration ?? i.targetGeneration,
                fenceToken: i.previousFenceToken ?? i.fenceToken });
        }
        if (i.operation === 'provision' || i.operation === 'replace') {
            const rows = await deps.instances({ token: token(envelope.digest, 'instance') });
            if (rows.length > 1) return fail();
            if (!rows.length && entered('runInstances')) return wait();
            if (rows[0]) {
                const row = rows[0];
                if (!entered('runInstances') || row.owner !== d.accountId || row.instance.ClientToken !== token(envelope.digest, 'instance')
                    || row.instance.InstanceId === originalId || !tagged(row.instance.Tags, currentTags)) return fail();
                targets.push({ role: 'target', instance: row.instance, generation: i.targetGeneration, fenceToken: i.fenceToken });
            }
        }
        if (targets.length && !v) return fail();
        for (const { instance } of targets) {
            if (!/^i-[a-f0-9]{17}$/.test(instance.InstanceId ?? '') || instance.Placement?.AvailabilityZone !== d.availabilityZone) return fail();
        }
        if (v?.Attachments?.some(a => !targets.some(t => t.instance.InstanceId === a.InstanceId) || a.VolumeId !== v.VolumeId)) return fail();
        const action = (decision: string, parameters: object) => {
            if (deps.now() - began >= 570000) return fail();
            return { decision, parameters };
        };
        for (const target of targets) {
            const { instance, role } = target, id = instance.InstanceId!, state = instance.State?.Name;
            if (state === 'terminated') {
                if (v!.Attachments!.some(a => a.InstanceId === id)) return wait();
                continue;
            }
            if (state === 'shutting-down') return wait();
            // Never regress after requesting a later operation. EC2 reads may
            // briefly return an earlier state with already-detached mappings.
            const phaseIndex = recoveryPhases.indexOf(e.phase);
            if (phaseIndex >= recoveryPhases.indexOf(`${role}-terminated`)) return wait();
            if (!['running', 'pending', 'stopping', 'stopped'].includes(state ?? '')) return fail();
            const preserved = preservation(instance, v!);
            if (preserved === 'wait') return wait();
            if (!preserved) {
                if (phaseIndex >= recoveryPhases.indexOf(`${role}-preserved`)) return wait();
                return action(`preserve-${role}`, { InstanceId: id,
                    BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: v!.VolumeId, DeleteOnTermination: false } }] });
            }
            if (state === 'pending' || state === 'stopping') return wait();
            if (state === 'stopped') return action(`terminate-${role}`, { InstanceIds: [id] });
            if (phaseIndex >= recoveryPhases.indexOf(`${role}-stopped`)) return wait();
            return action(`stop-${role}`, { InstanceIds: [id], Force: false, Hibernate: false, SkipOsShutdown: false });
        }
        if (v && (v.State !== 'available' || v.Attachments!.length)) return wait();
        if (deps.now() - began >= 600000) return fail();
        const receipt: RecoveryReceipt = { schemaVersion: 1, sourceExecutionArn, jobId: i.jobId, digest: envelope.digest,
            computerId: i.computerId, state: 'fenced', volumeId: v?.VolumeId ?? null,
            instances: targets.map(t => ({ instanceId: t.instance.InstanceId!, generation: t.generation, fenceToken: t.fenceToken, state: 'terminated' })) };
        return { decision: 'success', receipt };
    };
}

function preservation(instance: Instance, volume: Volume): boolean | 'wait' {
    if (!Array.isArray(instance.BlockDeviceMappings)) return fail();
    const data = instance.BlockDeviceMappings.filter(m => m.Ebs?.VolumeId === volume.VolumeId);
    const attachments = volume.Attachments!.filter(a => a.InstanceId === instance.InstanceId);
    // An unexpected attached volume must not be destroyed with the root disk.
    if (instance.BlockDeviceMappings.some(m => m.DeviceName !== '/dev/xvda' && m.Ebs?.VolumeId !== volume.VolumeId)) return fail();
    if (!data.length && !attachments.length) return true;
    if (data.length !== 1 || attachments.length !== 1) return 'wait';
    if (data[0]!.DeviceName !== '/dev/sdf' || attachments[0]!.Device !== '/dev/sdf') return fail();
    if (data[0]!.Ebs?.Status !== 'attached' || attachments[0]!.State !== 'attached') return 'wait';
    return data[0]!.Ebs?.DeleteOnTermination === false && attachments[0]!.DeleteOnTermination === false;
}

let helper: ReturnType<typeof createRecoveryHelper> | undefined;
export async function handler(input: unknown) {
    try {
        if (!helper) { const settings = RecoverySettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_RECOVERY_SETTINGS ?? ''));
            helper = createRecoveryHelper(settings, recoveryDependencies(settings)); }
        return await helper(input);
    } catch { return fail(); }
}
