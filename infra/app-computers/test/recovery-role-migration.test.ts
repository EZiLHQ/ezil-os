import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle, type RetainedLifecycleSource } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { AppCaller } from '../lib/app-caller.js';
import { applyWorkloadIdentity } from '../lib/workload-identity.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { preparationFixture } from './preparation-fixture.js';

const oldRole = 'RecoveryRecoveryRole1B60FF4C', oldPolicy = 'RecoveryRecoveryRoleDefaultPolicy2A415109';
function synth(image: boolean, retainedObserverVersionLogicalId?: string, pathMetadata = false, retainedSource?: RetainedLifecycleSource) {
    const base = image ? preparationFixture().settings : lifecycleFixture().settings;
    const settings = retainedSource ? { ...base, deployment: { ...base.deployment, amiId: 'ami-33333333333333333',
        stateMachineVersionArn: base.deployment.stateMachineVersionArn.replace(/:[1-9][0-9]*$/, ':2'),
        recoveryStateMachineVersionArn: base.deployment.recoveryStateMachineVersionArn?.replace(/:[1-9][0-9]*$/, ':2') } } : base;
    const d = settings.deployment;
    const stack = new Stack(new App({ context: { 'aws:cdk:enable-path-metadata': pathMetadata } }), 'RecoveryMigration', { env: { account: d.accountId, region: d.region } });
    applyWorkloadIdentity(stack, d.accountId, d.namespace);
    const controller = new ComputerLifecycle(stack, 'Lifecycle', { settings, authorityKeyArn: d.dataKeyArn, ...(retainedSource ? { retainedSource } : {}) });
    new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: settings,
        recoveryVersionArn: d.recoveryStateMachineVersionArn ?? `arn:aws:states:${d.region}:${d.accountId}:stateMachine:ezil-${d.namespace}-recovery:1` },
        sourceHistoryKey: controller.historyKey,
        ...(retainedObserverVersionLogicalId ? { retainedObserverVersionLogicalId } : {}) });
    new AppCaller(stack, 'AppCaller', { config: { enabled: true, roleName: 'ezil-pilot-app-caller', providers: [],
        ec2CallerRoleArns: [`arn:aws:iam::${d.accountId}:role/ezil-host`], ec2CallerEnv: 'production' },
        region: d.region, versionArns: [d.stateMachineVersionArn], historyKeyArn: controller.historyKey.keyArn,
        ...(retainedSource ? { retainedLifecycleVersionArn: retainedSource.stateMachineVersionArn } : {}) });
    return assertions.Template.fromStack(stack).toJSON().Resources as Record<string, any>;
}
for (const metadata of [false, true]) test(`image migration preserves legacy resources and observer capabilities (path metadata=${metadata})`, () => {
    const before = synth(false, undefined, metadata);
    const legacyVersion = before[oldPolicy].Properties.PolicyDocument.Statement
        .find((s: any) => s.Action === 'lambda:InvokeFunction').Resource.Ref;
    const after = synth(true, legacyVersion, metadata);
    for (const id of [oldRole, oldPolicy, legacyVersion]) assert.deepEqual(after[id], before[id], id);
    assert.equal(after[oldRole].Properties.RoleName, undefined);
    assert.match(after[oldRole].Properties.PermissionsBoundary, /:policy\/ezil\/identity\/ezil-pilot-boundary$/);
    const imageRoles = Object.entries(after).filter(([, r]) => r.Type === 'AWS::IAM::Role'
        && r.Properties.PermissionsBoundary.endsWith('/ezil-pilot-image-job-boundary'));
    assert.equal(imageRoles.length, 2);
    const [imageId, imageRole] = imageRoles.find(([id]) => id.startsWith('RecoveryImageRecoveryRole'))!;
    assert.equal(imageRole.Properties.RoleName, 'ezil-pilot-recovery');
    assert.equal(imageRole.Properties.Path, '/ezil/pilot/');
    assert.deepEqual(imageRole.Properties.AssumeRolePolicyDocument, before[oldRole].Properties.AssumeRolePolicyDocument);
    const workflow = Object.entries(after).find(([id, r]) => id.startsWith('RecoveryWorkflow') && r.Type === 'AWS::StepFunctions::StateMachine')![1];
    assert.deepEqual(workflow.Properties.RoleArn, { 'Fn::GetAtt': [imageId, 'Arn'] });
    const newPolicy = Object.values(after).find((r: any) => r.Type === 'AWS::IAM::Policy'
        && r.Properties.Roles?.some((v: any) => v.Ref === imageId))!;
    const currentVersion = newPolicy.Properties.PolicyDocument.Statement.find((s: any) => s.Action === 'lambda:InvokeFunction').Resource.Ref;
    assert.notEqual(currentVersion, legacyVersion);
    assert.ok(after[currentVersion]);
    assert.equal(after[legacyVersion].Properties.FunctionName.Ref, 'RecoveryObserver1D350FD8');
    const observerPolicy = 'RecoveryObserverServiceRoleDefaultPolicyA036F4CB';
    for (const statement of before[observerPolicy].Properties.PolicyDocument.Statement)
        assert.ok(after[observerPolicy].Properties.PolicyDocument.Statement.some((s: any) =>
            JSON.stringify(s) === JSON.stringify(statement)), 'retained observer loses baseline statement: ' + JSON.stringify(statement));
});
test('retained observer references cannot target another construct, current version or a non-image deployment', () => {
    for (const value of ['OtherObserverCurrentVersion680AB0D7' + 'a'.repeat(32),
        'RecoveryObserverCurrentVersionFFFFFFFF' + 'a'.repeat(32), 'arn:aws:lambda:region:account:function:x:1']) {
        assert.throws(() => synth(true, value), /invalid_retained_recovery_observer_version/);
    }
    const before = synth(false);
    const version = before[oldPolicy].Properties.PolicyDocument.Statement.find((s: any) => s.Action === 'lambda:InvokeFunction').Resource.Ref;
    assert.throws(() => synth(false, version), /invalid_retained_recovery_observer_version/);
});

test('already-image-enabled and fresh stacks keep the existing fixed role and conditional observer key permissions', () => {
    const before = synth(true), after = synth(true);
    assert.deepEqual(after[oldRole], before[oldRole]);
    assert.equal(after[oldRole].Properties.RoleName, 'ezil-pilot-recovery');
    assert.match(after[oldRole].Properties.PermissionsBoundary, /\/ezil-pilot-image-job-boundary$/);
    assert.equal(Object.keys(after).some(id => id.startsWith('RecoveryImageRecoveryRole')), false);
    const roles = Object.entries(after).filter(([, r]) => r.Type === 'AWS::IAM::Role'
        && r.Properties.PermissionsBoundary.endsWith('/ezil-pilot-image-job-boundary'));
    assert.equal(roles.length, 2);
    const workflow = Object.entries(after).find(([id, r]) => id.startsWith('RecoveryWorkflow') && r.Type === 'AWS::StepFunctions::StateMachine')![1];
    assert.deepEqual(workflow.Properties.RoleArn, { 'Fn::GetAtt': [oldRole, 'Arn'] });
    for (const statement of after.RecoveryObserverServiceRoleDefaultPolicyA036F4CB.Properties.PolicyDocument.Statement) {
        if (![statement.Action].flat().includes('kms:Decrypt') || !JSON.stringify(statement.Resource).includes('HistoryKey')) continue;
        assert.ok(statement.Condition?.StringEquals?.['kms:ViaService'], 'no unconditional legacy-key expansion in image-only mode');
    }
});

test('retained Lifecycle1 keeps exact old AMI/invoke and history capabilities alongside the current target', () => {
    const before = synth(false);
    const prior = JSON.parse(before.LifecycleObserver4909851D.Properties.Environment.Variables.EZIL_LIFECYCLE_SETTINGS).deployment;
    const oldController = before.LifecycleControllerRoleDefaultPolicy31C0D948.Properties.PolicyDocument.Statement;
    const oldInvoke = oldController.find((s: any) => s.Action === 'lambda:InvokeFunction');
    const oldLaunch = oldController.find((s: any) => s.Action === 'ec2:RunInstances'
        && JSON.stringify(s.Resource).includes('/' + prior.amiId));
    const recoveryVersion = before[oldPolicy].Properties.PolicyDocument.Statement.find((s: any) => s.Action === 'lambda:InvokeFunction').Resource.Ref;
    const retainedSource = { amiId: prior.amiId, stateMachineVersionArn: prior.stateMachineVersionArn,
        observerVersionLogicalId: oldInvoke.Resource.Ref };
    const after = synth(true, recoveryVersion, true, retainedSource);
    const oldVersion = { ...before[retainedSource.observerVersionLogicalId],
        Metadata: { ...before[retainedSource.observerVersionLogicalId].Metadata,
            'aws:cdk:path': 'RecoveryMigration/Lifecycle/Observer/CurrentVersion/Resource' } };
    assert.deepEqual(after[retainedSource.observerVersionLogicalId], oldVersion);
    const retainedPolicy = Object.entries(after).find(([id]) => id.startsWith('LifecycleRetainedSourcePolicy'))![1];
    assert.deepEqual(retainedPolicy.Properties.Roles, [{ Ref: 'LifecycleControllerRole1FB8E154' }]);
    assert.deepEqual(retainedPolicy.Properties.PolicyDocument.Statement, [oldLaunch, oldInvoke]);
    const current = after.LifecycleControllerRoleDefaultPolicy31C0D948.Properties.PolicyDocument.Statement;
    assert.ok(current.some((s: any) => s.Action === 'ec2:RunInstances' && JSON.stringify(s.Resource).includes('/ami-33333333333333333')));
    assert.ok(current.some((s: any) => s.Action === 'lambda:InvokeFunction' && s.Resource.Ref !== oldInvoke.Resource.Ref));
    for (const id of ['LifecycleObserverServiceRoleDefaultPolicy537A1B52', 'AppCallerRoleDefaultPolicy61BE57D2'])
        for (const statement of before[id].Properties.PolicyDocument.Statement)
            assert.ok(after[id].Properties.PolicyDocument.Statement.some((s: any) => JSON.stringify(s) === JSON.stringify(statement)),
                id + ' loses prior capability: ' + JSON.stringify(statement));
});
