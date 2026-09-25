import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { appInstallations, appJobs, appOutbox, appReleases } from './app-marketplace';
import { computerInstances } from './computer-runtime';
import { authUsers } from './auth-users';

/** Immutable host intent, committed with its job/outbox. The generation is a
 * per-installation command revision, not a browser authorization generation or
 * clock value. The migration serializes inserts on the installation row and
 * enforces consecutive revisions. Producers reuse identical current intent.
 *
 * A command is neither launch authorization nor evidence of a running service.
 * Start delivery must recheck ownership, grants, release, writer generation,
 * and the complete approved plan. Revocation must not prevent stopping already
 * owned resources using their recorded scope.
 * Secrets, arbitrary host paths and provider handles do not belong in a plan.
 */
export const appRuntimeCommands = pgTable('ezil_app_runtime_commands', {
    jobId: uuid('job_id').primaryKey(),
    installationId: uuid('installation_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    appId: uuid('app_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    computerGeneration: integer('computer_generation').notNull(),
    generation: integer('generation').notNull(),
    authGeneration: integer('auth_generation').notNull(),
    operation: text('operation').$type<'start' | 'stop'>().notNull(),
    outboxEvent: text('outbox_event').$type<'reconcile'>().notNull().default('reconcile'),
    plan: jsonb('plan').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({
        name: 'ezil_app_runtime_commands_installation_fkey',
        columns: [table.installationId, table.computerId, table.appId],
        foreignColumns: [appInstallations.id, appInstallations.computerId, appInstallations.appId],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_runtime_commands_release_fkey',
        columns: [table.releaseId, table.appId],
        foreignColumns: [appReleases.id, appReleases.appId],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_runtime_commands_writer_fkey',
        columns: [table.computerId, table.computerGeneration],
        foreignColumns: [computerInstances.computerId, computerInstances.generation],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_runtime_commands_job_fkey',
        columns: [table.jobId, table.installationId, table.computerId, table.operation],
        foreignColumns: [appJobs.id, appJobs.installationId, appJobs.computerId, appJobs.operation],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_runtime_commands_outbox_fkey',
        columns: [table.jobId, table.outboxEvent],
        foreignColumns: [appOutbox.jobId, appOutbox.eventType],
    }).onDelete('restrict'),
    unique('ezil_app_runtime_commands_revision_uq').on(table.installationId, table.generation),
    unique('ezil_app_runtime_commands_job_installation_uq').on(table.jobId, table.installationId),
    check('ezil_app_runtime_commands_generation_chk', sql.raw('generation >= 1 AND computer_generation >= 1 AND auth_generation >= 1')),
    check('ezil_app_runtime_commands_operation_chk', sql.raw("operation in ('start','stop') AND outbox_event = 'reconcile'")),
    check('ezil_app_runtime_commands_plan_chk', sql.raw(
        "jsonb_typeof(plan) = 'object' AND octet_length(plan::text) <= 49152 AND coalesce(plan->>'releaseId','') = release_id::text AND coalesce(plan->>'policyDigest','') ~ '^sha256:[0-9a-f]{64}$'",
    )),
]).enableRLS();

/** Different Open requests may reuse one running intent without allocating a
 * new revision. Retain every accepted request UUID so replaying it after Stop
 * still refers to the original intent and cannot accidentally restart an app. */
export const appRuntimeRequests = pgTable('ezil_app_runtime_requests', {
    installationId: uuid('installation_id').notNull(),
    requestId: uuid('request_id').notNull(),
    jobId: uuid('job_id').notNull(),
    requestedBy: uuid('requested_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ name: 'ezil_app_runtime_requests_pk', columns: [table.installationId, table.requestId] }),
    foreignKey({
        name: 'ezil_app_runtime_requests_command_fkey',
        columns: [table.jobId, table.installationId],
        foreignColumns: [appRuntimeCommands.jobId, appRuntimeCommands.installationId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_runtime_requests_requester_fkey', columns: [table.requestedBy], foreignColumns: [authUsers.id] })
        .onDelete('restrict'),
]).enableRLS();
