import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Docker, DockerError } from '../src/docker.js';

test('Docker Unix client bounds responses and redacts daemon error bodies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezil-docker-api-'));
    const socket = join(directory, 'docker.sock');
    const server = createServer((request, response) => {
        if (request.url === '/v1.45/fail') { response.writeHead(409); response.end('private environment value'); }
        else if (request.url === '/v1.45/large') response.end('x'.repeat(3 * 1024 * 1024));
        else response.end(JSON.stringify({ state: 'running' }));
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const client = new Docker(socket);
    try {
        assert.deepEqual(await client.call('GET', '/ok'), { state: 'running' });
        await assert.rejects(client.call('GET', '/fail'), (error: unknown) =>
            error instanceof DockerError && error.status === 409 && error.message === 'docker_operation_failed');
        await assert.rejects(client.call('GET', '/large'), /docker_operation_failed/);
    } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true });
    }
});

test('installation pulls use pinned image bytes, scoped Unix-socket auth and bounded cancellable progress', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezil-pull-'));
    const socket = join(directory, 'docker.sock');
    const registry = '123456789012.dkr.ecr.us-east-1.amazonaws.com';
    const reference = `${registry}/app@sha256:${'a'.repeat(64)}`;
    let mode = 'ok', requests = 0;
    let entered!: () => void;
    let sawCredentials = false;
    const server = createServer((req, res) => {
        requests++;
        assert.equal(req.method, 'POST');
        const url = new URL(req.url!, 'http://local');
        assert.equal(url.pathname, '/v1.45/images/create');
        assert.equal(url.searchParams.get('fromImage'), reference);
        assert.equal(url.searchParams.get('platform'), 'linux/amd64');
        const encoded = req.headers['x-registry-auth'];
        if (typeof encoded === 'string') {
            const credentials = JSON.parse(Buffer.from(encoded, 'base64url').toString());
            assert.deepEqual(credentials, { username: 'AWS', password: 'test-secret', serveraddress: registry });
            sawCredentials = true;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        if (mode === 'ok') { res.write('{"sta'); res.end('tus":"downloaded"}\n'); }
        if (mode === 'error') res.end('{"error":"test-secret","errorDetail":{"message":"private"}}\n');
        if (mode === 'large') res.end('x'.repeat(70000));
        if (mode === 'stall') { res.write('{"status":"waiting"}\n'); entered(); }
    });
    await new Promise<void>(resolve => server.listen(socket, resolve));
    const client = new Docker(socket);
    const signal = new AbortController().signal;
    try {
        await client.pullImage(reference, { registry, token: 'test-secret' }, signal);
        assert(sawCredentials);
        await assert.rejects(client.pullImage(reference, { registry: 'unapproved.example', token: 'test-secret' }, signal), /docker_operation_failed/);
        await assert.rejects(client.pullImage(`${registry}/app:latest`, undefined, signal), /docker_operation_failed/);
        assert.equal(requests, 1);
        for (mode of ['error', 'large']) await assert.rejects(client.pullImage(reference, undefined, signal),
            (error: unknown) => error instanceof DockerError && error.message === 'docker_operation_failed');
        mode = 'stall'; const abort = new AbortController();
        const started = new Promise<void>(resolve => { entered = resolve; });
        const pending = client.pullImage(reference, undefined, abort.signal);
        await started; abort.abort();
        await assert.rejects(pending, /docker_operation_failed/);
    } finally {
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        await rm(directory, { recursive: true });
    }
});
