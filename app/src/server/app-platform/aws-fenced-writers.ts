import { DescribeInstancesCommand, type EC2Client } from '@aws-sdk/client-ec2';
import { FencedWritersSchema, type FencedWriters } from './computer-recovery-authority';
import { parseComputerRecoveryWork } from './computer-recovery-protocol';
import { LifecycleError, type LifecycleWork } from './lifecycle-protocol';

export function validateFencedWriters(work: LifecycleWork, input: unknown): FencedWriters {
    const i = parseComputerRecoveryWork(work), parsed = FencedWritersSchema.safeParse(input);
    if (!parsed.success || parsed.data.some(w => w.generation >= i.targetGeneration || w.fenceToken === i.fenceToken
        || Date.parse(w.observedAt) > Date.parse(w.fencedAt) + 5000 || Date.parse(w.fencedAt) > work.createdAt.getTime() + 5000)) {
        throw new LifecycleError('lifecycle_conflict');
    }
    return parsed.data;
}

/** Only server-recorded positive historical fences can survive EC2's eventual
 * removal of terminated IDs. This exception MUST NOT be used for the newly
 * allocated generation, a null provider ID, or an uncertain allocation. */
export async function observeFencedWriters(ec2: Pick<EC2Client, 'send'>, work: LifecycleWork,
    writers: FencedWriters, signal: AbortSignal) {
    const i = parseComputerRecoveryWork(work), d = i.deployment;
    validateFencedWriters(work, writers);
    for (let offset = 0; offset < writers.length; offset += 8) {
        await Promise.all(writers.slice(offset, offset + 8).map(async w => {
            let result;
            try { result = await ec2.send(new DescribeInstancesCommand({ InstanceIds: [w.instanceId] }), { abortSignal: signal }); }
            catch (error) {
                if (!signal.aborted && error instanceof Error && error.name === 'InvalidInstanceID.NotFound') return;
                throw error;
            }
            const rows = result.Reservations?.flatMap(r => (r.Instances ?? []).map(instance => ({ instance, owner: r.OwnerId }))) ?? [];
            if (result.NextToken || rows.length > 1) throw new LifecycleError('lifecycle_unconfirmed');
            if (!rows.length) return;
            const row = rows[0]!, instance = row.instance;
            const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
                'ezil:generation': String(w.generation), 'ezil:fence-token': w.fenceToken };
            if (row.owner !== d.accountId || instance.InstanceId !== w.instanceId || instance.State?.Name !== 'terminated'
                || instance.Placement?.AvailabilityZone !== d.availabilityZone
                || !Object.entries(tags).every(([key, value]) => instance.Tags?.filter(t => t.Key === key).length === 1
                    && instance.Tags.find(t => t.Key === key)?.Value === value)) throw new LifecycleError('lifecycle_unconfirmed');
        }));
    }
    if (signal.aborted) throw new LifecycleError('lifecycle_unconfirmed');
}
