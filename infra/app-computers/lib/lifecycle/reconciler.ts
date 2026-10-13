import { SFNClient, DescribeExecutionCommand, ListExecutionsCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { canonical } from './contract.js';
import { RecoverySettingsSchema, machineArn, type RecoverySettings } from './recovery-contract.js';

/** Events are hints. Duplicate notifications and the scheduled backstop use a
 * single deterministic recovery execution for each original numeric version. */
export function createLifecycleReconciler(settings: RecoverySettings, client: Pick<SFNClient, 'send'>, now = Date.now) {
    const originalVersion = settings.lifecycle.deployment.stateMachineVersionArn, machine = machineArn(originalVersion);
    return async (input: unknown) => {
        try {
            const prefix = machine.replace(':stateMachine:', ':execution:') + ':computer-';
            const reconcile = async (arn: string) => {
                if (!arn.startsWith(prefix)) throw new Error();
                const source = await client.send(new DescribeExecutionCommand({ executionArn: arn }), { abortSignal: AbortSignal.timeout(6000) });
                if (source.executionArn !== arn || source.stateMachineArn !== machine || source.stateMachineVersionArn !== originalVersion
                    || source.stateMachineAliasArn || source.redriveCount !== 0) throw new Error();
                if (!source.startDate || !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(source.status ?? '')
                    || now() - source.startDate.getTime() > 86400000) return;
                if (!/^computer-[a-f0-9-]{36}$/.test(source.name ?? '') || arn !== prefix + source.name!.slice('computer-'.length)) throw new Error();
                try {
                    await client.send(new StartExecutionCommand({ stateMachineArn: settings.recoveryVersionArn,
                        name: `cleanup-${source.name}`, input: canonical({ sourceExecutionArn: arn }) }), { abortSignal: AbortSignal.timeout(6000) });
                } catch (error) { if (!(error instanceof Error && error.name === 'ExecutionAlreadyExists')) throw error; }
            };
            const event = input as { source?: unknown; 'detail-type'?: unknown; detail?: { stateMachineArn?: unknown; executionArn?: unknown } } | null;
            if (event?.source === 'aws.states') {
                if (event.detail?.stateMachineArn !== machine || typeof event.detail.executionArn !== 'string') throw new Error();
                await reconcile(event.detail.executionArn);
            } else {
                if (event?.source !== 'aws.events' || event['detail-type'] !== 'Scheduled Event') throw new Error();
                for (const status of ['FAILED', 'TIMED_OUT', 'ABORTED'] as const) {
                    let nextToken: string | undefined;
                    for (let page = 0; page < 10; page++) {
                        const result = await client.send(new ListExecutionsCommand({ stateMachineArn: originalVersion,
                            statusFilter: status, maxResults: 100, nextToken }), { abortSignal: AbortSignal.timeout(6000) });
                        let old = false;
                        for (const e of result.executions ?? []) {
                            if (!e.executionArn || !e.startDate) throw new Error();
                            if (now() - e.startDate.getTime() > 86400000) { old = true; break; }
                            await reconcile(e.executionArn);
                        }
                        nextToken = result.nextToken;
                        if (!nextToken || old) break;
                        if (page === 9) throw new Error();
                    }
                }
            }
            return { status: 'recovery_requested' };
        } catch { throw new Error('lifecycle_reconciliation_unavailable'); }
    };
}
let run: ReturnType<typeof createLifecycleReconciler> | undefined;
export async function handler(input: unknown) {
    try {
        if (!run) {
            const settings = RecoverySettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_RECOVERY_SETTINGS ?? ''));
            run = createLifecycleReconciler(settings, new SFNClient({ region: 'us-east-1', maxAttempts: 1,
                endpoint: 'https://states.us-east-1.amazonaws.com',
                requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } }));
        }
        return await run(input);
    } catch { throw new Error('lifecycle_reconciliation_unavailable'); }
}
