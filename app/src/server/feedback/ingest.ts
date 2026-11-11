import { createHash, randomUUID } from 'node:crypto';
import { and, desc, eq, gte, isNull, notInArray, sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';
import { feedbackAttachments, feedbackReports } from '@/server/db/schema/feedback';
import { decodeScreenshots, type FeedbackImage } from './image';
import { fitsAttachmentBudget, isFeedbackRateLimited } from './rate-limit';
import { feedbackFailureRefs, redactDescription, sanitizeDiagnostics } from './redact';
import { captureServerContext } from './server-context';
import { FEEDBACK_CATEGORIES, FEEDBACK_LIMITS, submittedImages, type FeedbackCreated, type FeedbackReportSummary,
    type FeedbackStaged, type FeedbackSubmit } from './types';

export type FeedbackDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>, 'transaction' | 'select'
>;

export type FeedbackIngestResult = { status: 200 | 201; created: FeedbackCreated } | { status: 429 }
    /** Upload-first: a referenced image is not staged for this user and request (or is too old); upload it again. */
    | { status: 409; error: 'staged_images_missing' };

export type FeedbackStageResult = { status: 200 | 201; staged: FeedbackStaged }
    | { status: 409; error: 'report_already_sent' }
    | { status: 413; error: 'payload_too_large' }
    | { status: 429; error: 'staged_reports_limit' }
    | { status: 507; error: 'attachment_budget' };

/**
 * Upload-first ticket: the report id a staged report will have, derived from the signed-in user and the
 * report's clientRequestId (UUIDv8 layout). It is never a credential: every staged row is also read by `user_id`.
 */
export function stagingTicket(userId: string, clientRequestId: string): string {
    const hex = createHash('sha256').update(`ezil-feedback-ticket\0${userId.toLowerCase()}\0${clientRequestId.toLowerCase()}`)
        .digest('hex').slice(0, 32).split('');
    hex[12] = '8';
    hex[16] = (8 | (Number.parseInt(hex[16]!, 16) & 3)).toString(16);
    const id = hex.join('');
    return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

// The schema deliberately has no uniqueness constraints (db/schema/feedback.ts:7).
// Serialize each user's check+insert in a READ COMMITTED transaction so queued
// requests see their predecessor's commit. A separate namespace protects the
// global attachment sum without serializing screenshot-free users together.
const USER_LOCK = 0x455a6662;
const ATTACHMENT_LOCK = 0x455a6661;

export async function ingestFeedback(
    db: FeedbackDb, userId: string, input: FeedbackSubmit, now = new Date(), deploySha: string | null = null,
): Promise<FeedbackIngestResult> {
    const images = decodeScreenshots(submittedImages(input));
    const description = redactDescription(input.description);
    // A correlation id equal to the reporter's own user or computer id is not one.
    const diagnostics = sanitizeDiagnostics(input.diagnostics, { excludeIds: [userId, input.computerId] });
    const result = await db.transaction(async (tx): Promise<FeedbackIngestResult> => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USER_LOCK}::int4, hashtext(${userId}::uuid::text))`);
        const [existing] = await tx.select({ id: feedbackReports.id, createdAt: feedbackReports.createdAt, hasScreenshot: feedbackReports.hasScreenshot })
            .from(feedbackReports).where(and(eq(feedbackReports.userId, userId), eq(feedbackReports.clientRequestId, input.clientRequestId))).limit(1);
        // Retrying a committed request consumes no quota (docs/FEEDBACK-CONTROLS-CONTRACT.md:121).
        if (existing) {
            const screenshotCount = existing.hasScreenshot ? await countAttachments(tx, userId, existing.id) : 0;
            return { status: 200, created: { id: existing.id, createdAt: existing.createdAt.toISOString(),
                screenshotAccepted: existing.hasScreenshot, screenshotCount } };
        }
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
        // App-error coverage: consented reports about the reporter's own computer get a submission-time server
        // context. A failed or slow lookup still stores the report; a retry returned above never recaptures it.
        const serverContext = diagnostics && computerId
            ? await captureServerContext(tx as unknown as Parameters<typeof captureServerContext>[0], { userId, computerId, now })
            : null;
        if (input.screenshotRefs) {
            // Upload-first finalize: the staged rows become this report's images, all or none. Same lock order as a PUT.
            await tx.execute(sql`select pg_advisory_xact_lock(${ATTACHMENT_LOCK}::int4, 0)`);
            const id = stagingTicket(userId, input.clientRequestId);
            const staged = await stagedRows(tx, userId, id);
            const fresh = now.getTime() - FEEDBACK_LIMITS.stagedImageFreshMs;
            const ordered = input.screenshotRefs.map(ref => staged.find(row => row.sha256 === ref.sha256
                && row.contentType === ref.contentType && row.createdAt.getTime() >= fresh));
            if (ordered.some(row => !row)) return { status: 409, error: 'staged_images_missing' };
            const kept = input.screenshotRefs.map(ref => ref.sha256);
            // Staged but no longer referenced (removed before this request was frozen): not part of the report.
            await tx.delete(feedbackAttachments).where(and(eq(feedbackAttachments.reportId, id),
                eq(feedbackAttachments.userId, userId), notInArray(feedbackAttachments.sha256, kept)));
            // Report order, as for inline images. Every row is under an hour old, so moving it to `now` keeps it in
            // the same 24 h budget window: the global sums do not change.
            for (const [index, sha256] of kept.entries()) {
                await tx.update(feedbackAttachments).set({ createdAt: new Date(now.getTime() + index) })
                    .where(and(eq(feedbackAttachments.reportId, id), eq(feedbackAttachments.userId, userId),
                        eq(feedbackAttachments.sha256, sha256)));
            }
            await tx.insert(feedbackReports).values({
                id, userId, computerId, createdAt: now, category: input.category,
                description: description.text, diagnostics: serverContext ? { ...diagnostics, serverContext } : diagnostics,
                clientRequestId: input.clientRequestId,
                shellVersion: diagnostics?.shellVersion ?? null, status: 'new', redactionCount: description.count,
                hasScreenshot: true, deploySha,
            });
            return { status: 201, created: { id, createdAt: now.toISOString(), screenshotAccepted: true, screenshotCount: kept.length } };
        }
        let screenshotAccepted = false;
        if (images.length) {
            await tx.execute(sql`select pg_advisory_xact_lock(${ATTACHMENT_LOCK}::int4, 0)`);
            // All or none: a report never arrives with only some of the images its reporter previewed.
            screenshotAccepted = await fitsAttachmentBudget(tx, images.reduce((sum, image) => sum + image.byteLength, 0), now);
        }
        const id = randomUUID();
        await tx.insert(feedbackReports).values({
            id, userId, computerId, createdAt: now, category: input.category,
            description: description.text, diagnostics: serverContext ? { ...diagnostics, serverContext } : diagnostics,
            clientRequestId: input.clientRequestId,
            shellVersion: diagnostics?.shellVersion ?? null, status: 'new', redactionCount: description.count,
            hasScreenshot: screenshotAccepted, deploySha,
        });
        // The table has no ordinal column (production grammar: no defaults or constraints), so each image's
        // created_at is the report time plus its position in milliseconds; `findScreenshot` orders by it.
        if (screenshotAccepted) await tx.insert(feedbackAttachments).values(images.map((image, index) => ({
            reportId: id, userId, createdAt: new Date(now.getTime() + index), contentType: image.contentType,
            sha256: image.sha256, byteLength: image.byteLength, bytes: image.bytes,
        })));
        return { status: 201, created: { id, createdAt: now.toISOString(), screenshotAccepted,
            screenshotCount: screenshotAccepted ? images.length : 0 } };
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

async function countAttachments(db: Pick<FeedbackDb, 'select'>, userId: string, reportId: string): Promise<number> {
    const [row] = await db.select({ count: sql<number>`count(*)`.mapWith(Number) }).from(feedbackAttachments)
        .where(and(eq(feedbackAttachments.reportId, reportId), eq(feedbackAttachments.userId, userId)));
    return row?.count ?? 0;
}

type StagedRow = { sha256: string; contentType: string; byteLength: number; createdAt: Date };

/** This user's rows under one ticket, locked for the rest of the transaction. */
async function stagedRows(db: Pick<FeedbackDb, 'select'>, userId: string, ticket: string): Promise<StagedRow[]> {
    return db.select({ sha256: feedbackAttachments.sha256, contentType: feedbackAttachments.contentType,
        byteLength: feedbackAttachments.byteLength, createdAt: feedbackAttachments.createdAt })
        .from(feedbackAttachments)
        .where(and(eq(feedbackAttachments.reportId, ticket), eq(feedbackAttachments.userId, userId)))
        .for('update');
}

/**
 * Upload-first: store one image for a report that is not sent yet. Only the shell's explicit Send calls this, then
 * finalizes with `screenshotRefs`. Idempotent per (user, clientRequestId, image): the same image again is a no-op,
 * or renews its timestamp once it is too old to finalize. A report already stored is never changed: the same image
 * is acknowledged, anything else is refused. Lock order matches `ingestFeedback`: the user, then the global budget.
 */
export async function stageFeedbackImage(
    db: FeedbackDb, userId: string, clientRequestId: string, image: FeedbackImage, now = new Date(),
): Promise<FeedbackStageResult> {
    return db.transaction(async (tx): Promise<FeedbackStageResult> => {
        await tx.execute(sql`select pg_advisory_xact_lock(${USER_LOCK}::int4, hashtext(${userId}::uuid::text))`);
        const staged = { sha256: image.sha256, finalized: false };
        const [report] = await tx.select({ id: feedbackReports.id }).from(feedbackReports)
            .where(and(eq(feedbackReports.userId, userId), eq(feedbackReports.clientRequestId, clientRequestId))).limit(1);
        if (report) {
            // A finalize whose answer was lost is retried as PUTs first: acknowledge what the report holds, add nothing.
            const [held] = await tx.select({ sha256: feedbackAttachments.sha256 }).from(feedbackAttachments)
                .where(and(eq(feedbackAttachments.reportId, report.id), eq(feedbackAttachments.userId, userId),
                    eq(feedbackAttachments.sha256, image.sha256))).limit(1);
            return held ? { status: 200, staged: { ...staged, finalized: true } } : { status: 409, error: 'report_already_sent' };
        }
        const ticket = stagingTicket(userId, clientRequestId);
        const rows = await stagedRows(tx, userId, ticket);
        const same = rows.find(row => row.sha256 === image.sha256);
        if (same && same.createdAt.getTime() >= now.getTime() - FEEDBACK_LIMITS.stagedImageFreshMs) return { status: 200, staged };
        const others = rows.filter(row => row !== same);
        if (others.length >= FEEDBACK_LIMITS.imagesMax
            || others.reduce((sum, row) => sum + row.byteLength, 0) + image.byteLength > FEEDBACK_LIMITS.imagesBytesTotal) {
            return { status: 413, error: 'payload_too_large' };
        }
        const ttlStart = now.getTime() - FEEDBACK_LIMITS.stagedImageTtlMs;
        if (!rows.some(row => row.createdAt.getTime() >= ttlStart)) {
            // Bounded unsent work per user: tickets holding staged rows from the last day that are not reports yet. A
            // ticket whose rows are all older than that is not counted, so reactivating it is admitted like a new one.
            const [pending] = await tx.select({ count: sql<number>`count(distinct ${feedbackAttachments.reportId})`.mapWith(Number) })
                .from(feedbackAttachments)
                .where(and(eq(feedbackAttachments.userId, userId),
                    gte(feedbackAttachments.createdAt, new Date(ttlStart)),
                    sql`not exists (select 1 from ${feedbackReports} r where r.id = ${feedbackAttachments.reportId})`));
            if ((pending?.count ?? 0) >= FEEDBACK_LIMITS.stagedTicketsPerUser) return { status: 429, error: 'staged_reports_limit' };
        }
        await tx.execute(sql`select pg_advisory_xact_lock(${ATTACHMENT_LOCK}::int4, 0)`);
        // Staged bytes count against the global budgets from the moment they are stored.
        if (!await fitsAttachmentBudget(tx, image.byteLength, now, same)) return { status: 507, error: 'attachment_budget' };
        if (same) {
            await tx.delete(feedbackAttachments).where(and(eq(feedbackAttachments.reportId, ticket),
                eq(feedbackAttachments.userId, userId), eq(feedbackAttachments.sha256, image.sha256)));
        }
        await tx.insert(feedbackAttachments).values({ reportId: ticket, userId, createdAt: now, contentType: image.contentType,
            sha256: image.sha256, byteLength: image.byteLength, bytes: image.bytes });
        return { status: 201, staged };
    }, { isolationLevel: 'read committed' });
}

export async function listFeedback(db: FeedbackDb, userId: string): Promise<FeedbackReportSummary[]> {
    const rows = await db.select({
        id: feedbackReports.id, createdAt: feedbackReports.createdAt, category: feedbackReports.category,
        description: feedbackReports.description, hasScreenshot: feedbackReports.hasScreenshot, status: feedbackReports.status,
        // Owner-scoped like the report itself; retention may already have removed the images.
        screenshotCount: sql<number>`(select count(*) from ${feedbackAttachments} a where a.report_id = ${feedbackReports.id} and a.user_id = ${userId})`.mapWith(Number),
    }).from(feedbackReports).where(eq(feedbackReports.userId, userId))
        .orderBy(desc(feedbackReports.createdAt), desc(feedbackReports.id)).limit(FEEDBACK_LIMITS.listMax);
    return rows.map((row) => ({
        id: row.id, createdAt: row.createdAt.toISOString(),
        category: FEEDBACK_CATEGORIES.find((category) => category === row.category) ?? 'other',
        descriptionPreview: row.description.slice(0, FEEDBACK_LIMITS.descriptionPreview),
        hasScreenshot: row.hasScreenshot, screenshotCount: row.screenshotCount, status: row.status,
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
