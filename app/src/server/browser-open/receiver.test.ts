import { describe, expect, it, vi } from 'vitest';
import { browserTestOrigins } from './contract';
import { handleBrowserOpen } from './receiver';

const computerId = '11111111-1111-4111-8111-111111111111';
const requestId = '33333333-3333-4333-8333-333333333333';
const path = '/api/mcp/browser-sessions/' + computerId + '/open-url';
const origin = 'http://127.0.0.1:4173';
const url = origin + '/fixture';
const principal = { userId: 'synthetic-owner', clientId: 'synthetic-client' };
const target = { sandboxId: 'synthetic-sandbox', binding: 'a'.repeat(64) };
const loaded = { ok: true, runId: requestId, finalUrl: url, title: 'Fixture', httpStatus: 404, elapsedMs: 5 };

function setup() {
    return {
        enabled: true,
        allowedOrigins: new Set([origin]),
        verify: vi.fn(async () => principal as typeof principal | null),
        target: vi.fn(async () => target as typeof target | null),
        open: vi.fn(async () => loaded as unknown),
    };
}

function post(raw = JSON.stringify({ requestId, url }), signal?: AbortSignal, suffix = '') {
    return new Request('https://os-staging.ezil.work' + path + suffix, {
        method: 'POST', body: raw, signal, headers: { 'content-type': 'application/json' },
    });
}

describe('delegated browser open URL', () => {
    it('binds exact signed bytes and checks current placement around the typed browser dispatch', async () => {
        const deps = setup();
        const raw = JSON.stringify({ requestId, url }, null, 2);
        const response = await handleBrowserOpen(post(raw), deps);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(loaded);
        expect(deps.verify).toHaveBeenCalledWith(expect.any(Headers),
            'EZIL-BROWSER-OPEN-URL/1\nPOST\n' + path + '\n' + raw, 'browserSession.openUrl', 'ezil:browser:navigate');
        expect(deps.target.mock.calls).toEqual([[principal, computerId], [principal, computerId]]);
        expect(deps.open).toHaveBeenCalledWith(principal, computerId, target, { requestId, url, timeoutMs: 15000 },
            expect.any(AbortSignal));
    });

    it('fails closed before dispatch on malformed inputs, missing authority, or wrong ownership', async () => {
        const deps = setup();
        expect((await handleBrowserOpen(post('{}'), deps)).status).toBe(400);
        expect((await handleBrowserOpen(post(undefined, undefined, '?extra=1'), deps)).status).toBe(400);
        expect((await handleBrowserOpen(post(), { ...deps, enabled: false })).status).toBe(404);
        expect(deps.verify).not.toHaveBeenCalled();
        deps.verify.mockResolvedValueOnce(null);
        expect((await handleBrowserOpen(post(), deps)).status).toBe(401);
        expect(deps.target).not.toHaveBeenCalled();
        deps.target.mockResolvedValueOnce(null);
        expect((await handleBrowserOpen(post(), deps)).status).toBe(404);
        expect(deps.open).not.toHaveBeenCalled();
    });

    it('requires an exact approved origin and excludes control ports and URL credentials', async () => {
        const deps = setup();
        expect(browserTestOrigins(origin + ',https://fixture.example')).toEqual(new Set([origin, 'https://fixture.example']));
        expect(browserTestOrigins(origin + '/path').size).toBe(0);
        for (const unsafe of [
            'http://127.0.0.1:9223/health', 'http://localhost:4173', 'https://user:secret@fixture.example/',
            'file:///example', 'https:fixture.example', 'https://127.0.0.1:9223/', 'https://test.localhost:4173/', 'https://fixture.example/\t',
        ]) {
            const response = await handleBrowserOpen(post(JSON.stringify({ requestId, url: unsafe })), deps);
            expect(response.status).toBe(400);
        }
        expect((await handleBrowserOpen(post(JSON.stringify({ requestId, url: 'https://other.example/' })), deps)).status).toBe(403);
        expect(deps.open).not.toHaveBeenCalled();
    });

    it('validates the receipt identity and origin and scrubs query and fragment from the returned URL', async () => {
        const deps = setup();
        deps.open.mockResolvedValueOnce({ ...loaded, runId: computerId });
        expect((await handleBrowserOpen(post(), deps)).status).toBe(503);
        deps.open.mockResolvedValueOnce({ ...loaded, finalUrl: 'https://other.example/' });
        expect((await handleBrowserOpen(post(), deps)).status).toBe(503);
        deps.open.mockResolvedValueOnce({ ...loaded, finalUrl: url + '?token=synthetic#private', title: '\rFixture\n' });
        const response = await handleBrowserOpen(post(), deps);
        expect(await response.json()).toEqual(loaded);
    });

    it('reports placement drift, typed retryable runtime errors and cancellation', async () => {
        const deps = setup();
        deps.target.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, binding: 'b'.repeat(64) });
        expect((await handleBrowserOpen(post(), deps)).status).toBe(409);
        const pending = { ok: false, runId: requestId, error: 'request_pending', stage: 'request', retryable: true };
        deps.open.mockResolvedValueOnce(pending);
        const response = await handleBrowserOpen(post(), deps);
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual(pending);
        const controller = new AbortController();
        const call = post(undefined, controller.signal);
        deps.open.mockImplementationOnce(async () => {
            controller.abort();
            return loaded;
        });
        expect((await handleBrowserOpen(call, deps)).status).toBe(499);
    });
});
