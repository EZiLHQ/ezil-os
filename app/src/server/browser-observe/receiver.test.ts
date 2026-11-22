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
            { browserSessionId, action: { kind: 'click', ref: 'a'.repeat(22) } },
            { browserSessionId, requestId, action: { kind: 'click', selector: 'button' } },
            { browserSessionId, requestId, action: { kind: 'navigate', url: 'https://127.0.0.1/' } },
            { browserSessionId, requestId, action: { kind: 'navigate', url: 'https://id.ezil.work/u/login' } },
            { browserSessionId, requestId, action: { kind: 'type', ref: 'a'.repeat(22), text: 'x\rEnter' } },
            { browserSessionId, requestId, action: { kind: 'press', key: 'Control+A' } },
            { browserSessionId, requestId, action: { kind: 'scroll', ref: 'a'.repeat(22), dy: 10 } },
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

describe('browser verbs v2 on the existing route', () => {
    const owner = {
        ...modern, observed: 'owner_app_page', pageUrl: 'https://universe-staging.ezil.work/builder/jobs', pageTitle: 'Jobs',
        elements: [{ ref: 'r'.repeat(22), kind: 'select', label: 'Rate unit', options: ['per hour', 'per day'] }],
        ownerAppAccountEmail: null,
    };
    const act = (action: unknown) => request(JSON.stringify({ browserSessionId, requestId, action }));

    it('signs and forwards each v2 action kind, line feeds and tabs included, under the control scope', async () => {
        for (const action of [
            { kind: 'fill_form', fields: [{ ref: 'a'.repeat(22), text: 'line one\nline two\tend' }, { ref: 'b'.repeat(22), text: 'x'.repeat(4000) }] },
            { kind: 'select', ref: 'a'.repeat(22), values: ['per day'] },
            { kind: 'scroll', dy: -400 }, { kind: 'scroll', ref: 'a'.repeat(22) },
            { kind: 'press', key: 'Shift+Tab' }, { kind: 'press', key: 'Enter', ref: 'a'.repeat(22) },
            { kind: 'navigate', url: 'https://universe-staging.ezil.work/builder/profile-builder?tab=skills' },
        ]) {
            const d = { ...deps(), controlEnabled: true };
            d.observe.mockResolvedValueOnce(owner);
            const response = await handleBrowserObserve(act(action), d);
            expect([action.kind, response.status]).toEqual([action.kind, 200]);
            expect(d.verify.mock.calls[0]?.slice(2)).toEqual(['browserSession.control', 'ezil:browser:control']);
            expect((d.observe.mock.calls[0] as unknown[] | undefined)?.[3]).toEqual({ browserSessionId, requestId, action });
        }
    });

    it('a request as large as a 20-field fill_form can be is read; one byte over 512 KiB is not', async () => {
        const text = String.fromCharCode(0xd800).repeat(4000);
        const fields = Array.from({ length: 20 }, (_, n) => ({ ref: String(n).padStart(22, 'f'), text }));
        const largest = JSON.stringify({ browserSessionId, requestId, action: { kind: 'fill_form', fields } });
        const d = { ...deps(), controlEnabled: true };
        d.observe.mockResolvedValueOnce(owner);
        expect((await handleBrowserObserve(request(largest), d)).status).toBe(200);
        expect(d.observe).toHaveBeenCalledTimes(1);
        const over = largest.slice(0, -1) + ',' + ' '.repeat(512 * 1024 - Buffer.byteLength(largest)) + '}';
        expect(Buffer.byteLength(over)).toBe(512 * 1024 + 1);
        expect((await handleBrowserObserve(request(over), d)).status).toBe(400);
        expect(d.observe).toHaveBeenCalledTimes(1);
    });

    it('answers an owner-app read with its elements, frame and account e-mail', async () => {
        const d = { ...deps(), controlEnabled: true };
        const read = { ...owner, observed: 'profile_builder', profileHeadingVisible: true, pageUrl: 'https://universe-staging.ezil.work/builder/profile-builder',
            viewerFrame: { mimeType: 'image/jpeg', base64: '/9j/2Q==' }, ownerAppAccountEmail: 'ada.builder@example.test' };
        d.observe.mockResolvedValueOnce(read);
        const response = await handleBrowserObserve(request('{"action":{"kind":"read","includeFrame":true}}'), d);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(read);
    });

    it('maps origin_read_only to 403 and a sidecar refusal to 400, and refuses an e-mail off the owner app', async () => {
        const d = { ...deps(), controlEnabled: true };
        d.observe.mockResolvedValueOnce({ ok: false, error: 'origin_read_only' });
        const refused = await handleBrowserObserve(act({ kind: 'press', key: 'Enter' }), d);
        expect([refused.status, await refused.json()]).toEqual([403, { ok: false, error: 'origin_read_only' }]);
        d.observe.mockResolvedValueOnce({ ok: false, error: 'browser_invalid_request' });
        expect((await handleBrowserObserve(act({ kind: 'press', key: 'Enter' }), d)).status).toBe(400);
        d.observe.mockResolvedValueOnce({ ...modern, ownerAppAccountEmail: 'someone@example.test' });
        expect(await (await handleBrowserObserve(act({ kind: 'press', key: 'Enter' }), d)).json())
            .toEqual({ ok: false, error: 'browser_action_uncertain' });
    });

    it('sanitises every page URL it answers with, and never answers over 160 KiB', async () => {
        const d = { ...deps(), controlEnabled: true };
        d.observe.mockResolvedValueOnce({ ...owner, pageUrl: 'https://universe-staging.ezil.work/cb?code=C1&state=S1' });
        const answer = await handleBrowserObserve(request('{"action":{"kind":"read"}}'), d);
        expect((await answer.json()).pageUrl).toBe('https://universe-staging.ezil.work/cb');
        // 64 selects of 20 three-byte options pass 160 KiB: the OS refuses to relay it rather than exceed the MCP's bound.
        const wide = String.fromCharCode(0x20ac).repeat(80);
        const elements = Array.from({ length: 64 }, (_, n) => ({ ref: String(n).padStart(22, 'h'), kind: 'select', label: 'S' + n, options: Array(20).fill(wide) }));
        d.observe.mockResolvedValueOnce({ ...owner, elements });
        const big = await handleBrowserObserve(request('{"action":{"kind":"read"}}'), d);
        expect([big.status, await big.json()]).toEqual([503, { ok: false, error: 'browser_unavailable' }]);
        // Positive control: the same page trimmed to 32 selects is relayed.
        d.observe.mockResolvedValueOnce({ ...owner, elements: elements.slice(0, 32) });
        expect((await handleBrowserObserve(request('{"action":{"kind":"read"}}'), d)).status).toBe(200);
    });
});
