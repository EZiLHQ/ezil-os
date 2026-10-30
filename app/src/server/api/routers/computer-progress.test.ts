/**
 * `computer.progress`: ownership is checked server-side BEFORE the placement
 * is read, a foreign computer is NOT_FOUND (never FORBIDDEN), and the procedure
 * only reads.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ readComputerProgress: vi.fn() }));

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
vi.mock('./compute-dispatch', () => ({ routeComputer: vi.fn(() => { throw new Error('progress must not route (routing can pin)'); }) }));
vi.mock('@/server/lib/compute/progress', () => ({ readComputerProgress: h.readComputerProgress }));

import { computerRouter } from '@/server/api/routers/computer';

const OWNER = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222222';
const INFO = { version: 1, computerId: C1, stage: 'operations_paused', recordedStage: 'stopped', operationsPaused: true, active: false, durable: false, bytes: { transferred: null, total: null }, percent: null, etaSeconds: null };

function dbOwning(owned: boolean) {
    return { query: { computers: { findFirst: vi.fn(async () => (owned ? { id: C1 } : undefined)) } } };
}

beforeEach(() => {
    h.readComputerProgress.mockReset().mockResolvedValue(INFO);
});

describe('computer.progress', () => {
    it("returns the owner's system info", async () => {
        const db = dbOwning(true);
        const info = await computerRouter.createCaller({ user: { id: OWNER }, db } as never).progress({ computerId: C1 });
        expect(info).toEqual(INFO);
        expect(h.readComputerProgress).toHaveBeenCalledWith(db, { computerId: C1, userId: OWNER });
    });

    it('a computer that is not the caller\'s live row: NOT_FOUND, and the placement is never read', async () => {
        const call = computerRouter.createCaller({ user: { id: OWNER }, db: dbOwning(false) } as never).progress({ computerId: C1 });
        await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(h.readComputerProgress).not.toHaveBeenCalled();
    });

    it("a placement recorded for another owner (reader returns null): NOT_FOUND", async () => {
        h.readComputerProgress.mockResolvedValue(null);
        const call = computerRouter.createCaller({ user: { id: OWNER }, db: dbOwning(true) } as never).progress({ computerId: C1 });
        await expect(call).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('signed out: UNAUTHORIZED; a non-uuid id: BAD_REQUEST', async () => {
        await expect(computerRouter.createCaller({ user: null, db: dbOwning(true) } as never).progress({ computerId: C1 }))
            .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(computerRouter.createCaller({ user: { id: OWNER }, db: dbOwning(true) } as never).progress({ computerId: 'nope' }))
            .rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
});
