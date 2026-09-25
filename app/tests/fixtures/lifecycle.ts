import { randomUUID, createHash } from 'node:crypto';
import { type LifecycleDeployment, type LifecycleIntent, type LifecycleReceipt, type LifecycleWork } from '../../src/server/app-platform/lifecycle-protocol';
export const lifecycleDeployment: LifecycleDeployment = { accountId: '123456789012', region: 'us-east-1', availabilityZone: 'us-east-1a',
    subnetId: 'subnet-11111111111111111', securityGroupId: 'sg-11111111111111111', launchTemplateId: 'lt-11111111111111111',
    launchTemplateVersion: '1', amiId: 'ami-11111111111111111', namespace: 'pilot',
    instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/ezil/host',
    dataKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111',
    stateMachineVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle:1' };
export function lifecycleFixture(operation: LifecycleIntent['operation'] = 'start') {
    const intent: LifecycleIntent = { schemaVersion: 1, jobId: randomUUID(), computerId: randomUUID(), revision: 1,
        operation, targetGeneration: operation === 'replace' ? 2 : 1, fenceToken: randomUUID(),
        providerInstanceId: ['provision','replace'].includes(operation) ? null : 'i-11111111111111111',
        dataVolumeId: operation === 'provision' ? null : 'vol-11111111111111111',
        previousGeneration: operation === 'replace' ? 1 : null,
        previousInstanceId: operation === 'replace' ? 'i-22222222222222222' : null,
        previousFenceToken: operation === 'replace' ? randomUUID() : null, deployment: lifecycleDeployment };
    const document = JSON.stringify(intent), digest = createHash('sha256').update(document).digest('hex');
    const work: LifecycleWork = { document, digest, createdAt: new Date() };
    const receipt: LifecycleReceipt = { schemaVersion: 1, jobId: intent.jobId, digest, computerId: intent.computerId,
        generation: intent.targetGeneration, fenceToken: intent.fenceToken, instanceId: intent.providerInstanceId ?? 'i-11111111111111111',
        volumeId: intent.dataVolumeId ?? 'vol-11111111111111111', state: operation === 'retire' ? 'retired' : operation === 'stop' ? 'stopped' : 'running' };
    return { intent, work, receipt };
}
