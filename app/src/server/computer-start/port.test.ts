/**
 * The real `StartPort` against fakes of its collaborators (routing, billing gate, providers, meter): what `start.ts`'s
 * ordering test cannot see. A start routes read-only until admitted, rates the route it was handed, boots with the
 * open path's own ensure options and meter, and pushes no credential.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    routeComputer: vi.fn(),
    gateComputerStart: vi.fn(),
    ready: vi.fn(),
    stopComputerForPolicy: vi.fn(),
    prepareAwsPoolSession: vi.fn(),
    migration: vi.fn(),
    config: { isConfigured: true } as { isConfigured: boolean },
    enforcement: true,
}));

vi.mock('server-only', () => ({}));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ routeComputer: h.routeComputer, cloudflareMigrationAnswer: h.migration }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date('2026-11-07T00:00:00Z'), config: { enforcementEnabled: h.enforcement } }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: h.gateComputerStart }));
vi.mock('@/server/billing/v2/compute-meter', () => ({ billingComputeMeter: () => ({ ready: h.ready }) }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({ newCorrelationId: () => 'corr-1', resolveCloudflareGuacamoleConfig: () => h.config }));
vi.mock('@/server/lib/compute/aws-preview', () => ({ prepareAwsPoolSession: h.prepareAwsPoolSession }));
vi.mock('@/server/lib/compute/stop-policy', () => ({ stopComputerForPolicy: h.stopComputerForPolicy }));

import { startPort } from './port';

const COMPUTER = { userId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222' };
const db = {};
const ensure = vi.fn();
const cloudflare = { kind: 'cloudflare', provider: { ensure } };
const aws = (extra: Record<string, unknown> = {}) => ({ kind: 'aws-ec2', instanceType: 'm6i.large', provider: { ensure }, ...extra });

beforeEach(() => {
    for (const mock of [h.routeComputer, h.gateComputerStart, h.ready, h.stopComputerForPolicy, h.prepareAwsPoolSession, h.migration, ensure]) mock.mockReset();
    h.config = { isConfigured: true };
    h.enforcement = true;
    h.migration.mockReturnValue(null);
    h.gateComputerStart.mockResolvedValue({ allowed: true });
    h.prepareAwsPoolSession.mockResolvedValue(undefined);
});

describe('startPort', () => {
    it('routes read-only until asked to pin, and describes the route', async () => {
        const port = startPort(db, COMPUTER);
        h.routeComputer.mockResolvedValueOnce(cloudflare).mockResolvedValueOnce(aws()).mockResolvedValueOnce(aws({ reverse: 'moving' }));
        expect(await port.route(false)).toEqual({ kind: 'cloudflare', instanceType: null, moving: false });
        expect(await port.route(true)).toEqual({ kind: 'aws-ec2', instanceType: 'm6i.large', moving: false });
        expect(await port.route(false)).toEqual({ kind: 'aws-ec2', instanceType: 'm6i.large', moving: true });
        expect(h.routeComputer.mock.calls.map((call) => call[2])).toEqual([{ pinCloudflare: false }, { pinCloudflare: true }, { pinCloudflare: false }]);
        expect(h.routeComputer.mock.calls.every((call) => call[1] === COMPUTER)).toBe(true);
    });

    it('rates the route it is given, with the open path\'s own gate, and passes the refusal reason on', async () => {
        const port = startPort(db, COMPUTER);
        expect(await port.gate({ kind: 'aws-ec2', instanceType: 'm6i.large', moving: false })).toEqual({ allowed: true });
        expect(h.gateComputerStart).toHaveBeenCalledWith(expect.objectContaining({ ...COMPUTER, kind: 'aws-ec2', instanceType: 'm6i.large', now: new Date('2026-11-07T00:00:00Z') }));
        h.gateComputerStart.mockResolvedValue({ allowed: false, reason: 'fair_use_paused' });
        expect(await port.gate({ kind: 'cloudflare', instanceType: null, moving: false })).toEqual({ allowed: false, reason: 'fair_use_paused' });
    });

    it('refuses to boot when the provider is not configured, before any ensure', async () => {
        h.config = { isConfigured: false };
        h.routeComputer.mockResolvedValue(cloudflare);
        const port = startPort(db, COMPUTER);
        await port.route(true);
        expect(await port.boot({ kind: 'cloudflare', instanceType: null, moving: false })).toEqual({ state: 'failed', reason: 'not_configured' });
        expect(ensure).not.toHaveBeenCalled();
    });

    it('boot needs a route first', async () => {
        await expect(startPort(db, COMPUTER).boot({ kind: 'cloudflare', instanceType: null, moving: false })).rejects.toThrow(/boot before route/);
    });

    describe('AWS', () => {
        const boot = async () => {
            h.routeComputer.mockResolvedValue(aws());
            const port = startPort(db, COMPUTER);
            const route = await port.route(true);
            return port.boot(route);
        };

        it('ready is running, with the computer id as the session and no screen or folder', async () => {
            ensure.mockResolvedValue({ ok: true });
            expect(await boot()).toEqual({ state: 'running' });
            expect(ensure).toHaveBeenCalledWith({ correlationId: 'corr-1' }, COMPUTER, { sessionId: COMPUTER.computerId, desktopMode: 'neko' });
            expect(h.prepareAwsPoolSession).not.toHaveBeenCalled();
            expect(h.ready).not.toHaveBeenCalled();
        });

        it('a retryable wait is starting, and primes the pool relay as an open does; a failure that cannot prime does not fail the start', async () => {
            ensure.mockResolvedValue({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: true });
            h.prepareAwsPoolSession.mockRejectedValue(new Error('worker down'));
            expect(await boot()).toEqual({ state: 'starting' });
            expect(h.prepareAwsPoolSession).toHaveBeenCalledTimes(1);
        });

        it('any other refusal is failed with the provider code', async () => {
            ensure.mockResolvedValue({ ok: false, error: 'x', errorCode: 'aws_capacity', retryable: false });
            expect(await boot()).toEqual({ state: 'failed', reason: 'aws_capacity' });
            ensure.mockResolvedValue({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: false });
            expect(await boot()).toEqual({ state: 'failed', reason: 'computer_starting' });
            expect(h.prepareAwsPoolSession).not.toHaveBeenCalled();
        });
    });

    describe('Cloudflare', () => {
        const boot = async () => {
            h.routeComputer.mockResolvedValue(cloudflare);
            const port = startPort(db, COMPUTER);
            const route = await port.route(true);
            return port.boot(route);
        };

        it('ready with a desktop is metered exactly as an open meters it, and is running', async () => {
            ensure.mockResolvedValue({ ok: true, guacamoleUrl: 'https://x.example/d' });
            expect(await boot()).toEqual({ state: 'running' });
            expect(h.ready).toHaveBeenCalledWith({ ...COMPUTER, size: 'free-cf', readyAt: expect.any(Date), overheadSeconds: 0 });
            expect(ensure).toHaveBeenCalledWith({ correlationId: 'corr-1' }, COMPUTER, { sessionId: COMPUTER.computerId, desktopMode: 'neko' });
            expect(h.stopComputerForPolicy).not.toHaveBeenCalled();
        });

        it('the answer carries no URL even though the provider returned one', async () => {
            ensure.mockResolvedValue({ ok: true, guacamoleUrl: 'https://x.example/d', appPreviewUrl: 'https://y.example', codePreviewUrl: 'https://z.example' });
            expect(JSON.stringify(await boot())).not.toMatch(/https?:/);
        });

        it('a concurrent-limit refusal stops the computer and fails the start when enforcement is on; with it off the start stands', async () => {
            ensure.mockResolvedValue({ ok: true, codePreviewUrl: 'https://z.example' });
            h.ready.mockResolvedValue('concurrent');
            expect(await boot()).toEqual({ state: 'failed', reason: 'billing_concurrent_limit' });
            expect(h.stopComputerForPolicy).toHaveBeenCalledWith(db, COMPUTER, 'user_stop', { correlationId: 'corr-1' });
            h.stopComputerForPolicy.mockReset();
            h.enforcement = false;
            expect(await boot()).toEqual({ state: 'running' });
            expect(h.stopComputerForPolicy).not.toHaveBeenCalled();
        });

        it('a meter that throws does not fail the start', async () => {
            ensure.mockResolvedValue({ ok: true, guacamoleUrl: 'https://x.example/d' });
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            h.ready.mockRejectedValue(new Error('meter down'));
            expect(await boot()).toEqual({ state: 'running' });
        });

        it('ok without any desktop is only starting, and is not metered', async () => {
            ensure.mockResolvedValue({ ok: true });
            expect(await boot()).toEqual({ state: 'starting' });
            expect(h.ready).not.toHaveBeenCalled();
        });

        it('a refusal is failed with its code; a migrating computer is not started', async () => {
            ensure.mockResolvedValue({ ok: false, error: 'x', errorCode: 'worker_error', retryable: true });
            expect(await boot()).toEqual({ state: 'failed', reason: 'worker_error' });
            h.migration.mockReturnValue({ computeMigrating: true });
            ensure.mockResolvedValue({ ok: false, error: 'worker_http_409: {"error":"migrating"}', errorCode: 'worker_http_409', retryable: true });
            expect(await boot()).toEqual({ state: 'failed', reason: 'computer_migrating' });
        });
    });
});
