import { boolean, customType, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * In-product feedback (`docs/FEEDBACK-CONTROLS-CONTRACT.md` §4).
 *
 * Shaped by the production migration grammar
 * (`.github/scripts/production-migrations.mjs` `additiveSQL`): NO primary
 * keys, defaults, constraints or policies. Ids are app-generated UUIDv4,
 * every timestamp is written by the app, RLS is enabled with every client
 * role revoked, so only the app's server role reads. HARD-DELETE-ONLY:
 * retention and user deletion run `DELETE`. Mirrors
 * `app/src/server/feedback/migration-sql.ts` column for column.
 */

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => 'bytea',
});

export const feedbackReports = pgTable(
    'ezil_feedback_reports',
    {
        id: uuid('id').notNull(),
        userId: uuid('user_id').notNull(),
        computerId: uuid('computer_id'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        category: text('category').notNull(),
        description: text('description').notNull(),
        diagnostics: jsonb('diagnostics'),
        clientRequestId: uuid('client_request_id').notNull(),
        shellVersion: text('shell_version'),
        status: text('status').notNull(),
        redactionCount: integer('redaction_count').notNull(),
        hasScreenshot: boolean('has_screenshot').notNull(),
        /** Deployed commit when the report arrived (server-stamped; null if unknown). */
        deploySha: text('deploy_sha'),
    },
    (t) => [
        index('ezil_feedback_reports_user_created').on(t.userId, t.createdAt),
        index('ezil_feedback_reports_id').on(t.id),
    ],
);

export const feedbackAttachments = pgTable(
    'ezil_feedback_attachments',
    {
        reportId: uuid('report_id').notNull(),
        userId: uuid('user_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        contentType: text('content_type').notNull(),
        sha256: text('sha256').notNull(),
        byteLength: integer('byte_length').notNull(),
        bytes: bytea('bytes').notNull(),
    },
    (t) => [
        index('ezil_feedback_attachments_report').on(t.reportId),
        index('ezil_feedback_attachments_created').on(t.createdAt),
    ],
);

export const feedbackAccessLog = pgTable(
    'ezil_feedback_access_log',
    {
        id: uuid('id').notNull(),
        reportId: uuid('report_id').notNull(),
        adminUserId: uuid('admin_user_id').notNull(),
        action: text('action').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    },
    (t) => [index('ezil_feedback_access_log_report').on(t.reportId, t.createdAt)],
);
