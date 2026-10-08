import { describe, expect, it, vi } from 'vitest';

import { getActivePlan, HttpEntitlementSource } from './entitlement-source';

const now = Date.parse('2026-10-08T00:00:00Z');

function source(body: unknown, status = 200) {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(body, { status }));
    const getAccessToken = vi.fn(async () => 'user-token');
    return { fetch, getAccessToken, source: new HttpEntitlementSource({
        baseUrl: 'https://gateway.example/unused', fetch, getAccessToken, now: () => now,
    }) };
}

describe('HTTP entitlements', () => {
    it('uses the user-scoped token, GET /v1/me/plan, no cache, timeout and no redirects', async () => {
        const fixture = source({ plan: 'subscriber', periodEnd: '2026-11-08T00:00:00Z', shapes: ['standard', 'performance'] });
        await expect(fixture.source.getPlan('user-one')).resolves.toEqual({ plan: 'subscriber', periodEnd: '2026-11-08T00:00:00Z' });
        expect(fixture.getAccessToken).toHaveBeenCalledWith('user-one');
        expect(String(fixture.fetch.mock.calls[0]![0])).toBe('https://gateway.example/v1/me/plan');
        expect(fixture.fetch).toHaveBeenCalledWith(expect.any(URL), expect.objectContaining({
            method: 'GET', cache: 'no-store', redirect: 'error', signal: expect.any(AbortSignal),
            headers: { Authorization: 'Bearer user-token', Accept: 'application/json' },
        }));
    });

    it.each([
        null, {}, { plan: 'enterprise', periodEnd: '2099-01-01' },
        { plan: 'free', shapes: ['performance'] },
        { plan: 'subscriber', periodEnd: null }, { plan: 'subscriber', periodEnd: 'invalid' },
        { plan: 'subscriber', periodEnd: '2026-10-08T00:00:00Z' },
        { plan: 'subscriber', periodEnd: '2026-09-01T00:00:00Z' },
    ])('fails closed for invalid or expired plans: %j', async (body) => {
        await expect(source(body).source.getPlan('user')).resolves.toEqual({ plan: 'free', periodEnd: null });
    });

    it.each([401, 403, 500, 503])('fails closed for HTTP %s', async (status) => {
        await expect(source({ plan: 'subscriber', periodEnd: '2099-01-01' }, status).source.getPlan('user'))
            .resolves.toEqual({ plan: 'free', periodEnd: null });
    });

    it('fails closed on transport, token and JSON errors', async () => {
        const fixture = source({});
        fixture.fetch.mockRejectedValueOnce(new Error('offline'));
        await expect(fixture.source.getPlan('user')).resolves.toEqual({ plan: 'free', periodEnd: null });
        fixture.fetch.mockResolvedValueOnce(new Response('not JSON'));
        await expect(fixture.source.getPlan('user')).resolves.toEqual({ plan: 'free', periodEnd: null });
        fixture.getAccessToken.mockRejectedValueOnce(new Error('no session'));
        await expect(fixture.source.getPlan('user')).resolves.toEqual({ plan: 'free', periodEnd: null });
    });

    it('does not request a plan when unconfigured or missing a token', async () => {
        const fetch = vi.fn();
        await expect(new HttpEntitlementSource({ fetch }).getPlan('user')).resolves.toEqual({ plan: 'free', periodEnd: null });
        await new HttpEntitlementSource({ baseUrl: 'https://gateway.example', fetch, getAccessToken: async () => null }).getPlan('user');
        expect(fetch).not.toHaveBeenCalled();
    });

    it('does not cache a previous grant and fails closed even with a throwing custom source', async () => {
        const fixture = source({ plan: 'subscriber', periodEnd: '2099-01-01' });
        expect((await fixture.source.getPlan('user')).plan).toBe('subscriber');
        fixture.fetch.mockResolvedValueOnce(Response.json({ plan: 'free', periodEnd: null }));
        expect((await fixture.source.getPlan('user')).plan).toBe('free');
        expect(await getActivePlan({ getPlan: async () => { throw new Error('offline'); } }, 'user')).toBe('free');
    });
});
