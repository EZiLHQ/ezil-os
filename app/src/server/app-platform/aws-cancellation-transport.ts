import { EC2Client } from '@aws-sdk/client-ec2';
import { SFNClient, DescribeExecutionCommand, DescribeStateMachineCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import type { AwsLifecycleTransportOptions } from './aws-lifecycle-transport';
import type { CancellationConsumerOptions } from './cancellation-consumer';
import { type LifecycleWork, LifecycleError } from './lifecycle-protocol';
import { parseComputerLifecycleWork } from './computer-lifecycle-work';
import { parseComputerCancellation } from './computer-cancellation-protocol';
import { CancellationAuthorityScopeSchema, validateCancellationReceipt, type CancellationAuthorityScope } from './cancellation-authority-protocol';
import { lifecycleDeploymentApproved } from './lifecycle-approval';
import { observeCancelledResources, verifyCancelledSource } from './aws-cancellation-observation';

export type AwsCancellationTransportOptions = Pick<AwsLifecycleTransportOptions, 'credentials' | 'requestHandler'>
    & Pick<CancellationConsumerOptions, 'deployments' | 'workflows'>;
const fail = (code: LifecycleError['code'] = 'lifecycle_unconfirmed'): never => { throw new LifecycleError(code); };
const millis = (date: Date | undefined) => date instanceof Date && Number.isFinite(date.getTime()) ? date.getTime() : NaN;

/** Starts only the exact approved cancellation execution. EC2 mutations and
 * StopExecution belong to its pinned Standard workflow, not this web adapter. */
export function createAwsCancellationTransport(options: AwsCancellationTransportOptions): Pick<CancellationConsumerOptions, 'advance'> & { destroy(): void } {
    const credentials = async () => {
        const c = await options.credentials();
        if (!c || !/^ASIA[A-Z0-9]{16}$/.test(c.accessKeyId) || !c.secretAccessKey || !c.sessionToken
            || !Number.isFinite(millis(c.expiration)) || millis(c.expiration) < Date.now()+30000) return fail('lifecycle_invalid');
        return c;
    };
    const settings = { region: 'us-east-1', credentials, maxAttempts: 1,
        requestHandler: options.requestHandler ?? { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } };
    const sfn = new SFNClient({ ...settings, endpoint: 'https://states.us-east-1.amazonaws.com' });
    const ec2 = new EC2Client({ ...settings, endpoint: 'https://ec2.us-east-1.amazonaws.com' });
    async function advance(work: LifecycleWork, source: LifecycleWork, scope: CancellationAuthorityScope, signal: AbortSignal) {
        const c = parseComputerCancellation(work,source), i = parseComputerLifecycleWork(source);
        if (signal.aborted) return fail();
        if (!CancellationAuthorityScopeSchema.safeParse(scope).success || !lifecycleDeploymentApproved(options.deployments,i)
            || options.workflows[i.deployment.stateMachineVersionArn] !== c.workflowVersionArn
            || scope.source.jobId !== i.jobId || scope.source.schemaVersion !== i.schemaVersion || scope.source.digest !== source.digest
            || (i.dataVolumeId !== null && scope.dataVolumeId !== i.dataVolumeId)
            || source.createdAt.getTime() > work.createdAt.getTime()+5000) return fail('lifecycle_conflict');
        const version = c.workflowVersionArn, machine = version.slice(0,version.lastIndexOf(':')), name = `cancel-computer-${c.cancellationId}`;
        const arn = machine.replace(':stateMachine:',':execution:')+':'+name;
        const input = JSON.stringify({ schemaVersion: 1, document: work.document, digest: work.digest,
            source: { schemaVersion: i.schemaVersion, document: source.document, digest: source.digest } });
        const request = { abortSignal: signal };
        const describe = async () => {
            try { return await sfn.send(new DescribeExecutionCommand({ executionArn: arn }),request); }
            catch (e) { if (e instanceof Error && e.name === 'ExecutionDoesNotExist') return null; throw e; }
        };
        let execution = await describe();
        if (!execution) {
            // Names can be reused after provider history expiry; never resurrect
            // old cancellation work or rename an ambiguous execution.
            if (Date.now()-work.createdAt.getTime()>7*86400000 || work.createdAt.getTime()>Date.now()+30000) return fail();
            const definition = await sfn.send(new DescribeStateMachineCommand({ stateMachineArn: version, includedData: 'METADATA_ONLY' }),request);
            if (definition.stateMachineArn !== version || definition.type !== 'STANDARD' || definition.status !== 'ACTIVE') return fail('lifecycle_conflict');
            try {
                const started = await sfn.send(new StartExecutionCommand({ stateMachineArn: version, name, input }),request);
                if (started.executionArn !== arn) return fail('lifecycle_conflict');
                return { state: 'pending' as const };
            } catch (e) {
                if (e instanceof LifecycleError || signal.aborted) throw e;
                execution = await describe(); if (!execution) return fail();
            }
        }
        if (execution.executionArn !== arn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== version
            || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.name !== name || execution.input !== input
            || !Number.isFinite(millis(execution.startDate)) || millis(execution.startDate)<work.createdAt.getTime()-5000
            || millis(execution.startDate)>Date.now()+5000) return fail('lifecycle_conflict');
        if (execution.status === 'RUNNING') return { state: 'pending' as const };
        if (execution.status !== 'SUCCEEDED' || !execution.output || Buffer.byteLength(execution.output)>8192
            || !Number.isFinite(millis(execution.stopDate)) || millis(execution.stopDate)<millis(execution.startDate)
            || millis(execution.stopDate)>Date.now()+5000) return fail();
        const receipt = validateCancellationReceipt(work,source,JSON.parse(execution.output));
        const original = await verifyCancelledSource(sfn,source,execution.stopDate!,signal);
        if (Date.now()-original.stopDate!.getTime()<60000) return { state: 'pending' as const };
        await observeCancelledResources({ sfn, ec2, source, scope, receipt: receipt.source, execution: original, signal });
        const checked = await verifyCancelledSource(sfn,source,execution.stopDate!,signal);
        if (checked.status !== original.status || checked.startDate!.getTime() !== original.startDate!.getTime()
            || checked.stopDate!.getTime() !== original.stopDate!.getTime() || signal.aborted) return fail();
        return { state: 'observed' as const, receipt, observedAt: new Date() };
    }
    return { async advance(work,source,scope,signal) {
        try { return await advance(work,source,scope,signal); }
        catch (e) { if (e instanceof LifecycleError) throw e; throw new LifecycleError('lifecycle_unavailable'); }
    }, destroy() { sfn.destroy(); ec2.destroy(); } };
}
