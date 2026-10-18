/**
 * Codex PR #200: an AWS computer's screen, focus and relay controls are signed v2 with
 * `provider: "aws-ec2"` and the placement's epoch, so the Worker can REFUSE them when the
 * tunnel is absent or fenced instead of waking a Cloudflare sandbox. Cloudflare computers
 * keep the exact legacy call (v1, the session user's sandbox name, no placement read).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { initTRPC, TRPCError } from '@trpc/server';

const spies = vi.hoisted(() => ({ relay: vi.fn(), focus: vi.fn(), read: vi.fn(), set: vi.fn() }));
vi.mock('../trpc', () => {
    const t = initTRPC.context<{ user: { id: string } | null; db: unknown }>().create();
    return {
        createTRPCRouter: t.router,
        protectedProcedure: t.procedure.use(({ ctx, next }) => {
            if (!ctx.user) throw new TRPCError({ code: 'UNAUTHORIZED' });
            return next({ ctx: { ...ctx, user: ctx.user } });
        }),
    };
});
vi.mock('@/server/lib/cloudflare-guacamole-provider', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        requestRelayRefresh: spies.relay,
        requestGuacamoleFocusApp: spies.focus,
        readGuacamoleScreen: spies.read,
        requestGuacamoleScreen: spies.set,
        resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
    };
});

import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const userId = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const computerId = '22222222-2222-4222-8222-222222222222';
const runtimeId = 'a'.repeat(32);

function caller(placements: Record<string, unknown>[] = []) {
    const fake = createFakePlacementDb({ placements });
    const db = Object.assign(fake.db, { query: { computers: { findFirst: async () => ({ id: computerId }) } } });
    for (const s of [spies.relay, spies.focus, spies.read, spies.set]) s.mockReset();
    spies.relay.mockResolvedValue({ ok: true, runtimeId, expiresAt: Date.now() + 300_000 });
    spies.focus.mockResolvedValue({ ok: true });
    spies.read.mockResolvedValue({ ok: true, width: 1920, height: 1080 });
    spies.set.mockResolvedValue({ ok: true, width: 1920, height: 1080, verified: true });
    return { api: cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, db } as never), statements: fake.statements };
}

/** Every control procedure; returns [sandboxName, auth] as each helper received them. */
async function forwarded(api: ReturnType<typeof caller>['api']) {
    await api.relayState({ computerId });
    await api.refreshRelay({ computerId, runtimeId });
    await api.focusApp({ computerId, app: 'chromium' });
    await api.getScreen({ computerId });
    await api.setScreen({ computerId, width: 1920, height: 1080 });
    return [
        [spies.relay.mock.calls[0]![2], spies.relay.mock.calls[0]![5]],
        [spies.relay.mock.calls[1]![2], spies.relay.mock.calls[1]![5]],
        [spies.focus.mock.calls[0]![2], spies.focus.mock.calls[0]![5]],
        [spies.read.mock.calls[0]![2], spies.read.mock.calls[0]![4]],
        [spies.set.mock.calls[0]![2], spies.set.mock.calls[0]![6]],
    ];
}

afterEach(() => vi.unstubAllEnvs());

describe('control calls: AWS computers are signed as AWS', () => {
    it('an aws-ec2 placement: every control carries v2 aws-ec2 claims for its epoch, on the owner-derived sandbox', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-only-secret');
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const { api } = caller([placementRow({ computer_id: computerId, owner_user_id: userId, generation: 4, lease_epoch: 7, state: 'RUNNING' })]);
        const sid = deriveGuacamoleSandboxId(userId, computerId);
        for (const [sandboxName, auth] of await forwarded(api)) {
            expect(sandboxName).toBe(sid);
            expect(auth).toEqual({
                kind: 'v2',
                claims: { sandboxId: sid, computerId, userId, provider: 'aws-ec2', store: '', generation: 4, leaseEpoch: 7 },
            });
        }
    });

    it('placement reads off: the exact legacy call (v1) and no placement read', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-only-secret');
        const { api, statements } = caller([placementRow({ computer_id: computerId, owner_user_id: userId })]);
        for (const [sandboxName, auth] of await forwarded(api)) {
            expect(sandboxName).toBe(deriveGuacamoleSandboxId(userId, computerId));
            expect(auth).toEqual({ kind: 'v1' });
        }
        expect(statements).toEqual([]);
    });

    it('a Cloudflare computer (no row, or a cloudflare row) keeps v1 with reads on', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-only-secret');
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        for (const rows of [[], [placementRow({ computer_id: computerId, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' })]]) {
            const { api } = caller(rows);
            for (const [, auth] of await forwarded(api)) expect(auth).toEqual({ kind: 'v1' });
        }
    });

    it('a CLOUDFLARE placement owned by someone else also looks absent: the owner check precedes the provider branch', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-only-secret');
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        // ezil_computers is user-writable: a re-keyed row passes assertOwnedComputer, but the
        // placement's owner_user_id is authoritative (C-2), same NOT_FOUND as routeComputer.
        const { api } = caller([placementRow({ computer_id: computerId, owner_user_id: other, provider: 'cloudflare', workspace_store: 'r2' })]);
        await expect(api.focusApp({ computerId, app: 'chromium' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(api.getScreen({ computerId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(api.relayState({ computerId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(spies.focus).not.toHaveBeenCalled();
        expect(spies.read).not.toHaveBeenCalled();
        expect(spies.relay).not.toHaveBeenCalled();
    });

    it('an AWS placement owned by someone else looks absent (NOT_FOUND) and nothing is forwarded', async () => {
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-only-secret');
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const { api } = caller([placementRow({ computer_id: computerId, owner_user_id: other })]);
        await expect(api.focusApp({ computerId, app: 'chromium' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        await expect(api.relayState({ computerId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(spies.focus).not.toHaveBeenCalled();
        expect(spies.relay).not.toHaveBeenCalled();
    });
});
