import { sql } from 'drizzle-orm';
import { bigint, check, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

/**
 * Native session operations: one immutable (user, operation) tombstone per accepted create or renew. Mirrors
 * `app/drizzle/0029_native_session_operations.sql` (reserved, unapplied); the SQL file is authoritative, including
 * the row guard trigger that refuses DELETE, TRUNCATE, identity changes and illegal state moves, and
 * `server/native-session/authority.pg.test.ts` compares the two. Written only by `server/native-session/authority.ts`
 * through raw SQL. Server-only: RLS on, nothing granted to `anon` or `authenticated`. No token, proof or credential
 * column, and no foreign key, so a computer's deletion or reassignment can never prune an operation's identity.
 */
export const nativeSessionOperations = pgTable(
    'ezil_native_session_operations',
    {
        userId: uuid('user_id').notNull(),
        operationId: uuid('operation_id').notNull(),
        kind: text('kind').notNull(),
        sessionId: uuid('session_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        instructionRevision: bigint('instruction_revision', { mode: 'bigint' }).notNull(),
        instructionDigest: text('instruction_digest').notNull(),
        taskRef: text('task_ref').notNull(),
        /** sha256 of the canonical request semantics; the same operation id with another digest always conflicts. */
        requestDigest: text('request_digest').notNull(),
        /** The placement tuple authority admitted at claim time; delivery and renewal recheck the live tuple against it. */
        placementGeneration: bigint('placement_generation', { mode: 'bigint' }).notNull(),
        placementLeaseEpoch: bigint('placement_lease_epoch', { mode: 'bigint' }).notNull(),
        placementInstanceId: text('placement_instance_id').notNull(),
        placementFenceToken: uuid('placement_fence_token').notNull(),
        state: text('state').notNull(),
        reason: text('reason'),
        /** Receipt only (the Gateway's grant id and expiry); the grant itself is never stored. */
        grantId: uuid('grant_id'),
        grantExpiresAt: timestamp('grant_expires_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
    },
    (t) => [
        primaryKey({ name: 'ezil_native_session_operations_pkey', columns: [t.userId, t.operationId] }),
        uniqueIndex('ezil_native_session_operations_one_create').on(t.userId, t.sessionId).where(sql`kind = 'create'`),
        index('ezil_native_session_operations_session').on(t.userId, t.sessionId, t.createdAt, t.operationId),
        check('ezil_native_session_operations_kind_check', sql`kind IN ('create', 'renew')`),
        check('ezil_native_session_operations_revision_check', sql`instruction_revision >= 1`),
        check('ezil_native_session_operations_instruction_digest_check', sql`instruction_digest ~ '^sha256:[0-9a-f]{64}$'`),
        check('ezil_native_session_operations_task_ref_check', sql`task_ref ~ '^[a-z0-9][a-z0-9._:-]{0,127}$'`),
        check('ezil_native_session_operations_request_digest_check', sql`request_digest ~ '^sha256:[0-9a-f]{64}$'`),
        check('ezil_native_session_operations_placement_check', sql`placement_generation >= 0 AND placement_lease_epoch >= 0
            AND placement_instance_id ~ '^i-[0-9a-f]{8,17}$'`),
        check('ezil_native_session_operations_state_check', sql`state IN ('claimed', 'exchanging', 'exchange_refused',
            'exchange_unknown', 'granted', 'authority_changed', 'delivering', 'delivered', 'host_refused', 'delivery_unknown')`),
        check('ezil_native_session_operations_reason_check', sql`(reason IS NULL) = (state IN ('claimed', 'exchanging',
            'granted', 'delivering', 'delivered')) AND (reason IS NULL OR reason ~ '^[a-z][a-z0-9_]{0,63}$')`),
        check('ezil_native_session_operations_grant_check', sql`(grant_id IS NULL) = (grant_expires_at IS NULL)
            AND (grant_id IS NULL) = (state IN ('claimed', 'exchanging', 'exchange_refused', 'exchange_unknown'))`),
    ],
).enableRLS();

export type NativeSessionOperationRow = typeof nativeSessionOperations.$inferSelect;
