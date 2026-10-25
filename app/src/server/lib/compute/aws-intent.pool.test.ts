import { expect, it } from 'vitest';
import { buildLifecycleWork, type LifecycleIntent } from './aws-intent';
import { fixturePoolIntent } from './aws-intent.test-support';
import fixtures from './aws-intent.fixtures.json';
it.each(['pool-provision', 'pool-retire', 'adopt', 'release'] as const)('%s envelope matches pinned bytes', operation => {
    const w = buildLifecycleWork(fixturePoolIntent(operation));
    expect({ name: w.name, stateMachineArn: w.stateMachineArn, digest: w.digest, input: w.input }).toEqual(fixtures[operation]);
});
it.each(['pool-provision', 'pool-retire', 'adopt', 'release'] as const)('%s uses the infra pool allowlist', operation => {
    const i = fixturePoolIntent(operation);
    for (const type of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) expect(buildLifecycleWork({ ...i, instanceType: type,
        deployment: { ...i.deployment, instanceTypes: [type] } }).intent.instanceType).toBe(type);
    for (const type of ['t3a.medium', 'c6i.xlarge']) expect(() => buildLifecycleWork({ ...i, instanceType: type,
        deployment: { ...i.deployment, instanceTypes: [type] } })).toThrow();
});
const cases: [Parameters<typeof fixturePoolIntent>[0], string, Partial<LifecycleIntent>][] = [
    ['pool-provision', 'missing host', { poolHostId: undefined }],
    ['pool-provision', 'missing generation', { poolGeneration: undefined }],
    ['pool-provision', 'zero generation', { poolGeneration: 0 }],
    ['pool-provision', 'wrong generation', { poolGeneration: 2 }],
    ['pool-provision', 'tenant computer', { computerId: '22222222-2222-4222-8222-222222222222' }],
    ['pool-provision', 'instance supplied', { providerInstanceId: 'i-11111111111111111' }],
    ['pool-provision', 'volume supplied', { dataVolumeId: 'vol-11111111111111111' }],
    ['pool-provision', 'data size supplied', { dataVolumeGiB: 20 }],
    ['pool-provision', 'userdata supplied', { userData: 'e30=' }],
    ['pool-provision', 'previous generation', { previousGeneration: 1 }],
    ['pool-retire', 'missing host', { poolHostId: undefined }],
    ['pool-retire', 'missing generation', { poolGeneration: undefined }],
    ['pool-retire', 'wrong generation', { poolGeneration: 2 }],
    ['pool-retire', 'tenant computer', { computerId: '22222222-2222-4222-8222-222222222222' }],
    ['pool-retire', 'missing instance', { providerInstanceId: null }],
    ['pool-retire', 'volume supplied', { dataVolumeId: 'vol-11111111111111111' }],
    ['pool-retire', 'data size supplied', { dataVolumeGiB: 20 }],
    ['pool-retire', 'userdata supplied', { userData: 'e30=' }],
    ['adopt', 'missing host', { poolHostId: undefined }],
    ['adopt', 'pool generation supplied', { poolGeneration: 1 }],
    ['adopt', 'missing instance', { providerInstanceId: null }],
    ['adopt', 'no volume or size', { dataVolumeId: null }],
    ['adopt', 'volume and size', { dataVolumeGiB: 20 }],
    ['adopt', 'new volume too small', { dataVolumeId: null, dataVolumeGiB: 1 }],
    ['adopt', 'new volume too large', { dataVolumeId: null, dataVolumeGiB: 101 }],
    ['release', 'host supplied', { poolHostId: '11111111-1111-4111-8111-111111111111' }],
    ['release', 'pool generation supplied', { poolGeneration: 1 }],
    ['release', 'missing instance', { providerInstanceId: null }],
    ['release', 'missing volume', { dataVolumeId: null }],
];
it.each(cases)('%s rejects %s', (op, _label, patch) => expect(() => buildLifecycleWork({ ...fixturePoolIntent(op), ...patch })).toThrow());
it('adopt creates a first volume within the deployment storage bounds', () => {
    expect(buildLifecycleWork({ ...fixturePoolIntent('adopt'), dataVolumeId: null, dataVolumeGiB: 20 }).intent.dataVolumeGiB).toBe(20);
});
