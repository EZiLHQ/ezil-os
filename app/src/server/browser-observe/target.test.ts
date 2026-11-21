import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { pinCloudflarePlacement } from '@/server/lib/compute/placement';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';

const dialect = new PgDialect();
const holder = vi.hoisted(() => ({ db: null as unknown as { execute(q: SQL): Promise<unknown> } }));
vi.mock('@/server/db', () => ({ db: { execute: (q: SQL) => holder.db.execute(q) } }));

import { resolveCloudflareBrowserTarget } from './target';

const computerId = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const stranger = '33333333-3333-4333-8333-333333333333';
const principal = { userId: owner, clientId: 'client-test' };

// The fake placement db does not model `ezil_computers` ownership reads for the browser resolver, so answer that
// one tagged statement from the seeded computer and delegate every placement statement to the fake store.
function install(seed: Parameters<typeof createFakePlacementDb>[0], owned = true) {
    const fake = createFakePlacementDb(seed);
    holder.db = {
        execute: (q: SQL) => {
            return dialect.sqlToQuery(q).sql.includes('browser:owned-now') ? Promise.resolve(owned ? [{ owned: 1 }] : []) : fake.db.execute(q);
        },
    };
    return fake;
}
const row = (over: Record<string, unknown> = {}) => placementRow({
    computer_id: computerId, owner_user_id: owner, provider: 'cloudflare', workspace_store: 'r2', state: 'STOPPED', ...over,
});

describe('Cloudflare browser target resolver', () => {
    beforeEach(() => { holder.db = null as never; });

    it('accepts the row pinCloudflarePlacement actually writes (generation 1, lease epoch 0)', async () => {
        const fake = install({ computers: [{ id: computerId, user_id: owner }] });
        await pinCloudflarePlacement(fake.db, { computerId, userId: owner });
        expect(fake.placements).toHaveLength(1);
        expect(fake.placements[0]).toMatchObject({ provider: 'cloudflare', state: 'STOPPED' });
        expect(Number(fake.placements[0]!.generation)).toBe(1);
        expect(Number(fake.placements[0]!.lease_epoch)).toBe(0);
        const target = await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1');
        expect(target).toEqual({ sandboxId: deriveGuacamoleSandboxId(owner, computerId), binding: expect.stringMatching(/^[0-9a-f]{64}$/) });
    });

    it.each([['STOPPED'], ['RUNNING']])('accepts a %s canonical row and the legacy 0/0 row, binding purpose and client', async (state) => {
        install({ placements: [row({ state })] });
        const canonical = await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1');
        expect(canonical).not.toBeNull();
        expect(await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-open-url-v1')).not.toEqual(canonical);
        expect(await resolveCloudflareBrowserTarget({ ...principal, clientId: 'other' }, computerId, 'ezil-browser-observe-v1')).not.toEqual(canonical);
        install({ placements: [row({ state, generation: 0, lease_epoch: 0 })] });
        expect(await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1')).toMatchObject({ sandboxId: canonical!.sandboxId });
    });

    it('binding changes when the placement row is updated, so a mid-request move is refused by the receiver', async () => {
        install({ placements: [row()] });
        const before = await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1');
        install({ placements: [row({ updated_at: new Date('2026-10-14T00:00:00Z') })] });
        const after = await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1');
        expect(after!.binding).not.toBe(before!.binding);
    });

    it.each([
        ['moved generation 2', { generation: 2 }],
        ['moved generation 3 epoch 1', { generation: 3, lease_epoch: 1 }],
        ['leased generation 1 epoch 1', { lease_epoch: 1 }],
        ['legacy generation 0 with epoch 1', { generation: 0, lease_epoch: 1 }],
        ['AWS provider with a valid-looking counter pair', { provider: 'aws-ec2', workspace_store: 'ebs' }],
        ['PROVISIONING state', { state: 'PROVISIONING' }],
        ['RETIRED state', { state: 'RETIRED' }],
        ['foreign owner', { owner_user_id: stranger }],
    ])('fails closed on %s', async (_label, over) => {
        install({ placements: [row(over)] });
        expect(await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1')).toBeNull();
    });

    it('fails closed when the computer is not owned now or no placement row exists', async () => {
        install({ placements: [row()] }, false);
        expect(await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1')).toBeNull();
        install({});
        expect(await resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1')).toBeNull();
    });
});
