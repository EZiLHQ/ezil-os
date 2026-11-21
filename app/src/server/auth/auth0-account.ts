import 'server-only';

import type { SupabaseClient } from '@supabase/supabase-js';
import { sql } from 'drizzle-orm';

import { Auth0Error, type Auth0Identity } from './auth0';

type Admin = SupabaseClient['auth']['admin'];

type Auth0Account = { id: string; linked: boolean; sameEmail: boolean; active: boolean };

export async function createVerifiedAuth0Account(admin: Admin, { sub, email }: Auth0Identity) {
    const { data, error } = await admin.createUser({
        email: email.toLowerCase(), email_confirm: true, app_metadata: { auth0_sub: sub },
    });
    if (error || !data.user) throw new Auth0Error('session_failed');
    return data.user;
}

interface AccountLookup {
    execute(query: ReturnType<typeof sql>): Promise<ArrayLike<Auth0Account>>;
}
interface AccountDatabase {
    transaction<T>(operation: (tx: AccountLookup) => Promise<T>): Promise<T>;
}

async function accountMatches(tx: AccountLookup, { sub, email }: Auth0Identity) {
    return tx.execute(sql`/* auth0-bootstrap:account */
        SELECT id::text AS id,
            (raw_app_meta_data->>'auth0_sub' = ${sub}) IS TRUE AS linked,
            (lower(email) = ${email}) IS TRUE AS "sameEmail",
            (deleted_at IS NULL AND (banned_until IS NULL OR banned_until <= now())
                AND is_anonymous IS NOT TRUE AND email_confirmed_at IS NOT NULL) AS active
        FROM auth.users
        WHERE raw_app_meta_data->>'auth0_sub' = ${sub} OR lower(email) = ${email}
        LIMIT 2`);
}

function hasActiveLink(rows: ArrayLike<Auth0Account>): boolean {
    if (rows.length === 0) return false;
    if (rows.length === 1 && rows[0]?.active && rows[0].linked) return true;
    // Matching email is never authority to adopt an existing or disabled account.
    throw new Auth0Error('account_conflict');
}

/** Both staging registration surfaces serialize the same upstream subject. */
async function withSubjectLock<T>(database: AccountDatabase, sub: string, operation: (tx: AccountLookup) => Promise<T>): Promise<T> {
    return database.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${'ezil.auth0.identity:' + sub}, 0))`);
        return operation(tx);
    });
}

export function withBrowserAuth0AccountLock<T>(database: AccountDatabase, identity: Auth0Identity, resolve: () => Promise<T>) {
    return withSubjectLock(database, identity.sub, async tx => {
        const rows = await accountMatches(tx, { ...identity, email: identity.email.toLowerCase() });
        // Keep an ordinary browser login from creating a second row after an email change.
        if (rows.length > 1 || (rows[0]?.linked && !rows[0].sameEmail)) throw new Auth0Error('account_conflict');
        return resolve();
    });
}

/** Idempotent account registration only. Browser session and AI membership are separate sign-in actions. */
export async function ensureMcpAuth0Account(database: AccountDatabase, admin: Admin, identity: Auth0Identity): Promise<void> {
    const normalized = { ...identity, email: identity.email.toLowerCase() };
    await withSubjectLock(database, identity.sub, async tx => {
        if (hasActiveLink(await accountMatches(tx, normalized))) return;
        try {
            await createVerifiedAuth0Account(admin, normalized);
        } catch {
            // GoTrue can commit even if its response is lost. Resolve only by the exact subject below.
        }
        if (!hasActiveLink(await accountMatches(tx, normalized))) throw new Auth0Error('session_failed');
    });
}
