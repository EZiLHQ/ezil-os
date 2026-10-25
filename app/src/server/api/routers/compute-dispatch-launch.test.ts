import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ start: vi.fn(), describe: vi.fn() }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string } | null; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure.use(({ ctx, next }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
        return next({ ctx: { ...ctx, user: ctx.user } });
    }) };
});
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/api/routers/computer-store', () => ({ stampOpened: vi.fn() }));
vi.mock('@/server/lib/ai-credential', () => ({ syncAiCredential: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ config: {}, now: () => new Date() }) }));
vi.mock('@/server/billing/v2/compute-access', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/billing/v2/compute-access')>(),
    billingV2EntitlementReader: () => ({ read: async () => null }),
}));
vi.mock('@/server/billing/v2/compute-meter', () => ({ billingComputeMeter: () => ({ ready: vi.fn() }) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => ({ starter: { start: effects.start }, executions: { describe: effects.describe } }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
import { awsPreviewAnswer } from './compute-dispatch';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import { LIFECYCLE_DEPLOYMENTS_ENV } from '@/server/lib/compute/aws-intent';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

const U = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const F = '33333333-3333-4333-8333-333333333333';
const env = {
    EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_BROWSER_ZONE: 'preview.example',
    EZIL_AWS_WAKE_MODE: 'replace', EZIL_AWS_ENROLL_URL: 'https://app.example/api/compute/aws/enroll',
    EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1',
    AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': fixtureDeployment('ap-south-1') }),
};
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.resetAllMocks();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'unit-test-only');
    effects.describe.mockResolvedValue({ status: 'RUNNING' });
    fetcher = vi.fn(async () => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('real preview/open replacement answers', () => {
    for (const surface of ['previewUrl', 'appPreviewUrl', 'codePreviewUrl'] as const) {
        it.each(['replace', 'uncertain replace', 'start', 'provision', 'refused'])(`${surface}: %s grants only an admitted replacement the launch budget`, async mode => {
            vi.useFakeTimers();
            if (mode === 'start') vi.stubEnv('EZIL_AWS_WAKE_MODE', 'start');
            if (mode === 'refused') effects.start.mockRejectedValue(Object.assign(new Error('refused'), {
                name: 'ExecutionLimitExceeded', $metadata: { httpStatusCode: 400 },
            }));
            if (mode === 'uncertain replace') effects.start.mockRejectedValue(Object.assign(new Error('lost answer'), { code: 'ECONNRESET' }));
            const f = createFakePlacementDb({ computers: [{ id: C, user_id: U }], placements: [placementRow({
                computer_id: C, owner_user_id: U, region: 'ap-south-1', instance_type: 'm6i.large',
                ...(mode === 'provision' ? { state: 'PROVISIONING', lifecycle_job_id: F, lifecycle_digest: 'a'.repeat(64) }
                    : { instance_id: 'i-11111111111111111', volume_id: 'vol-11111111111111111',
                    fs_uuid: F, fence_token: F }),
            })] }, { yield: async () => {} });
            const db = { ...f.db, query: { computers: { findFirst: async () => ({ id: C }) } } };
            const open = async () => {
                const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: U }, db } as never);
                const response = surface === 'previewUrl' ? caller.previewUrl({ computerId: C, sessionId: F }) : caller[surface]({ computerId: C });
                await vi.runAllTimersAsync();
                return response;
            };
            const answer = await open();
            const replacing = mode === 'replace' || mode === 'uncertain replace';
            expect(answer).toMatchObject({ ok: false, computeProvider: 'aws-ec2',
                errorCode: mode === 'refused' ? 'aws_lifecycle_start_failed' : 'sandbox_starting', retryable: mode !== 'refused' });
            if (replacing) expect(answer).toHaveProperty('computeLaunching', true);
            else expect(answer).not.toHaveProperty('computeLaunching');
            expect(answer).not.toHaveProperty('computeMigrating');
            const startCount = mode === 'provision' ? 0 : mode === 'uncertain replace' ? 3 : 1;
            expect(effects.start).toHaveBeenCalledTimes(startCount);
            if (startCount) {
                const input = effects.start.mock.calls[0]![1].input;
                expect(JSON.parse(JSON.parse(input).document).operation).toBe(mode === 'start' ? 'start' : 'replace');
            }
            if (mode !== 'refused') {
                const repeated = await open();
                if (replacing) expect(repeated).toHaveProperty('computeLaunching', true);
                else expect(repeated).not.toHaveProperty('computeLaunching');
                expect(effects.start).toHaveBeenCalledTimes(startCount);
            }
            expect(fetcher).not.toHaveBeenCalled();
        });
    }
});

describe('preview launch guard', () => {
    const pending = { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true, computeLaunching: true } as const;
    const preview = vi.fn(async () => ({ ok: false as const, error: 'aws_origin_starting', errorCode: 'sandbox_starting' }));
    it('preserves a strict true flag only on retryable computer_starting', async () => {
        expect(await awsPreviewAnswer(pending, preview)).toMatchObject({ computeLaunching: true, errorCode: 'sandbox_starting' });
        expect(preview).not.toHaveBeenCalled();
    });
    const nonTrue = [undefined, null, false, 'true', 'false', 1, 0, {}, []];
    it.each(nonTrue.map(computeLaunching => ({ computeLaunching })))('rejects non-boolean launch flag $computeLaunching', async ({ computeLaunching }) => {
        expect(await awsPreviewAnswer({ ...pending, computeLaunching } as never, preview)).not.toHaveProperty('computeLaunching');
        expect(preview).not.toHaveBeenCalled();
    });
    it.each(nonTrue.map(retryable => ({ retryable })))('rejects non-boolean retryability $retryable', async ({ retryable }) => {
        expect(await awsPreviewAnswer({ ...pending, retryable } as never, preview)).not.toHaveProperty('computeLaunching');
        expect(preview).not.toHaveBeenCalled();
    });
    it.each(['computer_stopping', 'computer_migrating', 'capacity_unavailable', 'sandbox_starting'])('rejects unrelated pending code %s', async errorCode => {
        expect(await awsPreviewAnswer({ ...pending, errorCode }, preview)).not.toHaveProperty('computeLaunching');
        expect(preview).not.toHaveBeenCalled();
    });
    it('a ready ensure drops stale launch evidence even if the preview origin is still starting', async () => {
        expect(await awsPreviewAnswer({ ...pending, ok: true }, preview)).not.toHaveProperty('computeLaunching');
        expect(preview).toHaveBeenCalledTimes(1);
    });
});
