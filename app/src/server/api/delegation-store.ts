/**
 * Postgres side of `delegation-auth.ts`: the one-time `jti` ledger and the
 * account lookup. In Postgres, not process memory, because production runs
 * many app instances (docs/PLATFORM-NOTES.md §13) and a replay must be caught
 * whichever instance it lands on. The primary key makes "first use" atomic
 * across concurrent requests.
 *
 * Either query failing (including a missing table) makes the verifier REJECT.
 */
import { sql, type SQL } from 'drizzle-orm';

import type { DelegatedAccount, DelegatedIdentity } from './delegation-auth';

export interface SqlExecutor {
    execute(query: SQL): Promise<ArrayLike<Record<string, unknown>>>;
}

const PRUNE_EVERY_MS = 60_000;
let lastPrune = 0;

/** True only for the first use of `jti`; false when it was already recorded. */
export async function consumeDelegationJti(db: SqlExecutor, jti: string, expiresAt: number): Promise<boolean> {
    const rows = await db.execute(sql`/* delegation:consume-jti */
        INSERT INTO public.ezil_delegation_replay (jti, expires_at)
        VALUES (${jti}::uuid, to_timestamp(${expiresAt}))
        ON CONFLICT (jti) DO NOTHING
        RETURNING jti`);
    const first = rows.length === 1;
    if (first && Date.now() - lastPrune > PRUNE_EVERY_MS) {
        lastPrune = Date.now();
        // Expired entries can never be replayed (the assertion itself is expired), so they go.
        await db.execute(sql`/* delegation:prune */
            DELETE FROM public.ezil_delegation_replay WHERE expires_at < now() - interval '1 minute'`).catch(() => {});
    }
    return first;
}

/**
 * The ONE existing account for this identity, only if Supabase Auth would let
 * it sign in: not deleted, not banned, not anonymous, and with a confirmed
 * email or phone. A Supabase subject is the row's id; an EZiL ID subject must
 * already be linked in `app_metadata.auth0_sub` (which only OS's sign-in
 * bridge writes, after verifying the ID token), and two linked rows are a
 * conflict, not a choice. Never creates a row and never looks at email values.
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
    return { id: row.id, createdAt: created instanceof Date ? created.toISOString() : String(created ?? '') };
}
