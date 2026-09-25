import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfigurationAuthorityHandler } from './configuration-authority-http';
import { CONFIGURATION_AUTHORITY_PATH, ConfigurationAuthorityRequestSchema,
    configurationAuthoritySignature, type ConfigurationAuthorityRequest } from './configuration-authority-protocol';

const secret = 'ab'.repeat(32);
const input: ConfigurationAuthorityRequest = { schemaVersion: 1,
    configurationId: '11111111-1111-4111-8111-111111111111', operation: 'prepare', revision: 1, digest: 'a'.repeat(64),
    scope: { computerId: '22222222-2222-4222-8222-222222222222', computerGeneration: 1,
        providerInstanceId: 'i-0123456789abcdef0', dataVolumeId: 'vol-0123456789abcdef0',
        fenceToken: '33333333-3333-4333-8333-333333333333' } };
const url = `https://control.example${CONFIGURATION_AUTHORITY_PATH}`;
const body = JSON.stringify(input);
function signed(raw = body, timestamp = String(Math.floor(Date.now() / 1000))) {
    // Independent transcript construction checks interoperability rather than
    // using the production signer on both sides of every request.
    const hash = createHash('sha256').update(raw).digest('hex');
    const signature = createHmac('sha256', Buffer.from(secret, 'hex')).update([
        'ezil-configuration-authority-v1', 'POST', CONFIGURATION_AUTHORITY_PATH, timestamp, hash,
    ].join('\n')).digest('hex');
    return { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature };
}
const request = (raw = body, headers: HeadersInit = signed(raw)) => new Request(url, { method: 'POST', headers, body: raw });
const authorize = vi.fn<(input: ConfigurationAuthorityRequest) => Promise<boolean>>(async () => true);
const handle = createConfigurationAuthorityHandler({ enabled: true, secret, authorize });
async function denied(req: Request, status: number) {
    const result = await handle(req);
    expect(result.status).toBe(status); expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.text()).not.toContain(secret);
    expect(authorize).not.toHaveBeenCalled();
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); authorize.mockResolvedValue(true); });

describe('workflow configuration authority HTTP boundary', () => {
    it('authenticates exact bytes and returns only the checked reference, never a session', async () => {
        const headers = signed();
        expect(configurationAuthoritySignature(Buffer.from(body), secret, headers['x-ezil-workflow-timestamp']))
            .toBe(headers['x-ezil-workflow-signature']);
        const response = await handle(request(body, headers));
        expect(response.status).toBe(200); expect(await response.json()).toEqual({ authorized: true, ...input });
        expect(authorize).toHaveBeenCalledExactlyOnceWith(input);
        expect(response.headers.get('set-cookie')).toBeNull(); expect(response.headers.get('cache-control')).toBe('no-store');
    });
    it('performs no authorization work when disabled or missing a valid dedicated key', async () => {
        for (const [enabled, key, status] of [[false, undefined, 404], [true, undefined, 503], [true, 'invalid', 503]] as const) {
            const result = await createConfigurationAuthorityHandler({ enabled, secret: key, authorize })(request());
            expect(result.status).toBe(status); expect(result.headers.get('cache-control')).toBe('no-store');
        }
        expect(authorize).not.toHaveBeenCalled();
    });
    it('does not accept cookie or bearer identity in place of workflow authentication', async () => {
        await denied(request(body, { ...signed(), 'x-ezil-workflow-signature': '' }), 401);
        await denied(new Request(url, { method: 'POST', body, headers: { 'content-type': 'application/json',
            cookie: 'sb-session=sensitive-sentinel', authorization: 'Bearer sensitive-sentinel' } }), 401);
    });
    it('rejects other paths, query strings and methods before database access', async () => {
        for (const address of [`${url}?ignored=1`, `${url}/extra`, `${url}#fragment`]) {
            await denied(new Request(address, { method: 'POST', headers: signed(), body }), 404);
        }
        await denied(new Request(url, { method: 'GET', headers: signed() }), 405);
    });
    it('rejects forged signatures and mutations of signed bytes', async () => {
        for (const value of ['A'.repeat(64), 'g'.repeat(64), 'a'.repeat(63), '0'.repeat(64)]) {
            await denied(request(body, { ...signed(), 'x-ezil-workflow-signature': value }), 401);
        }
        await denied(request(`${body} `, signed()), 401);
        expect(() => configurationAuthoritySignature(Buffer.from(body), 'sensitive-sentinel', '1234567890'))
            .toThrow('configuration_authority_signing_invalid');
    });
    it('rejects expired, future and malformed timestamps', async () => {
        const now = Math.floor(Date.now() / 1000);
        for (const time of [String(now - 31), String(now + 31), '123', '1'.repeat(11), 'NaN']) {
            await denied(request(body, signed(body, time)), 401);
        }
    });
    it('rejects encoding and content types outside the protocol', async () => {
        await denied(request(body, { ...signed(), 'content-encoding': 'gzip' }), 415);
        for (const type of ['text/plain', '', 'application/json; charset=latin1']) {
            await denied(request(body, { ...signed(), 'content-type': type }), 415);
        }
    });
    it('bounds advertised and actual bytes without relying on Content-Length', async () => {
        for (const length of ['4097', '-1', 'invalid', '1'.repeat(100)]) {
            await denied(request(body, { ...signed(), 'content-length': length }), 413);
        }
        await denied(request(' '.repeat(4097)), 400);
    });
    it('rejects invalid JSON and strict schema changes without echoing values', async () => {
        for (const value of ['{"secret":"sensitive-sentinel"', JSON.stringify({ ...input, secret: 'sensitive-sentinel' }),
            JSON.stringify({ ...input, schemaVersion: 2 }), JSON.stringify({ ...input, scope: { ...input.scope, root: '/private' } })]) {
            const result = await handle(request(value)); expect(result.status).toBe(400);
            expect(await result.json()).toEqual({ code: 'invalid_request' });
        }
        expect(authorize).not.toHaveBeenCalled();
        for (const change of [{ operation: 'start' }, { revision: 0 }, { digest: 'sha256:' + input.digest },
            { configurationId: 'invalid' }, { scope: { ...input.scope, providerInstanceId: 'i-12345678' } },
            { scope: { ...input.scope, computerGeneration: 0 } }]) {
            expect(ConfigurationAuthorityRequestSchema.safeParse({ ...input, ...change }).success).toBe(false);
        }
    });
    it('rechecks the same signed request on each use and denies after revocation', async () => {
        const req = request(); expect((await handle(req.clone())).status).toBe(200);
        authorize.mockResolvedValueOnce(false);
        expect((await handle(req.clone())).status).toBe(403); expect(authorize).toHaveBeenCalledTimes(2);
    });
    it('does not expose database exception details', async () => {
        authorize.mockRejectedValueOnce(new Error('sensitive-sentinel'));
        const response = await handle(request()); expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ code: 'configuration_authority_unavailable' });
    });

    function streaming(raw: string, timestamp?: string, signal?: AbortSignal) {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const cancel = vi.fn();
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; }, cancel });
        const req = new Request(url, { method: 'POST', headers: signed(raw, timestamp), body: stream,
            signal, duplex: 'half' } as RequestInit);
        return { req, controller, cancel, stream };
    }
    it('rejects a signature that expires while a slow body arrives', async () => {
        vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
        const s = streaming(body, '1799999971'); const pending = handle(s.req);
        await vi.advanceTimersByTimeAsync(2000);
        s.controller.enqueue(Buffer.from(body)); s.controller.close();
        expect((await pending).status).toBe(401); expect(authorize).not.toHaveBeenCalled(); expect(s.stream.locked).toBe(false);
    });
    it('cancels hung bodies at five seconds and releases the reader', async () => {
        vi.useFakeTimers(); const s = streaming(body); const pending = handle(s.req);
        await vi.advanceTimersByTimeAsync(5000);
        expect((await pending).status).toBe(400); expect(s.cancel).toHaveBeenCalledOnce();
        expect(s.stream.locked).toBe(false); expect(authorize).not.toHaveBeenCalled();
    });
    it('cancels overflow and disconnected bodies and releases their readers', async () => {
        for (const kind of ['overflow', 'abort', 'already-aborted']) {
            const abort = new AbortController(); if (kind === 'already-aborted') abort.abort();
            const s = streaming(body, undefined, abort.signal); const pending = handle(s.req);
            if (kind === 'overflow') s.controller.enqueue(new Uint8Array(4097)); else abort.abort();
            expect((await pending).status).toBe(400); expect(s.cancel).toHaveBeenCalledOnce();
            expect(s.stream.locked).toBe(false);
        }
        expect(authorize).not.toHaveBeenCalled();
    });
    it('never returns success after disconnection or expiration during database work', async () => {
        vi.useFakeTimers();
        const abort = new AbortController();
        authorize.mockImplementationOnce(async () => { abort.abort(); return true; });
        expect((await handle(new Request(request(), { signal: abort.signal }))).status).toBe(400);
        authorize.mockImplementationOnce(async () => { vi.setSystemTime(Date.now() + 31_000); return true; });
        expect((await handle(request())).status).toBe(401);
    });
});
