import { bigint, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/**
 * Native runtime control (`app/drizzle/0032_runtime_control.sql`, reserved, unapplied). The SQL file is
 * authoritative, including its checks and the guard trigger that refuses DELETE, TRUNCATE, identity changes and
 * illegal state moves; these tables mirror only columns and keys, for types. Written only by
 * `server/native-session/runtime-store.ts` through raw SQL. Server-only: RLS on, nothing granted to `anon` or
 * `authenticated`. No token, proof, credential or AI grant column.
 */
export const nativeRuntimeLeases = pgTable('ezil_native_runtime_leases', {
    controlAuthorizationId: uuid('control_authorization_id').primaryKey(),
    ownerUserId: uuid('owner_user_id').notNull(),
    clientId: text('client_id').notNull(),
    sessionId: uuid('session_id').notNull(),
    computerId: uuid('computer_id').notNull(),
    runtimeId: uuid('runtime_id'),
    hostEpoch: text('host_epoch'),
    placementGeneration: bigint('placement_generation', { mode: 'bigint' }).notNull(),
    placementLeaseEpoch: bigint('placement_lease_epoch', { mode: 'bigint' }).notNull(),
    placementInstanceId: text('placement_instance_id').notNull(),
    placementFenceToken: uuid('placement_fence_token').notNull(),
    profile: text('profile').notNull(),
    policyDigest: text('policy_digest'),
    /** The `0031` native AI authorization this lease was prepared under (`terms.authzId`). Identification only. */
    aiAuthorizationId: uuid('ai_authorization_id').notNull(),
    actionSet: text('action_set').notNull(),
    preparedRequestId: uuid('prepared_request_id').notNull(),
    leaseDigest: text('lease_digest').notNull(),
    state: text('state').notNull(),
    consentExpiresAt: timestamp('consent_expires_at', { withTimezone: true }).notNull(),
    controlDeadline: timestamp('control_deadline', { withTimezone: true }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
}).enableRLS();

export const nativeRuntimeRequests = pgTable(
    'ezil_native_runtime_requests',
    {
        ownerUserId: uuid('owner_user_id').notNull(),
        requestId: uuid('request_id').notNull(),
        clientId: text('client_id').notNull(),
        sessionId: uuid('session_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        kind: text('kind').notNull(),
        requestDigest: text('request_digest').notNull(),
        instructionDigest: text('instruction_digest'),
        instruction: text('instruction'),
        promptId: uuid('prompt_id'),
        promptRevision: integer('prompt_revision'),
        promptInputDigest: text('prompt_input_digest'),
        decision: text('decision'),
        message: text('message'),
        targetRequestId: uuid('target_request_id'),
        promptSnapshot: jsonb('prompt_snapshot'),
        controlAuthorizationId: uuid('control_authorization_id').references(() => nativeRuntimeLeases.controlAuthorizationId),
        requestDeadline: timestamp('request_deadline', { withTimezone: true }),
        state: text('state').notNull(),
        effect: text('effect').notNull(),
        reason: text('reason'),
        dispatchClaimedAt: timestamp('dispatch_claimed_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [primaryKey({ name: 'ezil_native_runtime_requests_pkey', columns: [t.ownerUserId, t.requestId] })],
).enableRLS();

export const nativeRuntimeTombstones = pgTable(
    'ezil_native_runtime_tombstones',
    {
        ownerUserId: uuid('owner_user_id').notNull(),
        targetRequestId: uuid('target_request_id').notNull(),
        sessionId: uuid('session_id').notNull(),
        clientId: text('client_id').notNull(),
        cancelRequestId: uuid('cancel_request_id').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    },
    (t) => [primaryKey({ name: 'ezil_native_runtime_tombstones_pkey', columns: [t.ownerUserId, t.targetRequestId] })],
).enableRLS();
