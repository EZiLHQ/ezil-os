import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { cancellationDependencies, requestCancellationAuthority } from '../lib/lifecycle/cancellation-aws.js';
import { CancellationSchema, CancellationSettingsSchema, parseCancellationInput } from '../lib/lifecycle/cancellation-contract.js';
import { cancellationFixture } from './cancellation-fixture.js';

test('authority uses the dedicated key, realm, path and exact cancellation, with no browser credentials', async () => {
    const f = cancellationFixture(), c = CancellationSchema.parse(f.c), key = 'a'.repeat(64);
    const result = await requestCancellationAuthority(f.settings.lifecycle.authorityOrigin, key, c, f.digest, async (url, init) => {
        assert.equal(url, 'https://control.example/api/internal/computers/cancellation-authority');
        assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST'); assert.ok(init?.signal);
        const body = String(init.body), request = JSON.parse(body), headers = new Headers(init.headers);
        assert.deepEqual(request, { schemaVersion: 1, computerId: c.computerId, cancellationId: c.cancellationId, digest: f.digest });
        assert.equal(headers.get('authorization'), null); assert.equal(headers.get('cookie'), null);
        const expected = createHmac('sha256', Buffer.from(key, 'hex')).update(['ezil-cancellation-authority-v1', 'POST',
            '/api/internal/computers/cancellation-authority', headers.get('x-ezil-workflow-timestamp'), createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
        assert.equal(headers.get('x-ezil-workflow-signature'), expected);
        return Response.json({ authorized: true, ...request, ...f.scope });
    });
    assert.deepEqual(result, f.scope);
});
test('denial is not permission; malformed, oversized or changed authority responses fail closed', async () => {
    const f = cancellationFixture(), c = CancellationSchema.parse(f.c), key = 'a'.repeat(64);
    const request = { schemaVersion: 1, computerId: c.computerId, cancellationId: c.cancellationId, digest: f.digest };
    assert.equal(await requestCancellationAuthority('https://control.example', key, c, f.digest, async () => Response.json({}, { status: 403 })), null);
    const responses = [Response.json({ authorized: false, ...request, ...f.scope }),
        Response.json({ authorized: true, ...request, ...f.scope, unexpected: true }),
        Response.json({ authorized: true, ...request, ...f.scope, digest: 'b'.repeat(64) }),
        new Response('x'.repeat(65537)), new Response('private-invalid-json', { headers: { 'content-type': 'application/json' } }),
        Response.json({}, { status: 503 }), new Response('{}', { headers: { 'content-type': 'text/html' } })];
    for (const response of responses) await assert.rejects(requestCancellationAuthority('https://control.example', key, c, f.digest, async () => response), /^Error: cancellation_authority_unavailable$/);
});
test('wire adapter reads only the dedicated current secret and rejects incomplete history pagination', async () => {
    const f = cancellationFixture(), c = CancellationSchema.parse(f.c), calls: string[] = [];
    let mode: 'ok' | 'repeat' | 'truncated' = 'ok', secretArn = f.settings.cancellationSecretArn;
    const deps = cancellationDependencies(f.settings, { credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
        requestHandler: { async handle(req: any) {
            const operation = req.headers['x-amz-target'].split('.').at(-1); calls.push(operation);
            const body = JSON.parse(Buffer.from(req.body).toString());
            assert.match(req.headers.authorization, /^AWS4-HMAC-SHA256 /);
            let payload: unknown;
            if (operation === 'GetSecretValue') {
                assert.equal(req.hostname, 'secretsmanager.us-east-1.amazonaws.com'); assert.equal(body.SecretId, f.settings.cancellationSecretArn);
                assert.equal(body.VersionStage, 'AWSCURRENT'); payload = { ARN: secretArn, SecretString: 'a'.repeat(64), VersionStages: ['AWSCURRENT'] };
            } else {
                assert.equal(operation, 'GetExecutionHistory'); assert.equal(req.hostname, 'states.us-east-1.amazonaws.com');
                assert.equal(body.includeExecutionData, false); assert.equal(body.maxResults, 1000); assert.equal(body.executionArn, f.executionArn);
                payload = mode === 'repeat' ? { events: [], nextToken: 'again' } : mode === 'truncated' ? { events: [], nextToken: String(calls.length) }
                    : { events: [{ type: body.nextToken ? 'ExecutionSucceeded' : 'ExecutionStarted', id: body.nextToken ? 2 : 1, timestamp: 1 }], ...(body.nextToken ? {} : { nextToken: 'next' }) };
            }
            return { response: { statusCode: 200, headers: { 'content-type': 'application/x-amz-json-1.0' }, body: Readable.from([JSON.stringify(payload)]) } };
        } }, fetcher: async (_url, init) => Response.json({ authorized: true, ...JSON.parse(String(init?.body)), ...f.scope }) });
    assert.deepEqual(await deps.cancellationAuthority(c, f.digest), f.scope);
    secretArn = f.settings.lifecycle.authoritySecretArn;
    await assert.rejects(deps.cancellationAuthority(c, f.digest), /cancellation_authority_unavailable/);
    assert.equal((await deps.history(f.executionArn)).length, 2);
    for (const bad of ['repeat', 'truncated'] as const) { mode = bad; await assert.rejects(deps.history(f.executionArn), /cancellation_history_incomplete/); }
    assert.ok(calls.every(c => ['GetSecretValue', 'GetExecutionHistory'].includes(c)));
});
test('settings isolate workflow and key; both immutable documents and source schema must match', () => {
    const f = cancellationFixture();
    assert.equal(CancellationSettingsSchema.safeParse({ ...f.settings, cancellationSecretArn: f.settings.lifecycle.authoritySecretArn }).success, false);
    assert.equal(CancellationSettingsSchema.safeParse({ ...f.settings, cancellationVersionArn: f.settings.lifecycle.deployment.stateMachineVersionArn }).success, false);
    const original = JSON.parse(f.execution.input!);
    assert.equal(parseCancellationInput(original, new Date()).intent.jobId, f.i.jobId);
    for (const change of [(v: any) => { v.document += ' '; }, (v: any) => { v.source.document += ' '; },
        (v: any) => { v.source.schemaVersion = 2; }, (v: any) => { v.source.digest = 'b'.repeat(64); }, (v: any) => { v.extra = true; }]) {
        const value = structuredClone(original); change(value); assert.throws(() => parseCancellationInput(value, new Date()));
    }
});
