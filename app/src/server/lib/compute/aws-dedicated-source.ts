import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isExecutionAbsent } from './aws-errors';
import { canonicalReleaseWork, executionHistoryBound, terminationWitnessed, type WitnessBounds } from './aws-historical-source';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { lifecycleExecutionArn, LifecycleReceiptSchema, type LifecycleExecutionReader } from './aws-receipts';
import type { ImagePlacement } from './placement';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
/** An archived image job is a lookup/cross-check, never provider proof. No pool identity is invented. */
export interface DedicatedProvisionRecord {
    imageJobId: string; phase: 'succeeded' | 'recovered'; ownerUserId: string; computerId: string;
    region: string; zoneId: string; instanceId: string; volumeId: string; fsUuid: string;
    generation: number; leaseEpoch: number; fenceToken: string; lowerImageDigest: string;
    document: string; digest: string; executionArn: string;
}
export interface ReleasedDedicatedHostProof {
    imageJobId: string; provisionDigest: string; provisionExecutionArn: string;
    releaseExecutionArn: string; provisioned: LifecycleDeployment;
}
const JOB = /^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const authority = (a: LifecycleDeployment, b: LifecycleDeployment) =>
    (['accountId', 'region', 'zoneId', 'namespace'] as const).every(k => a[k] === b[k]);
const json = (value: string | undefined) => { try { return JSON.parse(value ?? '') as unknown; } catch { return undefined; } };

/** Rebuild exactly the archived dedicated replace; never use a retirement's requested deployment as its launch tuple. */
export function dedicatedProvisionWork(p: ImagePlacement, d: LifecycleDeployment, row: DedicatedProvisionRecord): LifecycleWork | null {
    try {
        if (p.state !== 'STOPPED' || p.provider !== 'aws-ec2' || p.store !== 'ebs' || p.lifecycleJobId
            || !p.instanceId || !p.volumeId || !p.fenceToken || !p.fsUuid || p.region !== d.region || p.zoneId !== d.zoneId
            || !UUID.test(row.imageJobId) || !['succeeded', 'recovered'].includes(row.phase)
            || row.ownerUserId !== p.ownerUserId || row.computerId !== p.computerId || row.region !== p.region || row.zoneId !== p.zoneId
            || row.instanceId !== p.instanceId || row.volumeId !== p.volumeId || row.fsUuid !== p.fsUuid
            || row.generation !== p.generation || row.fenceToken !== p.fenceToken || row.leaseEpoch > p.leaseEpoch
            || row.lowerImageDigest !== p.lowerImageDigest) return null;
        const work = buildLifecycleWork(json(row.document) as LifecycleWork['intent']), i = work.intent;
        if (JSON.parse(work.input).document !== row.document || work.digest !== row.digest || i.operation !== 'replace' || i.poolHostId
            || i.computerId !== p.computerId || i.targetGeneration !== p.generation || i.fenceToken !== p.fenceToken
            || i.dataVolumeId !== p.volumeId || i.leaseEpoch !== row.leaseEpoch || i.instanceType !== p.instanceType
            || i.deployment.lowerImageDigest !== row.lowerImageDigest || !authority(i.deployment, d)
            || lifecycleExecutionArn(i.deployment, i.jobId) !== row.executionArn
            || parseEnrollmentUserData(i.userData!).fsUuid !== p.fsUuid) return null;
        return work;
    } catch { return null; }
}

/** The exact same connected, successful EC2 task result must name both instance AND ImageId.
 * One launch chain only: failed, duplicate, disconnected or ambiguous launch evidence is refused. */
export function dedicatedLaunchWitnessed(events: readonly HistoryEvent[], bounds: WitnessBounds,
    work: LifecycleWork, instanceId: string): boolean {
    if (!executionHistoryBound(events, bounds)) return false;
    const i = work.intent, d = i.deployment;
    const launch = events.filter(e => e.type === 'TaskScheduled' && /runinstances/i.test(e.taskScheduledEventDetails?.resource ?? ''));
    if (launch.length !== 1) return false;
    const scheduled = launch[0]!, task = scheduled.taskScheduledEventDetails!;
    const entered = events.find(e => e.id === scheduled.previousEventId);
    if (task.resource !== 'runInstances' || task.resourceType !== 'aws-sdk:ec2' || task.region !== d.region
        || entered?.type !== 'TaskStateEntered' || entered.stateEnteredEventDetails?.name !== 'runInstances') return false;
    const params = json(task.parameters) as Record<string, unknown> | undefined;
    const token = createHash('sha256').update('ezil-lifecycle-v1\ninstance\n' + work.digest).digest('hex');
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': String(i.targetGeneration), 'ezil:fence-token': i.fenceToken };
    const specs = params?.TagSpecifications as { ResourceType?: unknown; Tags?: { Key?: unknown; Value?: unknown }[] }[] | undefined;
    const instances = Array.isArray(specs) ? specs.filter(s => s.ResourceType === 'instance') : [];
    if (!params || !isDeepStrictEqual(params.LaunchTemplate, { LaunchTemplateId: d.launchTemplateId, Version: d.launchTemplateVersion })
        || params.ImageId !== d.amiId || params.InstanceType !== i.instanceType || params.MinCount !== 1 || params.MaxCount !== 1
        || params.ClientToken !== token || params.UserData !== i.userData || params.SubnetId !== d.subnetId
        || !isDeepStrictEqual(params.SecurityGroupIds, [d.securityGroupId]) || instances.length !== 1
        || !Array.isArray(instances[0]!.Tags) || instances[0]!.Tags!.length !== Object.keys(tags).length
        || Object.entries(tags).some(([key, value]) => instances[0]!.Tags!.filter(t => t.Key === key && t.Value === value).length !== 1)) return false;
    const starts = events.filter(e => e.type === 'TaskStarted' && e.previousEventId === scheduled.id);
    if (starts.length !== 1 || starts[0]!.taskStartedEventDetails?.resource !== 'runInstances'
        || starts[0]!.taskStartedEventDetails?.resourceType !== 'aws-sdk:ec2') return false;
    const outcomes = events.filter(e => e.previousEventId === starts[0]!.id && e.type?.startsWith('Task') && e.type !== 'TaskStateExited');
    if (outcomes.length !== 1 || outcomes[0]!.type !== 'TaskSucceeded') return false;
    const done = outcomes[0]!.taskSucceededEventDetails;
    if (done?.resource !== 'runInstances' || done.resourceType !== 'aws-sdk:ec2') return false;
    const output = json(done.output) as { Instances?: { InstanceId?: unknown; ImageId?: unknown; InstanceType?: unknown }[] } | undefined;
    if (!Array.isArray(output?.Instances) || output.Instances.length !== 1 || output.Instances[0]!.InstanceId !== instanceId
        || output.Instances[0]!.ImageId !== d.amiId || output.Instances[0]!.InstanceType !== i.instanceType) return false;
    // No orphan launch answer may supply an alternative image or instance outside that connected chain.
    return events.filter(e => (e.type === 'TaskStarted' && /runinstances/i.test(e.taskStartedEventDetails?.resource ?? ''))
        || (e.type === 'TaskSucceeded' && /runinstances/i.test(e.taskSucceededEventDetails?.resource ?? ''))).length === 2;
}

/** Canonical archived launch + its own immutable provider history, then exact successful retirement of the current allocation. */
export function proveReleasedDedicatedHost(p: ImagePlacement, d: LifecycleDeployment, row: DedicatedProvisionRecord,
    provision: Execution, provisionEvents: readonly HistoryEvent[], release: Execution, releaseEvents: readonly HistoryEvent[],
    requestedArn: string, now: Date): ReleasedDedicatedHostProof | null {
    try {
        const work = dedicatedProvisionWork(p, d, row);
        const job = JOB.exec(requestedArn)?.[1];
        if (!work || !job || !Number.isFinite(now.getTime()) || lifecycleExecutionArn(d, job) !== requestedArn
            || requestedArn === row.executionArn) return null;
        const i = work.intent;
        if (provision.executionArn !== row.executionArn || provision.status !== 'SUCCEEDED' || provision.redriveCount !== 0
            || provision.stateMachineAliasArn || provision.stateMachineVersionArn !== work.stateMachineArn
            || provision.input !== work.input || !provision.output
            || !(provision.startDate instanceof Date) || !(provision.stopDate instanceof Date)) return null;
        const pr = LifecycleReceiptSchema.safeParse(json(provision.output));
        if (!pr.success || pr.data.jobId !== i.jobId || pr.data.digest !== work.digest || pr.data.computerId !== p.computerId
            || pr.data.generation !== p.generation || pr.data.leaseEpoch !== row.leaseEpoch || pr.data.fenceToken !== p.fenceToken
            || pr.data.instanceId !== p.instanceId || pr.data.volumeId !== p.volumeId || pr.data.state !== 'running' || pr.data.instanceLost
            || !dedicatedLaunchWitnessed(provisionEvents, { input: provision.input, output: provision.output,
                startedAt: provision.startDate, stoppedAt: provision.stopDate, region: d.region }, work, p.instanceId!)) return null;
        if (release.executionArn !== requestedArn || release.status !== 'SUCCEEDED' || release.redriveCount !== 0
            || release.stateMachineAliasArn || !release.input || !release.output
            || !(release.startDate instanceof Date) || !(release.stopDate instanceof Date)
            || !(provision.stopDate.getTime() < release.startDate.getTime())
            || !(release.startDate.getTime() <= release.stopDate.getTime()) || !(release.stopDate.getTime() <= now.getTime())) return null;
        const retiring = canonicalReleaseWork(release.input);
        if (!retiring) return null;
        const r = retiring.intent;
        if (lifecycleExecutionArn(r.deployment, r.jobId) !== requestedArn || release.stateMachineVersionArn !== retiring.stateMachineArn
            || !authority(r.deployment, d) || r.computerId !== p.computerId || r.targetGeneration !== p.generation
            || r.leaseEpoch !== p.leaseEpoch || r.fenceToken !== p.fenceToken || r.providerInstanceId !== p.instanceId
            || r.dataVolumeId !== p.volumeId) return null;
        const rr = LifecycleReceiptSchema.safeParse(json(release.output));
        if (!rr.success || rr.data.jobId !== r.jobId || rr.data.digest !== retiring.digest || rr.data.computerId !== p.computerId
            || rr.data.generation !== p.generation || rr.data.leaseEpoch !== p.leaseEpoch || rr.data.fenceToken !== p.fenceToken
            || rr.data.instanceId !== p.instanceId || rr.data.volumeId !== p.volumeId || rr.data.state !== 'retired' || rr.data.instanceLost
            || !terminationWitnessed(releaseEvents, { input: release.input, output: release.output, startedAt: release.startDate,
                stoppedAt: release.stopDate, region: d.region }, p.instanceId!)) return null;
        return { imageJobId: row.imageJobId, provisionDigest: row.digest, provisionExecutionArn: row.executionArn,
            releaseExecutionArn: requestedArn, provisioned: i.deployment };
    } catch { return null; }
}

/** Reads only exact namespace-bound launch/retirement hints; absence means not proven, other read errors remain uncertain. */
export async function readReleasedDedicatedHostProof(executions: LifecycleExecutionReader, p: ImagePlacement, d: LifecycleDeployment,
    row: DedicatedProvisionRecord, requestedArn: string | undefined, now: Date): Promise<ReleasedDedicatedHostProof | null> {
    const job = requestedArn ? JOB.exec(requestedArn)?.[1] : undefined;
    if (!executions.history || !requestedArn || !job || lifecycleExecutionArn(d, job) !== requestedArn
        || !dedicatedProvisionWork(p, d, row) || row.executionArn === requestedArn || !p.region) return null;
    try {
        const provision = await executions.describe(p.region, row.executionArn), release = await executions.describe(p.region, requestedArn);
        return proveReleasedDedicatedHost(p, d, row, provision, await executions.history(p.region, row.executionArn),
            release, await executions.history(p.region, requestedArn), requestedArn, now);
    } catch (error) { if (isExecutionAbsent(error)) return null; throw error; }
}
