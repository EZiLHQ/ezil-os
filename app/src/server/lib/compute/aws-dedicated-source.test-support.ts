import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { rebaseSetup } from './aws-rebase.test-support';
import { buildLifecycleWork, type LifecycleDeployment } from './aws-intent';
import { handleAwsEnrollment } from './aws-enroll';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { lifecycleExecutionArn } from './aws-receipts';
import { releaseHistory } from './aws-historical-source.test-support';
import { fixtureRebaseRelease } from './aws-intent.test-support';
import { handleImageRebase } from './aws-rebase-orchestrator';
const RELEASE_JOB = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
/** Build an archived successful image job through the real enrollment/store path, then release its dedicated host. */
export async function dedicatedSetup() {
    const s = rebaseSetup();
    await s.run('prepare'); await s.completePreparation(); await s.run('launch'); await s.completeLaunch();
    let j = await s.current(); const lease = parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData);
    const tunnels = { createTunnel: vi.fn(async () => ({ ok: true as const, tunnelToken: 'test-token' })), deleteTunnel: vi.fn() };
    const enrolled = await handleAwsEnrollment({ db: s.fake.db, env: s.env, now: s.deps.now, describer: s.deps.describer,
        tunnels, controlKeySecret: 'test-only-secret' }, { computerId: j.computerId, generation: j.targetGeneration,
        leaseEpoch: j.targetLeaseEpoch, nonce: lease.nonce, lowerImageDigest: j.toDigest, signature: 'x'.repeat(16),
        identityDocument: JSON.stringify({ accountId: s.source.deployment.accountId, region: j.region,
            instanceId: s.provider.host!.instanceId, instanceType: 'm6i.large', availabilityZone: 'ap-south-1a' }) });
    if (enrolled.status !== 200) throw new Error('fixture enrollment failed');
    await s.run('verify'); j = (await s.store.read(j.jobId))!;
    if (j.phase !== 'succeeded') throw new Error('fixture archive failed');
    const original = buildLifecycleWork(JSON.parse(j.launchDocument!));
    const source = original.intent.deployment;
    const target: LifecycleDeployment = { ...source, amiId: 'ami-33333333333333333', lowerImageDigest: 'sha256:' + 'c'.repeat(64),
        previousLowerImageDigest: source.lowerImageDigest!, launchTemplateVersion: '3',
        stateMachineVersionArn: source.stateMachineVersionArn.replace(/:[0-9]+$/, ':3') };
    const sourceRelease = fixtureRebaseRelease(source), targetRelease = fixtureRebaseRelease(target);
    // Ambiguous same-lower/same-AMI registry record: only original canonical launch identifies the workflow tuple.
    const twin = { ...sourceRelease, stateMachineVersionArn: source.stateMachineVersionArn.replace(/:[0-9]+$/, ':7') };
    s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [target.region]: { ...target, releases: [sourceRelease, twin, targetRelease] } });
    const placed = s.fake.placements[0]!;
    Object.assign(placed, { state: 'STOPPED', lease_epoch: Number(placed.lease_epoch) + 1 });
    s.provider.host = null; s.provider.volume.state = 'available'; s.provider.volume.attachments = [];
    s.advance(120_000);
    const p = (await s.store.inspect(j.computerId)).placement!;
    const release = buildLifecycleWork({ schemaVersion: 1, jobId: RELEASE_JOB, computerId: j.computerId, revision: 1, operation: 'release',
        targetGeneration: p.generation, leaseEpoch: p.leaseEpoch, fenceToken: p.fenceToken!, providerInstanceId: p.instanceId,
        dataVolumeId: p.volumeId, previousGeneration: null, previousInstanceId: null, previousFenceToken: null,
        deployment: target, instanceType: 'm6i.large', dataVolumeGiB: null, userData: null });
    const provisionArn = j.launchExecutionArn!, releaseArn = lifecycleExecutionArn(target, RELEASE_JOB);
    const receipt = (w: typeof release, state: 'running' | 'retired') => JSON.stringify({ schemaVersion: 1,
        jobId: w.intent.jobId, digest: w.digest, computerId: j.computerId, generation: w.intent.targetGeneration,
        leaseEpoch: w.intent.leaseEpoch, fenceToken: w.intent.fenceToken, instanceId: p.instanceId, volumeId: p.volumeId, state });
    const provisionStart = new Date('2026-10-22T12:01:00.000Z'), provisionStop = new Date('2026-10-22T12:01:01.000Z');
    const releaseStart = new Date('2026-10-22T12:02:00.000Z'), releaseStop = new Date('2026-10-22T12:02:01.000Z');
    const provision = s.executions.get(provisionArn)!;
    Object.assign(provision, { startDate: provisionStart, stopDate: provisionStop, output: receipt(original, 'running') });
    const retired = { executionArn: releaseArn, status: 'SUCCEEDED', stateMachineVersionArn: release.stateMachineArn, redriveCount: 0,
        startDate: releaseStart, stopDate: releaseStop, input: release.input, output: receipt(release, 'retired') };
    s.executions.set(releaseArn, retired);
    const i = original.intent, d = i.deployment;
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
        'ezil:generation': String(i.targetGeneration), 'ezil:fence-token': i.fenceToken };
    const parameters = { ImageId: d.amiId, InstanceType: i.instanceType, LaunchTemplate: { LaunchTemplateId: d.launchTemplateId, Version: d.launchTemplateVersion },
        MinCount: 1, MaxCount: 1, UserData: i.userData, ClientToken: createHash('sha256').update('ezil-lifecycle-v1\ninstance\n' + original.digest).digest('hex'),
        SubnetId: d.subnetId, SecurityGroupIds: [d.securityGroupId], TagSpecifications: [{ ResourceType: 'instance',
            Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }] };
    const launchEvents: Partial<HistoryEvent>[] = [
        { type: 'ExecutionStarted', executionStartedEventDetails: { input: provision.input! } },
        { type: 'TaskStateEntered', stateEnteredEventDetails: { name: 'runInstances' } },
        { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'runInstances', region: d.region, parameters: JSON.stringify(parameters) } },
        { type: 'TaskStarted', taskStartedEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'runInstances' } },
        { type: 'TaskSucceeded', taskSucceededEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'runInstances',
            output: JSON.stringify({ Instances: [{ InstanceId: p.instanceId, ImageId: d.amiId, InstanceType: i.instanceType }] }) } },
        { type: 'TaskStateExited', stateExitedEventDetails: { name: 'runInstances' } },
        { type: 'ExecutionSucceeded', executionSucceededEventDetails: { output: provision.output! } },
    ];
    const history = launchEvents.map((e, n) => ({ ...e, id: n + 1, previousEventId: n, timestamp: new Date(provisionStart.getTime() + n * 10) })) as HistoryEvent[];
    const histories = new Map([[provisionArn, history], [releaseArn, releaseHistory(retired.input, retired.output, p.instanceId!, releaseStart)]]);
    s.deps.executions.history = vi.fn(async (_region, arn) => structuredClone(histories.get(arn)!));
    const row = (await s.store.releasedDedicatedHost(j.computerId)).row!;
    if (!row) throw new Error('fixture archive not found');
    s.started.splice(0); vi.mocked(s.deps.executions.describe).mockClear();
    const request = (operation: 'plan' | 'prepare', hint: string | null = releaseArn) => handleImageRebase(s.deps, {
        schemaVersion: 1, operation, computerId: j.computerId, jobId: null, ...(hint ? { sourceRetirementExecutionArn: hint } : {}) });
    return { ...s, p, row, j, source, target, sourceRelease, original, release, provision, retired, provisionArn, releaseArn, histories, request };
}
