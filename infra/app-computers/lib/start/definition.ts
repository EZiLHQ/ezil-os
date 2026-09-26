/** Direct Standard SSM calls have no Retry. Recovery uses host observation and
 * its persistent cancellation fence, never an invented SSM ClientToken. */
export function startDefinition(helperArn: string, recovery = false) {
    const base = { 'executionArn.$': recovery ? '$.sourceExecutionArn' : '$$.Execution.Id',
        recovery, 'recoveryStartedAt.$': '$$.Execution.StartTime' };
    const helper = (mode: string, fields: Record<string, unknown>, next = 'Decide') => ({
        Type: 'Task', Resource: helperArn, TimeoutSeconds: 35,
        Parameters: { ...base, mode, ...fields }, ResultPath: '$.step', Next: next,
        Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'Unconfirmed' }],
    });
    return { Comment: 'Versioned start delivery; a startup receipt is not application readiness',
        StartAt: 'Initialize', TimeoutSeconds: recovery ? 360 : 660,
        States: {
            Initialize: helper('initialize', {}),
            Decide: { Type: 'Choice', Choices: [
                { Variable: '$.step.decision', StringEquals: 'dispatch', Next: 'Dispatch' },
                { Variable: '$.step.decision', StringEquals: 'wait', Next: 'WaitInvocation' },
                { Variable: '$.step.decision', StringEquals: 'success', Next: recovery ? 'Unconfirmed' : 'Succeeded' },
                { Variable: '$.step.decision', StringEquals: 'cancelled', Next: 'Cancelled' },
            ], Default: 'Unconfirmed' },
            Dispatch: { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:ssm:sendCommand', TimeoutSeconds: 15,
                Parameters: { 'DocumentName.$': '$.step.parameters.DocumentName', 'DocumentVersion.$': '$.step.parameters.DocumentVersion',
                    'DocumentHash.$': '$.step.parameters.DocumentHash', DocumentHashType: 'Sha256',
                    'InstanceIds.$': '$.step.parameters.InstanceIds', 'Parameters.$': '$.step.parameters.Parameters',
                    'Comment.$': '$.step.parameters.Comment', TimeoutSeconds: 30 },
                ResultSelector: { 'id.$': '$.Command.CommandId' }, ResultPath: '$.command', Next: 'WaitInvocation',
                Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'LostResponse' }],
            },
            WaitInvocation: { Type: 'Wait', Seconds: 5, Next: 'Poll' },
            Poll: helper('poll', { 'attempt.$': '$.step.attempt', 'commandId.$': '$.command.id' }),
            LostResponse: { Type: 'Wait', Seconds: 5, Next: 'ObserveLost' },
            ObserveLost: helper('lost', { 'attempt.$': '$.step.attempt' }),
            ...(!recovery ? { Succeeded: { Type: 'Pass', InputPath: '$.step.result', End: true } } : {}),
            Cancelled: recovery ? { Type: 'Pass', Result: { status: 'cancelled' }, End: true }
                : { Type: 'Fail', Error: 'StartCancelled', Cause: 'Host cancellation fence and quiescence observed' },
            Unconfirmed: { Type: 'Fail', Error: 'StartUnconfirmed', Cause: 'Delivery outcome or stop could not be confirmed' },
        },
    };
}
