/**
 * Hotfix r5 (ACCEPT-11865d06 B6), defence in depth. After a stop, a hosted-app poll (`codePreviewUrl`,
 * `appPreviewUrl`) arriving while the placement has just settled STOPPED must NOT run `ensure()` — which
 * starts (replaces) a STOPPED AWS computer. It answers a refusal VALUE instead (`computer_stopped`, never the
 * waking `sandbox_starting` the wake loop keeps re-asking). The desktop open (`previewUrl`: Settings → Open
 * desktop) is not held: an explicit open still starts the computer. Driven through the real router procedures.
 */
import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const NOW = new Date('2026-10-29T19:25:53.000Z');
const ensure = vi.hoisted(() => vi.fn());
const sync = vi.hoisted(() => vi.fn());
const read = vi.hoisted(() => vi.fn());
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: {} }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: async () => ({ allowed: true }) }));
vi.mock('@/server/billing/v2/compute-meter-observation', () => ({ recordComputeMeter: async () => 'ok' }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown; headers: Headers }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure, createTRPCContext: async () => ({}) };
});
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async original => ({
    ...await original<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
}));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: sync }));
vi.mock('@/server/lib/compute/aws-preview', () => ({
    requestAwsPreview: vi.fn(), prepareAwsPoolSession: vi.fn(async () => {}), waitForAwsPreviewPlacement: async () => false,
}));
vi.mock('@/server/lib/compute/placement', async original => ({
    ...await original<Record<string, unknown>>(), readPlacement: read,
}));
vi.mock('@/server/api/routers/compute-dispatch', async original => ({
    ...await original<Record<string, unknown>>(),
    routeComputer: async () => ({ kind: 'aws-ec2', instanceType: 'm6i.xlarge', provider: { ensure } }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
import { STOP_COOLDOWN_MS } from './compute-dispatch';

const caller = () => cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, headers: new Headers({ cookie: 'session=1' }),
    db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
const placement = (state: string, agoMs: number) => ({ provider: 'aws-ec2', store: 'aws-ebs', record: {
    computerId, ownerUserId: userId, provider: 'aws-ec2', state, lastError: 'pool_released', updatedAt: new Date(NOW.getTime() - agoMs) } });
const starting = { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true, computeLaunching: true };

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    for (const f of [ensure, sync, read]) f.mockReset();
    ensure.mockResolvedValue(starting);
    sync.mockResolvedValue({ ok: true });
});

describe('a hosted-app poll right after a stop does not restart the computer', () => {
    it('is a 60 s hold', () => expect(STOP_COOLDOWN_MS).toBe(60_000));

    it.each(['codePreviewUrl', 'appPreviewUrl'] as const)('%s: STOPPED 0.23 s ago → computer_stopped, ensure never runs', async name => {
        read.mockResolvedValue(placement('STOPPED', 230));
        const answer = await caller()[name]({ computerId });
        expect(answer).toMatchObject({ ok: false, errorCode: 'computer_stopped', computeProvider: 'aws-ec2' });
        // Not the waking code: the client's wake loop would re-ask that every 1.5 s for 215 s.
        expect(answer).not.toMatchObject({ errorCode: 'sandbox_starting' });
        expect(ensure).not.toHaveBeenCalled();
        expect(read).toHaveBeenCalledWith(expect.anything(), computerId, userId);
    });

    it.each(['codePreviewUrl', 'appPreviewUrl'] as const)('%s: after the hold (60 s) the open starts the computer as before', async name => {
        read.mockResolvedValue(placement('STOPPED', 60_000));
        expect(await caller()[name]({ computerId })).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
        expect(ensure).toHaveBeenCalledOnce();
    });

    it.each([['RUNNING', 1_000], ['STOPPING', 1_000], ['DRAINING', 1_000]] as const)('codePreviewUrl: %s (not settled stopped) is not held', async (state, ago) => {
        read.mockResolvedValue(placement(state, ago));
        await caller().codePreviewUrl({ computerId });
        expect(ensure).toHaveBeenCalledOnce();
    });

    it('no placement, a foreign provider, or an unreadable placement is not held (fail open to the existing path)', async () => {
        read.mockResolvedValueOnce({ provider: 'cloudflare', store: 'r2', record: null });
        await caller().codePreviewUrl({ computerId });
        read.mockResolvedValueOnce({ ...placement('STOPPED', 100), record: { ...placement('STOPPED', 100).record, provider: 'cloudflare' } });
        await caller().codePreviewUrl({ computerId });
        read.mockRejectedValueOnce(new Error('db down'));
        await caller().codePreviewUrl({ computerId });
        expect(ensure).toHaveBeenCalledTimes(3);
    });

    it('the desktop open (Settings → Open desktop) is never held: an explicit open still starts it', async () => {
        read.mockResolvedValue(placement('STOPPED', 230));
        await caller().previewUrl({ computerId, sessionId: '33333333-3333-4333-8333-333333333333' });
        expect(ensure).toHaveBeenCalledOnce();
    });
});
