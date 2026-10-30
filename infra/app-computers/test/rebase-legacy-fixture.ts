import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { recoveryDeploymentFor } from '../lib/lifecycle/deployment.js';
import { parsePreparationInput } from '../lib/lifecycle/preparation-contract.js';
import { parseLifecycleWork } from '../lib/lifecycle/intent.js';
import { envelopeFor, rebaseFixture, rebindFixture } from './rebase-fixture.js';
import { preparationFixture } from './preparation-fixture.js';
import { imageRecoveryFixture, runImageRecovery } from './image-recovery-fixture.js';
import { machineArn } from '../lib/lifecycle/recovery-contract.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';

export const goldenInput = readFileSync(join(__dirname, 'fixtures/rebase-legacy/preparation-input.json'), 'utf8').trim();
export const golden = () => parsePreparationInput(goldenInput);

export function goldenPreparationFixture() {
    const f = rebaseFixture(), { document, envelope } = golden();
    f.preparation = document; f.preparationEnvelope = envelope;
    f.reference.digest = envelope.digest;
    return preparationFixture(f);
}

/** Keep the existing failure-history timeline and substitute the real legacy
 * resource tuple, including its distinct launch-template/workflow versions. */
export function legacyRecoveryFixture() {
    const f = rebaseFixture();
    f.preparation.sourceDeployment = golden().document.sourceDeployment;
    f.preparationEnvelope = envelopeFor(f.preparation);
    f.reference.digest = f.preparationEnvelope.digest;
    f.intent.rebasePreparation = f.reference; f.envelope = envelopeFor(f.intent);
    const rebind = rebindFixture();
    rebind.intent.deployment = recoveryDeploymentFor(f.preparation.sourceDeployment, f.preparation.deployment);
    rebind.intent.rebasePreparation = f.reference;
    rebind.envelope = envelopeFor(rebind.intent);
    parseLifecycleWork({ ...rebind.envelope, createdAt: new Date('2026-10-22T12:00:00.000Z') });
    return imageRecoveryFixture(preparationFixture(f), rebind);
}

export async function legacyMaintenanceFixture() {
    const f = await runImageRecovery({}, legacyRecoveryFixture());
    if (f.result.output?.state !== 'restore_volume_ready') throw new Error(JSON.stringify(f.result));
    Object.assign(f.f.state.executions[f.executionArn]!, { status: 'SUCCEEDED', output: JSON.stringify(f.result.output), stopDate: new Date(f.f.state.now) });
    const i = f.rebind.intent, machine = machineArn(i.deployment.stateMachineVersionArn);
    const executionArn = machine.replace(':stateMachine:', ':execution:') + ':computer-' + i.jobId;
    f.f.state.now = Date.parse(f.rebind.lease.ebsRestore.issuedAt);
    f.f.state.executions[executionArn] = { executionArn, stateMachineArn: machine, stateMachineVersionArn: i.deployment.stateMachineVersionArn,
        name: 'computer-' + i.jobId, input: JSON.stringify(f.rebind.envelope), status: 'RUNNING', redriveCount: 0, startDate: new Date(f.f.state.now) };
    const deps = { ...f.f.deps, template: f.deps.template! };
    // Real deployed settings are the TARGET release, not a fictitious source stack.
    const helper = createLifecycleHelper(f.f.settings, deps);
    return { ...f, deps, i, maintenanceExecutionArn: executionArn, call: () => helper({ executionArn, phase: 'initial' }) };
}
