import { initTRPC, TRPCError } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

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
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: {} }));
import { computerRouter } from './computer';

const USER = '11111111-1111-4111-8111-111111111111';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const FOREIGN = '33333333-3333-4333-8333-333333333333';

function fixture(overrides: Record<string, unknown> | null = {}, owned = true) {
    const store = createFakePlacementDb({ placements: overrides === null ? [] : [placementRow({
        computer_id: COMPUTER, owner_user_id: USER, provider: 'aws-ec2', region: 'ap-south-1', ...overrides,
    })] });
    const findFirst = vi.fn<(input: { where: SQL }) => Promise<{ id: string } | undefined>>()
        .mockResolvedValue(owned ? { id: COMPUTER } : undefined);
    const db = { ...store.db, query: { computers: { findFirst } } };
    const caller = computerRouter.createCaller({ user: { id: USER }, db } as never);
    return { ...store, findFirst, db, caller };
}

beforeEach(() => {
    vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
    vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '');
    vi.stubEnv('EZIL_AWS_REQUIRED_USER_IDS', '');
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('metadata must not call a provider'); }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('computer.computePlacement: actual placement without starting compute', () => {
    it('reports AWS and region even with AWS admission off, without resource identifiers or secrets', async () => {
        const f = fixture({ last_error: 'private-provider-detail', instance_id: 'i-private' });
        await expect(f.caller.computePlacement({ id: COMPUTER })).resolves.toEqual({
            status: 'placed', provider: 'aws-ec2', region: 'ap-south-1', state: 'STOPPED', fallback: false, awsRequired: false,
        });
        expect(f.statements).toHaveLength(1);
        expect(f.statements[0]!.sql).toMatch(/SELECT/);
        expect(f.statements[0]!.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/);
        expect(fetch).not.toHaveBeenCalled();
        const where = new PgDialect().sqlToQuery(f.findFirst.mock.calls[0]![0]!.where);
        expect(where.params).toEqual([COMPUTER, USER]);
        expect(where.sql).toMatch(/deleted_at.*is null/);
    });

    it.each([null, 'cloudflare_fallback:admission_refused:capacity_unavailable'])('labels CF fallback only when recorded (%s)', async last_error => {
        const f = fixture({ provider: 'cloudflare', workspace_store: 'r2', last_error });
        await expect(f.caller.computePlacement({ id: COMPUTER })).resolves.toMatchObject({
            provider: 'cloudflare', region: null, fallback: last_error !== null,
        });
    });

    it('does not call an unplaced computer Cloudflare or AWS', async () => {
        const f = fixture(null);
        await expect(f.caller.computePlacement({ id: COMPUTER })).resolves.toMatchObject({ status: 'unplaced', provider: null });
        expect(f.placements).toEqual([]);
        expect(f.statements).toHaveLength(1);
    });

    it('shows the founder requirement without an optional environment list', async () => {
        const f = fixture(null);
        const caller = computerRouter.createCaller({ user: { id: '1ae9b1fd-880b-42ac-aebe-433b3c0ba11f' }, db: f.db } as never);
        await expect(caller.computePlacement({ id: COMPUTER })).resolves.toMatchObject({
            status: 'unplaced', provider: null, awsRequired: true,
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports unavailable without database reads when placement reads are off', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '');
        const f = fixture();
        await expect(f.caller.computePlacement({ id: COMPUTER })).resolves.toMatchObject({ status: 'unavailable', provider: null });
        expect(f.statements).toEqual([]);
    });

    it('refuses deleted or foreign computers before a placement lookup', async () => {
        const f = fixture({}, false);
        await expect(f.caller.computePlacement({ id: COMPUTER })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(f.statements).toEqual([]);
    });

    it('refuses a mismatched recorded placement owner', async () => {
        const f = fixture({ owner_user_id: FOREIGN });
        await expect(f.caller.computePlacement({ id: COMPUTER })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('does not turn unknown providers or database failures into a provider label', async () => {
        const f = fixture({ provider: 'unknown' });
        await expect(f.caller.computePlacement({ id: COMPUTER })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        f.db.execute = vi.fn(async () => { throw new Error('database secret'); });
        await expect(f.caller.computePlacement({ id: COMPUTER })).rejects.toMatchObject({ message: 'Compute provider unavailable' });
    });

    it('requires authentication before any lookup', async () => {
        const f = fixture();
        const caller = computerRouter.createCaller({ user: null, db: f.db } as never);
        await expect(caller.computePlacement({ id: COMPUTER })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(f.findFirst).not.toHaveBeenCalled();
        expect(f.statements).toEqual([]);
    });
});
