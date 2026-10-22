import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LifecycleDeploymentSchema } from '../lib/lifecycle/deployment.js';
import type { LifecycleIntent } from '../lib/lifecycle/intent.js';
import { PreparationDocumentSchema } from '../lib/lifecycle/preparation-contract.js';
import { leaseFixture } from './lease-fixture.js';

export const hash = (document: string) => createHash('sha256').update(document).digest('hex');
export const envelopeFor = (value: unknown) => { const document = JSON.stringify(value); return { schemaVersion: 1, document, digest: hash(document) }; };
/** Equivalent of the contract's lane A `rebase-replace` fixture. */
export function rebaseFixture() {
    const shared = JSON.parse(readFileSync(join(__dirname, '../../../app/src/server/lib/compute/aws-intent.fixtures.json'), 'utf8'));
    const base = Object.values(shared).map((f: any) => JSON.parse(JSON.parse(f.input).document))
        .find((i: any) => i.operation === 'replace' && i.deployment.region === 'ap-south-1') as LifecycleIntent;
    // The current shared file has only the free-tier replacement variant;
    // §3 pins fixtureIntent('replace')'s default m6i.large and type list.
    base.instanceType = 'm6i.large'; base.deployment.instanceTypes = ['m6i.large', 'c6i.xlarge'];
    const deployment = LifecycleDeploymentSchema.parse({ ...base.deployment,
        storage: { ...base.deployment.storage, rootDeviceName: '/dev/sda1' },
        lowerImageDigest: 'sha256:' + 'b'.repeat(64), previousLowerImageDigest: 'sha256:' + 'a'.repeat(64),
        preparationStateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-rebase-preparation:1',
        recoveryStateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-pilot-recovery:1' });
    const sourceDeployment = LifecycleDeploymentSchema.parse({ ...deployment, amiId: 'ami-22222222222222222',
        lowerImageDigest: deployment.previousLowerImageDigest, previousLowerImageDigest: null,
        stateMachineVersionArn: deployment.stateMachineVersionArn.replace(/:1$/, ':2') });
    const preparation = PreparationDocumentSchema.parse({ schemaVersion: 1, jobId: '11111111-1111-4111-8111-111111111111',
        computerId: base.computerId, sourceInstanceId: base.previousInstanceId, sourceVolumeId: base.dataVolumeId,
        fsUuid: '22222222-2222-4222-8222-222222222222', sourceGeneration: base.previousGeneration,
        sourceLeaseEpoch: 3, sourceFenceToken: base.previousFenceToken,
        fromDigest: deployment.previousLowerImageDigest, toDigest: deployment.lowerImageDigest, volumeGiB: 20,
        sourceDeployment, deployment, createdAt: '2026-10-22T11:00:00.000Z' });
    const preparationEnvelope = envelopeFor(preparation);
    const reference = { v: 1 as const, preparationJobId: preparation.jobId,
        executionArn: 'arn:aws:states:ap-south-1:123456789012:execution:ezil-pilot-rebase-preparation:computer-' + preparation.jobId,
        digest: preparationEnvelope.digest };
    const lease = { ...JSON.parse(Buffer.from(leaseFixture(base), 'base64').toString('utf8')), rebase: { snapshotId: 'snap-11111111111111111', volumeId: base.dataVolumeId,
        fromDigest: preparation.fromDigest, toDigest: preparation.toDigest }, rebasePermit: { v: 1, preparationJobId: preparation.jobId,
        launchJobId: base.jobId, computerId: base.computerId, fsUuid: preparation.fsUuid,
        generation: base.targetGeneration, leaseEpoch: base.leaseEpoch, fenceToken: base.fenceToken,
        issuedAt: '2026-10-22T12:00:00.000Z', expiresAt: '2026-10-22T12:10:00.000Z' } };
    const intent: LifecycleIntent = { ...base, deployment, userData: Buffer.from(JSON.stringify(lease)).toString('base64'), rebasePreparation: reference };
    return { intent, lease, preparation, preparationEnvelope, envelope: envelopeFor(intent), reference };
}
