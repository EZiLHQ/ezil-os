/** Deterministic lifecycle intents for the fixture contract (aws-intent.fixtures.json). */
import type { LifecycleDeployment, LifecycleIntent } from './aws-intent';

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
            userData: 'ZXppbC1ub25jZQ==',
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
        userData: operation === 'provision' ? 'ZXppbC1ub25jZQ==' : null,
    };
}
