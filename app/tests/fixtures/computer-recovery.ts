import { randomUUID, createHash } from 'node:crypto';
import type { ComputerRecoveryIntentV2 } from '../../src/server/app-platform/computer-recovery-protocol';
import type { ComputerRecoveryReceipt } from '../../src/server/app-platform/computer-lifecycle-work';
import type { FencedWriters } from '../../src/server/app-platform/computer-recovery-authority';
import { lifecycleDeployment } from './lifecycle';

export function computerRecoveryFixture() {
    const now = Date.now(), computerId = randomUUID();
    const intent: ComputerRecoveryIntentV2 = { schemaVersion: 2, operation: 'recover', computerId, jobId: randomUUID(),
        revision: 2, targetGeneration: 2, fenceToken: randomUUID(), source: { schemaVersion: 1, jobId: randomUUID(), digest: 'a'.repeat(64) },
        dataVolumeId: 'vol-11111111111111111', dataScope: { generation: 1, fenceToken: randomUUID() },
        deployment: { ...lifecycleDeployment, instanceProfileArn: `arn:aws:iam::123456789012:instance-profile/ezil/pilot/computers/${computerId}/g2` } };
    const document = JSON.stringify(intent), digest = createHash('sha256').update(document).digest('hex');
    const work = { document, digest, createdAt: new Date(now) };
    const writers: FencedWriters = [{ instanceId: 'i-22222222222222222', ...intent.dataScope,
        observedAt: new Date(now - 10000).toISOString(), fencedAt: new Date(now - 5000).toISOString() }];
    const receipt: ComputerRecoveryReceipt = { schemaVersion: 2, jobId: intent.jobId, computerId, digest, generation: 2,
        fenceToken: intent.fenceToken, instanceId: 'i-11111111111111111', volumeId: intent.dataVolumeId, state: 'running' };
    return { intent, work, writers, receipt };
}
