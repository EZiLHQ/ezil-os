import { DescribeExecutionCommand, GetExecutionHistoryCommand, type SFNClient, type HistoryEvent } from '@aws-sdk/client-sfn';
import { DescribeInstancesCommand, DescribeVolumesCommand, type EC2Client, type Tag } from '@aws-sdk/client-ec2';
import { LifecycleError, parseLifecycleWork, type LifecycleWork } from './lifecycle-protocol';
import { lifecycleAllocationToken, validateLifecycleRecoveryReceipt } from './lifecycle-recovery-protocol';

const fail = (): never => { throw new LifecycleError('lifecycle_unconfirmed'); };
const tagged = (tags: Tag[] | undefined, expected: Record<string, string>) => Object.entries(expected).every(([key, value]) =>
    tags?.filter(t => t.Key === key).length === 1 && tags.find(t => t.Key === key)?.Value === value);

/** A trusted deployment maps each original numeric workflow version to its
 * recovery version. These are operator pins, never browser-submitted ARNs. */
export type LifecycleRecoveryDeployments = Readonly<Record<string, string>>;

export async function observeLifecycleRecovery(options: {
    work: LifecycleWork; recoveryVersionArn: string; sourceStatus: string;
    sfn: Pick<SFNClient, 'send'>; ec2: Pick<EC2Client, 'send'>; signal: AbortSignal;
}) {
    const { work, recoveryVersionArn: version, sfn, ec2, signal } = options;
    const i = parseLifecycleWork(work), d = i.deployment;
    const originalMachine = d.stateMachineVersionArn.slice(0, d.stateMachineVersionArn.lastIndexOf(':'));
    if (!new RegExp(`^arn:aws:states:us-east-1:${d.accountId}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$`).test(version)
        || !['FAILED', 'ABORTED', 'TIMED_OUT'].includes(options.sourceStatus)) return fail();
    const machine = version.slice(0, version.lastIndexOf(':'));
    if (machine === originalMachine) return fail();
    const sourceArn = originalMachine.replace(':stateMachine:', ':execution:') + `:computer-${i.jobId}`;
    const name = `cleanup-computer-${i.jobId}`, arn = machine.replace(':stateMachine:', ':execution:') + ':' + name;
    const request = { abortSignal: signal };
    let execution;
    try { execution = await sfn.send(new DescribeExecutionCommand({ executionArn: arn }), request); }
    catch (error) { if (error instanceof Error && error.name === 'ExecutionDoesNotExist') return { state: 'pending' as const }; throw error; }
    if (execution.executionArn !== arn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== version
        || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.name !== name
        || execution.input !== JSON.stringify({ sourceExecutionArn: sourceArn })) return fail();
    if (execution.status === 'RUNNING') return { state: 'pending' as const };
    if (execution.status !== 'SUCCEEDED' || !execution.output || Buffer.byteLength(execution.output) > 4096) return fail();
    const receipt = validateLifecycleRecoveryReceipt(work, JSON.parse(execution.output));
    // A fencing receipt cannot omit a possibly allocated instance or disk.
    const history: HistoryEvent[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 4; page++) {
        const result = await sfn.send(new GetExecutionHistoryCommand({ executionArn: sourceArn,
            includeExecutionData: false, maxResults: 1000, reverseOrder: false, nextToken }), request);
        history.push(...result.events ?? []); nextToken = result.nextToken;
        if (!nextToken) break;
    }
    if (nextToken || !history.length || history.length > 4000 || history[0]?.type !== 'ExecutionStarted'
        || history.at(-1)?.type !== ({ FAILED: 'ExecutionFailed', ABORTED: 'ExecutionAborted', TIMED_OUT: 'ExecutionTimedOut' } as Record<string, string>)[options.sourceStatus]
        || history.some((h, index) => h.id !== index + 1 || !h.timestamp
            || (h.type === 'TaskStateEntered' && !h.stateEnteredEventDetails?.name))) return fail();
    const entered = (name: string) => history.some(h => h.type === 'TaskStateEntered' && h.stateEnteredEventDetails?.name === name);
    const originalId = i.previousInstanceId ?? i.providerInstanceId;
    const target = receipt.instances.find(v => v.instanceId !== originalId);
    if (['provision', 'replace'].includes(i.operation) && entered('runInstances') !== Boolean(target)) return fail();
    if (i.operation === 'provision' && entered('createVolume') !== (receipt.volumeId !== null)) return fail();
    // Empty ID lists must never turn into unscoped account-wide describes.
    const [instances, volumes] = await Promise.all([
        receipt.instances.length ? ec2.send(new DescribeInstancesCommand({ InstanceIds: receipt.instances.map(v => v.instanceId) }), request) : null,
        receipt.volumeId ? ec2.send(new DescribeVolumesCommand({ VolumeIds: [receipt.volumeId] }), request) : null,
    ]);
    const rows = instances?.Reservations?.flatMap(r => (r.Instances ?? []).map(instance => ({ instance, owner: r.OwnerId }))) ?? [];
    if (instances?.NextToken || volumes?.NextToken || rows.length !== receipt.instances.length
        || new Set(rows.map(r => r.instance.InstanceId)).size !== rows.length) return fail();
    const tags = (generation: number, fence: string) => ({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': String(generation), 'ezil:fence-token': fence });
    for (const expected of receipt.instances) {
        const row = rows.find(r => r.instance.InstanceId === expected.instanceId), instance = row?.instance;
        if (row?.owner !== d.accountId || !instance || instance.State?.Name !== 'terminated'
            || instance.Placement?.AvailabilityZone !== d.availabilityZone || !tagged(instance.Tags, tags(expected.generation, expected.fenceToken))
            || (expected.instanceId !== originalId && instance.ClientToken !== lifecycleAllocationToken(work.digest, 'instance'))) return fail();
    }
    if (receipt.volumeId) {
        const v = volumes?.Volumes?.[0];
        if (volumes?.Volumes?.length !== 1 || v?.VolumeId !== receipt.volumeId || v.State !== 'available' || v.Attachments?.length !== 0
            || v.Encrypted !== true || v.KmsKeyId !== d.dataKeyArn || v.Size !== 50 || v.VolumeType !== 'gp3'
            || v.MultiAttachEnabled !== false || v.AvailabilityZone !== d.availabilityZone
            || (!tagged(v.Tags, tags(i.targetGeneration, i.fenceToken))
                && !(i.previousGeneration && tagged(v.Tags, tags(i.previousGeneration, i.previousFenceToken!))))
            || (i.operation === 'provision' && !tagged(v.Tags, { 'ezil:allocation': lifecycleAllocationToken(work.digest, 'volume') }))) return fail();
    }
    if (signal.aborted) return fail();
    return { state: 'fenced' as const, receipt, observedAt: new Date() };
}
