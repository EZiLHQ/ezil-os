import { z } from 'zod';
import type { DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import { equal, tagsFor, writerProfile } from './contract.js';
import { tagged } from './helper.js';
import { machineArn, type RecoveryPhase } from './recovery-contract.js';
import { planLifecycleFencing, type FencingTarget } from './fencing-plan.js';
import { CancellationSettingsSchema, CancellationScopeSchema, cancellationPhases, parseCancellationInput, type CancellationSettings } from './cancellation-contract.js';
import { cancellationDependencies, type CancellationDependencies } from './cancellation-aws.js';

const Event = z.object({ executionArn: z.string().max(300), phase: z.enum(cancellationPhases) }).strict();
const fail = (): never => { throw new Error('computer_cancellation_unconfirmed'); };
const millis = (d?: Date) => d instanceof Date && Number.isFinite(d.getTime()) ? d.getTime() : NaN;

/** A pending explicit cancellation is the authority for every decision. Loss of
 * normal launch authority alone never grants permission to terminate writers. */
export function createCancellationHelper(settings: CancellationSettings, deps: CancellationDependencies) {
    return async (input: unknown): Promise<Record<string, unknown>> => {
        const event = Event.parse(input), d = settings.lifecycle.deployment;
        const machine = machineArn(settings.cancellationVersionArn), sourceMachine = machineArn(d.stateMachineVersionArn);
        if (!event.executionArn.startsWith(machine.replace(':stateMachine:', ':execution:') + ':cancel-computer-')) return fail();
        const execution = await deps.execution(event.executionArn), began = millis(execution.startDate), now = deps.now();
        if (execution.executionArn !== event.executionArn || execution.stateMachineArn !== machine
            || execution.stateMachineVersionArn !== settings.cancellationVersionArn || execution.stateMachineAliasArn
            || execution.redriveCount !== 0 || execution.status !== 'RUNNING' || !Number.isFinite(began)
            || began > now || now - began >= 600000 || !execution.input || Buffer.byteLength(execution.input) > 26000) return fail();
        const { envelope, cancellation: c, intent: i } = parseCancellationInput(JSON.parse(execution.input), execution.startDate!);
        const { instanceProfileArn, ...pins } = i.deployment, name = `cancel-computer-${c.cancellationId}`;
        if (!equal(pins, d) || instanceProfileArn !== writerProfile(settings.lifecycle, i) || c.workflowVersionArn !== settings.cancellationVersionArn
            || execution.name !== name || event.executionArn !== machine.replace(':stateMachine:', ':execution:') + ':' + name) return fail();
        const scope = CancellationScopeSchema.parse(await deps.cancellationAuthority(c, envelope.digest));
        if (!equal(scope.source, { schemaVersion: i.schemaVersion, jobId: i.jobId, digest: envelope.source.digest })
            || (i.dataVolumeId && scope.dataVolumeId !== i.dataVolumeId)
            || scope.writers.some(w => w.generation > i.targetGeneration || (w.generation === i.targetGeneration && w.fenceToken !== i.fenceToken))) return fail();
        const sourceName = `computer-${i.jobId}`, sourceExecutionArn = sourceMachine.replace(':stateMachine:', ':execution:') + ':' + sourceName;
        const wait = () => { if (deps.now() - began >= 600000) return fail(); return { decision: 'wait', phase: event.phase }; };
        let source: DescribeExecutionOutput;
        try { source = await deps.execution(sourceExecutionArn); }
        catch (error) { if (error instanceof Error && error.name === 'ExecutionDoesNotExist') return wait(); throw error; }
        if (source.executionArn !== sourceExecutionArn || source.stateMachineArn !== sourceMachine || source.stateMachineVersionArn !== d.stateMachineVersionArn
            || source.stateMachineAliasArn || source.redriveCount !== 0 || source.name !== sourceName
            || source.input !== JSON.stringify(envelope.source) || !Number.isFinite(millis(source.startDate))
            || millis(source.startDate) > deps.now() || deps.now() - millis(source.startDate) > 7 * 86400000) return fail();
        const confirmAuthority = async () => {
            if (!equal(scope, await deps.cancellationAuthority(c, envelope.digest)) || deps.now() - began >= 570000) return fail();
        };
        if (source.status === 'RUNNING') {
            if (event.phase !== 'initial') return wait();
            await confirmAuthority();
            return { decision: 'interrupt-source', parameters: { ExecutionArn: sourceExecutionArn,
                Error: 'ComputerCancellationRequested', Cause: 'Explicit computer cancellation' } };
        }
        if (!['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED_OUT'].includes(source.status ?? '') || !Number.isFinite(millis(source.stopDate))
            || millis(source.stopDate) < millis(source.startDate) || millis(source.stopDate) > deps.now()) return fail();
        const confirmScope = async (targets: FencingTarget[], volume: import('@aws-sdk/client-ec2').Volume | undefined) => {
            if (scope.dataVolumeId && scope.dataVolumeId !== volume?.VolumeId) return fail();
            for (const target of targets) {
                const known = scope.writers.find(w => w.generation === target.generation);
                if (known && (known.instanceId !== target.instance.InstanceId || known.fenceToken !== target.fenceToken)) return fail();
            }
            for (const w of scope.writers) {
                const current = targets.find(t => t.instance.InstanceId === w.instanceId);
                if (current) { if (current.generation !== w.generation || current.fenceToken !== w.fenceToken) return fail(); continue; }
                if (w.generation >= i.targetGeneration || !w.fencedAt || !w.observedAt || w.observedState !== 'stopped'
                    || Date.parse(w.fencedAt) > millis(source.startDate) || Date.parse(w.observedAt) > Date.parse(w.fencedAt) + 5000) return fail();
                // Historical instances may expire from provider history only
                // after a recorded fence; no current ID may take this path.
                let rows;
                try { rows = await deps.instances([w.instanceId]); }
                catch (error) { if (error instanceof Error && error.name === 'InvalidInstanceID.NotFound') continue; throw error; }
                if (rows.length > 1) return fail();
                if (rows[0] && (rows[0].owner !== d.accountId || rows[0].instance.InstanceId !== w.instanceId || rows[0].instance.State?.Name !== 'terminated'
                    || rows[0].instance.Placement?.AvailabilityZone !== d.availabilityZone || !tagged(rows[0].instance.Tags, tagsFor(i, w.generation, w.fenceToken)))) return fail();
            }
            const checked = await deps.execution(sourceExecutionArn);
            // AWS request IDs and transport metadata differ on every read.
            const identity = (e: DescribeExecutionOutput) => ({ executionArn: e.executionArn, stateMachineArn: e.stateMachineArn,
                stateMachineVersionArn: e.stateMachineVersionArn, stateMachineAliasArn: e.stateMachineAliasArn,
                name: e.name, status: e.status, redriveCount: e.redriveCount, input: e.input, startDate: e.startDate, stopDate: e.stopDate });
            if (!equal(identity(checked), identity(source))) return fail();
            await confirmAuthority();
        };
        const phase: RecoveryPhase = event.phase === 'source-interrupted' ? 'initial' : event.phase as RecoveryPhase;
        const decision = await planLifecycleFencing({ deps, source, sourceExecutionArn, envelope: envelope.source, i, began, phase, confirmScope });
        if (decision.decision === 'success') return { decision: 'success', receipt: { schemaVersion: 1, computerId: i.computerId,
            cancellationId: c.cancellationId, digest: envelope.digest, source: decision.receipt } };
        // Keep the original interruption phase while awaiting terminal history;
        // never repeat StopExecution after an ambiguous response.
        if (decision.decision === 'wait' && event.phase === 'source-interrupted') return wait();
        return decision;
    };
}

let helper: ReturnType<typeof createCancellationHelper> | undefined;
export async function handler(input: unknown) {
    try {
        if (!helper) { const settings = CancellationSettingsSchema.parse(JSON.parse(process.env.EZIL_CANCELLATION_SETTINGS ?? ''));
            helper = createCancellationHelper(settings, cancellationDependencies(settings)); }
        return await helper(input);
    } catch { return fail(); }
}
