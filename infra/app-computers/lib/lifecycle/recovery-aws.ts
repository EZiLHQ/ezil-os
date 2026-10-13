import { SFNClient, GetExecutionHistoryCommand, type HistoryEvent } from '@aws-sdk/client-sfn';
import { awsDependencies, type Dependencies } from './aws.js';
import type { RecoverySettings } from './recovery-contract.js';

export interface RecoveryDependencies extends Pick<Dependencies, 'execution' | 'instances' | 'volumes' | 'now'> {
    history(arn: string): Promise<HistoryEvent[]>;
}
export function recoveryDependencies(settings: RecoverySettings): RecoveryDependencies {
    const reads = awsDependencies(settings.lifecycle);
    const client = new SFNClient({ region: 'us-east-1', maxAttempts: 1,
        endpoint: 'https://states.us-east-1.amazonaws.com',
        requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } });
    return { ...reads, history: arn => readRecoveryHistory(client, arn) };
}

/** Complete terminal history is needed to prove an allocation never ran.
 * A missing page or truncated scan is uncertainty, never absence of effects. */
export async function readRecoveryHistory(client: Pick<SFNClient, 'send'>, arn: string): Promise<HistoryEvent[]> {
    const events: HistoryEvent[] = [];
    let nextToken: string | undefined;
    for (let page = 0; page < 4; page++) {
        const result = await client.send(new GetExecutionHistoryCommand({ executionArn: arn,
            includeExecutionData: false, reverseOrder: false, maxResults: 1000, nextToken }),
        { abortSignal: AbortSignal.timeout(6000) });
        events.push(...result.events ?? []);
        nextToken = result.nextToken;
        if (!nextToken) return events;
    }
    throw new Error('lifecycle_recovery_history_incomplete');
}
