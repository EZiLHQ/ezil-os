/**
 * Round 5 D3 seam: the plan id reaches the AWS provision sites on a FIRST create. The routers pass the
 * entitlement as a lazy function, which compute-dispatch turns into `entitlement: undefined` (a tier source
 * only); `resolveComputeProvider` resolves it for a computer with no placement and hands the RECORD to the
 * aws-ec2 provider. aws-ec2.ts sizes a new volume from `deps.entitlement?.planId` (Premium 100, Standard 50;
 * pinned in aws-ec2.test.ts / aws-ec2.pool.test.ts), so dropping the record here would silently give every
 * Premium first create the 50 GiB tier figure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import * as awsFactories from './aws-ec2';
import { createFakePlacementDb } from './fake-placement-db.test-support';
import { resolveComputeProvider } from './select';
import type { EntitlementRecord } from './tier';

const migrationRead = vi.hoisted(() => vi.fn(async (): Promise<Partial<Record<'userId' | 'state' | 'lastError', string>> | null> => null));
vi.mock('./provider-migrate-store', async importOriginal => ({
    ...await importOriginal<typeof import('./provider-migrate-store')>(),
    createProviderMigrationStore: () => ({ readByComputer: migrationRead, readActiveByComputer: async () => null }),
}));

const userId = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId, computerId };
const premium: EntitlementRecord = { source: 'billing_v2', status: 'active', planId: 'premium_monthly_v3', size: 'cmp-4', provider: 'aws', paymentIssue: false };

describe('round 5 D3: a first create hands the resolved plan to the aws-ec2 provider', () => {
    afterEach(() => vi.restoreAllMocks());

    it('fresh-provision route: the lazily resolved Premium record (planId) reaches the provider deps', async () => {
        migrationRead.mockResolvedValueOnce({ userId, state: 'committed', lastError: 'fresh_provision' });
        const factory = vi.spyOn(awsFactories, 'createAwsEc2Provider');
        const resolveEntitlement = vi.fn(async () => premium);
        // The router's shape: aws deps without a record (compute-dispatch's function form), a lazy resolver.
        const provider = await resolveComputeProvider(createFakePlacementDb().db, computer, { EZIL_AWS_COMPUTERS_ENABLED: '1' },
            { tierFor: async () => 'compute4' }, { resolveEntitlement });
        expect(provider.kind).toBe('aws-ec2');
        expect(resolveEntitlement).toHaveBeenCalledTimes(1);
        expect(factory.mock.calls.at(-1)?.[0].entitlement).toMatchObject({ planId: 'premium_monthly_v3' });
    });

    it('direct paid route (new computer after SINCE): the Premium record reaches the provider deps', async () => {
        const factory = vi.spyOn(awsFactories, 'createAwsEc2Provider');
        const { db } = createFakePlacementDb({ computers: [{ id: computerId, user_id: userId, created_at: new Date('2026-10-20T00:00:00Z') }] });
        const provider = await resolveComputeProvider(db, computer, { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_SINCE: '2026-10-14T00:00:00Z' },
            { tierFor: async () => 'compute4' }, { resolveEntitlement: async () => premium });
        expect(provider.kind).toBe('aws-ec2');
        expect(factory.mock.calls.at(-1)?.[0].entitlement).toMatchObject({ planId: 'premium_monthly_v3' });
    });
});
