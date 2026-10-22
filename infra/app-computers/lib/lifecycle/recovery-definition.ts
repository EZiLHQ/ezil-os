import { imageRecoveryControl, imageRecoveryPhases, recoveryPhases, type RecoveryPhase } from './recovery-contract.js';
import { NO_ERROR } from './errors.js';
import { observationRetry, recordedCause } from './definition.js';

export function recoveryDefinition(helperArn: string, imageEnabled = false) {
    const actions = Object.fromEntries((['old', 'target'] as const).flatMap(role => [
        [`stop-${role}`, { operation: 'stopInstances', fields: ['InstanceIds', 'Force', 'Hibernate', 'SkipOsShutdown'], phase: `${role}-stopped` }],
        [`terminate-${role}`, { operation: 'terminateInstances', fields: ['InstanceIds'], phase: `${role}-terminated` }],
    ])) as Record<string, { operation: string; fields: string[]; phase: RecoveryPhase }>;
    const States: Record<string, any> = {
        Route: { Type: 'Choice', Choices: [{ Variable: '$.schemaVersion', IsPresent: true, Next: 'ImageInit' }], Default: 'Init' },
        Init: { Type: 'Pass', Result: { lastError: NO_ERROR, observeError: NO_ERROR }, ResultPath: '$.ctl', Next: 'Observe-initial' },
        Decide: { Type: 'Choice', Choices: [...Object.keys(actions).map(action => ({ Variable: '$.step.decision', StringEquals: action, Next: action })),
            { Variable: '$.step.decision', StringEquals: 'wait', Next: 'Wait' },
            { Variable: '$.step.decision', StringEquals: 'success', Next: 'Fenced' }], Default: 'Unconfirmed' },
        Wait: { Type: 'Wait', Seconds: 5, Next: 'Resume' },
        Resume: { Type: 'Choice', Choices: recoveryPhases.map(phase => ({ Variable: '$.step.phase', StringEquals: phase, Next: 'Observe-' + phase })), Default: 'Unconfirmed' },
        Fenced: { Type: 'Pass', InputPath: '$.step.receipt', End: true },
        Unconfirmed: { Type: 'Fail', Error: 'LifecycleRecoveryUnconfirmed', CausePath: recordedCause },
    };
    for (const phase of recoveryPhases) States['Observe-' + phase] = { Type: 'Task', Resource: helperArn, TimeoutSeconds: 60,
        Parameters: { 'executionArn.$': '$$.Execution.Id', phase }, ResultPath: '$.step', Next: 'Decide', Retry: observationRetry,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.observeError', Next: 'Unconfirmed' }] };
    for (const [name, action] of Object.entries(actions)) {
        States[name] = { Type: 'Task', Resource: `arn:aws:states:::aws-sdk:ec2:${action.operation}`, TimeoutSeconds: 30,
            Parameters: Object.fromEntries(action.fields.map(key => [key + '.$', '$.step.parameters.' + key])),
            ResultSelector: NO_ERROR, ResultPath: '$.ctl.lastError', Next: 'After-' + name,
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: 'After-' + name }] };
        States['After-' + name] = { Type: 'Wait', Seconds: 5, Next: 'Observe-' + action.phase };
    }
    if (imageEnabled) Object.assign(States, imageRecoveryStates(helperArn));
    else delete States.Route;
    return { Comment: 'Positively fence exact failed lifecycle writers; never launch, modify or delete storage',
        StartAt: imageEnabled ? 'Route' : 'Init', TimeoutSeconds: imageEnabled ? 7200 : 660, States };
}

/** Separate graph branch: cleanup inputs cannot reach a restore task. */
function imageRecoveryStates(helperArn: string): Record<string, any> {
    const actions = {
        'stop-target': { operation: 'stopInstances', fields: ['InstanceIds', 'Force', 'Hibernate', 'SkipOsShutdown'], phase: 'target-stopped' },
        'terminate-target': { operation: 'terminateInstances', fields: ['InstanceIds'], phase: 'target-terminated' },
        createVolume: { operation: 'createVolume', fields: ['SnapshotId', 'AvailabilityZoneId', 'Size', 'VolumeType', 'Iops', 'Throughput', 'Encrypted', 'KmsKeyId', 'ClientToken', 'TagSpecifications'], phase: 'volume' },
    };
    const States: Record<string, any> = {
        ImageInit: { Type: 'Pass', Result: imageRecoveryControl, ResultPath: '$.ctl', Next: 'ImageObserve-initial' },
        ImageDecide: { Type: 'Choice', Choices: [
            ...Object.keys(actions).map(name => ({ Variable: '$.step.decision', StringEquals: name, Next: name === 'createVolume' ? 'ImageCreating' : 'Image-' + name })),
            { Variable: '$.step.decision', StringEquals: 'wait', Next: 'ImageSaveWait' },
            { Variable: '$.step.decision', StringEquals: 'success', Next: 'RestoreReady' },
            { Variable: '$.step.decision', StringEquals: 'unconfirmed', Next: 'RestoreUnconfirmed' },
        ], Default: 'RestoreFailed' },
        ImageSaveWait: { Type: 'Pass', InputPath: '$.step.control', ResultPath: '$.ctl', Next: 'ImageWait' },
        ImageWait: { Type: 'Wait', Seconds: 15, Next: 'ImageResume' },
        ImageResume: { Type: 'Choice', Choices: imageRecoveryPhases.map(phase => ({ Variable: '$.step.phase', StringEquals: phase, Next: 'ImageObserve-' + phase })), Default: 'RestoreObserverFailed' },
        ImageCreating: { Type: 'Pass', Parameters: { 'fencedAt.$': '$.step.control.fencedAt', 'volumeId.$': '$.step.control.volumeId',
            createAttempted: true, lastError: NO_ERROR }, ResultPath: '$.ctl', Next: 'Image-createVolume' },
        ImageCreated: { Type: 'Pass', Parameters: { 'fencedAt.$': '$.ctl.fencedAt', 'volumeId.$': '$.created.VolumeId',
            createAttempted: true, lastError: NO_ERROR }, ResultPath: '$.ctl', Next: 'ImageAfter-createVolume' },
        RestoreReady: { Type: 'Pass', InputPath: '$.step.receipt', End: true },
        RestoreFailed: { Type: 'Fail', Error: 'EbsRestoreFailed', CausePath: '$.step.code' },
        RestoreUnconfirmed: { Type: 'Fail', Error: 'EbsRestoreUnconfirmed', CausePath: '$.step.code' },
        RestoreObserverFailed: { Type: 'Fail', Error: 'EbsRestoreUnconfirmed', Cause: 'restore_failed' },
    };
    for (const phase of imageRecoveryPhases) States['ImageObserve-' + phase] = { Type: 'Task', Resource: helperArn, TimeoutSeconds: 60,
        Parameters: { mode: 'image', 'executionArn.$': '$$.Execution.Id', phase, 'control.$': '$.ctl' }, ResultPath: '$.step', Next: 'ImageDecide', Retry: observationRetry,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: 'RestoreObserverFailed' }] };
    for (const [name, action] of Object.entries(actions)) {
        States['Image-' + name] = { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ec2:' + action.operation, TimeoutSeconds: 30,
            Parameters: Object.fromEntries(action.fields.map(key => [key + '.$', '$.step.parameters.' + key])),
            ...(name === 'createVolume' ? { ResultPath: '$.created', Next: 'ImageCreated' }
                : { ResultSelector: NO_ERROR, ResultPath: '$.ctl.lastError', Next: 'ImageAfter-' + name }),
            Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: '$.ctl.lastError', Next: 'ImageAfter-' + name }] };
        States['ImageAfter-' + name] = { Type: 'Wait', Seconds: 15, Next: 'ImageObserve-' + action.phase };
    }
    return States;
}
