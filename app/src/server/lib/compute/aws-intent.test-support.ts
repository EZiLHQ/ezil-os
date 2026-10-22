import { buildEnrollmentUserData } from './aws-enroll';
import { buildRebasePreparation } from './aws-rebase-preparation';
/** Deterministic lifecycle intents for the fixture contract (aws-intent.fixtures.json). */
import { LifecycleDeploymentSchema, type SourceLifecycleDeployment, type LifecycleDeployment, type LifecycleIntent } from './aws-intent';

export const FIXTURE_ACCOUNT = '123456789012'; // AWS documentation placeholder account
export function fixtureDeployment(region: 'ap-south-1' | 'us-east-1', instanceTypes: string[] = ['m6i.large', 'c6i.xlarge']): LifecycleDeployment {
    const zoneId = region === 'ap-south-1' ? 'aps1-az1' : 'use1-az4';
    return {
        accountId: FIXTURE_ACCOUNT,
        region,
        zoneId,
        subnetId: 'subnet-11111111111111111',
        securityGroupId: 'sg-11111111111111111',
        launchTemplateId: 'lt-11111111111111111',
        launchTemplateVersion: '1',
        amiId: 'ami-11111111111111111',
        namespace: 'pilot',
        instanceTypes,
        storage: { rootGiB: 20, dataMinGiB: 20, dataMaxGiB: 100 },
        dataKeyArn: `arn:aws:kms:${region}:${FIXTURE_ACCOUNT}:key/11111111-1111-4111-8111-111111111111`,
        stateMachineVersionArn: `arn:aws:states:${region}:${FIXTURE_ACCOUNT}:stateMachine:ezil-pilot-lifecycle:1`,
    };
}

const COMPUTER = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
export function fixtureIntent(
    operation: 'provision' | 'start' | 'stop' | 'replace',
    region: 'ap-south-1' | 'us-east-1' = 'ap-south-1',
    instanceType = 'm6i.large',
    deploymentTypes?: string[],
): LifecycleIntent {
    if (operation === 'replace') {
        // Wake by replace: a new instance (generation 2) on the retained volume; the
        // stopped generation-1 instance and its fence are handed on as previous*.
        return {
            schemaVersion: 1,
            jobId: '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c',
            computerId: COMPUTER,
            revision: 1,
            operation,
            targetGeneration: 2,
            fenceToken: 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd',
            providerInstanceId: null,
            dataVolumeId: 'vol-11111111111111111',
            previousGeneration: 1,
            previousInstanceId: 'i-11111111111111111',
            previousFenceToken: 'fefefefe-fefe-4efe-8efe-fefefefefefe',
            deployment: fixtureDeployment(region, deploymentTypes),
            instanceType,
            dataVolumeGiB: null,
            leaseEpoch: 4,
            userData: fixtureUserData(false, 2, 4),
        };
    }
    return {
        schemaVersion: 1,
        jobId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
        computerId: COMPUTER,
        revision: 1,
        operation,
        targetGeneration: 1,
        fenceToken: 'fefefefe-fefe-4efe-8efe-fefefefefefe',
        providerInstanceId: operation === 'provision' ? null : 'i-11111111111111111',
        dataVolumeId: operation === 'provision' ? null : 'vol-11111111111111111',
        previousGeneration: null,
        previousInstanceId: null,
        previousFenceToken: null,
        deployment: fixtureDeployment(region, deploymentTypes),
        instanceType,
        dataVolumeGiB: operation === 'provision' ? 20 : null,
        leaseEpoch: operation === 'provision' ? 1 : 3,
        userData: operation === 'provision' ? fixtureUserData(true, 1, 1) : null,
    };
}

export function fixtureUserData(provision: boolean, generation: number, leaseEpoch: number): string {
    return buildEnrollmentUserData({ computerId: COMPUTER, volumeId: provision ? null : 'vol-11111111111111111',
        fsUuid: '22222222-2222-4222-8222-222222222222', generation, leaseEpoch, nonce: 'n'.repeat(43), provision,
        enrollUrl: 'https://os.example.com/api/compute/aws/enroll' });
}
export function fixtureRebaseDeployments() {
    const deployment: LifecycleDeployment = { ...fixtureDeployment('ap-south-1'),
        storage: { ...fixtureDeployment('ap-south-1').storage, rootDeviceName: '/dev/sda1' },
        lowerImageDigest: 'sha256:' + 'b'.repeat(64), previousLowerImageDigest: 'sha256:' + 'a'.repeat(64),
        preparationStateMachineVersionArn: `arn:aws:states:ap-south-1:${FIXTURE_ACCOUNT}:stateMachine:ezil-pilot-rebase-preparation:1`,
        recoveryStateMachineVersionArn: `arn:aws:states:ap-south-1:${FIXTURE_ACCOUNT}:stateMachine:ezil-pilot-recovery:1` };
    const sourceDeployment: LifecycleDeployment = { ...deployment, amiId: 'ami-22222222222222222',
        lowerImageDigest: deployment.previousLowerImageDigest!, previousLowerImageDigest: null,
        stateMachineVersionArn: deployment.stateMachineVersionArn.replace(/:1$/, ':2') };
    return { deployment, sourceDeployment };
}
export function fixtureRebasePreparation() {
    const i = fixtureIntent('replace');
    return buildRebasePreparation({ schemaVersion: 1, jobId: '11111111-1111-4111-8111-111111111111',
        computerId: i.computerId, sourceInstanceId: i.previousInstanceId!, sourceVolumeId: i.dataVolumeId!,
        fsUuid: '22222222-2222-4222-8222-222222222222', sourceGeneration: i.previousGeneration!, sourceLeaseEpoch: 3,
        sourceFenceToken: i.previousFenceToken!, fromDigest: 'sha256:' + 'a'.repeat(64), toDigest: 'sha256:' + 'b'.repeat(64),
        volumeGiB: 20, ...fixtureRebaseDeployments(), createdAt: '2026-10-22T11:00:00.000Z' });
}
export function fixtureRebaseIntent(restore = false): LifecycleIntent {
    const i = fixtureIntent('replace'), p = fixtureRebasePreparation();
    const volumeId = restore ? 'vol-22222222222222222' : i.dataVolumeId!;
    const generation = restore ? 3 : i.targetGeneration, leaseEpoch = restore ? 5 : i.leaseEpoch;
    const permit = { v: 1 as const, preparationJobId: p.intent.jobId, launchJobId: i.jobId, computerId: i.computerId,
        fsUuid: p.intent.fsUuid, generation, leaseEpoch, fenceToken: i.fenceToken,
        issuedAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-10-22T12:10:00.000Z' };
    return { ...i, targetGeneration: generation, leaseEpoch, dataVolumeId: volumeId,
        deployment: restore ? LifecycleDeploymentSchema.parse(p.intent.sourceDeployment) : p.intent.deployment,
        userData: buildEnrollmentUserData({ computerId: i.computerId, volumeId, fsUuid: p.intent.fsUuid,
            generation, leaseEpoch, nonce: 'n'.repeat(43), provision: false, enrollUrl: 'https://os.example.com/api/compute/aws/enroll',
            ...(restore ? { ebsRestore: { ...permit, recoveryJobId: '33333333-3333-4333-8333-333333333333',
                snapshotId: 'snap-11111111111111111', originalVolumeId: p.intent.sourceVolumeId, volumeId,
                fromDigest: p.intent.fromDigest, sourceGeneration: p.intent.sourceGeneration, sourceLeaseEpoch: p.intent.sourceLeaseEpoch,
                maintenance: true as const } } : { rebase: { snapshotId: 'snap-11111111111111111', volumeId,
                fromDigest: p.intent.fromDigest, toDigest: p.intent.toDigest }, rebasePermit: permit }) }),
        rebasePreparation: { v: 1, preparationJobId: p.intent.jobId, executionArn: p.executionArn, digest: p.digest } };
}

/** Local release evidence double; registry manifest hashes intentionally differ from baked lower IDs. */
export function fixtureRebaseRelease(d: SourceLifecycleDeployment) {
    return { schemaVersion: 1 as const, accountId: d.accountId, region: d.region, namespace: d.namespace, amiId: d.amiId,
        recipeVersion: '1.2.3', lowerImageDigest: d.lowerImageDigest!,
        lowerImageRef: `${FIXTURE_ACCOUNT}.dkr.ecr.ap-south-1.amazonaws.com/desktop@sha256:${'c'.repeat(64)}`,
        previousLowerImageDigest: d.previousLowerImageDigest!, previousLowerImageRef: d.previousLowerImageDigest === null ? null
            : `${FIXTURE_ACCOUNT}.dkr.ecr.ap-south-1.amazonaws.com/desktop@sha256:${'d'.repeat(64)}`,
        agentCommit: 'e'.repeat(40), stateMachineVersionArn: d.stateMachineVersionArn,
        preparationStateMachineVersionArn: d.preparationStateMachineVersionArn!, recoveryStateMachineVersionArn: d.recoveryStateMachineVersionArn!,
        launchTemplateId: d.launchTemplateId, launchTemplateVersion: d.launchTemplateVersion, createdAt: '2026-10-22T10:00:00.000Z' };
}
