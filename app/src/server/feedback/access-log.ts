import { sql } from 'drizzle-orm';

import { FEEDBACK_ACCESS_ACTIONS } from './types';

export interface FeedbackDb {
    execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export interface FeedbackAccess {
    reportId: string;
    adminUserId: string;
    action: (typeof FEEDBACK_ACCESS_ACTIONS)[number];
}

/** Awaited BEFORE content is read or a report is deleted. Never best-effort. */
export async function recordAccess(db: FeedbackDb, access: FeedbackAccess): Promise<void> {
    await db.execute(sql`
        INSERT INTO ezil_feedback_access_log (id, report_id, admin_user_id, action, created_at)
        VALUES (${crypto.randomUUID()}, ${access.reportId}, ${access.adminUserId}, ${access.action}, ${new Date()})
    `);
}
