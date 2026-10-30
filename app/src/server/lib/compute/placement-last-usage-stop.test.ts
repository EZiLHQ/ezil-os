/**
 * Hotfix r5 review: `readLastUsageStop` is the stop hold's key (`stopCooldownAnswer`, compute-dispatch.ts) —
 * when the computer's last AWS run ended. Owner-scoped, read-only, null when it never ran.
 */
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { readLastUsageStop, type PlacementExecutor } from './placement';

const C = '22222222-2222-4222-8222-222222222222';
const U = '11111111-1111-4111-8111-111111111111';

function db(rows: Record<string, unknown>[]) {
    const seen: { sql: string; params: unknown[] }[] = [];
    const execute = async (q: SQL) => { const { sql, params } = new PgDialect().sqlToQuery(q); seen.push({ sql, params }); return rows; };
    return { seen, db: { execute } as unknown as PlacementExecutor };
}

describe('readLastUsageStop', () => {
    it('reads the newest stopped_at of this owner\'s usage rows for the computer, and nothing else', async () => {
        const t = db([{ stopped_at: '2026-10-29T19:25:52.770Z' }]);
        expect(await readLastUsageStop(t.db, C.toUpperCase(), U)).toEqual(new Date('2026-10-29T19:25:52.770Z'));
        expect(t.seen).toHaveLength(1);
        expect(t.seen[0]!.sql.replace(/\s+/g, ' ').trim()).toBe('/* placement:usage-last-stop */ SELECT max(stopped_at) AS stopped_at '
            + 'FROM public.ezil_compute_usage WHERE computer_id = $1::uuid AND user_id = $2::uuid');
        expect(t.seen[0]!.params).toEqual([C, U]);
    });

    it.each([[[{ stopped_at: null }]], [[]], [[{ stopped_at: 'not a time' }]]])('answers null when there is no usable stop (%j)', async rows => {
        expect(await readLastUsageStop(db(rows).db, C, U)).toBeNull();
    });

    it('accepts a Date from the driver', async () => {
        const at = new Date('2026-10-29T19:25:52.770Z');
        expect(await readLastUsageStop(db([{ stopped_at: at }]).db, C, U)).toEqual(at);
    });
});
