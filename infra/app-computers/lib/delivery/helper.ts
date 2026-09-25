import { z } from 'zod';
import { awsDependencies, type Dependencies } from './aws.js';
import { canonical, equal, hostObservation, hostOperation, parseDelivery, resultFor, SettingsSchema,
    type Delivery, type HostAction, type Settings } from './contract.js';

const commandId = z.string().uuid();
const Attempt = z.object({ action: z.enum(['start', 'observe', 'cancel']),
    issuedAt: z.number().int().positive(), cancelling: z.boolean(),
}).strict();
const Event = z.object({ mode: z.enum(['initialize', 'poll', 'lost', 'next']), executionArn: z.string().max(256),
    recovery: z.boolean(), recoveryStartedAt: z.string().datetime(),
    attempt: Attempt.optional(), commandId: commandId.optional(),
}).strict();
type Attempt = z.infer<typeof Attempt>;
export type HelperEvent = z.infer<typeof Event>;
export type Decision = { decision: 'wait'; attempt: Attempt } | { decision: 'unconfirmed' | 'cancelled' }
    | { decision: 'success'; result: ReturnType<typeof resultFor> }
    | { decision: 'dispatch'; attempt: Attempt; parameters: ReturnType<typeof commandParameters> };
const RUN_MS = 15 * 60000, CLEANUP_MS = 5 * 60000;

export function commandParameters(settings: Settings, delivery: Delivery, action: HostAction, deadline: number) {
    return { DocumentName: settings.documentName, DocumentVersion: settings.documentVersion,
        DocumentHash: settings.documentHash, DocumentHashType: 'Sha256',
        InstanceIds: [delivery.scope.providerInstanceId],
        Parameters: { Operation: [hostOperation(delivery, action, deadline)] },
        TimeoutSeconds: 30, Comment: `ezil-${delivery.operation}-${delivery.configurationId}-${action}`,
    };
}

/** Reconstruct authority from the original, version-pinned Standard execution,
 * never caller-provided instance IDs or a cached approval. Recovery can only
 * cancel/observe historical work, including after current grants are revoked. */
export function createDeliveryHelper(settings: Settings, deps: Dependencies) {
    async function execute(input: unknown): Promise<Decision> {
        const parsed = Event.safeParse(input); if (!parsed.success) throw new Error('invalid_workflow_request');
        const event = parsed.data, now = deps.now();
        const prefix = settings.machineArn.replace(':stateMachine:', ':execution:') + ':configuration-';
        if (!event.executionArn.startsWith(prefix)) throw new Error('invalid_workflow_execution');
        const execution = await deps.execution(event.executionArn);
        if (execution.executionArn !== event.executionArn || execution.stateMachineArn !== settings.machineArn
            || execution.stateMachineVersionArn !== `${settings.machineArn}:${settings.workflowVersion}`
            || execution.stateMachineAliasArn || !execution.startDate || !execution.input
            || Buffer.byteLength(execution.input) > 8192) throw new Error('invalid_workflow_execution');
        const started = execution.startDate.getTime(), deadline = started + RUN_MS;
        if (!Number.isFinite(started) || started > now || now - started > 86400000) throw new Error('invalid_workflow_execution');
        if (event.recovery ? !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(execution.status ?? '')
            : execution.status !== 'RUNNING' || execution.redriveCount !== 0) throw new Error('invalid_workflow_execution');
        const delivery = parseDelivery(JSON.parse(execution.input), settings);
        if (execution.input !== canonical(delivery) || execution.name !== `configuration-${delivery.operation}-${delivery.configurationId}`
            || event.executionArn !== prefix + `${delivery.operation}-${delivery.configurationId}`) throw new Error('invalid_workflow_execution');
        const recoveryStarted = Date.parse(event.recoveryStartedAt);
        const stopAt = event.recovery ? recoveryStarted + CLEANUP_MS : deadline + CLEANUP_MS;
        if (recoveryStarted > now || recoveryStarted < started || now >= stopAt) return { decision: 'unconfirmed' };
        // Exact original writer is required even for cancellation. Replaced,
        // stopped or uncertain writers need lifecycle reconciliation, not a
        // command redirected onto the new instance or a claimed cancellation.
        if (!await deps.writer(delivery)) return { decision: 'unconfirmed' };
        let cancelling = event.recovery || event.attempt?.cancelling === true || now >= deadline;
        if (!cancelling) {
            try { cancelling = !await deps.authority(delivery); }
            catch { cancelling = true; } // loss of authority is not permission to keep preparing
        }
        const dispatch = (action: HostAction): Decision => ({ decision: 'dispatch',
            attempt: { action, issuedAt: now, cancelling }, parameters: commandParameters(settings, delivery, action, deadline) });
        if (event.mode === 'initialize') return dispatch(cancelling ? 'cancel' : 'start');
        const attempt = event.attempt;
        if (!attempt || attempt.issuedAt < started || attempt.issuedAt > now || (attempt.action === 'start' && event.recovery)) {
            throw new Error('invalid_workflow_request');
        }
        if (cancelling && !attempt.cancelling) return dispatch('cancel');
        if (event.mode !== 'poll') return dispatch(cancelling ? 'cancel' : 'observe');
        if (!event.commandId) throw new Error('invalid_workflow_request');
        // SSM eventual visibility and lost response: no second start. A fresh
        // observe/cancel operation addresses the same persisted host identity.
        const uncertain = () => now - attempt.issuedAt < 60000
            ? { decision: 'wait' as const, attempt } : dispatch(cancelling ? 'cancel' : 'observe');
        const command = await deps.command(event.commandId);
        if (!command) return uncertain();
        const expected = commandParameters(settings, delivery, attempt.action, deadline);
        if (command.CommandId !== event.commandId || command.DocumentName !== expected.DocumentName
            || command.DocumentVersion !== expected.DocumentVersion || !equal(command.InstanceIds, expected.InstanceIds)
            || (command.Targets?.length ?? 0) !== 0 || !equal(command.Parameters, expected.Parameters)
            || command.Comment !== expected.Comment || !command.RequestedDateTime
            || command.RequestedDateTime.getTime() < attempt.issuedAt - 5000
            || command.RequestedDateTime.getTime() > now + 5000) throw new Error('invalid_command_binding');
        const invocation = await deps.invocation(event.commandId, delivery.scope.providerInstanceId);
        if (!invocation) return uncertain();
        if (invocation.CommandId !== event.commandId || invocation.InstanceId !== delivery.scope.providerInstanceId
            || invocation.DocumentName !== expected.DocumentName || invocation.DocumentVersion !== expected.DocumentVersion
            || invocation.PluginName !== 'operateConfiguration') throw new Error('invalid_command_binding');
        if (['Pending', 'InProgress', 'Delayed'].includes(invocation.Status ?? '')) return uncertain();
        if (invocation.Status !== 'Success' || invocation.ResponseCode !== 0 || !invocation.StandardOutputContent) {
            cancelling = true; return dispatch('cancel');
        }
        const status = hostObservation(invocation.StandardOutputContent, delivery);
        if (status === 'cancelled') return { decision: 'cancelled' };
        if (cancelling) return dispatch('cancel');
        if (status === 'succeeded') {
            // The receipt still is not a loaded-supervisor receipt. Recheck
            // after potentially slow SSM calls before emitting this narrower result.
            if (!await deps.writer(delivery) || !await deps.authority(delivery)) { cancelling = true; return dispatch('cancel'); }
            return { decision: 'success', result: resultFor(delivery) };
        }
        if (status === 'failed' || status === 'cancelling') { cancelling = true; return dispatch('cancel'); }
        return dispatch('observe');
    }
    // Never leak AWS response bodies, secret values, configuration or paths to
    // execution history. Any unexpected error enters bounded cancellation.
    return async (input: unknown): Promise<Decision> => {
        try { return await execute(input); } catch { throw new Error('configuration_workflow_unavailable'); }
    };
}

let initialized: ReturnType<typeof createDeliveryHelper> | undefined;
export const handler = (input: unknown) => {
    if (!initialized) {
        try { const settings = SettingsSchema.parse(JSON.parse(process.env.EZIL_DELIVERY_SETTINGS ?? ''));
            initialized = createDeliveryHelper(settings, awsDependencies(settings)); }
        catch { throw new Error('configuration_workflow_unavailable'); }
    }
    return initialized(input);
};
