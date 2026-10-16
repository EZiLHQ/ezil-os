/**
 * Hard-delete feedback in the existing maintenance cron. Physical row ids
 * bound each delete even though these tables deliberately have no unique
 * constraints. The cutoff is fixed for the run; the injected clock also
 * bounds work, leaving a backlog for the next invocation.
 */
import { sql } from 'drizzle-orm';

import type { FeedbackDb } from './access-log';
import { FEEDBACK_RETENTION_DAYS } from './types';

export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_BUDGET_MS = 20_000;
const DAY_MS = 86_400_000;

export interface FeedbackPruneResult {
    deletedRows: number;
    hitBudget: boolean;
    /** The table does not exist yet (its migration is unregistered); nothing ran. */
    skipped?: true;
}

/** Which feedback tables exist. Production has none until the founder registers the SQL. */
export interface FeedbackTablesPresent {
    reports: boolean;
    attachments: boolean;
    accessLog: boolean;
}

const ALL_PRESENT: FeedbackTablesPresent = Object.freeze({ reports: true, attachments: true, accessLog: true });

/**
 * 🔴 The maintenance cron ships with the floating-controls release, BEFORE the
 * feedback SQL is registered (docs/feedback-migration.md). Deleting from a
 * table that does not exist throws, which would turn the shared cron into a
 * nightly 500. So the cron asks first; reports + access log (0003) can also
 * exist without attachments (0004). Catalog-only read: `to_regclass` never
 * touches rows.
 */
export async function feedbackTablesPresent(db: FeedbackDb): Promise<FeedbackTablesPresent> {
    const result = await db.execute(sql`
        SELECT to_regclass('public.ezil_feedback_reports') IS NOT NULL AS reports,
               to_regclass('public.ezil_feedback_attachments') IS NOT NULL AS attachments,
               to_regclass('public.ezil_feedback_access_log') IS NOT NULL AS access_log
    `);
    const rows = (Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? []) as Array<Record<string, unknown>>;
    const row = rows[0] ?? {};
    return { reports: row.reports === true, attachments: row.attachments === true, accessLog: row.access_log === true };
}

const SKIPPED: FeedbackPruneResult = Object.freeze({ deletedRows: 0, hitBudget: false, skipped: true });

export interface FeedbackRetentionResult {
    attachments: FeedbackPruneResult;
    reports: FeedbackPruneResult;
    accessLog: FeedbackPruneResult;
}

export interface FeedbackRetentionOptions {
    chunkSize?: number;
    budgetMs?: number;
    now?: () => number;
    /** Which tables exist; defaults to all (the cron passes `feedbackTablesPresent`). */
    tables?: FeedbackTablesPresent;
}

/** One shared budget, so feedback adds at most one prune budget to the cron. */
export async function runFeedbackRetention(
    db: FeedbackDb,
    opts: FeedbackRetentionOptions = {},
): Promise<FeedbackRetentionResult> {
    const clock = opts.now ?? Date.now;
    const started = clock();
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const attachmentCutoff = new Date(started - FEEDBACK_RETENTION_DAYS.attachments * DAY_MS).toISOString();
    const reportCutoff = new Date(started - FEEDBACK_RETENTION_DAYS.reports * DAY_MS).toISOString();
    const accessCutoff = new Date(started - FEEDBACK_RETENTION_DAYS.accessLog * DAY_MS).toISOString();
    const tables = opts.tables ?? ALL_PRESENT;

    async function prune(query: ReturnType<typeof sql>): Promise<FeedbackPruneResult> {
        let deletedRows = 0;
        for (;;) {
            if (clock() - started >= budgetMs) return { deletedRows, hitBudget: true };
            const result = await db.execute(query);
            const rows = Array.isArray(result) ? result : (result as { rows?: unknown[] })?.rows ?? [];
            deletedRows += rows.length;
            if (rows.length === 0) return { deletedRows, hitBudget: false };
        }
    }

    // Remove even a recent attachment when its parent report has expired.
    // The attachments query also reads reports, so it needs both tables.
    const attachments = !(tables.attachments && tables.reports) ? { ...SKIPPED } : await prune(sql`
        DELETE FROM ezil_feedback_attachments WHERE ctid IN (
            SELECT a.ctid FROM ezil_feedback_attachments a
            WHERE a.created_at < ${attachmentCutoff}::timestamptz
                OR EXISTS (SELECT 1 FROM ezil_feedback_reports r
                    WHERE r.id = a.report_id AND r.created_at < ${reportCutoff}::timestamptz)
            ORDER BY a.created_at LIMIT ${chunkSize}
        ) RETURNING report_id
    `);
    // If the budget ran out, or a concurrent attachment arrived, keep the
    // parent until its children are removed by a later run. Never orphan data.
    const reports = !tables.reports ? { ...SKIPPED } : tables.attachments ? await prune(sql`
        DELETE FROM ezil_feedback_reports WHERE ctid IN (
            SELECT r.ctid FROM ezil_feedback_reports r
            WHERE r.created_at < ${reportCutoff}::timestamptz
                AND NOT EXISTS (SELECT 1 FROM ezil_feedback_attachments a WHERE a.report_id = r.id)
            ORDER BY r.created_at LIMIT ${chunkSize}
        ) RETURNING id
    `) : await prune(sql`
        DELETE FROM ezil_feedback_reports WHERE ctid IN (
            SELECT r.ctid FROM ezil_feedback_reports r
            WHERE r.created_at < ${reportCutoff}::timestamptz
            ORDER BY r.created_at LIMIT ${chunkSize}
        ) RETURNING id
    `);
    const accessLog = !tables.accessLog ? { ...SKIPPED } : await prune(sql`
        DELETE FROM ezil_feedback_access_log WHERE ctid IN (
            SELECT ctid FROM ezil_feedback_access_log
            WHERE created_at < ${accessCutoff}::timestamptz
            ORDER BY created_at LIMIT ${chunkSize}
        ) RETURNING id
    `);
    return { attachments, reports, accessLog };
}
