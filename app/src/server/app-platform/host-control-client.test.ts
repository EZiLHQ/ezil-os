import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostControlClient, hostIntentDigest, type HostCommand } from './host-control-client';
import { compileRuntimePlan } from './runtime-plan';
import { runtimeRecords } from '../../../tests/fixtures/runtime-release';

const secret = Buffer.alloc(32, 23);
const scope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-test', fenceToken: randomUUID(), dataVolumeId: 'vol-test' };
const installationId = randomUUID();
const command: HostCommand = { ...scope, schemaVersion: 1, requestId: randomUUID(), installationId, operation: 'reconcile',
    generation: 1, desired: 'running', plan: compileRuntimePlan(runtimeRecords('node')) };
// Strip provisioning handles from the actual wire fixture.
const request: HostCommand = { schemaVersion: 1, requestId: command.requestId, computerId: scope.computerId,
    computerGeneration: 1, installationId, operation: 'reconcile', generation: 1, desired: 'running', plan: command.plan };
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } });
const serve = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
    const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};
const observation = () => ({ computerId: scope.computerId, computerGeneration: 1, installationId, generation: 1,
    desired: 'running', intentDigest: hostIntentDigest(request), state: 'running', settled: true, runtimeDeadlineMs: Date.now() + 10000 });

describe('bounded supervisor client', () => {
    it('reads the signed loaded configuration without sending installation IDs or provisioning handles', async () => {
        const descriptor = { computerId: scope.computerId, computerGeneration: scope.computerGeneration,
            configurationRevision: 7, configurationDigest: 'a'.repeat(64) };
        const origin = await serve((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
            const value = JSON.parse(body) as Record<string, unknown>;
            expect(Object.keys(value).sort()).toEqual(['schemaVersion', 'requestId', 'computerId', 'computerGeneration', 'operation'].sort());
            expect(value.operation).toBe('configuration');
            expect(req.headers['x-ezil-signature']).toMatch(/^[a-f0-9]{64}$/);
            res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(descriptor));
        }); });
        const client = createHostControlClient({ ...scope, secret, origin }, { privateValidation: true });
        await expect(client.configuration()).resolves.toEqual(descriptor);
    });
    it('rejects unavailable, cross-generation, prefixed-digest or malformed loaded descriptors', async () => {
        for (const fields of [{ computerId: randomUUID() }, { computerGeneration: 2 }, { configurationRevision: 0 },
            { configurationDigest: `sha256:${'a'.repeat(64)}` }, { secret: 'sensitive-sentinel' }]) {
            const origin = await serve((_req, res) => {
                res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ computerId: scope.computerId,
                    computerGeneration: 1, configurationRevision: 1, configurationDigest: 'a'.repeat(64), ...fields }));
            });
            await expect(createHostControlClient({ ...scope, secret, origin }, { privateValidation: true }).configuration())
                .rejects.toThrow(/^host_response_invalid$/);
        }
        const origin = await serve((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 'computer_configuration_unavailable' })); });
        await expect(createHostControlClient({ ...scope, secret, origin }, { privateValidation: true }).configuration())
            .rejects.toThrow(/^host_rejected$/);
    });
    it('rejects mutable target identity, invalid configurations and cross-computer replies', async () => {
        expect(() => createHostControlClient({ ...scope, secret, origin: 'http://127.0.0.1:1234' })).toThrow('invalid_host_control_configuration');
        expect(() => createHostControlClient({ ...scope, secret, origin: 'https://secret:password@example.com' })).toThrow('invalid_host_control_configuration');
        const origin = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ...observation(), computerId: randomUUID() })); });
        const target = { ...scope, secret, origin };
        const client = createHostControlClient(target, { privateValidation: true });
        target.origin = 'https://should-never-be-requested.invalid';
        expect(Object.isFrozen(client.scope)).toBe(true);
        await expect(client.observe(installationId)).rejects.toThrow('host_response_invalid');
    });
    it('retries use identical command bytes and distinct nonce signatures; 202 is only a receipt', async () => {
        const nonces = new Set<string>(), bodies: string[] = [];
        const origin = await serve((req, res) => { let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
            bodies.push(body); nonces.add(String(req.headers['x-ezil-nonce']));
            expect(req.headers.authorization).toBeUndefined(); expect(req.headers.cookie).toBeUndefined();
            expect(req.headers['x-ezil-signature']).toMatch(/^[a-f0-9]{64}$/);
            res.writeHead(202, { 'content-type': 'application/json' }); res.end(JSON.stringify({ requestId: request.requestId,
                installationId, generation: 1, state: 'queued', reused: bodies.length > 1 }));
        }); });
        const client = createHostControlClient({ ...scope, secret, origin }, { privateValidation: true });
        await client.reconcile(request); await client.reconcile(request);
        expect(nonces.size).toBe(2); expect(bodies[0]).toBe(bodies[1]);
        expect(bodies[0]).not.toContain('providerInstanceId');
    });
    it('does not follow redirects or echo oversized/malformed upstream data', async () => {
        let leaked = 0;
        const redirectTarget = await serve((_req, res) => { leaked++; res.end(); });
        const origin = await serve((_req, res) => { res.writeHead(302, { location: redirectTarget }); res.end(); });
        await expect(createHostControlClient({ ...scope, secret, origin }, { privateValidation: true }).observe(installationId))
            .rejects.toThrow('host_unavailable');
        expect(leaked).toBe(0);
        for (const body of ['{"secret":"must-not-leak"', 'x'.repeat(20000)]) {
            const bad = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body); });
            await expect(createHostControlClient({ ...scope, secret, origin: bad }, { privateValidation: true }).observe(installationId))
                .rejects.toThrow(/^host_response_invalid$/);
        }
    });
    it('rejects missing generation and mismatched acceptance receipts', async () => {
        const origin = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ installationId, state: 'running' })); });
        const client = createHostControlClient({ ...scope, secret, origin }, { privateValidation: true });
        await expect(client.observe(installationId)).rejects.toThrow('host_response_invalid');
        await expect(client.reconcile(request)).rejects.toThrow('host_rejected');
    });
});
