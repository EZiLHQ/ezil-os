import { initTRPC } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ owned: true, signedIn: true }));
const reset = vi.hoisted(() => vi.fn());
const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date(), config: {} }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ gateComputerStart: async () => ({ allowed: true }) }));
vi.mock('@/server/billing/v2/compute-meter-observation', () => ({ recordComputeMeter: async () => 'ok' }));
vi.mock('@/server/api/trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure,
        createTRPCContext: async () => ({ user: state.signedIn ? { id: userId } : null,
            db: { query: { computers: { findFirst: async () => state.owned ? { id: computerId } : undefined } } } }) };
});
vi.mock('@/server/api/root', async () => {
    const { cloudflareGuacamoleRouter } = await import('@/server/api/routers/cloudflare-guacamole');
    return { appRouter: { createCaller: (ctx: Parameters<typeof cloudflareGuacamoleRouter.createCaller>[0]) => ({
        cloudflareGuacamole: cloudflareGuacamoleRouter.createCaller(ctx),
    }) } };
});
// The lock-ordered DB reset itself is proven against real Postgres (ready-pool.pg.test.ts).
vi.mock('@/server/lib/compute/aws-pool-demand', async original => ({
    ...await original<Record<string, unknown>>(), resetCapacityAttempt: reset,
}));

import { maxDuration, POST } from './route';
const request = (body: unknown = { computerId, attemptId }) => new Request('https://app.example/api/shell/capacity-retry', {
    method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

beforeEach(() => {
    state.owned = true; state.signedIn = true;
    reset.mockReset(); reset.mockResolvedValue('reset');
});

describe('POST /api/shell/capacity-retry (real route and router)', () => {
    it('401s before reading the body, and never resets', async () => {
        state.signedIn = false;
        const req = request();
        const json = vi.spyOn(req, 'json');
        const res = await POST(req);
        expect(res.status).toBe(401);
        expect(json).not.toHaveBeenCalled();
        expect(reset).not.toHaveBeenCalled();
    });

    it("a computer the caller does not own is not found, with no reset", async () => {
        state.owned = false;
        const res = await POST(request());
        expect(res.status).toBe(404);
        expect(reset).not.toHaveBeenCalled();
    });

    it.each([['not json', '{'], ['no attempt id', { computerId }], ['a non-uuid attempt id', { computerId, attemptId: 'x' }]])(
        'rejects %s before any reset', async (_label, body) => {
            const res = await POST(request(body));
            expect(res.status).toBe(400);
            expect(reset).not.toHaveBeenCalled();
        });

    it.each([['reset', true], ['already_reset', true], ['superseded', true], ['not_found', false]] as const)(
        'resets only the stated attempt for the signed-in owner, once, and returns %s', async (outcome, ok) => {
            reset.mockResolvedValue(outcome);
            const res = await POST(request({ computerId, attemptId, userId: 'someone-else', ownerUserId: 'someone-else' }));
            expect(res.status).toBe(200);
            expect(res.headers.get('cache-control')).toContain('no-store');
            expect(await res.json()).toEqual({ ok, outcome, provider: 'cloudflare-guacamole' });
            expect(reset).toHaveBeenCalledTimes(1);
            // The owner comes from the session, never the body.
            expect(reset.mock.calls[0]![1]).toEqual({ computerId, ownerUserId: userId, attemptId });
        });

    it('is a short request', () => { expect(maxDuration).toBeLessThanOrEqual(60); });
});
