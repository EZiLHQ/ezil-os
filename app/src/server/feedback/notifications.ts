import { sql } from 'drizzle-orm';
import type { FeedbackDb } from './ingest';
import type { FeedbackMailer, FeedbackNotice } from './notification-mail';

const DRAIN_LOCK = 0x455a666e;
export interface FeedbackNotificationCounts { accepted: number; retry: number; skipped: boolean }
function rows<T>(result: unknown): T[] {
    return (Array.isArray(result) ? result : (result as { rows?: T[] })?.rows ?? []) as T[];
}

/** One bounded send per invocation. The existing minute sweep is the retry driver.
 * The transaction owns both the global drain lock and the row throughout the
 * bounded request. Overlapping sweeps cannot send the same report concurrently.
 * A process death after provider acceptance can cause a duplicate on recovery.
 */
export async function drainFeedbackNotifications(db: FeedbackDb, mailer: FeedbackMailer | null, now = new Date()): Promise<FeedbackNotificationCounts> {
    return db.transaction(async tx => {
        const lock = rows<{ locked: boolean }>(await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${DRAIN_LOCK}::int4, 0::int4) AS locked`))[0];
        if (!lock?.locked) return { accepted: 0, retry: 0, skipped: true };
        // Retention/user deletion may have removed the parent. Never email an orphan.
        await tx.execute(sql`DELETE FROM ezil_feedback_notifications n
            WHERE NOT EXISTS (SELECT 1 FROM ezil_feedback_reports r WHERE r.id = n.report_id)`);
        // Cleanup still runs with sending disabled, so retention never leaves
        // notification metadata behind for a deleted report.
        if (!mailer) return { accepted: 0, retry: 0, skipped: true };
        const notice = rows<FeedbackNotice & { attempts: number }>(await tx.execute(sql`
            SELECT n.report_id AS "reportId", n.category, n.created_at AS "createdAt", n.attempts
            FROM ezil_feedback_notifications n
            WHERE n.accepted_at IS NULL AND n.next_attempt_at <= ${now.toISOString()}::timestamptz
            ORDER BY n.next_attempt_at, n.report_id LIMIT 1 FOR UPDATE SKIP LOCKED
        `))[0];
        if (!notice) return { accepted: 0, retry: 0, skipped: false };
        const normalized = { reportId: notice.reportId, category: notice.category, createdAt: new Date(notice.createdAt).toISOString() };
        let outcome;
        try { outcome = await mailer(normalized); } catch { outcome = { accepted: false as const }; }
        if (outcome.accepted) {
            await tx.execute(sql`UPDATE ezil_feedback_notifications SET accepted_at = ${now.toISOString()}::timestamptz,
                provider_message_id = ${outcome.messageId}, attempts = attempts + 1 WHERE report_id = ${notice.reportId}::uuid`);
            return { accepted: 1, retry: 0, skipped: false };
        }
        // Retry indefinitely, with bounded exponential delay. No report is dropped
        // because the mail service is temporarily unavailable or misconfigured.
        const delayMs = Math.min(6 * 3_600_000, 60_000 * 2 ** Math.min(9, notice.attempts));
        await tx.execute(sql`UPDATE ezil_feedback_notifications SET attempts = attempts + 1,
            next_attempt_at = ${new Date(now.getTime() + delayMs).toISOString()}::timestamptz WHERE report_id = ${notice.reportId}::uuid`);
        return { accepted: 0, retry: 1, skipped: false };
    }, { isolationLevel: 'read committed' });
}
