/**
 * Round 3: `computer.switchConfiguration` / `computer.restartComputer` check the caller's live row
 * first (a foreign or missing computer is `foreign_computer`, and the driver never runs), then hand
 * the authenticated owner — never a client-supplied one — to the drivers.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ switch: vi.fn(), restart: vi.fn() }));
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
vi.mock('./compute-dispatch', () => ({ routeComputer: vi.fn(), switchComputerConfiguration: h.switch, restartWholeComputer: h.restart }));

import { computerRouter } from '@/server/api/routers/computer';

const OWNER = '11111111-1111-4111-8111-111111111111';
const C1 = '22222222-2222-4222-8222-222222222222';
const dbOwning = (owned: boolean) => ({ query: { computers: { findFirst: vi.fn(async () => (owned ? { id: C1 } : undefined)) } } });
const caller = (owned = true, user: { id: string } | null = { id: OWNER }) => computerRouter.createCaller({ user, db: dbOwning(owned) } as never);

beforeEach(() => {
    h.switch.mockReset().mockResolvedValue({ ok: true, effective: 'switching', current: 'std-2', target: 'cmp-8', transitionId: 't' });
    h.restart.mockReset().mockResolvedValue({ ok: true, transitionId: 't', path: 'restart', size: 'std-2' });
});

describe('computer.switchConfiguration', () => {
    it('passes the authenticated owner, the computer and the request to the driver', async () => {
        expect(await caller().switchConfiguration({ computerId: C1, size: 'cmp-8', requestId: 'click-000001' }))
            .toMatchObject({ ok: true, effective: 'switching' });
        expect(h.switch).toHaveBeenCalledWith(expect.anything(), { userId: OWNER, computerId: C1 }, { size: 'cmp-8', requestId: 'click-000001' });
    });
    it('a computer that is not the caller\'s live row is foreign_computer, and the driver never runs', async () => {
        expect(await caller(false).switchConfiguration({ computerId: C1, size: 'cmp-8', requestId: 'click-000001' })).toEqual({ ok: false, reason: 'foreign_computer' });
        expect(h.switch).not.toHaveBeenCalled();
    });
    it('validates input and authentication', async () => {
        await expect(caller(true, null).switchConfiguration({ computerId: C1, size: 'cmp-8', requestId: 'click-000001' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(caller().switchConfiguration({ computerId: C1, size: 'gpu' as never, requestId: 'click-000001' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(caller().switchConfiguration({ computerId: C1, size: 'cmp-8', requestId: 'a b' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(h.switch).not.toHaveBeenCalled();
    });
});

describe('computer.restartComputer', () => {
    it('restarts the caller\'s computer; a foreign one is refused before the driver', async () => {
        expect(await caller().restartComputer({ computerId: C1, requestId: 'restart-0001' })).toMatchObject({ ok: true, path: 'restart' });
        expect(h.restart).toHaveBeenCalledWith(expect.anything(), { userId: OWNER, computerId: C1 }, { requestId: 'restart-0001' });
        h.restart.mockClear();
        expect(await caller(false).restartComputer({ computerId: C1, requestId: 'restart-0001' })).toEqual({ ok: false, reason: 'foreign_computer' });
        expect(h.restart).not.toHaveBeenCalled();
    });
});
