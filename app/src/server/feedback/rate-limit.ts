import { and, eq, gte, sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@/server/db/schema';
import { feedbackAttachments, feedbackReports } from '@/server/db/schema/feedback';
import { FEEDBACK_LIMITS } from './types';

export type FeedbackCountDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>, 'select'
>;

export async function isFeedbackRateLimited(db: FeedbackCountDb, userId: string, now: Date): Promise<boolean> {
    const hour = new Date(now.getTime() - 3_600_000);
    const day = new Date(now.getTime() - 86_400_000);
    const [counts] = await db.select({
        hour: sql<number>`count(*) filter (where ${feedbackReports.createdAt} >= ${hour.toISOString()})`.mapWith(Number),
        day: sql<number>`count(*)`.mapWith(Number),
    }).from(feedbackReports).where(and(eq(feedbackReports.userId, userId), gte(feedbackReports.createdAt, day)));
    // Unlike telemetry/load-shed.ts's approximate cache, these bounds govern
    // user-visible acceptance and must use committed rows (docs/FEEDBACK-CONTROLS-CONTRACT.md:126).
    if (!counts) throw new Error('Feedback counts unavailable');
    return counts.hour >= FEEDBACK_LIMITS.perUserPerHour || counts.day >= FEEDBACK_LIMITS.perUserPerDay;
}

/**
 * `replacing` is a staged row that this write deletes and re-inserts at `now` (an expired upload-first image sent
 * again): its bytes are subtracted from each window it is already counted in, so the renewal is never charged twice
 * and never lets a full budget through.
 */
export async function fitsAttachmentBudget(
    db: FeedbackCountDb, byteLength: number, now: Date, replacing?: { byteLength: number; createdAt: Date },
): Promise<boolean> {
    const dayStart = now.getTime() - 86_400_000;
    const day = new Date(dayStart).toISOString();
    const [counts] = await db.select({
        day: sql<number>`coalesce(sum(${feedbackAttachments.byteLength}) filter (where ${feedbackAttachments.createdAt} >= ${day}), 0)`.mapWith(Number),
        total: sql<number>`coalesce(sum(${feedbackAttachments.byteLength}), 0)`.mapWith(Number),
    }).from(feedbackAttachments);
    if (!counts) throw new Error('Feedback attachment counts unavailable');
    const dayCredit = replacing && replacing.createdAt.getTime() >= dayStart ? replacing.byteLength : 0;
    const totalCredit = replacing?.byteLength ?? 0;
    return counts.day - dayCredit + byteLength <= FEEDBACK_LIMITS.globalAttachmentBytesPerDay
        && counts.total - totalCredit + byteLength <= FEEDBACK_LIMITS.globalAttachmentBytesTotal;
}
