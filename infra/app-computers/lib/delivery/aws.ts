import { createHash, createHmac } from 'node:crypto';
import { EC2Client, DescribeInstancesCommand, DescribeVolumesCommand } from '@aws-sdk/client-ec2';
import { SSMClient, ListCommandsCommand, GetCommandInvocationCommand } from '@aws-sdk/client-ssm';
import { SFNClient, DescribeExecutionCommand } from '@aws-sdk/client-sfn';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { authorityFor, canonical, equal, type Delivery, type Settings } from './contract.js';

export const AUTHORITY_PATH = '/api/internal/apps/configuration-authority';
export function authoritySignature(body: string, key: string, timestamp: string) {
    if (!/^[a-f0-9]{64}$/.test(key) || !/^[0-9]{10}$/.test(timestamp)) throw new Error('authority_unavailable');
    return createHmac('sha256', Buffer.from(key, 'hex'))
        .update(`ezil-configuration-authority-v1\nPOST\n${AUTHORITY_PATH}\n${timestamp}\n${createHash('sha256').update(body).digest('hex')}`).digest('hex');
}
export interface Dependencies {
    execution(arn: string): Promise<import('@aws-sdk/client-sfn').DescribeExecutionOutput>;
    authority(delivery: Delivery): Promise<boolean>;
    writer(delivery: Delivery): Promise<boolean>;
    command(id: string): Promise<import('@aws-sdk/client-ssm').Command | undefined>;
    invocation(id: string, instance: string): Promise<import('@aws-sdk/client-ssm').GetCommandInvocationResult | undefined>;
    now(): number;
}

/** Only read-side SDK operations. SendCommand belongs to the Standard state
 * machine; a Lambda retry must never accidentally dispatch new work. */
export function awsDependencies(settings: Settings, test?: {
    requestHandler: import('@aws-sdk/client-ec2').EC2ClientConfig['requestHandler'];
    credentials: import('@aws-sdk/client-ec2').EC2ClientConfig['credentials'];
    fetcher: typeof fetch;
}): Dependencies {
    const options = { region: settings.region, maxAttempts: 1,
        ...(test ? { credentials: test.credentials } : {}),
        requestHandler: test?.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } };
    const ec2 = new EC2Client({ ...options, endpoint: 'https://ec2.us-east-1.amazonaws.com' });
    const ssm = new SSMClient({ ...options, endpoint: 'https://ssm.us-east-1.amazonaws.com' });
    const sfn = new SFNClient({ ...options, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const secrets = new SecretsManagerClient({ ...options, endpoint: 'https://secretsmanager.us-east-1.amazonaws.com' });
    const signal = () => ({ abortSignal: AbortSignal.timeout(6000) });
    return {
        now: Date.now,
        execution: arn => sfn.send(new DescribeExecutionCommand({ executionArn: arn }), signal()),
        command: async id => {
            const response = await ssm.send(new ListCommandsCommand({ CommandId: id, MaxResults: 1 }), signal());
            if (response.NextToken || (response.Commands?.length ?? 0) > 1) throw new Error('command_ambiguous');
            return response.Commands?.[0];
        },
        invocation: async (id, instance) => {
            try { return await ssm.send(new GetCommandInvocationCommand({ CommandId: id,
                InstanceId: instance, PluginName: 'operateConfiguration' }), signal()); }
            catch (error) { if (error instanceof Error && error.name === 'InvocationDoesNotExist') return undefined; throw error; }
        },
        writer: async delivery => {
            const [instances, volumes] = await Promise.all([
                ec2.send(new DescribeInstancesCommand({ InstanceIds: [delivery.scope.providerInstanceId] }), signal()),
                ec2.send(new DescribeVolumesCommand({ VolumeIds: [delivery.scope.dataVolumeId] }), signal()),
            ]);
            return validWriter(settings, delivery, instances, volumes);
        },
        authority: async delivery => {
            const value = await secrets.send(new GetSecretValueCommand({ SecretId: settings.authoritySecretArn,
                VersionStage: 'AWSCURRENT' }), signal());
            if (value.ARN !== settings.authoritySecretArn || value.SecretBinary || !value.SecretString
                || !value.VersionStages?.includes('AWSCURRENT')) throw new Error('authority_unavailable');
            return requestAuthority(settings.authorityOrigin, value.SecretString, delivery, test?.fetcher);
        },
    };
}

export async function requestAuthority(origin: string, key: string, delivery: Delivery, fetcher: typeof fetch = fetch): Promise<boolean> {
    const body = canonical(authorityFor(delivery)), timestamp = String(Math.floor(Date.now() / 1000));
    const response = await fetcher(`${origin}${AUTHORITY_PATH}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(6000), headers: { 'content-type': 'application/json',
            'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': authoritySignature(body, key, timestamp) }, body });
    const reader = response.body?.getReader();
    if (!reader) throw new Error('authority_unavailable');
    try {
        let size = 0; const chunks: Uint8Array[] = [];
        for (;;) { const part = await reader.read(); if (part.done) break;
            size += part.value.length; if (size > 4096) throw new Error('authority_unavailable'); chunks.push(part.value); }
        if (response.status === 403) return false;
        if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') ?? '')) throw new Error();
        return equal(JSON.parse(Buffer.concat(chunks).toString()), { authorized: true, ...authorityFor(delivery) });
    } catch { throw new Error('authority_unavailable'); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export function validWriter(settings: Settings, delivery: Delivery,
    instances: import('@aws-sdk/client-ec2').DescribeInstancesResult, volumes: import('@aws-sdk/client-ec2').DescribeVolumesResult) {
    const entries = instances.Reservations?.flatMap(r => (r.Instances ?? []).map(instance => ({ instance, owner: r.OwnerId }))) ?? [];
    if (instances.NextToken || volumes.NextToken || entries.length !== 1 || volumes.Volumes?.length !== 1) return false;
    const { instance: i, owner } = entries[0]!, v = volumes.Volumes[0]!;
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': settings.stage,
        'ezil:computer-id': delivery.scope.computerId, 'ezil:generation': String(delivery.scope.computerGeneration),
        'ezil:fence-token': delivery.scope.fenceToken };
    const tagged = (input: typeof i.Tags, required: Record<string, string>) => Object.entries(required).every(([key, value]) =>
        input?.filter(t => t.Key === key).length === 1 && input.find(t => t.Key === key)?.Value === value);
    const mapping = i.BlockDeviceMappings?.filter(m => m.Ebs?.VolumeId === v.VolumeId);
    const attachment = v.Attachments?.[0];
    return owner === settings.accountId && i.InstanceId === delivery.scope.providerInstanceId && i.State?.Name === 'running'
        && tagged(i.Tags, tags) && tagged(v.Tags, tags) && i.Architecture === 'x86_64' && i.InstanceType === 'm7i.large'
        && i.MetadataOptions?.HttpTokens === 'required' && i.MetadataOptions.HttpPutResponseHopLimit === 1
        && v.VolumeId === delivery.scope.dataVolumeId && v.State === 'in-use' && v.Encrypted === true
        && v.KmsKeyId === settings.dataKeyArn && v.VolumeType === 'gp3' && v.Size === 50 && v.MultiAttachEnabled === false
        && v.AvailabilityZone === i.Placement?.AvailabilityZone && !!v.AvailabilityZone
        && v.Attachments?.length === 1 && attachment?.InstanceId === i.InstanceId && attachment.State === 'attached'
        && mapping?.length === 1 && mapping[0]?.Ebs?.DeleteOnTermination === false && mapping[0].Ebs.Status === 'attached'
        && attachment.Device === mapping[0].DeviceName;
}
