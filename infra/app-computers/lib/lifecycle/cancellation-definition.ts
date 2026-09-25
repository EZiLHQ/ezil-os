import { cancellationPhases } from './cancellation-contract.js';
import { recoveryDefinition } from './recovery-definition.js';

export function cancellationDefinition(helperArn: string) {
    const graph = recoveryDefinition(helperArn), states = graph.States;
    graph.Comment = 'Explicit current cancellation: interrupt exact source, preserve disk, positively fence exact writers';
    states.Decide.Choices.unshift({ Variable: '$.step.decision', StringEquals: 'interrupt-source', Next: 'InterruptSource' });
    states.InterruptSource = { Type: 'Task', Resource: 'arn:aws:states:::aws-sdk:sfn:stopExecution', TimeoutSeconds: 30,
        Parameters: { 'ExecutionArn.$': '$.step.parameters.ExecutionArn', 'Error.$': '$.step.parameters.Error', 'Cause.$': '$.step.parameters.Cause' },
        ResultPath: null, Next: 'AfterInterrupt', Catch: [{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'AfterInterrupt' }] };
    states.AfterInterrupt = { Type: 'Wait', Seconds: 5, Next: 'Observe-source-interrupted' };
    states['Observe-source-interrupted'] = { ...states['Observe-initial'], Parameters: { 'executionArn.$': '$$.Execution.Id', phase: 'source-interrupted' } };
    states.Resume.Choices = cancellationPhases.map(phase => ({ Variable: '$.step.phase', StringEquals: phase, Next: 'Observe-' + phase }));
    states.Unconfirmed.Error = 'ComputerCancellationUnconfirmed';
    return graph;
}
