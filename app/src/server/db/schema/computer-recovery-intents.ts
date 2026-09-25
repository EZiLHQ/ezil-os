import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { computerLifecycleJobs, computerLifecycleOutbox, computerRuntimes } from './computer-runtime';

/** Recovery preserves an existing computer disk and reserves a fresh writer.
 * SQL checks recorded scope/fencing; the producer and workflow must independently
 * observe provider termination, disk ownership/tags and exclusive detachment. */
export const computerRecoveryIntents = pgTable('ezil_computer_recovery_intents', {
    jobId: uuid('job_id').primaryKey(), computerId: uuid('computer_id').notNull(),
    sourceJobId: uuid('source_job_id').notNull(), sourceSchemaVersion: integer('source_schema_version').notNull(),
    sourceDigest: text('source_digest').notNull(), revision: integer('revision').notNull(),
    targetGeneration: integer('target_generation').notNull(), fenceToken: uuid('fence_token').notNull(),
    dataVolumeId: text('data_volume_id').notNull(), dataGeneration: integer('data_generation').notNull(),
    dataFenceToken: uuid('data_fence_token').notNull(),
    outboxEvent: text('outbox_event').$type<'reconcile'>().notNull().default('reconcile'),
    deployment: text('deployment').notNull(), digest: text('digest').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
    foreignKey({ name: 'ezil_recovery_intents_job_fkey', columns: [table.jobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_recovery_intents_source_job_fkey', columns: [table.sourceJobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_recovery_intents_runtime_fkey', columns: [table.computerId], foreignColumns: [computerRuntimes.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_recovery_intents_outbox_fkey', columns: [table.jobId, table.outboxEvent],
        foreignColumns: [computerLifecycleOutbox.jobId, computerLifecycleOutbox.eventType] }).onDelete('restrict'),
    unique('ezil_recovery_intents_revision_uq').on(table.computerId, table.revision),
    unique('ezil_recovery_intents_digest_uq').on(table.jobId, table.digest),
    check('ezil_recovery_intents_generation_chk', sql.raw('revision >= 1 AND data_generation >= 1 AND target_generation > data_generation')),
    check('ezil_recovery_intents_source_chk', sql.raw('source_schema_version IN (1,2) AND source_job_id <> job_id AND fence_token <> data_fence_token')),
    check('ezil_recovery_intents_volume_chk', sql.raw("data_volume_id ~ '^vol-[a-f0-9]{17}$'")),
    check('ezil_recovery_intents_outbox_chk', sql.raw("outbox_event = 'reconcile'")),
    check('ezil_recovery_intents_deployment_chk', sql.raw('octet_length(deployment) BETWEEN 2 AND 8192')),
    check('ezil_recovery_intents_digest_chk', sql.raw("digest ~ '^[a-f0-9]{64}$' AND source_digest ~ '^[a-f0-9]{64}$'")),
]).enableRLS();
