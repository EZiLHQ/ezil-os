import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import { recordAccess, type FeedbackDb } from './access-log';
import { FEEDBACK_ACCESS_ACTIONS } from './types';

describe('recordAccess', () => {
    it.each(FEEDBACK_ACCESS_ACTIONS)('inserts a fresh id and timestamp for %s', async (action) => {
        const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
        const db: FeedbackDb = { execute: async (q) => { statements.push(new PgDialect().sqlToQuery(q)); return []; } };
        const before = Date.now();
        await recordAccess(db, { reportId: 'report', adminUserId: 'admin', action });
        await recordAccess(db, { reportId: 'report', adminUserId: 'admin', action });
        for (const statement of statements) {
            expect(statement.sql).toMatch(/INSERT INTO ezil_feedback_access_log \(id, report_id, admin_user_id, action, created_at\)/);
            expect(statement.params[0]).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/);
            expect(statement.params.slice(1, 4)).toEqual(['report', 'admin', action]);
            expect(statement.params[4]).toBeInstanceOf(Date);
            expect((statement.params[4] as Date).getTime()).toBeGreaterThanOrEqual(before);
            expect((statement.params[4] as Date).getTime()).toBeLessThanOrEqual(Date.now());
        }
        expect(statements[0]!.params[0]).not.toBe(statements[1]!.params[0]);
    });

    it('propagates an audit write failure', async () => {
        const db = { execute: vi.fn().mockRejectedValue(new Error('audit unavailable')) };
        await expect(recordAccess(db, { reportId: 'report', adminUserId: 'admin', action: 'view_report' })).rejects.toThrow('audit unavailable');
    });
});
