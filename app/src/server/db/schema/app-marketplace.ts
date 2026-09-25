import { sql } from 'drizzle-orm';
import {
    check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text,
    timestamp, unique, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

import { authUsers } from './auth-users';
import { computers } from './computers';

/** All marketplace tables are service-only under RLS. The privileged API must
 * independently check OS access, computer ownership, roles and entitlements. */
export const appAdmins = pgTable('ezil_app_admins', {
    userId: uuid('user_id').primaryKey(),
    grantedBy: uuid('granted_by'),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
    foreignKey({ name: 'ezil_app_admins_user_fkey', columns: [table.userId], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_admins_granter_fkey', columns: [table.grantedBy], foreignColumns: [authUsers.id] }).onDelete('set null'),
]).enableRLS();

export const appPublishers = pgTable('ezil_app_publishers', {
    id: uuid('id').primaryKey().defaultRandom(),
    ownerUserId: uuid('owner_user_id').notNull(),
    displayName: text('display_name').notNull(),
    status: text('status').$type<'invited' | 'active' | 'revoked'>().notNull().default('invited'),
    invitedBy: uuid('invited_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
    foreignKey({ name: 'ezil_app_publishers_owner_fkey', columns: [table.ownerUserId], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_publishers_inviter_fkey', columns: [table.invitedBy], foreignColumns: [appAdmins.userId] }).onDelete('restrict'),
    unique('ezil_app_publishers_owner_uq').on(table.ownerUserId),
    check('ezil_app_publishers_name_chk', sql.raw("length(display_name) between 1 and 120")),
    check('ezil_app_publishers_status_chk', sql.raw("status in ('invited','active','revoked')")),
]).enableRLS();

export const apps = pgTable('ezil_apps', {
    id: uuid('id').primaryKey().defaultRandom(),
    publisherId: uuid('publisher_id').notNull(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    summary: text('summary').notNull(),
    category: text('category').notNull(),
    // This is a trusted, sanitized asset key, never a publisher-controlled URL.
    logoAssetKey: text('logo_asset_key'),
    visibility: text('visibility').$type<'grant-only' | 'all-authenticated'>().notNull().default('grant-only'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_apps_publisher_fkey', columns: [table.publisherId], foreignColumns: [appPublishers.id] }).onDelete('restrict'),
    unique('ezil_apps_slug_uq').on(table.slug),
    check('ezil_apps_slug_chk', sql.raw("slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 64")),
    check('ezil_apps_name_chk', sql.raw("length(name) between 1 and 80")),
    check('ezil_apps_summary_chk', sql.raw("length(summary) between 1 and 500")),
    check('ezil_apps_category_chk', sql.raw("length(category) between 1 and 60")),
    check('ezil_apps_visibility_chk', sql.raw("visibility in ('grant-only','all-authenticated')")),
]).enableRLS();

/** A release freezes its manifest, policy, source pin and image evidence.
 * Approval state is separate and may change without overwriting those bytes.
 * The migration installs a trigger to enforce that distinction in Postgres. */
export const appReleases = pgTable('ezil_app_releases', {
    id: uuid('id').primaryKey().defaultRandom(),
    appId: uuid('app_id').notNull(),
    version: text('version').notNull(),
    manifest: jsonb('manifest').$type<Record<string, unknown>>().notNull(),
    policy: jsonb('policy').$type<Record<string, unknown>>().notNull(),
    manifestDigest: text('manifest_digest').notNull(),
    policyDigest: text('policy_digest').notNull(),
    imageReference: text('image_reference').notNull(),
    provenanceDigest: text('provenance_digest').notNull(),
    sourceCommitSha: text('source_commit_sha'),
    status: text('status').$type<'draft' | 'validated' | 'approved' | 'rejected' | 'revoked'>().notNull().default('draft'),
    approvedBy: uuid('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_app_releases_app_fkey', columns: [table.appId], foreignColumns: [apps.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_releases_approver_fkey', columns: [table.approvedBy], foreignColumns: [appAdmins.userId] }).onDelete('restrict'),
    unique('ezil_app_releases_app_version_uq').on(table.appId, table.version),
    unique('ezil_app_releases_id_app_uq').on(table.id, table.appId),
    check('ezil_app_releases_version_chk', sql.raw("version ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]*$' AND length(version) <= 64")),
    check('ezil_app_releases_manifest_version_chk', sql.raw("coalesce(manifest->>'schemaVersion','') = '2' AND coalesce(policy->>'schemaVersion','') = '2'")),
    check('ezil_app_releases_digest_chk', sql.raw(
        "manifest_digest ~ '^sha256:[0-9a-f]{64}$' AND policy_digest ~ '^sha256:[0-9a-f]{64}$' AND provenance_digest ~ '^sha256:[0-9a-f]{64}$' AND image_reference ~ '@sha256:[0-9a-f]{64}$'",
    )),
    check('ezil_app_releases_source_pin_chk', sql.raw(
        "((coalesce(manifest #>> '{source,kind}','') = 'github') and source_commit_sha is not null and source_commit_sha ~ '^[0-9a-f]{40}$' and source_commit_sha = lower(coalesce(manifest #>> '{source,commitSha}',''))) or ((coalesce(manifest #>> '{source,kind}','') = 'oci') and source_commit_sha is null and image_reference = coalesce(manifest #>> '{source,image}',''))",
    )),
    check('ezil_app_releases_policy_image_chk', sql.raw("image_reference = coalesce(policy #>> '{image,reference}','')")),
    check('ezil_app_releases_status_chk', sql.raw("status in ('draft','validated','approved','rejected','revoked')")),
    check('ezil_app_releases_approval_chk', sql.raw(
        "(status in ('draft','validated','rejected') and approved_by is null and approved_at is null and revoked_at is null) or (status = 'approved' and approved_by is not null and approved_at is not null and revoked_at is null) or (status = 'revoked' and approved_by is not null and approved_at is not null and revoked_at is not null)",
    )),
]).enableRLS();

/** One current publication per app. The composite FK forbids pointing a
 * catalog entry at another app's release; publication/revocation triggers
 * additionally require an approved release. */
export const appPublications = pgTable('ezil_app_publications', {
    appId: uuid('app_id').primaryKey(),
    releaseId: uuid('release_id').notNull(),
    publishedBy: uuid('published_by').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_app_publications_app_fkey', columns: [table.appId], foreignColumns: [apps.id] }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_publications_release_app_fkey',
        columns: [table.releaseId, table.appId],
        foreignColumns: [appReleases.id, appReleases.appId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_publications_admin_fkey', columns: [table.publishedBy], foreignColumns: [appAdmins.userId] }).onDelete('restrict'),
]).enableRLS();

export const appGrants = pgTable('ezil_app_grants', {
    userId: uuid('user_id').notNull(),
    appId: uuid('app_id').notNull(),
    grantedBy: uuid('granted_by').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
    primaryKey({ name: 'ezil_app_grants_pk', columns: [table.userId, table.appId] }),
    foreignKey({ name: 'ezil_app_grants_user_fkey', columns: [table.userId], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_grants_app_fkey', columns: [table.appId], foreignColumns: [apps.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_grants_admin_fkey', columns: [table.grantedBy], foreignColumns: [appAdmins.userId] }).onDelete('restrict'),
]).enableRLS();

/** A URL starts inspection; it is never itself a build or run approval. URL
 * syntax, DNS and redirects require bounded runtime checks before fetching. */
export const appSubmissions = pgTable('ezil_app_submissions', {
    id: uuid('id').primaryKey().defaultRandom(),
    submittedBy: uuid('submitted_by').notNull(),
    appId: uuid('app_id'),
    repositoryUrl: text('repository_url').notNull(),
    requestedCommitSha: text('requested_commit_sha'),
    resolvedCommitSha: text('resolved_commit_sha'),
    status: text('status').$type<'queued' | 'inspecting' | 'needs-config' | 'building' | 'validated' | 'rejected' | 'cancelled'>()
        .notNull().default('queued'),
    inspection: jsonb('inspection').$type<Record<string, unknown>>(),
    errorCode: text('error_code'),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_app_submissions_submitter_fkey', columns: [table.submittedBy], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_submissions_app_fkey', columns: [table.appId], foreignColumns: [apps.id] }).onDelete('restrict'),
    unique('ezil_app_submissions_idempotency_uq').on(table.submittedBy, table.idempotencyKey),
    check('ezil_app_submissions_url_chk', sql.raw("length(repository_url) between 1 and 2048")),
    check('ezil_app_submissions_pin_chk', sql.raw(
        "(requested_commit_sha is null or requested_commit_sha ~ '^[0-9a-f]{40}$') AND (resolved_commit_sha is null or resolved_commit_sha ~ '^[0-9a-f]{40}$')",
    )),
    check('ezil_app_submissions_status_chk', sql.raw("status in ('queued','inspecting','needs-config','building','validated','rejected','cancelled')")),
    check('ezil_app_submissions_idempotency_chk', sql.raw("length(idempotency_key) between 1 and 128")),
]).enableRLS();

/** A computer owns an installation. A constant provider plus a composite FK
 * prevents a marketplace install from silently changing a legacy computer. */
export const appInstallations = pgTable('ezil_app_installations', {
    id: uuid('id').primaryKey().defaultRandom(),
    computerId: uuid('computer_id').notNull(),
    computerProvider: text('computer_provider').$type<'aws-ec2'>().notNull().default('aws-ec2'),
    appId: uuid('app_id').notNull(),
    releaseId: uuid('release_id').notNull(),
    installedBy: uuid('installed_by').notNull(),
    status: text('status').$type<'pending' | 'installed' | 'failed' | 'uninstalled'>().notNull().default('pending'),
    authGeneration: integer('auth_generation').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    installedAt: timestamp('installed_at', { withTimezone: true }),
    uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
}, (table) => [
    foreignKey({
        name: 'ezil_app_installations_computer_provider_fkey',
        columns: [table.computerId, table.computerProvider],
        foreignColumns: [computers.id, computers.provider],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_installations_owner_fkey',
        columns: [table.computerId, table.installedBy],
        foreignColumns: [computers.id, computers.userId],
    }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_installations_release_app_fkey',
        columns: [table.releaseId, table.appId],
        foreignColumns: [appReleases.id, appReleases.appId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_installations_installer_fkey', columns: [table.installedBy], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    unique('ezil_app_installations_id_computer_uq').on(table.id, table.computerId),
    uniqueIndex('ezil_app_installations_active_uidx').on(table.computerId, table.appId)
        .where(sql.raw('uninstalled_at is null')),
    check('ezil_app_installations_provider_chk', sql.raw("computer_provider = 'aws-ec2'")),
    check('ezil_app_installations_status_chk', sql.raw("status in ('pending','installed','failed','uninstalled')")),
    check('ezil_app_installations_generation_chk', sql.raw('auth_generation >= 1')),
    check('ezil_app_installations_uninstalled_chk', sql.raw("(status = 'uninstalled') = (uninstalled_at is not null)")),
]).enableRLS();

export const appServices = pgTable('ezil_app_services', {
    installationId: uuid('installation_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    name: text('name').notNull(),
    protocol: text('protocol').$type<'http'>().notNull().default('http'),
    scope: text('scope').$type<'installation' | 'selected-project'>().notNull(),
    internalPort: integer('internal_port').notNull(),
    preferredHostPort: integer('preferred_host_port'),
    healthPath: text('health_path').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    primaryKey({ name: 'ezil_app_services_pk', columns: [table.installationId, table.computerId, table.name] }),
    foreignKey({
        name: 'ezil_app_services_installation_computer_fkey',
        columns: [table.installationId, table.computerId],
        foreignColumns: [appInstallations.id, appInstallations.computerId],
    }).onDelete('restrict'),
    check('ezil_app_services_name_chk', sql.raw("name ~ '^[a-z][a-z0-9-]*$' AND length(name) <= 48")),
    check('ezil_app_services_protocol_chk', sql.raw("protocol = 'http'")),
    check('ezil_app_services_scope_chk', sql.raw("scope in ('installation','selected-project')")),
    check('ezil_app_services_ports_chk', sql.raw('internal_port between 1024 and 65535 AND (preferred_host_port is null or preferred_host_port between 1024 and 65535)')),
    check('ezil_app_services_health_chk', sql.raw("health_path like '/%' AND length(health_path) <= 256")),
]).enableRLS();

/** A lease survives stop/restart. Releasing it is a distinct recorded action;
 * partial indexes allow reuse only after the old lease is marked released. */
export const appPortLeases = pgTable('ezil_app_port_leases', {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    serviceName: text('service_name').notNull(),
    hostPort: integer('host_port').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp('released_at', { withTimezone: true }),
}, (table) => [
    foreignKey({
        name: 'ezil_app_port_leases_service_fkey',
        columns: [table.installationId, table.computerId, table.serviceName],
        foreignColumns: [appServices.installationId, appServices.computerId, appServices.name],
    }).onDelete('restrict'),
    uniqueIndex('ezil_app_port_leases_computer_port_uidx').on(table.computerId, table.hostPort)
        .where(sql.raw('released_at is null')),
    uniqueIndex('ezil_app_port_leases_service_uidx').on(table.installationId, table.serviceName)
        .where(sql.raw('released_at is null')),
    check('ezil_app_port_leases_port_chk', sql.raw('host_port between 1024 and 65535')),
]).enableRLS();

export const appFolderGrants = pgTable('ezil_app_folder_grants', {
    id: uuid('id').primaryKey().defaultRandom(),
    installationId: uuid('installation_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    folder: text('folder').$type<'Documents' | 'Projects' | 'Downloads'>().notNull(),
    scope: text('scope').$type<'whole-folder' | 'selected-projects'>().notNull(),
    projectId: uuid('project_id'),
    access: text('access').$type<'read' | 'read-write'>().notNull(),
    grantedBy: uuid('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
}, (table) => [
    foreignKey({
        name: 'ezil_app_folder_grants_installation_computer_fkey',
        columns: [table.installationId, table.computerId],
        foreignColumns: [appInstallations.id, appInstallations.computerId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_folder_grants_granter_fkey', columns: [table.grantedBy], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_folder_grants_owner_fkey',
        columns: [table.computerId, table.grantedBy],
        foreignColumns: [computers.id, computers.userId],
    }).onDelete('restrict'),
    uniqueIndex('ezil_app_folder_grants_whole_uidx').on(table.installationId, table.folder)
        .where(sql.raw("scope = 'whole-folder' and revoked_at is null")),
    uniqueIndex('ezil_app_folder_grants_project_uidx').on(table.installationId, table.folder, table.projectId)
        .where(sql.raw("scope = 'selected-projects' and revoked_at is null")),
    check('ezil_app_folder_grants_folder_chk', sql.raw("folder in ('Documents','Projects','Downloads')")),
    check('ezil_app_folder_grants_access_chk', sql.raw("access in ('read','read-write')")),
    check('ezil_app_folder_grants_scope_chk', sql.raw(
        "(scope = 'whole-folder' and project_id is null) or (scope = 'selected-projects' and folder = 'Projects' and project_id is not null)",
    )),
]).enableRLS();

/** Build/inspection jobs point to a submission; installation lifecycle jobs
 * point to an installation and its owning computer. Outbox has no payload. */
export const appJobs = pgTable('ezil_app_jobs', {
    id: uuid('id').primaryKey().defaultRandom(),
    submissionId: uuid('submission_id'),
    installationId: uuid('installation_id'),
    computerId: uuid('computer_id'),
    requestedBy: uuid('requested_by').notNull(),
    operation: text('operation').$type<'inspect' | 'build' | 'install' | 'start' | 'stop' | 'update' | 'uninstall'>().notNull(),
    status: text('status').$type<'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'>().notNull().default('queued'),
    idempotencyKey: text('idempotency_key').notNull(),
    errorCode: text('error_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
}, (table) => [
    foreignKey({ name: 'ezil_app_jobs_submission_fkey', columns: [table.submissionId], foreignColumns: [appSubmissions.id] }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_jobs_installation_computer_fkey',
        columns: [table.installationId, table.computerId],
        foreignColumns: [appInstallations.id, appInstallations.computerId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_jobs_requester_fkey', columns: [table.requestedBy], foreignColumns: [authUsers.id] }).onDelete('restrict'),
    uniqueIndex('ezil_app_jobs_submission_idempotency_uidx').on(table.submissionId, table.idempotencyKey)
        .where(sql.raw('submission_id is not null')),
    uniqueIndex('ezil_app_jobs_installation_idempotency_uidx').on(table.installationId, table.idempotencyKey)
        .where(sql.raw('installation_id is not null')),
    check('ezil_app_jobs_target_chk', sql.raw(
        "((operation in ('inspect','build') and submission_id is not null and installation_id is null and computer_id is null) or (operation in ('install','start','stop','update','uninstall') and submission_id is null and installation_id is not null and computer_id is not null))",
    )),
    check('ezil_app_jobs_status_chk', sql.raw("status in ('queued','running','succeeded','failed','cancelled')")),
    check('ezil_app_jobs_idempotency_chk', sql.raw('length(idempotency_key) between 1 and 128')),
]).enableRLS();

export const appOutbox = pgTable('ezil_app_outbox', {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id').notNull(),
    eventType: text('event_type').$type<'reconcile'>().notNull().default('reconcile'),
    availableAt: timestamp('available_at', { withTimezone: true }).notNull().defaultNow(),
    leaseUntil: timestamp('lease_until', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_app_outbox_job_fkey', columns: [table.jobId], foreignColumns: [appJobs.id] }).onDelete('restrict'),
    unique('ezil_app_outbox_job_event_uq').on(table.jobId, table.eventType),
    index('ezil_app_outbox_due_idx').on(table.availableAt).where(sql.raw('delivered_at is null')),
    check('ezil_app_outbox_event_chk', sql.raw("event_type = 'reconcile'")),
    check('ezil_app_outbox_attempts_chk', sql.raw('attempts >= 0')),
]).enableRLS();

/** Structured, redacted audit facts only. No free-form secret-bearing payload. */
export const appAuditEvents = pgTable('ezil_app_audit_events', {
    id: uuid('id').primaryKey().defaultRandom(),
    actorUserId: uuid('actor_user_id'),
    action: text('action').notNull(),
    appId: uuid('app_id'),
    releaseId: uuid('release_id'),
    submissionId: uuid('submission_id'),
    installationId: uuid('installation_id'),
    computerId: uuid('computer_id'),
    reasonCode: text('reason_code'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
    foreignKey({ name: 'ezil_app_audit_actor_fkey', columns: [table.actorUserId], foreignColumns: [authUsers.id] }).onDelete('set null'),
    foreignKey({ name: 'ezil_app_audit_app_fkey', columns: [table.appId], foreignColumns: [apps.id] }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_audit_release_app_fkey',
        columns: [table.releaseId, table.appId],
        foreignColumns: [appReleases.id, appReleases.appId],
    }).onDelete('restrict'),
    foreignKey({ name: 'ezil_app_audit_submission_fkey', columns: [table.submissionId], foreignColumns: [appSubmissions.id] }).onDelete('restrict'),
    foreignKey({
        name: 'ezil_app_audit_installation_computer_fkey',
        columns: [table.installationId, table.computerId],
        foreignColumns: [appInstallations.id, appInstallations.computerId],
    }).onDelete('restrict'),
    check('ezil_app_audit_action_chk', sql.raw('length(action) between 1 and 100')),
    check('ezil_app_audit_reason_chk', sql.raw('reason_code is null or length(reason_code) <= 100')),
    check('ezil_app_audit_scope_chk', sql.raw('(release_id is null or app_id is not null) and (installation_id is null or computer_id is not null)')),
]).enableRLS();
