import { describe, expect, it, vi } from 'vitest';
import { AWS_REQUIRED_FOUNDER_ID, CLOUDFLARE_DEV_ACCOUNT_ID, awsRequiredUserIds, invalidRequiredUserConfig, isAwsRequiredUser, isCloudflareDevAccount } from './aws-config';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { AwsPlacementRefusedError, AwsRequiredError, resolveComputeProvider } from './select';

const userId = AWS_REQUIRED_FOUNDER_ID;
const builder = '11111111-1111-4111-8111-111111111111';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId, computerId };
const ENV = {
    EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_CANARY_SINCE: '2026-10-15T00:00:00Z',
    AWS_MAX_RUNNING: '2', EZIL_AWS_USER_MONTHLY_HOURS: '10', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '10', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '10',
    AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
};
const start = { pinCloudflare: true };
const seeded = (owner = userId, created = '2026-10-16T00:00:00Z') => createFakePlacementDb({
    computers: [{ id: computerId, user_id: owner, created_at: new Date(created) }],
});

describe('founder is always AWS-required for new placement', () => {
    it.each([
        { name: 'placement reads disabled', env: {}, reason: 'placement_reads_disabled' },
        { name: 'AWS disabled', env: { ...ENV, EZIL_AWS_COMPUTERS_ENABLED: '0', EZIL_COMPUTE_PLACEMENT_READS: '1' }, reason: 'aws_disabled' },
        { name: 'cutoff absent', env: { ...ENV, EZIL_AWS_CANARY_SINCE: undefined }, reason: 'canary_unset' },
        { name: 'cohort excludes founder', env: { ...ENV, EZIL_AWS_CANARY_USER_IDS: builder }, reason: 'user_not_in_cohort' },
        { name: 'capacity full', env: { ...ENV, AWS_MAX_RUNNING: '0' }, reason: 'admission_refused:max_running' },
        { name: 'invalid spending limit', env: { ...ENV, AWS_MAX_RUNNING: undefined }, reason: 'admission_refused:aws_config_invalid' },
    ])('$name refuses without creating any placement', async ({ env, reason }) => {
        const { db, placements } = seeded();
        await expect(resolveComputeProvider(db, computer, env, {}, start)).rejects.toMatchObject({ name: 'AwsRequiredError', reason });
        expect(placements).toEqual([]);
    });

    it.each(['*', 'bad', `${userId},bad`, `${builder},`])('malformed additional requirements %s fail closed', async (list) => {
        const { db, placements } = seeded();
        await expect(resolveComputeProvider(db, computer, { ...ENV, EZIL_AWS_REQUIRED_USER_IDS: list }, {}, start))
            .rejects.toMatchObject({ name: 'AwsPlacementRefusedError', reason: 'aws_required_config_invalid' });
        expect(placements).toEqual([]);
        expect(isAwsRequiredUser({ EZIL_AWS_REQUIRED_USER_IDS: list }, userId)).toBe(true);
    });

    it('concurrent founder resolutions only return AWS and never write a Cloudflare pin', async () => {
        const { db, placements } = seeded();
        const results = await Promise.all(Array.from({ length: 6 }, () => resolveComputeProvider(db, computer, ENV, {}, start)));
        expect(results.map((r) => r.kind)).toEqual(Array(6).fill('aws-ec2'));
        expect(placements).toEqual([]);
    });

    it('preserves a Cloudflare pin even with malformed requirements or disabled AWS', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' })] });
        const provider = await resolveComputeProvider(db, computer, { EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_REQUIRED_USER_IDS: 'bad' }, {}, start);
        expect(provider.kind).toBe('cloudflare');
        expect(placements).toHaveLength(1);
    });

    it('keeps a pre-cutoff unplaced computer on Cloudflare rather than opening an empty AWS disk', async () => {
        const { db, placements } = seeded(userId, '2026-09-18T00:00:00Z');
        expect((await resolveComputeProvider(db, computer, ENV, {}, start)).kind).toBe('cloudflare');
        expect(placements[0]?.provider).toBe('cloudflare');
    });
});

describe('builders prefer AWS; fallback requires only allowed admission refusals', () => {
    const ref = { userId: builder, computerId };
    it('an unset cohort list prefers AWS for a new builder', async () => {
        const { db } = seeded(builder);
        expect((await resolveComputeProvider(db, ref, ENV, {}, start)).kind).toBe('aws-ec2');
    });
    it.each(['AWS_MAX_RUNNING', 'EZIL_AWS_USER_MONTHLY_HOURS', 'EZIL_AWS_GLOBAL_MONTHLY_HOURS', 'EZIL_AWS_USER_MONTHLY_EGRESS_GB', 'EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB', 'EZIL_AWS_MAX_RUNNING_US_EAST_1'])('%s cap permits a labeled Cloudflare pin', async (key) => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const { db, placements } = seeded(builder);
            expect((await resolveComputeProvider(db, ref, { ...ENV, [key]: '0' }, {}, start)).kind).toBe('cloudflare');
            expect(placements[0]?.provider).toBe('cloudflare');
            expect(placements[0]?.last_error).toMatch(/^cloudflare_fallback:admission_refused:/);
            expect(log).toHaveBeenCalledWith('[compute.placement] pinned', expect.objectContaining({ provider: 'cloudflare', canary: expect.stringContaining('admission_refused:') }));
        } finally { log.mockRestore(); }
    });
    it.each([
        {}, { ...ENV, AWS_MAX_RUNNING: undefined }, { ...ENV, EZIL_AWS_CANARY_SINCE: undefined },
        { ...ENV, EZIL_AWS_CANARY_USER_IDS: 'bad' }, { ...ENV, EZIL_AWS_REQUIRED_USER_IDS: 'bad' },
        { ...ENV, EZIL_AWS_COMPUTERS_ENABLED: '0', EZIL_COMPUTE_PLACEMENT_READS: '1' },
        { ...ENV, EZIL_AWS_CANARY_USER_IDS: userId },
    ])('invalid/incomplete config %j refuses before a pin', async (env) => {
        const { db, placements } = seeded(builder);
        await expect(resolveComputeProvider(db, ref, env, {}, start)).rejects.toBeInstanceOf(AwsPlacementRefusedError);
        expect(placements).toEqual([]);
    });
    it.each(['missing', 'deleted', 'foreign', 'duplicate'])('%s state never becomes Cloudflare fallback', async (state) => {
        const seed = createFakePlacementDb({ computers: state === 'missing' ? [] : [{
            id: computerId, user_id: state === 'foreign' ? userId : builder,
            created_at: new Date('2026-10-16T00:00:00Z'), deleted_at: state === 'deleted' ? new Date() : null,
        }] });
        if (state === 'duplicate') seed.placements.push(placementRow({ computer_id: computerId }), placementRow({ computer_id: computerId }));
        await expect(resolveComputeProvider(seed.db, ref, ENV, {}, start)).rejects.toThrow();
        expect(seed.placements.every((r) => r.provider !== 'cloudflare')).toBe(true);
    });
    it('a kill switch cannot hide duplicate placement elsewhere in admission counters', async () => {
        const seed = seeded(builder);
        seed.placements.push(placementRow({ computer_id: userId }), placementRow({ computer_id: userId }));
        await expect(resolveComputeProvider(seed.db, ref, { ...ENV, EZIL_AWS_KILL_SWITCH: '1' }, {}, start)).rejects.toBeInstanceOf(AwsPlacementRefusedError);
        expect(seed.placements.every((r) => r.provider !== 'cloudflare')).toBe(true);
    });
});

describe('dev account: its own computers start on Cloudflare when AWS does not take them', () => {
    const dev = CLOUDFLARE_DEV_ACCOUNT_ID;
    const devRef = { userId: dev, computerId };
    const AWS_OFF = { ...ENV, EZIL_AWS_COMPUTERS_ENABLED: '2', EZIL_COMPUTE_PLACEMENT_READS: '1' };

    it('pins a labelled Cloudflare placement for the dev account while AWS is off', async () => {
        const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const { db, placements } = seeded(dev);
            expect((await resolveComputeProvider(db, devRef, AWS_OFF, {}, start)).kind).toBe('cloudflare');
            expect(placements).toHaveLength(1);
            expect(placements[0]).toMatchObject({ provider: 'cloudflare', owner_user_id: dev, last_error: 'cloudflare_fallback:dev_account:aws_disabled' });
        } finally { log.mockRestore(); }
    });

    it('matches the id case-insensitively and nothing else', () => {
        expect(isCloudflareDevAccount(dev.toUpperCase())).toBe(true);
        expect(isCloudflareDevAccount(builder)).toBe(false);
        expect(isCloudflareDevAccount(userId)).toBe(false);
    });

    it('changes nothing for any other account: builder and founder still refuse before any pin', async () => {
        const other = seeded(builder);
        await expect(resolveComputeProvider(other.db, { userId: builder, computerId }, AWS_OFF, {}, start)).rejects.toBeInstanceOf(AwsPlacementRefusedError);
        expect(other.placements).toEqual([]);
        const founder = seeded();
        await expect(resolveComputeProvider(founder.db, computer, AWS_OFF, {}, start)).rejects.toMatchObject({ name: 'AwsRequiredError', reason: 'aws_disabled' });
        expect(founder.placements).toEqual([]);
    });

    it('still goes to AWS when AWS admits the dev account', async () => {
        const { db, placements } = seeded(dev);
        expect((await resolveComputeProvider(db, devRef, ENV, {}, start)).kind).toBe('aws-ec2');
        expect(placements).toEqual([]);
    });

    it('reads and stops never pin, even for the dev account', async () => {
        const { db, placements } = seeded(dev);
        expect((await resolveComputeProvider(db, devRef, AWS_OFF, {}, {})).kind).toBe('cloudflare');
        expect(placements).toEqual([]);
    });

    it('cannot pin without placement reads', async () => {
        const { db, placements } = seeded(dev);
        await expect(resolveComputeProvider(db, devRef, { EZIL_COMPUTE_PLACEMENT_READS: undefined }, {}, start))
            .rejects.toMatchObject({ name: 'AwsPlacementRefusedError', reason: 'placement_reads_disabled' });
        expect(placements).toEqual([]);
    });

    it.each([
        { state: 'missing', reason: 'computer_missing' },
        { state: 'foreign', reason: 'owner_mismatch' },
        { state: 'deleted', reason: 'computer_deleted' },
    ])('a $state computer is refused, never pinned', async ({ state, reason }) => {
        const seed = createFakePlacementDb({ computers: state === 'missing' ? [] : [{
            id: computerId, user_id: state === 'foreign' ? builder : dev,
            created_at: new Date('2026-10-16T00:00:00Z'), deleted_at: state === 'deleted' ? new Date() : null,
        }] });
        await expect(resolveComputeProvider(seed.db, devRef, AWS_OFF, {}, start)).rejects.toMatchObject({ name: 'AwsPlacementRefusedError', reason });
        expect(seed.placements).toEqual([]);
    });

    it('stays AWS-required if the owner lists it as required', async () => {
        const { db, placements } = seeded(dev);
        await expect(resolveComputeProvider(db, devRef, { ...AWS_OFF, EZIL_AWS_REQUIRED_USER_IDS: dev }, {}, start))
            .rejects.toMatchObject({ name: 'AwsRequiredError', reason: 'aws_disabled' });
        expect(placements).toEqual([]);
    });

    it('an existing AWS placement is never changed', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: computerId, owner_user_id: dev, provider: 'aws-ec2' })] });
        await resolveComputeProvider(db, devRef, AWS_OFF, {}, start).catch(() => undefined);
        expect(placements).toHaveLength(1);
        expect(placements[0]?.provider).toBe('aws-ec2');
    });
});

describe('required-user configuration', () => {
    it('keeps founder plus canonical additional accounts and flags malformed config', () => {
        expect([...awsRequiredUserIds({ EZIL_AWS_REQUIRED_USER_IDS: ` ${builder.toUpperCase()} ` })]).toEqual([userId, builder]);
        expect(invalidRequiredUserConfig({ EZIL_AWS_REQUIRED_USER_IDS: `${builder},bad` })).toBe(true);
        expect(isAwsRequiredUser({ EZIL_AWS_REQUIRED_USER_IDS: `${builder},bad` }, builder)).toBe(true);
        expect(new AwsRequiredError(computerId, 'max_running').message).toBe('aws_required:max_running');
    });
});
