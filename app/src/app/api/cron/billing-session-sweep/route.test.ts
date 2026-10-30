import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routeComputer, type RoutedComputer } from '@/server/api/routers/compute-dispatch';
import { getBillingDeps } from '@/server/billing/deps';
import { readBillingConfig } from '@/server/billing/config';
import type { BillingDeps, BillingStore } from '@/server/billing/ports';
import { db } from '@/server/db';
import { readPlacement, type ResolvedPlacement } from '@/server/lib/compute/placement';
import { stopComputerForPolicy } from '@/server/lib/compute/stop-policy';
import { handleBillingSessionSweep } from './handler';
import { GET, maxDuration } from './route';

const mockEnv = vi.hoisted(() => ({ CRON_SECRET: undefined as string | undefined }));
vi.mock('@/env', () => ({ env: mockEnv }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn() }));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ routeComputer: vi.fn() }));
vi.mock('@/server/lib/compute/placement', () => ({ readPlacement: vi.fn() }));
vi.mock('@/server/lib/compute/stop-policy', () => ({ stopComputerForPolicy: vi.fn() }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', () => ({ newCorrelationId: () => 'correlation' }));
vi.mock('./handler', () => ({ handleBillingSessionSweep: vi.fn() }));

const now = new Date('2026-10-18T06:00:00Z');
const computer = { userId: 'epoch-owner', computerId: 'computer' };
const counts = { examined: 2, stopped: 1, closed: 2, stopFailed: 0, heartbeatClosed: 1, retried: 0, shadow: 0 };
const deps: BillingDeps = { config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
    store: {} as BillingStore, stripe: null, usage: null, now: () => now };
const request = (authorization?: string) => new Request('https://app.test/api/cron/billing-session-sweep', {
    headers: authorization === undefined ? {} : { authorization },
});

beforeEach(() => {
    vi.resetAllMocks();
    mockEnv.CRON_SECRET = 'cron';
    vi.mocked(getBillingDeps).mockReturnValue(deps);
    vi.mocked(handleBillingSessionSweep).mockResolvedValue(counts);
});

async function wiring() {
    await GET(request('Bearer cron'));
    return vi.mocked(handleBillingSessionSweep).mock.calls[0]![0];
}

describe('GET /api/cron/billing-session-sweep', () => {
    it('404s when CRON_SECRET is unset, before constructing any billing dependencies', async () => {
        mockEnv.CRON_SECRET = undefined;
        const response = await GET(request('Bearer undefined'));
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('');
        expect(getBillingDeps).not.toHaveBeenCalled();
        expect(handleBillingSessionSweep).not.toHaveBeenCalled();
    });

    it.each([undefined, 'Bearer wrong', 'Basic cron', 'bearer cron'])('404s a missing or wrong bearer (%s)', async auth => {
        expect((await GET(request(auth))).status).toBe(404);
        expect(getBillingDeps).not.toHaveBeenCalled();
        expect(handleBillingSessionSweep).not.toHaveBeenCalled();
    });

    it('returns the sweep counts and injects the dependency clock with a duration budget', async () => {
        const response = await GET(request('Bearer cron'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(counts);
        expect(handleBillingSessionSweep).toHaveBeenCalledExactlyOnceWith({ deps, now,
            stop: expect.any(Function), isStillRunning: expect.any(Function), awsStopProof: expect.any(Function) });
        expect(maxDuration).toBe(300);
    });

    // Round 3 (D9): stale AWS epochs close only on placement PROOF, never on a read error.
    it.each(['RUNNING', 'LEASED', 'STARTING', 'MOUNTING', 'STOPPED', 'STOPPING', 'DRAINING', 'RETIRED'])('awsStopProof reports %s from the placement with no stop time', async state => {
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider: {}, instanceType: null } as RoutedComputer);
        vi.mocked(readPlacement).mockResolvedValue({ provider: 'aws-ec2', record: {
            ownerUserId: computer.userId, provider: 'aws-ec2', state,
        } } as ResolvedPlacement);
        expect(await (await wiring()).awsStopProof!(computer)).toEqual({
            running: ['RUNNING', 'LEASED', 'STARTING', 'MOUNTING'].includes(state), stoppedAt: null });
    });

    it('awsStopProof treats a Cloudflare computer as running (the policy path owns it)', async () => {
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'cloudflare', provider: { status: vi.fn() }, instanceType: null } as unknown as RoutedComputer);
        expect(await (await wiring()).awsStopProof!(computer)).toEqual({ running: true, stoppedAt: null });
        expect(readPlacement).not.toHaveBeenCalled();
    });

    it.each([
        { name: 'no placement row', record: null },
        { name: 'another owner', record: { ownerUserId: 'another-owner', provider: 'aws-ec2', state: 'STOPPED' } },
        { name: 'a non-AWS provider on the row', record: { ownerUserId: computer.userId, provider: 'cloudflare', state: 'STOPPED' } },
    ])('awsStopProof THROWS (never running:false) when the placement is unproven: $name', async ({ record }) => {
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider: {}, instanceType: null } as RoutedComputer);
        vi.mocked(readPlacement).mockResolvedValue({ provider: 'aws-ec2', record } as unknown as ResolvedPlacement);
        await expect((await wiring()).awsStopProof!(computer)).rejects.toThrow('placement_unproven');
    });

    it('awsStopProof propagates a read error instead of answering', async () => {
        vi.mocked(routeComputer).mockRejectedValue(new Error('db down'));
        await expect((await wiring()).awsStopProof!(computer)).rejects.toThrow('db down');
    });

    it('stops using the epoch owner and the shared policy helper without a session or confirmation poll', async () => {
        const input = await wiring();
        const outcome = { kind: 'aws-ec2' as const, result: { ok: false, terminated: false, outcome: 'stopping' } };
        vi.mocked(stopComputerForPolicy).mockResolvedValue(outcome);
        expect(await input.stop(computer, 'session_max')).toBe(outcome);
        expect(stopComputerForPolicy).toHaveBeenCalledExactlyOnceWith(db, computer, 'session_max');
    });

    it.each(['RUNNING', 'LEASED', 'STARTING', 'MOUNTING', 'STOPPED', 'STOPPING', 'DRAINING', 'RETIRED'])('AWS retry checks placement state %s without calling provider status', async state => {
        const status = vi.fn();
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider: { status }, instanceType: null } as unknown as RoutedComputer);
        vi.mocked(readPlacement).mockResolvedValue({ provider: 'aws-ec2', record: {
            ownerUserId: computer.userId, provider: 'aws-ec2', state,
        } } as ResolvedPlacement);
        const input = await wiring();
        expect(await input.isStillRunning(computer)).toBe(['RUNNING', 'LEASED', 'STARTING', 'MOUNTING'].includes(state));
        expect(routeComputer).toHaveBeenCalledExactlyOnceWith(db, computer);
        expect(readPlacement).toHaveBeenCalledExactlyOnceWith(db, computer.computerId);
        expect(status).not.toHaveBeenCalled();
    });

    it('does not retry if the placement owner no longer matches the epoch', async () => {
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider: {}, instanceType: null } as RoutedComputer);
        vi.mocked(readPlacement).mockResolvedValue({ provider: 'aws-ec2', record: {
            ownerUserId: 'another-owner', provider: 'aws-ec2', state: 'RUNNING',
        } } as ResolvedPlacement);
        expect(await (await wiring()).isStillRunning(computer)).toBe(false);
    });

    it.each([
        { ok: true, guacamoleRunning: true, expected: true },
        { ok: true, guacamoleRunning: false, expected: false },
        { ok: false, guacamoleRunning: true, expected: false },
    ])('Cloudflare retry trusts a successful running status (%j)', async ({ expected, ...answer }) => {
        const status = vi.fn().mockResolvedValue(answer);
        vi.mocked(routeComputer).mockResolvedValue({ kind: 'cloudflare', provider: { status } } as unknown as RoutedComputer);
        expect(await (await wiring()).isStillRunning(computer)).toBe(expected);
        expect(status).toHaveBeenCalledExactlyOnceWith({ correlationId: 'correlation' }, computer);
        expect(readPlacement).not.toHaveBeenCalled();
    });

    it.each(['route', 'placement', 'status'] as const)('treats %s errors as not running', async failure => {
        const fail = new Error('unavailable');
        if (failure === 'route') vi.mocked(routeComputer).mockRejectedValue(fail);
        else if (failure === 'placement') {
            vi.mocked(routeComputer).mockResolvedValue({ kind: 'aws-ec2', provider: {}, instanceType: null } as RoutedComputer);
            vi.mocked(readPlacement).mockRejectedValue(fail);
        } else vi.mocked(routeComputer).mockResolvedValue({ kind: 'cloudflare',
            provider: { status: vi.fn().mockRejectedValue(fail) } } as unknown as RoutedComputer);
        expect(await (await wiring()).isStillRunning(computer)).toBe(false);
    });
});
