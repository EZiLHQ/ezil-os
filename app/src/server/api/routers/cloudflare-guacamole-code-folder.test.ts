/**
 * Per-tab Code folder continuity through the REAL `codePreviewUrl` procedure (compute/code-folder.ts).
 *
 * - The own-files hint `{v:1, path}` is never a 400 of the mint: a hint that fails the lexical check is not
 *   forwarded and the answer says `invalid`.
 * - Cloudflare: a valid hint rides the ensure body (`compute/cloudflare.ts`, explicit fields), and the Worker's
 *   `{v:1, outcome}` passes back; never a path.
 * - AWS: a valid hint rides the v2-signed `surface: 'code'` preview body; the answer allowlist passes the outcome
 *   code only and fails closed on anything else.
 * - Another person's computer is NOT_FOUND before anything about the hint is read or sent.
 * Harness: the same mocks as compute-dispatch.test.ts.
 */
import { initTRPC, TRPCError } from '@trpc/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ billingDeps: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: captured.billingDeps }));
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
vi.mock('@/server/api/routers/computer-store', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, stampOpened: vi.fn(async () => {}) };
});
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: { CRON_SECRET: 'cron', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'env-secret' } }));

import { cloudflareGuacamoleRouter } from '@/server/api/routers/cloudflare-guacamole';
import { readBillingConfig } from '@/server/billing/config';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';
import { appCallerRoleEnv } from '@/server/lib/compute/aws-clients';
import { LIFECYCLE_DEPLOYMENTS_ENV } from '@/server/lib/compute/aws-intent';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import { cloudflareComputeProvider } from '@/server/lib/compute/cloudflare';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];
const AWS_ENV: Record<string, string> = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    EZIL_AWS_BROWSER_ZONE: 'preview.example',
    AWS_MAX_RUNNING: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1,us-east-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({
        'ap-south-1': fixtureDeployment('ap-south-1', TYPES),
        'us-east-1': fixtureDeployment('us-east-1', TYPES),
    }),
};
const ASK = { v: 1, path: '/workspace/sports/sports-web' };

function routerDb(placements: Record<string, unknown>[], computerOwner = U1) {
    const fake = createFakePlacementDb({ placements, computers: [{ id: C1, user_id: computerOwner }] });
    const owned = computerOwner === U1;
    return { fake, db: { ...fake.db, query: { computers: { findFirst: async () => (owned ? { id: C1 } : undefined) } } } };
}
const caller = (db: unknown, user = U1) => cloudflareGuacamoleRouter.createCaller({ user: { id: user }, db } as never);

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    captured.billingDeps.mockReset().mockReturnValue({ config: readBillingConfig({}), store: {}, stripe: null, usage: null, now: () => new Date() });
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example');
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'router-secret');
    fetchMock = vi.fn(async () => Response.json({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    // The credential sync's own non-fatal line (no AI credential store in this harness).
    vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('codePreviewUrl, Cloudflare: the own-files folder hint', () => {
    const sandboxId = deriveGuacamoleSandboxId(U1, C1);
    const minted = `https://8443-${sandboxId}-code.preview.example/preview-bootstrap?token=t&folder=%2Fworkspace`;
    const ready = (extra: Record<string, unknown> = {}) => ({
        ok: true as const, guacamoleUrl: `https://6080-${sandboxId}-guac.preview.example/`, expiresAt: Date.now() + 60_000,
        provider: 'cloudflare-neko' as const, codePreviewUrl: minted, ...extra,
    });

    it('a valid hint rides the ensure options; the Worker\'s outcome code passes back, never a path', async () => {
        const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure').mockResolvedValue(ready({ codeFolder: { v: 1, outcome: 'missing' } }) as never);
        const { db } = routerDb([]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: ASK });
        expect(ensure.mock.calls[0]![2]).toEqual({ sessionId: C1, desktopMode: 'neko', codeFolder: { v: 1, path: ASK.path } });
        expect(out).toMatchObject({ ok: true, codePreviewUrl: minted, codeFolder: { v: 1, outcome: 'missing' } });
        expect(JSON.stringify((out as { codeFolder?: unknown }).codeFolder)).not.toContain('sports');
    });

    it('no hint: today\'s ensure options exactly, and no codeFolder in the answer', async () => {
        const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure').mockResolvedValue(ready() as never);
        const { db } = routerDb([]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open' });
        expect(ensure.mock.calls[0]![2]).toStrictEqual({ sessionId: C1, desktopMode: 'neko' });
        expect(out).not.toHaveProperty('codeFolder');
    });

    it('a malformed hint is never a 400 and never forwarded: the mint proceeds and says `invalid`', async () => {
        for (const bad of [{ v: 1, path: '/workspace/../etc' }, { v: 2, path: '/workspace' }, { v: 1, path: '/w', extra: 1 }, '/workspace', 7, null]) {
            const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure').mockResolvedValue(ready() as never);
            const { db } = routerDb([]);
            const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: bad });
            expect(ensure.mock.calls.at(-1)![2]).toStrictEqual({ sessionId: C1, desktopMode: 'neko' });
            expect(out).toMatchObject({ ok: true, codeFolder: { v: 1, outcome: 'invalid' } });
            ensure.mockRestore();
        }
    });

    it('a Worker answer that is not a plain code is dropped (an older Worker says nothing; the shell reports that)', async () => {
        for (const odd of [{ v: 1, outcome: '/etc/passwd' }, { v: 1, outcome: 'X' }, 'restored', null]) {
            const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure').mockResolvedValue(ready({ codeFolder: odd }) as never);
            const { db } = routerDb([]);
            const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: ASK });
            expect(out).toMatchObject({ ok: true });
            expect(out).not.toHaveProperty('codeFolder');
            ensure.mockRestore();
        }
    });

    it('the provider puts the hint in the Worker body (explicit fields), last and only when set', async () => {
        fetchMock.mockResolvedValue(Response.json(ready()));
        const { db } = routerDb([]);
        await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: { path: '/workspace/a b/日本', v: 1 } });
        const body = JSON.parse(String(fetchMock.mock.calls.find(([u]) => String(u).endsWith('/sandbox/preview'))![1].body));
        expect(body.codeFolder).toEqual({ v: 1, path: '/workspace/a b/日本' });
        expect(Object.keys(body).at(-1) === 'codeFolder' || Object.keys(body).at(-1) === 'token').toBe(true);
    });

    it('another person\'s computer is NOT_FOUND before anything is ensured or sent', async () => {
        const ensure = vi.spyOn(cloudflareComputeProvider, 'ensure');
        const { db } = routerDb([], U2);
        await expect(caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: ASK })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(ensure).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('codePreviewUrl, AWS: the hint rides the signed Code preview body; the answer is a code', () => {
    const sandboxId = deriveGuacamoleSandboxId(U1, C1);
    const awsRow = (over: Record<string, unknown> = {}) => placementRow({ computer_id: C1, owner_user_id: U1, state: 'RUNNING',
        region: 'ap-south-1', instance_type: 't3a.medium', instance_id: 'i-0123456789abcdef0', volume_id: 'vol-0123456789abcdef0',
        generation: 7, lease_epoch: 11, lease_until: new Date(Date.now() + 3_600_000), ...over });
    const url = (port: number) => `https://aws-${port}-${sandboxId}-aws.preview.example/preview-bootstrap?token=opaque&path=%2F`;
    const ready = (extra: Record<string, unknown> = {}) => ({
        ok: true, provider: 'aws-ec2', mode: 'neko', sandboxId, generation: 7, leaseEpoch: 11,
        guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443), expiresAt: Date.now() + 3_600_000, ...extra,
    });
    beforeEach(() => {
        for (const [k, v] of Object.entries(AWS_ENV)) vi.stubEnv(k, v);
        for (const region of ['ap-south-1', 'us-east-1']) vi.stubEnv(appCallerRoleEnv(region), 'arn:aws:iam::123456789012:role/ezil/pilot/app-caller');
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
    });
    const previewBodies = () => fetchMock.mock.calls
        .filter(([u]) => String(u) === 'https://worker.example/sandbox/preview').map(([, init]) => JSON.parse(String(init.body)));

    it('a valid hint is in the surface:code body; the allow-listed outcome passes back', async () => {
        fetchMock.mockResolvedValue(Response.json(ready({ codeFolder: { v: 1, outcome: 'restored' } })));
        const { db } = routerDb([awsRow()]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: ASK });
        expect(out).toMatchObject({ ok: true, computeProvider: 'aws-ec2', codeFolder: { v: 1, outcome: 'restored' } });
        const bodies = previewBodies();
        expect(bodies.length).toBeGreaterThan(0);
        for (const b of bodies) expect(b).toMatchObject({ surface: 'code', codeFolder: { v: 1, path: ASK.path } });
    });

    it('no hint: no codeFolder in the body or the answer', async () => {
        fetchMock.mockResolvedValue(Response.json(ready()));
        const { db } = routerDb([awsRow()]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open' });
        expect(out).toMatchObject({ ok: true });
        expect(out).not.toHaveProperty('codeFolder');
        for (const b of previewBodies()) expect(b).not.toHaveProperty('codeFolder');
    });

    it('a malformed hint is not sent and the open says `invalid`', async () => {
        fetchMock.mockResolvedValue(Response.json(ready()));
        const { db } = routerDb([awsRow()]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: { v: 1, path: 'relative' } });
        expect(out).toMatchObject({ ok: true, codeFolder: { v: 1, outcome: 'invalid' } });
        for (const b of previewBodies()) expect(b).not.toHaveProperty('codeFolder');
    });

    it('a Worker answer whose codeFolder carries anything but a code fails the preview closed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'info').mockImplementation(() => {});
        fetchMock.mockResolvedValue(Response.json(ready({ codeFolder: { v: 1, outcome: 'restored', path: '/workspace/x' } })));
        const { db } = routerDb([awsRow()]);
        const out = await caller(db).codePreviewUrl({ computerId: C1, intent: 'open', codeFolder: ASK });
        expect(out).toMatchObject({ ok: false });
        expect(JSON.stringify(out)).not.toContain('/workspace/x');
    });
});
