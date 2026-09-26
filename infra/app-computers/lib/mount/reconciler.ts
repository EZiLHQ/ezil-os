import { SFNClient, DescribeExecutionCommand, ListExecutionsCommand, StartExecutionCommand } from '@aws-sdk/client-sfn';
import { canonical } from './contract.js';

export interface ReconcilerSettings { machineArn: string; recoveryVersionArn: string }
/** EventBridge events are hints, not authority. Both event delivery and the
 * scheduled backstop re-read Standard history. Recovery never resends start. */
export function createMountReconciler(settings: ReconcilerSettings, client: Pick<SFNClient, 'send'>, now = Date.now) {
    return async (input: unknown) => {
        try {
            const prefix = settings.machineArn.replace(':stateMachine:', ':execution:') + ':';
            const reconcile = async (arn: string) => {
                if (!arn.startsWith(prefix)) throw new Error();
                const e = await client.send(new DescribeExecutionCommand({ executionArn: arn }), { abortSignal: AbortSignal.timeout(6000) });
                if (e.executionArn !== arn || e.stateMachineArn !== settings.machineArn || !e.startDate
                    || !['FAILED', 'ABORTED', 'TIMED_OUT'].includes(e.status ?? '') || now() - e.startDate.getTime() > 86400000) return;
                if (!/^mount-[a-f0-9-]{36}$/.test(e.name ?? '') || arn !== prefix + e.name) throw new Error();
                // Stable cleanup name; duplicate event/scheduled deliveries do
                // not create more executions, including after terminal failure.
                try { await client.send(new StartExecutionCommand({ stateMachineArn: settings.recoveryVersionArn,
                    name: `cleanup-${e.name}`, input: canonical({ sourceExecutionArn: arn }) }), { abortSignal: AbortSignal.timeout(6000) }); }
                catch (error) { if (!(error instanceof Error && error.name === 'ExecutionAlreadyExists')) throw error; }
            };
            if (input && typeof input === 'object' && 'source' in input && input.source === 'aws.states') {
                const detail = (input as { detail?: { executionArn?: unknown; stateMachineArn?: unknown } }).detail;
                if (detail?.stateMachineArn !== settings.machineArn || typeof detail.executionArn !== 'string') throw new Error();
                await reconcile(detail.executionArn);
            } else {
                if (!input || typeof input !== 'object' || !('source' in input) || input.source !== 'aws.events'
                    || !('detail-type' in input) || input['detail-type'] !== 'Scheduled Event') throw new Error();
                for (const status of ['FAILED', 'TIMED_OUT', 'ABORTED'] as const) {
                    let nextToken: string | undefined;
                    for (let page = 0; page < 10; page++) {
                        const values = await client.send(new ListExecutionsCommand({ stateMachineArn: settings.machineArn,
                            statusFilter: status, maxResults: 100, nextToken }), { abortSignal: AbortSignal.timeout(6000) });
                        let old = false;
                        for (const e of values.executions ?? []) {
                            if (!e.executionArn || !e.startDate) throw new Error();
                            if (now() - e.startDate.getTime() > 86400000) { old = true; break; }
                            await reconcile(e.executionArn);
                        }
                        nextToken = values.nextToken;
                        if (!nextToken || old) break;
                        if (page === 9) throw new Error(); // bounded scan exhaustion is visible
                    }
                }
            }
            return { status: 'reconciliation_requested' };
        } catch { throw new Error('mount_reconciliation_unavailable'); }
    };
}
let run: ReturnType<typeof createMountReconciler> | undefined;
export const handler = (event: unknown) => {
    if (!run) {
        const machineArn = process.env.EZIL_MOUNT_MACHINE_ARN ?? '', recoveryVersionArn = process.env.EZIL_MOUNT_RECOVERY_VERSION_ARN ?? '';
        if (!/^arn:aws:states:us-east-1:\d{12}:stateMachine:[A-Za-z0-9_-]+$/.test(machineArn)
            || !/^arn:aws:states:us-east-1:\d{12}:stateMachine:[A-Za-z0-9_-]+:[1-9]\d*$/.test(recoveryVersionArn)) {
            throw new Error('mount_reconciliation_unavailable');
        }
        run = createMountReconciler({ machineArn, recoveryVersionArn }, new SFNClient({ region: 'us-east-1', maxAttempts: 1,
            endpoint: 'https://states.us-east-1.amazonaws.com',
            requestHandler: { connectionTimeout: 2000, requestTimeout: 5000, throwOnRequestTimeout: true } }));
    }
    return run(event);
};
