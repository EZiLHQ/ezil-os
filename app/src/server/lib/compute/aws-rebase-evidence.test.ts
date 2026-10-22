import { describe, expect, it, vi } from 'vitest';
import { createEc2EnrollmentDescriber } from './aws-clients';
import { verifyImageSnapshot } from './aws-rebase-evidence';
import { rebaseSetup } from './aws-rebase.test-support';

describe('independent EC2 snapshot evidence', () => {
    it.each(['pending', 'missing', 'source', 'size', 'key', 'unencrypted', 'started', 'duplicate-tag', 'extra-tag'])('refuses %s snapshot evidence', async fault => {
        const s = rebaseSetup(); await s.run('prepare'); await s.completePreparation();
        const j = await s.current(), e = s.executions.get(j.preparationExecutionArn!)!, v = s.provider.snapshot!;
        if (fault === 'pending') v.state = 'pending';
        if (fault === 'source') v.volumeId = 'vol-22222222222222222';
        if (fault === 'size') v.volumeGiB++;
        if (fault === 'key') v.kmsKeyId += 'foreign';
        if (fault === 'unencrypted') v.encrypted = false;
        if (fault === 'started') v.startedAt = new Date('2026-10-22T11:00:00.000Z');
        if (fault === 'duplicate-tag' || fault === 'extra-tag') v.tags = { ...v.tags, Name: 'extra' };
        expect(() => verifyImageSnapshot(j, e, fault === 'missing' ? null : v, s.deps.now())).toThrow();
    });
    it('pins DescribeSnapshots to the exact ID and owner and rejects duplicate tag keys', async () => {
        const send = vi.fn(async () => ({ Snapshots: [{ SnapshotId: 'snap-11111111111111111', OwnerId: '123456789012',
            StartTime: new Date(), Tags: [{ Key: 'a', Value: '1' }, { Key: 'a', Value: '1' }] }] }));
        const sdk = createEc2EnrollmentDescriber(() => ({ account: '123456789012', client: { send } }));
        await expect(sdk.describeSnapshot('ap-south-1', 'snap-11111111111111111')).rejects.toThrow('DescribeTagsAmbiguous');
        expect((send.mock.calls[0] as unknown as [{ input: unknown }])[0].input).toEqual({ SnapshotIds: ['snap-11111111111111111'], OwnerIds: ['123456789012'] });
    });
    it('rejects duplicate snapshot rows and never treats an API outage as absence', async () => {
        const send = vi.fn(async () => ({ Snapshots: [{}, {}] }));
        const sdk = createEc2EnrollmentDescriber(() => ({ account: '123456789012', client: { send } }));
        await expect(sdk.describeSnapshot('ap-south-1', 'snap-11111111111111111')).rejects.toThrow('DescribeSnapshotsAmbiguous');
        send.mockRejectedValue(new Error('transport'));
        await expect(sdk.describeSnapshot('ap-south-1', 'snap-11111111111111111')).rejects.toThrow();
    });
});

it('duplicate live volume rows cannot authenticate host enrollment', async () => {
    const id = 'i-11111111111111111', volumeId = 'vol-11111111111111111';
    const send = vi.fn().mockResolvedValueOnce({ Reservations: [{ Instances: [{ InstanceId: id, State: { Name: 'running' },
        Placement: { AvailabilityZone: 'ap-south-1a', AvailabilityZoneId: 'aps1-az1' },
        BlockDeviceMappings: [{ Ebs: { VolumeId: volumeId, DeleteOnTermination: false } }] }] }] })
        .mockResolvedValueOnce({ Volumes: [{ VolumeId: volumeId, Tags: [] }, { VolumeId: volumeId, Tags: [] }] });
    const sdk = createEc2EnrollmentDescriber(() => ({ account: '123456789012', client: { send } }));
    await expect(sdk.describeForEnrollment('ap-south-1', id)).rejects.toThrow('DescribeVolumesAmbiguous');
});
