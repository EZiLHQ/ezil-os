import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Native authorization intents: one immutable (owner, operation) row per prepared create or renew, decided
 * once by its owner's normal-cookie consent. Mirrors `app/drizzle/0031_native_auth_intents.sql` (reserved,
 * unapplied); the SQL file is authoritative, including the guard triggers. Written only by
 * `server/native-auth/store.ts` through raw SQL. Server-only: RLS on, nothing granted to `anon` or
 * `authenticated`. `instruction` is private owner text: never a receipt, URL, error or log.
 */
export const nativeAuthIntents = pgTable(
    'ezil_native_auth_intents',
    {
        userId: uuid('user_id').notNull(),
        operationId: uuid('operation_id').notNull(),
        kind: text('kind').notNull(),
        sessionId: uuid('session_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        instructionRevision: bigint('instruction_revision', { mode: 'bigint' }),
        instructionDigest: text('instruction_digest'),
        instruction: text('instruction'),
        instructionBytes: integer('instruction_bytes'),
        /** sha256 of the canonical prepared input; the same operation id with another digest always conflicts. */
        inputDigest: text('input_digest').notNull(),
        clientId: text('client_id').notNull(),
        idpIssuer: text('idp_issuer').notNull(),
        subject: text('subject').notNull(),
        scope: text('scope').notNull(),
        state: text('state').notNull(),
        reason: text('reason'),
        /** Finite consent terms, all or none, written once on approval (a renewal copies its create's terms). */
        authzId: uuid('authz_id'),
        consentEpoch: text('consent_epoch'),
        budgetMicro: text('budget_micro'),
        policyId: uuid('policy_id'),
        service: text('service'),
        profile: text('profile'),
        initialApprovalAt: timestamp('initial_approval_at', { withTimezone: true }),
        authorizationDeadline: timestamp('authorization_deadline', { withTimezone: true }),
        /** The full placement tuple pinned at approval under the owner and computer locks (a renewal copies it). */
        approvedPlacementGeneration: bigint('approved_placement_generation', { mode: 'bigint' }),
        approvedPlacementLeaseEpoch: bigint('approved_placement_lease_epoch', { mode: 'bigint' }),
        approvedPlacementInstanceId: text('approved_placement_instance_id'),
        approvedPlacementFenceToken: uuid('approved_placement_fence_token'),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
        decidedAt: timestamp('decided_at', { withTimezone: true }),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
        primaryKey({ name: 'ezil_native_auth_intents_pkey', columns: [t.userId, t.operationId] }),
        uniqueIndex('ezil_native_auth_intents_one_create').on(t.userId, t.sessionId).where(sql`kind = 'create'`),
        check('ezil_native_auth_intents_kind_check', sql`kind IN ('create', 'renew')`),
        check('ezil_native_auth_intents_instruction_check', sql`(CASE kind
        WHEN 'create' THEN instruction_revision IS NOT NULL AND instruction_digest IS NOT NULL AND instruction IS NOT NULL
            AND instruction_bytes IS NOT NULL AND instruction_revision = 1 AND instruction_digest ~ '^sha256:[0-9a-f]{64}$'
            AND instruction_bytes = octet_length(instruction) AND instruction_bytes BETWEEN 1 AND 16384
        ELSE instruction_revision IS NULL AND instruction_digest IS NULL AND instruction IS NULL AND instruction_bytes IS NULL END) IS TRUE`),
        check('ezil_native_auth_intents_input_digest_check', sql`input_digest ~ '^sha256:[0-9a-f]{64}$'`),
        check('ezil_native_auth_intents_actor_check', sql`length(client_id) BETWEEN 1 AND 256 AND length(idp_issuer) BETWEEN 1 AND 512
        AND length(subject) BETWEEN 1 AND 256 AND scope ~ '^[\\x21-\\x7e]+( [\\x21-\\x7e]+)*$' AND length(scope) <= 1024`),
        check('ezil_native_auth_intents_state_check', sql`state IN ('required', 'approved', 'denied', 'expired', 'blocked')`),
        check('ezil_native_auth_intents_reason_check', sql`(reason IS NULL) = (state <> 'blocked')
        AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')`),
        check('ezil_native_auth_intents_expiry_check', sql`expires_at = created_at + interval '5 minutes'`),
        check('ezil_native_auth_intents_decided_check', sql`(decided_at IS NULL) = (state = 'required')`),
        check('ezil_native_auth_intents_terms_check', sql`(
        (authz_id IS NULL AND consent_epoch IS NULL AND budget_micro IS NULL AND policy_id IS NULL AND service IS NULL AND profile IS NULL
            AND initial_approval_at IS NULL AND authorization_deadline IS NULL AND approved_placement_generation IS NULL
            AND approved_placement_lease_epoch IS NULL AND approved_placement_instance_id IS NULL AND approved_placement_fence_token IS NULL)
        OR (authz_id IS NOT NULL AND consent_epoch IS NOT NULL AND budget_micro IS NOT NULL AND policy_id IS NOT NULL AND service IS NOT NULL
            AND profile IS NOT NULL AND initial_approval_at IS NOT NULL AND authorization_deadline IS NOT NULL
            AND approved_placement_generation IS NOT NULL AND approved_placement_lease_epoch IS NOT NULL
            AND approved_placement_instance_id IS NOT NULL AND approved_placement_fence_token IS NOT NULL
            AND approved_placement_generation >= 1 AND approved_placement_lease_epoch >= 1
            AND approved_placement_instance_id ~ '^i-[0-9a-f]{8,17}$'
            AND state IN ('approved', 'blocked') AND consent_epoch ~ '^[1-9][0-9]{0,18}$' AND budget_micro ~ '^[1-9][0-9]{0,18}$'
            AND service = 'ezil-os-native' AND profile = 'ezil-native-claude-v1'
            AND initial_approval_at = date_trunc('milliseconds', initial_approval_at)
            AND authorization_deadline = date_trunc('milliseconds', authorization_deadline)
            AND authorization_deadline > initial_approval_at AND authorization_deadline <= initial_approval_at + interval '24 hours')
    ) IS TRUE`),
    ],
).enableRLS();

/**
 * The owner's local STOP of a whole AI consent: a terminal, insert-only tombstone per (owner, authorization). Once
 * present, the consent binding is unreadable and no renewal derives from it; existing operations are untouched.
 */
export const nativeConsentRevocations = pgTable(
    'ezil_native_consent_revocations',
    {
        userId: uuid('user_id').notNull(),
        authzId: uuid('authz_id').notNull(),
        consentOperationId: uuid('consent_operation_id').notNull(),
        /** Stable id for the Gateway-side revocation of this consent. */
        gatewayRevokeOperationId: uuid('gateway_revoke_operation_id').notNull(),
        sessionId: uuid('session_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        clientId: text('client_id').notNull(),
        policyId: uuid('policy_id').notNull(),
        consentEpoch: text('consent_epoch').notNull(),
        budgetMicro: text('budget_micro').notNull(),
        initialApprovalAt: timestamp('initial_approval_at', { withTimezone: true }).notNull(),
        authorizationDeadline: timestamp('authorization_deadline', { withTimezone: true }).notNull(),
        approvedPlacementGeneration: bigint('approved_placement_generation', { mode: 'bigint' }).notNull(),
        approvedPlacementLeaseEpoch: bigint('approved_placement_lease_epoch', { mode: 'bigint' }).notNull(),
        approvedPlacementInstanceId: text('approved_placement_instance_id').notNull(),
        approvedPlacementFenceToken: uuid('approved_placement_fence_token').notNull(),
        revokedAt: timestamp('revoked_at', { withTimezone: true }).notNull(),
    },
    (t) => [
        primaryKey({ name: 'ezil_native_consent_revocations_pkey', columns: [t.userId, t.authzId] }),
        unique('ezil_native_consent_revocations_consent_key').on(t.userId, t.consentOperationId),
        unique('ezil_native_consent_revocations_gateway_key').on(t.gatewayRevokeOperationId),
        foreignKey({ name: 'ezil_native_consent_revocations_consent_fkey', columns: [t.userId, t.consentOperationId],
            foreignColumns: [nativeAuthIntents.userId, nativeAuthIntents.operationId] }).onUpdate('restrict').onDelete('restrict'),
    ],
).enableRLS();

/** The private task a consented create intent admits, sealed once from the approved intent. Never updated or deleted. */
export const nativeTaskArtifacts = pgTable(
    'ezil_native_task_artifacts',
    {
        userId: uuid('user_id').notNull(),
        taskRef: text('task_ref').notNull(),
        operationId: uuid('operation_id').notNull(),
        sessionId: uuid('session_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        instructionRevision: bigint('instruction_revision', { mode: 'bigint' }).notNull(),
        instructionDigest: text('instruction_digest').notNull(),
        instruction: text('instruction').notNull(),
        instructionBytes: integer('instruction_bytes').notNull(),
        sealedAt: timestamp('sealed_at', { withTimezone: true }).notNull(),
    },
    (t) => [
        primaryKey({ name: 'ezil_native_task_artifacts_pkey', columns: [t.userId, t.taskRef] }),
        unique('ezil_native_task_artifacts_operation_key').on(t.userId, t.operationId),
        foreignKey({ name: 'ezil_native_task_artifacts_intent_fkey', columns: [t.userId, t.operationId],
            foreignColumns: [nativeAuthIntents.userId, nativeAuthIntents.operationId] }).onUpdate('restrict').onDelete('restrict'),
        check('ezil_native_task_artifacts_task_ref_check', sql`task_ref = 'native-task:' || operation_id::text`),
        check('ezil_native_task_artifacts_instruction_check', sql`instruction_revision = 1
        AND instruction_digest ~ '^sha256:[0-9a-f]{64}$' AND instruction_bytes = octet_length(instruction)
        AND instruction_bytes BETWEEN 1 AND 16384`),
    ],
).enableRLS();
