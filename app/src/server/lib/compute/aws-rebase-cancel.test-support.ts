import type { HistoryEvent } from '@aws-sdk/client-sfn';
import type { Execution } from './aws-rebase-evidence';

export type Step = Omit<HistoryEvent, 'id' | 'timestamp' | 'previousEventId'>;
export const entered = (type: string, name: string): Step => ({ type: type as HistoryEvent['type'], stateEnteredEventDetails: { name } });
export const exited = (type: string, name: string): Step => ({ type: type as HistoryEvent['type'], stateExitedEventDetails: { name } });
/** The real preparation machine's events when Observe-initial answers `failed`. */
export function refusedAtFirstObservation(e: Pick<Execution, 'input'>, code: string): Step[] {
    return [
        { type: 'ExecutionStarted', executionStartedEventDetails: { input: e.input ?? undefined } },
        entered('PassStateEntered', 'Init'), exited('PassStateExited', 'Init'),
        entered('TaskStateEntered', 'Observe-initial'),
        { type: 'LambdaFunctionScheduled', lambdaFunctionScheduledEventDetails: { resource: 'arn:aws:lambda:ap-south-1:123456789012:function:observer:3' } },
        { type: 'LambdaFunctionStarted' },
        { type: 'LambdaFunctionSucceeded', lambdaFunctionSucceededEventDetails: { output: JSON.stringify({ decision: 'failed', code }) } },
        exited('TaskStateExited', 'Observe-initial'),
        entered('ChoiceStateEntered', 'CheckResult'), exited('ChoiceStateExited', 'CheckResult'),
        entered('FailStateEntered', 'Failed'),
        { type: 'ExecutionFailed', executionFailedEventDetails: { error: 'RebasePreparationFailed', cause: code } },
    ];
}
export const numbered = (steps: Step[], start: Date): HistoryEvent[] =>
    steps.map((s, i) => ({ ...s, id: i + 1, previousEventId: i, timestamp: new Date(start.getTime() + i * 100) }));
