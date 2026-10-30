import { drizzle } from 'drizzle-orm/pg-proxy';
import { describe, expect, it } from 'vitest';
import * as schema from '@/server/db/schema';
import { fitsAttachmentBudget, isFeedbackRateLimited } from './rate-limit';
import { FEEDBACK_LIMITS } from './types';

const NOW = new Date('2026-10-15T12:00:00.000Z');
const USER = '550e8400-e29b-41d4-a716-446655440000';
function database(rows: unknown[][]) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = drizzle(async (sql, params) => { statements.push({ sql, params }); return { rows }; }, { schema });
    return { db, statements };
}

describe('database rate and attachment budgets', () => {
    it.each([[0, 0, false], [9, 29, false], [10, 10, true], [0, 30, true], [11, 31, true]])(
        'hour=%i day=%i -> limited=%s', async (hour, day, limited) => {
            const { db } = database([[String(hour), String(day)]]);
            expect(await isFeedbackRateLimited(db, USER, NOW)).toBe(limited);
        },
    );

    it('counts only this caller with inclusive rolling hour/day boundaries', async () => {
        const { db, statements } = database([[0, 0]]);
        await isFeedbackRateLimited(db, USER, NOW);
        expect(statements).toHaveLength(1);
        expect(statements[0]!.sql).toMatch(/count\(\*\) filter \(where "created_at" >= \$1\)/);
        expect(statements[0]!.sql).toMatch(/where \("ezil_feedback_reports"\."user_id" = \$2 and "ezil_feedback_reports"\."created_at" >= \$3\)/);
        expect(statements[0]!.params).toEqual(['2026-10-15T11:00:00.000Z', USER, '2026-10-14T12:00:00.000Z']);
    });

    it.each([
        [0, 0, true],
        [FEEDBACK_LIMITS.globalAttachmentBytesPerDay - 100, FEEDBACK_LIMITS.globalAttachmentBytesTotal - 100, true],
        [FEEDBACK_LIMITS.globalAttachmentBytesPerDay - 99, 0, false],
        [0, FEEDBACK_LIMITS.globalAttachmentBytesTotal - 99, false],
    ])('day=%i total=%i includes incoming bytes -> fits=%s', async (day, total, fits) => {
        const { db } = database([[String(day), String(total)]]);
        expect(await fitsAttachmentBudget(db, 100, NOW)).toBe(fits);
    });

    it('sums all users globally and filters only the daily sum', async () => {
        const { db, statements } = database([[0, 0]]);
        await fitsAttachmentBudget(db, 100, NOW);
        expect(statements[0]!.sql).toContain('sum("byte_length") filter (where "created_at" >= $1)');
        expect(statements[0]!.sql).toContain('coalesce(sum("byte_length"), 0)');
        expect(statements[0]!.sql).not.toContain('user_id');
        expect(statements[0]!.params).toEqual(['2026-10-14T12:00:00.000Z']);
    });

    it('fails closed if aggregate rows are unavailable', async () => {
        const { db } = database([]);
        await expect(isFeedbackRateLimited(db, USER, NOW)).rejects.toThrow('counts unavailable');
        await expect(fitsAttachmentBudget(db, 100, NOW)).rejects.toThrow('counts unavailable');
    });
});
