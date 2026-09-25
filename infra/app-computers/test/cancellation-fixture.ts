import { createHash, randomUUID } from 'node:crypto';
import type { DescribeExecutionOutput, HistoryEvent } from '@aws-sdk/client-sfn';
import { createCancellationHelper } from '../lib/lifecycle/cancellation-helper.js';
import { cancellationDefinition } from '../lib/lifecycle/cancellation-definition.js';
import { CancellationSettingsSchema, type CancellationScope } from '../lib/lifecycle/cancellation-contract.js';
import { machineArn } from '../lib/lifecycle/recovery-contract.js';
import type { CancellationDependencies } from '../lib/lifecycle/cancellation-aws.js';
import { tagList, tagsFor } from '../lib/lifecycle/contract.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { computerRecoveryFixture } from './computer-recovery-fixture.js';
import assert from 'node:assert/strict';

export function cancellationFixture(operation: 'provision' | 'start' | 'replace' | 'recover' = 'provision', allocated = true) {
    const recovery = operation === 'recover' ? computerRecoveryFixture() : null;
    const f = recovery ?? lifecycleFixture(operation as 'provision' | 'start' | 'replace');
    const settings = CancellationSettingsSchema.parse({ lifecycle: f.settings,
        cancellationVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancellation:1',
        cancellationSecretArn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:ezil/cancel-key-abcdef' });
    const c = { schemaVersion: 1, operation: 'cancel', cancellationId: randomUUID(), computerId: f.i.computerId,
        source: { schemaVersion: f.i.schemaVersion, jobId: f.i.jobId, digest: f.digest, stateAtRequest: 'running' },
        reason: 'stop_requested', requestedBy: randomUUID(), workflowVersionArn: settings.cancellationVersionArn };
    const document = JSON.stringify(c), digest = createHash('sha256').update(document).digest('hex');
    const name = `cancel-computer-${c.cancellationId}`, arn = machineArn(settings.cancellationVersionArn).replace(':stateMachine:', ':execution:') + ':' + name;
    const execution: DescribeExecutionOutput = { executionArn: arn, name, stateMachineArn: machineArn(settings.cancellationVersionArn),
        stateMachineVersionArn: settings.cancellationVersionArn, redriveCount: 0, status: 'RUNNING', startDate: new Date(f.state.now - 1000),
        input: JSON.stringify({ schemaVersion: 1, document, digest, source: f.envelope }) };
    const source: DescribeExecutionOutput = { ...f.state.execution, status: 'SUCCEEDED', startDate: new Date(f.state.now - 180000), stopDate: new Date(f.state.now - 61000) };
    const tasks: string[] = [];
    if (operation === 'provision' && allocated) { f.state.volumes.push((f as ReturnType<typeof lifecycleFixture>).volume()); tasks.push('createVolume'); }
    if (operation !== 'start' && allocated) {
        tasks.push('runInstances');
        if (operation === 'replace' || operation === 'recover') {
            f.state.instances[0]!.State = { Name: 'terminated' }; f.state.instances[0]!.BlockDeviceMappings = [];
            f.state.volumes[0]!.Tags = tagList(tagsFor(f.i));
        }
        const target = recovery ? recovery.instance() : (f as ReturnType<typeof lifecycleFixture>).instance('i-33333333333333333');
        f.state.instances.push(target); f.attach(f.state.volumes[0]!, target);
    }
    const scope: CancellationScope = { source: { schemaVersion: f.i.schemaVersion, jobId: f.i.jobId, digest: f.digest },
        dataVolumeId: f.i.dataVolumeId, writers: f.state.instances.map(instance => ({ instanceId: instance.InstanceId!,
            generation: Number(instance.Tags!.find(t => t.Key === 'ezil:generation')!.Value), fenceToken: instance.Tags!.find(t => t.Key === 'ezil:fence-token')!.Value!,
            observedState: instance.State!.Name === 'terminated' ? 'stopped' : 'running',
            observedAt: new Date(f.state.now - 200000).toISOString(), fencedAt: instance.State!.Name === 'terminated' ? new Date(f.state.now - 190000).toISOString() : null })) };
    const controls = { authorized: true, sourceMissing: false, historyBad: false, authorityCalls: 0,
        before: undefined as ((kind: string) => void) | undefined };
    const deps: CancellationDependencies = { ...f.deps,
        execution: async id => {
            controls.before?.('execution');
            if (id === arn) return structuredClone(execution);
            if (controls.sourceMissing) throw Object.assign(new Error('missing'), { name: 'ExecutionDoesNotExist' });
            return structuredClone(source);
        },
        cancellationAuthority: async () => { controls.authorityCalls++; controls.before?.('authority'); return controls.authorized ? structuredClone(scope) : null; },
        history: async () => {
            const end = ({ SUCCEEDED: 'ExecutionSucceeded', ABORTED: 'ExecutionAborted', FAILED: 'ExecutionFailed', TIMED_OUT: 'ExecutionTimedOut' } as const)[source.status as 'SUCCEEDED'];
            return [{ type: 'ExecutionStarted' }, ...tasks.map(name => ({ type: 'TaskStateEntered', stateEnteredEventDetails: { name } })),
                ...(controls.historyBad ? [] : [{ type: end }])].map((h, index) => ({ ...h, id: index + 1, timestamp: source.startDate })) as HistoryEvent[];
        } };
    return { ...f, settings, c, digest, arn, execution, source, scope, tasks, controls, deps };
}
export async function simulateCancellation(f = cancellationFixture(), options: { lose?: string; noEffect?: string; after?: (action: string) => void } = {}) {
    const helper = createCancellationHelper(f.settings, f.deps), graph = cancellationDefinition('helper');
    const data: Record<string, any> = {}, calls: { action: string; parameters: any }[] = [];
    let next = graph.StartAt, lost = false;
    const at = (path: string): any => path === '$$.Execution.Id' ? f.arn : path.slice(2).split('.').reduce((v, k) => v?.[k], data);
    for (let n = 0; n < 1500; n++) {
        const s = graph.States[next]; assert.ok(s);
        if (s.Type === 'Fail') return { error: s.Error, calls };
        if (s.Type === 'Pass') return { receipt: at(s.InputPath), calls };
        if (s.Type === 'Choice') { next = s.Choices.find((c: any) => at(c.Variable) === c.StringEquals)?.Next ?? s.Default; continue; }
        if (s.Type === 'Wait') { f.state.now += s.Seconds * 1000; next = s.Next; continue; }
        assert.equal(s.Type, 'Task'); assert.equal(s.Retry, undefined);
        const parameters = Object.fromEntries(Object.entries(s.Parameters as Record<string, any>)
            .map(([key, value]) => [key.endsWith('.$') ? key.slice(0, -2) : key, key.endsWith('.$') ? at(value) : value]));
        try {
            if (s.Resource === 'helper') data.step = await helper(parameters);
            else {
                const action = s.Resource.split(':').at(-1)!; calls.push({ action, parameters });
                assert.ok(f.controls.authorityCalls >= calls.length);
                if (action !== options.noEffect) {
                    if (action === 'stopExecution') { assert.equal(parameters.ExecutionArn, f.executionArn); f.source.status = 'ABORTED'; f.source.stopDate = new Date(f.state.now); }
                    else {
                        const target = f.state.instances.find(i => i.InstanceId === (parameters.InstanceIds?.[0] ?? parameters.InstanceId))!;
                        if (action === 'modifyInstanceAttribute') {
                            assert.equal(parameters.BlockDeviceMappings[0].Ebs.DeleteOnTermination, false);
                            target.BlockDeviceMappings![0]!.Ebs!.DeleteOnTermination = false; f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination = false;
                        } else if (action === 'stopInstances') target.State = { Name: 'stopped' };
                        else if (action === 'terminateInstances') {
                            assert.equal(target.State?.Name, 'stopped');
                            assert.ok(target.BlockDeviceMappings!.every(m => m.DeviceName === '/dev/xvda' || m.Ebs?.DeleteOnTermination === false));
                            target.State = { Name: 'terminated' }; target.BlockDeviceMappings = [];
                            const volume = f.state.volumes[0]!; volume.Attachments = volume.Attachments!.filter(a => a.InstanceId !== target.InstanceId);
                            if (!volume.Attachments.length) volume.State = 'available';
                        } else assert.fail('forbidden cancellation mutation');
                    }
                }
                options.after?.(action);
                if (action === options.lose && !lost) { lost = true; throw new Error('lost response'); }
            }
            next = s.Next;
        } catch { next = s.Catch[0].Next; }
    }
    throw new Error('unbounded cancellation');
}
