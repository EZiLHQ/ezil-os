/**
 * The reverse move's export-boot claim (REVERSE-MOVE-CONTRACT §5.1.1): one admission transaction, admission lock →
 * computer lock → counters → the placement → decideAdmission minus the user's own caps → the fleet's move cap → the
 * replace lease → the reverse write, against the fake database (real mutex locks, CAS parsed from the SQL text).
 */

import { sql, type SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { admitExportBoot } from './admission';
import { createFakePlacementDb, placementRow, type Row } from './fake-placement-db.test-support';
import type { Placement, PlacementDb, PlacementExecutor } from './placement';
import { REVERSE_MOVE_MAX_ACTIVE } from './provider-reverse-store';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const JOB = '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f';
const FENCE = 'fefefefe-fefe-4efe-8efe-fefefefefefe';
const NOW = new Date('2026-10-13T12:00:00Z');
const ENV = {
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    AWS_MAX_RUNNING: '2',
    EZIL_AWS_USER_MONTHLY_HOURS: '1',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    // The user's egress cap is already reached at 0 bytes: a Free user's own allowance must never block the move.
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '0',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
};
const deps = { env: ENV, now: () => NOW };
/** A held Free computer: STOPPED at N = 4, E = 7, its own region and Free type. */
const held = (over: Partial<Row> = {}) => placementRow({ computer_id: C1, owner_user_id: U1, generation: 4, lease_epoch: 7, state: 'STOPPED',
    region: 'ap-south-1', zone_id: 'aps1-az1', instance_type: 't3a.medium', instance_id: 'i-0123456789abcdef0', volume_id: 'vol-0b1ffbc8f8cfa6384',
    fs_uuid: 'abababab-abab-4bab-8bab-abababababab', fence_token: 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd', last_error: 'instance_lost', ...over });
const fields = { fenceToken: FENCE, enrollNonceHash: 'a'.repeat(64), enrollExpiresAt: new Date(NOW.getTime() + 600_000), enrollConsumedHash: null,
    lifecycleJobId: JOB, lifecycleDigest: 'b'.repeat(64), lastError: null };
const input = (over: Partial<Parameters<typeof admitExportBoot>[1]> = {}) => ({ userId: U1, computerId: C1, expected: { generation: 4, leaseEpoch: 7 },
    leaseUntil: new Date(NOW.getTime() + 200 * 60_000), fields, ...over });

/** The fake database plus the two reverse-table statements of the claim, answered here and recorded in its log. */
function claimDb(seed: Parameters<typeof createFakePlacementDb>[0], hostBound = 0) {
    const fake = createFakePlacementDb(seed, { clock: () => NOW });
    const dialect = new PgDialect();
    const wrap = (x: PlacementExecutor): PlacementExecutor => ({ execute: async (q: SQL) => {
        const { sql: text, params } = dialect.sqlToQuery(q);
        if (text.includes('reverse:')) {
            fake.statements.push({ sql: text, params, tx: null });
            if (text.includes('reverse:count-host-bound')) {
                expect(text).toMatch(/WHERE state IN \(\$1, \$2, \$3, \$4, \$5\)/);
                expect(params).toEqual(['booting', 'exporting', 'copying', 'checking', 'flipping']);
                return { rows: [{ n: hostBound }] };
            }
            return { rows: [] };
        }
        return x.execute(q);
    } });
    const db: PlacementDb = { execute: q => wrap(fake.db).execute(q), transaction: fn => fake.db.transaction(tx => fn(wrap(tx))) };
    return { ...fake, db };
}
const record = vi.fn(async (tx: PlacementExecutor) => { await tx.execute(sql`/* reverse:record-export-boot */ SELECT 1`); });
const seed = (over: Partial<Row> = {}, extra: Partial<Parameters<typeof createFakePlacementDb>[0]> = {}) =>
    ({ placements: [held(over)], computers: [{ id: C1, user_id: U1 }], ...extra });

describe('admitExportBoot (REVERSE-MOVE-CONTRACT §5.1.1)', () => {
    it('disabled config refuses without a single statement', async () => {
        const { db, statements } = claimDb(seed());
        expect(await admitExportBoot(db, input(), record, { env: {}, now: () => NOW })).toMatchObject({ admitted: false, reason: 'aws_disabled' });
        expect(statements).toEqual([]);
    });

    it('pins the order: admission lock, computer lock, counters, placement, move cap, the replace CAS, then the reverse write; one transaction', async () => {
        const { db, statements, placements } = claimDb(seed());
        let leasedSeen: Placement | null = null;
        const r = await admitExportBoot(db, input(), async (tx, leased) => { leasedSeen = leased; await record(tx); }, deps);
        expect(r).toMatchObject({ admitted: true, placement: { state: 'LEASED', generation: 5, leaseEpoch: 8 } });
        const tags = statements.map(s => s.sql === 'BEGIN' || s.sql === 'COMMIT' ? s.sql : s.sql.match(/(placement|reverse):([a-z-]+)/)?.[0] ?? s.sql.slice(0, 30))
            .filter(t => t !== 'placement:image-reservation');
        expect(tags).toEqual(['BEGIN', 'placement:lock-admission', 'placement:lock-computer',
            'placement:computer-owner', 'placement:read', 'placement:usage-foreign', 'placement:count-running', 'placement:count-running-region',
            'placement:count-user', 'placement:count-demand', 'placement:duplicates', 'placement:usage-month',
            'placement:read', 'reverse:count-host-bound', 'placement:read', 'placement:read', 'placement:cas',
            'reverse:record-export-boot', 'COMMIT']);
        // The export boot keeps the placement's own type and region; a replace clears the instance; the boot's fields land in the CAS.
        expect(leasedSeen).toMatchObject({ state: 'LEASED', generation: 5, leaseEpoch: 8, instanceType: 't3a.medium', region: 'ap-south-1',
            instanceId: null, volumeId: 'vol-0b1ffbc8f8cfa6384', fenceToken: FENCE, lifecycleJobId: JOB, lifecycleDigest: 'b'.repeat(64), lastError: null });
        expect(placements[0]).toMatchObject({ state: 'LEASED', generation: 5, lease_epoch: 8, instance_type: 't3a.medium' });
    });

    it('the user\'s own hours and egress caps never block the move; every capacity cap still does', async () => {
        const usage = [{ computer_id: C1, user_id: U1, instance_type: 't3a.medium', started_at: new Date(NOW.getTime() - 50 * 3_600_000), stopped_at: NOW, egress_bytes: null }];
        expect(await admitExportBoot(claimDb(seed({}, { usage })).db, input(), record, deps)).toMatchObject({ admitted: true });
        expect(await admitExportBoot(claimDb(seed({}, { usage })).db, input(), record, { env: { ...ENV, EZIL_AWS_GLOBAL_MONTHLY_HOURS: '10' }, now: () => NOW }))
            .toMatchObject({ admitted: false, reason: 'global_hours_cap' });
        const busy = claimDb({ placements: [held(), placementRow({ computer_id: C2, owner_user_id: U2, state: 'RUNNING', region: 'ap-south-1', instance_type: 'm6i.large' }),
            placementRow({ computer_id: 'c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3', owner_user_id: U2, state: 'RUNNING', region: 'ap-south-1', instance_type: 'm6i.large' })],
        computers: [{ id: C1, user_id: U1 }] });
        const refused = await admitExportBoot(busy.db, input(), record, deps);
        expect(refused).toMatchObject({ admitted: false, reason: 'max_running' });
        expect(refused.admitted || refused.reasons).not.toContain('user_egress_cap');
        expect(busy.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 7 });
    });

    it('the kill switch refuses the claim', async () => {
        expect(await admitExportBoot(claimDb(seed()).db, input(), record, { env: { ...ENV, EZIL_AWS_KILL_SWITCH: '1' }, now: () => NOW }))
            .toMatchObject({ admitted: false, reason: 'kill_switch' });
    });

    it(`move_capacity at ${REVERSE_MOVE_MAX_ACTIVE} rows past requested (step 5b), before any ticket or write`, async () => {
        expect(REVERSE_MOVE_MAX_ACTIVE).toBe(3);
        const full = claimDb(seed(), 3);
        expect(await admitExportBoot(full.db, input(), record, deps)).toEqual({ admitted: false, reason: 'move_capacity' });
        expect(full.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 7 });
        expect(full.statements.some(s => /placement:cas/.test(s.sql))).toBe(false);
        expect(await admitExportBoot(claimDb(seed(), 2).db, input(), record, deps)).toMatchObject({ admitted: true });
    });

    it('region_missing for a null or invalid region, before decideAdmission (never region_not_configured)', async () => {
        for (const region of [null, 'mumbai', 'xx-nowhere-9']) {
            const fake = claimDb(seed({ region }));
            expect(await admitExportBoot(fake.db, input(), record, deps), String(region)).toEqual({ admitted: false, reason: 'region_missing' });
            expect(fake.placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 7 });
        }
        // A valid region the deployment does not configure is the deployment-wide wait, not this computer's fault.
        expect(await admitExportBoot(claimDb(seed({ region: 'us-east-1' })).db, input(), record, deps))
            .toMatchObject({ admitted: false, reason: 'region_not_configured' });
    });

    it('a placement that is not this owner\'s STOPPED aws-ec2 row at N/E with no job is cas_conflict, and nothing is written', async () => {
        const cases: [string, Partial<Row>, Partial<Parameters<typeof admitExportBoot>[1]>][] = [
            ['running', { state: 'RUNNING' }, {}],
            ['job pending', { lifecycle_job_id: JOB }, {}],
            ['moved generation', {}, { expected: { generation: 3, leaseEpoch: 7 } }],
            ['moved epoch', {}, { expected: { generation: 4, leaseEpoch: 6 } }],
            ['cloudflare', { provider: 'cloudflare', workspace_store: 'r2' }, {}],
            ['another owner', { owner_user_id: U2 }, {}],
        ];
        for (const [name, over, ask] of cases) {
            const fake = claimDb(seed(over));
            expect(await admitExportBoot(fake.db, input(ask), record, deps), name).toEqual({ admitted: false, reason: 'cas_conflict' });
            expect(fake.statements.some(s => /placement:cas|reverse:record/.test(s.sql)), name).toBe(false);
        }
    });

    it('an image reservation (ImageJobConflictError) is cas_conflict, rolled back, never a throw (§5.2.1)', async () => {
        const fake = claimDb(seed({ image_upgrade_job_id: JOB }));
        expect(await admitExportBoot(fake.db, input(), record, deps)).toEqual({ admitted: false, reason: 'cas_conflict' });
        expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK');
        expect(fake.placements[0]).toMatchObject({ state: 'STOPPED', generation: 4, lease_epoch: 7 });
    });

    it('a throw from the reverse write (lost_race) rolls the lease back and propagates', async () => {
        const fake = claimDb(seed());
        await expect(admitExportBoot(fake.db, input(), async () => { throw new Error('reverse_move_conflict:lost_race'); }, deps))
            .rejects.toThrow('reverse_move_conflict:lost_race');
        expect(fake.statements.at(-1)?.sql).toBe('ROLLBACK');
        expect(fake.placements[0]).toMatchObject({ state: 'STOPPED', generation: 4, lease_epoch: 7, lifecycle_job_id: null });
    });

    it('user_has_aws_computer passes for this computer and refuses only another AWS computer of the user', async () => {
        expect(await admitExportBoot(claimDb(seed()).db, input(), record, deps)).toMatchObject({ admitted: true });
        const two = claimDb({ placements: [held(), placementRow({ computer_id: C2, owner_user_id: U1, state: 'STOPPED', region: 'ap-south-1' })],
            computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U1 }] });
        expect(await admitExportBoot(two.db, input(), record, deps)).toMatchObject({ admitted: false, reason: 'user_has_aws_computer' });
    });

    it('a computer that is not the caller\'s, or deleted, is refused (computer_not_owned / computer_deleted)', async () => {
        expect(await admitExportBoot(claimDb({ placements: [held()], computers: [{ id: C1, user_id: U2 }] }).db, input(), record, deps))
            .toMatchObject({ admitted: false, reason: 'computer_not_owned' });
        expect(await admitExportBoot(claimDb({ placements: [held()], computers: [{ id: C1, user_id: U1, deleted_at: NOW }] }).db, input(), record, deps))
            .toMatchObject({ admitted: false, reason: 'computer_deleted' });
    });
});
