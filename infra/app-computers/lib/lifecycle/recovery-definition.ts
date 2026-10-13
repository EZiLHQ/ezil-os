import { recoveryPhases, type RecoveryPhase } from './recovery-contract.js';

export function recoveryDefinition(helperArn: string) {
    const actions = Object.fromEntries((['old', 'target'] as const).flatMap(role => [
        [`preserve-${role}`, { operation: 'modifyInstanceAttribute', fields: ['InstanceId', 'BlockDeviceMappings'], phase: `${role}-preserved` }],
        [`stop-${role}`, { operation: 'stopInstances', fields: ['InstanceIds', 'Force', 'Hibernate', 'SkipOsShutdown'], phase: `${role}-stopped` }],
        [`terminate-${role}`, { operation: 'terminateInstances', fields: ['InstanceIds'], phase: `${role}-terminated` }],
    ])) as Record<string, { operation: string; fields: string[]; phase: RecoveryPhase }>;
    const States: Record<string, any> = {
        Decide: { Type: 'Choice', Choices: [...Object.keys(actions).map(action => ({ Variable: '$.step.decision', StringEquals: action, Next: action })),
            { Variable: '$.step.decision', StringEquals: 'wait', Next: 'Wait' },
            { Variable: '$.step.decision', StringEquals: 'success', Next: 'Fenced' }], Default: 'Unconfirmed' },
        Wait: { Type: 'Wait', Seconds: 5, Next: 'Resume' },
        Resume: { Type: 'Choice', Choices: recoveryPhases.map(phase => ({ Variable: '$.step.phase', StringEquals: phase, Next: 'Observe-' + phase })), Default: 'Unconfirmed' },
        Fenced: { Type: 'Pass', InputPath: '$.step.receipt', End: true },
        Unconfirmed: { Type: 'Fail', Error: 'LifecycleRecoveryUnconfirmed', Cause: 'Keep admission reserved; original resources require reconciliation' },
    };
    for (const phase of recoveryPhases) States['Observe-' + phase] = { Type: 'Task', Resource: helperArn, TimeoutSeconds: 60,
        Parameters: { 'executionArn.$': '$$.Execution.Id', phase }, ResultPath: '$.step', Next: 'Decide',
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'Unconfirmed' }] };
    for (const [name, action] of Object.entries(actions)) {
        States[name] = { Type: 'Task', Resource: `arn:aws:states:::aws-sdk:ec2:${action.operation}`, TimeoutSeconds: 30,
            Parameters: Object.fromEntries(action.fields.map(key => [key + '.$', '$.step.parameters.' + key])),
            ResultPath: null, Next: 'After-' + name, Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'After-' + name }] };
        States['After-' + name] = { Type: 'Wait', Seconds: 5, Next: 'Observe-' + action.phase };
    }
    return { Comment: 'Preserve disk and positively fence exact failed lifecycle writers; never launch or delete storage',
        StartAt: 'Observe-initial', TimeoutSeconds: 660, States };
}
