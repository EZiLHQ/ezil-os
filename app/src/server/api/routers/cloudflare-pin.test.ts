/**
 * Codex PR #200 (4277908733): a computer that already ran on Cloudflare keeps its workspace
 * in R2, so it must never be reassigned to AWS by the canary (an empty EBS volume would make
 * the workspace look lost). With placement reads on, every procedure that STARTS a sandbox
 * records a `cloudflare` placement row BEFORE the sandbox starts; the canary only ever
 * claims a computer with NO row. Reads and stops never pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTRPC, TRPCError } from '@trpc/server';

const spies = vi.hoisted(() => ({ preview: vi.fn(), restart: vi.fn(), status: vi.fn() }));
// Billing effects are exercised in compute-dispatch.test.ts.
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => ({ now: () => new Date() }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({
    billingV2EntitlementReader: () => ({ read: async () => null }),
    gateComputerStart: async () => ({ allowed: true }),
}));
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
        requestGuacamolePreview: spies.preview,
        requestGuacamoleDesktopRestart: spies.restart,
        resolveCloudflareGuacamoleConfig: () => ({ isConfigured: true, workerUrl: 'https://worker.example', hasHmacSecret: true }),
    };
});

import { createFakePlacementDb, placementRow, type Row } from '@/server/lib/compute/fake-placement-db.test-support';
import { cloudflareGuacamoleRouter } from './cloudflare-guacamole';

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const sessionId = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-10-15T12:00:00Z');

function harness(seed: { placements?: Row[] } = {}) {
    const fake = createFakePlacementDb({ placements: seed.placements, computers: [{ id: computerId, user_id: userId, created_at: NOW }] });
    const db = Object.assign(fake.db, { query: { computers: { findFirst: async () => ({ id: computerId }) } } });
    // What the database held at the moment the Cloudflare sandbox start was requested.
    const atStart: { rows: number; provider: unknown }[] = [];
    spies.preview.mockReset().mockImplementation(async () => {
        const read = fake.statements.filter((s) => s.sql.includes('placement:insert'));
        atStart.push({ rows: read.length, provider: read[0]?.params[2] });
        return { ok: true, previewUrl: 'https://8080-sandbox-token.preview.example/', sandboxId: 'guac-x-y' };
    });
    spies.restart.mockReset().mockImplementation(async () => {
        const read = fake.statements.filter((s) => s.sql.includes('placement:insert'));
        atStart.push({ rows: read.length, provider: read[0]?.params[2] });
        return { ok: true, outcome: 'restarted' };
    });
    const call = cloudflareGuacamoleRouter.createCaller({ user: { id: userId }, db } as never);
    return { fake, call, atStart, inserts: () => fake.statements.filter((s) => s.sql.includes('placement:insert')) };
}

beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'test-secret');
    // Nothing here may reach a network: any unmocked provider call fails fast.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in test'); }));
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

const STARTS: [string, (c: ReturnType<typeof harness>['call']) => Promise<unknown>][] = [
    ['previewUrl (open)', (c) => c.previewUrl({ sessionId, computerId })],
    ['appPreviewUrl', (c) => c.appPreviewUrl({ computerId })],
    ['codePreviewUrl', (c) => c.codePreviewUrl({ computerId })],
    ['restartDesktop', (c) => c.restartDesktop({ computerId })],
];

describe('reads on: a no-row computer is pinned to Cloudflare before its sandbox starts', () => {
    it.each(STARTS)('%s writes exactly one cloudflare row owned by the session user, before the start', async (_name, start) => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const h = harness();
        await start(h.call).catch(() => undefined);
        expect(h.atStart.length).toBeGreaterThan(0);
        expect(h.atStart[0]).toEqual({ rows: 1, provider: 'cloudflare' });
        const inserts = h.inserts();
        expect(inserts).toHaveLength(1);
        expect(inserts[0]!.params.slice(0, 3)).toEqual([computerId, userId, 'cloudflare']);
    });

    it('a pinned computer stays Cloudflare when its user later joins the AWS canary', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const h = harness();
        await h.call.previewUrl({ sessionId, computerId }).catch(() => undefined);
        expect(h.inserts()).toHaveLength(1);
        vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '1');
        vi.stubEnv('EZIL_AWS_CANARY_USER_IDS', userId);
        vi.stubEnv('EZIL_AWS_CANARY_SINCE', '2026-10-01T00:00:00Z');
        const before = h.atStart.length;
        await h.call.previewUrl({ sessionId, computerId }).catch(() => undefined);
        // Served by Cloudflare again (the sandbox start was requested), no second row, no canary read.
        expect(h.atStart.length).toBe(before + 1);
        expect(h.inserts()).toHaveLength(1);
        expect(h.fake.statements.some((s) => s.sql.includes('placement:canary-computer'))).toBe(false);
    });

    it('a no-row computer the canary claims is NOT pinned to Cloudflare (the canary is checked first)', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '1');
        // A full admission config: the canary routes to AWS only when admission would admit.
        for (const [k, v] of Object.entries({ AWS_MAX_RUNNING: '2', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
            EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200', AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2' })) vi.stubEnv(k, v);
        vi.stubEnv('EZIL_AWS_CANARY_USER_IDS', userId);
        vi.stubEnv('EZIL_AWS_CANARY_SINCE', '2026-10-01T00:00:00Z');
        const h = harness();
        await h.call.previewUrl({ sessionId, computerId }).catch(() => undefined);
        expect(h.fake.statements.some((s) => s.sql.includes('placement:canary-computer'))).toBe(true);
        expect(h.inserts().filter((s) => s.params[2] === 'cloudflare')).toEqual([]);
        expect(h.atStart).toEqual([]); // the Cloudflare sandbox was never started
    });

    it('two concurrent first opens create one row', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const h = harness();
        await Promise.all([
            h.call.previewUrl({ sessionId, computerId }).catch(() => undefined),
            h.call.appPreviewUrl({ computerId }).catch(() => undefined),
        ]);
        const rows = h.fake.statements.filter((s) => s.sql.includes('placement:insert'));
        expect(rows).toHaveLength(1);
        expect(h.atStart).toHaveLength(2);
    });

    it('an existing row is never re-pinned', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const h = harness({ placements: [placementRow({ computer_id: computerId, provider: 'cloudflare', workspace_store: 'r2' })] });
        await h.call.previewUrl({ sessionId, computerId }).catch(() => undefined);
        expect(h.inserts()).toHaveLength(0);
        expect(h.atStart).toHaveLength(1);
    });

    it('status never pins (a computer that never ran stays eligible for the canary)', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const h = harness();
        await h.call.status({ computerId }).catch(() => undefined);
        expect(h.inserts()).toHaveLength(0);
    });
});

describe('reads off: unchanged, no database statement at all', () => {
    it.each(STARTS)('%s issues no placement statement', async (_name, start) => {
        const h = harness();
        await start(h.call).catch(() => undefined);
        expect(h.atStart.length).toBeGreaterThan(0);
        expect(h.fake.statements).toEqual([]);
    });
});
