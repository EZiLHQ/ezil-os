import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owned: true, signedIn: true }));
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('Unexpected billing operation'); } }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure,
        createTRPCContext: async () => ({ user: state.signedIn ? { id: userId } : null,
            db: { query: { computers: { findFirst: async () => state.owned ? { id: computerId } : undefined } } } }) };
});
vi.mock('@/server/api/root', async () => {
    const { cloudflareGuacamoleRouter } = await import('@/server/api/routers/cloudflare-guacamole');
    return { appRouter: { createCaller: (ctx: Parameters<typeof cloudflareGuacamoleRouter.createCaller>[0]) => ({
        cloudflareGuacamole: cloudflareGuacamoleRouter.createCaller(ctx),
    }) } };
});
vi.mock('@/server/lib/cloudflare-guacamole-provider', async original => ({
    ...await original<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
}));

import { deriveGuacamoleSandboxId, resetNekoAdminTokenCacheForTests } from '@/server/lib/cloudflare-guacamole-provider';
import { GET } from './route';

const origin = `https://aws-8181-${deriveGuacamoleSandboxId(userId, computerId)}-aws.preview.example`;
const frameUrl = `${origin}/preview-bootstrap?token=test-bootstrap&path=%2F`;
const request = (confirm = 'frame', candidate = frameUrl) => new Request(`https://app.example/api/shell/desktop?${new URLSearchParams({ computerId, confirm, frameUrl: candidate })}`);

beforeEach(() => {
    state.owned = true; state.signedIn = true;
    resetNekoAdminTokenCacheForTests();
    vi.stubEnv('EZIL_AWS_BROWSER_ZONE', 'preview.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'synthetic-test-key');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function wire(status = 200, entries: unknown[] = []) {
    vi.mocked(fetch).mockImplementation(async (raw, init) => {
        const u = new URL(String(raw));
        expect(u.origin).toBe(origin);
        if (u.pathname === '/preview-bootstrap') return new Response(null, {
            status: 302, headers: { location: '/', 'set-cookie': 'ezil_preview=test-cookie; Secure; Path=/' },
        });
        expect(new Headers(init?.headers).get('cookie')).toBe('ezil_preview=test-cookie');
        if (u.pathname === '/api/login') return Response.json({ token: 'test-session', profile: { is_admin: true } });
        if (u.pathname === '/api/sessions') return Response.json(entries);
        return new Response('desktop', { status });
    });
}

describe('shell desktop route through the real router and provider', () => {
    it('AWS 302 bootstrap plus same-origin cookie confirms the final healthy frame', async () => {
        wire();
        const response = await GET(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true, confirmed: true, status: 200 });
        expect(fetch).toHaveBeenCalledTimes(2);
    });
    it('a reachable bootstrap cannot confirm an erroring final desktop', async () => {
        wire(503);
        expect(await (await GET(request())).json()).toEqual({ ok: true, confirmed: false, reason: 'http_error', status: 503 });
    });
    it('the live legacy viewer / admin-only snapshot is unknown through the route', async () => {
        wire(200, [{ profile: { is_admin: true }, state: { is_connected: false, is_watching: false } }]);
        expect(await (await GET(request('display'))).json()).toEqual({ ok: true, display: 'unknown', reason: 'unrecognised' });
    });
    it('a measured watcher remains live through the route', async () => {
        wire(200, [{ state: { is_connected: true, is_watching: true } }]);
        expect(await (await GET(request('display'))).json()).toEqual({ ok: true, display: 'live', sessions: 1, watching: 1 });
    });
    it('a foreign origin is rejected before either probe fetches', async () => {
        expect(await (await GET(request('frame', 'https://foreign.example/'))).json()).toMatchObject({ confirmed: false, reason: 'not_own_origin' });
        expect(await (await GET(request('display', 'https://foreign.example/'))).json()).toMatchObject({ display: 'unknown', reason: 'not_own_origin' });
        expect(fetch).not.toHaveBeenCalled();
    });
    it('another user’s computer is rejected before probing', async () => {
        state.owned = false;
        expect((await GET(request())).status).toBe(404);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('an unsigned request is rejected before probing', async () => {
        state.signedIn = false;
        expect((await GET(request())).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });
});
