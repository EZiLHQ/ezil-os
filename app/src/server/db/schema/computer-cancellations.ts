import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { authUsers } from './auth-users';
import { computerLifecycleJobs } from './computer-runtime';

/** Explicit immutable cancellation, never inferred from authority=false. The
 * producer must authenticate the stop request or verify current revocation.
 * SQL preserves admission/scope; only independent provider evidence can fence
 * writers or establish that an interrupted operation had no effects. */
export const computerCancellations = pgTable('ezil_computer_cancellations', {
    id: uuid('id').primaryKey().defaultRandom(), computerId: uuid('computer_id').notNull(),
    sourceJobId: uuid('source_job_id').notNull(), sourceSchemaVersion: integer('source_schema_version').notNull(),
    sourceDigest: text('source_digest').notNull(), sourceState: text('source_state').$type<'queued' | 'running'>().notNull().default('queued'),
    reason: text('reason').$type<'stop_requested' | 'authority_revoked'>().notNull(), requestedBy: uuid('requested_by'),
    workflowVersionArn: text('workflow_version_arn').notNull(), digest: text('digest').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
    foreignKey({ name: 'ezil_cancellations_source_fkey', columns: [table.sourceJobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_cancellations_requester_fkey', columns: [table.requestedBy], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    unique('ezil_cancellations_source_uq').on(table.sourceJobId),
    check('ezil_cancellations_version_chk', sql.raw('source_schema_version IN (1,2)')),
    check('ezil_cancellations_state_chk', sql.raw("source_state IN ('queued','running')")),
    check('ezil_cancellations_reason_chk', sql.raw("(reason='stop_requested' AND requested_by IS NOT NULL) OR (reason='authority_revoked' AND requested_by IS NULL)")),
    check('ezil_cancellations_digest_chk', sql.raw("digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$'")),
    check('ezil_cancellations_workflow_chk', sql.raw("workflow_version_arn ~ '^arn:aws:states:us-east-1:[0-9]{12}:stateMachine:[A-Za-z0-9_-]{1,80}:[1-9][0-9]*$'")),
]).enableRLS();

/** One durable delivery per cancellation. The cancellation supplies computer
 * scope; there is no second caller-selected computer or resource identifier. */
export const computerCancellationOutbox = pgTable('ezil_computer_cancellation_outbox', {
    cancellationId: uuid('cancellation_id').primaryKey(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }), attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }), errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
    foreignKey({ name: 'ezil_cancellation_outbox_intent_fkey', columns: [table.cancellationId], foreignColumns: [computerCancellations.id] }).onDelete('restrict'),
    index('ezil_cancellation_outbox_due_idx').on(table.availableAt).where(sql`${table.deliveredAt} IS NULL`),
    check('ezil_cancellation_outbox_attempts_chk', sql.raw('attempts >= 0')),
    check('ezil_cancellation_outbox_error_chk', sql.raw("error_code IS NULL OR error_code ~ '^[a-z_]{1,80}$'")),
]).enableRLS();
