import { createHash, createHmac, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStartAuthorityHandler, START_AUTHORITY_PATH, startAuthoritySignature } from './computer-start-authority-http';
import { computerControlKeyIdentity } from './computer-control-key';
import { ComputerStartWorkSchema } from './computer-start-protocol';
import { lifecycleDeployment as deployment } from '../../../tests/fixtures/lifecycle';

const key = 'ab'.repeat(32), url = 'https://control.example'+START_AUTHORITY_PATH;
const scope = { computerId: randomUUID(), computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0',
    dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() };
const policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
    controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn };
const input = ComputerStartWorkSchema.parse({ schemaVersion: 1, authorizationId: randomUUID(), mountAuthorizationId: randomUUID(),
    scope, deployment, configuration: { configurationId: randomUUID(), revision: 1, digest: 'cd'.repeat(32), bytes: 1024 },
    controlKey: { versionId: randomUUID(), policy, secretArn: `${computerControlKeyIdentity(policy, { scope }).arnPrefix}Ab12Cd` },
    issuedAt: 1800000000, expiresAt: 1800000300 });
const body = JSON.stringify(input);
function request(text = body, age = 0, realm = 'ezil-start-authority-v1', path = START_AUTHORITY_PATH, secret = key) {
    const timestamp = String(Math.floor(Date.now()/1000)+age);
    const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update([realm, 'POST', path, timestamp,
        createHash('sha256').update(text).digest('hex')].join('\n')).digest('hex');
    return new Request(url, { method: 'POST', headers: { 'content-type': 'application/json',
        'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature }, body: text });
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('startup authority HTTP', () => {
    it('binds the exact work, uses the documented signature and rechecks every replay', async () => {
        const authorize = vi.fn(async () => true), handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize });
        const req = request(), result = await handle(req.clone());
        expect(req.headers.get('x-ezil-workflow-signature')).toBe(startAuthoritySignature(Buffer.from(body), key,
            req.headers.get('x-ezil-workflow-timestamp')!));
        expect(result.status).toBe(200); expect(await result.json()).toEqual({ authorized: true, work: input });
        expect(result.headers.get('cache-control')).toBe('no-store'); expect(result.headers.get('set-cookie')).toBeNull();
        expect(authorize).toHaveBeenLastCalledWith(input);
        authorize.mockResolvedValue(false); const revoked = await handle(req);
        expect(revoked.status).toBe(403); expect(await revoked.json()).toEqual({ code: 'start_not_current' });
        expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('stays closed with disabled or invalid configuration', async () => {
        const authorize = vi.fn(async () => true);
        for (const [enabled, secret, status] of [[false, undefined, 404], [true, undefined, 503], [true, 'PRIVATE_VALUE', 503]] as const) {
            const result = await createStartAuthorityHandler({ enabled, secret, authorize })(request());
            expect(result.status).toBe(status); expect(await result.text()).not.toContain('PRIVATE_VALUE');
        }
        expect(authorize).not.toHaveBeenCalled();
        expect(() => startAuthoritySignature(Buffer.from(body), 'PRIVATE_VALUE', '1800000000')).toThrow('start_authority_signing_invalid');
        expect(() => startAuthoritySignature(Buffer.from(body), key, 'invalid')).toThrow('start_authority_signing_invalid');
    });
    it('rejects stale time, other realms, paths, keys, tampering and user credentials before the DB', async () => {
        const authorize = vi.fn(async () => true), handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize });
        const requests = [request(body, -31), request(body, 31), request(body, 0, 'ezil-mount-authority-v1'),
            request(body, 0, 'ezil-lifecycle-authority-v1'), request(body, 0, 'ezil-configuration-authority-v1'),
            request(body, 0, undefined, '/api/internal/computers/mount-authority'), request(body, 0, undefined, undefined, 'cd'.repeat(32)),
            new Request(url, { method: 'POST', headers: request().headers, body: body+' ' }),
            new Request(url, { method: 'POST', body, headers: { authorization: 'Bearer PRIVATE_SESSION', cookie: 'sb=PRIVATE_SESSION' } })];
        for (const req of requests) {
            const result = await handle(req); expect(result.status).toBe(401);
            expect(await result.json()).toEqual({ code: 'unauthorized' }); expect(result.headers.get('set-cookie')).toBeNull();
        }
        expect(authorize).not.toHaveBeenCalled();
    });
    it('strictly rejects malformed work and redacts schema failures', async () => {
        const authorize = vi.fn(async () => true), handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize });
        for (const text of ['{', JSON.stringify({ ...input, secret: 'PRIVATE_VALUE' }),
            JSON.stringify({ ...input, schemaVersion: 2 }), JSON.stringify({ ...input, expiresAt: input.expiresAt+1 }),
            JSON.stringify({ ...input, configuration: { ...input.configuration, path: '/PRIVATE_VALUE' } }),
            JSON.stringify({ ...input, controlKey: { ...input.controlKey, secretArn: 'PRIVATE_VALUE' } }),
            JSON.stringify({ ...input, scope: { ...scope, computerId: 'PRIVATE_VALUE' } })]) {
            const result = await handle(request(text)); expect(result.status).toBe(400);
            expect(await result.json()).toEqual({ code: 'invalid_request' });
        }
        expect(authorize).not.toHaveBeenCalled();
    });
    it('enforces exact path, method, declared length and unencoded JSON', async () => {
        const authorize = vi.fn(async () => true), handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize });
        for (const [target, method, extra, status] of [[url+'?x=1', 'POST', {}, 404], [url+'#x', 'POST', {}, 404],
            [url+'/extra', 'POST', {}, 404], [url, 'GET', {}, 405], [url, 'POST', { 'content-length': '16385' }, 413],
            [url, 'POST', { 'content-length': '-1' }, 413], [url, 'POST', { 'content-type': 'text/plain' }, 415],
            [url, 'POST', { 'content-encoding': 'gzip' }, 415]] as const) {
            const headers = new Headers(request().headers); for (const [k, v] of Object.entries(extra)) headers.set(k, v);
            expect((await handle(new Request(target, { method, headers, ...(method === 'POST' ? { body } : {}) }))).status).toBe(status);
        }
        expect((await handle(request('x'.repeat(16385)))).status).toBe(400);
        expect(authorize).not.toHaveBeenCalled();
    });
    it('cancels stalled or excessive streams and refuses falsely small content lengths', async () => {
        vi.useFakeTimers(); const authorize = vi.fn(async () => true), handle = createStartAuthorityHandler({ enabled: true, secret: key, authorize });
        const cancelled = vi.fn(), headers = request().headers; headers.set('content-length', '1');
        const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16385)); }, cancel: cancelled });
        const result = await handle(new Request(url, { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit));
        expect(result.status).toBe(400); expect(cancelled).toHaveBeenCalledOnce();
        const stalled = new ReadableStream({ cancel: cancelled });
        const reading = handle(new Request(url, { method: 'POST', headers, body: stalled, duplex: 'half' } as RequestInit));
        await vi.advanceTimersByTimeAsync(5100); expect((await reading).status).toBe(400);
        expect(cancelled).toHaveBeenCalledTimes(2); expect(authorize).not.toHaveBeenCalled();
    });
    it('bounds authorization time and redacts database exceptions', async () => {
        vi.useFakeTimers(); let finish!: (value: boolean) => void;
        const waiting = createStartAuthorityHandler({ enabled: true, secret: key,
            authorize: () => new Promise(resolve => { finish = resolve; }) })(request());
        await vi.advanceTimersByTimeAsync(15100); expect((await waiting).status).toBe(503); finish(true);
        const result = await createStartAuthorityHandler({ enabled: true, secret: key, authorize: async () => { throw new Error('PRIVATE_DATABASE'); } })(request());
        expect(result.status).toBe(503); expect(await result.json()).toEqual({ code: 'start_authority_unavailable' });
    });
    it.each(['disable', 'cancel', 'stale'])('rejects %s during authorization', async kind => {
        const controller = new AbortController(), req = new Request(request(), { signal: controller.signal }), now = Date.now();
        const options = { enabled: true, secret: key, authorize: async () => {
            if (kind === 'disable') options.enabled = false;
            if (kind === 'cancel') controller.abort();
            if (kind === 'stale') vi.spyOn(Date, 'now').mockReturnValue(now+31000);
            return true;
        } };
        expect([401, 403, 503]).toContain((await createStartAuthorityHandler(options)(req)).status);
    });
    it('does not authorize an already cancelled request or let the authorizer mutate the response', async () => {
        const authorize = vi.fn(async () => true), controller = new AbortController(); controller.abort();
        const req = new Request(request(), { signal: controller.signal });
        expect((await createStartAuthorityHandler({ enabled: true, secret: key, authorize })(req)).status).toBe(400);
        expect(authorize).not.toHaveBeenCalled();
        const result = await createStartAuthorityHandler({ enabled: true, secret: key, authorize: async work => {
            work.scope.computerId = randomUUID(); work.configuration.digest = 'ef'.repeat(32); return true;
        } })(request());
        expect(await result.json()).toEqual({ authorized: true, work: input });
    });
});
