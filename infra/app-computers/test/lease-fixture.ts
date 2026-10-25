import type { LifecycleIntent } from '../lib/lifecycle/intent.js';

/** Test double for lane A's enrollment serializer; contains no live nonce. */
export function leaseFixture(i: Pick<LifecycleIntent, 'computerId' | 'dataVolumeId' | 'targetGeneration' | 'leaseEpoch' | 'operation'>): string {
    return Buffer.from(JSON.stringify({ v: 1, computerId: i.computerId,
        ...(i.dataVolumeId ? { volumeId: i.dataVolumeId } : {}), fsUuid: '22222222-2222-4222-8222-222222222222',
        generation: i.targetGeneration, leaseEpoch: i.leaseEpoch, nonce: 'n'.repeat(43), provision: i.operation === 'provision',
        enrollUrl: 'https://os.example.com/api/compute/aws/enroll' })).toString('base64');
}
