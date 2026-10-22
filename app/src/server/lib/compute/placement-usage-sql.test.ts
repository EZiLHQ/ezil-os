/**
 * The admission usage read totals IN THE DATABASE (Codex 4278276853): one row per
 * user, never the month's ledger, with exactly usage.ts's arithmetic.
 *
 * - Always: the statement aggregates (SUM … GROUP BY user) and selects no per-run
 *   column, and many runs of one user come back as ONE total.
 * - With EZIL_PG_TEST_URL (a disposable Postgres): the SQL totals equal
 *   `monthUsageFromRows` on a mixed fixture (open runs, month-boundary runs, NULL and
 *   non-NULL egress, runs outside the month).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readMonthUsage, peekAdmissionCounters, type PlacementExecutor } from './placement';
import { monthUsageFromRows, utcMonthStart, type MonthUsage } from './usage';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const MONTH = utcMonthStart(NOW);
const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const U3 = '33333333-3333-4333-8333-333333333333';
const C = (n: number) => `c${String(n).padStart(7, '0')}-cccc-4ccc-8ccc-cccccccccccc`;
const at = (iso: string) => new Date(iso);

/** Mixed fixture: open runs, runs across the month start, NULL/non-NULL egress, runs outside the month. */
const FIXTURE = [
    { computer_id: C(1), user_id: U1, instance_type: 'm6i.2xlarge', started_at: at('2026-10-15T09:30:00.000Z'), stopped_at: null, egress_bytes: 5 },
    { computer_id: C(1), user_id: U1, instance_type: 'm6i.2xlarge', started_at: at('2026-10-02T00:00:00.000Z'), stopped_at: at('2026-10-02T03:15:30.250Z'), egress_bytes: null },
    { computer_id: C(2), user_id: U1, instance_type: 'm6i.xlarge', started_at: at('2026-09-30T22:00:00.000Z'), stopped_at: at('2026-10-01T01:00:00.000Z'), egress_bytes: 1_000 },
    { computer_id: C(3), user_id: U2, instance_type: 'unknown', started_at: at('2026-09-29T00:00:00.000Z'), stopped_at: null, egress_bytes: 7 },
    { computer_id: C(4), user_id: U2, instance_type: 'm6i.large', started_at: at('2026-09-01T00:00:00.000Z'), stopped_at: at('2026-09-02T00:00:00.000Z'), egress_bytes: 99 },
    { computer_id: C(5), user_id: U3, instance_type: 'm6i.large', started_at: at('2026-10-15T12:30:00.000Z'), stopped_at: null, egress_bytes: 3 },
    { computer_id: C(6), user_id: U3, instance_type: 'c6i.xlarge', started_at: at('2026-10-10T08:00:00.000Z'), stopped_at: at('2026-10-10T08:00:00.000Z'), egress_bytes: 0 },
    { computer_id: C(7), user_id: U3, instance_type: 'm6i.large', started_at: at('2026-10-15T11:00:00.100Z'), stopped_at: null, egress_bytes: 0 },
    { computer_id: C(8), user_id: U3, instance_type: 'c6i.xlarge', started_at: at('2026-09-30T23:59:59.100Z'), stopped_at: at('2026-10-01T00:00:01.999Z'), egress_bytes: 0 },
    { computer_id: C(9), user_id: U3, instance_type: 'm6i.large', started_at: at('2026-10-15T11:00:00.000Z'), stopped_at: at('2026-10-15T11:00:00.999Z'), egress_bytes: 0 },
];

const reference = (): MonthUsage => monthUsageFromRows(FIXTURE.map((r) => ({
    computerId: r.computer_id, userId: r.user_id, instanceType: r.instance_type, startedAt: r.started_at, stoppedAt: r.stopped_at, egressBytes: r.egress_bytes,
})), NOW);

const plain = (m: MonthUsage) => ({ global: m.global, byUser: Object.fromEntries([...m.byUser].sort(([a], [b]) => a.localeCompare(b))) });

describe('readMonthUsage totals in the database', () => {
    it('aggregates per user in SQL and selects no per-run column', async () => {
        const { db, statements } = createFakePlacementDb({ usage: FIXTURE });
        await readMonthUsage(db, NOW, MONTH);
        const text = statements.find((s) => s.sql.includes('placement:usage-month'))!.sql;
        expect(text).toMatch(/SUM\(/);
        expect(text).toMatch(/SUM\(FLOOR\(/);
        expect(text).toMatch(/CASE u\.instance_type/);
        expect(text).toContain('AS weighted_seconds');
        expect(text).toMatch(/GROUP BY u\.user_id/);
        expect(text).not.toMatch(/SELECT[^;]*\bu\.started_at\s+AS\b/);
        expect(text).not.toMatch(/\bcomputer_id\b[^;]*\bFROM\b/);
    });

    it('many runs of one user come back as ONE total (bounded by users, not by wake cycles)', async () => {
        const runs = Array.from({ length: 500 }, (_, i) => ({
            computer_id: C(1), user_id: U1, instance_type: 'm6i.large',
            started_at: new Date(MONTH.getTime() + i * 60_000), stopped_at: new Date(MONTH.getTime() + i * 60_000 + 30_000), egress_bytes: 1,
        }));
        const { db } = createFakePlacementDb({ usage: runs });
        const usage = await readMonthUsage(db, NOW, MONTH);
        expect(usage.byUser.size).toBe(1);
        expect(usage.byUser.get(U1)).toEqual({ hours: (500 * 30) / 3_600, weightedSeconds: 15_000, egressBytes: 500 });
        expect(usage.global).toEqual(usage.byUser.get(U1));
    });

    it('a malformed aggregate fails closed, naming the field', async () => {
        const db: PlacementExecutor = { execute: async () => ({ rows: [{ user_id: U1, seconds: '1e3', egress_bytes: '0' }] }) };
        await expect(readMonthUsage(db, NOW, MONTH)).rejects.toThrow(/seconds/);
        const dup: PlacementExecutor = { execute: async () => ({ rows: [{ user_id: U1, seconds: '1', weighted_seconds: '1', egress_bytes: '0' }, { user_id: U1, seconds: '1', weighted_seconds: '1', egress_bytes: '0' }] }) };
        await expect(readMonthUsage(dup, NOW, MONTH)).rejects.toThrow(/user_id/);
    });

    it.each([undefined, '-1', '1.5', 'NaN', '9007199254740992'])('invalid weighted_seconds %j fails closed', async weighted_seconds => {
        const db: PlacementExecutor = { execute: async () => ({ rows: [{ user_id: U1, seconds: '1', weighted_seconds, egress_bytes: '0' }] }) };
        await expect(readMonthUsage(db, NOW, MONTH)).rejects.toThrow(/weighted_seconds/);
    });
});

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `placement_usage_test_${randomUUID().replaceAll('-', '')}`;

describe.skipIf(!PG)('readMonthUsage on real Postgres equals usage.ts arithmetic', () => {
    const client = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const db: PlacementExecutor = { execute: async q => {
        const rendered = dialect.sqlToQuery(q);
        return client!.unsafe(local(rendered.sql), rendered.params as never[]);
    } };
    let created = false;
    afterAll(async () => {
        try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); }
        finally { await client?.end(); }
    });

    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Capacity includes in-flight migrations as well as placements. Install
        // both contracts locally; never depend on or drop another suite's tables.
        for (const file of ['../../../../../docs/aws-computers/sql/0001_compute_placement.sql.txt', '../../../../drizzle/0006_compute_migrations.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, file), 'utf8')));
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_placements, ${schema}.ezil_compute_usage, ${schema}.ezil_compute_migrations`);
    });

    it('SQL totals equal monthUsageFromRows on a mixed fixture', async () => {
        for (const r of FIXTURE) {
            await client!`INSERT INTO ${client!(schema)}.ezil_compute_usage (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, egress_bytes, observed_by, updated_at)
                VALUES (${r.computer_id}::uuid, ${r.user_id}::uuid, 'i-x', ${r.instance_type}, ${r.started_at.toISOString()}::timestamptz,
                    ${r.stopped_at ? r.stopped_at.toISOString() : null}::timestamptz, ${r.egress_bytes}, 'test', now())`;
        }
        const got = plain(await readMonthUsage(db, NOW, MONTH));
        const want = plain(reference());
        expect(Object.keys(got.byUser)).toEqual(Object.keys(want.byUser));
        for (const [user, t] of Object.entries(want.byUser)) {
            expect(got.byUser[user]!.hours).toBeCloseTo(t.hours, 9);
            expect(got.byUser[user]!.weightedSeconds).toBe(t.weightedSeconds);
            expect(got.byUser[user]!.egressBytes).toBe(t.egressBytes);
        }
        expect(got.global.hours).toBeCloseTo(want.global.hours, 9);
        expect(got.global.weightedSeconds).toBe(want.global.weightedSeconds);
        expect(got.global.egressBytes).toBe(want.global.egressBytes);
    });

    it('running counter SQL sums mixed types globally, per region and unplaced', async () => {
        const rows = [
            placementRow({ computer_id: C(1), state: 'RUNNING', region: 'ap-south-1', instance_type: 'm6i.large' }),
            placementRow({ computer_id: C(2), state: 'LEASED', region: 'ap-south-1', instance_type: 'm6i.xlarge' }),
            placementRow({ computer_id: C(3), state: 'UNCONFIRMED', region: 'us-east-1', instance_type: 'm6i.2xlarge' }),
            placementRow({ computer_id: C(4), state: 'STOPPING', region: null, instance_type: 'unknown' }),
            placementRow({ computer_id: C(5), state: 'PROVISIONING', region: null, instance_type: null }),
            placementRow({ computer_id: C(6), state: 'STOPPED', region: 'ap-south-1', instance_type: 'm6i.2xlarge' }),
            placementRow({ computer_id: C(7), state: 'RUNNING', provider: 'cloudflare', workspace_store: 'r2' }),
            placementRow({ computer_id: C(8), state: 'STARTING', region: 'us-east-1', instance_type: 'c6i.xlarge' }),
        ];
        // Use the same production counter statements captured by the fake, then
        // execute them on PG: this checks the SQL independently of the fake's sums.
        const fake = createFakePlacementDb({ placements: rows });
        const expected = await peekAdmissionCounters(fake.db, { userId: U1, computerId: C(1), now: NOW, monthStart: MONTH });
        for (const row of rows) {
            await client!`INSERT INTO ${client!(schema)}.ezil_computer_placements
                (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, instance_type, updated_at)
                VALUES (${String(row.computer_id)}::uuid, ${U1}::uuid, ${String(row.provider)}, ${String(row.workspace_store)}, 1, 0,
                    ${String(row.state)}, ${row.region as string | null}, ${row.instance_type as string | null}, now())`;
        }
        const statements = fake.statements.filter(s => /placement:count-running(?:-region)? \*\//.test(s.sql));
        expect(statements).toHaveLength(2);
        const global = await client!.unsafe(local(statements[0]!.sql), statements[0]!.params.map(String));
        expect(global.map(r => ({ n: Number(r.n), vcpu: Number(r.vcpu) }))).toEqual([{ n: 6, vcpu: 34 }]);
        expect(expected).toMatchObject({ runningCount: 6, runningVcpu: 34, runningUnplaced: 2, runningVcpuUnplaced: 16 });
        const regional = await client!.unsafe(local(statements[1]!.sql), statements[1]!.params.map(String));
        expect(Object.fromEntries(regional.map(r => [r.region ?? 'unplaced', [Number(r.n), Number(r.vcpu)]]))).toEqual({
            'ap-south-1': [2, 6], 'us-east-1': [2, 12], unplaced: [2, 16],
        });
    });
});
