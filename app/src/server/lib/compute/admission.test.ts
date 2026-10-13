/**
 * AWS admission (docs/AWS-COMPUTERS.md C-3, §4). Pure decision first, then
 * the transactional path against the fake database (real mutex locks, CAS
 * parsed from the SQL text).
 */

import { describe, expect, it } from 'vitest';

import { decideAdmission, runAdmission } from './admission';
import { AWS_CAP_ENV, readAwsAdmissionConfig, type AwsAdmissionConfig } from './aws-config';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import type { AdmissionCounters } from './placement';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const C3 = 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3';
const NOW = new Date('2026-10-13T12:00:00Z');
const GB = 1_000_000_000;

const ENV = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    AWS_MAX_RUNNING: '2',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
};
const config = readAwsAdmissionConfig(ENV);
const empty: Pick<AdmissionCounters, 'runningCount' | 'userOtherAwsComputers' | 'duplicates' | 'usage'> = { runningCount: 0, userOtherAwsComputers: 0, duplicates: [], usage: [] };
const hoursRow = (userId: string, hours: number, egressBytes: number | null = 0) => ({
    computerId: C3,
    userId,
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
        });
    });

    it.each(Object.values(AWS_CAP_ENV).flatMap((name) => [undefined, '', 'NaN', '-1', '1.5', ' 2', '1e3', 'two'].map((v) => [name, v] as const)))(
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
    const decide = (counters: Partial<typeof empty> = {}, cfg: AwsAdmissionConfig = config) =>
        decideAdmission({ config: cfg, counters: { ...empty, ...counters }, userId: U1, now: NOW });

    it('admits under every cap', () => {
        expect(decide({ runningCount: 1, usage: [hoursRow(U1, 99, 49 * GB), hoursRow(U2, 400, 100 * GB)] })).toEqual({ admit: true });
    });

    it.each([
        ['disabled', {}, readAwsAdmissionConfig({}), 'aws_disabled'],
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
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: true, placement: { state: 'LEASED', leaseEpoch: 1 } });
        const sqls = statements.map((s) => s.sql);
        expect(sqls[0]).toBe('BEGIN');
        expect(sqls[1]).toMatch(/SELECT pg_advisory_xact_lock\(\$1::int4, 0\)/);
        expect(sqls.slice(2, 6).map((s) => s.match(/placement:([a-z-]+)/)?.[1])).toEqual(['count-running', 'count-user', 'duplicates', 'usage-month']);
        expect(sqls[6]).toMatch(/placement:cas/);
        expect(sqls[7]).toBe('COMMIT');
        expect(sqls).not.toContainEqual(expect.stringMatching(/set transaction|isolation/i));
    });

    it('the counter SQL counts running-class aws-ec2 rows and the user\'s other aws-ec2 rows, soft-deleted included', async () => {
        const { db, statements } = createFakePlacementDb({ placements: [placementRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        await runAdmission(db, lease(U1, C1), deps);
        const running = statements.find((s) => /count-running/.test(s.sql))!;
        expect(running.sql).toMatch(/provider = 'aws-ec2' AND state IN \(/);
        expect(running.params).toContain('UNCONFIRMED');
        expect(running.params).not.toContain('STOPPED');
        const user = statements.find((s) => /count-user/.test(s.sql))!;
        expect(user.sql).toMatch(/JOIN public\.ezil_computers c ON c\.id = p\.computer_id/);
        expect(user.sql).not.toMatch(/deleted_at/);
        expect(user.sql).toMatch(/p\.computer_id <> \$2::uuid AND p\.state <> 'PURGE_ELIGIBLE'/);
    });

    it('two concurrent admissions at the running cap: exactly one winner', async () => {
        // AWS_MAX_RUNNING=2, one computer already RUNNING: one slot left, two contenders.
        const { db, placements } = createFakePlacementDb({
            placements: [placementRow({ computer_id: C3, state: 'RUNNING' }), placementRow({ computer_id: C1 }), placementRow({ computer_id: C2 })],
            computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }, { id: C3, user_id: U3 }],
        });
        const results = await Promise.all([runAdmission(db, lease(U1, C1), deps), runAdmission(db, lease(U2, C2), deps)]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ admitted: false, reason: 'max_running' });
        expect(placements.filter((p) => p.state === 'LEASED')).toHaveLength(1);
    });

    it('two concurrent leases of the same computer: exactly one winner, the loser sees cas_conflict', async () => {
        const { db, placements } = createFakePlacementDb({ placements: [placementRow({ computer_id: C1 })], computers: [{ id: C1, user_id: U1 }] });
        const results = await Promise.all([runAdmission(db, lease(U1, C1), deps), runAdmission(db, lease(U1, C1), deps)]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ reason: 'cas_conflict' });
        expect(placements[0]).toMatchObject({ state: 'LEASED', lease_epoch: 1 });
    });

    it('one AWS computer per user, even when the other computer is soft-deleted', async () => {
        const { db } = createFakePlacementDb({
            placements: [placementRow({ computer_id: C1 }), placementRow({ computer_id: C2, state: 'RETIRED' })],
            computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U1 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'user_has_aws_computer' });
    });

    it('two concurrent creates for one user: exactly one AWS placement', async () => {
        const { db, placements } = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U1 }] });
        const results = await Promise.all([
            runAdmission(db, { kind: 'create', userId: U1, computerId: C1 }, deps),
            runAdmission(db, { kind: 'create', userId: U1, computerId: C2 }, deps),
        ]);
        expect(results.filter((r) => r.admitted)).toHaveLength(1);
        expect(results.find((r) => !r.admitted)).toMatchObject({ reason: 'user_has_aws_computer' });
        expect(placements).toHaveLength(1);
        expect(placements[0]).toMatchObject({ provider: 'aws-ec2', workspace_store: 'ebs', state: 'PROVISIONING', generation: 1, lease_epoch: 0 });
    });

    it('usage from the ledger closes admission at the hours cap (open row counted to now)', async () => {
        const { db } = createFakePlacementDb({
            placements: [placementRow({ computer_id: C1 })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C1, user_id: U1, started_at: new Date(NOW.getTime() - 100 * 3_600_000), stopped_at: null, egress_bytes: null }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'user_hours_cap' });
    });

    it('duplicate placements anywhere close admission', async () => {
        const { db } = createFakePlacementDb({
            placements: [placementRow({ computer_id: C1 }), placementRow({ computer_id: C2 }), placementRow({ computer_id: C2 })],
            computers: [{ id: C1, user_id: U1 }],
        });
        expect(await runAdmission(db, lease(U1, C1), deps)).toMatchObject({ admitted: false, reason: 'duplicate_placement' });
    });
});
