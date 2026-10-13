import { describe, expect, it } from 'vitest';

import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { listPurgeEligible, PURGE_AFTER_DAYS, purgeEligibility, type RetentionCandidate } from './retention';

const NOW = new Date('2026-10-30T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

function deepFreeze<T>(value: T): T {
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

describe('purge eligibility (§6, dry run)', () => {
    const placements: RetentionCandidate[] = [
        { computerId: 'retired-14', state: 'RETIRED', updatedAt: daysAgo(14) },
        { computerId: 'retired-13', state: 'RETIRED', updatedAt: daysAgo(13.9) },
        { computerId: 'cancelled-20', state: 'STOPPED', updatedAt: daysAgo(30) },
        { computerId: 'cancelled-running', state: 'RUNNING', updatedAt: daysAgo(30) },
        { computerId: 'cancelled-recent', state: 'STOPPED', updatedAt: daysAgo(30) },
        { computerId: 'stopped-not-cancelled', state: 'STOPPED', updatedAt: daysAgo(400) },
        { computerId: 'already', state: 'PURGE_ELIGIBLE', updatedAt: daysAgo(400) },
    ];
    const cancellations = [
        { computerId: 'cancelled-20', cancelledAt: daysAgo(20) },
        { computerId: 'cancelled-running', cancelledAt: daysAgo(20) },
        { computerId: 'cancelled-recent', cancelledAt: daysAgo(3) },
        { computerId: 'already', cancelledAt: daysAgo(300) },
    ];

    it('RETIRED or cancelled for 14+ days, never running, never twice', () => {
        expect(PURGE_AFTER_DAYS).toBe(14);
        expect(purgeEligibility({ placements, cancellations, now: NOW })).toEqual([
            { computerId: 'retired-14', basis: 'retired', since: daysAgo(14) },
            { computerId: 'cancelled-20', basis: 'cancelled', since: daysAgo(20) },
        ]);
    });

    it('never mutates its input', () => {
        const input = deepFreeze({ placements: structuredClone(placements), cancellations: structuredClone(cancellations), now: new Date(NOW) });
        const before = structuredClone(input);
        const out = purgeEligibility(input);
        expect(input).toEqual(before);
        // Returned dates are copies: mutating them cannot reach back into the input.
        out[0]!.since.setTime(0);
        expect(input).toEqual(before);
    });

    it('the database path issues one read-only SELECT and changes no row', async () => {
        const seed = [
            placementRow({ computer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', state: 'RETIRED', updated_at: daysAgo(15) }),
            placementRow({ computer_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', state: 'RUNNING' }),
        ];
        const { db, statements, placements: rows } = createFakePlacementDb({ placements: seed });
        const before = structuredClone(rows);
        const out = await listPurgeEligible(db, { cancellations: [], now: NOW });
        expect(out.map((o) => o.computerId)).toEqual(['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql.replace(/\/\*[\s\S]*?\*\//, '').trim()).toMatch(/^SELECT\b/);
        expect(statements[0]!.sql).not.toMatch(/\b(UPDATE|INSERT|DELETE|TRUNCATE)\b/i);
        expect(rows).toEqual(before);
    });
});
