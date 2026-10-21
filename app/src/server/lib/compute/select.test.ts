/**
 * Placement-aware provider selection (C-1, C-2, R13). The flag-off path is
 * the production path today and must not touch the database at all.
 */

import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import * as awsFactories from './aws-ec2';
import { AwsProviderNotImplementedError, createAwsEc2StubProvider } from './aws-ec2';
import { cloudflareComputeProvider } from './cloudflare';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { PlacementIntegrityError, PlacementOwnerError } from './placement';
import { providerForPlacement, resolveComputeProvider, selectComputeProvider } from './select';
import type { EntitlementRecord } from './tier';

const migrationRead = vi.hoisted(() => vi.fn(async (): Promise<Partial<Record<'userId' | 'state' | 'lastError', string>> | null> => null));
vi.mock('./provider-migrate-store', () => ({ createProviderMigrationStore: () => ({ readByComputer: migrationRead }) }));

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId, computerId };
const ON = { EZIL_AWS_COMPUTERS_ENABLED: '1' };
const ADMIT = {
    AWS_MAX_RUNNING: '2', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
};

describe('billing v2 placement selection', () => {
    const paid: EntitlementRecord = { source: 'billing_v2', status: 'active', planId: 'compute_monthly_v2', provider: 'aws', size: 'cmp-8', paymentIssue: false };
    const free: EntitlementRecord = { source: 'billing_v2', status: 'active', planId: 'free_v1_legacy', provider: 'cloudflare', size: 'free-cf', paymentIssue: false };
    const SINCE = '2026-10-14T00:00:00Z';
    const DIRECT = { ...ON, EZIL_AWS_CANARY_SINCE: SINCE };

    it.each([SINCE, '2026-10-14T00:00:00.001Z'])('(c) paid + no row + created at/after SINCE (%s) selects AWS without a canary list or Cloudflare pin', async createdAt => {
        const { db, placements, statements } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date(createdAt) }] });
        expect((await resolveComputeProvider(db, computer, DIRECT, {}, { entitlement: paid, pinCloudflare: true })).kind).toBe('aws-ec2');
        expect(placements).toEqual([]);
        expect(statements).toHaveLength(2); // placement and live computer reads; admission happens at ensure
    });

    it.each([false, true])('(a) paid + no row + created before SINCE stays Cloudflare (pinCloudflare=%s)', async pinCloudflare => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date('2026-10-13T23:59:59.999Z') }] });
        const provider = await resolveComputeProvider(db, computer, DIRECT, {}, { entitlement: paid, pinCloudflare });
        expect(provider.kind).toBe('cloudflare');
        expect(provider).toBe(cloudflareComputeProvider);
        if (pinCloudflare) expect(placements).toMatchObject([{ provider: 'cloudflare', workspace_store: 'r2', state: 'STOPPED' }]);
        else expect(placements).toEqual([]);
    });

    it.each([false, true])('(b) paid + no row + SINCE unset stays Cloudflare (pinCloudflare=%s)', async pinCloudflare => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date(SINCE) }] });
        const provider = await resolveComputeProvider(db, computer, ON, {}, { entitlement: paid, pinCloudflare });
        expect(provider.kind).toBe('cloudflare');
        expect(provider).toBe(cloudflareComputeProvider);
        if (pinCloudflare) expect(placements).toMatchObject([{ provider: 'cloudflare', workspace_store: 'r2', state: 'STOPPED' }]);
        else expect(placements).toEqual([]);
    });

    it.each(['', '2026-10-14', '2026-10-14T00:00:00', 'yesterday', '2026-13-40T00:00:00Z'])('paid + no row + malformed SINCE %j stays Cloudflare', async since => {
        const { db, placements, statements } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date(SINCE) }] });
        expect(await resolveComputeProvider(db, computer, { ...ON, EZIL_AWS_CANARY_SINCE: since }, {}, { entitlement: paid })).toBe(cloudflareComputeProvider);
        expect(placements).toEqual([]);
        expect(statements).toHaveLength(1);
    });

    it.each([
        { computers: [] },
        { computers: [{ id: computerId, user_id: userId, created_at: new Date(SINCE), deleted_at: new Date(SINCE) }] },
        { computers: [{ id: computerId, user_id: '33333333-3333-4333-8333-333333333333', created_at: new Date(SINCE) }] },
    ])('paid route requires a live computer owned by the caller (%j)', async ({ computers }) => {
        const { db } = createFakePlacementDb({ computers });
        expect(await resolveComputeProvider(db, computer, DIRECT, {}, { entitlement: paid })).toBe(cloudflareComputeProvider);
    });

    it('AWS disabled preserves the Cloudflare pin behavior even for a paid user', async () => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId }] });
        expect(await resolveComputeProvider(db, computer, { EZIL_COMPUTE_PLACEMENT_READS: '1' }, {}, { entitlement: paid, pinCloudflare: true })).toBe(cloudflareComputeProvider);
        expect(placements).toMatchObject([{ provider: 'cloudflare', workspace_store: 'r2' }]);
    });

    it.each([
        ['cloudflare', 'r2', paid], ['aws-ec2', 'ebs', free],
    ] as const)('an existing %s row keeps its provider despite entitlement', async (provider, workspace_store, entitlement) => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, provider, workspace_store })] });
        expect((await resolveComputeProvider(db, computer, ON, {}, { entitlement, pinCloudflare: true })).kind).toBe(provider);
        expect(placements).toHaveLength(1);
        expect(placements[0]!.provider).toBe(provider);
    });

    it('a payment issue does not grant the paid route', async () => {
        const { db } = createFakePlacementDb();
        expect(await resolveComputeProvider(db, computer, ON, {}, { entitlement: { ...paid, paymentIssue: true } })).toBe(cloudflareComputeProvider);
    });

    it.each([free, { ...free, status: 'past_due', paymentIssue: true }])('Free/delinquent records still follow the existing canary rule (%j)', async entitlement => {
        const { db } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date('2026-10-15T00:00:00Z') }] });
        const env = { ...ON, ...ADMIT, EZIL_AWS_CANARY_USER_IDS: '*', EZIL_AWS_CANARY_SINCE: '2026-10-14T00:00:00Z' };
        expect((await resolveComputeProvider(db, computer, env, {}, { entitlement })).kind).toBe('aws-ec2');
    });
});

describe('resolveComputeProvider', () => {
    it.each([{}, { EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_COMPUTERS_ENABLED: 'true' }])('flag off (%j): Cloudflare with ZERO statements', async (env) => {
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId })] });
        expect(await resolveComputeProvider(db, computer, env)).toBe(cloudflareComputeProvider);
        expect(statements).toEqual([]);
    });

    it('flag on, no row: Cloudflare', async () => {
        const { db, statements } = createFakePlacementDb();
        expect(await resolveComputeProvider(db, computer, ON)).toBe(cloudflareComputeProvider);
        expect(statements).toHaveLength(1);
    });

    it('flag on, aws-ec2 row: the aws-ec2 provider', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId })] });
        expect((await resolveComputeProvider(db, computer, ON)).kind).toBe('aws-ec2');
    });

    it('flag on, explicit cloudflare row: Cloudflare', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, provider: 'cloudflare', workspace_store: 'r2' })] });
        expect(await resolveComputeProvider(db, computer, ON)).toBe(cloudflareComputeProvider);
    });

    it('flag on, duplicate or unknown: fails closed, never Cloudflare', async () => {
        const dup = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId }), placementRow({ computer_id: computerId })] });
        await expect(resolveComputeProvider(dup.db, computer, ON)).rejects.toBeInstanceOf(PlacementIntegrityError);
        const unknown = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, provider: 'azure' })] });
        await expect(resolveComputeProvider(unknown.db, computer, ON)).rejects.toBeInstanceOf(PlacementIntegrityError);
    });

    it('a database error (e.g. missing table) propagates; it is not "no row"', async () => {
        const db = { execute: async () => { throw new Error('relation "public.ezil_computer_placements" does not exist'); } };
        await expect(resolveComputeProvider(db, computer, ON)).rejects.toThrow(/does not exist/);
    });

    describe('flag matrix: reads x AWS x row', () => {
        const ctx = { correlationId: 'c' };
        const rows = {
            none: [],
            cloudflare: [placementRow({ computer_id: computerId, provider: 'cloudflare', workspace_store: 'r2' })],
            'aws-ec2': [placementRow({ computer_id: computerId })],
        } as const;
        const cases = [undefined, '0', '1'].flatMap((reads) =>
            [undefined, '1'].flatMap((aws) => (Object.keys(rows) as (keyof typeof rows)[]).map((row) => [reads, aws, row] as const)),
        );
        it.each(cases)('READS=%s AWS=%s row=%s', async (reads, aws, row) => {
            const env = { EZIL_COMPUTE_PLACEMENT_READS: reads, EZIL_AWS_COMPUTERS_ENABLED: aws };
            const { db, statements } = createFakePlacementDb({ placements: [...rows[row]] });
            const provider = await resolveComputeProvider(db, computer, env);
            const readsOn = reads === '1' || aws === '1';
            if (!readsOn) {
                expect(provider).toBe(cloudflareComputeProvider);
                expect(statements).toEqual([]);
                return;
            }
            expect(statements).toHaveLength(1);
            if (row !== 'aws-ec2') {
                expect(provider).toBe(cloudflareComputeProvider);
                return;
            }
            expect(provider.kind).toBe('aws-ec2');
            const ensure = provider.ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' });
            // AWS on but no caps/regions configured: the real provider refuses before any write.
            if (aws === '1') expect(await ensure).toEqual({ ok: false, error: 'aws_config_invalid', errorCode: 'aws_config_invalid', retryable: false });
            else expect(await ensure).toEqual({ ok: false, error: 'aws_disabled', errorCode: 'aws_disabled', retryable: false });
            expect(statements).toHaveLength(1);
        });
    });

    it('a placement owned by someone else refuses every provider operation (re-inserted computer row)', async () => {
        const { db } = createFakePlacementDb({
            placements: [placementRow({ computer_id: computerId, owner_user_id: '66666666-6666-4666-8666-666666666666' })],
        });
        await expect(resolveComputeProvider(db, computer, ON)).rejects.toBeInstanceOf(PlacementOwnerError);
        await expect(resolveComputeProvider(db, computer, { EZIL_COMPUTE_PLACEMENT_READS: '1' })).rejects.toBeInstanceOf(PlacementOwnerError);
        const cf = createFakePlacementDb({
            placements: [placementRow({ computer_id: computerId, provider: 'cloudflare', workspace_store: 'r2', owner_user_id: '66666666-6666-4666-8666-666666666666' })],
        });
        await expect(resolveComputeProvider(cf.db, computer, ON)).rejects.toBeInstanceOf(PlacementOwnerError);
    });

    it('the owner matches case-insensitively', async () => {
        const UA = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: UA })] });
        expect((await resolveComputeProvider(db, { userId: UA.toUpperCase(), computerId }, ON)).kind).toBe('aws-ec2');
    });

    it('selectComputeProvider (existing callers) is unchanged', () => {
        expect(selectComputeProvider(computer)).toBe(cloudflareComputeProvider);
        expect(providerForPlacement({ provider: 'cloudflare' })).toBe(cloudflareComputeProvider);
    });
});

describe('aws-ec2 stub', () => {
    const ctx = { correlationId: 'c' };
    const ops = (p: ReturnType<typeof createAwsEc2StubProvider>) => [
        ['ensure', () => p.ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' })],
        ['status', () => p.status(ctx, computer)],
        ['activity', () => p.activity(ctx, computer, { lastInputAgoMs: 0 })],
        ['restart', () => p.restart(ctx, computer)],
        ['stop', () => p.stop(ctx, computer, 'user')],
        ['terminate', () => p.terminate(ctx, computer)],
    ] as const;

    it('flag off: every operation refuses with aws_disabled', async () => {
        for (const [, op] of ops(createAwsEc2StubProvider(() => ({})))) {
            const r = (await op()) as { ok: boolean; error?: string };
            expect(r.ok).toBe(false);
            expect(r.error).toBe('aws_disabled');
        }
        const e = await createAwsEc2StubProvider(() => ({})).ensure(ctx, computer, { sessionId: 's', desktopMode: 'neko' });
        expect(e).toEqual({ ok: false, error: 'aws_disabled', errorCode: 'aws_disabled', retryable: false });
        const s = await createAwsEc2StubProvider(() => ({})).stop(ctx, computer, 'user');
        expect(s.terminated).toBe(false);
    });

    it('flag on: every operation throws not-implemented', async () => {
        for (const [name, op] of ops(createAwsEc2StubProvider(() => ON))) {
            await expect(op(), name).rejects.toBeInstanceOf(AwsProviderNotImplementedError);
        }
    });
});

describe('resolveComputeProvider: AWS canary cohort (no placement row)', () => {
    const SINCE = '2026-10-14T00:00:00Z';
    const after = new Date('2026-10-14T12:00:00Z');
    const before = new Date('2026-10-13T23:59:59Z');
    const other = '33333333-3333-4333-8333-333333333333';
    // A full admission config: the canary routes to AWS only when admission would admit (precheckAdmission).
    const CANARY = { ...ON, ...ADMIT, EZIL_AWS_CANARY_USER_IDS: ` ${other}, ${userId.toUpperCase()} `, EZIL_AWS_CANARY_SINCE: SINCE };
    const seeded = (c: Partial<{ user_id: string; deleted_at: Date | null; created_at: Date }> = {}) =>
        createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: after, ...c }] });
    const canaryReads = (statements: { sql: string }[]) => statements.filter((s) => s.sql.includes('placement:canary-computer'));

    it('listed user, computer created after SINCE, AWS on: the aws-ec2 provider', async () => {
        const { db, statements } = seeded();
        expect((await resolveComputeProvider(db, computer, CANARY)).kind).toBe('aws-ec2');
        expect(canaryReads(statements)).toHaveLength(1);
    });

    it('computer created before SINCE stays on Cloudflare (it may hold an R2 workspace)', async () => {
        const { db } = seeded({ created_at: before });
        expect(await resolveComputeProvider(db, computer, CANARY)).toBe(cloudflareComputeProvider);
    });

    it('unlisted user: Cloudflare, and the computer row is never read', async () => {
        const { db, statements } = seeded();
        expect(await resolveComputeProvider(db, computer, { ...CANARY, EZIL_AWS_CANARY_USER_IDS: other })).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it('placement reads on but AWS off: Cloudflare, no canary read', async () => {
        const { db, statements } = seeded();
        const env = { ...CANARY, EZIL_AWS_COMPUTERS_ENABLED: undefined, EZIL_COMPUTE_PLACEMENT_READS: '1' };
        expect(await resolveComputeProvider(db, computer, env)).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it.each([`${userId},not-a-uuid`, `${userId},`, ''])('malformed list (%j): no cohort', async (list) => {
        const { db, statements } = seeded();
        expect(await resolveComputeProvider(db, computer, { ...CANARY, EZIL_AWS_CANARY_USER_IDS: list })).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it.each([undefined, '', '2026-10-14', '2026-10-14T00:00:00', 'yesterday', '2026-13-40T00:00:00Z'])('SINCE %j: no cohort', async (since) => {
        const { db, statements } = seeded();
        expect(await resolveComputeProvider(db, computer, { ...CANARY, EZIL_AWS_CANARY_SINCE: since })).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it('an existing cloudflare row wins over the cohort', async () => {
        const { db, statements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: computerId, provider: 'cloudflare', workspace_store: 'r2' })],
            computers: [{ id: computerId, user_id: userId, created_at: after }],
        });
        expect(await resolveComputeProvider(db, computer, CANARY)).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it('computer row owned by another user: Cloudflare', async () => {
        const { db } = seeded({ user_id: other });
        expect(await resolveComputeProvider(db, computer, CANARY)).toBe(cloudflareComputeProvider);
    });

    it('deleted or missing computer row: Cloudflare', async () => {
        expect(await resolveComputeProvider(seeded({ deleted_at: after }).db, computer, CANARY)).toBe(cloudflareComputeProvider);
        expect(await resolveComputeProvider(createFakePlacementDb().db, computer, CANARY)).toBe(cloudflareComputeProvider);
    });

    it('a failed or unparsable canary read rejects (never AWS or Cloudflare by accident)', async () => {
        const failing = { execute: async (q: Parameters<typeof db.execute>[0]) => {
            const text = new PgDialect().sqlToQuery(q).sql;
            if (text.includes('placement:canary-computer')) throw new Error('connection reset');
            return db.execute(q);
        } };
        const { db } = createFakePlacementDb();
        await expect(resolveComputeProvider(failing, computer, CANARY)).rejects.toThrow('connection reset');
        const garbled = { execute: async (q: Parameters<typeof db.execute>[0]) =>
            new PgDialect().sqlToQuery(q).sql.includes('placement:canary-computer')
                ? { rows: [{ user_id: userId, deleted: false, created_at: 'not a date' }] } : db.execute(q) };
        await expect(resolveComputeProvider(garbled, computer, CANARY)).rejects.toBeInstanceOf(PlacementIntegrityError);
    });
});

describe('resolveComputeProvider: canary `*` (every user) with the admission fallback', () => {
    const SINCE = '2026-10-14T00:00:00Z';
    const after = new Date('2026-10-14T12:00:00Z');
    const EVERYONE = { ...ON, ...ADMIT, EZIL_AWS_CANARY_USER_IDS: '*', EZIL_AWS_CANARY_SINCE: SINCE };
    const otherUser = '44444444-4444-4444-8444-444444444444';
    const mine = { id: computerId, user_id: userId, created_at: after };
    const aws = (id: string, owner: string, state = 'RUNNING') =>
        placementRow({ computer_id: id, owner_user_id: owner, provider: 'aws-ec2', state, region: 'us-east-1' });
    const canaryReads = (statements: { sql: string }[]) => statements.filter((s) => s.sql.includes('placement:canary-computer'));

    it('routes a new no-row computer of ANY signed-in user to AWS while admission would admit', async () => {
        const { db } = createFakePlacementDb({ computers: [mine] });
        expect((await resolveComputeProvider(db, computer, EVERYONE)).kind).toBe('aws-ec2');
    });

    it('falls back to Cloudflare when running AWS computers are at the cap', async () => {
        const { db } = createFakePlacementDb({
            computers: [mine],
            placements: [aws('55555555-5555-4555-8555-555555555555', otherUser), aws('66666666-6666-4666-8666-666666666666', otherUser)],
        });
        expect(await resolveComputeProvider(db, computer, EVERYONE)).toBe(cloudflareComputeProvider);
    });

    it('falls back to Cloudflare when the user already has an AWS computer', async () => {
        const { db } = createFakePlacementDb({ computers: [mine], placements: [aws('77777777-7777-4777-8777-777777777777', userId, 'STOPPED')] });
        expect(await resolveComputeProvider(db, computer, EVERYONE)).toBe(cloudflareComputeProvider);
    });

    it('falls back to Cloudflare when the user monthly hour cap is reached', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
        try {
            const { db } = createFakePlacementDb({
                computers: [mine],
                usage: [{ computer_id: '88888888-8888-4888-8888-888888888888', user_id: userId, instance_id: 'i-1', instance_type: 't3a.medium',
                    started_at: new Date('2026-10-01T00:00:00Z'), stopped_at: new Date('2026-10-06T00:00:00Z'), egress_bytes: null, observed_by: 't', updated_at: new Date('2026-10-06T00:00:00Z') }],
            });
            expect(await resolveComputeProvider(db, computer, EVERYONE)).toBe(cloudflareComputeProvider); // 120 h >= 100 h
            const { db: under } = createFakePlacementDb({ computers: [mine] });
            expect((await resolveComputeProvider(under, computer, EVERYONE)).kind).toBe('aws-ec2');
        } finally {
            vi.useRealTimers();
        }
    });

    it('falls back to Cloudflare when the kill switch is on, or the admission config is incomplete', async () => {
        const { db } = createFakePlacementDb({ computers: [mine] });
        expect(await resolveComputeProvider(db, computer, { ...EVERYONE, EZIL_AWS_KILL_SWITCH: '1' })).toBe(cloudflareComputeProvider);
        expect(await resolveComputeProvider(db, computer, { ...EVERYONE, AWS_MAX_RUNNING: undefined })).toBe(cloudflareComputeProvider);
    });

    it.each(['*,' + userId, userId + ',*', ' * , * '])('`*` beside anything else (%j) is malformed: no cohort, no canary read', async (list) => {
        const { db, statements } = createFakePlacementDb({ computers: [mine] });
        expect(await resolveComputeProvider(db, computer, { ...EVERYONE, EZIL_AWS_CANARY_USER_IDS: list })).toBe(cloudflareComputeProvider);
        expect(canaryReads(statements)).toEqual([]);
    });

    it('an existing row always wins over `*`: cloudflare stays Cloudflare, aws stays AWS', async () => {
        const cf = createFakePlacementDb({ computers: [mine], placements: [placementRow({ computer_id: computerId, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' })] });
        expect(await resolveComputeProvider(cf.db, computer, EVERYONE)).toBe(cloudflareComputeProvider);
        expect(canaryReads(cf.statements)).toEqual([]);
        const full = [aws('55555555-5555-4555-8555-555555555555', otherUser), aws('66666666-6666-4666-8666-666666666666', otherUser)];
        const own = createFakePlacementDb({ computers: [mine], placements: [...full, aws(computerId, userId, 'STOPPED')] });
        expect((await resolveComputeProvider(own.db, computer, EVERYONE)).kind).toBe('aws-ec2');
    });

    it('a computer created before SINCE stays Cloudflare under `*`', async () => {
        const { db } = createFakePlacementDb({ computers: [{ ...mine, created_at: new Date('2026-10-13T00:00:00Z') }] });
        expect(await resolveComputeProvider(db, computer, EVERYONE)).toBe(cloudflareComputeProvider);
    });
});

describe('fresh provision routing', () => {
    it.each([{ EZIL_AWS_COMPUTERS_ENABLED: '1' }, { EZIL_COMPUTE_PLACEMENT_READS: '1' },
        { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '1' }])('never re-pins a proven-empty old computer with %j', async env => {
        migrationRead.mockResolvedValueOnce({ userId, state: 'committed', lastError: 'fresh_provision' });
        const f = createFakePlacementDb();
        expect((await resolveComputeProvider(f.db, computer, env, {}, { pinCloudflare: true })).kind).toBe('aws-ec2');
        expect(f.placements).toEqual([]);
    });
    it('does not use another owner’s fresh-provision outcome', async () => {
        migrationRead.mockResolvedValueOnce({ userId: computerId, state: 'committed', lastError: 'fresh_provision' });
        const f = createFakePlacementDb();
        expect((await resolveComputeProvider(f.db, computer, ON)).kind).toBe('cloudflare');
    });
});

it('rechecks fresh-provision completion while acquiring the Cloudflare pin lock', async () => {
    migrationRead.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId, state: 'committed', lastError: 'fresh_provision' });
    const f = createFakePlacementDb();
    expect((await resolveComputeProvider(f.db, computer, ON, {}, { pinCloudflare: true })).kind).toBe('aws-ec2');
    expect(f.placements).toEqual([]);
});

it('confines a fresh paid cutover to Mumbai even when other regions have capacity', async () => {
    migrationRead.mockResolvedValueOnce({ userId, state: 'committed', lastError: 'fresh_provision' });
    const factory = vi.spyOn(awsFactories, 'createAwsEc2Provider');
    await resolveComputeProvider(createFakePlacementDb().db, computer, { ...ON, AWS_REGIONS: 'us-east-1,ap-south-1' });
    expect(factory.mock.calls.at(-1)?.[0].env?.().AWS_REGIONS).toBe('ap-south-1');
    factory.mockRestore();
});
