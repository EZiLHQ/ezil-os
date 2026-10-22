import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LifecycleDeploymentSchema } from '../lib/lifecycle/deployment.js';
import { parseLifecycleWork, type LifecycleIntent } from '../lib/lifecycle/intent.js';
import { PreparationDocumentSchema } from '../lib/lifecycle/preparation-contract.js';

export const hash = (document: string) => createHash('sha256').update(document).digest('hex');
export const envelopeFor = (value: unknown) => { const document = JSON.stringify(value); return { schemaVersion: 1, document, digest: hash(document) }; };
/** Read the actual lane A fixture; reconstruct its separately hashed preparation. */
export function rebaseFixture() {
    const shared = JSON.parse(readFileSync(join(__dirname, '../../../app/src/server/lib/compute/aws-intent.fixtures.json'), 'utf8'));
    const envelope = JSON.parse(shared['rebase-replace'].input);
    const base = parseLifecycleWork({ ...envelope, createdAt: new Date('2026-10-22T12:00:00.000Z') });
    const deployment = base.deployment;
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
    const lease = JSON.parse(Buffer.from(base.userData!, 'base64').toString('utf8'));
    const intent = base;
    if (preparationEnvelope.digest !== base.rebasePreparation!.digest) throw new Error('app_preparation_fixture_drift');
    return { intent, lease, preparation, preparationEnvelope, envelope: envelopeFor(intent), reference };
}

export function rebindFixture() {
    const shared = JSON.parse(readFileSync(join(__dirname, '../../../app/src/server/lib/compute/aws-intent.fixtures.json'), 'utf8'));
    const envelope = JSON.parse(shared['ebs-restore-rebind'].input);
    const intent = parseLifecycleWork({ ...envelope, createdAt: new Date('2026-10-22T12:00:00.000Z') });
    return { intent, envelope, lease: JSON.parse(Buffer.from(intent.userData!, 'base64').toString('utf8')) };
}
