import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { AWS_TIERS } from './aws-config';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { AWS_INSTANCE_SIZES, CLOUDFLARE_CONTAINER_SIZE, describePlacement, readSystemInfo } from './system-info';

const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId: OWNER, computerId };
const READS = { EZIL_COMPUTE_PLACEMENT_READS: '1' };

/** Any statement that is not a plain read of the placement row would be a write. */
const writes = (statements: { sql: string }[]) => statements.filter((s) => !/^\s*(\/\*[^*]*\*\/\s*)?select\b/i.test(s.sql));

describe('readSystemInfo — read only, honest about what is not known', () => {
    it('🔴 placement reads off: provider UNKNOWN (routing config is not an observation), no size claimed, ZERO statements', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OWNER })] });
        const info = await readSystemInfo(db, computer, {});
        expect(info).toEqual({
            provider: 'unknown', providerSource: 'reads_off', configuredRouting: 'cloudflare',
            machine: { vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' },
            lifecycleState: null, usage: null,
        });
        expect(statements).toEqual([]);
    });

    it('no placement row: "unassigned", NOT Cloudflare, and nothing is written (no pin)', async () => {
        const { db, statements } = createFakePlacementDb();
        const info = await readSystemInfo(db, computer, { ...READS, EZIL_AWS_COMPUTERS_ENABLED: '1' });
        expect(info).toMatchObject({ provider: 'unassigned', providerSource: 'no_placement', machine: { vcpu: null, memoryMiB: null, source: 'unknown' } });
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
            machine: { vcpu: 2, memoryMiB: 8192, instanceType: 'm6i.large', region: 'us-east-1', source: 'configured' },
            lifecycleState: 'RUNNING', usage: null,
        });
        expect(writes(statements)).toEqual([]);
    });

    it('aws-ec2 placement with no instance type yet: size unknown, never inferred from the plan', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OWNER })] });
        const info = await readSystemInfo(db, computer, READS);
        expect(info?.machine).toEqual({ vcpu: null, memoryMiB: null, instanceType: null, region: null, source: 'unknown' });
    });

    it('aws-ec2 placement with an unlisted instance type: name shown, size unknown', () => {
        const info = describePlacement({ provider: 'aws-ec2', store: 'ebs', record: { ...baseRecord(), instanceType: 'x9.huge' } });
        expect(info.machine).toMatchObject({ instanceType: 'x9.huge', vcpu: null, memoryMiB: null, source: 'unknown' });
    });

    it('cloudflare placement: the configured container class', async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OWNER, provider: 'cloudflare', workspace_store: 'r2' })] });
        const info = await readSystemInfo(db, computer, READS);
        expect(info).toMatchObject({ provider: 'cloudflare', providerSource: 'placement', machine: { vcpu: 2, memoryMiB: 6144, source: 'configured' } });
    });

    it("another user's placement: null (→ NOT_FOUND), nothing about it is returned", async () => {
        const { db } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: OTHER, instance_type: 't3a.medium' })] });
        expect(await readSystemInfo(db, computer, READS)).toBeNull();
    });

    it('an unreadable placement (missing table, duplicate, unknown provider): "unknown", not Cloudflare', async () => {
        const missing = { execute: async () => { throw new Error('relation "public.ezil_computer_placements" does not exist'); } };
        expect(await readSystemInfo(missing, computer, READS)).toMatchObject({ provider: 'unknown', providerSource: 'unavailable' });
        const dup = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId }), placementRow({ computer_id: computerId })] });
        expect(await readSystemInfo(dup.db, computer, READS)).toMatchObject({ provider: 'unknown' });
        const unknown = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, provider: 'azure' })] });
        expect(await readSystemInfo(unknown.db, computer, READS)).toMatchObject({ provider: 'unknown' });
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
