import { initTRPC, TRPCError } from '@trpc/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../trpc', () => {
    const t = initTRPC.context<{ user: { id: string } | null }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure.use(({ ctx, next }) => {
        if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
        return next({ ctx: { user: ctx.user } });
    }) };
});

import { createComputeRouter } from './compute';

describe('compute router server-side eligibility', () => {
    it('refuses a free user requesting performance and explains the catalog restriction', async () => {
        const getPlan = vi.fn(async () => ({ plan: 'free' as const, periodEnd: null }));
        const caller = createComputeRouter({ getPlan }).createCaller({ user: { id: 'authenticated-user' } } as never);
        await expect(caller.requestShape({ shape: 'performance' })).rejects.toMatchObject({ code: 'FORBIDDEN', message: 'subscription_required' });
        expect(await caller.shapes()).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'performance', eligible: false, reason: 'subscription_required' }),
            expect.objectContaining({ id: 'standard', eligible: true, reason: null }),
        ]));
        expect(getPlan).toHaveBeenCalledWith('authenticated-user');
        await expect(caller.requestShape({ shape: 'standard' })).resolves.toMatchObject({ id: 'standard' });
    });

    it('rechecks an active subscriber on every request, including after cancellation', async () => {
        const getPlan = vi.fn(async () => ({ plan: 'subscriber' as 'free' | 'subscriber', periodEnd: '2099-01-01' as string | null }));
        const caller = createComputeRouter({ getPlan }).createCaller({ user: { id: 'user' } } as never);
        await expect(caller.requestShape({ shape: 'performance' })).resolves.toMatchObject({ id: 'performance', memoryGiB: 12 });
        getPlan.mockResolvedValueOnce({ plan: 'free', periodEnd: null });
        await expect(caller.requestShape({ shape: 'performance' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        expect(getPlan).toHaveBeenCalledTimes(2);
    });

    it('rejects unknown shapes, forged plans and unauthenticated callers', async () => {
        const router = createComputeRouter();
        const caller = router.createCaller({ user: { id: 'user' } } as never);
        await expect(caller.requestShape({ shape: 'standard', plan: 'subscriber' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        await expect(caller.requestShape({ shape: 'supercomputer' } as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        const anonymous = router.createCaller({ user: null } as never);
        await expect(anonymous.shapes()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(anonymous.requestShape({ shape: 'standard' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it('denies performance by default and when entitlement resolution fails', async () => {
        for (const router of [createComputeRouter(), createComputeRouter({ getPlan: async () => { throw new Error('offline'); } })]) {
            const caller = router.createCaller({ user: { id: 'user' } } as never);
            await expect(caller.requestShape({ shape: 'performance' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
        }
    });
});
