import { getTableColumns, getTableName } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { additiveSQL } from '../../../../.github/scripts/production-migrations.mjs';
import { feedbackAccessLog, feedbackAttachments, feedbackReports } from '../db/schema/feedback';
import { FEEDBACK_ATTACHMENTS_SQL, FEEDBACK_REPORTS_SQL } from './migration-sql';

describe('feedback SQL: production grammar and Drizzle parity', () => {
    it.each([FEEDBACK_REPORTS_SQL, FEEDBACK_ATTACHMENTS_SQL])('passes the actual public-schema additive grammar', (statement) => {
        expect(additiveSQL(statement, ['public'])).toBe(statement);
    });

    it.each([feedbackReports, feedbackAttachments, feedbackAccessLog])('matches every column, type, and nullability', (table) => {
        const name = getTableName(table);
        const sql = `${FEEDBACK_REPORTS_SQL};${FEEDBACK_ATTACHMENTS_SQL}`;
        const body = sql.match(new RegExp(`CREATE TABLE public\\.${name} \\(([^;]+)\\);`))?.[1];
        expect(body).toBeDefined();
        const columns = body!.split(',').map((definition) => {
            const match = definition.trim().match(/^(\w+)\s+(\w+)(?:\s+(NOT NULL|NULL))?$/i);
            expect(match).not.toBeNull();
            return { name: match![1], type: match![2]!.toLowerCase(), notNull: match![3]?.toUpperCase() === 'NOT NULL' };
        });
        const expected = Object.values(getTableColumns(table)).map((column) => ({
            name: column.name,
            type: column.getSQLType().replace('timestamp with time zone', 'timestamptz'),
            notNull: column.notNull,
        }));
        expect(columns).toEqual(expected);
    });
});
