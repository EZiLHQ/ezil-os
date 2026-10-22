import { observationRetry } from './definition.js';
import { NO_ERROR } from './errors.js';
import { REBASE_PREPARATION_TIMEOUT_SECONDS } from './preparation-contract.js';
import { preparationControl, preparationPhases } from './preparation-helper.js';

/** Every mutation is a fixed SDK task. A lost CreateSnapshot result reaches
 * reconciliation with createAttempted=true; no Task retry can duplicate it. */
export function preparationDefinition(observerVersionArn: string) {
    const States: Record<string, any> = {
        Init: { Type: 'Pass', Result: preparationControl, ResultPath: '$.ctl', Next: 'Observe-initial' },
        CheckResult: { Type: 'Choice', Choices: [
            { Variable: '$.step.decision', StringEquals: 'failed', Next: 'Failed' },
            { Variable: '$.step.decision', StringEquals: 'unconfirmed', Next: 'Unconfirmed' },
        ], Default: 'PersistControl' },
        PersistControl: { Type: 'Pass', Parameters: Object.fromEntries(Object.keys(preparationControl).map(k => [k + '.$', '$.step.control.' + k])), ResultPath: '$.ctl', Next: 'Decide' },
        Decide: { Type: 'Choice', Choices: ['stopInstances', 'terminateInstances', 'createSnapshot'].map(name => ({ Variable: '$.step.decision', StringEquals: name, Next: name })).concat([
            { Variable: '$.step.decision', StringEquals: 'wait', Next: 'Wait' },
            { Variable: '$.step.decision', StringEquals: 'success', Next: 'Succeeded' },
        ]), Default: 'ObserverUnconfirmed' },
        Wait: { Type: 'Wait', Seconds: 15, Next: 'Resume' },
        Resume: { Type: 'Choice', Choices: preparationPhases.map(phase => ({ Variable: '$.step.phase', StringEquals: phase, Next: 'Observe-' + phase })), Default: 'ObserverUnconfirmed' },
        Succeeded: { Type: 'Pass', InputPath: '$.step.receipt', End: true },
        Failed: { Type: 'Fail', Error: 'RebasePreparationFailed', CausePath: '$.step.code' },
        Unconfirmed: { Type: 'Fail', Error: 'RebasePreparationUnconfirmed', CausePath: '$.step.code' },
        ObserverUnconfirmed: { Type: 'Fail', Error: 'RebasePreparationUnconfirmed', Cause: 'preparation_failed' },
    };
    for (const phase of preparationPhases) States['Observe-' + phase] = { Type: 'Task', Resource: observerVersionArn, TimeoutSeconds: 60,
        Parameters: { 'executionArn.$': '$$.Execution.Id', phase, 'control.$': '$.ctl' }, ResultPath: '$.step', Next: 'CheckResult',
        Retry: observationRetry, Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.observeError', Next: 'ObserverUnconfirmed' }] };
    for (const [name, phase, keys] of [
        ['stopInstances', 'stopped', ['InstanceIds', 'Force', 'Hibernate', 'SkipOsShutdown']],
        ['terminateInstances', 'terminated', ['InstanceIds']],
    ] as const) {
        States[name] = { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ec2:' + name, TimeoutSeconds: 30,
            Parameters: Object.fromEntries(keys.map(k => [k + '.$', '$.step.parameters.' + k])), ResultSelector: NO_ERROR,
            ResultPath: '$.ctl.lastError', Next: 'After-' + name,
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: 'After-' + name }] };
        States['After-' + name] = { Type: 'Wait', Seconds: 15, Next: 'Observe-' + phase };
    }
    States.createSnapshot = { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ec2:createSnapshot', TimeoutSeconds: 30,
        Parameters: Object.fromEntries(['VolumeId', 'Description', 'TagSpecifications'].map(k => [k + '.$', '$.step.parameters.' + k])),
        ResultSelector: { 'snapshotId.$': '$.SnapshotId' }, ResultPath: '$.snapshotResult', Next: 'PersistSnapshot',
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: 'SnapshotUncertain' }] };
    const control = { 'fencedAt.$': '$.ctl.fencedAt', snapshotCompletedAt: null, createAttempted: true };
    States.PersistSnapshot = { Type: 'Pass', Parameters: { ...control, 'snapshotId.$': '$.snapshotResult.snapshotId', lastError: NO_ERROR }, ResultPath: '$.ctl', Next: 'PollSnapshot' };
    States.SnapshotUncertain = { Type: 'Pass', Parameters: { ...control, snapshotId: null, 'lastError.$': '$.ctl.lastError' }, ResultPath: '$.ctl', Next: 'PollSnapshot' };
    States.PollSnapshot = { Type: 'Wait', Seconds: 15, Next: 'Observe-snapshot' };
    return { Comment: 'Reserved, positively fenced pre-rebase snapshot; observers never mutate EC2', StartAt: 'Init',
        TimeoutSeconds: REBASE_PREPARATION_TIMEOUT_SECONDS, States };
}
