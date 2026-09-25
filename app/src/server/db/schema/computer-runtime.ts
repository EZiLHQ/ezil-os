import { sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
    index,
    integer,
    pgTable,
    primaryKey,
    text,
    timestamp,
    unique,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';

import { authUsers } from './auth-users';
import { computers } from './computers';

/** The AWS disk association belongs to a computer, never to a browser session.
 * A null volume/AZ pair means provisioning has not finished. Runtime APIs must
 * still verify computer ownership and a provider-observed detach before fencing
 * an old instance; database constraints alone cannot prove an EBS detach. */
export const computerRuntimes = pgTable('ezil_computer_runtimes', {
    computerId: uuid('computer_id').primaryKey(),
    provider: text('provider').$type<'aws-ec2'>().notNull().default('aws-ec2'),
    region: text('region').notNull(),
    availabilityZone: text('availability_zone'),
    dataVolumeId: text('data_volume_id').unique('ezil_computer_runtimes_volume_uq'),
    nextGeneration: integer('next_generation').notNull().default(1),
    desiredState: text('desired_state').$type<'stopped' | 'running' | 'retired'>().notNull().default('stopped'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({
        name: 'ezil_computer_runtimes_computer_provider_fkey',
        columns: [table.computerId, table.provider],
        foreignColumns: [computers.id, computers.provider],
    }).onDelete('restrict'),
    check('ezil_computer_runtimes_provider_chk', sql`${table.provider} = 'aws-ec2'`),
    check('ezil_computer_runtimes_generation_chk', sql`${table.nextGeneration} >= 1`),
    check('ezil_computer_runtimes_state_chk', sql`${table.desiredState} in ('stopped', 'running', 'retired')`),
    check('ezil_computer_runtimes_volume_az_chk', sql`(${table.dataVolumeId} is null) = (${table.availabilityZone} is null)`),
]).enableRLS();

/** One row per launch attempt. A writer slot is held until a controller records
 * fencing after observing provider stop/detach. Changing observed state alone
 * cannot free it, including when a callback arrives late or out of order. */
export const computerInstances = pgTable('ezil_computer_instances', {
    computerId: uuid('computer_id').notNull(),
    generation: integer('generation').notNull(),
    providerInstanceId: text('provider_instance_id').unique('ezil_computer_instances_provider_id_uq'),
    fenceToken: uuid('fence_token').notNull().defaultRandom(),
    observedState: text('observed_state').$type<'pending' | 'starting' | 'running' | 'stopping' | 'stopped' | 'failed'>()
        .notNull().default('pending'),
    observedAt: timestamp('observed_at', { withTimezone: true }),
    fencedAt: timestamp('fenced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ name: 'ezil_computer_instances_pk', columns: [table.computerId, table.generation] }),
    foreignKey({
        name: 'ezil_computer_instances_runtime_fkey',
        columns: [table.computerId],
        foreignColumns: [computerRuntimes.computerId],
    }).onDelete('restrict'),
    uniqueIndex('ezil_computer_instances_single_writer_uidx').on(table.computerId)
        .where(sql`${table.fencedAt} is null`),
    check('ezil_computer_instances_generation_chk', sql`${table.generation} >= 1`),
    check('ezil_computer_instances_state_chk', sql`${table.observedState} in ('pending', 'starting', 'running', 'stopping', 'stopped', 'failed')`),
]).enableRLS();

/** Durable, server-derived lifecycle intent. An idempotency key is scoped to
 * one computer; callers cannot supply EC2 IDs, volume IDs, or arbitrary work. */
export const computerLifecycleJobs = pgTable('ezil_computer_lifecycle_jobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    computerId: uuid('computer_id').notNull(),
    requestedBy: uuid('requested_by'),
    operation: text('operation').$type<'provision' | 'start' | 'stop' | 'replace' | 'retire' | 'migrate' | 'recover'>().notNull(),
    status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    targetGeneration: integer('target_generation'),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
    foreignKey({ name: 'ezil_computer_lifecycle_jobs_computer_fkey', columns: [table.computerId], foreignColumns: [computers.id] })
        .onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_lifecycle_jobs_requester_fkey', columns: [table.requestedBy], foreignColumns: [authUsers.id] })
        .onDelete('set null'),
    unique('ezil_computer_lifecycle_jobs_computer_idempotency_uq').on(table.computerId, table.idempotencyKey),
    unique('ezil_computer_lifecycle_jobs_id_computer_uq').on(table.id, table.computerId),
    check('ezil_computer_lifecycle_jobs_operation_chk', sql`${table.operation} in ('provision', 'start', 'stop', 'replace', 'retire', 'migrate', 'recover')`),
    check('ezil_computer_lifecycle_jobs_status_chk', sql`${table.status} in ('queued', 'running', 'succeeded', 'failed', 'cancelled')`),
    check('ezil_computer_lifecycle_jobs_generation_chk', sql`${table.targetGeneration} is null or ${table.targetGeneration} >= 1`),
    check('ezil_computer_lifecycle_jobs_idempotency_chk', sql`length(${table.idempotencyKey}) between 1 and 128`),
]).enableRLS();

/** Transactional outbox: a consumer fetches the canonical job and runtime by
 * ID. No untrusted payload or provider credential is stored in an event. */
export const computerLifecycleOutbox = pgTable('ezil_computer_lifecycle_outbox', {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    eventType: text('event_type').$type<'reconcile'>().notNull().default('reconcile'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({
        name: 'ezil_computer_lifecycle_outbox_job_computer_fkey',
        columns: [table.jobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId],
    }).onDelete('restrict'),
    unique('ezil_computer_lifecycle_outbox_job_event_uq').on(table.jobId, table.eventType),
    index('ezil_computer_lifecycle_outbox_due_idx').on(table.availableAt)
        .where(sql`${table.deliveredAt} is null`),
    check('ezil_computer_lifecycle_outbox_event_chk', sql`${table.eventType} = 'reconcile'`),
    check('ezil_computer_lifecycle_outbox_attempts_chk', sql`${table.attempts} >= 0`),
]).enableRLS();
