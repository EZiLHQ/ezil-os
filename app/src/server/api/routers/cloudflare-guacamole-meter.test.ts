import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    deps: vi.fn(), route: vi.fn(), factory: vi.fn(),
    ensure: vi.fn(), restart: vi.fn(), activity: vi.fn(), terminate: vi.fn(), stop: vi.fn(),
}));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: mocks.deps }));
vi.mock('@/server/billing/v2/compute-meter', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), billingComputeMeter: mocks.factory,
}));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});
vi.mock('./compute-dispatch', () => ({ routeComputer: mocks.route }));
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, hasHmacSecret: true }),
    confirmDesktopFrame: async () => ({ alive: true, status: 200 }),
    enableImplicitHosting: async () => 'implicit',
}));

import type { BillingStore } from '@/server/billing/ports';
import type { ComputeMeter } from '@/server/billing/v2/compute-meter';
import { readBillingConfig } from '@/server/billing/config';
import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '33333333-3333-4333-8333-333333333333';
const NOW = new Date('2026-10-19T12:00:00Z');
const ready = { ok: true, mode: 'neko', guacamoleUrl: 'https://8181-sandbox-token.preview.example/',
    appPreviewUrl: 'https://3002-sandbox-token.preview.example/preview-bootstrap?token=app',
    codePreviewUrl: 'https://8443-sandbox-token.preview.example/preview-bootstrap?token=code' };
const caller = () => cloudflareGuacamoleRouter.createCaller({ user: { id: userId },
    db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
const surfaces = ['previewUrl', 'appPreviewUrl', 'codePreviewUrl', 'restartDesktop', 'reportActivity', 'terminate'] as const;
type Surface = typeof surfaces[number];
function call(surface: Surface) {
    const api = caller();
    if (surface === 'previewUrl') return api.previewUrl({ computerId, sessionId });
    if (surface === 'reportActivity') return api.reportActivity({ computerId, lastInputAgoMs: 0 });
    return api[surface]({ computerId });
}

let meter: { [K in keyof ComputeMeter]: ReturnType<typeof vi.fn<ComputeMeter[K]>> };
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-secret');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected network'); }));
    mocks.deps.mockReset().mockReturnValue({ config: readBillingConfig({}), store: {}, stripe: null, now: () => NOW });
    mocks.ensure.mockReset().mockResolvedValue(ready);
    mocks.restart.mockReset().mockResolvedValue({ ok: true, outcome: 'restarted', wasRunning: true });
    mocks.activity.mockReset().mockResolvedValue({ ok: true });
    mocks.terminate.mockReset().mockResolvedValue({ ok: true, terminated: true, outcome: 'destroyed' });
    mocks.stop.mockReset().mockResolvedValue({ ok: true, terminated: true });
    mocks.route.mockReset().mockResolvedValue({ kind: 'cloudflare', provider: mocks });
    meter = { ready: vi.fn(async () => {}), stopped: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}) };
    mocks.factory.mockReset().mockReturnValue(meter);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Cloudflare compute metering', () => {
    it.each(surfaces.slice(0, 4))('%s meters readiness as free-cf after provider success', async surface => {
        expect(await call(surface)).toMatchObject({ ok: true });
        expect(meter.ready).toHaveBeenCalledExactlyOnceWith({ userId, computerId, size: 'free-cf', readyAt: NOW, overheadSeconds: 0 });
        const provider = surface === 'restartDesktop' ? mocks.restart : mocks.ensure;
        expect(provider.mock.invocationCallOrder[0]).toBeLessThan(meter.ready.mock.invocationCallOrder[0]!);
    });

    it('reportActivity preserves its answer and heartbeats after provider success', async () => {
        expect(await call('reportActivity')).toMatchObject({ ok: true, provider: 'cloudflare-guacamole' });
        expect(meter.heartbeat).toHaveBeenCalledExactlyOnceWith({ userId, computerId, at: NOW });
        expect(mocks.activity.mock.invocationCallOrder[0]).toBeLessThan(meter.heartbeat.mock.invocationCallOrder[0]!);
    });

    it('terminate closes a confirmed Cloudflare stop with user_stop', async () => {
        expect(await call('terminate')).toMatchObject({ ok: true, terminated: true, outcome: 'destroyed' });
        expect(meter.stopped).toHaveBeenCalledExactlyOnceWith({ userId, computerId, endedAt: NOW, reason: 'user_stop' });
        expect(mocks.terminate.mock.invocationCallOrder[0]).toBeLessThan(meter.stopped.mock.invocationCallOrder[0]!);
    });

    it.each(surfaces)('%s remains successful when an injected meter throws', async surface => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const method of Object.values(meter)) method.mockRejectedValue(new Error('meter failed'));
        expect(await call(surface)).toMatchObject({ ok: true });
        expect(console.warn).toHaveBeenCalledWith('[billing.meter] observation failed', expect.any(Object));
    });

    it.each(surfaces)('%s with the real meter and flags off makes ZERO billing-store accesses', async surface => {
        const actual = await vi.importActual<typeof import('@/server/billing/v2/compute-meter')>('@/server/billing/v2/compute-meter');
        mocks.factory.mockImplementation(() => actual.billingComputeMeter());
        const access = vi.fn(() => { throw new Error('billing tables absent'); });
        mocks.deps.mockReturnValue({ config: readBillingConfig({}), store: new Proxy({} as BillingStore, { get: access }),
            stripe: null, now: () => NOW });
        expect(await call(surface)).toMatchObject({ ok: true });
        expect(mocks.factory).toHaveBeenCalledTimes(1);
        expect(mocks.deps).toHaveBeenCalled();
        expect(access).not.toHaveBeenCalled();
    });

    it('an exhausted enforced allowance refuses before the provider or meter', async () => {
        mocks.deps.mockReturnValue({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }), now: () => NOW,
            store: { openEpochFor: async () => null, subscriptionsFor: async () => [{ sku: 'standard_monthly_v2',
                stripeSubscriptionId: 'sub_a', status: 'active', currentPeriodStart: new Date('2026-10-01'),
                currentPeriodEnd: new Date('2026-11-01'), cancelAtPeriodEnd: false }],
            userCreatedAt: async () => null, openPlanChanges: async () => [], epochsFor: async () => [],
            grantsForPeriod: async () => [], latestConsent: async () => null, openPaymentIssues: async () => [], sizePreference: async () => null } });
        expect(await call('previewUrl')).toMatchObject({ ok: false, billingRefusal: 'allowance_exhausted' });
        expect(mocks.ensure).not.toHaveBeenCalled();
        expect(mocks.factory).not.toHaveBeenCalled();
    });

    it.each(surfaces)('%s provider refusal emits no meter signal', async surface => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const failure = { ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting', retryable: true };
        for (const method of [mocks.ensure, mocks.restart, mocks.activity, mocks.terminate]) method.mockResolvedValue(failure);
        expect(await call(surface)).toMatchObject({ ok: false });
        expect(mocks.factory).not.toHaveBeenCalled();
    });

    it('an ok response without a preview URL does not open an epoch', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        mocks.ensure.mockResolvedValue({ ...ready, guacamoleUrl: '', appPreviewUrl: null, codePreviewUrl: null });
        await call('appPreviewUrl');
        expect(mocks.factory).not.toHaveBeenCalled();
    });

    it('an unconfirmed terminate does not close an epoch', async () => {
        mocks.terminate.mockResolvedValue({ ok: true, terminated: false });
        await call('terminate');
        expect(mocks.factory).not.toHaveBeenCalled();
    });

    it.each(['reportActivity', 'terminate', 'restartDesktop'] as const)('%s on AWS does not use the Cloudflare meter', async surface => {
        mocks.route.mockResolvedValue({ kind: 'aws-ec2', provider: mocks, instanceType: 'm6i.2xlarge' });
        await call(surface);
        expect(mocks.factory).not.toHaveBeenCalled();
    });
});
