/**
 * P3 per-computer dispatch (docs/AWS-COMPUTERS.md C-1, R13).
 *
 * - Placement reads OFF (production default): no database read, the exact
 *   pre-P3 Cloudflare adapter instance.
 * - Reads ON: no row / cloudflare row → that same adapter; aws-ec2 row → the
 *   AWS provider, never Cloudflare; a foreign placement → NOT_FOUND before any
 *   provider call (two users).
 * - Routers: an AWS computer never reaches the Cloudflare Worker (no fetch),
 *   not-ready answers are VALUES, a user stop is `stop` (keeps disks), delete
 *   retires or refuses — never deletes data, never falls back to Cloudflare.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ softDelete: vi.fn() }));

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
import { cloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

import { awsDepsFor, awsPreviewAnswer, awsStatusAnswer, routeComputer, shellCodeForAwsEnsure } from './compute-dispatch';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];
const AWS_ENV: Record<string, string> = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
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

    it('a duplicate placement fails closed (never Cloudflare)', async () => {
        const { db } = routerDb([placementRow({ computer_id: C1 }), placementRow({ computer_id: C1 })]);
        await expect(routeComputer(db, computer, { env: AWS_ENV })).rejects.toThrow();
    });

    it('the tier the AWS provider gets: free without an entitlement, plus only for an active listed plan', async () => {
        const env = { ...AWS_ENV, EZIL_AWS_PLUS_PLAN_IDS: 'os-plus' };
        const seen: string[] = [];
        const paid = { read: async (u: string) => { seen.push(u); return { status: 'active', planId: 'os-plus' }; } };
        const cancelled = { read: async () => ({ status: 'cancelled', planId: 'os-plus' }) };
        await expect(awsDepsFor(env, paid).tierFor(U1)).resolves.toBe('plus');
        expect(seen).toEqual([U1]);
        await expect(awsDepsFor(env, cancelled).tierFor(U1)).resolves.toBe('free');
        await expect(awsDepsFor(env, undefined).tierFor(U1)).resolves.toBe('free');
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

describe('shell-facing AWS answers', () => {
    it('a waking AWS computer is the shell\'s existing `sandbox_starting` (its wake loop re-asks)', () => {
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: true })).toBe('sandbox_starting');
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_stopping', retryable: true })).toBe('sandbox_starting');
    });

    it('a deterministic refusal keeps its own code (capacity is never dressed up as waking)', () => {
        expect(shellCodeForAwsEnsure({ ok: false, error: 'region_capacity', errorCode: 'capacity_unavailable', retryable: false })).toBe('capacity_unavailable');
        expect(shellCodeForAwsEnsure({ ok: false, error: 'x', errorCode: 'computer_starting', retryable: false })).toBe('computer_starting');
        expect(awsPreviewAnswer({ ok: false, error: 'x', errorCode: 'aws_disabled', retryable: false })).toMatchObject({ ok: false, errorCode: 'aws_disabled', computeProvider: 'aws-ec2' });
    });

    it('ready but no AWS desktop URL route yet → a refusal value, not a Cloudflare URL', () => {
        expect(awsPreviewAnswer({ ok: true })).toMatchObject({ ok: false, errorCode: 'aws_desktop_url_unavailable', computeProvider: 'aws-ec2' });
    });

    it('status: guacamoleRunning is true only for a running AWS computer', () => {
        expect(awsStatusAnswer({ ok: true, state: 'running' } as never)).toMatchObject({ guacamoleRunning: true, computeProvider: 'aws-ec2' });
        expect(awsStatusAnswer({ ok: true, state: 'starting' } as never).guacamoleRunning).toBe(false);
        expect(awsStatusAnswer({ ok: true, state: 'stopped' } as never).guacamoleRunning).toBe(false);
        expect(awsStatusAnswer({ ok: false, state: 'running' } as never).guacamoleRunning).toBe(false);
    });
});

describe('routers: an AWS computer never reaches the Cloudflare Worker', () => {
    const awsRow = (over: Record<string, unknown> = {}) =>
        placementRow({ computer_id: C1, owner_user_id: U1, state: 'STOPPED', region: 'ap-south-1', instance_type: 't3a.medium', instance_id: 'i-0123456789abcdef0', volume_id: 'vol-0123456789abcdef0', ...over });
    const caller = (db: unknown, user = U1) => cloudflareGuacamoleRouter.createCaller({ user: { id: user }, db } as never);

    beforeEach(() => {
        for (const [k, v] of Object.entries(AWS_ENV)) vi.stubEnv(k, v);
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

    it('reportActivity and restartDesktop answer the AWS refusal, no Worker call', async () => {
        const { db } = routerDb([awsRow({ state: 'RUNNING' })]);
        await expect(caller(db).reportActivity({ computerId: C1, lastInputAgoMs: 5 })).resolves.toMatchObject({ ok: false, error: 'aws_not_supported' });
        await expect(caller(db).restartDesktop({ computerId: C1 })).resolves.toMatchObject({ ok: false, errorCode: 'aws_not_supported' });
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
        expect(after).toHaveLength(3);
        expect(after.every((s) => /placement:read \*\//.test(s.sql))).toBe(true);
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

    it('a Cloudflare computer still deletes through the Worker teardown, exactly as before', async () => {
        const { db } = routerDb([]);
        fetchMock.mockImplementation(async () => Response.json({ ok: true, terminated: true, outcome: 'destroyed' }));
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).resolves.toMatchObject({ id: C1 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'DELETE' });
    });
});
