import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cloudflare from '../cloudflare-guacamole-provider';
import { AWS_TIERS } from './aws-config';
import { mintPreviewTokenV2, type WorkerAuth } from './preview-token-v2';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { AWS_INSTANCE_SIZES, CLOUDFLARE_CONTAINER_SIZE, describeFreePlan, describePlacement, describePlanPlacement, readSystemInfo } from './system-info';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('No live billing DB in tests'); } }));

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId: OWNER, computerId };
const READS = { EZIL_COMPUTE_PLACEMENT_READS: '1' };
const UNKNOWN_IMAGE = { id: null, source: 'unknown' };
const workerFetch = vi.fn<typeof fetch>();
const CONFIG = { workerUrl: 'https://worker.example', hasHmacSecret: true, isConfigured: true };
const SANDBOX = 'guac-1111111111114111-2222222222224222';
const SECRET = 'system-info-test-secret';

beforeEach(() => {
    vi.spyOn(cloudflare, 'resolveCloudflareGuacamoleConfig').mockReturnValue(CONFIG);
    vi.spyOn(cloudflare, 'getGuacamoleSandboxStatus');
    vi.spyOn(cloudflare, 'getGuacamoleSandboxSystem').mockResolvedValue({ ok: true, imageId: null });
    workerFetch.mockReset().mockImplementation(async () => Response.json({ ok: true, imageId: null }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(workerFetch);
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
});

function cloudflareDb() {
    return createFakePlacementDb({ placements: [placementRow({
        computer_id: computerId, owner_user_id: OWNER, provider: 'cloudflare', workspace_store: 'r2',
    })] });
}

function expectNoWorkerCall() {
    expect(cloudflare.getGuacamoleSandboxStatus).not.toHaveBeenCalled();
    expect(cloudflare.getGuacamoleSandboxSystem).not.toHaveBeenCalled();
    expect(cloudflare.resolveCloudflareGuacamoleConfig).not.toHaveBeenCalled();
    expect(workerFetch).not.toHaveBeenCalled();
}

/** Any statement that is not a plain read of the placement row would be a write. */
const writes = (statements: { sql: string }[]) => statements.filter((s) => !/^\s*(\/\*[^*]*\*\/\s*)?select\b/i.test(s.sql));

describe('readSystemInfo — read only, honest about what is not known', () => {
    it('🔴 placement reads off: provider UNKNOWN (routing config is not an observation), no size claimed, ZERO statements', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OWNER })] });
        const info = await readSystemInfo(db, computer, {});
        expect(info).toEqual({
            provider: 'unknown', providerSource: 'reads_off', configuredRouting: 'cloudflare',
            image: UNKNOWN_IMAGE,
            machine: { vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' },
            lifecycleState: null, usage: null,
        });
        expect(statements).toEqual([]);
        expectNoWorkerCall();
    });

    it('no placement row: "unassigned", NOT Cloudflare, and nothing is written (no pin)', async () => {
        const { db, statements } = createFakePlacementDb();
        const info = await readSystemInfo(db, computer, { ...READS, EZIL_AWS_COMPUTERS_ENABLED: '1' });
        expect(info).toMatchObject({ provider: 'unassigned', providerSource: 'no_placement', machine: { vcpu: null, memoryMiB: null, source: 'unknown' } });
        expect(info?.image).toEqual(UNKNOWN_IMAGE);
        expectNoWorkerCall();
        expect(statements.length).toBeGreaterThan(0);
        expect(writes(statements)).toEqual([]);
    });

    it('aws-ec2 placement: the RECORDED instance type sizes the machine', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({
            computer_id: computerId, owner_user_id: OWNER, instance_type: 'm6i.large', region: 'us-east-1', state: 'RUNNING',
        })] });
        const info = await readSystemInfo(db, computer, READS);
        expect(info).toEqual({
            provider: 'aws-ec2', providerSource: 'placement',
            image: UNKNOWN_IMAGE,
            machine: { vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large', region: 'us-east-1', source: 'configured' },
            lifecycleState: 'RUNNING', usage: null,
        });
        expect(writes(statements)).toEqual([]);
        expectNoWorkerCall();
    });

    it('aws-ec2 placement with no instance type yet: size unknown, never inferred from the plan', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OWNER })] });
        const info = await readSystemInfo(db, computer, READS);
        expect(info?.machine).toEqual({ vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' });
        expect(info?.image).toEqual(UNKNOWN_IMAGE);
        expectNoWorkerCall();
    });

    it('aws-ec2 placement with an unlisted instance type: name shown, size unknown', () => {
        const info = describePlacement({ provider: 'aws-ec2', store: 'ebs', record: { ...baseRecord(), instanceType: 'x9.huge' } });
        expect(info.machine).toMatchObject({ instanceType: 'x9.huge', vcpu: null, memoryMiB: null, source: 'unknown' });
        expect(info.image).toEqual(UNKNOWN_IMAGE);
        expectNoWorkerCall();
    });

    it('cloudflare placement: the configured container class', async () => {
        const { db } = cloudflareDb();
        const info = await readSystemInfo(db, computer, READS);
        expect(info).toMatchObject({ provider: 'cloudflare', providerSource: 'placement', machine: { vcpu: 2, memoryMiB: 6144, source: 'configured' } });
        expect(info?.image).toEqual(UNKNOWN_IMAGE);
    });

    it.each(['a', 'EZiL_os-2026.10:abcdef0123456789', 'a'.repeat(128)])('cloudflare image %s: uses the signed system helper', async (imageId) => {
        vi.mocked(cloudflare.getGuacamoleSandboxSystem).mockResolvedValueOnce({ ok: true, imageId });
        const { db, statements } = cloudflareDb();
        const info = await readSystemInfo(db, computer, READS);
        expect(info?.image).toEqual({ id: imageId, source: 'running' });
        expect(cloudflare.getGuacamoleSandboxSystem).toHaveBeenCalledExactlyOnceWith(CONFIG, SANDBOX);
        expect(cloudflare.getGuacamoleSandboxStatus).not.toHaveBeenCalled();
        expect(workerFetch).not.toHaveBeenCalled();
        expect(writes(statements)).toEqual([]);
    });

    it.each([undefined, null, '', 'unknown', 'a'.repeat(129), 'image/tag', 'image tag', 'image\n', 'image\r', '<image>', 'ézil', 42, {}])('cloudflare invalid or missing image %j: unknown', async (imageId) => {
        vi.mocked(cloudflare.getGuacamoleSandboxSystem).mockResolvedValueOnce({ ok: true, imageId: imageId as never });
        const { db } = cloudflareDb();
        expect((await readSystemInfo(db, computer, READS))?.image).toEqual(UNKNOWN_IMAGE);
    });

    it('cloudflare system error: image unknown, provider and size still returned', async () => {
        vi.mocked(cloudflare.getGuacamoleSandboxSystem).mockResolvedValueOnce({ ok: false, imageId: 'should-not-appear' });
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, READS)).toMatchObject({
            provider: 'cloudflare', image: UNKNOWN_IMAGE,
            machine: { vcpu: 2, memoryMiB: 6144, source: 'configured' },
        });
    });

    it('cloudflare system helper rejection does not fail system info', async () => {
        vi.mocked(cloudflare.getGuacamoleSandboxSystem).mockRejectedValueOnce(new Error('Worker unavailable'));
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, READS)).toMatchObject({ provider: 'cloudflare', image: UNKNOWN_IMAGE });
    });

    it.each(['aws-ec2', 'cloudflare'] as const)("another user's %s placement: null (→ NOT_FOUND), no Worker call", async (provider) => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OTHER, provider, workspace_store: provider === 'cloudflare' ? 'r2' : 'ebs' })] });
        expect(await readSystemInfo(db, computer, READS)).toBeNull();
        expectNoWorkerCall();
    });

    it("another user's placement under an active image job: null (→ NOT_FOUND) before any reservation lookup", async () => {
        const { db, statements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: computerId, owner_user_id: OTHER, provider: 'aws-ec2', workspace_store: 'ebs', image_upgrade_job_id: '33333333-3333-4333-8333-333333333333' })],
            imageJobs: [{ job_id: '33333333-3333-4333-8333-333333333333', computer_id: computerId, phase: 'snapshot_pending' }],
        });
        expect(await readSystemInfo(db, computer, READS)).toBeNull();
        expect(statements.some((st: { sql: string }) => st.sql.includes('placement:image-reservation'))).toBe(false);
        expectNoWorkerCall();
    });

    it('an unreadable placement (missing table, duplicate, unknown provider): "unknown", not Cloudflare', async () => {
        const missing = { execute: async () => { throw new Error('relation "public.ezil_computer_placements" does not exist'); } };
        expect(await readSystemInfo(missing, computer, READS)).toMatchObject({ provider: 'unknown', providerSource: 'unavailable', image: UNKNOWN_IMAGE });
        const dup = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId }), placementRow({ computer_id: computerId })] });
        expect(await readSystemInfo(dup.db, computer, READS)).toMatchObject({ provider: 'unknown', image: UNKNOWN_IMAGE });
        const unknown = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, provider: 'azure' })] });
        expect(await readSystemInfo(unknown.db, computer, READS)).toMatchObject({ provider: 'unknown', image: UNKNOWN_IMAGE });
        expectNoWorkerCall();
    });
});

describe('getGuacamoleSandboxSystem — signed, bounded, best-effort reads', () => {
    beforeEach(() => {
        vi.mocked(cloudflare.getGuacamoleSandboxSystem).mockRestore();
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', SECRET);
    });

    it.each(['v1', 'v2'] as const)('signs the system GET with %s and disables caching', async (kind) => {
        const now = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(now);
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const auth: WorkerAuth = kind === 'v1' ? { kind } : { kind, claims: {
            sandboxId: SANDBOX, computerId, userId: OWNER, provider: 'cloudflare',
            store: '', generation: 0, leaseEpoch: 0,
        } };
        workerFetch.mockResolvedValueOnce(Response.json({ ok: true, imageId: 'running-image' }));
        expect(await cloudflare.getGuacamoleSandboxSystem({ ...CONFIG, workerUrl: `${CONFIG.workerUrl}/` }, SANDBOX, auth))
            .toEqual({ ok: true, imageId: 'running-image' });
        expect(workerFetch).toHaveBeenCalledTimes(1);
        const [url, init] = workerFetch.mock.calls[0]!;
        expect(url).toBe(`${CONFIG.workerUrl}/sandbox/${SANDBOX}/system`);
        expect(init).toMatchObject({ method: 'GET', cache: 'no-store' });
        expect(init?.body).toBeUndefined();
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(timeout).toHaveBeenCalledWith(10_000);
        const headers = new Headers(init?.headers);
        if (auth.kind === 'v1') {
            expect(headers.get('Authorization')).toBe(`Bearer ${cloudflare.mintSandboxPreviewToken(SECRET)}`);
            expect(headers.has('x-ezil-auth')).toBe(false);
        } else {
            expect(headers.get('x-ezil-auth')).toBe(mintPreviewTokenV2(SECRET, { ...auth.claims, ts: now }, {
                method: 'GET', path: `/sandbox/${SANDBOX}/system`, body: '',
            }));
            expect(headers.has('Authorization')).toBe(false);
        }
        expect(cloudflare.getGuacamoleSandboxStatus).not.toHaveBeenCalled();
    });

    it('defaults to a signed v1 bearer and preserves missing image metadata', async () => {
        expect(await cloudflare.getGuacamoleSandboxSystem(CONFIG, SANDBOX)).toEqual({ ok: true, imageId: null });
        expect(new Headers(workerFetch.mock.calls[0]![1]?.headers).get('Authorization')).toMatch(/^Bearer t=\d+,v1=[a-f0-9]{64}$/);
    });

    it('does not fetch when config or the HMAC secret is missing', async () => {
        expect(await cloudflare.getGuacamoleSandboxSystem({ ...CONFIG, isConfigured: false }, SANDBOX))
            .toEqual({ ok: false, imageId: null });
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', ' ');
        expect(await cloudflare.getGuacamoleSandboxSystem(CONFIG, SANDBOX)).toEqual({ ok: false, imageId: null });
        expect(workerFetch).not.toHaveBeenCalled();
    });

    it.each([
        ['HTTP error', () => Response.json({ ok: true, imageId: 'should-not-appear' }, { status: 503 })],
        ['unauthorized', () => Response.json({ ok: false, error: 'unauthorized' }, { status: 401 })],
        ['Worker error', () => Response.json({ ok: false, error: 'unavailable', imageId: 'should-not-appear' })],
        ['error alongside success', () => Response.json({ ok: true, error: 'unavailable', imageId: 'should-not-appear' })],
        ['invalid JSON', () => new Response('not JSON')],
        ['null body', () => Response.json(null)],
        ['network error', () => { throw new Error('fetch failed'); }],
        ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
    ] as const)('%s yields no image and leaves system info available', async (_name, reply) => {
        workerFetch.mockImplementationOnce(async () => reply());
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, READS)).toMatchObject({
            provider: 'cloudflare', image: UNKNOWN_IMAGE,
            machine: { vcpu: 2, memoryMiB: 6144, source: 'configured' },
        });
    });
});

describe('configured sizes stay in step with their sources', () => {
    it('every AWS tier instance type has a size', () => {
        for (const type of Object.values(AWS_TIERS).flat()) expect(AWS_INSTANCE_SIZES[type], type).toBeDefined();
    });

    it('the Cloudflare container size matches worker/wrangler.toml (every instance_type line)', () => {
        const toml = readFileSync(fileURLToPath(new URL('../../../../../worker/wrangler.toml', import.meta.url)), 'utf8');
        const lines = [...toml.matchAll(/^\s*instance_type\s*=\s*\{([^}]*)\}/gm)].map((m) => m[1]!);
        expect(lines.length).toBeGreaterThan(0);
        for (const body of lines) {
            expect(Number(/vcpu\s*=\s*(\d+)/.exec(body)?.[1])).toBe(CLOUDFLARE_CONTAINER_SIZE.vcpu);
            expect(Number(/memory_mib\s*=\s*(\d+)/.exec(body)?.[1])).toBe(CLOUDFLARE_CONTAINER_SIZE.memoryMiB);
        }
    });
});

function baseRecord() {
    return {
        computerId, ownerUserId: OWNER, provider: 'aws-ec2' as const, store: 'ebs' as const, generation: 1, leaseEpoch: 0,
        state: 'STOPPED' as const, region: null, zoneId: null, instanceId: null, instanceType: null, volumeId: null, fsUuid: null,
        tunnelId: null, enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null,
        fenceToken: null, lifecycleJobId: null, lifecycleDigest: null, lastError: null, updatedAt: new Date(0),
    };
}

describe('actual placement versus paid entitlement', () => {
    const paid = { source: 'billing_v2' as const, status: 'active', provider: 'aws' as const, planId: 'standard_monthly_v3', size: 'std-2' as const };
    const cf = describePlacement({ provider: 'cloudflare', store: 'r2', record: { ...baseRecord(), provider: 'cloudflare' } });
    it('keeps CF region unknown and 6 GiB while preparing 8 GB in Mumbai', () => {
        expect(describePlanPlacement(cf, paid, null, { EZIL_AWS_COMPUTERS_ENABLED: '1' })).toMatchObject({ vcpu: 2, memoryGB: 8, region: 'ap-south-1', status: 'preparing' });
        expect(cf.machine).toMatchObject({ memoryMiB: 6144, region: null });
    });
    it.each([{}, { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '1' }])('explains operations pause with %j', env => {
        expect(describePlanPlacement(cf, paid, null, env)).toMatchObject({ status: 'blocked', reason: 'AWS paused by operations' });
    });
    it('shows a failure and preserves the fresh-provision outcome while preparing', () => {
        expect(describePlanPlacement(cf, paid, { state: 'failed_needs_operator', reason: 'head_moved', outcome: null }, ON_ENV)).toMatchObject({ status: 'failed' });
        expect(describePlanPlacement(cf, paid, { state: 'committed', reason: 'fresh_provision', outcome: 'fresh_provision' }, ON_ENV)).toMatchObject({ status: 'preparing', outcome: 'fresh_provision' });
    });
    it('requires actual Mumbai size and a ready lifecycle before saying ready', () => {
        const aws = { ...cf, provider: 'aws-ec2' as const, machine: { ...cf.machine, region: 'ap-south-1', vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large' }, lifecycleState: 'RUNNING' };
        expect(describePlanPlacement(aws, paid, null, ON_ENV)?.status).toBe('ready');
        expect(describePlanPlacement({ ...aws, lifecycleState: 'PROVISIONING' }, paid, null, ON_ENV)?.status).toBe('preparing');
        expect(describePlanPlacement({ ...aws, machine: { ...aws.machine, region: 'us-east-1' } }, paid, null, ON_ENV)?.status).toBe('preparing');
    });
    it('round 3: a size mismatch alone is ready (current vs selected), never being prepared', () => {
        const aws = { ...cf, provider: 'aws-ec2' as const, machine: { ...cf.machine, region: 'ap-south-1', vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large' }, lifecycleState: 'RUNNING' };
        const premium = { ...paid, planId: 'premium_monthly_v3', size: 'cmp-8' as const };
        expect(describePlanPlacement(aws, premium, null, ON_ENV)).toMatchObject({ status: 'ready', current: 'std-2', selected: 'cmp-8', vcpu: 8, transition: null });
        expect(describePlanPlacement({ ...aws, lifecycleState: 'STOPPED' }, premium, null, ON_ENV)?.status).toBe('ready');
    });
    it('round 3: being_prepared ONLY while a transition is in flight; a failed one shows failed with its reason', () => {
        const aws = { ...cf, provider: 'aws-ec2' as const, machine: { ...cf.machine, region: 'ap-south-1', vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large' }, lifecycleState: 'STOPPED' };
        const premium = { ...paid, planId: 'premium_monthly_v3', size: 'cmp-8' as const };
        const view = { transitionId: 't', kind: 'switch' as const, current: 'std-2' as const, target: 'cmp-8' as const, reason: null, requestedAt: '2026-10-28T00:00:00.000Z', endedAt: null, revertAvailable: false };
        for (const phase of ['requested', 'stopping', 'waking'] as const)
            expect(describePlanPlacement(aws, premium, null, ON_ENV, { ...view, phase })?.status).toBe('being_prepared');
        expect(describePlanPlacement(aws, premium, null, ON_ENV, { ...view, phase: 'failed', reason: 'capacity_unavailable', revertAvailable: true }))
            .toMatchObject({ status: 'failed', reason: 'capacity_unavailable', transition: { revertAvailable: true } });
        expect(describePlanPlacement(aws, premium, null, ON_ENV, { ...view, phase: 'done' })?.status).toBe('ready');
        expect(describePlanPlacement(aws, premium, null, { ...ON_ENV, EZIL_AWS_KILL_SWITCH: '1' }, { ...view, phase: 'waking' })?.status).toBe('blocked');
    });
    it('uses the Premium entitled size', () => {
        expect(describePlanPlacement(cf, { ...paid, planId: 'premium_monthly_v3', size: 'cmp-8' }, null, ON_ENV)).toMatchObject({ vcpu: 8, memoryGB: 32 });
    });
});
const ON_ENV = { EZIL_AWS_COMPUTERS_ENABLED: '1' };

it('wires computer-scoped migration status into the production System data path', async () => {
    const billing = await import('@/server/billing/v2/compute-access');
    const migrations = await import('./provider-migrate-orchestrator');
    vi.spyOn(billing, 'billingV2EntitlementReader').mockReturnValue({ read: async () => ({ source: 'billing_v2', status: 'active', provider: 'aws', planId: 'standard_monthly_v3', size: 'std-2' }) });
    const status = vi.spyOn(migrations, 'migrationStatusFor').mockResolvedValue({ state: 'committed', reason: 'fresh_provision', outcome: 'fresh_provision' });
    const { db } = cloudflareDb();
    const info = await readSystemInfo(db, computer, { ...READS, ...ON_ENV });
    expect(status).toHaveBeenCalledWith(OWNER, computerId, db);
    expect(info).toMatchObject({ provider: 'cloudflare', machine: { memoryMiB: 6144, region: null }, plan: { memoryGB: 8, status: 'preparing', outcome: 'fresh_provision' } });
});

describe('round 4: a Free plan is reported, never "not available"', () => {
    const free = { source: 'billing_v2' as const, status: 'active', provider: 'cloudflare' as const, planId: 'free_v3', size: 'free-cf' as const, paymentIssue: false };
    const cf = describePlacement({ provider: 'cloudflare', store: 'r2', record: { ...baseRecord(), provider: 'cloudflare' } });
    const aws = describePlacement({ provider: 'aws-ec2', store: 'ebs', record: { ...baseRecord(), instanceType: 'm6i.large', region: 'ap-south-1' } });
    it('Free on Cloudflare (or not yet placed) is Free 2 vCPU / 6 GB on Cloudflare', () => {
        const expected = { name: 'Free', provider: 'cloudflare', standing: 'free', vcpu: 2, memoryGB: 6, region: null, status: 'ready', current: 'free-cf' };
        expect(describeFreePlan(cf, free)).toMatchObject(expected);
        expect(describeFreePlan(describePlacement({ provider: 'cloudflare', store: 'r2', record: null }), free)).toMatchObject(expected);
        const unread = describeFreePlan({ ...cf, provider: 'unknown', providerSource: 'reads_off' }, free);
        expect(unread).toMatchObject({ name: 'Free', provider: 'cloudflare', vcpu: 2, memoryGB: 6 });
        expect(unread).not.toHaveProperty('standing');
    });
    it('Free with the AWS computer still placed reports that configuration as files_on_aws', () => {
        expect(describeFreePlan(aws, free)).toEqual({ name: 'Free', provider: 'aws', standing: 'files_on_aws', vcpu: 2, memoryGB: 8, region: 'ap-south-1',
            status: 'ready', reason: null, outcome: null, current: 'std-2', selected: null, transition: null });
        const big = describePlacement({ provider: 'aws-ec2', store: 'ebs', record: { ...baseRecord(), instanceType: 'm6i.2xlarge', region: 'ap-south-1' } });
        expect(describeFreePlan(big, free)).toMatchObject({ vcpu: 8, memoryGB: 32, current: 'cmp-8', standing: 'files_on_aws' });
        expect(describeFreePlan(describePlacement({ provider: 'aws-ec2', store: 'ebs', record: baseRecord() }), free)).toMatchObject({ vcpu: 2, memoryGB: 8, current: null, region: null });
    });
    it('only for a billing Free plan: paid AWS and unknown entitlements are not Free', () => {
        expect(describeFreePlan(aws, { ...free, provider: 'aws', planId: 'standard_monthly_v3', size: 'std-2' })).toBeUndefined();
        expect(describeFreePlan(aws, null)).toBeUndefined();
        expect(describeFreePlan(aws, { status: 'active', planId: 'free_v3' })).toBeUndefined();
    });
    it('paid plans now carry their name and provider', () => {
        const paid = { source: 'billing_v2' as const, status: 'active', provider: 'aws' as const, planId: 'premium_monthly_v3', size: 'cmp-4' as const };
        expect(describePlanPlacement(aws, paid, null, ON_ENV)).toMatchObject({ name: 'Premium', provider: 'aws', region: 'ap-south-1' });
    });
    it('the System data path sets the Free plan instead of nothing', async () => {
        const billing = await import('@/server/billing/v2/compute-access');
        vi.spyOn(billing, 'billingV2EntitlementReader').mockReturnValue({ read: async () => free });
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, { ...READS, ...ON_ENV })).toMatchObject({ provider: 'cloudflare', plan: { name: 'Free', provider: 'cloudflare', standing: 'free' } });
    });
});
