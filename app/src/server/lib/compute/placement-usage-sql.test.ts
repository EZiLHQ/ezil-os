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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { createFakePlacementDb } from './fake-placement-db.test-support';
import { readMonthUsage, type PlacementExecutor } from './placement';
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
    { computer_id: C(1), user_id: U1, started_at: at('2026-10-15T09:30:00.000Z'), stopped_at: null, egress_bytes: 5 },
    { computer_id: C(1), user_id: U1, started_at: at('2026-10-02T00:00:00.000Z'), stopped_at: at('2026-10-02T03:15:30.250Z'), egress_bytes: null },
    { computer_id: C(2), user_id: U1, started_at: at('2026-09-30T22:00:00.000Z'), stopped_at: at('2026-10-01T01:00:00.000Z'), egress_bytes: 1_000 },
    { computer_id: C(3), user_id: U2, started_at: at('2026-09-29T00:00:00.000Z'), stopped_at: null, egress_bytes: 7 },
    { computer_id: C(4), user_id: U2, started_at: at('2026-09-01T00:00:00.000Z'), stopped_at: at('2026-09-02T00:00:00.000Z'), egress_bytes: 99 },
    { computer_id: C(5), user_id: U3, started_at: at('2026-10-15T12:30:00.000Z'), stopped_at: null, egress_bytes: 3 },
    { computer_id: C(6), user_id: U3, started_at: at('2026-10-10T08:00:00.000Z'), stopped_at: at('2026-10-10T08:00:00.000Z'), egress_bytes: 0 },
];

const reference = (): MonthUsage => monthUsageFromRows(FIXTURE.map((r) => ({
    computerId: r.computer_id, userId: r.user_id, startedAt: r.started_at, stoppedAt: r.stopped_at, egressBytes: r.egress_bytes,
})), NOW);

const plain = (m: MonthUsage) => ({ global: m.global, byUser: Object.fromEntries([...m.byUser].sort(([a], [b]) => a.localeCompare(b))) });

describe('readMonthUsage totals in the database', () => {
    it('aggregates per user in SQL and selects no per-run column', async () => {
        const { db, statements } = createFakePlacementDb({ usage: FIXTURE });
        await readMonthUsage(db, NOW, MONTH);
        const text = statements.find((s) => s.sql.includes('placement:usage-month'))!.sql;
        expect(text).toMatch(/SUM\(/);
        expect(text).toMatch(/GROUP BY u\.user_id/);
        expect(text).not.toMatch(/SELECT[^;]*\bu\.started_at\s+AS\b/);
        expect(text).not.toMatch(/\bcomputer_id\b[^;]*\bFROM\b/);
    });

    it('many runs of one user come back as ONE total (bounded by users, not by wake cycles)', async () => {
        const runs = Array.from({ length: 500 }, (_, i) => ({
            computer_id: C(1), user_id: U1,
            started_at: new Date(MONTH.getTime() + i * 60_000), stopped_at: new Date(MONTH.getTime() + i * 60_000 + 30_000), egress_bytes: 1,
        }));
        const { db } = createFakePlacementDb({ usage: runs });
        const usage = await readMonthUsage(db, NOW, MONTH);
        expect(usage.byUser.size).toBe(1);
        expect(usage.byUser.get(U1)).toEqual({ hours: (500 * 30) / 3_600, egressBytes: 500 });
        expect(usage.global).toEqual(usage.byUser.get(U1));
    });

    it('a malformed aggregate fails closed, naming the field', async () => {
        const db: PlacementExecutor = { execute: async () => ({ rows: [{ user_id: U1, seconds: '1e3', egress_bytes: '0' }] }) };
        await expect(readMonthUsage(db, NOW, MONTH)).rejects.toThrow(/seconds/);
        const dup: PlacementExecutor = { execute: async () => ({ rows: [{ user_id: U1, seconds: '1', egress_bytes: '0' }, { user_id: U1, seconds: '1', egress_bytes: '0' }] }) };
        await expect(readMonthUsage(dup, NOW, MONTH)).rejects.toThrow(/user_id/);
    });
});

const PG = process.env.EZIL_PG_TEST_URL;

describe.skipIf(!PG)('readMonthUsage on real Postgres equals usage.ts arithmetic', () => {
    const client = PG ? postgres(PG, { max: 1, onnotice: () => {} }) : null;
    afterAll(async () => { await client?.end(); });

    it('SQL totals equal monthUsageFromRows on a mixed fixture', async () => {
        const sqlFile = readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql/0001_compute_placement.sql.txt'), 'utf8');
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DROP TABLE IF EXISTS public.ezil_computer_placements, public.ezil_compute_usage;`);
        await client!.unsafe(sqlFile);
        for (const r of FIXTURE) {
            await client!`INSERT INTO public.ezil_compute_usage (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, egress_bytes, observed_by, updated_at)
                VALUES (${r.computer_id}::uuid, ${r.user_id}::uuid, 'i-x', 't3a.medium', ${r.started_at.toISOString()}::timestamptz,
                    ${r.stopped_at ? r.stopped_at.toISOString() : null}::timestamptz, ${r.egress_bytes}, 'test', now())`;
        }
        const got = plain(await readMonthUsage(drizzle(client!) as unknown as PlacementExecutor, NOW, MONTH));
        const want = plain(reference());
        expect(Object.keys(got.byUser)).toEqual(Object.keys(want.byUser));
        for (const [user, t] of Object.entries(want.byUser)) {
            expect(got.byUser[user]!.hours).toBeCloseTo(t.hours, 9);
            expect(got.byUser[user]!.egressBytes).toBe(t.egressBytes);
        }
        expect(got.global.hours).toBeCloseTo(want.global.hours, 9);
        expect(got.global.egressBytes).toBe(want.global.egressBytes);
    });
});
