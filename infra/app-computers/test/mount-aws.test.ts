import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { awsDependencies } from '../lib/mount/aws.js';
import { canonical } from '../lib/mount/contract.js';
import { createMountReconciler } from '../lib/mount/reconciler.js';
import { fixture, settings } from './mount-fixture.js';

test('real SDK clients use fixed AWS endpoints and bounded read operations only', async () => {
    const requests: { hostname: string; body: string; target: string }[] = [];
    const f = fixture(), delivery = f.input, secret = '1'.repeat(64);
    const deps = awsDependencies(settings, { credentials: { accessKeyId: 'TESTACCESSKEY', secretAccessKey: 'TESTSIGNINGKEY' },
        fetcher: async (_url, init) => Response.json({ authorized: true, work: JSON.parse(String(init?.body)) }),
        requestHandler: { handle: async (request: { body?: unknown; headers: Record<string, string>; hostname: string }) => {
            const body = typeof request.body === 'string' ? request.body : Buffer.from(request.body as Uint8Array ?? []).toString(), target = request.headers['x-amz-target'] ?? '';
            requests.push({ hostname: request.hostname, body, target });
            let content = '{}', contentType = 'application/x-amz-json-1.1';
            if (target.endsWith('DescribeExecution')) content = JSON.stringify({ ...f.state.execution,
                startDate: f.start / 1000, $metadata: undefined });
            else if (target.endsWith('GetSecretValue')) content = JSON.stringify({ ARN: settings.authoritySecretArn,
                SecretString: secret, VersionStages: ['AWSCURRENT'] });
            else if (request.hostname === 'ec2.us-east-1.amazonaws.com') {
                contentType = 'text/xml'; content = body.includes('Action=DescribeInstances')
                    ? '<DescribeInstancesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><reservationSet/></DescribeInstancesResponse>'
                    : '<DescribeVolumesResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><volumeSet/></DescribeVolumesResponse>';
            }
            return { response: { statusCode: 200, headers: { 'content-type': contentType }, body: Readable.from([Buffer.from(content)]) } };
        } },
    });
    assert.equal((await deps.execution(f.event.executionArn)).executionArn, f.event.executionArn);
    assert.equal(await deps.authority(delivery), true);
    assert.equal(await deps.writer(delivery), false);
    assert.equal(await deps.command(delivery.work.authorization.authorizationId), undefined);
    await deps.invocation(delivery.work.authorization.authorizationId, delivery.work.authorization.scope.providerInstanceId);
    assert.deepEqual(new Set(requests.map(r => r.hostname)), new Set(['states.us-east-1.amazonaws.com',
        'secretsmanager.us-east-1.amazonaws.com', 'ec2.us-east-1.amazonaws.com', 'ssm.us-east-1.amazonaws.com']));
    assert.equal(requests.length, 6); // no retry, pagination or mutation hidden inside a poll
    assert.doesNotMatch(JSON.stringify(requests), /SendCommand|RunInstances|AttachVolume|StopInstances/);
    assert.ok(requests.some(r => r.body.includes('PluginName') && r.body.includes('operateMount')));
});
test('reconciler rechecks source history and uses a stable recovery name under duplicate events', async () => {
    const f = fixture(), delivery = f.input; Object.assign(f.state.execution, { status: 'FAILED' });
    const requests: { name: string; input: any }[] = [];
    const run = createMountReconciler({ machineArn: settings.machineArn, recoveryVersionArn: settings.machineArn + '-recovery:1' },
        { send: async (command: any) => { requests.push({ name: command.constructor.name, input: command.input });
            if (command.constructor.name === 'DescribeExecutionCommand') return f.state.execution;
            if (requests.filter(r => r.name === 'StartExecutionCommand').length > 1) { const error = new Error(); error.name = 'ExecutionAlreadyExists'; throw error; }
            return {}; } } as any, () => f.state.now);
    const event = { source: 'aws.states', detail: { executionArn: f.event.executionArn, stateMachineArn: settings.machineArn } };
    await run(event); await run(event);
    const starts = requests.filter(r => r.name === 'StartExecutionCommand');
    assert.equal(starts.length, 2); assert.deepEqual(starts[0], starts[1]);
    assert.deepEqual(starts[0]?.input, { stateMachineArn: settings.machineArn + '-recovery:1',
        name: `cleanup-mount-${delivery.work.authorization.authorizationId}`, input: canonical({ sourceExecutionArn: f.event.executionArn }) });
    await assert.rejects(run({ source: 'aws.states', detail: { ...event.detail, stateMachineArn: 'unrelated' } }), /^Error: mount_reconciliation_unavailable$/);
});
test('scheduled reconciliation follows pagination and stops at old history', async () => {
    const f = fixture(), pages: any[] = []; Object.assign(f.state.execution, { status: 'FAILED' });
    let starts = 0;
    const run = createMountReconciler({ machineArn: settings.machineArn, recoveryVersionArn: settings.machineArn + '-recovery:1' },
        { send: async (command: any) => {
            if (command.constructor.name === 'DescribeExecutionCommand') return f.state.execution;
            if (command.constructor.name === 'StartExecutionCommand') { starts++; return {}; }
            pages.push(command.input);
            if (command.input.statusFilter !== 'FAILED') return { executions: [] };
            if (!command.input.nextToken) return { executions: [{ executionArn: f.event.executionArn, startDate: new Date(f.start) }], nextToken: 'second' };
            return { executions: [{ executionArn: f.event.executionArn, startDate: new Date(f.start - 86400001) }], nextToken: 'do-not-read' };
        } } as any, () => f.state.now);
    await run({ source: 'aws.events', 'detail-type': 'Scheduled Event', detail: {} });
    assert.equal(starts, 1); assert.equal(pages.length, 4); assert.equal(pages[1]?.nextToken, 'second');
});
