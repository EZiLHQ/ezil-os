import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand,
    type EC2ClientConfig, type Instance, type Tag } from '@aws-sdk/client-ec2';
import { SFNClient, DescribeExecutionCommand, DescribeStateMachineCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { LifecycleError, parseLifecycleWork, validateLifecycleReceipt, type LifecycleWork } from './lifecycle-protocol';
import type { LifecycleConsumerOptions } from './lifecycle-consumer';

export interface AwsLifecycleTransportOptions {
    /** Dedicated short-lived OIDC federation. No shared profile, IMDS or
     * long-lived administrator credential fallback in the web control plane. */
    credentials(): Promise<{ accessKeyId: string; secretAccessKey: string; sessionToken: string; expiration: Date }>;
    requestHandler?: EC2ClientConfig['requestHandler'];
}
const fail = (code: LifecycleError['code']): never => { throw new LifecycleError(code); };
const nameOf = (error: unknown) => error instanceof Error ? error.name : '';
const tagged = (tags: Tag[] | undefined, expected: Record<string, string>) => Object.entries(expected).every(([key, value]) =>
    tags?.filter(t => t.Key === key).length === 1 && tags.find(t => t.Key === key)?.Value === value);

/** Real Standard submission plus independent EC2/EBS observation. EC2 mutations
 * belong to the version-pinned Standard workflow, never a retried HTTP consumer.
 * A failed/missing/aborted execution retains admission until reconciliation. */
export function createAwsLifecycleTransport(options: AwsLifecycleTransportOptions):
    Pick<LifecycleConsumerOptions, 'advance'> & { destroy(): void } {
    const credentials = async () => {
        const c = await options.credentials();
        if (!c || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId) || !c.secretAccessKey || !c.sessionToken
            || !(c.expiration instanceof Date) || !Number.isFinite(c.expiration.getTime())
            || c.expiration.getTime() < Date.now() + 30000) return fail('lifecycle_invalid');
        return c;
    };
    const settings = { region: 'us-east-1', credentials, maxAttempts: 1,
        requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } };
    const sfn = new SFNClient({ ...settings, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const ec2 = new EC2Client({ ...settings, endpoint: 'https://ec2.us-east-1.amazonaws.com' });

    async function advance(work: LifecycleWork, allowStart: boolean, signal: AbortSignal) {
        const i = parseLifecycleWork(work), d = i.deployment;
        const versionArn = d.stateMachineVersionArn, machineArn = versionArn.slice(0, versionArn.lastIndexOf(':'));
        const name = `computer-${i.jobId}`, executionArn = machineArn.replace(':stateMachine:', ':execution:') + ':' + name;
        // Preserve the SQL-returned UTF-8 document exactly; do not reserialize it.
        const input = JSON.stringify({ schemaVersion: 1, document: work.document, digest: work.digest });
        const request = { abortSignal: signal };
        const describe = async () => {
            try { return await sfn.send(new DescribeExecutionCommand({ executionArn }), request); }
            catch (e) { if (nameOf(e) === 'ExecutionDoesNotExist') return null; throw e; }
        };
        let execution = await describe();
        if (!execution) {
            if (!allowStart) return { state: 'pending' as const };
            // AWS execution names become reusable after history expiry (90d).
            // Never resurrect a missing historical execution under the same name.
            if (Date.now() - work.createdAt.getTime() > 7 * 86400000 || work.createdAt.getTime() > Date.now() + 30000) {
                return fail('lifecycle_unconfirmed');
            }
            const definition = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: versionArn, includedData: 'METADATA_ONLY' }), request);
            if (definition.stateMachineArn !== versionArn || definition.type !== 'STANDARD' || definition.status !== 'ACTIVE') {
                return fail('lifecycle_conflict');
            }
            try {
                const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: versionArn, name, input }), request);
                if (started.executionArn !== executionArn) return fail('lifecycle_conflict');
                return { state: 'pending' as const };
            } catch (e) {
                if (e instanceof LifecycleError || signal.aborted) throw e;
                // Observe an ambiguous start once. No fresh name or SDK retry.
                execution = await describe();
                if (!execution) return fail('lifecycle_unconfirmed');
            }
        }
        if (execution.executionArn !== executionArn || execution.stateMachineArn !== machineArn
            || execution.stateMachineVersionArn !== versionArn || execution.stateMachineAliasArn || execution.name !== name
            || execution.input !== input || execution.redriveCount !== 0) return fail('lifecycle_conflict');
        if (execution.status === 'RUNNING') return { state: 'pending' as const };
        if (execution.status !== 'SUCCEEDED') return fail('lifecycle_unconfirmed');
        if (!execution.output || Buffer.byteLength(execution.output) > 4096) return fail('lifecycle_conflict');
        let json: unknown;
        try { json = JSON.parse(execution.output); } catch { return fail('lifecycle_conflict'); }
        const receipt = validateLifecycleReceipt(work, json);
        const ids = [receipt.instanceId, ...(i.previousInstanceId ? [i.previousInstanceId] : [])];
        const [instances, volumes] = await Promise.all([
            ec2.send(new DescribeInstancesCommand({ InstanceIds: ids }), request),
            ec2.send(new DescribeVolumesCommand({ VolumeIds: [receipt.volumeId] }), request),
        ]);
        const entries = instances.Reservations?.flatMap(r => (r.Instances ?? []).map(instance => ({ instance, owner: r.OwnerId }))) ?? [];
        if (instances.NextToken || volumes.NextToken || entries.length !== ids.length || volumes.Volumes?.length !== 1
            || new Set(entries.map(e => e.instance.InstanceId)).size !== ids.length || entries.some(e => e.owner !== d.accountId)) {
            return fail('lifecycle_conflict');
        }
        const target = entries.find(e => e.instance.InstanceId === receipt.instanceId)?.instance;
        const v = volumes.Volumes[0]!;
        const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
            'ezil:generation': String(i.targetGeneration), 'ezil:fence-token': i.fenceToken };
        const identity = (instance: Instance | undefined, expected = tags) => instance && tagged(instance.Tags, expected)
            && instance.Placement?.AvailabilityZone === d.availabilityZone;
        if (!identity(target) || !tagged(v.Tags, tags) || v.VolumeId !== receipt.volumeId
            || v.AvailabilityZone !== d.availabilityZone || v.Encrypted !== true || v.KmsKeyId !== d.dataKeyArn
            || v.Size !== 50 || v.VolumeType !== 'gp3' || v.MultiAttachEnabled !== false) return fail('lifecycle_conflict');
        if (i.previousInstanceId) {
            const old = entries.find(e => e.instance.InstanceId === i.previousInstanceId)?.instance;
            // STOPPED alone is insufficient: a delayed old StartInstances could
            // restart it. Replacement fencing requires observed termination.
            if (!identity(old, { ...tags, 'ezil:generation': String(i.previousGeneration), 'ezil:fence-token': i.previousFenceToken! })
                || old?.State?.Name !== 'terminated') return fail('lifecycle_unconfirmed');
        }
        if (receipt.state === 'retired') {
            if (target?.State?.Name !== 'terminated' || v.State !== 'available' || v.Attachments?.length !== 0) {
                return fail('lifecycle_unconfirmed');
            }
        } else {
            if (target?.State?.Name !== receipt.state || target.Architecture !== 'x86_64' || target.InstanceType !== 'm7i.large'
                || target.ImageId !== d.amiId || target.SubnetId !== d.subnetId || target.RootDeviceType !== 'ebs'
                || target.SecurityGroups?.length !== 1 || target.SecurityGroups[0]?.GroupId !== d.securityGroupId
                // DescribeInstances exposes effective launch properties, not a
                // LaunchTemplate field. The pinned workflow owns template use.
                || target.IamInstanceProfile?.Arn !== d.instanceProfileArn || target.MetadataOptions?.HttpTokens !== 'required'
                || target.MetadataOptions.HttpPutResponseHopLimit !== 1 || target.MetadataOptions.State !== 'applied') return fail('lifecycle_conflict');
            const mapping = target.BlockDeviceMappings?.filter(m => m.Ebs?.VolumeId === receipt.volumeId);
            const a = v.Attachments?.[0];
            if (v.State !== 'in-use' || mapping?.length !== 1 || mapping[0]?.Ebs?.DeleteOnTermination !== false
                || mapping[0]?.Ebs?.Status !== 'attached' || v.Attachments?.length !== 1 || a?.State !== 'attached'
                || a.InstanceId !== receipt.instanceId || a.VolumeId !== receipt.volumeId || a.Device !== mapping[0].DeviceName
                || a.DeleteOnTermination !== false) return fail('lifecycle_unconfirmed');
        }
        if (signal.aborted) return fail('lifecycle_unconfirmed');
        return { state: 'observed' as const, receipt, observedAt: new Date() };
    }
    return {
        async advance(work, allowStart, signal) {
            try { return await advance(work, allowStart, signal); }
            catch (e) { if (e instanceof LifecycleError) throw e; throw new LifecycleError('lifecycle_unavailable'); }
        },
        destroy() { sfn.destroy(); ec2.destroy(); },
    };
}
