import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import type { FeedbackDb } from './access-log';
import { runFeedbackRetention } from './retention';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const DAY = 86_400_000;
const dialect = new PgDialect();

describe('feedback retention: fixed cutoffs, bounded hard deletes', () => {
    it('uses strict cutoffs at exactly 30/180/365 days with an injected clock', async () => {
        const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
        const db: FeedbackDb = { execute: async (q) => { statements.push(dialect.sqlToQuery(q)); return []; } };
        expect(await runFeedbackRetention(db, { now: () => NOW })).toEqual({
            attachments: { deletedRows: 0, hitBudget: false },
            reports: { deletedRows: 0, hitBudget: false },
            accessLog: { deletedRows: 0, hitBudget: false },
        });
        expect(statements).toHaveLength(3);
        for (const [i, days] of [30, 180, 365].entries()) {
            const query = statements[i]!;
            expect(query.params[0]).toBe(new Date(NOW - days * DAY).toISOString());
            // Exercise the generated comparator at -1ms, the exact boundary,
            // and +1ms. Changing SQL to <= must fail the exact-age assertion.
            const match = query.sql.match(/created_at\s*(<=|<|>=|>)\s*\$1::timestamptz/);
            expect(match).not.toBeNull();
            const cutoff = Date.parse(query.params[0] as string);
            const eligible = (age: number) => {
                const created = NOW - age;
                switch (match![1]) {
                    case '<': return created < cutoff;
                    case '<=': return created <= cutoff;
                    case '>': return created > cutoff;
                    default: return created >= cutoff;
                }
            };
            expect(eligible(days * DAY + 1)).toBe(true);
            expect(eligible(days * DAY)).toBe(false);
            expect(eligible(days * DAY - 1)).toBe(false);
            expect(query.sql).toMatch(/DELETE FROM ezil_feedback_\w+ WHERE ctid IN/);
            expect(query.sql).toMatch(/ORDER BY .*created_at LIMIT/);
            expect(query.params.at(-1)).toBe(500);
            expect(query.sql).not.toMatch(/UPDATE|TRUNCATE|\bbytes\b/);
        }
    });

    it('chunks all three stores until empty, supporting both driver result shapes', async () => {
        const counts = [2, 2, 1, 0, 2, 0, 2, 1, 0];
        const tables: string[] = [];
        const db: FeedbackDb = { execute: async (q) => {
            const { sql, params } = dialect.sqlToQuery(q);
            tables.push(sql.match(/DELETE FROM (\w+)/)![1]!);
            expect(params.at(-1)).toBe(2);
            const rows = Array.from({ length: counts.shift()! }, () => ({ id: 'row' }));
            return tables.length % 2 ? rows : { rows };
        } };
        const result = await runFeedbackRetention(db, { chunkSize: 2, now: () => NOW });
        expect(result).toEqual({
            attachments: { deletedRows: 5, hitBudget: false },
            reports: { deletedRows: 2, hitBudget: false },
            accessLog: { deletedRows: 3, hitBudget: false },
        });
        expect(tables).toEqual([
            ...Array(4).fill('ezil_feedback_attachments'),
            ...Array(2).fill('ezil_feedback_reports'),
            ...Array(3).fill('ezil_feedback_access_log'),
        ]);
    });

    it('removes recent attachments of expired reports and prevents deleting a parent with remaining attachments', async () => {
        const queries: ReturnType<PgDialect['sqlToQuery']>[] = [];
        const db: FeedbackDb = { execute: async (q) => { queries.push(dialect.sqlToQuery(q)); return []; } };
        await runFeedbackRetention(db, { now: () => NOW });
        expect(queries[0]!.sql).toMatch(/OR EXISTS \(SELECT 1 FROM ezil_feedback_reports r\s+WHERE r.id = a.report_id AND r.created_at < \$2::timestamptz\)/);
        expect(queries[0]!.params[1]).toBe(new Date(NOW - 180 * DAY).toISOString());
        expect(queries[1]!.sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM ezil_feedback_attachments a WHERE a.report_id = r.id\)/);
    });

    it('stops at the shared wall-clock budget even with a never-ending backlog', async () => {
        let time = NOW;
        const db = { execute: vi.fn(async () => { time += 10; return [{ id: 'old' }]; }) };
        const result = await runFeedbackRetention(db, { now: () => time, budgetMs: 20 });
        expect(db.execute).toHaveBeenCalledTimes(2);
        expect(result).toEqual({
            attachments: { deletedRows: 2, hitBudget: true },
            reports: { deletedRows: 0, hitBudget: true },
            accessLog: { deletedRows: 0, hitBudget: true },
        });
    });

    it('does not start a query when no budget remains', async () => {
        const db = { execute: vi.fn() };
        const result = await runFeedbackRetention(db, { now: () => NOW, budgetMs: 0 });
        expect(db.execute).not.toHaveBeenCalled();
        expect(Object.values(result).every((r) => r.hitBudget)).toBe(true);
    });

    it('does not proceed to parent deletion after an attachment delete throws', async () => {
        const db = { execute: vi.fn().mockRejectedValue(new Error('delete failed')) };
        await expect(runFeedbackRetention(db, { now: () => NOW })).rejects.toThrow('delete failed');
        expect(db.execute).toHaveBeenCalledTimes(1);
    });
});
