import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { SFNClient } from '@aws-sdk/client-sfn';
import { readRecoveryHistory } from '../lib/lifecycle/recovery-aws.js';
import { createLifecycleReconciler } from '../lib/lifecycle/reconciler.js';
import { canonical } from '../lib/lifecycle/contract.js';
import { lifecycleFixture } from './lifecycle-fixture.js';

function wire(handle: (action: string, body: any) => { value: unknown; status?: number }) {
    return new SFNClient({ region: 'us-east-1', maxAttempts: 1, endpoint: 'https://states.us-east-1.amazonaws.com',
        credentials: { accessKeyId: 'ASIAABCDEFGHIJKLMNOP', secretAccessKey: 'test-only', sessionToken: 'test-only' },
        requestHandler: { async handle(request: any) {
            assert.match(request.headers.authorization, /AWS4-HMAC-SHA256/);
            const body = JSON.parse(typeof request.body === 'string' ? request.body : Buffer.from(request.body).toString());
            const result = handle(request.headers['x-amz-target'].split('.').at(-1), body);
            return { response: { statusCode: result.status ?? 200, headers: { 'content-type': 'application/x-amz-json-1.0' },
                body: Readable.from([JSON.stringify(result.value)]) } };
        } } });
}

test('actual history requests follow pagination without execution data and reject bounded-scan exhaustion', async () => {
    const f = lifecycleFixture(); let pages = 0, endless = false;
    const client = wire((action, body) => {
        assert.equal(action, 'GetExecutionHistory'); assert.equal(body.executionArn, f.executionArn);
        assert.equal(body.includeExecutionData, false); assert.equal(body.reverseOrder, false); assert.equal(body.maxResults, 1000);
        pages++;
        return { value: { events: [{ id: pages, type: pages % 2 ? 'ExecutionStarted' : 'ExecutionFailed', timestamp: f.state.now / 1000 }],
            ...(endless || pages % 2 ? { nextToken: 'page-' + pages } : {}) } };
    });
    try {
        const rows = await readRecoveryHistory(client, f.executionArn); assert.equal(rows.length, 2); assert.ok(rows[0]!.timestamp instanceof Date);
        pages = 0; endless = true;
        await assert.rejects(readRecoveryHistory(client, f.executionArn), /history_incomplete/); assert.equal(pages, 4);
    } finally { client.destroy(); }
});
test('actual reconciler requests bind the original numeric version and reuse a single cleanup name', async () => {
    const f = lifecycleFixture(), settings = { lifecycle: f.settings,
        recoveryVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle-recovery:1' };
    let starts = 0, lists = 0, sourceStatus = 'FAILED'; const seen: string[] = [];
    const client = wire((action, body) => {
        seen.push(action);
        if (action === 'ListExecutions') {
            lists++; assert.equal(body.stateMachineArn, f.settings.deployment.stateMachineVersionArn);
            return { value: { executions: body.statusFilter === 'FAILED' ? [{ executionArn: f.executionArn, startDate: f.state.now / 1000 }] : [] } };
        }
        if (action === 'DescribeExecution') return { value: { ...f.state.execution, status: sourceStatus, startDate: f.state.now / 1000 } };
        if (action === 'StartExecution') {
            starts++; assert.equal(body.stateMachineArn, settings.recoveryVersionArn);
            assert.equal(body.name, `cleanup-computer-${f.i.jobId}`); assert.equal(body.input, canonical({ sourceExecutionArn: f.executionArn }));
            return { status: 400, value: { __type: 'ExecutionAlreadyExists', message: 'already exists' } };
        }
        throw new Error('unexpected provider call');
    });
    try {
        const run = createLifecycleReconciler(settings, client, () => f.state.now);
        const event = { source: 'aws.states', detail: { stateMachineArn: f.state.execution.stateMachineArn, executionArn: f.executionArn } };
        await run(event); await run(event); assert.equal(starts, 2);
        await run({ source: 'aws.events', 'detail-type': 'Scheduled Event' }); assert.equal(lists, 3); assert.equal(starts, 3);
        sourceStatus = 'SUCCEEDED'; await run(event); assert.equal(starts, 3);
        await assert.rejects(run({ source: 'aws.states', detail: { ...event.detail, executionArn: f.executionArn.replace('computer-', 'forged-') } }));
        assert.ok(seen.every(action => ['ListExecutions', 'DescribeExecution', 'StartExecution'].includes(action)));
    } finally { client.destroy(); }
});
test('reconciliation refuses a redriven source before starting recovery', async () => {
    const f = lifecycleFixture(), settings = { lifecycle: f.settings,
        recoveryVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle-recovery:1' };
    const client = wire(action => {
        assert.equal(action, 'DescribeExecution');
        return { value: { ...f.state.execution, startDate: f.state.now / 1000, redriveCount: 1, status: 'FAILED' } };
    });
    try { await assert.rejects(createLifecycleReconciler(settings, client)({ source: 'aws.states',
        detail: { stateMachineArn: f.state.execution.stateMachineArn, executionArn: f.executionArn } }), /reconciliation_unavailable/); }
    finally { client.destroy(); }
});
