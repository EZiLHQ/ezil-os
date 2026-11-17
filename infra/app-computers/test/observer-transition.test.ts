import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle, type RetainedLifecycleSource } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery, type TransitionObserverVersions } from '../lib/lifecycle-recovery.js';
import { applyWorkloadIdentity } from '../lib/workload-identity.js';
import { preparationFixture } from './preparation-fixture.js';

// Staging incident 2026-11-17 (ezil-mum-lifecycle): the workflows change set is executed BEFORE the app
// promotion switches the deployed state-machine version. The still-deployed lifecycle version (:45)
// invoked its own observer Lambda version (LifecycleObserver…:45) while the controller policy only
// allowed lambda:InvokeFunction on the NEW CurrentVersion. An image-to-image rollout carries no
// retainedLifecycleSource, so nothing re-granted the previous version. The transition grant below
// keeps the exact previous observer version invokable (per observer, by exact logical id) alongside
// the current one until promotion completes.

type Resources = Record<string, any>;
const CONTROLLER = 'LifecycleControllerRole1FB8E154';
const observers = {
    lifecycle: { role: CONTROLLER, prefix: 'LifecycleObserverCurrentVersion' },
    preparation: { role: 'LifecyclePreparationRebasePreparationRole', prefix: 'LifecyclePreparationObserverCurrentVersion' },
    recovery: { role: 'RecoveryRecoveryRole1B60FF4C', prefix: 'RecoveryObserverCurrentVersion' },
} as const;
const attachedTo = (r: any, role: string) => r.Properties.Roles?.some((v: any) => typeof v.Ref === 'string' && v.Ref.startsWith(role) && !v.Ref.includes('DefaultPolicy'));

function synth(generation: 1 | 2, transition?: TransitionObserverVersions, retainedSource?: RetainedLifecycleSource, pathMetadata = false): Resources {
    const base = preparationFixture().settings;
    const settings = generation === 1 ? base : { ...base, deployment: { ...base.deployment, amiId: 'ami-33333333333333333',
        stateMachineVersionArn: base.deployment.stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ':2'),
        preparationStateMachineVersionArn: base.deployment.preparationStateMachineVersionArn!.replace(/:[1-9][0-9]*$/, ':2'),
        recoveryStateMachineVersionArn: base.deployment.recoveryStateMachineVersionArn!.replace(/:[1-9][0-9]*$/, ':2') } };
    const d = settings.deployment;
    const stack = new Stack(new App({ context: { 'aws:cdk:enable-path-metadata': pathMetadata } }), 'ObserverTransition', { env: { account: d.accountId, region: d.region } });
    applyWorkloadIdentity(stack, d.accountId, d.namespace);
    const controller = new ComputerLifecycle(stack, 'Lifecycle', { settings, authorityKeyArn: d.dataKeyArn,
        ...(retainedSource ? { retainedSource } : {}),
        ...(transition ? { transitionObserverVersions: { lifecycle: transition.lifecycle, preparation: transition.preparation } } : {}) });
    new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: settings, recoveryVersionArn: d.recoveryStateMachineVersionArn! },
        sourceHistoryKey: controller.historyKey, ...(transition?.recovery ? { transitionObserverVersionLogicalId: transition.recovery } : {}) });
    return assertions.Template.fromStack(stack).toJSON().Resources as Resources;
}
/** Every Allow lambda:InvokeFunction resource of the policies attached to a role, as exact logical-id Refs.
 * `defaultOnly` restricts the scan to CDK's default policy, which carries the current-version row only. */
function invokeRefs(resources: Resources, role: string, defaultOnly = false): string[] {
    const refs: string[] = [];
    for (const [id, r] of Object.entries(resources)) {
        if (r.Type !== 'AWS::IAM::Policy' || !attachedTo(r, role) || (defaultOnly && !id.includes('DefaultPolicy'))) continue;
        for (const s of r.Properties.PolicyDocument.Statement) {
            if (s.Effect !== 'Allow' || ![s.Action].flat().includes('lambda:InvokeFunction')) continue;
            for (const resource of [s.Resource].flat()) {
                assert.ok(typeof resource === 'object' && Object.keys(resource).join() === 'Ref', `${role}: lambda grant must name one exact version Ref, got ${JSON.stringify(resource)}`);
                assert.ok(!JSON.stringify(resource).includes('*'), `${role}: wildcard lambda resource`);
                refs.push(resource.Ref);
            }
        }
    }
    return refs;
}
function currentVersions(resources: Resources) {
    const ids = {} as Record<keyof typeof observers, string>;
    for (const [name, o] of Object.entries(observers)) {
        const refs = invokeRefs(resources, o.role, true);
        const current = refs.filter(id => resources[id]?.Type === 'AWS::Lambda::Version' && id.startsWith(o.prefix));
        assert.equal(current.length, 1, `${name}: expected exactly one current observer version grant in the default policy, got ${JSON.stringify(refs)}`);
        ids[name as keyof typeof observers] = current[0]!;
    }
    return ids;
}

test('image-to-image rollout keeps the exact previous observer version invokable alongside the current one', () => {
    for (const metadata of [false, true]) {
        const before = synth(1, undefined, undefined, metadata);
        const previous = currentVersions(before);
        const after = synth(2, previous, undefined, metadata);
        const current = currentVersions(after);
        for (const [name, o] of Object.entries(observers) as [keyof typeof observers, typeof observers[keyof typeof observers]][]) {
            assert.notEqual(current[name], previous[name], `${name}: a new tuple publishes a new observer version`);
            const refs = invokeRefs(after, o.role);
            assert.deepEqual(new Set(refs), new Set([current[name], previous[name]]), `${name}: invoke grants must cover current and previous version only`);
            assert.equal(refs.length, 2, `${name}: exactly one grant per admitted version`);
            // The previous version resource is the same immutable retained resource (same physical version).
            const expected = { ...before[previous[name]], ...(metadata ? { Metadata: { ...before[previous[name]].Metadata,
                'aws:cdk:path': before[previous[name]].Metadata['aws:cdk:path'] } } : {}) };
            assert.deepEqual(after[previous[name]], expected, `${name}: retained previous version must remain unchanged`);
            assert.equal(after[previous[name]].DeletionPolicy, 'Retain');
        }
        // Default policies keep their exact current-only invoke row; the transition grant is a separate attachment.
        for (const o of Object.values(observers)) {
            const transition = Object.entries(after).filter(([id, r]) => r.Type === 'AWS::IAM::Policy' && id.includes('TransitionObserver') && attachedTo(r, o.role));
            assert.equal(transition.length, 1, `${o.role}: one transition attachment`);
            assert.deepEqual(transition[0]![1].Properties.PolicyDocument.Statement.map((s: any) => s.Action), ['lambda:InvokeFunction']);
        }
    }
});

test('transition grants admit no wildcard or non-version lambda resources anywhere in the stack', () => {
    const before = synth(1);
    const after = synth(2, currentVersions(before));
    for (const [id, r] of Object.entries(after)) {
        if (r.Type !== 'AWS::IAM::Policy' && r.Type !== 'AWS::IAM::Role') continue;
        const documents = r.Type === 'AWS::IAM::Policy' ? [r.Properties.PolicyDocument] : (r.Properties.Policies ?? []).map((p: any) => p.PolicyDocument);
        for (const document of documents) for (const s of document.Statement) {
            if (![s.Action].flat().some((a: string) => a.startsWith('lambda:'))) continue;
            for (const resource of [s.Resource].flat()) {
                assert.ok(typeof resource === 'object' && resource.Ref && after[resource.Ref]?.Type === 'AWS::Lambda::Version', `${id}: lambda grant must target an exact version in this template: ${JSON.stringify(resource)}`);
            }
        }
    }
});

test('transition references cannot target another construct, the current version, or coexist with a retained lifecycle source', () => {
    const before = synth(1);
    const previous = currentVersions(before);
    const current = currentVersions(synth(2));
    assert.throws(() => synth(2, { lifecycle: current.lifecycle }), /invalid_transition_observer_version/);
    assert.throws(() => synth(2, { preparation: 'LifecycleObserverCurrentVersion' + previous.lifecycle.slice(-40) }), /invalid_transition_observer_version/);
    assert.throws(() => synth(2, { recovery: 'RecoveryObserverCurrentVersionFFFFFFFF' + 'a'.repeat(32) }), /invalid_transition_observer_version/);
    assert.throws(() => synth(2, { lifecycle: 'arn:aws:lambda:ap-south-1:123456789012:function:x:1' }), /invalid_transition_observer_version/);
    const retainedSource = { amiId: 'ami-11111111111111111', stateMachineVersionArn: before.LifecycleObserver4909851D && preparationFixture().settings.deployment.stateMachineVersionArn,
        observerVersionLogicalId: previous.lifecycle };
    assert.throws(() => synth(2, { lifecycle: previous.lifecycle }, retainedSource), /transition_conflicts_with_retained_source/);
});
