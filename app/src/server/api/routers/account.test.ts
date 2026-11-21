import { initTRPC } from '@trpc/server';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ getDeps: vi.fn(), billing: vi.fn(), receipts: vi.fn(), findMany: vi.fn(), balance: vi.fn() }));

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: h.getDeps }));
vi.mock('./account-ai-balance', () => ({ readSettingsAiBalance: h.balance }));
vi.mock('@/server/billing/v2/compute-access', () => ({ loadComputeBillingState: h.billing }));
vi.mock('../trpc', () => {
    const t = initTRPC.context<{ user: { id: string }; db: unknown }>().create();
    return { createTRPCRouter: t.router, protectedProcedure: t.procedure };
});

import { accountRouter } from './account';

const uid = '11111111-1111-4111-8111-111111111111';
const caller = (userId = uid) => accountRouter.createCaller({
    user: { id: userId },
    db: { query: { computers: { findMany: h.findMany } } },
    delegation: { status: 'accepted',
        call: { clientId: 'registered-client', userId, procedure: 'account.mcpSettings' } },
} as never);

beforeEach(() => {
    vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'enabled');
    vi.stubEnv('EZIL_DELEGATION_ISSUER', 'https://connect-staging.ezil.work');
    vi.stubEnv('EZIL_DELEGATION_AUDIENCE', 'https://os-staging.ezil.work');
    h.findMany.mockReset().mockResolvedValue([]);
    h.balance.mockReset().mockResolvedValue(null);
    h.billing.mockReset().mockResolvedValue({
        planSku: 'free_v3',
        summary: { version: 3, computer: { machineChoice: [{ size: 'free-cf' }] } },
        window: { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' },
        usedStdSeconds: 20, allowanceStdSeconds: 120,
    });
    h.receipts.mockReset().mockResolvedValue([
        { credits: 8, deliveredAt: null, expiresAt: '2026-12-01T00:00:00Z' },
        { credits: 100, deliveredAt: '2026-11-02T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z' },
        { credits: 100, deliveredAt: null, expiresAt: '2026-11-02T00:00:00Z' },
        { credits: 100, deliveredAt: null, expiresAt: '2026-12-01T00:00:00Z', failed: true },
    ]);
    h.getDeps.mockReset().mockReturnValue({ now: () => new Date('2026-11-21T00:00:00Z'), aiCredits: { receiptsFor: h.receipts } });
});
afterEach(() => vi.unstubAllEnvs());

describe('account.mcpSettings', () => {
    it('returns owner-only usage and known pending credits at zero computers using reads alone', async () => {
        expect(await caller().mcpSettings({})).toEqual({
            account: { id: uid },
            computers: [],
            entitlements: { planSku: 'free_v3', allowedComputerSizes: ['free-cf'] },
            usage: { compute: {
                startsAt: '2026-11-01T00:00:00Z', resetsAt: '2026-12-01T00:00:00Z',
                usedStandardSeconds: 20, allowanceStandardSeconds: 120, remainingStandardSeconds: 100,
            } },
            credits: { state: 'unavailable', balanceMicro: null, heldMicro: null, pendingDeliveryCredits: 8 },
        });
        const { where, columns, limit } = h.findMany.mock.calls[0]![0];
        expect(new PgDialect().sqlToQuery(where).params).toEqual([uid]);
        expect(columns).toEqual({ id: true, name: true, slot: true });
        expect(limit).toBe(2);
        expect(h.receipts).toHaveBeenCalledWith(uid);
        expect(h.billing).toHaveBeenCalledWith(expect.anything(), uid, expect.any(Date));
    });

    it('keeps the returned owner balance distinct from pending deliveries when the Worker proves it', async () => {
        const computer = '33333333-3333-4333-8333-333333333333';
        h.findMany.mockResolvedValue([{ id: computer, name: 'Owned desktop', slot: 1 }]);
        h.balance.mockResolvedValue({ balanceMicro: '1700', heldMicro: '200' });
        expect((await caller().mcpSettings({})).credits).toEqual({
            state: 'available', balanceMicro: '1700', heldMicro: '200', pendingDeliveryCredits: 8,
        });
        expect(h.balance).toHaveBeenCalledWith(expect.anything(), uid, [computer], undefined);
    });

    it('withholds an unconfirmed zero balance while preserving the pending delivery', async () => {
        h.findMany.mockResolvedValue([{ id: uid, name: 'Owned desktop', slot: 1 }]);
        h.balance.mockResolvedValue({ balanceMicro: '0', heldMicro: '2' });
        expect((await caller().mcpSettings({})).credits).toEqual({
            state: 'unavailable', balanceMicro: null, heldMicro: null, pendingDeliveryCredits: 8,
        });
        h.receipts.mockResolvedValue([]);
        expect((await caller().mcpSettings({})).credits).toEqual({
            state: 'available', balanceMicro: '0', heldMicro: '2', pendingDeliveryCredits: 0,
        });
    });

    it('reports failed evidence as unavailable independently of owned rows', async () => {
        const nextOwner = '22222222-2222-4222-8222-222222222222';
        h.findMany.mockResolvedValue([{ id: uid, name: 'Another desktop', slot: 2 }]);
        h.billing.mockRejectedValue(new Error('billing store unavailable'));
        h.receipts.mockRejectedValue(new Error('receipt store unavailable'));
        expect(await caller(nextOwner).mcpSettings({})).toEqual({
            account: { id: nextOwner },
            computers: [{ id: uid, name: 'Another desktop', slot: 2 }],
            entitlements: { planSku: null, allowedComputerSizes: null },
            usage: { compute: null },
            credits: { state: 'unavailable', balanceMicro: null, heldMicro: null, pendingDeliveryCredits: null },
        });
        expect(h.receipts).toHaveBeenCalledWith(nextOwner);
    });

    it('rejects computer id or billing arguments and refuses even reads when the gate is off', async () => {
        await expect(caller().mcpSettings({ computerId: uid })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        vi.stubEnv('EZIL_DELEGATED_ONBOARDING', 'disabled');
        await expect(caller().mcpSettings({})).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(h.findMany).not.toHaveBeenCalled();
        expect(h.billing).not.toHaveBeenCalled();
    });
});
