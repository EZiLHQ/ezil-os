import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { ControlStore } from '../src/control-store.js';
import { createControlService } from '../src/control-server.js';
import { signControlRequest } from '../src/control-auth.js';
import { command, computerId } from './control-fixture.js';

test('real HTTP control requires signatures and scope; status does not execute or wake a service', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezil-control-http-'));
    const store = new ControlStore(directory, computerId, 1);
    const secret = Buffer.alloc(32, 44);
    let starts = 0, observations = 0;
    let approved = true;
    const service = createControlService({ computerId, computerGeneration: 1, secret, store, approvePlan: () => approved,
        driver: { reconcile: async () => { starts++; return 'running'; },
            observe: async () => { observations++; return { state: 'stopped', privateDriverField: 'must-not-leak' }; } } });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1/control`;
    const send = async (value: unknown, signed = true, override?: Record<string, string>) => {
        const body = Buffer.from(JSON.stringify(value));
        const headers = signed ? signControlRequest('POST', '/v1/control', body, secret) : {};
        return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json',
            ...headers as Record<string, string>, ...override } });
    };
    try {
        assert.equal((await send(command(), false)).status, 401);
        assert.equal((await send({ ...command(), computerId: randomUUID() })).status, 403);
        const invalid = await send({ ...command(), arbitraryHostPath: 'sensitive-input' });
        assert.equal(invalid.status, 400);
        assert.ok(!JSON.stringify(await invalid.json()).includes('sensitive-input'));
        assert.equal(starts, 0);
        const request = command();
        assert.equal((await send(request)).status, 202);
        await service.drain();
        assert.equal(starts, 1);
        const observed = { schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1,
            installationId: request.installationId, operation: 'observe' };
        assert.deepEqual(await (await send(observed)).json(), { installationId: request.installationId, state: 'stopped' });
        assert.equal(starts, 1);
        assert.equal(observations, 1);
        approved = false;
        const newer = { ...request, generation: 2, requestId: randomUUID(), desired: 'stopped' };
        assert.equal((await send(newer)).status, 202);
        await service.drain();
        approved = true;
        assert.equal((await send({ ...request, requestId: randomUUID() })).status, 409);
        const body = Buffer.from(JSON.stringify(observed));
        const fixed = signControlRequest('POST', '/v1/control', body, secret) as Record<string, string>;
        assert.equal((await send(observed, true, fixed)).status, 200);
        assert.equal((await send(observed, true, fixed)).status, 401);
    } finally {
        service.server.close(); service.server.closeAllConnections();
        await service.drain(); store.close(); await rm(directory, { recursive: true, force: true });
    }
});
