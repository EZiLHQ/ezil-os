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

export async function fitsAttachmentBudget(db: FeedbackCountDb, byteLength: number, now: Date): Promise<boolean> {
    const day = new Date(now.getTime() - 86_400_000).toISOString();
    const [counts] = await db.select({
        day: sql<number>`coalesce(sum(${feedbackAttachments.byteLength}) filter (where ${feedbackAttachments.createdAt} >= ${day}), 0)`.mapWith(Number),
        total: sql<number>`coalesce(sum(${feedbackAttachments.byteLength}), 0)`.mapWith(Number),
    }).from(feedbackAttachments);
    if (!counts) throw new Error('Feedback attachment counts unavailable');
    return counts.day + byteLength <= FEEDBACK_LIMITS.globalAttachmentBytesPerDay
        && counts.total + byteLength <= FEEDBACK_LIMITS.globalAttachmentBytesTotal;
}
