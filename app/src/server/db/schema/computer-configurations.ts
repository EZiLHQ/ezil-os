import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { appInstallations, appJobs, appOutbox, appReleases } from './app-marketplace';
import { appRuntimeCommands } from './app-runtime-commands';
import { computerInstances } from './computer-runtime';

/** Exact serialized host configuration, compiled by the trusted controller.
 * The database-computed digest binds these bytes; producers must use the host's canonical
 * serialization so its authenticated loaded digest agrees. No keys, credentials
 * or publisher-authored host configuration belong here. Tables are service-only;
 * ownership/OS access/release/project authorization is still the producer's job.
 * SQL guards serialize consecutive revisions and retain immutable history. */
export const computerConfigurations = pgTable('ezil_computer_configurations', {
    id: uuid('id').primaryKey().defaultRandom(),
    computerId: uuid('computer_id').notNull(),
    computerGeneration: integer('computer_generation').notNull(),
    revision: integer('revision').notNull(),
    providerInstanceId: text('provider_instance_id').notNull(),
    fenceToken: uuid('fence_token').notNull(),
    dataVolumeId: text('data_volume_id').notNull(),
    configuration: text('configuration').notNull(),
    // The BEFORE INSERT guard replaces this default (and any supplied digest).
    // convert_to is STABLE in PostgreSQL, so a generated column cannot use it.
    digest: text('digest').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_computer_configurations_writer_fkey',
        columns: [table.computerId, table.computerGeneration],
        foreignColumns: [computerInstances.computerId, computerInstances.generation] }).onDelete('restrict'),
    unique('ezil_computer_configurations_revision_uq').on(table.computerId, table.revision),
    unique('ezil_computer_configurations_id_computer_uq').on(table.id, table.computerId),
    unique('ezil_computer_configurations_receipt_uq').on(table.id, table.digest),
    check('ezil_computer_configurations_generation_chk', sql.raw('computer_generation >= 1 AND revision >= 1')),
    check('ezil_computer_configurations_scope_chk', sql.raw("provider_instance_id ~ '^i-([0-9a-f]{8}|[0-9a-f]{17})$' AND data_volume_id ~ '^vol-([0-9a-f]{8}|[0-9a-f]{17})$'")),
    check('ezil_computer_configurations_size_chk', sql.raw('octet_length(configuration) BETWEEN 1 AND 262144')),
    check('ezil_computer_configurations_digest_chk', sql.raw("digest ~ '^[0-9a-f]{64}$'")),
    check('ezil_computer_configurations_envelope_chk', sql.raw(`COALESCE((
        jsonb_typeof(configuration::jsonb) = 'object'
        AND configuration::jsonb ?& ARRAY['schemaVersion','computerId','computerGeneration','configurationRevision','volumeId',
            'dataRoot','stateDirectory','stagingRoot','controlPort','memoryBudgetMiB','suspended','preparedInstallations','approvedInstallations']
        AND configuration::jsonb - ARRAY['schemaVersion','computerId','computerGeneration','configurationRevision','volumeId',
            'dataRoot','stateDirectory','stagingRoot','controlPort','memoryBudgetMiB','suspended','preparedInstallations','approvedInstallations'] = '{}'::jsonb
        AND configuration::jsonb->'schemaVersion' = '1'::jsonb
        AND configuration::jsonb->>'computerId' = computer_id::text
        AND configuration::jsonb->'computerGeneration' = to_jsonb(computer_generation)
        AND configuration::jsonb->'configurationRevision' = to_jsonb(revision)
        AND configuration::jsonb->>'volumeId' = data_volume_id
        AND jsonb_typeof(configuration::jsonb->'suspended') = 'boolean'
        AND jsonb_typeof(configuration::jsonb->'preparedInstallations') = 'array'
        AND jsonb_typeof(configuration::jsonb->'approvedInstallations') = 'array'
        AND jsonb_array_length(configuration::jsonb->'preparedInstallations') <= 128
        AND jsonb_array_length(configuration::jsonb->'approvedInstallations') <= 128
    ), false)`)),
]).enableRLS();

/** One binding per prepared installation, including every already-installed app
 * retained by the snapshot. An install job is optional for retained entries.
 * Execution authority is optional and must match an immutable Start command;
 * preparation without a selected project has no runtimeJobId. SQL checks exact
 * JSON membership and requires all members to be bound before commit. */
export const computerConfigurationInstallations = pgTable('ezil_computer_configuration_installations', {
    configurationId: uuid('configuration_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    installationId: uuid('installation_id').notNull(),
    appId: uuid('app_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    authGeneration: integer('auth_generation').notNull(),
    installJobId: uuid('install_job_id'),
    installOperation: text('install_operation').$type<'install'>().notNull().default('install'),
    installEvent: text('install_event').$type<'reconcile'>().notNull().default('reconcile'),
    runtimeJobId: uuid('runtime_job_id'),
}, (table) => [
    primaryKey({ name: 'ezil_computer_configuration_installations_pk', columns: [table.configurationId, table.installationId] }),
    foreignKey({ name: 'ezil_computer_configuration_installations_config_fkey',
        columns: [table.configurationId, table.computerId],
        foreignColumns: [computerConfigurations.id, computerConfigurations.computerId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_installations_scope_fkey',
        columns: [table.installationId, table.computerId, table.appId],
        foreignColumns: [appInstallations.id, appInstallations.computerId, appInstallations.appId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_installations_release_fkey',
        columns: [table.releaseId, table.appId], foreignColumns: [appReleases.id, appReleases.appId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_installations_install_job_fkey',
        columns: [table.installJobId, table.installationId, table.computerId, table.installOperation],
        foreignColumns: [appJobs.id, appJobs.installationId, appJobs.computerId, appJobs.operation] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_installations_runtime_job_fkey',
        columns: [table.runtimeJobId, table.installationId],
        foreignColumns: [appRuntimeCommands.jobId, appRuntimeCommands.installationId] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_installations_outbox_fkey',
        columns: [table.installJobId, table.installEvent],
        foreignColumns: [appOutbox.jobId, appOutbox.eventType] }).onDelete('restrict'),
    check('ezil_computer_configuration_installations_generation_chk', sql.raw('auth_generation >= 1')),
    check('ezil_computer_configuration_installations_operation_chk', sql.raw("install_operation = 'install' AND install_event = 'reconcile'")),
]).enableRLS();

/** Durable delivery outbox and historical receipt, not proof of current readiness.
 * Preparation and loaded acknowledgement are distinct. A consumer must validate
 * the signed host descriptor before writing loadedDigest; SQL then checks the
 * exact snapshot digest, latest revision, current writer and installation scope.
 * This schema does not itself mark an installation complete or start a resource. */
export const computerConfigurationDeliveries = pgTable('ezil_computer_configuration_deliveries', {
    configurationId: uuid('configuration_id').primaryKey(),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    errorCode: text('error_code'),
    preparedAt: timestamp('prepared_at', { withTimezone: true }),
    loadedAt: timestamp('loaded_at', { withTimezone: true }),
    loadedDigest: text('loaded_digest'),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
}, (table) => [
    foreignKey({ name: 'ezil_computer_configuration_deliveries_config_fkey', columns: [table.configurationId],
        foreignColumns: [computerConfigurations.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_computer_configuration_deliveries_digest_fkey', columns: [table.configurationId, table.loadedDigest],
        foreignColumns: [computerConfigurations.id, computerConfigurations.digest] }).onDelete('restrict'),
    index('ezil_computer_configuration_deliveries_due_idx').on(table.availableAt)
        .where(sql.raw('loaded_at IS NULL AND superseded_at IS NULL')),
    check('ezil_computer_configuration_deliveries_attempts_chk', sql.raw('attempts >= 0')),
    check('ezil_computer_configuration_deliveries_error_chk', sql.raw("error_code IS NULL OR error_code ~ '^[a-z][a-z0-9_]{1,63}$'")),
    check('ezil_computer_configuration_deliveries_receipt_chk', sql.raw(`
        (loaded_at IS NULL) = (loaded_digest IS NULL)
        AND (loaded_at IS NULL OR (prepared_at IS NOT NULL AND loaded_at >= prepared_at AND superseded_at IS NULL))
    `)),
]).enableRLS();
