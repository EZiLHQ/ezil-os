import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as cloudflare from '../cloudflare-guacamole-provider';
import { AWS_TIERS } from './aws-config';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { AWS_INSTANCE_SIZES, CLOUDFLARE_CONTAINER_SIZE, describePlacement, readSystemInfo } from './system-info';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId: OWNER, computerId };
const READS = { EZIL_COMPUTE_PLACEMENT_READS: '1' };
const UNKNOWN_IMAGE = { id: null, source: 'unknown' };
const workerFetch = vi.fn<typeof fetch>();

beforeEach(() => {
    vi.spyOn(cloudflare, 'resolveCloudflareGuacamoleConfig').mockReturnValue({
        workerUrl: 'https://worker.example', hasHmacSecret: false, isConfigured: true,
    });
    vi.spyOn(cloudflare, 'getGuacamoleSandboxStatus');
    workerFetch.mockReset().mockImplementation(async () => Response.json({ ok: true, imageId: null }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(workerFetch);
});

afterEach(() => {
    vi.restoreAllMocks();
});

function cloudflareDb() {
    return createFakePlacementDb({ placements: [placementRow({
        computer_id: computerId, owner_user_id: OWNER, provider: 'cloudflare', workspace_store: 'r2',
    })] });
}

function expectNoWorkerCall() {
    expect(cloudflare.getGuacamoleSandboxStatus).not.toHaveBeenCalled();
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

    it.each(['a', 'EZiL_os-2026.10:abcdef0123456789', 'a'.repeat(128)])('cloudflare image %s: reported via a bounded, non-waking status GET', async (imageId) => {
        workerFetch.mockImplementationOnce(async () => Response.json({ ok: true, imageId }));
        const timeout = vi.spyOn(AbortSignal, 'timeout');
        const { db, statements } = cloudflareDb();
        const info = await readSystemInfo(db, computer, READS);
        expect(info?.image).toEqual({ id: imageId, source: 'running' });
        expect(workerFetch).toHaveBeenCalledTimes(1);
        const [url, init] = workerFetch.mock.calls[0]!;
        expect(url).toBe('https://worker.example/sandbox/guac-1111111111114111-2222222222224222/status');
        expect(init?.method ?? 'GET').toBe('GET');
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(timeout).toHaveBeenCalledWith(10_000);
        expect(writes(statements)).toEqual([]);
    });

    it.each([undefined, null, '', 'a'.repeat(129), 'image/tag', 'image tag', 'image\n', 'image\r', '<image>', 'ézil', 42, {}])('cloudflare invalid or missing image %j: unknown', async (imageId) => {
        workerFetch.mockImplementationOnce(async () => Response.json({ ok: true, imageId }));
        const { db } = cloudflareDb();
        expect((await readSystemInfo(db, computer, READS))?.image).toEqual(UNKNOWN_IMAGE);
    });

    it.each([
        ['HTTP error', () => Response.json({ ok: true, imageId: 'should-not-appear' }, { status: 503 })],
        ['Worker error', () => Response.json({ ok: false, error: 'unavailable', imageId: 'should-not-appear' })],
        ['error alongside success', () => Response.json({ ok: true, error: 'unavailable', imageId: 'should-not-appear' })],
        ['invalid JSON', () => new Response('not JSON')],
        ['null body', () => Response.json(null)],
        ['network error', () => { throw new Error('fetch failed'); }],
        ['timeout', () => { throw new DOMException('Timed out', 'TimeoutError'); }],
    ] as const)('cloudflare %s: image unknown, provider and size still returned', async (_name, reply) => {
        workerFetch.mockImplementationOnce(async () => reply());
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, READS)).toMatchObject({
            provider: 'cloudflare', image: UNKNOWN_IMAGE,
            machine: { vcpu: 2, memoryMiB: 6144, source: 'configured' },
        });
    });

    it('cloudflare status helper rejection does not fail system info', async () => {
        vi.spyOn(cloudflare, 'getGuacamoleSandboxStatus').mockRejectedValueOnce(new Error('Worker unavailable'));
        const { db } = cloudflareDb();
        expect(await readSystemInfo(db, computer, READS)).toMatchObject({ provider: 'cloudflare', image: UNKNOWN_IMAGE });
    });

    it.each(['aws-ec2', 'cloudflare'] as const)("another user's %s placement: null (→ NOT_FOUND), no Worker call", async (provider) => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OTHER, provider, workspace_store: provider === 'cloudflare' ? 'r2' : 'ebs' })] });
        expect(await readSystemInfo(db, computer, READS)).toBeNull();
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
