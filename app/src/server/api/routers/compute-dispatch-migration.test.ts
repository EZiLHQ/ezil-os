import { initTRPC, TRPCError } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const effects = vi.hoisted(() => ({ start: vi.fn(), describe: vi.fn(), ready: vi.fn() }));
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
vi.mock('@/server/billing/v2/compute-meter', () => ({ billingComputeMeter: () => ({ ready: effects.ready }) }));
vi.mock('@/server/lib/compute/aws-clients', () => ({
    sharedAwsSdkCollaborators: () => ({ starter: { start: effects.start }, executions: { describe: effects.describe } }),
}));

import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';
import { cloudflareMigrationAnswer, routeComputer } from './compute-dispatch';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import { LIFECYCLE_DEPLOYMENTS_ENV } from '@/server/lib/compute/aws-intent';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { MIGRATION_STATES, TERMINAL_MIGRATION_STATES } from '@/server/lib/compute/provider-migrate';
import { deriveGuacamoleSandboxId, classifyWorkerHttpFailure, isRetryablePreviewErrorCode } from '@/server/lib/cloudflare-guacamole-provider';
import { resolveComputeProvider } from '@/server/lib/compute/select';
import { providerForPendingMigration } from '@/server/lib/compute/provider-migrate-placement';
import * as migrationStore from '@/server/lib/compute/provider-migrate-store';

const U = '11111111-1111-4111-8111-111111111111';
const C = '22222222-2222-4222-8222-222222222222';
const M = '33333333-3333-4333-8333-333333333333';
const FOREIGN = '44444444-4444-4444-8444-444444444444';
const I = 'i-11111111111111111', V = 'vol-11111111111111111';
const computer = { computerId: C, userId: U };
const pending = { ok: false, errorCode: 'sandbox_starting', retryable: true, computeProvider: 'aws-ec2' };
const env = {
    EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_BROWSER_ZONE: 'preview.example',
    AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': fixtureDeployment('ap-south-1') }),
};
const receipt = { schemaVersion: 1, computerId: C, jobId: M, generation: 1, leaseEpoch: 1,
    digest: 'a'.repeat(64), fenceToken: M, instanceId: I, volumeId: V, state: 'running' };
const awsRow = () => placementRow({ computer_id: C, owner_user_id: U, state: 'PROVISIONING', region: 'ap-south-1',
    generation: 1, lease_epoch: 1, instance_type: 'm6i.large', instance_id: I, volume_id: V, fs_uuid: M,
    lifecycle_job_id: M, lifecycle_digest: receipt.digest, fence_token: M, enroll_consumed_hash: 'b'.repeat(64),
    lease_until: new Date(Date.now() + 3600_000), last_error: `migration_pending:${M}` });
const cfRow = () => placementRow({ computer_id: C, owner_user_id: U, provider: 'cloudflare', workspace_store: 'r2' });

/** Real router, selector, migration reads and receipt writes; only external I/O is faked. */
function fixture(placements: Record<string, unknown>[] = [cfRow()]) {
    const f = createFakePlacementDb({ placements });
    let migration: Record<string, unknown> | null = { id: M, computer_id: C, user_id: U,
        from_provider: 'cloudflare', to_provider: 'aws-ec2', to_size: 'standard', state: 'provisioning',
        attempts: 0, created_at: '2026-10-22', updated_at: '2026-10-22' };
    const dialect = new PgDialect();
    const queries: string[] = [];
    const db = { ...f.db, query: { computers: { findFirst: async () => ({ id: C }) } }, execute: async (q: Parameters<typeof f.db.execute>[0]) => {
        const { sql, params } = dialect.sqlToQuery(q);
        queries.push(sql);
        if (sql.includes('FROM public.ezil_compute_migrations')) {
            const active = !sql.includes('state NOT IN') || !TERMINAL_MIGRATION_STATES.includes(migration?.state as never);
            const matches = params[0] === (sql.includes('WHERE id =') ? migration?.id : migration?.computer_id);
            return { rows: migration && active && matches ? [migration] : [] };
        }
        return f.db.execute(q);
    } };
    const caller = cloudflareGuacamoleRouter.createCaller({ user: { id: U }, db } as never);
    return { ...f, db, caller, queries, setMigration: (m: Record<string, unknown> | null) => { migration = m; },
        changeMigration: (patch: Record<string, unknown>) => { Object.assign(migration!, patch); } };
}

const calls = {
    previewUrl: (c: ReturnType<typeof fixture>['caller']) => c.previewUrl({ computerId: C, sessionId: M }),
    appPreviewUrl: (c: ReturnType<typeof fixture>['caller']) => c.appPreviewUrl({ computerId: C }),
    codePreviewUrl: (c: ReturnType<typeof fixture>['caller']) => c.codePreviewUrl({ computerId: C }),
    status: (c: ReturnType<typeof fixture>['caller']) => c.status({ computerId: C }),
};
const previewCalls = Object.entries(calls).filter(([name]) => name !== 'status');
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
    vi.clearAllMocks();
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'unit-test-only');
    effects.describe.mockResolvedValue({ status: 'SUCCEEDED', output: JSON.stringify(receipt) });
    fetcher = vi.fn(async () => { throw new Error('Unexpected network request'); });
    vi.stubGlobal('fetch', fetcher);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('same-open paid migration routing', () => {
    for (const [name, call] of Object.entries(calls)) {
        it.each(['implicit', 'cloudflare', 'aws-ec2'])(`${name}: pending %s placement uses the AWS wake budget without touching either host`, async placement => {
            const f = fixture(placement === 'implicit' ? [] : [placement === 'cloudflare' ? cfRow() : awsRow()]);
            const before = structuredClone(f.placements);
            await expect(call(f.caller)).resolves.toMatchObject(pending);
            expect(f.placements).toEqual(before);
            expect(fetcher).not.toHaveBeenCalled();
            expect(effects.describe).not.toHaveBeenCalled();
            expect(effects.start).not.toHaveBeenCalled();
            expect(effects.ready).not.toHaveBeenCalled();
        });

        it(`${name}: committed migration is ready on the next poll and applies the receipt once`, async () => {
            const f = fixture([awsRow()]);
            await expect(call(f.caller)).resolves.toMatchObject(pending);
            expect(f.usage).toHaveLength(0);
            f.changeMigration({ state: 'committed' });
            const sandboxId = deriveGuacamoleSandboxId(U, C);
            const url = (port: number) => `https://aws-${port}-${sandboxId}-aws.preview.example/preview-bootstrap?token=unit&path=%2F`;
            fetcher.mockImplementation(async () => Response.json({ ok: true, provider: 'aws-ec2', mode: 'neko',
                sandboxId, generation: 1, leaseEpoch: 1, expiresAt: Date.now() + 60_000,
                guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443) }));
            const answer = await call(f.caller);
            expect(answer).toMatchObject({ ok: true, computeProvider: 'aws-ec2' });
            if (name === 'status') expect(answer).toMatchObject({ guacamoleRunning: true, state: 'running' });
            else expect(answer).toHaveProperty('codePreviewUrl');
            expect(f.placements[0]).toMatchObject({ state: 'RUNNING', last_error: 'enroll_succeeded', lifecycle_job_id: null });
            expect(f.usage).toHaveLength(1);
            expect(effects.ready).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ overheadSeconds: 0, size: 'std-2' }));
            expect(effects.describe).toHaveBeenCalledTimes(1);
            expect(effects.start).not.toHaveBeenCalled();
        });

        it(`${name}: foreign placement is NOT_FOUND before reservation or migration reads`, async () => {
            const f = fixture([{ ...awsRow(), owner_user_id: FOREIGN }]);
            await expect(call(f.caller)).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(f.queries).toEqual([expect.stringContaining('/* placement:read */')]);
            expect(fetcher).not.toHaveBeenCalled();
        });

        it(`${name}: foreign migration owner is NOT_FOUND`, async () => {
            const f = fixture([]); f.changeMigration({ user_id: FOREIGN });
            await expect(call(f.caller)).rejects.toMatchObject({ code: 'NOT_FOUND' });
            expect(fetcher).not.toHaveBeenCalled();
        });
    }

    it.each(MIGRATION_STATES.filter(s => !TERMINAL_MIGRATION_STATES.includes(s)))('keeps %s fenced, including recovery', async state => {
        const f = fixture(); f.changeMigration({ state, last_error: 'recovery:reopen:commit' });
        await expect(calls.status(f.caller)).resolves.toMatchObject(pending);
        const routed = await routeComputer(f.db, computer);
        for (const op of ['activity', 'restart', 'stop', 'terminate'] as const) {
            const result = await routed.provider[op]({ correlationId: M }, computer, 'user' as never);
            expect(result.ok).toBe(false);
        }
        expect(fetcher).not.toHaveBeenCalled();
        expect(effects.start).not.toHaveBeenCalled();
    });

    it.each([{ to_provider: 'unknown' }, { from_provider: 'unknown' }, { state: 'unknown' }])('fails closed on malformed migration %j', async patch => {
        const f = fixture(); f.changeMigration(patch);
        await expect(calls.status(f.caller)).rejects.toThrow('migration_conflict');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([{ computerId: FOREIGN }, { state: 'committed' }])('fails closed on inconsistent active migration read %j', async patch => {
        const f = fixture();
        const store = migrationStore.createProviderMigrationStore(f.db);
        const migration = (await store.readActiveByComputer(C))!;
        vi.spyOn(migrationStore, 'createProviderMigrationStore').mockReturnValue({ ...store,
            readActiveByComputer: async () => ({ ...migration, ...patch }) as typeof migration });
        await expect(providerForPendingMigration(f.db, computer)).rejects.toThrow('migration_conflict');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each(['duplicate', 'unknown'])('fails closed on %s placement before migration reads', async kind => {
        const f = fixture(kind === 'duplicate' ? [awsRow(), awsRow()] : [{ ...awsRow(), provider: 'unknown' }]);
        await expect(calls.status(f.caller)).rejects.toThrow();
        expect(f.queries).toEqual([expect.stringContaining('/* placement:read */')]);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('the resolver itself checks ownership before reservation reads', async () => {
        const f = fixture([{ ...awsRow(), owner_user_id: FOREIGN }]);
        await expect(resolveComputeProvider(f.db, computer, env)).rejects.toThrow();
        expect(f.queries).toEqual([expect.stringContaining('/* placement:read */')]);
    });
});

describe('Cloudflare migration fence replies', () => {
    it.each([200, 409])('status: a migration fence appearing after dispatch is re-routed (HTTP %i)', async status => {
        const f = fixture();
        const migration = await migrationStore.createProviderMigrationStore(f.db).readActiveByComputer(C);
        f.setMigration(null);
        fetcher.mockImplementation(async () => {
            f.setMigration({ id: migration!.id, computer_id: C, user_id: U, state: 'provisioning',
                from_provider: 'cloudflare', to_provider: 'aws-ec2' });
            return Response.json({ ok: false, error: 'migrating' }, { status });
        });
        await expect(calls.status(f.caller)).resolves.toMatchObject(pending);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('status: an unrelated CF 409 is not labelled as an AWS migration', async () => {
        const f = fixture(); f.setMigration(null);
        fetcher.mockResolvedValue(Response.json({ ok: false, error: 'other_conflict' }, { status: 409 }));
        const answer = await calls.status(f.caller);
        expect(answer).toMatchObject({ ok: false, error: 'http_409' });
        expect(answer).not.toHaveProperty('computeProvider');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each([{ ok: true, status: 200 }, { ok: false, status: 500 }])('status: re-routing requires a failure and a conflict (%j)', async ({ ok, status }) => {
        const f = fixture(); f.setMigration(null);
        fetcher.mockImplementation(async () => {
            f.setMigration({ id: M, computer_id: C, user_id: U, state: 'provisioning',
                from_provider: 'cloudflare', to_provider: 'aws-ec2' });
            return Response.json({ ok, error: 'migrating' }, { status });
        });
        const answer = await calls.status(f.caller);
        expect(answer).toMatchObject({ ok, error: status === 200 ? 'migrating' : 'http_500' });
        expect(answer).not.toHaveProperty('computeProvider');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(previewCalls)('%s: a CF 409 migrating after dispatch stays retryable with the AWS wake budget', async (_name, call) => {
        const f = fixture(); f.setMigration(null);
        fetcher.mockImplementation(async () => Response.json({ ok: false, error: 'migrating', workspace: { mounted: false } }, { status: 409 }));
        await expect(call(f.caller)).resolves.toMatchObject(pending);
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('the adapter classifies the migration fence as retryable progress', () => {
        const code = classifyWorkerHttpFailure(409, '{"error":"migrating"}');
        expect(code).toBe('sandbox_starting');
        expect(isRetryablePreviewErrorCode(code)).toBe(true);
    });

    it.each([
        { ok: true, error: 'worker_http_409: {"error":"migrating"}' },
        { ok: false, error: 'worker_http_500: {"error":"migrating"}' },
        { ok: false, error: 'worker_http_409: {"error":"other_conflict"}' },
        { ok: false, error: 'worker_http_409: not json' },
        { ok: false, error: 'sandbox_starting' },
    ])('does not relabel unrelated Cloudflare replies %j', reply => {
        expect(cloudflareMigrationAnswer(reply)).toBeNull();
    });
});
