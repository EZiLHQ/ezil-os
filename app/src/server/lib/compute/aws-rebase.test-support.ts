import { randomUUID } from 'node:crypto';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import type { PlacementDb } from './placement';
import { vi } from 'vitest';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { buildLifecycleWork, LifecycleDeploymentSchema, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { lifecycleExecutionArn } from './aws-receipts';
import { releaseHistory } from './aws-historical-source.test-support';
import { fixtureSharedLowerSuccessor, LOWER_105 } from './aws-rebase-release-registry.test-support';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { createImageJobStore } from './aws-rebase-store';
import { handleImageRebase, type ImageRebaseDeps, type ImageRebaseRequest } from './aws-rebase-orchestrator';
import { AwsClientError } from './aws-errors';
import type { Execution, RebaseSnapshotView } from './aws-rebase-evidence';
import type { Ec2VolumeView } from './aws-clients';
import type { Ec2EnrollmentView } from './aws-enroll';

export const rebaseEnv = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '20', EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '20', EZIL_AWS_ENROLL_URL: 'https://os.example.com/api/compute/aws/enroll',
    EZIL_AWS_BROWSER_ZONE: 'example.com' };
export function rebaseSetup(externalDb?: PlacementDb) {
    const prep = fixtureRebasePreparation(), source = prep.intent, owner = '33333333-3333-4333-8333-333333333333';
    let clock = new Date('2026-10-22T12:00:00.000Z');
    const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: source.computerId, owner_user_id: owner,
        state: 'STOPPED', generation: source.sourceGeneration, lease_epoch: source.sourceLeaseEpoch, fence_token: source.sourceFenceToken,
        region: source.deployment.region, zone_id: source.deployment.zoneId, instance_id: source.sourceInstanceId, instance_type: 'm6i.large',
        volume_id: source.sourceVolumeId, fs_uuid: source.fsUuid, lower_image_digest: source.fromDigest,
        lower_digest_observed_at: new Date(source.createdAt), image_upgrade_job_id: null })],
        computers: [{ id: source.computerId, user_id: owner }] }, { clock: () => clock });
    const env = { ...rebaseEnv, EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ [source.deployment.region]: { ...source.deployment,
        releases: [fixtureRebaseRelease(source.sourceDeployment), fixtureRebaseRelease(source.deployment)] } }) };
    const store = createImageJobStore(externalDb ?? fake.db, env);
    const executions = new Map<string, Execution>();
    const ids = ['11111111-1111-4111-8111-111111111111', '44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555', '66666666-6666-4666-8666-666666666666',
        '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888', '99999999-9999-4999-8999-999999999999'];
    const started: { stateMachineArn: string; name: string; input: string }[] = [];
    const provider = {
        restoredVolume: null as Ec2VolumeView | null, snapshot: null as RebaseSnapshotView | null, host: null as Ec2EnrollmentView | null,
        volume: { volumeId: source.sourceVolumeId, state: 'available', sizeGiB: source.volumeGiB, tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.deployment.namespace,
            'ezil:computer-id': source.computerId, 'ezil:generation': String(source.sourceGeneration), 'ezil:fence-token': source.sourceFenceToken, 'ezil:backup': source.deployment.namespace }, attachments: [] as { instanceId: string; state: string }[], encrypted: true, kmsKeyId: source.deployment.dataKeyArn },
    };
    const deps: ImageRebaseDeps = { store, env, now: () => clock, newId: () => ids.shift() ?? randomUUID(),
        starter: { start: vi.fn(async (_region, work) => {
            started.push(work); const executionArn = work.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${work.name}`);
            executions.set(executionArn, { executionArn, input: work.input, stateMachineVersionArn: work.stateMachineArn, redriveCount: 0, status: 'RUNNING' });
        }) },
        executions: { describe: vi.fn(async (_region, arn) => { const e = executions.get(arn); if (!e) throw new AwsClientError('aws_config', false, 'ExecutionDoesNotExist'); return e; }) },
        describer: { describeSnapshot: vi.fn(async () => provider.snapshot), describeVolume: vi.fn(async (_region, id) => id === provider.restoredVolume?.volumeId ? provider.restoredVolume : provider.volume), describeForEnrollment: vi.fn(async () => provider.host) },
        desktopHealthy: vi.fn(async () => true), meter: { stopped: vi.fn(async () => {}), ready: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}) } };
    const run = (operation: ImageRebaseRequest['operation'], jobId: string | null = null) => handleImageRebase(deps, { schemaVersion: 1, operation, computerId: source.computerId, jobId });
    const current = async () => (await store.inspect(source.computerId)).job!;
    const completePreparation = async () => {
        const j = await current(); const start = Date.parse(j.createdAt); clock = new Date(start + 60000);
        const r = { schemaVersion: 1, jobId: j.jobId, digest: j.preparationDigest, computerId: j.computerId, state: 'snapshot_ready',
            sourceInstanceId: j.sourceInstanceId, sourceVolumeId: j.sourceVolumeId, fsUuid: j.fsUuid, sourceGeneration: j.sourceGeneration,
            sourceLeaseEpoch: j.sourceLeaseEpoch, sourceFenceToken: j.sourceFenceToken, fromDigest: j.fromDigest, toDigest: j.toDigest,
            snapshotId: j.parentJobId ? 'snap-33333333333333333' : 'snap-11111111111111111', snapshotOwnerId: source.deployment.accountId, snapshotVolumeGiB: source.volumeGiB,
            snapshotKmsKeyArn: source.deployment.dataKeyArn, fencedAt: new Date(start + 1000).toISOString(), snapshotStartedAt: new Date(start + 2000).toISOString(),
            snapshotCompletedAt: new Date(start + 59000).toISOString(), verifiedAt: clock.toISOString() };
        Object.assign(executions.get(j.preparationExecutionArn!)!, { status: 'SUCCEEDED', output: JSON.stringify(r) });
        provider.snapshot = { snapshotId: r.snapshotId, ownerId: r.snapshotOwnerId, volumeId: r.sourceVolumeId, volumeGiB: r.snapshotVolumeGiB,
            state: 'completed', encrypted: true, kmsKeyId: r.snapshotKmsKeyArn, startedAt: new Date(r.snapshotStartedAt), tags: {
                'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.deployment.namespace, 'ezil:computer-id': j.computerId,
                'ezil:source-volume-id': j.sourceVolumeId, 'ezil:source-generation': String(j.sourceGeneration), 'ezil:source-fence-token': j.sourceFenceToken,
                'ezil:preparation-job-id': j.jobId, 'ezil:purpose': 'pre-rebase' } };
    };
    const completeLaunch = async () => {
        const j = await current(), instanceId = j.parentJobId ? 'i-44444444444444444' : 'i-22222222222222222';
        const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.deployment.namespace, 'ezil:computer-id': j.computerId,
            'ezil:generation': String(j.targetGeneration), 'ezil:fence-token': j.targetFenceToken!, 'ezil:backup': source.deployment.namespace };
        provider.host = { instanceId, state: 'running', instanceType: 'm6i.large', publicIp: '203.0.113.1', availabilityZone: 'ap-south-1a',
            availabilityZoneId: j.zoneId, tags, volumes: [{ volumeId: j.sourceVolumeId, deleteOnTermination: false, tags }] };
        Object.assign(provider.restoredVolume?.volumeId === j.sourceVolumeId ? provider.restoredVolume : provider.volume, { state: 'in-use', tags, attachments: [{ instanceId, state: 'attached' }] });
        Object.assign(executions.get(j.launchExecutionArn!)!, { status: 'SUCCEEDED', output: JSON.stringify({ schemaVersion: 1, jobId: j.launchJobId,
            digest: j.launchDigest, computerId: j.computerId, generation: j.targetGeneration, leaseEpoch: j.targetLeaseEpoch,
            fenceToken: j.targetFenceToken, instanceId, volumeId: j.sourceVolumeId, state: 'running' }) });
    };
    const completeRecovery = async () => {
        const j = await current(); clock = new Date(clock.getTime() + 5000);
        const volumeId = 'vol-22222222222222222';
        provider.volume.state = 'available'; provider.volume.attachments = [];
        provider.restoredVolume = { volumeId, state: 'available', attachments: [], snapshotId: j.snapshotId!, zoneId: j.zoneId,
            sizeGiB: source.volumeGiB, encrypted: true, kmsKeyId: source.deployment.dataKeyArn, tags: {
                'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.deployment.namespace, 'ezil:computer-id': j.computerId,
                'ezil:generation': String(j.sourceGeneration), 'ezil:fence-token': j.sourceFenceToken, 'ezil:backup': source.deployment.namespace,
                'ezil:restored-from-snapshot': j.snapshotId!, 'ezil:original-volume-id': j.sourceVolumeId, 'ezil:recovery-job-id': j.recoveryJobId! } };
        Object.assign(executions.get(j.recoveryExecutionArn!)!, { status: 'SUCCEEDED', output: JSON.stringify({ schemaVersion: 1,
            jobId: j.recoveryJobId, digest: j.recoveryDigest, imageJobId: j.jobId, state: 'restore_volume_ready', sourceExecutionArn: j.launchExecutionArn,
            snapshotId: j.snapshotId, originalVolumeId: j.sourceVolumeId, volumeId, fsUuid: j.fsUuid, sourceGeneration: j.sourceGeneration,
            sourceLeaseEpoch: j.sourceLeaseEpoch, sourceFenceToken: j.sourceFenceToken, fromDigest: j.fromDigest, verifiedAt: clock.toISOString() }) });
    };
    const completeRebind = async () => {
        const j = await current(), instanceId = 'i-33333333333333333';
        const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.deployment.namespace, 'ezil:computer-id': j.computerId,
            'ezil:generation': String(j.rebindGeneration), 'ezil:fence-token': j.rebindFenceToken!, 'ezil:backup': source.deployment.namespace };
        provider.host = { instanceId, state: 'running', instanceType: 'm6i.large', publicIp: null, availabilityZone: 'ap-south-1a',
            availabilityZoneId: j.zoneId, tags, volumes: [{ volumeId: j.restoredVolumeId!, deleteOnTermination: false, tags }] };
        Object.assign(provider.restoredVolume!, { state: 'in-use', tags, attachments: [{ instanceId, state: 'attached' }] });
        Object.assign(executions.get(j.rebindExecutionArn!)!, { status: 'SUCCEEDED', output: JSON.stringify({ schemaVersion: 1, jobId: j.rebindJobId,
            digest: j.rebindDigest, computerId: j.computerId, generation: j.rebindGeneration, leaseEpoch: j.rebindLeaseEpoch,
            fenceToken: j.rebindFenceToken, instanceId, volumeId: j.restoredVolumeId, state: 'running' }) });
    };
    return { deps, fake, store, env, started, executions, provider, run, current, completePreparation, completeLaunch, completeRecovery, completeRebind,
        advance: (ms: number) => { clock = new Date(clock.getTime() + ms); }, source, owner };
}

export const RELEASED_POOL_HOST = 'a0a0a0a0-a0a0-4a0a-8a0a-a0a0a0a0a0a0';
const PROVISION_JOB = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1', RELEASE_JOB = 'd3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3';
type ReleaseIntent = LifecycleWork['intent'];
/** DESIGN R: the placement's warm-pool host was released and aged out of EC2. Synthetic retired claim row, SUCCEEDED provision and
 * release executions with a Code-48 termination history. `shared`: 34ac-like lower whose 1.0.5/1.0.6 records share it. */
export function releasedPoolSetup(options: { shared?: boolean; db?: PlacementDb } = {}) {
    const s = rebaseSetup(options.db), src = s.source, f = fixtureSharedLowerSuccessor();
    if (options.shared) { s.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = JSON.stringify({ [f.entry.region]: f.entry }); s.fake.placements[0]!.lower_image_digest = LOWER_105; }
    const provisioned = options.shared ? f.deployment105 : LifecycleDeploymentSchema.parse(src.sourceDeployment);
    const provisionStart = new Date('2026-10-21T09:00:00.000Z'), releaseStart = new Date('2026-10-22T10:00:00.000Z');
    const row: Record<string, unknown> = { id: RELEASED_POOL_HOST, generation: 1, region: src.deployment.region, zone_id: src.deployment.zoneId,
        instance_type: 'm6i.large', instance_id: src.sourceInstanceId, state: 'retired', leased_computer_id: src.computerId,
        claim_generation: src.sourceGeneration, claim_lease_epoch: src.sourceLeaseEpoch, claim_fence: src.sourceFenceToken,
        claim_volume_serial: src.sourceVolumeId.replace('-', ''), dispatch_status: 'settled' };
    s.fake.poolHosts.push(row);
    const histories = new Map<string, HistoryEvent[]>();
    const absent = () => new AwsClientError('aws_config', false, 'ExecutionDoesNotExist');
    s.deps.executions.history = vi.fn(async (_region: string, arn: string) => { const h = histories.get(arn); if (!h) throw absent(); return structuredClone(h); });
    let provision!: LifecycleWork, release!: LifecycleWork;
    /** Re-pins the provision tuple: row input/digest/job and the SUCCEEDED execution with its strict pool receipt. */
    const setProvision = (deployment: LifecycleDeployment) => {
        provision = buildLifecycleWork({ schemaVersion: 1, jobId: PROVISION_JOB, computerId: RELEASED_POOL_HOST, revision: 1, operation: 'pool-provision',
            targetGeneration: 1, fenceToken: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', poolHostId: RELEASED_POOL_HOST, poolGeneration: 1,
            providerInstanceId: null, dataVolumeId: null, previousGeneration: null, previousInstanceId: null, previousFenceToken: null,
            deployment, instanceType: 'm6i.large', dataVolumeGiB: null, leaseEpoch: 1, userData: null });
        Object.assign(row, { lifecycle_job_id: PROVISION_JOB, lifecycle_digest: provision.digest, lifecycle_input: provision.input });
        const arn = lifecycleExecutionArn(deployment, PROVISION_JOB);
        s.executions.set(arn, { executionArn: arn, input: provision.input, stateMachineVersionArn: provision.stateMachineArn, redriveCount: 0,
            status: 'SUCCEEDED', startDate: provisionStart, stopDate: new Date(provisionStart.getTime() + 240000), output: JSON.stringify({ schemaVersion: 1,
                jobId: PROVISION_JOB, digest: provision.digest, computerId: RELEASED_POOL_HOST, generation: 1, leaseEpoch: 1, fenceToken: provision.intent.fenceToken,
                instanceId: src.sourceInstanceId, volumeId: null, state: 'running', poolHostId: RELEASED_POOL_HOST, poolGeneration: 1 }) });
        return arn;
    };
    /** Re-pins the release: its exact input, `retired` receipt and the matching Code-48 history (patches apply to all three). */
    const setRelease = (intent: Partial<ReleaseIntent> = {}, receipt: Record<string, unknown> = {}, current?: { Code: number; Name: string }) => {
        release = buildLifecycleWork({ schemaVersion: 1, jobId: RELEASE_JOB, computerId: src.computerId, revision: 1, operation: 'release',
            targetGeneration: src.sourceGeneration, fenceToken: src.sourceFenceToken, providerInstanceId: src.sourceInstanceId, dataVolumeId: src.sourceVolumeId,
            previousGeneration: null, previousInstanceId: null, previousFenceToken: null, deployment: provisioned, instanceType: 'm6i.large',
            dataVolumeGiB: null, leaseEpoch: src.sourceLeaseEpoch, userData: null, ...intent } as ReleaseIntent);
        const i = release.intent, arn = lifecycleExecutionArn(i.deployment, i.jobId);
        const output = JSON.stringify({ schemaVersion: 1, jobId: i.jobId, digest: release.digest, computerId: i.computerId, generation: i.targetGeneration,
            leaseEpoch: i.leaseEpoch, fenceToken: i.fenceToken, instanceId: i.providerInstanceId, volumeId: i.dataVolumeId, state: 'retired', ...receipt });
        s.executions.set(arn, { executionArn: arn, input: release.input, stateMachineVersionArn: release.stateMachineArn, redriveCount: 0,
            status: 'SUCCEEDED', startDate: releaseStart, stopDate: new Date(releaseStart.getTime() + 60000), output });
        histories.set(arn, releaseHistory(release.input, output, i.providerInstanceId!, releaseStart, current));
        return arn;
    };
    const provisionArn = setProvision(provisioned), releaseArn = setRelease();
    /** `hint` null: no release hint at all. */
    const request = (operation: ImageRebaseRequest['operation'], hint: string | null = releaseArn) => handleImageRebase(s.deps,
        { schemaVersion: 1, operation, computerId: src.computerId, jobId: null, ...(hint === null ? {} : { sourceRetirementExecutionArn: hint }) });
    /** EC2 still listing the released host: terminated, with the claim identity and no canonical or pool tag. */
    const terminatedHost = (): Ec2EnrollmentView => ({ instanceId: src.sourceInstanceId, imageId: provisioned.amiId, state: 'terminated',
        availabilityZone: 'ap-south-1a', availabilityZoneId: src.deployment.zoneId, publicIp: null, volumes: [], tags: {
            'ezil:managed-by': 'app-computer-platform', 'ezil:stage': provisioned.namespace, 'ezil:namespace': provisioned.namespace,
            'ezil:pool-host': RELEASED_POOL_HOST, 'ezil:computer': src.computerId, 'ezil:generation': String(src.sourceGeneration),
            'ezil:fence': src.sourceFenceToken, 'aws:ec2launchtemplate:id': provisioned.launchTemplateId } });
    return { ...s, f, provisioned, row, histories, provisionArn, releaseArn, setProvision, setRelease, request, terminatedHost,
        provision: () => provision, release: () => release };
}
