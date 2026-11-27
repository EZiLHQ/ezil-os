import { describe, expect, it, vi } from 'vitest';
import { handleBrowserObserve } from './receiver';

const computer = '11111111-1111-4111-8111-111111111111';
const path = '/api/mcp/browser-sessions/' + computer + '/observe';
const browserSessionId = 'a'.repeat(43);
const now = Date.parse('2026-11-20T00:00:00.000Z');
const safe = {
    ok: true, browserSessionId, expiresAt: new Date(now + 120_000).toISOString(),
    observed: 'profile_builder', profileHeadingVisible: true, universeIdentity: 'unverified',
};
const target = { sandboxId: 'sandbox-test', binding: 'a'.repeat(64) };
const principal = { userId: 'owner-test', clientId: 'client-test' };
function deps() {
    return { enabled: true, verify: vi.fn(async () => principal as typeof principal | null),
        target: vi.fn(async () => target as typeof target | null), observe: vi.fn(async () => safe as unknown), now: () => now };
}
function request(raw = '{}', suffix = '') {
    return new Request('https://os-staging.ezil.work' + path + suffix, {
        method: 'POST', body: raw, headers: { 'content-type': 'application/json' },
    });
}
describe('delegated browser observation', () => {
    it('binds the exact request bytes, verified owner and same placement before and after', async () => {
        const d = deps();
        const raw = '{ "browserSessionId":"' + browserSessionId + '" }';
        const response = await handleBrowserObserve(request(raw), d);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(safe);
        expect(d.verify).toHaveBeenCalledWith(expect.any(Headers), 'EZIL-BROWSER-OBSERVE/1\nPOST\n' + path + '\n' + raw, 'browserSession.observe', 'ezil:browser:read');
        expect(d.target.mock.calls).toEqual([[principal, computer], [principal, computer]]);
        expect(d.observe).toHaveBeenCalledWith(principal, computer, target, { browserSessionId });
    });

    it('rejects a wrong principal and a missing/foreign placement before any browser call', async () => {
        const d = deps();
        d.verify.mockResolvedValueOnce(null);
        expect((await handleBrowserObserve(request(), d)).status).toBe(401);
        expect(d.target).not.toHaveBeenCalled();
        d.target.mockResolvedValueOnce(null);
        expect((await handleBrowserObserve(request(), d)).status).toBe(404);
        expect(d.observe).not.toHaveBeenCalled();
    });

    it('fails closed on untrusted selector, oversize input, unsigned query, or disabled config', async () => {
        const d = deps();
        expect((await handleBrowserObserve(request('{"selector":"input"}'), d)).status).toBe(400);
        expect((await handleBrowserObserve(request(' '.repeat(1025)), d)).status).toBe(400);
        expect((await handleBrowserObserve(request('{}', '?ignored=1'), d)).status).toBe(400);
        expect((await handleBrowserObserve(request(), { ...d, enabled: false })).status).toBe(404);
        expect(d.verify).not.toHaveBeenCalled();
    });

    it('refuses placement drift, expired sessions, and secret-bearing provider replies', async () => {
        const d = deps();
        d.target.mockResolvedValueOnce(target).mockResolvedValueOnce({ ...target, binding: 'b'.repeat(64) });
        expect((await handleBrowserObserve(request(), d)).status).toBe(409);
        d.observe.mockResolvedValueOnce({ ...safe, expiresAt: new Date(now - 1).toISOString() });
        expect((await handleBrowserObserve(request(), d)).status).toBe(503);
        d.observe.mockResolvedValueOnce({ ...safe, title: 'synthetic provider secret' });
        const refused = await handleBrowserObserve(request(), d);
        expect(refused.status).toBe(503);
        expect(await refused.json()).toEqual({ ok: false, error: 'browser_unavailable' });
    });
});

const requestId = '7bb70a50-cd7d-40f8-9539-45aee597ea48';
const modern = {
    ...safe,
    observed: 'approved_page',
    profileHeadingVisible: false,
    pageUrl: 'https://example.com/',
    pageTitle: 'Example Domain',
    elements: [],
    viewerFrame: null,
};

describe('delegated Browser UI session on the existing route', () => {
    it('binds a modern attach and optional frame to a separate read scope', async () => {
        const d = { ...deps(), controlEnabled: true };
        const projected = { ...modern, viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/2Q==' } };
        d.observe.mockResolvedValueOnce(projected);
        const raw = '{"action":{"kind":"read","includeFrame":true}}';
        const response = await handleBrowserObserve(request(raw), d);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(projected);
        expect(d.verify).toHaveBeenCalledWith(expect.any(Headers), 'EZIL-BROWSER-PAGE/1\nPOST\n' + path + '\n' + raw,
            'browserSession.readPage', 'ezil:browser:page:read');
        expect(d.target.mock.calls).toEqual([[principal, computer], [principal, computer]]);
    });

    it('binds a typed action to its distinct write scope and exact bytes', async () => {
        const d = { ...deps(), controlEnabled: true };
        d.observe.mockResolvedValueOnce(modern);
        const raw = JSON.stringify({ browserSessionId, requestId, action: { kind: 'navigate', url: 'https://example.com/' } });
        expect((await handleBrowserObserve(request(raw), d)).status).toBe(200);
        expect(d.verify).toHaveBeenCalledWith(expect.any(Headers), 'EZIL-BROWSER-CONTROL/1\nPOST\n' + path + '\n' + raw,
            'browserSession.control', 'ezil:browser:control');
        expect(d.observe).toHaveBeenCalledWith(principal, computer, target, JSON.parse(raw));
    });

    it('rejects action gates, private URLs, arbitrary selectors and absent mutation handles before signing', async () => {
        const d = { ...deps(), controlEnabled: true };
        const allowed = '{"action":{"kind":"read"}}';
        expect((await handleBrowserObserve(request(allowed), { ...d, controlEnabled: false })).status).toBe(404);
        const invalid = [
            { action: { kind: 'click', ref: 'a'.repeat(22) } },
            { browserSessionId, action: { kind: 'click', selector: 'button' } },
            { browserSessionId, action: { kind: 'navigate', url: 'https://127.0.0.1/' } },
            { browserSessionId, action: { kind: 'navigate', url: 'https://example.com/?password=no' } },
            { browserSessionId, action: { kind: 'type', ref: 'a'.repeat(22), text: 'x\nEnter' } },
        ];
        for (const value of invalid) {
            expect((await handleBrowserObserve(request(JSON.stringify(value)), d)).status).toBe(400);
        }
        expect(d.verify).not.toHaveBeenCalled();
        expect(d.observe).not.toHaveBeenCalled();
    });

    it('distinguishes a stale prior ref from an uncertain dispatched operation and blocks unsolicited frames', async () => {
        const d = { ...deps(), controlEnabled: true };
        const raw = JSON.stringify({ browserSessionId, requestId, action: { kind: 'click', ref: 'a'.repeat(22) } });
        d.observe.mockResolvedValueOnce({ ok: false, error: 'browser_session_stale' });
        expect((await handleBrowserObserve(request(raw), d)).status).toBe(409);
        d.observe.mockRejectedValueOnce(new Error('no reply'));
        expect(await (await handleBrowserObserve(request(raw), d)).json())
            .toEqual({ ok: false, error: 'browser_action_uncertain' });
        d.observe.mockResolvedValueOnce({ ...modern, viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/2Q==' } });
        expect(await (await handleBrowserObserve(request(raw), d)).json())
            .toEqual({ ok: false, error: 'browser_action_uncertain' });
    });
});
