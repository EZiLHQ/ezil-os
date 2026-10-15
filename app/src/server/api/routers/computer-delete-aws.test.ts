/**
 * computer.delete for an AWS computer once its provider CAN retire: the row is
 * soft-deleted after a confirmed retire, and the Cloudflare teardown is never
 * used for it (there is no Cloudflare sandbox). The provider is a stub here
 * because the real AWS provider does not implement retire yet.
 */

import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ softDelete: vi.fn(), terminate: vi.fn(), routeComputer: vi.fn() }));

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
vi.mock('@/server/api/routers/computer-store', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    softDeleteComputer: h.softDelete,
}));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('./compute-dispatch', () => ({ routeComputer: h.routeComputer }));

import { computerRouter } from '@/server/api/routers/computer';

const U1 = '11111111-1111-4111-8111-111111111111';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const db = { query: { computers: { findFirst: vi.fn(async () => ({ id: C1 })) } } };
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'router-secret');
    fetchMock = vi.fn(async () => Response.json({ ok: true, terminated: true }));
    vi.stubGlobal('fetch', fetchMock);
    h.terminate.mockReset().mockResolvedValue({ ok: true, terminated: true, outcome: 'retired' });
    h.routeComputer.mockReset().mockResolvedValue({ kind: 'aws-ec2', provider: { kind: 'aws-ec2', terminate: h.terminate } });
    h.softDelete.mockReset().mockImplementation(async (_db: unknown, args: { terminateSandbox: () => Promise<void> }) => {
        await args.terminateSandbox();
        return { id: C1, slot: 1, deletedAt: new Date(), sandboxTerminated: true };
    });
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('computer.delete: a confirmed AWS retire', () => {
    it('retires through the AWS provider, then soft-deletes without any Cloudflare teardown', async () => {
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).resolves.toMatchObject({ id: C1 });
        expect(h.terminate).toHaveBeenCalledTimes(1);
        expect(h.terminate.mock.calls[0]![1]).toEqual({ userId: U1, computerId: C1 });
        expect(h.softDelete).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('the retire happens BEFORE the soft delete', async () => {
        const order: string[] = [];
        h.terminate.mockImplementation(async () => { order.push('retire'); return { ok: true, terminated: true }; });
        h.softDelete.mockImplementation(async () => { order.push('soft-delete'); return { id: C1 }; });
        await computerRouter.createCaller({ user: { id: U1 }, db } as never).delete({ id: C1 });
        expect(order).toEqual(['retire', 'soft-delete']);
    });
});

describe('computer.delete: ONE delete completes while the retirement runs in the background (Codex 4275269627)', () => {
    it.each(['retiring', 'retire_after_stop'])('a durably recorded job (%s) → the row is soft-deleted now', async (outcome) => {
        h.terminate.mockResolvedValue({ ok: false, terminated: false, outcome });
        const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
        await expect(caller.delete({ id: C1 })).resolves.toMatchObject({ id: C1 });
        expect(h.softDelete).toHaveBeenCalledTimes(1);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each(['aws_lifecycle_start_failed', 'stopping', 'computer_starting', 'computer_recovering', 'cas_conflict', 'aws_lifecycle_unconfigured'])(
        'nothing durably recorded (%s) → REFUSED, never soft-deleted',
        async (outcome) => {
            h.terminate.mockResolvedValue({ ok: false, terminated: false, outcome });
            const caller = computerRouter.createCaller({ user: { id: U1 }, db } as never);
            await expect(caller.delete({ id: C1 })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
            expect(h.softDelete).not.toHaveBeenCalled();
        },
    );
});
