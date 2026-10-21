/**
 * AWS admission (docs/AWS-COMPUTERS.md C-3, §4). Pure decision first, then
 * the transactional path against the fake database (real mutex locks, CAS
 * parsed from the SQL text).
 */

import { describe, expect, it } from 'vitest';

import { decideAdmission, runAdmission, type RegionalCounters, type RegionPlan } from './admission';
import { AWS_CAP_ENV, AWS_TIERS, instanceTypeForTier, isAwsTier, readAwsAdmissionConfig, regionCapEnv, type AwsAdmissionConfig } from './aws-config';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { leasePlacement, mintAdmissionTicket, readAdmissionCounters, withAdmission, ENROLLMENT_FAILED, type AdmissionCounters } from './placement';
import { monthUsageFromRows } from './usage';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const C3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const NOW = new Date('2026-10-13T12:00:00Z');
/** Every AWS row lives in a region; seeded rows default to the configured one. */
const awsRow = (over: Parameters<typeof placementRow>[0]) => placementRow({ region: 'ap-south-1', instance_type: 'm6i.large', ...over });
const GB = 1_000_000_000;

const ENV = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    AWS_MAX_RUNNING: '2',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
};
const config = readAwsAdmissionConfig(ENV);
const empty: Pick<AdmissionCounters, 'targetOwnerId' | 'targetPlacementOwnerId' | 'targetDeleted' | 'targetForeignUsage' | 'runningCount' | 'userOtherAwsComputers' | 'duplicates' | 'usage'> = { targetOwnerId: U1, targetPlacementOwnerId: null, targetDeleted: false, targetForeignUsage: 0, runningCount: 0, userOtherAwsComputers: 0, duplicates: [], usage: monthUsageFromRows([], NOW) };
const hoursRow = (userId: string, hours: number, egressBytes: number | null = 0) => ({
    computerId: C3,
    userId,
    instanceType: 'm6i.large',
    startedAt: new Date(NOW.getTime() - hours * 3_600_000),
    stoppedAt: NOW,
    egressBytes,
});

describe('config: absent or invalid means disabled', () => {
    it('absent flag disables', () => {
        expect(readAwsAdmissionConfig({})).toEqual({ enabled: false, reason: 'aws_disabled' });
        expect(readAwsAdmissionConfig({ ...ENV, EZIL_AWS_COMPUTERS_ENABLED: 'true' })).toEqual({ enabled: false, reason: 'aws_disabled' });
    });

    it('a complete config enables with the kill switch off', () => {
        expect(config).toEqual({
            enabled: true,
            killSwitch: false,
            caps: { maxRunning: 2, userMonthlyHours: 100, globalMonthlyHours: 600, userMonthlyEgressGb: 50, globalMonthlyEgressGb: 200 },
            regions: [{ name: 'ap-south-1', maxRunning: 2 }],
        });
    });

    it.each(Object.values(AWS_CAP_ENV).flatMap((name) => [undefined, '', 'NaN', '-1', '1.5', ' 2', '1e3', 'two', '9007199254740993'].map((v) => [name, v] as const)))(
        '%s=%j disables admission',
        (name, v) => {
            const cfg = readAwsAdmissionConfig({ ...ENV, [name]: v });
            expect(cfg).toEqual({ enabled: false, reason: 'aws_config_invalid', invalid: [name] });
        },
    );

    it.each([['1', true], ['yes', true], ['', true], ['0', false], [undefined, false]] as const)('kill switch %j -> %s', (v, on) => {
        const cfg = readAwsAdmissionConfig({ ...ENV, EZIL_AWS_KILL_SWITCH: v });
        expect(cfg.enabled && cfg.killSwitch).toBe(on);
    });
});

describe('decideAdmission (pure)', () => {
    // Fixtures are usage ROWS; admission takes the database's totals (`readMonthUsage`), which
    // `monthUsageFromRows` reproduces exactly (pinned against real Postgres in placement-usage-sql).
    type DecideCounters = Partial<Omit<typeof empty, 'usage'>> & RegionalCounters & { usage?: Parameters<typeof monthUsageFromRows>[0] };
    const decide = (counters: DecideCounters = {}, cfg: AwsAdmissionConfig = config) =>
        decideAdmission({ config: cfg, counters: { ...empty, ...counters, usage: monthUsageFromRows(counters.usage ?? [], NOW) }, userId: U1, now: NOW, instanceType: 'm6i.large' });

    it('admits under every cap', () => {
        expect(decide({ runningCount: 1, runningVcpu: 2, usage: [hoursRow(U1, 99, 49 * GB), hoursRow(U2, 400, 100 * GB)] })).toEqual({ admit: true });
    });

    it.each([
        ['disabled', {}, readAwsAdmissionConfig({}), 'aws_disabled'],
        ['not the owner', { targetOwnerId: U2 }, config, 'computer_not_owned'],
        ['no such computer', { targetOwnerId: null }, config, 'computer_not_owned'],
        ['placement owned by someone else', { targetPlacementOwnerId: U2 }, config, 'computer_not_owned'],
        ['usage metered to another user', { targetForeignUsage: 1 }, config, 'computer_not_owned'],
        ['soft-deleted computer', { targetDeleted: true }, config, 'computer_deleted'],
        ['kill switch', {}, readAwsAdmissionConfig({ ...ENV, EZIL_AWS_KILL_SWITCH: '1' }), 'kill_switch'],
        ['duplicates', { duplicates: [{ computerId: C1, rows: 2 }] }, config, 'duplicate_placement'],
        ['running at cap', { runningCount: 2 }, config, 'max_running'],
        ['user has an AWS computer', { userOtherAwsComputers: 1 }, config, 'user_has_aws_computer'],
        ['user hours at cap', { usage: [hoursRow(U1, 100)] }, config, 'user_hours_cap'],
        ['global hours at cap', { usage: [hoursRow(U2, 300), hoursRow(U3, 300)] }, config, 'global_hours_cap'],
        ['user egress at cap', { usage: [hoursRow(U1, 1, 50 * GB)] }, config, 'user_egress_cap'],
        ['global egress at cap', { usage: [hoursRow(U2, 1, 200 * GB)] }, config, 'global_egress_cap'],
    ] as const)('%s refuses with a machine-readable reason', (_label, counters, cfg, reason) => {
        const d = decide(counters as never, cfg);
        expect(d.admit).toBe(false);
        expect(!d.admit && d.reason).toBe(reason);
    });

    it('a cap of zero refuses everything (no NaN admission)', () => {
        const zero = readAwsAdmissionConfig({ ...ENV, AWS_MAX_RUNNING: '0' });
        expect(decide({}, zero)).toMatchObject({ admit: false, reason: 'max_running' });
    });

    it('lists every failing reason', () => {
        const d = decide({ runningCount: 5, userOtherAwsComputers: 1 });
        expect(!d.admit && d.reasons).toEqual(['max_running', 'user_has_aws_computer']);
    });
});

describe('vCPU-weighted admission', () => {
    const env = (global: number, regional = global) => ({ ...ENV, AWS_MAX_RUNNING: String(global), EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: String(regional) });
    const computers = [{ id: C1, user_id: U1 }];
    const create = (tier: 'plus' | 'compute4' | 'compute8') => ({ kind: 'create' as const, userId: U1, computerId: C1, tier });
    const lease = { kind: 'lease' as const, userId: U1, computerId: C1, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date(NOW.getTime() + 3_600_000) };
    const running = (computer_id = C2, instance_type: string | null = 'm6i.large', region: string | null = 'ap-south-1') =>
        awsRow({ computer_id, owner_user_id: U2, state: 'RUNNING', instance_type, region });

    it('two m6i.large rows exhaust cap 2 and refuse a third', async () => {
        const { db } = createFakePlacementDb({ computers, placements: [running(), running(C3)] });
        expect(await runAdmission(db, create('plus'), { env: env(2), now: () => NOW })).toMatchObject({
            admitted: false, reasons: ['max_running', 'region_capacity'],
        });
    });

    it('one m6i.large with cap 3 refuses cmp-8 but admits std-2 and cmp-4', async () => {
        for (const tier of ['plus', 'compute4', 'compute8'] as const) {
            const { db } = createFakePlacementDb({ computers, placements: [running()] });
            const result = await runAdmission(db, create(tier), { env: env(3), now: () => NOW });
            expect(result.admitted).toBe(tier !== 'compute8');
            if (tier === 'compute8') expect(result).toMatchObject({ reason: 'max_running', reasons: ['max_running', 'region_capacity'] });
        }
    });

    it.each([[3, 10, 'max_running'], [10, 3, 'region_capacity']] as const)('global cap %i and regional cap %i independently enforce %s on create and lease', async (global, regional, reason) => {
        for (const request of [create('compute8'), lease]) {
            const placements = [running(), ...(request.kind === 'lease' ? [awsRow({ computer_id: C1, instance_type: 'm6i.2xlarge' })] : [])];
            const { db } = createFakePlacementDb({ computers, placements });
            expect(await runAdmission(db, request, { env: env(global, regional), now: () => NOW })).toMatchObject({ admitted: false, reason, reasons: [reason] });
        }
    });

    it.each(['unknown', null])('unknown recorded type %j costs 8 vCPU for running rows and wakes', async instance_type => {
        const runningDb = createFakePlacementDb({ computers, placements: [running(C2, instance_type)] }).db;
        expect(await runAdmission(runningDb, create('plus'), { env: env(4), now: () => NOW })).toMatchObject({ admitted: false, reason: 'max_running' });
        const wakeDb = createFakePlacementDb({ computers, placements: [awsRow({ computer_id: C1, instance_type })] }).db;
        expect(await runAdmission(wakeDb, lease, { env: env(3), now: () => NOW })).toMatchObject({ admitted: false, reason: 'max_running' });
    });

    it('missing pure vCPU data uses count times 8, including regional and unplaced counts', () => {
        const check = (counters: Partial<AdmissionCounters>, instanceType: string | null = 'm6i.large') => decideAdmission({
            config: readAwsAdmissionConfig(env(4)), counters: { ...empty, ...counters }, userId: U1, now: NOW,
            region: { kind: 'create' }, instanceType,
        });
        expect(check({ runningCount: 1 })).toMatchObject({ reasons: ['max_running', 'region_capacity'] });
        expect(check({ runningCount: 1, runningVcpu: 2, runningByRegion: { 'ap-south-1': 1 } })).toMatchObject({ reasons: ['region_capacity'] });
        expect(check({ runningCount: 1, runningVcpu: 2, runningByRegion: {}, runningUnplaced: 1 })).toMatchObject({ reasons: ['region_capacity'] });
        expect(check({ runningCount: 1, runningVcpu: 2, runningByRegion: { 'ap-south-1': 1 }, runningVcpuByRegion: { 'ap-south-1': 2 } })).toMatchObject({ admit: true });
        expect(check({ runningVcpu: 2 }, null)).toMatchObject({ reasons: ['max_running', 'region_capacity'] });
    });

    it('counters retain counts and sum mixed running types globally, per region and unplaced', async () => {
        const { db } = createFakePlacementDb({ computers, placements: [
            running(), running(C3, 'm6i.xlarge', 'us-east-1'), running(C1, null, null),
            awsRow({ computer_id: C2, state: 'STOPPED', instance_type: 'm6i.2xlarge' }),
            awsRow({ computer_id: C3, provider: 'cloudflare', workspace_store: 'r2', state: 'RUNNING' }),
        ] });
        const counters = await withAdmission(db, (tx, lock) => readAdmissionCounters(tx, lock, { userId: U1, computerId: C1, monthStart: new Date('2026-10-01T00:00:00Z'), now: NOW }));
        expect(counters).toMatchObject({
            runningCount: 3, runningVcpu: 14, runningByRegion: { 'ap-south-1': 1, 'us-east-1': 1 },
            runningVcpuByRegion: { 'ap-south-1': 2, 'us-east-1': 4 }, runningUnplaced: 1, runningVcpuUnplaced: 8,
        });
    });

    it('failed enrollment replacement reuses its recorded vCPU at an exactly full budget', async () => {
        const { db } = createFakePlacementDb({ computers, placements: [awsRow({
            computer_id: C1, state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED, instance_type: 'm6i.2xlarge',
        })] });
        expect(await runAdmission(db, { ...lease, replace: true }, { env: env(4), now: () => NOW })).toMatchObject({ admitted: true });
    });

    it.each([U1, U2])('one cmp-8 hour reaches a four-hour monthly cap for %s', userId => {
        const usage = monthUsageFromRows([{ ...hoursRow(userId, 1), instanceType: 'm6i.2xlarge' }], NOW);
        const decision = decideAdmission({ config: readAwsAdmissionConfig({ ...ENV, EZIL_AWS_USER_MONTHLY_HOURS: '4', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '4' }),
            counters: { ...empty, usage }, userId: U1, now: NOW, instanceType: 'm6i.large' });
        expect(decision).toMatchObject({ reasons: userId === U1 ? ['user_hours_cap', 'global_hours_cap'] : ['global_hours_cap'] });
    });
});

describe('runAdmission (transactional)', () => {
    const lease = (userId: string, computerId: string) =>
        ({ kind: 'lease', userId, computerId, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date(NOW.getTime() + 3_600_000) }) as const;
    const deps = { env: ENV, now: () => NOW };

    it('disabled config refuses without a single statement', async () => {
        const { db, statements } = createFakePlacementDb();
        expect(await runAdmission(db, lease(U1, C1), { env: {}, now: () => NOW })).toMatchObject({ admitted: false, reason: 'aws_disabled' });
        expect(await runAdmission(db, lease(U1, C1), { env: { ...ENV, AWS_MAX_RUNNING: 'x' }, now: () => NOW })).toMatchObject({ admitted: false, reason: 'aws_config_invalid' });
        expect(statements).toEqual([]);
    });

    it('takes the global lock FIRST, reads after it, issues no isolation change', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [awsRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: true, placement: { state: 'LEASED', leaseEpoch: 1 } });
        const sqls = statements.map((s) => s.sql);
        expect(sqls[0]).toBe('BEGIN');
        expect(sqls[1]).toMatch(/SELECT pg_advisory_xact_lock\(\$1::int4, 0\), current_setting\('transaction_isolation'\) AS isolation/);
        expect(sqls.slice(2, 10).map((s) => s.match(/placement:([a-z-]+)/)?.[1])).toEqual([
            'computer-owner', 'read', 'usage-foreign', 'count-running', 'count-running-region', 'count-user', 'duplicates', 'usage-month',
        ]);
        expect(sqls[10]).toMatch(/placement:read/); // the lease's home region, read under the lock
        expect(sqls[11]).toMatch(/placement:read/); // the replacement/enrollment-outcome re-read (review C1)
        expect(sqls[12]).toMatch(/placement:read/); // the CAS duplicate pre-check
        expect(sqls[13]).toMatch(/placement:cas/);
        expect(sqls[14]).toBe('COMMIT');
        expect(sqls).not.toContainEqual(expect.stringMatching(/set transaction|set session|isolation level/i));
    });

    it('the counter SQL counts running-class aws-ec2 rows and the user\'s other aws-ec2 rows by owner_user_id', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [awsRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        await runAdmission(db, lease(U1, C1), deps);
        const running = statements.find((s) => /count-running/.test(s.sql))!;
        expect(running.sql).toMatch(/provider = 'aws-ec2' AND state IN \(/);
        expect(running.params).toContain('UNCONFIRMED');
        expect(running.params).not.toContain('STOPPED');
        const perRegion = statements.find((s) => /count-running-region/.test(s.sql))!;
        expect(perRegion.sql).toMatch(/SELECT region, count\(\*\)::int AS n,\s+COALESCE\(SUM\(CASE instance_type[\s\S]*?AS vcpu\s+FROM \([\s\S]*UNION ALL[\s\S]*ezil_compute_migrations[\s\S]*\) AS capacity\s+WHERE provider = 'aws-ec2' AND state IN \([^)]*\)\s+GROUP BY region/);
        expect(perRegion.params).toEqual(running.params);
        const user = statements.find((s) => /count-user/.test(s.sql))!;
        expect(user.sql).toMatch(/p\.computer_id <> \$1::uuid AND p\.state <> 'PURGE_ELIGIBLE'/);
        expect(user.sql).toMatch(/AND \(p\.owner_user_id = \$2::uuid/);
        expect(user.sql).not.toMatch(/ezil_computers/);
        expect(user.sql).toMatch(/OR EXISTS \(SELECT 1 FROM public\.ezil_compute_usage u WHERE u\.computer_id = p\.computer_id AND u\.user_id = \$3::uuid\)/);
        expect(user.sql).not.toMatch(/deleted_at/);
    });

    it('two concurrent admissions at the running cap: exactly one winner', async () => {
        // AWS_MAX_RUNNING=2, one computer already RUNNING: one slot left, two contenders.
        const { db, placements } = createFakePlacementDb({
            placements: [
                awsRow({ computer_id: C3, owner_user_id: U3, state: 'RUNNING' }),
                awsRow({ computer_id: C1, owner_user_id: U1 }),
                awsRow({ computer_id: C2, owner_user_id: U2 }),
            ],
            computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }, { id: C3, user_id: U3 }],
        });
        const results = await Promise.all([runAdmission(db, lease(U1, C1), deps), runAdmission(db, lease(U2, C2), deps)]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ admitted: false, reason: 'max_running' });
        expect(placements.filter((p) => p.state === 'LEASED')).toHaveLength(1);
    });

    it('two concurrent leases of the same computer: exactly one winner, the loser sees cas_conflict', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [awsRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        const results = await Promise.all([runAdmission(db, lease(U1, C1), deps), runAdmission(db, lease(U1, C1), deps)]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ reason: 'cas_conflict' });
        expect(placements[0]).toMatchObject({ state: 'LEASED', lease_epoch: 1 });
    });

    it('one AWS computer per user, even when the other computer is soft-deleted', async () => {
        const { db } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1 }), awsRow({ computer_id: C2, state: 'RETIRED' })],
            computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U1 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'user_has_aws_computer' });
    });

    it('two concurrent creates for one user: exactly one AWS placement', async () => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U1 }] });
        const results = await Promise.all([
            runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps),
            runAdmission(db, { kind: 'create', userId: U1, computerId: C2, tier: 'free' }, deps),
        ]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ reason: 'user_has_aws_computer' });
        expect(placements).toHaveLength(1);
        expect(placements[0]).toMatchObject({ provider: 'aws-ec2', workspace_store: 'ebs', state: 'PROVISIONING', generation: 1, lease_epoch: 1 });
    });

    it('usage from the ledger closes admission at the hours cap (open row counted to now)', async () => {
        const { db } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1 })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C1, user_id: U1, started_at: new Date(NOW.getTime() - 100 * 3_600_000), stopped_at: null, egress_bytes: null }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'user_hours_cap' });
    });

    it("a create for another user's computer is refused before any write", async () => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: C1, user_id: U2 }] });
        expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps)).toMatchObject({ admitted: false, reason: 'computer_not_owned' });
        expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C2, tier: 'free' }, deps)).toMatchObject({ admitted: false, reason: 'computer_not_owned' });
        expect(placements).toEqual([]);
    });

    it('a STOPPED Cloudflare row is never leased under AWS admission', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1, provider: 'cloudflare', workspace_store: 'r2' })],
            computers: [{ id: C1, user_id: U1 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'cas_conflict' });
        expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
    });

    it('a re-keyed computer row cannot hide an AWS computer that has run (usage ledger counts)', async () => {
        // C3's ezil_computers row is gone (re-keyed by its owner), but the ledger metered it to U1.
        const { db } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C3 })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C3, user_id: U1, started_at: new Date('2026-09-01T00:00:00Z'), stopped_at: new Date('2026-09-01T01:00:00Z'), egress_bytes: 0 }],
        });
        expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps)).toMatchObject({ admitted: false, reason: 'user_has_aws_computer' });
    });

    it('a placement whose usage was metered to another user is not leasable by the current row owner', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1 })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C1, user_id: U2, started_at: new Date('2026-09-01T00:00:00Z'), stopped_at: new Date('2026-09-01T01:00:00Z'), egress_bytes: 0 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'computer_not_owned' });
        expect(placements[0]!.state).toBe('STOPPED');
    });

    it('a soft-deleted computer is not admitted', async () => {
        const { db } = createFakePlacementDb({ placements: [awsRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1, deleted_at: NOW }] });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'computer_deleted' });
    });

    it('a malformed egress_bytes refuses admission instead of counting as 0', async () => {
        const { db, placements } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1 })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C1, user_id: U1, started_at: new Date(NOW.getTime() - 3_600_000), stopped_at: null, egress_bytes: 'lots' }],
        });
        await expect(runAdmission(db, lease(U1, C1), deps)).rejects.toThrow(/egress_bytes/);
        expect(placements[0]!.state).toBe('STOPPED');
    });

    it('refuses outside READ COMMITTED before reading any counter', async () => {
        const { db, statements, placements } = createFakePlacementDb(
            { placements: [awsRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] },
            { isolation: 'repeatable read' },
        );
        await expect(runAdmission(db, lease(U1, C1), deps)).rejects.toThrow(/READ COMMITTED/);
        expect(statements.map((s) => s.sql)).not.toContainEqual(expect.stringMatching(/placement:(computer-owner|count-running|cas)/));
        expect(placements[0]!.state).toBe('STOPPED');
    });

    describe('ownership is owner_user_id, never ezil_computers (C-2)', () => {
        const C9 = '99999999-9999-4999-8999-999999999999';
        const GONE = '66666666-6666-4666-8666-666666666666';

        it('(a) the owner re-keys a NEVER-RUN computer to dodge the per-user check: still counted', async () => {
            // C9's ezil_computers row was re-keyed away by U1; no usage was ever metered.
            const { db, placements } = createFakePlacementDb({
                placements: [awsRow({ computer_id: C9, owner_user_id: U1, state: 'STOPPED' })],
                computers: [{ id: C1, user_id: U1 }],
            });
            expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps)).toMatchObject({ admitted: false, reason: 'user_has_aws_computer' });
            expect(placements).toHaveLength(1);
        });

        it('(b) after account deletion, another user re-inserts a computer row with the same id: refused', async () => {
            const { db, placements } = createFakePlacementDb({
                placements: [awsRow({ computer_id: C9, owner_user_id: GONE, state: 'STOPPED' })],
                computers: [{ id: C9, user_id: U2 }], // U2 inserted a row with the orphaned id
            });
            const leased = await runAdmission(db, lease(U2, C9), deps);
            expect(leased).toMatchObject({ admitted: false, reason: 'computer_not_owned' });
            const created = await runAdmission(db, { kind: 'create', userId: U2, computerId: C9, tier: 'free' }, deps);
            expect(created).toMatchObject({ admitted: false, reason: 'computer_not_owned' });
            expect(placements).toEqual([expect.objectContaining({ owner_user_id: GONE, state: 'STOPPED', lease_epoch: 0 })]);
        });

        it('the lease CAS itself only matches the owner, even with a ticket minted despite the decision', async () => {
            const { db, placements } = createFakePlacementDb({ placements: [awsRow({ computer_id: C9, owner_user_id: GONE })] });
            const r = await withAdmission(db, async (tx, lock) => {
                // A ticket the decision would never have issued (U2 does not own C9): the CAS still refuses.
                await readAdmissionCounters(tx, lock, { userId: U2, computerId: C9, monthStart: new Date(0), now: NOW });
                const ticket = mintAdmissionTicket(tx, lock, { computerId: C9, userId: U2, kind: 'lease' });
                return leasePlacement(tx, lock, ticket, { computerId: C9, ownerUserId: U2, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: NOW });
            });
            expect(r).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
        });

        it('create records the session user as owner, lower-cased, whatever ezil_computers says later', async () => {
            const UA = 'abcdefab-cdef-4abc-8def-abcdefabcdef'; // letters, so case actually matters
            const { db, placements } = createFakePlacementDb({ computers: [{ id: C1, user_id: UA }] });
            const r = await runAdmission(db, { kind: 'create', userId: UA.toUpperCase(), computerId: C1, tier: 'free' }, deps);
            expect(r).toMatchObject({ admitted: true, placement: { ownerUserId: UA } });
            expect(placements[0]!.owner_user_id).toBe(UA);
        });
    });

    it('duplicate placements anywhere close admission', async () => {
        const { db } = createFakePlacementDb({
            placements: [awsRow({ computer_id: C1 }), awsRow({ computer_id: C2 }), awsRow({ computer_id: C2 })],
            computers: [{ id: C1, user_id: U1 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'duplicate_placement' });
    });
});

describe('regions and tiers (founder decisions 2026-10-14)', () => {
    const TWO = { ...ENV, AWS_REGIONS: 'ap-south-1,us-east-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2', EZIL_AWS_MAX_RUNNING_US_EAST_1: '2' };
    const deps2 = (env: Record<string, string>) => ({ env, now: () => NOW });

    describe('config', () => {
        it('reads regions in order with their own caps', () => {
            const cfg = readAwsAdmissionConfig(TWO);
            expect(cfg.enabled && cfg.regions).toEqual([{ name: 'ap-south-1', maxRunning: 2 }, { name: 'us-east-1', maxRunning: 2 }]);
            expect(regionCapEnv('us-east-1')).toBe('EZIL_AWS_MAX_RUNNING_US_EAST_1');
        });

        it.each([undefined, '', 'ap-south-1,', 'AP-SOUTH-1', 'ap-south-1,ap-south-1', 'mars-east-1', 'ap-south-1 ,us-east-1', 'ap-south-1,us-east-1,us-east-2,us-west-2,eu-west-1'])(
            'AWS_REGIONS=%j disables admission',
            (v) => {
                expect(readAwsAdmissionConfig({ ...TWO, AWS_REGIONS: v })).toEqual({ enabled: false, reason: 'aws_config_invalid', invalid: ['AWS_REGIONS'] });
            },
        );

        it.each([undefined, '', '-1', '1.5', 'x'])('a region cap of %j disables admission (no default, never 64)', (v) => {
            expect(readAwsAdmissionConfig({ ...TWO, EZIL_AWS_MAX_RUNNING_US_EAST_1: v })).toEqual({
                enabled: false,
                reason: 'aws_config_invalid',
                invalid: ['EZIL_AWS_MAX_RUNNING_US_EAST_1'],
            });
        });

        it('tiers: free is 2 vCPU / 4 GiB burstable first, plus is 2 vCPU / 8 GiB; unknown tiers never get a default', () => {
            expect(AWS_TIERS).toEqual({ free: ['t3a.medium', 't3.medium'], plus: ['m6i.large'], compute4: ['m6i.xlarge'], compute8: ['m6i.2xlarge'] });
            expect(instanceTypeForTier('free')).toBe('t3a.medium');
            expect(instanceTypeForTier('plus')).toBe('m6i.large');
            for (const t of ['premium', '', 'toString', '__proto__', 'constructor', null, undefined]) {
                expect(isAwsTier(t)).toBe(false);
                expect(() => instanceTypeForTier(t as never)).toThrow('aws_tier_invalid');
            }
        });
    });

    describe('decideAdmission with a region plan (pure)', () => {
        const cfg = (ap: number, us: number) => readAwsAdmissionConfig({ ...TWO, AWS_MAX_RUNNING: '50', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: String(ap), EZIL_AWS_MAX_RUNNING_US_EAST_1: String(us) });
        const decide = (c: AwsAdmissionConfig, region: RegionPlan, counters: Partial<typeof empty> & RegionalCounters = {}) =>
            decideAdmission({ config: c, counters: { ...empty, ...counters }, userId: U1, now: NOW, region, instanceType: 'm6i.large' });

        it('create picks the first region in order with room', () => {
            expect(decide(cfg(2, 2), { kind: 'create' })).toEqual({ admit: true, region: 'ap-south-1' });
            expect(decide(cfg(0, 2), { kind: 'create' })).toEqual({ admit: true, region: 'us-east-1' });
            expect(decide(cfg(2, 2), { kind: 'create' }, { runningCount: 2 })).toMatchObject({ admit: false, reason: 'region_capacity' });
            expect(decide(cfg(0, 0), { kind: 'create' })).toMatchObject({ admit: false, reason: 'region_capacity' });
        });

        it('without exact per-region counts the global count bounds every region (never over-admits)', () => {
            // One computer runs somewhere: with AP cap 1 the global count fills AP even if that computer is in the US.
            expect(decide(cfg(1, 5), { kind: 'create' }, { runningCount: 1 })).toEqual({ admit: true, region: 'us-east-1' });
            // Exact counts, when supplied, are used instead.
            expect(decide(cfg(1, 5), { kind: 'create' }, { runningCount: 1, runningByRegion: { 'ap-south-1': 0, 'us-east-1': 1 } })).toEqual({ admit: true, region: 'ap-south-1' });
            expect(decide(cfg(1, 1), { kind: 'create' }, { runningCount: 1, runningByRegion: { 'ap-south-1': 1, 'us-east-1': 1 } })).toMatchObject({ reason: 'region_capacity' });
        });

        it('lease stays in its home region: full home refuses even when another region has room', () => {
            expect(decide(cfg(2, 2), { kind: 'lease', region: 'us-east-1' })).toEqual({ admit: true, region: 'us-east-1' });
            expect(decide(cfg(0, 5), { kind: 'lease', region: 'ap-south-1' })).toMatchObject({ admit: false, reason: 'region_capacity' });
            expect(decide(cfg(2, 2), { kind: 'lease', region: 'eu-west-1' })).toMatchObject({ admit: false, reason: 'region_not_configured' });
            expect(decide(cfg(2, 2), { kind: 'lease', region: null })).toMatchObject({ admit: false, reason: 'region_not_configured' });
        });

        it('region refusals rank after the global caps and are listed with them', () => {
            expect(decide(cfg(0, 0), { kind: 'create' }, { runningCount: 50 })).toMatchObject({ reason: 'max_running', reasons: ['max_running', 'region_capacity'] });
        });
    });

    describe('runAdmission across regions (transactional)', () => {
        it('Mumbai full → a new computer is created in the US with the tier type; both full → refused, nothing written', async () => {
            const env = { ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0' };
            const { db, placements } = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }] });
            const r = await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free', fields: { region: 'ap-south-1', instanceType: 'c6i.xlarge' } }, deps2(env));
            expect(r).toMatchObject({ admitted: true, placement: { region: 'us-east-1', instanceType: 't3a.medium', state: 'PROVISIONING' } });
            const full = await runAdmission(db, { kind: 'create', userId: U2, computerId: C2, tier: 'plus' }, deps2({ ...env, EZIL_AWS_MAX_RUNNING_US_EAST_1: '1' }));
            expect(full).toMatchObject({ admitted: false, reason: 'region_capacity' });
            expect(placements).toHaveLength(1);
        });

        it('plus tier records the 8 GiB type', async () => {
            const { db } = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }] });
            expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'plus' }, deps2(TWO))).toMatchObject({
                admitted: true,
                placement: { region: 'ap-south-1', instanceType: 'm6i.large' },
            });
        });

        it('a wake never hops regions: home region full or unconfigured refuses and the placement is unchanged', async () => {
            const seed = () =>
                createFakePlacementDb({
                    // Mumbai (home) holds one running computer; the US has room. A full home must refuse, not hop.
                    placements: [placementRow({ instance_type: 'm6i.large', computer_id: C1, region: 'ap-south-1' }), placementRow({ instance_type: 'm6i.large', computer_id: C3, owner_user_id: U3, state: 'RUNNING', region: 'ap-south-1' })],
                    computers: [{ id: C1, user_id: U1 }, { id: C3, user_id: U3 }],
                });
            const lease = { kind: 'lease', userId: U1, computerId: C1, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date(NOW.getTime() + 3_600_000) } as const;
            const a = seed();
            expect(await runAdmission(a.db, lease, deps2({ ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '9' }))).toMatchObject({
                admitted: false,
                reason: 'region_capacity',
            });
            expect(a.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0, region: 'ap-south-1' });
            const b = seed();
            expect(await runAdmission(b.db, lease, deps2({ ...ENV, AWS_REGIONS: 'us-east-1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '9' }))).toMatchObject({
                admitted: false,
                reason: 'region_not_configured',
            });
            expect(b.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
            const c = seed();
            expect(await runAdmission(c.db, lease, deps2({ ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2' }))).toMatchObject({
                admitted: true,
                placement: { state: 'LEASED', region: 'ap-south-1' },
            });
        });

        it('exact per-region counts: Mumbai full while the US is empty admits into the US although the GLOBAL count is at Mumbai\'s cap', async () => {
            const { db, placements } = createFakePlacementDb({
                placements: [placementRow({ instance_type: 'm6i.large', computer_id: C3, owner_user_id: U3, state: 'RUNNING', region: 'ap-south-1' })],
                computers: [{ id: C1, user_id: U1 }, { id: C3, user_id: U3 }],
            });
            const r = await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps2({ ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '1' }));
            expect(r).toMatchObject({ admitted: true, placement: { region: 'us-east-1' } });
            expect(placements).toHaveLength(2);
        });

        it('a running row in another region does not fill this one, and a STOPPED row fills none', async () => {
            const { db } = createFakePlacementDb({
                placements: [
                    placementRow({ instance_type: 'm6i.large', computer_id: C3, owner_user_id: U3, state: 'RUNNING', region: 'us-east-1' }),
                    placementRow({ instance_type: 'm6i.large', computer_id: C2, owner_user_id: U2, state: 'STOPPED', region: 'ap-south-1' }),
                ],
                computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }, { id: C3, user_id: U3 }],
            });
            const r = await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps2({ ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '1' }));
            expect(r).toMatchObject({ admitted: true, placement: { region: 'ap-south-1' } });
        });

        it('a running row WITHOUT a region counts against every region (safe direction)', async () => {
            const { db, placements } = createFakePlacementDb({
                placements: [placementRow({ instance_type: 'm6i.large', computer_id: C3, owner_user_id: U3, state: 'RUNNING', region: null })],
                computers: [{ id: C1, user_id: U1 }, { id: C3, user_id: U3 }],
            });
            const r = await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'free' }, deps2({ ...TWO, EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1', EZIL_AWS_MAX_RUNNING_US_EAST_1: '1' }));
            expect(r).toMatchObject({ admitted: false, reason: 'region_capacity' });
            expect(placements).toHaveLength(1);
        });

        it('a legacy aws-ec2 row without a region is not leased', async () => {
            const { db, placements } = createFakePlacementDb({ placements: [placementRow({ instance_type: 'm6i.large', computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
            const lease = { kind: 'lease', userId: U1, computerId: C1, expected: { generation: 1, leaseEpoch: 0 }, leaseUntil: new Date(NOW.getTime() + 3_600_000) } as const;
            expect(await runAdmission(db, lease, deps2(TWO))).toMatchObject({ admitted: false, reason: 'region_not_configured' });
            expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
        });

        it('an unknown tier refuses before a single statement', async () => {
            const { db, statements } = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }] });
            expect(await runAdmission(db, { kind: 'create', userId: U1, computerId: C1, tier: 'premium' as never }, deps2(TWO))).toMatchObject({
                admitted: false,
                reason: 'aws_tier_invalid',
            });
            expect(statements).toEqual([]);
        });
    });
});
