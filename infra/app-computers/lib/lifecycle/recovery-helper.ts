import { z } from 'zod';
import { EnvelopeSchema, equal, writerProfile } from './contract.js';
import { parseComputerLifecycleWork } from './computer-recovery.js';
import { planLifecycleFencing } from './fencing-plan.js';
import { RecoveryInputSchema, RecoverySettingsSchema, machineArn, recoveryPhases,
    type RecoverySettings } from './recovery-contract.js';
import { recoveryDependencies, type RecoveryDependencies } from './recovery-aws.js';

const Event = z.object({ executionArn: z.string().max(300), phase: z.enum(recoveryPhases) }).strict();
const fail = (): never => { throw new Error('lifecycle_recovery_unconfirmed'); };
const terminal = ['FAILED', 'ABORTED', 'TIMED_OUT'];

/** Recovery can preserve/stop/terminate only exact historical writers. It has
 * no launch, attach, retag, detach, delete or current-authority capability. */
export function createRecoveryHelper(settings: RecoverySettings, deps: RecoveryDependencies) {
    return async (input: unknown): Promise<Record<string, unknown>> => {
        const e = Event.parse(input), d = settings.lifecycle.deployment;
        const recoveryMachine = machineArn(settings.recoveryVersionArn), sourceMachine = machineArn(d.stateMachineVersionArn);
        if (!e.executionArn.startsWith(recoveryMachine.replace(':stateMachine:', ':execution:') + ':cleanup-computer-')) return fail();
        const execution = await deps.execution(e.executionArn), now = deps.now();
        if (execution.executionArn !== e.executionArn || execution.stateMachineArn !== recoveryMachine
            || execution.stateMachineVersionArn !== settings.recoveryVersionArn || execution.stateMachineAliasArn
            || execution.redriveCount !== 0 || execution.status !== 'RUNNING' || !execution.startDate || !execution.input
            || Buffer.byteLength(execution.input) > 1024) return fail();
        const began = execution.startDate.getTime();
        if (!Number.isFinite(began) || began > now || now - began >= 600000) return fail();
        const { sourceExecutionArn } = RecoveryInputSchema.parse(JSON.parse(execution.input));
        if (!sourceExecutionArn.startsWith(sourceMachine.replace(':stateMachine:', ':execution:') + ':computer-')) return fail();
        const source = await deps.execution(sourceExecutionArn);
        if (source.executionArn !== sourceExecutionArn || source.stateMachineArn !== sourceMachine
            || source.stateMachineVersionArn !== d.stateMachineVersionArn || source.stateMachineAliasArn || source.redriveCount !== 0
            || !terminal.includes(source.status ?? '') || !source.input || Buffer.byteLength(source.input) > 20000
            || !source.startDate || !source.stopDate || !Number.isFinite(source.stopDate.getTime())
            || source.stopDate.getTime() > began || source.stopDate.getTime() < source.startDate.getTime()
            || now - source.startDate.getTime() > 86400000) return fail();
        const envelope = EnvelopeSchema.parse(JSON.parse(source.input));
        const i = parseComputerLifecycleWork({ ...envelope, createdAt: source.startDate });
        if (envelope.schemaVersion !== i.schemaVersion) return fail();
        const { instanceProfileArn, ...pins } = i.deployment;
        if (!equal(pins, d) || instanceProfileArn !== writerProfile(settings.lifecycle, i)
            || source.name !== `computer-${i.jobId}` || sourceExecutionArn !== sourceMachine.replace(':stateMachine:', ':execution:') + ':' + source.name
            || execution.name !== `cleanup-computer-${i.jobId}`
            || e.executionArn !== recoveryMachine.replace(':stateMachine:', ':execution:') + ':' + execution.name) return fail();
        return planLifecycleFencing({ deps, source, sourceExecutionArn, envelope, i, began, phase: e.phase,
            confirmScope: async () => {} });
    };
}

let helper: ReturnType<typeof createRecoveryHelper> | undefined;
export async function handler(input: unknown) {
    try {
        if (!helper) { const settings = RecoverySettingsSchema.parse(JSON.parse(process.env.EZIL_LIFECYCLE_RECOVERY_SETTINGS ?? ''));
            helper = createRecoveryHelper(settings, recoveryDependencies(settings)); }
        return await helper(input);
    } catch { return fail(); }
}
