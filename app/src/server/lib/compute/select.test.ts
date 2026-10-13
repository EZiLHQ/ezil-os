/**
 * Placement-aware provider selection (C-1, C-2, R13). The flag-off path is
 * the production path today and must not touch the database at all.
 */

import { describe, expect, it } from 'vitest';

import { AwsProviderNotImplementedError, createAwsEc2StubProvider } from './aws-ec2';
import { cloudflareComputeProvider } from './cloudflare';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { PlacementIntegrityError, PlacementOwnerError } from './placement';
import { providerForPlacement, resolveComputeProvider, selectComputeProvider } from './select';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId, computerId };
const ON = { EZIL_AWS_COMPUTERS_ENABLED: '1' };

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
            if (aws === '1') await expect(ensure).rejects.toBeInstanceOf(AwsProviderNotImplementedError);
            else expect(await ensure).toEqual({ ok: false, error: 'aws_disabled', errorCode: 'aws_disabled', retryable: false });
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
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId })] });
        expect((await resolveComputeProvider(db, { userId: userId.toUpperCase(), computerId }, ON)).kind).toBe('aws-ec2');
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
