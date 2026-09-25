import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { computerInstances, computerLifecycleJobs, computerLifecycleOutbox, computerRuntimes } from './computer-runtime';

/** Immutable, server-created provider intent. The workflow receives its job ID
 * and this digest, not caller-selected EC2/volume handles. SQL reserves a new
 * generation for provision/replace without freeing the previous writer slot.
 * Current ownership, OS access and admission are still controller checks. */
export const computerLifecycleIntents = pgTable('ezil_computer_lifecycle_intents', {
    jobId: uuid('job_id').primaryKey(), computerId: uuid('computer_id').notNull(),
    revision: integer('revision').notNull(),
    operation: text('operation').$type<'provision' | 'start' | 'stop' | 'replace' | 'retire'>().notNull(),
    targetGeneration: integer('target_generation').notNull(), fenceToken: uuid('fence_token').notNull(),
    providerInstanceId: text('provider_instance_id'), dataVolumeId: text('data_volume_id'),
    previousGeneration: integer('previous_generation'), previousInstanceId: text('previous_instance_id'),
    previousFenceToken: uuid('previous_fence_token'),
    outboxEvent: text('outbox_event').$type<'reconcile'>().notNull().default('reconcile'),
    deployment: text('deployment').notNull(), digest: text('digest').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
    foreignKey({ name: 'ezil_lifecycle_intents_job_fkey', columns: [table.jobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_lifecycle_intents_runtime_fkey', columns: [table.computerId],
        foreignColumns: [computerRuntimes.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_lifecycle_intents_outbox_fkey', columns: [table.jobId, table.outboxEvent],
        foreignColumns: [computerLifecycleOutbox.jobId, computerLifecycleOutbox.eventType] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_lifecycle_intents_previous_fkey', columns: [table.computerId, table.previousGeneration],
        foreignColumns: [computerInstances.computerId, computerInstances.generation] }).onDelete('restrict'),
    unique('ezil_lifecycle_intents_revision_uq').on(table.computerId, table.revision),
    unique('ezil_lifecycle_intents_digest_uq').on(table.jobId, table.digest),
    check('ezil_lifecycle_intents_generation_chk', sql.raw('revision >= 1 AND target_generation >= 1')),
    check('ezil_lifecycle_intents_outbox_chk', sql.raw("outbox_event = 'reconcile'")),
    check('ezil_lifecycle_intents_scope_chk', sql.raw(`
        (provider_instance_id IS NULL OR provider_instance_id ~ '^i-[a-f0-9]{17}$')
        AND (data_volume_id IS NULL OR data_volume_id ~ '^vol-[a-f0-9]{17}$')
        AND (previous_instance_id IS NULL OR previous_instance_id ~ '^i-[a-f0-9]{17}$')`)),
    check('ezil_lifecycle_intents_shape_chk', sql.raw(`
        (operation = 'provision' AND provider_instance_id IS NULL AND data_volume_id IS NULL
            AND previous_generation IS NULL AND previous_instance_id IS NULL AND previous_fence_token IS NULL)
        OR (operation IN ('start','stop','retire') AND provider_instance_id IS NOT NULL AND data_volume_id IS NOT NULL
            AND previous_generation IS NULL AND previous_instance_id IS NULL AND previous_fence_token IS NULL)
        OR (operation = 'replace' AND provider_instance_id IS NULL AND data_volume_id IS NOT NULL
            AND previous_generation IS NOT NULL AND previous_generation >= 1 AND previous_generation < target_generation
            AND previous_instance_id IS NOT NULL AND previous_fence_token IS NOT NULL)`)),
    check('ezil_lifecycle_intents_deployment_size_chk', sql.raw('octet_length(deployment) BETWEEN 2 AND 8192')),
    check('ezil_lifecycle_intents_digest_chk', sql.raw("digest ~ '^[a-f0-9]{64}$'")),
]).enableRLS();
