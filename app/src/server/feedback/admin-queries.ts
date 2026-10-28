/**
 * Admin-only queries and their testable handlers. Every handler gates first,
 * then awaits the audit write before reading content. List discovery selects
 * only ids, so even description previews have a preceding view_report row.
 * These reads deliberately span owners; the allow-list is their only scope.
 */
import { sql } from 'drizzle-orm';
import { z } from 'zod';

import { isFeedbackAdmin } from './admin';
import { recordAccess, type FeedbackAccess, type FeedbackDb } from './access-log';
import { FEEDBACK_LIMITS } from './types';

export interface AdminReportSummary {
    id: string;
    createdAt: Date | string;
    category: string;
    descriptionPreview: string;
    hasScreenshot: boolean;
    computerId: string | null;
    diagnostics: unknown;
}

export interface AdminReport extends Omit<AdminReportSummary, 'descriptionPreview'> {
    description: string;
    status: string;
}

export interface AdminScreenshot {
    bytes: Uint8Array;
    contentType: string;
}

export interface FeedbackAdminContext {
    user: { id: string; email?: string | null } | null;
    allowList: string | undefined;
    recordAccess: (access: FeedbackAccess) => Promise<void>;
}

export interface FeedbackAdminQueries {
    listReportIds: () => Promise<string[]>;
    listReports: (ids: string[]) => Promise<AdminReportSummary[]>;
    findReport: (id: string) => Promise<AdminReport | null>;
    findScreenshot: (id: string) => Promise<AdminScreenshot | null>;
    deleteReport: (id: string) => Promise<void>;
}

const reportIdSchema = z.string().uuid();

function adminId(deps: FeedbackAdminContext): string | null {
    return deps.user && isFeedbackAdmin(deps.user.email, deps.allowList) ? deps.user.id : null;
}

function rowsOf<T>(result: unknown): T[] {
    return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];
}

export function feedbackAdminQueries(db: FeedbackDb): FeedbackAdminQueries & Pick<FeedbackAdminContext, 'recordAccess'> {
    return {
        recordAccess: (access) => recordAccess(db, access),
        async listReportIds() {
            const result = await db.execute(sql`
                SELECT id FROM ezil_feedback_reports ORDER BY created_at DESC, id DESC LIMIT ${FEEDBACK_LIMITS.listMax}
            `);
            return rowsOf<{ id: string }>(result).map((row) => row.id);
        },
        async listReports(ids) {
            if (ids.length === 0) return [];
            return rowsOf<AdminReportSummary>(await db.execute(sql`
                SELECT r.id, r.created_at AS "createdAt", r.category,
                    left(r.description, ${FEEDBACK_LIMITS.descriptionPreview}) AS "descriptionPreview",
                    left(r.computer_id::text, 8) AS "computerId", r.diagnostics,
                    EXISTS (SELECT 1 FROM ezil_feedback_attachments a WHERE a.report_id = r.id) AS "hasScreenshot"
                FROM ezil_feedback_reports r
                WHERE r.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
                ORDER BY r.created_at DESC, r.id DESC
            `));
        },
        async findReport(id) {
            return rowsOf<AdminReport>(await db.execute(sql`
                SELECT r.id, r.created_at AS "createdAt", r.category, r.description,
                    r.computer_id AS "computerId", r.diagnostics, r.status,
                    EXISTS (SELECT 1 FROM ezil_feedback_attachments a WHERE a.report_id = r.id) AS "hasScreenshot"
                FROM ezil_feedback_reports r WHERE r.id = ${id} LIMIT 1
            `))[0] ?? null;
        },
        async findScreenshot(id) {
            return rowsOf<AdminScreenshot>(await db.execute(sql`
                SELECT bytes, content_type AS "contentType"
                FROM ezil_feedback_attachments WHERE report_id = ${id} LIMIT 1
            `))[0] ?? null;
        },
        async deleteReport(id) {
            // One atomic statement. The dependency on the CTE completes the
            // attachment delete before deleting the report; audit rows survive.
            await db.execute(sql`
                WITH deleted_attachments AS (
                    DELETE FROM ezil_feedback_attachments WHERE report_id = ${id} RETURNING report_id
                )
                DELETE FROM ezil_feedback_reports
                WHERE id = ${id} AND (SELECT count(*) FROM deleted_attachments) >= 0
            `);
        },
    };
}

export async function loadFeedbackList(
    deps: FeedbackAdminContext & Pick<FeedbackAdminQueries, 'listReportIds' | 'listReports'>,
): Promise<AdminReportSummary[] | null> {
    const userId = adminId(deps);
    if (!userId) return null;
    const ids = await deps.listReportIds();
    for (const reportId of ids) {
        await deps.recordAccess({ reportId, adminUserId: userId, action: 'view_report' });
    }
    return deps.listReports(ids);
}

export async function loadFeedbackReport(
    id: unknown,
    deps: FeedbackAdminContext & Pick<FeedbackAdminQueries, 'findReport'>,
): Promise<AdminReport | null> {
    const userId = adminId(deps);
    const parsed = reportIdSchema.safeParse(id);
    if (!userId || !parsed.success) return null;
    await deps.recordAccess({ reportId: parsed.data, adminUserId: userId, action: 'view_report' });
    return deps.findReport(parsed.data);
}

export async function deleteFeedbackReport(
    id: unknown,
    deps: FeedbackAdminContext & Pick<FeedbackAdminQueries, 'deleteReport'>,
): Promise<boolean> {
    const userId = adminId(deps);
    const parsed = reportIdSchema.safeParse(id);
    if (!userId || !parsed.success) return false;
    await deps.recordAccess({ reportId: parsed.data, adminUserId: userId, action: 'delete' });
    await deps.deleteReport(parsed.data);
    return true;
}

/** Thin route adapter supplies auth/DB; tests inject both without a live connection. */
export async function handleFeedbackScreenshot(
    req: Request,
    deps: FeedbackAdminContext & Pick<FeedbackAdminQueries, 'findScreenshot'>,
): Promise<Response> {
    const headers = {
        'Cache-Control': 'no-store',
        'Content-Disposition': 'inline',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
    };
    const userId = adminId(deps);
    const parsed = reportIdSchema.safeParse(new URL(req.url).searchParams.get('id'));
    if (!userId || !parsed.success) return new Response(null, { status: 404, headers });
    try {
        await deps.recordAccess({ reportId: parsed.data, adminUserId: userId, action: 'view_screenshot' });
        const screenshot = await deps.findScreenshot(parsed.data);
        if (!screenshot) return new Response(null, { status: 404, headers });
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(screenshot.bytes);
                controller.close();
            },
        });
        return new Response(stream, { headers: { ...headers, 'Content-Type': screenshot.contentType } });
    } catch {
        // An audit failure must not expose even part of the screenshot.
        return new Response(null, { status: 500, headers });
    }
}
