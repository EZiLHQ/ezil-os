/**
 * P3 per-computer dispatch (docs/AWS-COMPUTERS.md C-1, R13).
 *
 * - Placement reads OFF (production default): no database read, the exact
 *   pre-P3 Cloudflare adapter instance.
 * - Reads ON: no row / cloudflare row → that same adapter; aws-ec2 row → the
 *   AWS provider, never Cloudflare; a foreign placement → NOT_FOUND before any
 *   provider call (two users).
 * - Routers: AWS previews use the Worker's AWS route; lifecycle refusals never fetch,
 *   not-ready answers are VALUES, a user stop is `stop` (keeps disks), delete
 *   retires or refuses — never deletes data, never falls back to Cloudflare.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ softDelete: vi.fn(), billingDeps: vi.fn() }));

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: captured.billingDeps }));

vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string } | null; db: unknown }>().create();
    return {
        createTRPCRouter: t.router,
        protectedProcedure: t.procedure.use(({ ctx, next }) => {
            if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
            return next({ ctx: { ...ctx, user: ctx.user } });
        }),
    };
});
vi.mock('@/server/api/routers/computer-store', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        stampOpened: vi.fn(async () => {}),
        softDeleteComputer: captured.softDelete,
    };
});
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: { CRON_SECRET: 'cron', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'env-secret' } }));

import { cloudflareGuacamoleRouter } from '@/server/api/routers/cloudflare-guacamole';
import { computerRouter } from '@/server/api/routers/computer';
import { LIFECYCLE_DEPLOYMENTS_ENV } from '@/server/lib/compute/aws-intent';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import type { LifecycleStarter } from '@/server/lib/compute/aws-ec2';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { cloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { ImageJobConflictError } from '@/server/lib/compute/placement';

import { awsDepsFor, awsPreviewAnswer, awsStatusAnswer, confirmAwsStop, defaultAwsCollaborators, routeComputer, shellCodeForAwsEnsure } from './compute-dispatch';
import { appCallerRoleEnv } from '@/server/lib/compute/aws-clients';
import { readBillingConfig } from '@/server/billing/config';
import type { BillingDeps, BillingStore } from '@/server/billing/ports';
import type { EntitlementRecord } from '@/server/lib/compute/tier';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const IMAGE_JOB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];
const AWS_ENV: Record<string, string> = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    // The configured AWS browser zone: the ONLY zone the AWS preview handoff accepts.
    EZIL_AWS_BROWSER_ZONE: 'preview.example',
    AWS_MAX_RUNNING: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1,us-east-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({
        'ap-south-1': fixtureDeployment('ap-south-1', TYPES),
        'us-east-1': fixtureDeployment('us-east-1', TYPES),
    }),
};
const ctxOpts = { correlationId: 'corr' };
const computer = { userId: U1, computerId: C1 };

/** A db that fails the test if anything reads it (placement reads OFF). */
const untouchableDb = {
    execute: vi.fn(async () => { throw new Error('db read with placement reads off'); }),
    transaction: vi.fn(async () => { throw new Error('db transaction with placement reads off'); }),
};

/** The fake placement db plus the ownership lookup the routers do first. */
function routerDb(placements: Record<string, unknown>[], computerOwner = U1) {
    const fake = createFakePlacementDb({ placements, computers: [{ id: C1, user_id: computerOwner }] });
    const db = {
        ...fake.db,
        query: { computers: { findFirst: async () => ({ id: C1 }) } },
    };
    return { fake, db };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    captured.billingDeps.mockReset().mockReturnValue({ config: readBillingConfig({}), store: {}, stripe: null, usage: null, now: () => new Date() });
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'router-secret');
    fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    captured.softDelete.mockReset();
    captured.softDelete.mockImplementation(async (_db: unknown, args: { terminateSandbox: () => Promise<void> }) => {
        await args.terminateSandbox();
        return { id: C1, slot: 1, deletedAt: new Date(), sandboxTerminated: true };
    });
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('routeComputer', () => {
    it('reads OFF: no database access, the identical pre-P3 Cloudflare adapter', async () => {
        const routed = await routeComputer(untouchableDb, computer, { env: {} });
        expect(routed.kind).toBe('cloudflare');
        expect(routed.provider).toBe(cloudflareComputeProvider);
        expect(untouchableDb.execute).not.toHaveBeenCalled();
        expect(untouchableDb.transaction).not.toHaveBeenCalled();
        expect(captured.billingDeps).not.toHaveBeenCalled();
    });

    it('reads ON, no placement row → the same Cloudflare adapter', async () => {
        const { db } = routerDb([]);
        const routed = await routeComputer(db, computer, { env: { EZIL_COMPUTE_PLACEMENT_READS: '1' } });
        expect(routed.kind).toBe('cloudflare');
        expect(routed.provider).toBe(cloudflareComputeProvider);
    });

    it('reads ON, cloudflare row → the same Cloudflare adapter', async () => {
        const { db } = routerDb([placementRow({ computer_id: C1, provider: 'cloudflare', workspace_store: 'r2' })]);
        const routed = await routeComputer(db, computer, { env: { EZIL_COMPUTE_PLACEMENT_READS: '1' } });
        expect(routed.provider).toBe(cloudflareComputeProvider);
    });

    it('aws-ec2 row → the AWS provider, never Cloudflare (even with the AWS flag off: it refuses)', async () => {
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U1 })]);
        const on = await routeComputer(db, computer, { env: AWS_ENV });
        expect(on.kind).toBe('aws-ec2');
        expect(on.provider.kind).toBe('aws-ec2');
        const off = await routeComputer(db, computer, { env: { EZIL_COMPUTE_PLACEMENT_READS: '1' } });
        expect(off.kind).toBe('aws-ec2');
        await expect(off.provider.ensure(ctxOpts, computer, { sessionId: 's', desktopMode: 'neko' })).resolves.toMatchObject({ ok: false, errorCode: 'aws_disabled' });
    });

    it('two users: a placement owned by U2 is NOT_FOUND for U1, before any provider exists', async () => {
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U2 })]);
        await expect(routeComputer(db, computer, { env: AWS_ENV })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // ...and U2 (the recorded owner) is routed to their AWS computer.
        await expect(routeComputer(db, { userId: U2, computerId: C1 }, { env: AWS_ENV })).resolves.toMatchObject({ kind: 'aws-ec2' });
    });

    it.each(['aws-ec2', 'cloudflare'] as const)('%s reservation: routing checks ownership before querying the image job', async provider => {
        const { db, fake } = routerDb([placementRow({ computer_id: C1, owner_user_id: U2,
            provider, workspace_store: provider === 'aws-ec2' ? 'ebs' : 'r2', image_upgrade_job_id: IMAGE_JOB })]);
        fake.imageJobs.push({ computer_id: C1, job_id: IMAGE_JOB, phase: 'requested' });
        const read = vi.fn(async () => null);
        await expect(routeComputer(db, computer, { env: AWS_ENV, entitlements: { read } })).rejects.toMatchObject({
            code: 'NOT_FOUND', message: 'Computer not found',
        });
        expect(fake.statements.map(s => s.sql)).toEqual([expect.stringContaining('/* placement:read */')]);
        expect(read).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();

        fake.statements.length = 0;
        await expect(routeComputer(db, { userId: U2, computerId: C1 }, { env: AWS_ENV })).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(fake.statements.map(s => s.sql)).toEqual([
            expect.stringContaining('/* placement:read */'), expect.stringContaining('/* placement:image-reservation */'),
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a duplicate placement fails closed (never Cloudflare)', async () => {
        const { db } = routerDb([placementRow({ computer_id: C1 }), placementRow({ computer_id: C1 })]);
        await expect(routeComputer(db, computer, { env: AWS_ENV })).rejects.toThrow();
    });

    it('the tier the AWS provider gets: free without an entitlement, plus only for an active listed plan', async () => {
        const env = { ...AWS_ENV, EZIL_AWS_PLUS_PLAN_IDS: 'os-plus' };
        const paid = { status: 'active', planId: 'os-plus' };
        const cancelled = { status: 'cancelled', planId: 'os-plus' };
        await expect(awsDepsFor(env, paid).tierFor()).resolves.toBe('plus');
        await expect(awsDepsFor(env, cancelled).tierFor()).resolves.toBe('free');
        await expect(awsDepsFor(env, undefined).tierFor()).resolves.toBe('free');
        // The collaborators pass through untouched.
        const starter: LifecycleStarter = { start: async () => {} };
        expect(awsDepsFor(env, undefined, { starter }).starter).toBe(starter);
    });

    it('a RUNNING AWS computer is ready through the routed provider (nothing started)', async () => {
        const calls: string[] = [];
        const starter: LifecycleStarter = { start: async () => { calls.push('start'); } };
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U1, state: 'RUNNING', region: 'ap-south-1', instance_type: 't3a.medium', instance_id: 'i-0123456789abcdef0', volume_id: 'vol-0123456789abcdef0' })]);
        const routed = await routeComputer(db, computer, { env: AWS_ENV, aws: { starter } });
        expect(routed.kind).toBe('aws-ec2');
        await expect(routed.provider.ensure(ctxOpts, computer, { sessionId: 's', desktopMode: 'neko' })).resolves.toEqual({ ok: true });
        expect(calls).toEqual([]);
    });
});

describe('billing v2 dispatch wiring', () => {
    const paid: EntitlementRecord = { source: 'billing_v2', status: 'active', planId: 'compute_monthly_v2', size: 'cmp-8', provider: 'aws', paymentIssue: false };
    const provisionEnv = {
        ...AWS_ENV, EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
        EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '4',
        // A NEW paid computer (created after the cutoff) provisions directly; older ones migrate (select.test.ts).
        EZIL_AWS_CANARY_SINCE: '2020-01-01T00:00:00Z',
        [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({
            'ap-south-1': fixtureDeployment('ap-south-1', [...TYPES, 'm6i.2xlarge']),
            'us-east-1': fixtureDeployment('us-east-1', [...TYPES, 'm6i.2xlarge']),
        }),
    };

    it('placement reads off never calls even an explicitly supplied reader', async () => {
        const read = vi.fn(async () => paid);
        expect((await routeComputer(untouchableDb, computer, { env: {}, entitlements: { read } })).kind).toBe('cloudflare');
        expect(read).not.toHaveBeenCalled();
    });

    it('the default reader provisions the paid size from billing exactly once', async () => {
        const now = new Date('2026-10-18T12:00:00Z');
        const store = {
            subscriptionsFor: vi.fn(async () => [{ stripeSubscriptionId: 'sub_a', sku: 'compute_monthly_v2', status: 'active',
                currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: false }]),
            userCreatedAt: vi.fn(async () => null), openPlanChanges: vi.fn(async () => []), epochsFor: vi.fn(async () => []),
            grantsForPeriod: vi.fn(async () => []), latestConsent: vi.fn(async () => null), openPaymentIssues: vi.fn(async () => []),
            sizePreference: vi.fn(async () => 'cmp-8' as const),
        };
        captured.billingDeps.mockReturnValue({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1' }), store: store as unknown as BillingStore,
            stripe: null, usage: null, now: () => now } satisfies BillingDeps);
        const { db, fake } = routerDb([]);
        const start = vi.fn(async () => {});
        const routed = await routeComputer(db, computer, { env: provisionEnv, aws: { starter: { start }, now: () => now }, pinCloudflare: true });
        expect(routed.kind).toBe('aws-ec2');
        expect(fake.placements).toEqual([]);
        expect(await routed.provider.ensure(ctxOpts, computer, { sessionId: 's', desktopMode: 'neko' })).toMatchObject({ errorCode: 'computer_starting' });
        expect(fake.placements).toMatchObject([{ provider: 'aws-ec2', instance_type: 'm6i.2xlarge' }]);
        expect(captured.billingDeps).toHaveBeenCalledTimes(1);
        expect(store.subscriptionsFor).toHaveBeenCalledExactlyOnceWith(U1);
        expect(store.sizePreference).toHaveBeenCalledExactlyOnceWith(U1);
        expect(start).toHaveBeenCalledTimes(1);
    });

    it('billing flags off with placement reads on makes ZERO store accesses', async () => {
        const access = vi.fn(() => { throw new Error('billing store touched while off'); });
        const store = new Proxy({} as BillingStore, { get: access });
        captured.billingDeps.mockReturnValue({ config: readBillingConfig({}), store, stripe: null, usage: null, now: () => new Date() } satisfies BillingDeps);
        const { db } = routerDb([]);
        expect((await routeComputer(db, computer, { env: AWS_ENV, aws: {} })).kind).toBe('cloudflare');
        expect(access).not.toHaveBeenCalled();
    });

    it.each(['status', 'terminate'] as const)('%s on a row-backed computer makes zero billing-store calls with metering on', async method => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const access = vi.fn(() => { throw new Error('Unexpected billing store call'); });
        captured.billingDeps.mockReturnValue({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1' }),
            store: new Proxy({} as BillingStore, { get: access }), stripe: null, usage: null, now: () => new Date() } satisfies BillingDeps);
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U1, provider: 'cloudflare', workspace_store: 'r2' })]);
        const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: U1 }, db } as never);
        await caller[method]({ computerId: C1 });
        expect(access).not.toHaveBeenCalled();
        expect(captured.billingDeps).not.toHaveBeenCalled();
    });

    it.each([true, false])('reportActivity on a row-backed Cloudflare computer only touches its heartbeat when metering is %s', async metering => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const at = new Date('2026-10-18T12:00:00Z');
        const touchEpoch = vi.fn<BillingStore['touchEpoch']>().mockResolvedValue('touched');
        // Any routing/state read (including loadComputeBillingState) fails this assertion,
        // even if the meter catches the error. With metering off, even touch is forbidden.
        const access = vi.fn((_target: BillingStore, key: string | symbol) => {
            if (metering && key === 'touchEpoch') return touchEpoch;
            throw new Error(`Unexpected billing store access: ${String(key)}`);
        });
        captured.billingDeps.mockReturnValue({ config: readBillingConfig(metering ? { BILLING_TAB_ENABLED: '1' } : {}),
            store: new Proxy({} as BillingStore, { get: access }), stripe: null, usage: null, now: () => at } satisfies BillingDeps);
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U1, provider: 'cloudflare', workspace_store: 'r2' })]);
        const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: U1 }, db } as never);
        await caller.reportActivity({ computerId: C1, lastInputAgoMs: 5 });
        expect(access.mock.calls.map(([, key]) => key)).toEqual(metering ? ['touchEpoch'] : []);
        if (metering) expect(touchEpoch).toHaveBeenCalledExactlyOnceWith(C1, expect.any(Date));
        else expect(touchEpoch).not.toHaveBeenCalled();
    });

    it('a paid computer at capacity stays unplaced and returns the existing refusal', async () => {
        const { db, fake } = routerDb([]);
        const read = vi.fn(async () => paid);
        const start = vi.fn(async () => {});
        const routed = await routeComputer(db, computer, { env: { ...provisionEnv,
            EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0', EZIL_AWS_MAX_RUNNING_US_EAST_1: '0',
        }, entitlements: { read }, aws: { starter: { start } }, pinCloudflare: true });
        expect(routed.kind).toBe('aws-ec2');
        expect(await routed.provider.ensure(ctxOpts, computer, { sessionId: 's', desktopMode: 'neko' })).toMatchObject({ error: 'region_capacity', errorCode: 'capacity_unavailable' });
        expect(fake.placements).toEqual([]);
        expect(read).toHaveBeenCalledExactlyOnceWith(U1);
        expect(start).not.toHaveBeenCalled();
    });

    it('billing failures log and keep the existing no-entitlement route', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { db } = routerDb([]);
        const routed = await routeComputer(db, computer, { env: AWS_ENV, aws: {}, entitlements: {
            read: async () => { throw new Error('billing unavailable'); },
        } });
        expect(routed.kind).toBe('cloudflare');
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('defaultAwsCollaborators: the real AWS clients, gated', () => {
    const ROLES = {
        [appCallerRoleEnv('ap-south-1')]: 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller-aps1',
        [appCallerRoleEnv('us-east-1')]: 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller-use1',
    };
    it('AWS off: nothing at all', () => {
        expect(defaultAwsCollaborators({})).toEqual({});
        expect(defaultAwsCollaborators({ ...ROLES, AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2' })).toEqual({});
    });
    it('AWS on but the caller unconfigured for some region: no starter or reader, so ensure/stop refuse before any write', () => {
        const half = defaultAwsCollaborators({ ...AWS_ENV, [appCallerRoleEnv('us-east-1')]: ROLES[appCallerRoleEnv('us-east-1')]! });
        expect(half.starter).toBeUndefined();
        expect(half.executions).toBeUndefined();
    });
    it('AWS on with a caller role for every region: the SDK starter and reader (built lazily; nothing is sent here)', () => {
        const all = defaultAwsCollaborators({ ...AWS_ENV, ...ROLES });
        expect(typeof all.starter?.start).toBe('function');
        expect(typeof all.executions?.describe).toBe('function');
        // Codex #6: the EC2 describe that catches a guest-initiated idle stop reaches the provider.
        expect(typeof all.describer?.describeForEnrollment).toBe('function');
        expect(typeof all.meter?.ready).toBe('function');
        expect(awsDepsFor(AWS_ENV, undefined, all).meter).toBe(all.meter);
    });
});

describe('shell-facing AWS answers', () => {
    it('a waking AWS computer is the shell\'s existing `sandbox_starting` (its wake loop re-asks)', () => {
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: true })).toBe('sandbox_starting');
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_stopping', retryable: true })).toBe('sandbox_starting');
    });

    it('a deterministic refusal keeps its own code (capacity is never dressed up as waking)', async () => {
        expect(shellCodeForAwsEnsure({ ok: false, error: 'region_capacity', errorCode: 'capacity_unavailable', retryable: false })).toBe('capacity_unavailable');
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: false })).toBe('computer_starting');
        const preview = vi.fn(async () => { throw new Error('preview after failed ensure'); });
        await expect(awsPreviewAnswer({ ok: false, error: 'x', errorCode: 'aws_disabled', retryable: false }, preview))
            .resolves.toMatchObject({ ok: false, errorCode: 'aws_disabled', computeProvider: 'aws-ec2' });
        expect(preview).not.toHaveBeenCalled();
    });

    it('ready ensure invokes the preview callback and preserves its fixed error as a value', async () => {
        const preview = vi.fn(async () => ({
            ok: false as const, error: 'aws_preview_unavailable', errorCode: 'aws_preview_unavailable',
        }));
        await expect(awsPreviewAnswer({ ok: true }, preview)).resolves.toEqual({
            ok: false, error: 'aws_preview_unavailable', errorCode: 'aws_preview_unavailable',
            provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2',
        });
        expect(preview).toHaveBeenCalledTimes(1);
    });

    it('status: guacamoleRunning is true only for a running AWS computer', () => {
        expect(awsStatusAnswer({ ok: true, state: 'running' } as never)).toMatchObject({ guacamoleRunning: true, computeProvider: 'aws-ec2' });
        expect(awsStatusAnswer({ ok: true, state: 'starting' } as never).guacamoleRunning).toBe(false);
        expect(awsStatusAnswer({ ok: true, state: 'stopped' } as never).guacamoleRunning).toBe(false);
        expect(awsStatusAnswer({ ok: false, state: 'running' } as never).guacamoleRunning).toBe(false);
    });
});

describe('routers: AWS previews use their own Worker route', () => {
    const awsRow = (over: Record<string, unknown> = {}) =>
        placementRow({ computer_id: C1, owner_user_id: U1, state: 'STOPPED', region: 'ap-south-1', instance_type: 't3a.medium', instance_id: 'i-0123456789abcdef0', volume_id: 'vol-0123456789abcdef0', ...over });
    const caller = (db: unknown, user = U1) => cloudflareGuacamoleRouter.createCaller({ user: { id: user }, db } as never);

    beforeEach(() => {
        for (const [k, v] of Object.entries(AWS_ENV)) vi.stubEnv(k, v);
    });

    it.each(['previewUrl', 'appPreviewUrl', 'codePreviewUrl', 'restartDesktop'] as const)('%s returns a terminal billing refusal before any provider call', async surface => {
        const now = new Date('2026-10-18T12:00:00Z');
        const store = {
            openEpochFor: vi.fn(async () => null),
            subscriptionsFor: vi.fn(async () => [{ stripeSubscriptionId: 'sub_a', sku: 'standard_monthly_v2', status: 'active',
                currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'), cancelAtPeriodEnd: false }]),
            userCreatedAt: vi.fn(async () => null), openPlanChanges: vi.fn(async () => []), epochsFor: vi.fn(async () => []),
            grantsForPeriod: vi.fn(async () => []), latestConsent: vi.fn(async () => null), openPaymentIssues: vi.fn(async () => []),
            sizePreference: vi.fn(async () => null),
        };
        captured.billingDeps.mockReturnValue({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            store: store as unknown as BillingStore, stripe: null, usage: null, now: () => now } satisfies BillingDeps);
        const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure');
        const restart = vi.spyOn(cloudflareComputeProvider, 'restart');
        const { db } = routerDb([placementRow({ computer_id: C1, owner_user_id: U1, provider: 'cloudflare', workspace_store: 'r2' })]);
        const result = surface === 'previewUrl'
            ? await caller(db).previewUrl({ computerId: C1, sessionId: '33333333-3333-4333-8333-333333333333' })
            : await caller(db)[surface]({ computerId: C1 });
        expect(result).toMatchObject({ ok: false, error: 'billing_allowance_exhausted', errorCode: 'billing_allowance_exhausted',
            billingRefusal: 'allowance_exhausted', provider: 'cloudflare-guacamole' });
        expect(ensure).not.toHaveBeenCalled();
        expect(restart).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([true, false])('flags-off previewUrl preserves the provider result with zero billing-store calls (placement %s)', async hasPlacement => {
        const access = vi.fn(() => { throw new Error('billing store accessed while flags off'); });
        captured.billingDeps.mockReturnValue({ config: readBillingConfig({}),
            store: new Proxy({} as BillingStore, { get: access }), stripe: null, usage: null, now: () => new Date() } satisfies BillingDeps);
        const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure').mockResolvedValue({
            ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting', retryable: true,
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const { db } = routerDb(hasPlacement
            ? [placementRow({ computer_id: C1, owner_user_id: U1, provider: 'cloudflare', workspace_store: 'r2' })] : []);
        expect(await caller(db).previewUrl({ computerId: C1, sessionId: '33333333-3333-4333-8333-333333333333' })).toEqual({
            ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting', provider: 'cloudflare-guacamole',
        });
        expect(ensure).toHaveBeenCalledTimes(1);
        expect(access).not.toHaveBeenCalled();
    });

    it('previewUrl / appPreviewUrl / codePreviewUrl answer a VALUE from the AWS provider, no Worker call', async () => {
        const { db } = routerDb([awsRow()]);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // No lifecycle starter is wired yet → refused before any write, as a value.
        for (const out of [
            await caller(db).previewUrl({ sessionId: '33333333-3333-4333-8333-333333333333', computerId: C1 }),
            await caller(db).appPreviewUrl({ computerId: C1 }),
            await caller(db).codePreviewUrl({ computerId: C1 }),
        ]) {
            expect(out).toMatchObject({ ok: false, errorCode: 'aws_lifecycle_unconfigured', computeProvider: 'aws-ec2' });
        }
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ['previewUrl', 'aws_desktop_starting'], ['previewUrl', 'aws_origin_starting'],
        ['appPreviewUrl', 'aws_desktop_starting'], ['appPreviewUrl', 'aws_origin_starting'],
        ['codePreviewUrl', 'aws_desktop_starting'], ['codePreviewUrl', 'aws_origin_starting'],
    ] as const)('%s re-asks after %s and hands off an AWS bootstrap URL', async (surface, error) => {
        for (const region of ['ap-south-1', 'us-east-1']) {
            vi.stubEnv(appCallerRoleEnv(region), 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller');
        }
        // A wake leases for an hour (aws-ec2.ts); most of it is left, so opening renews nothing.
        const { db, fake } = routerDb([awsRow({ state: 'RUNNING', generation: 7, lease_epoch: 11, lease_until: new Date(Date.now() + 3_600_000) })]);
        const sandboxId = deriveGuacamoleSandboxId(U1, C1);
        const url = (port: number) =>
            `https://aws-${port}-${sandboxId}-aws.preview.example/preview-bootstrap?token=opaque&path=%2F`;
        const ready = {
            ok: true, provider: 'aws-ec2', mode: 'neko', sandboxId, generation: 7, leaseEpoch: 11,
            guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443),
            expiresAt: Date.now() + 3_600_000,
            relay: { runtimeId: 'a'.repeat(32), expiresAt: Date.now() + 600_000 }, turnRelay: true,
        };
        fetchMock.mockResolvedValueOnce(Response.json({ ok: false, error, reason: 'LEAK' }, { status: 503 }));
        fetchMock.mockResolvedValueOnce(Response.json(ready));
        const open = () => surface === 'previewUrl'
            ? caller(db).previewUrl({ sessionId: '33333333-3333-4333-8333-333333333333', computerId: C1 })
            : caller(db)[surface]({ computerId: C1 });
        await expect(open()).resolves.toEqual({
            ok: false, error: 'sandbox_starting', errorCode: 'sandbox_starting',
            provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2',
        });
        const out = await open();
        expect(out).toMatchObject({ ...ready, provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2' });
        expect(out).not.toHaveProperty('frame.confirmed');
        expect(fetchMock).toHaveBeenCalledTimes(2);
        for (const [endpoint, init] of fetchMock.mock.calls) {
            expect(endpoint).toBe('https://worker.example/sandbox/preview');
            const token = new Headers(init.headers).get('x-ezil-auth')!;
            expect(JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString())).toMatchObject({
                sandboxId, computerId: C1, userId: U1, provider: 'aws-ec2', generation: 7, leaseEpoch: 11,
            });
        }
        // Reads only: the placement, and the month's usage for the hour caps (Codex 4275911832). No write.
        expect(fake.statements.every((s) => s.sql.includes('placement:read') || s.sql.includes('placement:usage-month')
            // The image-job reservation check (rebase contract §8) is a read too.
            || s.sql.includes('placement:image-reservation'))).toBe(true);
    });

    it('status reports the AWS lifecycle state, no Worker call', async () => {
        const { db } = routerDb([awsRow({ state: 'RUNNING' })]);
        await expect(caller(db).status({ computerId: C1 })).resolves.toMatchObject({ ok: true, state: 'running', guacamoleRunning: true, computeProvider: 'aws-ec2' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('terminate (the shell "stop") STOPS an AWS computer — never retire — and never calls the Worker', async () => {
        const { db, fake } = routerDb([awsRow({ state: 'RUNNING' })]);
        const out = await caller(db).terminate({ computerId: C1 });
        // No starter wired: refused before the placement moves; the disks are untouched.
        expect(out).toMatchObject({ ok: false, terminated: false, outcome: 'aws_lifecycle_unconfigured' });
        expect(fake.placements[0]).toMatchObject({ state: 'RUNNING' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('reportActivity renews the AWS lease from the owner\'s presence; unconfigured AWS restart is restart_unavailable; no Worker call', async () => {
        const { db, fake } = routerDb([awsRow({ state: 'RUNNING', lease_until: new Date(Date.now() + 60_000) })]);
        await expect(caller(db).reportActivity({ computerId: C1, lastInputAgoMs: 5 })).resolves.toMatchObject({ ok: true });
        // Presence 5 ms ago: the lease now runs an hour from it (Codex 4275911832).
        expect(new Date(fake.placements[0]!.lease_until as string).getTime()).toBeGreaterThan(Date.now() + 3_500_000);
        // AWS restart exists now (R3-L4); without a configured AWS control path it is refused honestly.
        await expect(caller(db).restartDesktop({ computerId: C1 })).resolves.toMatchObject({ ok: false, errorCode: 'restart_unavailable' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('two users: U1 cannot reach a computer whose placement belongs to U2 (re-inserted row) — NOT_FOUND, no provider, no Worker', async () => {
        const { db, fake } = routerDb([awsRow({ owner_user_id: U2, state: 'RUNNING' })]);
        const before = fake.statements.length;
        await expect(caller(db).previewUrl({ sessionId: '33333333-3333-4333-8333-333333333333', computerId: C1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(caller(db).status({ computerId: C1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(caller(db).terminate({ computerId: C1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        // Only placement READS happened (three, one per call); no write, no lease, no lifecycle.
        const after = fake.statements.slice(before);
        expect(after.map(s => ({ sql: s.sql, params: s.params }))).toEqual(Array.from({ length: 3 }, () => ({
            sql: expect.stringContaining('/* placement:read */'), params: [C1],
        })));
        expect(fetchMock).not.toHaveBeenCalled();
    });

    const reservedCalls = {
        previewUrl: (c: ReturnType<typeof caller>) => c.previewUrl({ computerId: C1, sessionId: C1 }),
        appPreviewUrl: (c: ReturnType<typeof caller>) => c.appPreviewUrl({ computerId: C1 }),
        codePreviewUrl: (c: ReturnType<typeof caller>) => c.codePreviewUrl({ computerId: C1 }),
        status: (c: ReturnType<typeof caller>) => c.status({ computerId: C1 }),
        terminate: (c: ReturnType<typeof caller>) => c.terminate({ computerId: C1 }),
        reportActivity: (c: ReturnType<typeof caller>) => c.reportActivity({ computerId: C1, lastInputAgoMs: 0 }),
        restartDesktop: (c: ReturnType<typeof caller>) => c.restartDesktop({ computerId: C1 }),
        relayState: (c: ReturnType<typeof caller>) => c.relayState({ computerId: C1 }),
        refreshRelay: (c: ReturnType<typeof caller>) => c.refreshRelay({ computerId: C1, runtimeId: 'a'.repeat(32) }),
        focusApp: (c: ReturnType<typeof caller>) => c.focusApp({ computerId: C1, app: 'chromium' }),
        getScreen: (c: ReturnType<typeof caller>) => c.getScreen({ computerId: C1 }),
        setScreen: (c: ReturnType<typeof caller>) => c.setScreen({ computerId: C1, width: 1920, height: 1080 }),
        confirmFrame: (c: ReturnType<typeof caller>) => c.confirmFrame({ computerId: C1, frameUrl: 'https://frame.example' }),
        confirmDisplay: (c: ReturnType<typeof caller>) => c.confirmDisplay({ computerId: C1, frameUrl: 'https://frame.example' }),
    };

    it.each(Object.entries(reservedCalls))('%s refuses a foreign reserved computer before reservation queries or Worker calls', async (_name, call) => {
        const { db, fake } = routerDb([awsRow({ owner_user_id: U2, image_upgrade_job_id: IMAGE_JOB })]);
        fake.imageJobs.push({ computer_id: C1, job_id: IMAGE_JOB, phase: 'requested' });
        await expect(call(caller(db))).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Computer not found' });
        expect(fake.statements.map(s => s.sql)).toEqual([expect.stringContaining('/* placement:read */')]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(Object.entries(reservedCalls))('%s preserves the image-job conflict for the owner', async (_name, call) => {
        const { db, fake } = routerDb([awsRow({ image_upgrade_job_id: IMAGE_JOB })]);
        fake.imageJobs.push({ computer_id: C1, job_id: IMAGE_JOB, phase: 'requested' });
        await expect(call(caller(db))).rejects.toMatchObject({ message: 'image_job_conflict', cause: expect.any(ImageJobConflictError) });
        expect(fake.statements.map(s => s.sql)).toEqual([
            expect.stringContaining('/* placement:read */'), expect.stringContaining('/* placement:image-reservation */'),
        ]);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('Cloudflare computers are unchanged with reads ON: the Worker is called exactly as before', async () => {
        const { db } = routerDb([]);
        fetchMock.mockImplementation(async () => Response.json({ ok: true, guacamoleRunning: true }));
        await expect(caller(db).status({ computerId: C1 })).resolves.toMatchObject({ ok: true, guacamoleRunning: true });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(String(fetchMock.mock.calls[0]![0])).toMatch(/\/sandbox\/[^/]+\/status$/);
    });
});

describe('computer.delete: AWS retires or refuses — never deletes data, never Cloudflare', () => {
    const awsRow = (owner = U1) => placementRow({ computer_id: C1, owner_user_id: owner, state: 'STOPPED', region: 'ap-south-1' });

    beforeEach(() => {
        for (const [k, v] of Object.entries(AWS_ENV)) vi.stubEnv(k, v);
    });

    it('retire not available → the delete is REFUSED, the row is not soft-deleted, no Worker call', async () => {
        const { db } = routerDb([awsRow()]);
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(captured.softDelete).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a foreign AWS placement → NOT_FOUND before any provider call', async () => {
        const { db } = routerDb([awsRow(U2)]);
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(captured.softDelete).not.toHaveBeenCalled();
    });

    it('delete hides a foreign image reservation and preserves the conflict for its owner', async () => {
        const { db, fake } = routerDb([{ ...awsRow(U2), image_upgrade_job_id: IMAGE_JOB }]);
        fake.imageJobs.push({ computer_id: C1, job_id: IMAGE_JOB, phase: 'requested' });
        const caller = (userId: string) => computerRouter.createCaller({ user: { id: userId }, db } as never);
        await expect(caller(U1).delete({ id: C1 })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Computer not found' });
        expect(fake.statements.map(s => s.sql)).toEqual([expect.stringContaining('/* placement:read */')]);
        fake.statements.length = 0;
        await expect(caller(U2).delete({ id: C1 })).rejects.toMatchObject({ message: 'image_job_conflict', cause: expect.any(ImageJobConflictError) });
        expect(fake.statements.map(s => s.sql)).toEqual([
            expect.stringContaining('/* placement:read */'), expect.stringContaining('/* placement:image-reservation */'),
        ]);
        expect(captured.softDelete).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('a Cloudflare computer still deletes through the Worker teardown, exactly as before', async () => {
        const { db } = routerDb([]);
        fetchMock.mockImplementation(async () => Response.json({ ok: true, terminated: true, outcome: 'destroyed' }));
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).resolves.toMatchObject({ id: C1 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    });
});

describe('Codex 4277613545: the shell stop of an AWS computer answers only a CONFIRMED stop', () => {
    const computer = { userId: U1, computerId: C1 };
    /** A provider whose stop answers `first` and whose status walks `states` (each status look applies the receipt). */
    function scripted(first: { ok: boolean; terminated: boolean; outcome?: string }, states: (string | undefined)[]) {
        const looks: string[] = [];
        const provider = {
            kind: 'aws-ec2',
            stop: vi.fn(async () => first),
            status: vi.fn(async () => { const s = states.shift(); looks.push(String(s)); return { ok: true, placementState: s }; }),
        } as never;
        let t = 0;
        const clock = { now: () => t, sleep: async (ms: number) => { t += ms; } };
        return { provider, looks, clock };
    }

    it('a running computer: the stop is started, polled through its receipt, and answered destroyed once STOPPED', async () => {
        const { provider, looks, clock } = scripted({ ok: false, terminated: false, outcome: 'stopping' }, ['STOPPING', 'STOPPING', 'STOPPED']);
        expect(await confirmAwsStop(provider, { correlationId: 'c' }, computer, { ...clock, budgetMs: 60_000, pollMs: 5_000 }))
            .toEqual({ ok: true, terminated: true, outcome: 'destroyed' });
        expect(looks).toEqual(['STOPPING', 'STOPPING', 'STOPPED']);
    });

    it('an already stopped computer: not_running, terminated false (the cold-start precondition)', async () => {
        const { provider, looks, clock } = scripted({ ok: true, terminated: false, outcome: 'already_stopped' }, []);
        expect(await confirmAwsStop(provider, { correlationId: 'c' }, computer, clock)).toEqual({ ok: true, terminated: false, outcome: 'not_running' });
        expect(looks).toEqual([]);
    });

    it.each(['placement_draining', 'placement_stopping'])('a stop already in flight (%s) is waited for, not refused', async (outcome) => {
        const { provider, clock } = scripted({ ok: false, terminated: false, outcome }, ['STOPPED']);
        expect(await confirmAwsStop(provider, { correlationId: 'c' }, computer, clock)).toEqual({ ok: true, terminated: true, outcome: 'destroyed' });
    });

    it('not settled within the budget: the shell\'s "not yet" (still_running), never a false success', async () => {
        const { provider, looks, clock } = scripted({ ok: false, terminated: false, outcome: 'stopping' }, Array(100).fill('STOPPING'));
        expect(await confirmAwsStop(provider, { correlationId: 'c' }, computer, { ...clock, budgetMs: 20_000, pollMs: 5_000 }))
            .toEqual({ ok: false, terminated: false, outcome: 'still_running' });
        expect(looks).toHaveLength(4);
    });

    it('a refusal or a stop that moves elsewhere is a failure, unchanged', async () => {
        const refused = scripted({ ok: false, terminated: false, outcome: 'placement_starting' }, []);
        expect(await confirmAwsStop(refused.provider, { correlationId: 'c' }, computer, refused.clock)).toEqual({ ok: false, terminated: false, outcome: 'placement_starting' });
        const moved = scripted({ ok: false, terminated: false, outcome: 'stopping' }, ['UNCONFIRMED']);
        expect(await confirmAwsStop(moved.provider, { correlationId: 'c' }, computer, moved.clock))
            .toEqual({ ok: false, terminated: false, outcome: 'placement_unconfirmed', error: 'placement_unconfirmed' });
    });

    it('the shell route asks for the confirmed stop', () => {
        const src = readFileSync(path.join(__dirname, '../../../app/api/shell/stop/route.ts'), 'utf8');
        expect(src).toMatch(/cloudflareGuacamole\.terminate\(\{[^}]*confirm:\s*true/);
    });
});
