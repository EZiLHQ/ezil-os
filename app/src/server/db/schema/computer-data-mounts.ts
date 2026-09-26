import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { computerInstances, computerLifecycleJobs } from './computer-runtime';

/** Trusted control-plane grants, not publisher declarations. SQL binds a grant
 * to a completed lifecycle job and the current writer/filesystem identity.
 * The issuer must still verify live OS access, deployment policy and actual
 * provider state. Stored observations and a UUID alone cannot authorize format. */
export const computerDataMountAuthorizations = pgTable('ezil_computer_data_mount_authorizations', {
    id: uuid('id').primaryKey().defaultRandom(), computerId: uuid('computer_id').notNull(),
    computerGeneration: integer('computer_generation').notNull(), lifecycleJobId: uuid('lifecycle_job_id').notNull(),
    fenceToken: uuid('fence_token').notNull(), providerInstanceId: text('provider_instance_id').notNull(),
    dataVolumeId: text('data_volume_id').notNull(), filesystemUuid: uuid('filesystem_uuid').notNull(),
    mode: text('mode').$type<'initialize' | 'mount'>().notNull(),
    digest: text('digest').notNull().default(''), providerObservedAt: timestamp('provider_observed_at', { withTimezone: true }).notNull(),
    // Database sets these from its clock. Revocation is the sole mutable field.
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, table => [
    foreignKey({ name: 'ezil_mount_authority_writer_fkey', columns: [table.computerId, table.computerGeneration],
        foreignColumns: [computerInstances.computerId, computerInstances.generation] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_mount_authority_job_fkey', columns: [table.lifecycleJobId, table.computerId],
        foreignColumns: [computerLifecycleJobs.id, computerLifecycleJobs.computerId] }).onDelete('restrict'),
    unique('ezil_mount_authority_job_uq').on(table.lifecycleJobId),
    uniqueIndex('ezil_mount_authority_initialization_uidx').on(table.computerId).where(sql.raw("mode = 'initialize'")),
    check('ezil_mount_authority_scope_chk', sql.raw("computer_generation >= 1 AND provider_instance_id ~ '^i-[a-f0-9]{17}$' AND data_volume_id ~ '^vol-[a-f0-9]{17}$'")),
    check('ezil_mount_authority_mode_chk', sql.raw("mode IN ('initialize','mount')")),
    check('ezil_mount_authority_digest_chk', sql.raw("digest ~ '^[a-f0-9]{64}$'")),
    check('ezil_mount_authority_lifetime_chk', sql.raw("expires_at = issued_at + interval '900 seconds' AND provider_observed_at BETWEEN issued_at - interval '30 seconds' AND issued_at + interval '5 seconds'")),
]).enableRLS();

/** Transactional delivery queue. A mounted receipt is historical evidence;
 * callers must still check current writer/access and application readiness.
 * Provider object versions and SSM operation handles belong to the transport's
 * immutable workflow state, not caller-selected queue payloads. */
export const computerDataMountDeliveries = pgTable('ezil_computer_data_mount_deliveries', {
    authorizationId: uuid('authorization_id').primaryKey(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }), attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'), mountedAt: timestamp('mounted_at', { withTimezone: true }), receipt: text('receipt'),
}, table => [
    foreignKey({ name: 'ezil_mount_delivery_authority_fkey', columns: [table.authorizationId],
        foreignColumns: [computerDataMountAuthorizations.id] }).onDelete('restrict'),
    index('ezil_mount_delivery_due_idx').on(table.availableAt).where(sql.raw('mounted_at IS NULL')),
    check('ezil_mount_delivery_attempts_chk', sql.raw('attempts >= 0')),
    check('ezil_mount_delivery_error_chk', sql.raw("error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'")),
    check('ezil_mount_delivery_receipt_chk', sql.raw('(mounted_at IS NULL) = (receipt IS NULL) AND (receipt IS NULL OR octet_length(receipt) BETWEEN 2 AND 4096)')),
]).enableRLS();
