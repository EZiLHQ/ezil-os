import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owned: true, signedIn: true, cloudflare: false }));
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: {} }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: async () => ({ allowed: true }) }));
vi.mock('@/server/billing/v2/compute-meter-observation', () => ({ recordComputeMeter: async () => 'ok' }));
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
// Isolate placement/billing infrastructure, but exercise the real route, router and both providers.
vi.mock('@/server/api/routers/compute-dispatch', async original => {
    const { createAwsEc2Provider } = await import('@/server/lib/compute/aws-ec2');
    const { createCloudflareComputeProvider } = await import('@/server/lib/compute/cloudflare');
    const { createFakePlacementDb, placementRow } = await import('@/server/lib/compute/fake-placement-db.test-support');
    return { ...await original<Record<string, unknown>>(), routeComputer: async () => {
        if (state.cloudflare) return { kind: 'cloudflare', provider: createCloudflareComputeProvider({
            readHmacSecret: () => 'test-secret', useTokenV2: () => false,
        }) };
        const fake = createFakePlacementDb({ placements: [placementRow({
            computer_id: computerId, owner_user_id: userId, state: 'RUNNING', generation: 7, lease_epoch: 11,
        })] });
        return { kind: 'aws-ec2', instanceType: 't3.medium', provider: createAwsEc2Provider({ db: fake.db,
            env: () => ({ EZIL_AWS_COMPUTERS_ENABLED: '1', CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.example',
                CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'test-secret' }) }) };
    } };
});

import { maxDuration, POST } from './route';
const request = (body = JSON.stringify({ computerId })) => new Request('https://app.example/api/shell/restart', { method: 'POST', body });
const relay = (runtimeId: string) => Response.json({ ok: true, runtimeId, expiresAt: Date.now() + 600_000 });
const ack = () => Response.json({ ok: true, outcome: 'restart_requested' }, { status: 202 });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    state.owned = true; state.signedIn = true; state.cloudflare = false;
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('Unexpected network request'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('shell restart through the real router and provider', () => {
    it('keeps HTTP pending while AWS still serves the old runtime, then succeeds once the new runtime is ready', async () => {
        let runtime = 'a'.repeat(32), posts = 0, complete = false;
        vi.mocked(fetch).mockImplementation(async (_url, init) => {
            if (init?.method === 'POST') { posts++; return ack(); }
            return relay(runtime);
        });
        const response = POST(request()).then(r => { complete = true; return r; });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(posts).toBe(1);
        expect(complete).toBe(false);
        runtime = 'b'.repeat(32);
        await vi.advanceTimersByTimeAsync(2_000);
        const result = await response;
        expect(result.status).toBe(200);
        expect(result.headers.get('cache-control')).toContain('no-store');
        expect(await result.json()).toMatchObject({ ok: true, outcome: 'restart_requested' });
        expect(posts).toBe(1);
        expect(maxDuration).toBeGreaterThan(180);
    });
    it('returns failure when AWS never replaces the runtime, rather than telling Code to reopen', async () => {
        vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST' ? ack() : relay('a'.repeat(32)));
        const response = POST(request());
        await vi.advanceTimersByTimeAsync(0);
        await vi.runAllTimersAsync();
        // Round 3: the distinct code reaches the shell route response.
        expect(await (await response).json()).toMatchObject({ ok: false, errorCode: 'restart_timeout' });
        expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });
    it.each([[409, 'restart_busy'], [429, 'restart_budget_exhausted'], [503, 'restart_host_unreachable']])(
        'round 3: a refused AWS dispatch %s answers %s through the route', async (status, errorCode) => {
            vi.mocked(fetch).mockImplementation(async (_url, init) => init?.method === 'POST'
                ? Response.json({ ok: false, outcome: 'restart_unavailable' }, { status }) : relay('a'.repeat(32)));
            const response = POST(request());
            await vi.runAllTimersAsync();
            expect(await (await response).json()).toMatchObject({ ok: false, errorCode });
        });
    it('round 3: an unknown restart scope is a 400 before any provider call', async () => {
        const response = await POST(request(JSON.stringify({ computerId, scope: 'everything' })));
        expect(response.status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('keeps Cloudflare on its existing synchronous restart path without runtime polls', async () => {
        state.cloudflare = true;
        vi.mocked(fetch).mockResolvedValue(Response.json({ ok: true, outcome: 'restarted', wasRunning: true }));
        expect(await (await POST(request())).json()).toMatchObject({ ok: true, outcome: 'restarted', wasRunning: true });
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0]![1]?.method).toBe('POST');
        expect(String(vi.mocked(fetch).mock.calls[0]![0])).toMatch(/\/restart$/);
    });
    it('rejects another user’s computer before runtime probes or restart', async () => {
        state.owned = false;
        expect((await POST(request())).status).toBe(404);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('authenticates before parsing the request body', async () => {
        state.signedIn = false;
        expect((await POST(request('invalid JSON'))).status).toBe(401);
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['invalid JSON', JSON.stringify({ computerId: 'invalid' })])('rejects malformed input before runtime probes: %s', async body => {
        expect((await POST(request(body))).status).toBe(400);
        expect(fetch).not.toHaveBeenCalled();
    });
});
