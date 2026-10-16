/**
 * AWS-required accounts (`EZIL_AWS_REQUIRED_USER_IDS`): a NEW computer that the canary or
 * admission does not claim is refused with its reason, never silently pinned to Cloudflare.
 * Existing placements and pre-SINCE computers keep their current provider.
 */

import { describe, expect, it, vi } from 'vitest';

import { awsRequiredUserIds, isAwsRequiredUser } from './aws-config';
import { cloudflareComputeProvider } from './cloudflare';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { AwsRequiredError, resolveComputeProvider } from './select';

const userId = '11111111-1111-4111-8111-111111111111';
const otherUser = '44444444-4444-4444-8444-444444444444';
const computerId = '22222222-2222-4222-8222-222222222222';
const computer = { userId, computerId };
const SINCE = '2026-10-15T13:12:00Z';
const ADMIT = {
    AWS_MAX_RUNNING: '2', EZIL_AWS_USER_MONTHLY_HOURS: '10', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '10', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '10',
    AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
};
const REQUIRED = {
    EZIL_AWS_COMPUTERS_ENABLED: '1', ...ADMIT,
    EZIL_AWS_CANARY_USER_IDS: userId, EZIL_AWS_CANARY_SINCE: SINCE,
    EZIL_AWS_REQUIRED_USER_IDS: userId,
};
const created = (at: string) => ({ computers: [{ id: computerId, user_id: userId, created_at: new Date(at) }] });
const NEW = '2026-10-16T05:30:00Z';

async function refusal(env: Record<string, string | undefined>, at = NEW) {
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
        const { db, placements } = createFakePlacementDb(created(at));
        const error = await resolveComputeProvider(db, computer, env, {}, { pinCloudflare: true }).then(
            () => null,
            (err: unknown) => err,
        );
        return { error, placements, logs: spy.mock.calls };
    } finally {
        spy.mockRestore();
    }
}

describe('AWS-required account: a new computer is refused with its reason, never pinned to Cloudflare', () => {
    it.each([
        { name: 'AWS flag off (placement reads on)', env: { ...REQUIRED, EZIL_AWS_COMPUTERS_ENABLED: undefined, EZIL_COMPUTE_PLACEMENT_READS: '1' }, reason: 'aws_disabled' },
        { name: 'canary unset', env: { ...REQUIRED, EZIL_AWS_CANARY_USER_IDS: undefined }, reason: 'canary_unset' },
        { name: 'canary list has a trailing comma', env: { ...REQUIRED, EZIL_AWS_CANARY_USER_IDS: `${userId},` }, reason: 'canary_malformed' },
        { name: 'account not in the canary list', env: { ...REQUIRED, EZIL_AWS_CANARY_USER_IDS: otherUser }, reason: 'user_not_in_cohort' },
        { name: 'admission refuses (no running capacity)', env: { ...REQUIRED, AWS_MAX_RUNNING: '0' }, reason: 'admission_refused:' },
        { name: 'admission config invalid (a cap is not an integer)', env: { ...REQUIRED, EZIL_AWS_USER_MONTHLY_HOURS: '10 ' }, reason: 'admission_refused:aws_config_invalid' },
    ])('$name', async ({ env, reason }) => {
        const { error, placements, logs } = await refusal(env);
        expect(error).toBeInstanceOf(AwsRequiredError);
        expect((error as AwsRequiredError).reason.startsWith(reason)).toBe(true);
        expect((error as AwsRequiredError).message).toBe(`aws_required:${(error as AwsRequiredError).reason}`);
        expect(placements).toEqual([]); // no Cloudflare pin, no row of any kind
        const refused = logs.filter((call) => call[0] === '[compute.placement] aws_required_refused');
        expect(refused).toHaveLength(1);
        expect(refused[0]?.[1]).toMatchObject({ computerId });
        expect(JSON.stringify(logs)).not.toContain(userId);
        expect(logs.some((call) => call[0] === '[compute.placement] pinned')).toBe(false);
    });

    it('still reaches AWS when the canary and admission claim it', async () => {
        const { db, placements } = createFakePlacementDb(created(NEW));
        expect((await resolveComputeProvider(db, computer, REQUIRED, {}, { pinCloudflare: true })).kind).toBe('aws-ec2');
        expect(placements).toEqual([]); // the aws-ec2 provider's ensure() admits and writes, not resolve
    });
});

describe('AWS-required account: existing state is protected', () => {
    it('a computer created before SINCE keeps Cloudflare (it may hold an R2 workspace) and the pin says why', async () => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const { db, placements } = createFakePlacementDb(created('2026-09-18T02:27:45Z'));
            expect(await resolveComputeProvider(db, computer, REQUIRED, {}, { pinCloudflare: true })).toBe(cloudflareComputeProvider);
            expect(placements.map((row) => row.provider)).toEqual(['cloudflare']);
            expect(spy.mock.calls.find((call) => call[0] === '[compute.placement] pinned')?.[1]).toMatchObject({ canary: 'created_before_since' });
        } finally {
            spy.mockRestore();
        }
    });

    it('an existing Cloudflare placement is never changed or refused', async () => {
        const row = placementRow({ computer_id: computerId, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' });
        const { db, placements, statements } = createFakePlacementDb({ ...created(NEW), placements: [row] });
        expect(await resolveComputeProvider(db, computer, REQUIRED, {}, { pinCloudflare: true })).toBe(cloudflareComputeProvider);
        expect(placements).toHaveLength(1);
        expect(placements[0]?.provider).toBe('cloudflare');
        expect(statements.every((statement) => !statement.sql.includes('placement:insert'))).toBe(true);
    });

    it('a read that does not start a sandbox is never refused and writes nothing', async () => {
        const { db, placements } = createFakePlacementDb(created(NEW));
        const env = { ...REQUIRED, EZIL_AWS_CANARY_USER_IDS: otherUser };
        expect(await resolveComputeProvider(db, computer, env)).toBe(cloudflareComputeProvider);
        expect(placements).toEqual([]);
    });
});

describe('accounts not on the required list keep today\'s behaviour', () => {
    it.each([
        { name: 'another account is required, not this one', required: otherUser },
        { name: 'list unset', required: undefined },
        { name: '`*` is not accepted (nobody is required)', required: '*' },
        { name: 'a malformed entry voids the list', required: `${userId},not-a-uuid` },
    ])('$name: the refused computer is pinned to Cloudflare as before', async ({ required }) => {
        const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
        try {
            const { db, placements } = createFakePlacementDb(created(NEW));
            const env = { ...REQUIRED, EZIL_AWS_CANARY_USER_IDS: otherUser, EZIL_AWS_REQUIRED_USER_IDS: required };
            expect(await resolveComputeProvider(db, computer, env, {}, { pinCloudflare: true })).toBe(cloudflareComputeProvider);
            expect(placements.map((row) => row.provider)).toEqual(['cloudflare']);
        } finally {
            spy.mockRestore();
        }
    });
});

describe('awsRequiredUserIds', () => {
    it('parses comma-separated UUIDs, trimming and ignoring case', () => {
        const ids = awsRequiredUserIds({ EZIL_AWS_REQUIRED_USER_IDS: ` ${userId.toUpperCase()} , ${otherUser}` });
        expect([...ids]).toEqual([userId, otherUser]);
        expect(isAwsRequiredUser({ EZIL_AWS_REQUIRED_USER_IDS: userId }, userId.toUpperCase())).toBe(true);
    });

    it.each([undefined, '', '   ', '*', `${userId},`, `${userId},*`, 'not-a-uuid'])('%j means nobody is required', (value) => {
        expect(awsRequiredUserIds({ EZIL_AWS_REQUIRED_USER_IDS: value }).size).toBe(0);
    });
});
