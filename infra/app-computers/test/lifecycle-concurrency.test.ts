import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

// Live: a new account's whole Lambda concurrency pool is 10, and AWS refuses any reservation
// that leaves fewer than 10 unreserved ("decreases account's UnreservedConcurrentExecution below
// its minimum value of [10]"). The reservation is configurable; null omits it.
function observers(lambdaReservedConcurrency?: number | null) {
    const f = lifecycleFixture(), stack = new Stack(new App(), 'LifecycleConcurrency', { env: { account: f.settings.deployment.accountId, region: REGION } });
    new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.settings.deployment.dataKeyArn,
        ...(lambdaReservedConcurrency === undefined ? {} : { lambdaReservedConcurrency }) });
    return Object.values(assertions.Template.fromStack(stack).findResources('AWS::Lambda::Function')) as { Properties: Record<string, unknown> }[];
}

test('lifecycle observer keeps its reserved concurrency of 2 by default', () => {
    const fns = observers();
    assert.equal(fns.length, 1);
    assert.equal(fns[0]!.Properties.ReservedConcurrentExecutions, 2);
});

test('lifecycle observer omits the reservation when configured null (new-account Lambda pool of 10)', () => {
    const fns = observers(null);
    assert.equal(fns.length, 1);
    assert.equal('ReservedConcurrentExecutions' in fns[0]!.Properties, false);
});

test('lifecycle observer honours an explicit reservation', () => {
    assert.equal(observers(5)[0]!.Properties.ReservedConcurrentExecutions, 5);
});
