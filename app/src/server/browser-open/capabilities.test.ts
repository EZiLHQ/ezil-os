import { describe, expect, it, vi } from 'vitest';
import { handleBrowserCapabilities } from './receiver';

const id = '87fc8cee-4b15-4e17-a204-6d039a98a9c2';
const path = '/api/mcp/browser-sessions/' + id + '/capabilities';
const body = '{"capability":"browser_open_url"}';
const target = { sandboxId: 'sandbox', binding: 'bead' };

function request(p = path, raw = body) {
    return new Request('https://os.ezil.work' + p, {
        method: 'POST', body: raw, headers: { 'content-type': 'application/json', authorization: 'EZiL-Delegation fixture' },
    });
}

function dependencies() {
    return {
        enabled: true,
        verify: vi.fn(async () => ({ userId: 'owner', clientId: 'connector' })),
        target: vi.fn(async () => target),
        ready: vi.fn(async () => ({ ok: true, capability: 'browser_open_url' })),
    };
}

describe('signed browser capability proof', () => {
    it('binds the literal body, read scope and computer, and returns a closed proof only after rechecking placement', async () => {
        const deps = dependencies();
        const response = await handleBrowserCapabilities(request(), deps);
        expect(response.status).toBe(200);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.json()).toEqual({ ok: true, computerId: id, capability: 'browser_open_url' });
        expect(deps.verify).toHaveBeenCalledWith(expect.any(Headers), ['EZIL-BROWSER-CAPABILITIES/1', 'POST', path, body].join('\n'),
            'browserSession.capabilities', 'ezil:computers:read');
        expect(deps.target).toHaveBeenCalledTimes(2);
        expect(deps.ready).toHaveBeenCalledTimes(1);
    });

    it('conceals disabled, modified, unauthorized, stale and unavailable runtime variants', async () => {
        const cases = [
            { ...dependencies(), enabled: false },
            { ...dependencies(), verify: vi.fn(async () => null) },
            { ...dependencies(), target: vi.fn(async () => null) },
            { ...dependencies(), target: vi.fn(async () => target).mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, binding: 'changed' }) },
            { ...dependencies(), ready: vi.fn(async () => ({ ok: true, capability: 'browser_open_url', extra: true })) },
            { ...dependencies(), ready: vi.fn(async () => ({ ok: false })) },
        ];
        for (const deps of cases) {
            const answer = await handleBrowserCapabilities(request(), deps);
            expect(answer.status).toBe(404);
            expect(await answer.json()).toEqual({ ok: false, error: 'browser_unavailable' });
        }
        for (const sent of [request(path + '?unsigned'), request(path, '{ "capability": "browser_open_url" }')]) {
            const deps = dependencies();
            expect((await handleBrowserCapabilities(sent, deps)).status).toBe(404);
            expect(deps.ready).not.toHaveBeenCalled();
        }
    });
});
