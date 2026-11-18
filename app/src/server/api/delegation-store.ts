/**
 * Postgres side of `delegation-auth.ts`: the one-time `jti` ledger and the read-only account lookup.
 *
 * The ledger is in Postgres, not process memory, because many app instances serve requests and a replay must
 * be caught wherever it lands; the unique index makes "first use" atomic across concurrent requests. Its one
 * INSERT per accepted assertion is the only write here, and it is a security record: computer and account
 * data stay read-only. Either query failing, including a missing table, makes the verifier REJECT; nothing
 * here creates a table, an account or a link.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { DelegatedAccount, DelegatedIdentity } from './delegation-core';

export interface SqlExecutor {
    execute(query: SQL): Promise<ArrayLike<Record<string, unknown>>>;
}

/** True only for the first use of `jti`; false when it was already recorded. */
export async function consumeDelegationJti(db: SqlExecutor, jti: string, expiresAt: number): Promise<boolean> {
    if (!Number.isSafeInteger(expiresAt)) throw new TypeError('invalid expiry');
    const rows = await db.execute(sql`/* delegation:consume-jti */
        INSERT INTO public.ezil_delegation_replay (jti, expires_at)
        VALUES (${jti}::uuid, to_timestamp(${expiresAt}))
        ON CONFLICT (jti) DO NOTHING
        RETURNING jti`);
    return rows.length === 1;
}

/**
 * The ONE existing account for this identity, only if Supabase Auth would let it sign in: not deleted, not
 * banned, not anonymous, with a confirmed email or phone. A Supabase subject is the row's id; an EZiL ID subject
 * must already be linked in `raw_app_meta_data.auth0_sub` (admin metadata only OS's verified sign-in bridge
 * writes; never `raw_user_meta_data` or email). Two linked rows are a conflict, not a choice.
 */
export async function findDelegatedAccount(db: SqlExecutor, identity: DelegatedIdentity): Promise<DelegatedAccount | null> {
    const match = identity.issuer === 'supabase'
        ? sql`id = ${identity.subject}::uuid`
        : sql`raw_app_meta_data->>'auth0_sub' = ${identity.subject}`;
    const rows = await db.execute(sql`/* delegation:account */
        SELECT id::text AS id, created_at
        FROM auth.users
        WHERE ${match}
          AND deleted_at IS NULL
          AND (banned_until IS NULL OR banned_until <= now())
          AND is_anonymous IS NOT TRUE
          AND (email_confirmed_at IS NOT NULL OR phone_confirmed_at IS NOT NULL)
        LIMIT 2`);
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (typeof row.id !== 'string' || (identity.issuer === 'supabase' && row.id !== identity.subject)) return null;
    const created = row.created_at;
    const createdAt = created instanceof Date ? created.toISOString() : typeof created === 'string' ? created : null;
    return createdAt ? { id: row.id, createdAt } : null;
}
