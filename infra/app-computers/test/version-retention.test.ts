import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

// A published Step Functions version invokes one exact Lambda version. Replacing the function's
// code must never delete the version an older (rollback) workflow version still calls
// (seen on the live Mumbai stack 2026-10-22: every lifecycle deploy removed the previous one).
test('every workflow observer Lambda version is retained on replacement', () => {
    const f = lifecycleFixture();
    const stack = new Stack(new App(), 'LifecycleRetention', { env: { account: f.settings.deployment.accountId, region: REGION } });
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.settings.deployment.dataKeyArn });
    const recoveryVersionArn = f.settings.deployment.stateMachineVersionArn.replace(/:stateMachine:[^:]+:/, ':stateMachine:ezil-pilot-recovery:');
    new ComputerLifecycleRecovery(stack, 'Recovery', {
        settings: { lifecycle: f.settings, recoveryVersionArn }, sourceHistoryKey: lifecycle.historyKey, enabled: true });
    const versions = Object.entries(assertions.Template.fromStack(stack).findResources('AWS::Lambda::Version'));
    assert.ok(versions.length >= 2, `expected lifecycle and recovery observer versions, got ${versions.length}`);
    for (const [logical, resource] of versions) {
        assert.equal((resource as { DeletionPolicy?: string }).DeletionPolicy, 'Retain', `${logical} must be retained`);
        assert.equal((resource as { UpdateReplacePolicy?: string }).UpdateReplacePolicy, 'Retain', `${logical} must be retained on replacement`);
    }
});
