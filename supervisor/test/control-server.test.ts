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
import { intentDigest } from '../src/control-protocol.js';

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
        assert.deepEqual(await (await send(observed)).json(), { computerId, computerGeneration: 1,
            installationId: request.installationId, generation: 1, desired: 'running', intentDigest: intentDigest(request),
            state: 'stopped', settled: false, runtimeDeadlineMs: null });
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

test('observations bind committed intent and reject a newer Stop arriving during a slow read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'ezil-control-race-'));
    const store = new ControlStore(directory, computerId, 1);
    const secret = Buffer.alloc(32, 45);
    let finishStart!: () => void;
    const starting = new Promise<void>(resolve => { finishStart = resolve; });
    let finishObserve: (() => void) | undefined;
    let didObserve!: () => void;
    const observing = new Promise<void>(resolve => { didObserve = resolve; });
    let state: 'running' | 'stopped' = 'running';
    const service = createControlService({ computerId, computerGeneration: 1, secret, store, approvePlan: () => true,
        driver: {
            reconcile: async intent => { await starting; state = intent.desired; return state; },
            observe: async () => { const snapshot = state;
                if (finishObserve) { didObserve(); await new Promise<void>(resolve => { finishObserve = resolve; }); }
                return { state: snapshot };
            },
        } });
    service.server.listen(0, '127.0.0.1');
    await once(service.server, 'listening');
    const url = `http://127.0.0.1:${(service.server.address() as AddressInfo).port}/v1/control`;
    const send = async (value: unknown) => {
        const body = Buffer.from(JSON.stringify(value));
        return fetch(url, { method: 'POST', body, headers: { 'content-type': 'application/json',
            ...signControlRequest('POST', '/v1/control', body, secret) as Record<string, string> } });
    };
    const start = command();
    const observe = { schemaVersion: 1, requestId: randomUUID(), computerId, computerGeneration: 1,
        installationId: start.installationId, operation: 'observe' };
    try {
        assert.equal((await send(start)).status, 202);
        const expires = store.reserveRuntimeDeadline(start, Date.now() + 1000);
        const pending = await (await send(observe)).json() as Record<string, unknown>;
        assert.equal(pending.state, 'running');
        assert.equal(pending.settled, false);
        assert.equal(pending.runtimeDeadlineMs, expires);
        finishStart(); await service.drain();
        const ready = await (await send(observe)).json() as Record<string, unknown>;
        assert.equal(ready.settled, true);
        assert.equal(ready.intentDigest, intentDigest(start));
        assert.equal(ready.runtimeDeadlineMs, expires);
        finishObserve = () => {};
        const stale = send(observe);
        await observing;
        const stop = { ...start, requestId: randomUUID(), generation: 2, desired: 'stopped' as const };
        assert.equal((await send(stop)).status, 202);
        await service.drain();
        finishObserve!(); finishObserve = undefined;
        const result = await stale;
        assert.equal(result.status, 409);
        assert.deepEqual(await result.json(), { code: 'observation_superseded' });
        const stopped = await (await send(observe)).json() as Record<string, unknown>;
        assert.equal(stopped.generation, 2);
        assert.equal(stopped.state, 'stopped');
        assert.equal(stopped.settled, true);
        assert.equal(stopped.intentDigest, intentDigest(stop));
        assert.equal(stopped.runtimeDeadlineMs, null);
    } finally {
        finishStart(); finishObserve?.();
        service.server.close(); service.server.closeAllConnections();
        await service.drain(); store.close(); await rm(directory, { recursive: true, force: true });
    }
});
