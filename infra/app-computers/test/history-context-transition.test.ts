import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { AppCaller } from '../lib/app-caller.js';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery, type TransitionStateMachineVersions } from '../lib/lifecycle-recovery.js';
import { applyWorkloadIdentity } from '../lib/workload-identity.js';
import { preparationFixture } from './preparation-fixture.js';

// Staging 2026-11-17, second cutover gap: the workflows change set also replaced every history-key Decrypt row's
// `kms:EncryptionContext:aws:states:stateMachineArn` list (old version -> new version) for the lifecycle observer,
// the app caller, the preparation observer and the recovery observer, while the previous state-machine versions were
// still deployed and running. `transitionStateMachineVersions` keeps the EXACT prior rows beside the current ones.

type Resources = Record<string, any>;
const CONTEXT = 'kms:EncryptionContext:aws:states:stateMachineArn';
const POLICIES = ['LifecycleObserverServiceRoleDefaultPolicy', 'AppCallerRoleDefaultPolicy', 'LifecyclePreparationObserverRoleDefaultPolicy', 'RecoveryObserverServiceRoleDefaultPolicy'];
const appCallerConfig = (accountId: string) => ({ enabled: true, roleName: 'ezil-pilot-app-caller', providers: [],
    ec2CallerRoleArns: [`arn:aws:iam::${accountId}:role/ezil-host`], ec2CallerEnv: 'production' as const });

function synth(generation: 1 | 2, transition?: TransitionStateMachineVersions): { resources: Resources; d: any } {
    const base = preparationFixture().settings;
    const bump = (arn: string) => arn.replace(/:[1-9][0-9]*$/, ':2');
    const settings = generation === 1 ? base : { ...base, deployment: { ...base.deployment, amiId: 'ami-33333333333333333',
        stateMachineVersionArn: bump(base.deployment.stateMachineVersionArn), preparationStateMachineVersionArn: bump(base.deployment.preparationStateMachineVersionArn!),
        recoveryStateMachineVersionArn: bump(base.deployment.recoveryStateMachineVersionArn!) } };
    const d = settings.deployment;
    const stack = new Stack(new App(), 'HistoryContextTransition', { env: { account: d.accountId, region: d.region } });
    applyWorkloadIdentity(stack, d.accountId, d.namespace);
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings, authorityKeyArn: d.dataKeyArn, ...(transition ? { transitionStateMachineVersions: transition } : {}) });
    const recovery = new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: settings, recoveryVersionArn: d.recoveryStateMachineVersionArn! },
        sourceHistoryKey: lifecycle.historyKey, ...(transition ? { transitionStateMachineVersions: transition } : {}) });
    new AppCaller(stack, 'AppCaller', { config: appCallerConfig(d.accountId), region: d.region, versionArns: [d.stateMachineVersionArn], historyKeyArn: lifecycle.historyKey.keyArn,
        ...(transition ? { transitionStateMachineVersions: transition } : {}) });
    void recovery;
    return { resources: assertions.Template.fromStack(stack).toJSON().Resources as Resources, d };
}
/** Every history-key Decrypt row with a state-machine context, by policy family, as canonical JSON (key Refs/GetAtts are stable across synths). */
function contextRows(resources: Resources): Map<string, Set<string>> {
    const rows = new Map<string, Set<string>>();
    for (const [id, r] of Object.entries(resources)) {
        const family = POLICIES.find(p => id.startsWith(p));
        if (r.Type !== 'AWS::IAM::Policy' || !family) continue;
        for (const s of r.Properties.PolicyDocument.Statement) {
            if (s.Effect !== 'Allow' || [s.Action].flat().join() !== 'kms:Decrypt' || !s.Condition?.StringEquals?.[CONTEXT]) continue;
            (rows.get(family) ?? rows.set(family, new Set()).get(family)!).add(JSON.stringify(s));
        }
    }
    return rows;
}

test('the four policies keep every exact prior history-context row beside the current rows across the window', () => {
    const before = synth(1), after = synth(2, { lifecycle: before.d.stateMachineVersionArn, preparation: before.d.preparationStateMachineVersionArn, recovery: before.d.recoveryStateMachineVersionArn });
    const prior = contextRows(before.resources), next = contextRows(after.resources);
    assert.deepEqual([...prior.keys()].sort(), POLICIES.slice().sort(), 'all four policy families carry history-context rows');
    for (const [family, rows] of prior) {
        for (const row of rows) assert.ok(next.get(family)?.has(row), `${family}: prior row lost: ${row.slice(0, 160)}`);
        // The current rows are present too (the lists name the NEW versions).
        assert.ok([...next.get(family)!].some(row => row.includes(':2"') || row.includes(':2]') || row.includes(':2,')), `${family}: current rows present`);
    }
    // Only version ARNs of the same machines, never wildcards or other keys.
    for (const rows of next.values()) for (const row of rows) assert.ok(!row.includes('*'), 'no wildcard context');
});

test('without the key the prior rows are gone (the incident shape) and the synth is otherwise the same', () => {
    const before = synth(1), after = synth(2);
    const prior = contextRows(before.resources), next = contextRows(after.resources);
    for (const [family, rows] of prior) for (const row of rows) assert.ok(!next.get(family)?.has(row), `${family}: prior row unexpectedly kept without the key`);
});

test('a previous version of another machine, a later version, or a retained-source conflict is refused', () => {
    const base = synth(1).d;
    assert.throws(() => synth(2, { lifecycle: base.preparationStateMachineVersionArn }), /invalid_transition_state_machine_version/);
    assert.throws(() => synth(2, { lifecycle: base.stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ':9') }), /invalid_transition_state_machine_version/);
    assert.throws(() => synth(2, { lifecycle: 'arn:aws:states:ap-south-1:123456789012:stateMachine:*:1' }), /invalid_transition_state_machine_version/);
});
