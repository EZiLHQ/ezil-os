import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';
import { feedbackAttachments, feedbackReports } from '@/server/db/schema/feedback';
import { decodeScreenshot } from './image';
import { fitsAttachmentBudget, isFeedbackRateLimited } from './rate-limit';
import { feedbackFailureRefs, redactDescription, sanitizeDiagnostics } from './redact';
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS, type FeedbackCreated, type FeedbackReportSummary, type FeedbackSubmit } from './types';

export type FeedbackDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>, 'transaction' | 'select'
>;

export type FeedbackIngestResult = { status: 200 | 201; created: FeedbackCreated } | { status: 429 };

// The schema deliberately has no uniqueness constraints (db/schema/feedback.ts:7).
// Serialize each user's check+insert in a READ COMMITTED transaction so queued
// requests see their predecessor's commit. A separate namespace protects the
// global attachment sum without serializing screenshot-free users together.
const USER_LOCK = 0x455a6662;
const ATTACHMENT_LOCK = 0x455a6661;

export async function ingestFeedback(
    db: FeedbackDb, userId: string, input: FeedbackSubmit, now = new Date(), deploySha: string | null = null,
): Promise<FeedbackIngestResult> {
    const image = input.screenshot ? decodeScreenshot(input.screenshot) : null;
    const description = redactDescription(input.description);
    // A correlation id equal to the reporter's own user or computer id is not one.
    const diagnostics = sanitizeDiagnostics(input.diagnostics, { excludeIds: [userId, input.computerId] });
    const result = await db.transaction(async (tx): Promise<FeedbackIngestResult> => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USER_LOCK}::int4, hashtext(${userId}::uuid::text))`);
        const [existing] = await tx.select({ id: feedbackReports.id, createdAt: feedbackReports.createdAt, hasScreenshot: feedbackReports.hasScreenshot })
            .from(feedbackReports).where(and(eq(feedbackReports.userId, userId), eq(feedbackReports.clientRequestId, input.clientRequestId))).limit(1);
        // Retrying a committed request consumes no quota (docs/FEEDBACK-CONTROLS-CONTRACT.md:121).
        if (existing) return { status: 200, created: { id: existing.id, createdAt: existing.createdAt.toISOString(), screenshotAccepted: existing.hasScreenshot } };
        if (await isFeedbackRateLimited(tx, userId, now)) return { status: 429 };

        let computerId: string | null = null;
        if (input.computerId) {
            // Same owner + nondeleted shape as api/routers/cloudflare-guacamole.ts:83;
            // feedback drops a foreign association instead of rejecting the report.
            const computer = await tx.query.computers.findFirst({
                where: and(eq(computers.id, input.computerId), eq(computers.userId, userId), isNull(computers.deletedAt)),
                columns: { id: true },
            });
            computerId = computer?.id ?? null;
        }
        let screenshotAccepted = false;
        if (image) {
            await tx.execute(sql`select pg_advisory_xact_lock(${ATTACHMENT_LOCK}::int4, 0)`);
            screenshotAccepted = await fitsAttachmentBudget(tx, image.byteLength, now);
        }
        const id = randomUUID();
        await tx.insert(feedbackReports).values({
            id, userId, computerId, createdAt: now, category: input.category,
            description: description.text, diagnostics, clientRequestId: input.clientRequestId,
            shellVersion: diagnostics?.shellVersion ?? null, status: 'new', redactionCount: description.count,
            hasScreenshot: screenshotAccepted, deploySha,
        });
        if (image && screenshotAccepted) await tx.insert(feedbackAttachments).values({
            reportId: id, userId, createdAt: now, contentType: image.contentType,
            sha256: image.sha256, byteLength: image.byteLength, bytes: image.bytes,
        });
        return { status: 201, created: { id, createdAt: now.toISOString(), screenshotAccepted } };
    }, { isolationLevel: 'read committed' });
    // FEEDBACK-DIAG: after commit, so a logged report id always exists. Report
    // id plus the validated server correlation ids and reason codes only —
    // never the description, the user, the computer or anything else submitted.
    const refs = result.status === 201 ? feedbackFailureRefs(diagnostics) : [];
    if (result.status === 201 && refs.length) {
        console.info('[feedback] report carries server failures', { reportId: result.created.id, failures: refs });
    }
    return result;
}

export async function listFeedback(db: FeedbackDb, userId: string): Promise<FeedbackReportSummary[]> {
    const rows = await db.select({
        id: feedbackReports.id, createdAt: feedbackReports.createdAt, category: feedbackReports.category,
        description: feedbackReports.description, hasScreenshot: feedbackReports.hasScreenshot, status: feedbackReports.status,
    }).from(feedbackReports).where(eq(feedbackReports.userId, userId))
        .orderBy(desc(feedbackReports.createdAt), desc(feedbackReports.id)).limit(FEEDBACK_LIMITS.listMax);
    return rows.map((row) => ({
        id: row.id, createdAt: row.createdAt.toISOString(),
        category: FEEDBACK_CATEGORIES.find((category) => category === row.category) ?? 'other',
        descriptionPreview: row.description.slice(0, FEEDBACK_LIMITS.descriptionPreview),
        hasScreenshot: row.hasScreenshot, status: row.status,
    }));
}

export async function deleteFeedback(db: FeedbackDb, userId: string, id: string): Promise<boolean> {
    return db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USER_LOCK}::int4, hashtext(${userId}::uuid::text))`);
        const owned = and(eq(feedbackReports.id, id), eq(feedbackReports.userId, userId));
        const [report] = await tx.select({ id: feedbackReports.id }).from(feedbackReports).where(owned).limit(1);
        if (!report) return false;
        // Explicit scope on BOTH deletes prevents an attachment from escaping
        // the owner boundary even without FKs (docs/FEEDBACK-CONTROLS-CONTRACT.md:130).
        await tx.delete(feedbackAttachments).where(and(eq(feedbackAttachments.reportId, id), eq(feedbackAttachments.userId, userId)));
        const deleted = await tx.delete(feedbackReports).where(owned).returning({ id: feedbackReports.id });
        return deleted.length > 0;
    }, { isolationLevel: 'read committed' });
}
