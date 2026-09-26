import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { computerDataMountAuthorizations } from './computer-data-mounts';
import { computerConfigurations } from './computer-configurations';
import { computerInstances } from './computer-runtime';

/** Immutable reference reservation, never a key or proof that AWS created it.
 * id is the pinned Secrets Manager VersionId. One key per writer generation;
 * revocation cannot be undone or followed by implicit same-generation rotation.
 * Creation is attempted once; ambiguous retries observe instead of recreating.
 * Confirmation stores only the AWS reference, never the key. The issuer must
 * independently approve domain/KMS policy and provider state. */
export const computerControlBindings = pgTable('ezil_computer_control_bindings', {
    id: uuid('id').primaryKey().defaultRandom(), computerId: uuid('computer_id').notNull(),
    computerGeneration: integer('computer_generation').notNull(), creationMountId: uuid('creation_mount_id').notNull(),
    fenceToken: uuid('fence_token').notNull(), providerInstanceId: text('provider_instance_id').notNull(), dataVolumeId: text('data_volume_id').notNull(),
    accountId: text('account_id').notNull(), region: text('region').notNull().default('us-east-1'),
    namespace: text('namespace').notNull(), controlDomain: text('control_domain').notNull(), kmsKeyArn: text('kms_key_arn').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createAttemptedAt: timestamp('create_attempted_at', { withTimezone: true }),
    keyConfirmedAt: timestamp('key_confirmed_at', { withTimezone: true }), secretArn: text('secret_arn'),
}, t => [
    foreignKey({ name: 'ezil_control_binding_writer_fkey', columns: [t.computerId, t.computerGeneration],
        foreignColumns: [computerInstances.computerId, computerInstances.generation] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_control_binding_mount_fkey', columns: [t.creationMountId],
        foreignColumns: [computerDataMountAuthorizations.id] }).onDelete('restrict'),
    unique('ezil_control_binding_writer_uq').on(t.computerId, t.computerGeneration),
    unique('ezil_control_binding_scope_uq').on(t.id, t.computerId, t.computerGeneration),
    check('ezil_control_binding_creation_chk', sql.raw(`(key_confirmed_at IS NULL) = (secret_arn IS NULL)
        AND (key_confirmed_at IS NULL OR (create_attempted_at IS NOT NULL AND key_confirmed_at >= create_attempted_at))
        AND (secret_arn IS NULL OR secret_arn ~ ('^arn:aws:secretsmanager:' || region || ':' || account_id || ':secret:'
            || namespace || '/computers/' || computer_id::text || '/generations/' || computer_generation::text || '/control-[A-Za-z0-9]{6}$'))`)),
    check('ezil_control_binding_scope_chk', sql.raw("computer_generation >= 1 AND provider_instance_id ~ '^i-[a-f0-9]{17}$' AND data_volume_id ~ '^vol-[a-f0-9]{17}$'")),
    check('ezil_control_binding_reference_chk', sql.raw(`region = 'us-east-1' AND account_id ~ '^[0-9]{12}$'
        AND namespace ~ '^[a-z][a-z0-9-]{0,30}$' AND octet_length(control_domain) <= 190
        AND control_domain ~ '^([a-z0-9]([a-z0-9-]*[a-z0-9])?[.])+[a-z]{2,63}$'
        AND kms_key_arn ~ ('^arn:aws:kms:us-east-1:' || account_id || ':key/[a-f0-9-]{36}$')`)),
]).enableRLS();

/** A bounded host-start authorization, distinct from configuration reload.
 * SQL binds current prepared config, completed mount and unrevoked key scope.
 * API issuance must also recompile live OS/app authority and observe AWS. */
export const computerStartAuthorizations = pgTable('ezil_computer_start_authorizations', {
    id: uuid('id').primaryKey().defaultRandom(), computerId: uuid('computer_id').notNull(),
    computerGeneration: integer('computer_generation').notNull(), controlBindingId: uuid('control_binding_id').notNull(),
    configurationId: uuid('configuration_id').notNull(), mountAuthorizationId: uuid('mount_authorization_id').notNull(),
    providerObservedAt: timestamp('provider_observed_at', { withTimezone: true }).notNull(),
    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, t => [
    foreignKey({ name: 'ezil_start_authority_binding_fkey', columns: [t.controlBindingId, t.computerId, t.computerGeneration],
        foreignColumns: [computerControlBindings.id, computerControlBindings.computerId, computerControlBindings.computerGeneration] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_start_authority_configuration_fkey', columns: [t.configurationId, t.computerId],
        foreignColumns: [computerConfigurations.id, computerConfigurations.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_start_authority_mount_fkey', columns: [t.mountAuthorizationId],
        foreignColumns: [computerDataMountAuthorizations.id] }).onDelete('restrict'),
    uniqueIndex('ezil_start_authority_current_uidx').on(t.computerId).where(sql.raw('revoked_at IS NULL')),
    check('ezil_start_authority_generation_chk', sql.raw('computer_generation >= 1')),
    check('ezil_start_authority_lifetime_chk', sql.raw("expires_at = issued_at + interval '300 seconds' AND provider_observed_at BETWEEN issued_at - interval '30 seconds' AND issued_at + interval '5 seconds'")),
]).enableRLS();

/** Transactional queue and immutable historical receipt, never live readiness.
 * An expired grant is not renewed by extending a worker lease or retry count. */
export const computerStartDeliveries = pgTable('ezil_computer_start_deliveries', {
    authorizationId: uuid('authorization_id').primaryKey(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }), attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'), startedAt: timestamp('started_at', { withTimezone: true }), receipt: text('receipt'),
}, t => [
    foreignKey({ name: 'ezil_start_delivery_authority_fkey', columns: [t.authorizationId],
        foreignColumns: [computerStartAuthorizations.id] }).onDelete('restrict'),
    index('ezil_start_delivery_due_idx').on(t.availableAt).where(sql.raw('started_at IS NULL')),
    check('ezil_start_delivery_attempts_chk', sql.raw('attempts >= 0')),
    check('ezil_start_delivery_error_chk', sql.raw("error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'")),
    check('ezil_start_delivery_receipt_chk', sql.raw('(started_at IS NULL) = (receipt IS NULL) AND (receipt IS NULL OR octet_length(receipt) BETWEEN 2 AND 4096)')),
]).enableRLS();
