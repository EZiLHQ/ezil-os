import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_FAILURE_COPY, computeBootUiState, isRetryableBootErrorCode, type BootErrorCode } from '@/components/desktop/boot-phases';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

const mocks = vi.hoisted(() => ({ route: vi.fn(), ensure: vi.fn(), preview: vi.fn(), restart: vi.fn(), prepare: vi.fn() }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});
vi.mock('./compute-dispatch', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(), routeComputer: mocks.route,
}));
vi.mock('./computer-store', () => ({ stampOpened: vi.fn(async () => {}) }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ config: { enforcementEnabled: false, tabEnabled: false }, now: () => new Date() }) }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn(async () => {}) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => { throw new Error('Unexpected AWS client construction'); },
}));
vi.mock('@/server/lib/compute/aws-preview', async original => ({
    ...await original<Record<string, unknown>>(), requestAwsPreview: mocks.preview, prepareAwsPoolSession: mocks.prepare,
}));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async importOriginal => ({
    ...await importOriginal<Record<string, unknown>>(),
    resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, hasHmacSecret: true }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const computerId = '22222222-2222-4222-8222-222222222222';
beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network'); }));
    mocks.ensure.mockReset();
    mocks.restart.mockReset();
    mocks.preview.mockReset();
    mocks.prepare.mockReset().mockResolvedValue(undefined);
    mocks.route.mockReset().mockResolvedValue({ kind: 'aws-ec2', provider: { ensure: mocks.ensure, restart: mocks.restart }, instanceType: 't3a.medium' });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('AWS Code and desktop preview holds', () => {
    const starting = { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true, computeLaunching: true };
    const waitingAnswer = { ...starting, errorCode: 'sandbox_starting', provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' };
    function setup(signal?: AbortSignal) {
        vi.useFakeTimers();
        const userId = '11111111-1111-4111-8111-111111111111';
        const fake = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: userId,
            state: 'STARTING', generation: 1, lease_epoch: 1 })] }, { yield: async () => {} });
        const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, db: { ...fake.db,
            query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never, { signal });
        mocks.ensure.mockImplementation(async () => fake.placements[0]!.state === 'RUNNING' ? { ok: true } : starting);
        mocks.preview.mockResolvedValue({ ok: true, codePreviewUrl: 'https://preview.test/code', guacamoleUrl: 'https://preview.test/desktop' });
        return { fake, caller };
    }

    it.each(['codePreviewUrl', 'previewUrl'] as const)('%s hands off within the held ask when placement becomes ready', async surface => {
        const { fake, caller } = setup();
        const done = vi.fn();
        const held = (surface === 'previewUrl' ? caller.previewUrl({ computerId, sessionId: computerId })
            : caller.codePreviewUrl({ computerId })).then(done);
        await vi.advanceTimersByTimeAsync(249);
        expect(done).not.toHaveBeenCalled();
        expect(mocks.preview).not.toHaveBeenCalled();
        fake.placements[0]!.state = 'RUNNING';
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(done).toHaveBeenCalledWith(expect.objectContaining({ ok: true, computeProvider: 'aws-ec2' }));
        expect(mocks.ensure).toHaveBeenCalledTimes(2);
        expect(mocks.preview).toHaveBeenCalledOnce();
        expect(mocks.prepare).toHaveBeenCalledOnce();
    });

    it('shares the concurrency bound between Code and desktop and returns the existing answer to further asks', async () => {
        const { fake, caller } = setup();
        const held = caller.codePreviewUrl({ computerId });
        await vi.advanceTimersByTimeAsync(0);
        expect(await caller.previewUrl({ computerId, sessionId: computerId })).toEqual(waitingAnswer);
        expect(vi.getTimerCount()).toBe(1);
        fake.placements[0]!.state = 'RUNNING';
        await vi.advanceTimersByTimeAsync(250);
        expect(await held).toMatchObject({ ok: true });
        expect(mocks.ensure).toHaveBeenCalledTimes(3);
        expect(mocks.preview).toHaveBeenCalledOnce();
    });

    it('returns the exact existing starting response after eight seconds', async () => {
        const { caller } = setup();
        const done = vi.fn();
        const held = caller.codePreviewUrl({ computerId }).then(done);
        await vi.advanceTimersByTimeAsync(7_999);
        expect(done).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        await held;
        expect(done).toHaveBeenCalledExactlyOnceWith(waitingAnswer);
        expect(mocks.ensure).toHaveBeenCalledOnce();
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(mocks.prepare).toHaveBeenCalledOnce();
    });

    it('keeps a fresh ensure refusal after readiness, without minting', async () => {
        const { fake, caller } = setup();
        const held = caller.codePreviewUrl({ computerId });
        await vi.advanceTimersByTimeAsync(0);
        fake.placements[0]!.state = 'RUNNING';
        mocks.ensure.mockResolvedValue({ ok: false, error: 'kill_switch', errorCode: 'kill_switch', retryable: false });
        await vi.advanceTimersByTimeAsync(250);
        expect(await held).toMatchObject({ ok: false, errorCode: 'kill_switch', retryable: false });
        expect(mocks.preview).not.toHaveBeenCalled();
    });

    it('forwards the tRPC disconnect signal and does no further work after abort', async () => {
        const controller = new AbortController();
        const { caller } = setup(controller.signal);
        const held = caller.codePreviewUrl({ computerId });
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        expect(await held).toEqual(waitingAnswer);
        expect(mocks.ensure).toHaveBeenCalledOnce();
        expect(mocks.prepare).toHaveBeenCalledOnce();
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe.each(['previewUrl', 'codePreviewUrl', 'appPreviewUrl'] as const)('%s AWS refusal pass-through', surface => {
    it.each([
        ['kill_switch', 'Your AWS computer is paused by operations'],
        ['aws_disabled', 'Your AWS computer is paused by operations'],
        ['capacity_unavailable', 'No capacity in India right now'],
        ['user_hours_cap', "This month's computer hours are used up"],
        ['global_hours_cap', "This month's computer hours are used up"],
        ['aws_lifecycle_start_failed', 'Something went wrong'],
    ])('%s returns its code as a value and renders %s', async (errorCode, title) => {
        mocks.ensure.mockResolvedValue({ ok: false, error: errorCode, errorCode, retryable: false });
        const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: '11111111-1111-4111-8111-111111111111' },
            db: { query: { computers: { findFirst: async () => ({ id: computerId }) } } } } as never);
        const result = await (surface === 'previewUrl'
            ? caller.previewUrl({ computerId, sessionId: computerId })
            : caller[surface]({ computerId }));
        expect(result).toMatchObject({ ok: false, errorCode, computeProvider: 'aws-ec2' });
        const state = computeBootUiState({ requestStatus: 'error', elapsedMs: 0, errorCode: (result as { errorCode: BootErrorCode }).errorCode });
        expect(state.kind).toBe('failed');
        if (state.kind !== 'failed') throw new Error('Expected refusal');
        expect(BOOT_FAILURE_COPY[state.reason].title).toBe(title);
        expect(isRetryableBootErrorCode(errorCode)).toBe(errorCode === 'aws_lifecycle_start_failed');
        expect(mocks.ensure).toHaveBeenCalledTimes(1);
        expect(mocks.preview).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});


describe('AWS desktop restart router', () => {
    const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const caller = (owned = true) => cloudflareGuacamoleRouter.createCaller({
        user: { id: '11111111-1111-4111-8111-111111111111' },
        db: { query: { computers: { findFirst: async () => owned ? { id: computerId } : undefined } } },
    } as never);
    it('returns requested without claiming completion and preserves the retry ID', async () => {
        mocks.restart.mockResolvedValue({ ok: true, outcome: 'restart_requested' });
        expect(await caller().restartDesktop({ computerId, requestId })).toMatchObject({ ok: true, outcome: 'restart_requested' });
        await caller().restartDesktop({ computerId, requestId });
        expect(mocks.restart.mock.calls.map(c => c[0])).toEqual([{ correlationId: requestId }, { correlationId: requestId }]);
        expect(mocks.ensure).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('returns an honest redacted refusal value', async () => {
        mocks.restart.mockResolvedValue({ ok: false, outcome: 'LEAK', error: 'LEAK' });
        expect(await caller().restartDesktop({ computerId })).toMatchObject({ ok: false, errorCode: 'restart_unavailable' });
    });
    it('ownership failure never dispatches restart', async () => {
        await expect(caller(false).restartDesktop({ computerId })).rejects.toThrow();
        expect(mocks.restart).not.toHaveBeenCalled();
    });
});
