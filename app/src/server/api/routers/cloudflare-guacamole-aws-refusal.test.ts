import { initTRPC } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BOOT_FAILURE_COPY, computeBootUiState, isRetryableBootErrorCode, type BootErrorCode } from '@/components/desktop/boot-phases';

const mocks = vi.hoisted(() => ({ route: vi.fn(), ensure: vi.fn(), preview: vi.fn(), restart: vi.fn() }));
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
vi.mock('@/server/lib/compute/aws-preview', () => ({ requestAwsPreview: mocks.preview }));
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
    mocks.route.mockReset().mockResolvedValue({ kind: 'aws-ec2', provider: { ensure: mocks.ensure, restart: mocks.restart }, instanceType: 't3a.medium' });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(['previewUrl', 'codePreviewUrl', 'appPreviewUrl'] as const)('%s AWS refusal pass-through', surface => {
    it.each([
        ['kill_switch', 'Your Mumbai computer is paused by operations'],
        ['aws_disabled', 'Your Mumbai computer is paused by operations'],
        ['capacity_unavailable', 'No Mumbai capacity right now'],
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
