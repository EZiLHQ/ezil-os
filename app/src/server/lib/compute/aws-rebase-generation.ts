import { createHash } from 'node:crypto';
import { z } from 'zod';
import { buildLifecycleWork, KNOWN_INSTANCE_TYPES, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { parseRebaseJson, RebaseHash } from './aws-rebase-json';
import { reconcileReplacementGeneration, type Placement } from './placement';
import type { LifecycleExecutionReader, ReceiptDeps } from './aws-receipts';

const envelopeSchema = z.object({ schemaVersion: z.literal(1), document: z.string(), digest: RebaseHash }).strict();
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;

/** The execution input, not today's deployment or generation-1, supplies source authority. */
export function replacementWorkFromExecution(p: Placement, d: LifecycleDeployment, e: Execution): LifecycleWork | null {
    try {
        if (!e.input || !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)
            || e.stateMachineAliasArn || e.redriveCount !== 0) return null;
        const envelope = envelopeSchema.parse(parseRebaseJson(e.input, 20000));
        if (envelope.digest !== p.lifecycleDigest || createHash('sha256').update(envelope.document).digest('hex') !== envelope.digest) return null;
        const work = buildLifecycleWork(parseRebaseJson(envelope.document) as LifecycleWork['intent']);
        const arn = d.stateMachineVersionArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:computer-${work.intent.jobId}`);
        if (e.executionArn !== arn || work.digest !== envelope.digest || work.intent.deployment.stateMachineVersionArn !== e.stateMachineVersionArn
            || work.intent.deployment.accountId !== d.accountId || work.intent.deployment.region !== d.region || work.intent.deployment.namespace !== d.namespace) return null;
        return matchesPlacement(work, p) ? work : null;
    } catch { return null; }
}

function matchesPlacement(work: LifecycleWork, p: Placement): boolean {
    const i = work.intent;
    return i.operation === 'replace' && !('rebasePreparation' in i) && i.jobId === p.lifecycleJobId && work.digest === p.lifecycleDigest
        && i.computerId === p.computerId && i.targetGeneration === p.generation && i.leaseEpoch === p.leaseEpoch
        && i.fenceToken === p.fenceToken && i.dataVolumeId === p.volumeId && i.deployment.region === p.region && i.deployment.zoneId === p.zoneId;
}

/** No EC2 writes. Unknown, absent or contradictory evidence keeps provisional authority reserved. */
export async function settleReplacementGeneration(deps: ReceiptDeps, p: Placement, work: LifecycleWork,
    startDefinitelyRefused = false): Promise<'settled' | 'unconfirmed' | 'generation_drift'> {
    if (!matchesPlacement(work, p) || !deps.describer?.describeVolume || !deps.describer.describeReplacementWriters) return 'unconfirmed';
    const i = work.intent;
    const common = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': i.deployment.namespace, 'ezil:computer-id': i.computerId };
    const tagsMatch = (tags: Readonly<Record<string, string>> | undefined, generation: number, fence: string) => !!tags
        && Object.entries({ ...common, 'ezil:generation': String(generation), 'ezil:fence-token': fence }).every(([k, v]) => tags[k] === v)
        && tags['ezil:pool'] === undefined;
    try {
        const token = createHash('sha256').update(`ezil-lifecycle-v1\ninstance\n${work.digest}`).digest('hex');
        const source = await deps.describer.describeForEnrollment(p.region!, i.previousInstanceId!);
        const targets = await deps.describer.describeReplacementWriters(p.region!, token);
        // Positive source fence. An unanswered launch needs positive target termination too;
        // a tag search returning zero is not proof that an uncertain launch did nothing.
        if (!source || source.instanceId !== i.previousInstanceId || !tagsMatch(source.tags, i.previousGeneration!, i.previousFenceToken!)
            || (source.state !== 'terminated' && !(startDefinitelyRefused && source.state === 'stopped'))
            || targets.length > 1 || (!startDefinitelyRefused && targets.length !== 1)) return 'unconfirmed';
        if (source.state === 'stopped' && (!source.instanceType || !KNOWN_INSTANCE_TYPES.includes(source.instanceType))) return 'unconfirmed';
        const target = targets[0];
        if (target && (startDefinitelyRefused || target.state !== 'terminated' || target.accountId !== i.deployment.accountId
            || target.clientToken !== token || !/^i-[0-9a-f]{17}$/.test(target.instanceId)
            || !tagsMatch(target.tags, i.targetGeneration, i.fenceToken))) return 'unconfirmed';
        const volume = await deps.describer.describeVolume(p.region!, i.dataVolumeId!);
        if (!volume || volume.volumeId !== i.dataVolumeId || volume.encrypted !== true || volume.kmsKeyId !== i.deployment.dataKeyArn
            || !volume.attachments || volume.tags?.['ezil:backup'] !== i.deployment.namespace) return 'unconfirmed';
        const sourcePair = tagsMatch(volume.tags, i.previousGeneration!, i.previousFenceToken!);
        const targetPair = tagsMatch(volume.tags, i.targetGeneration, i.fenceToken);
        if (!sourcePair && !targetPair) return 'generation_drift';
        if (targetPair && !target) return 'unconfirmed';
        const attachedToStoppedSource = startDefinitelyRefused && source.state === 'stopped' && sourcePair
            && volume.state === 'in-use' && volume.attachments.length === 1
            && volume.attachments[0]!.instanceId === source.instanceId && volume.attachments[0]!.state === 'attached'
            && source.volumes.some((v) => v.volumeId === volume.volumeId && v.deleteOnTermination === false);
        if (!attachedToStoppedSource && (volume.state !== 'available' || volume.attachments.length !== 0)) return 'unconfirmed';
        if (deps.tunnels) {
            const { awsSandboxId } = await import('./aws-enroll');
            const fenced = await deps.tunnels.deleteTunnel({ userId: p.ownerUserId }, {
                computerId: p.computerId, sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch,
            });
            if (!fenced.ok) return 'unconfirmed';
        }
        const result = await reconcileReplacementGeneration(deps.db, p, {
            generation: sourcePair ? i.previousGeneration! : i.targetGeneration,
            fenceToken: sourcePair ? i.previousFenceToken! : i.fenceToken,
            instanceId: sourcePair ? source.instanceId : target!.instanceId,
            instanceLost: sourcePair ? source.state === 'terminated' : true,
            ...(sourcePair && source.state === 'stopped' ? { instanceType: source.instanceType } : {}),
        });
        return result.ok ? 'settled' : 'unconfirmed';
    } catch { return 'unconfirmed'; }
}
