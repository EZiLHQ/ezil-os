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
