/**
 * The EZiL OS access gate — "may this account use the product at all?"
 *
 * Distinct from, and downstream of, authentication. `createTRPCContext`
 * (`./trpc.ts`) answers WHO the caller is, from a session cookie or a bearer
 * (`./bearer-auth.ts`). This file answers whether that caller is allowed in.
 * Two questions, two modules; a second way to authenticate still does not add
 * a second way to authorize, and now a second way to be *turned away* does
 * not add a second way to be let in either.
 *
 * ── Deliberately free of `@/env`, `@/server/db` and anything Next ─────────
 * Importing `@/env` eagerly validates the entire server environment, which
 * would make this untestable without a full env — the same reason
 * `./bearer-auth.ts` and `@/server/telemetry/admin.ts` stay clean. The mode
 * is a PARAMETER here; the caller passes `env.EZIL_OS_ACCESS_MODE`.
 *
 * ── How row A2 uses this ─────────────────────────────────────────────────
 * In `./trpc.ts`'s `protectedProcedure`, after the existing `ctx.user` null
 * check, and in each of the three page gates:
 *
 *     import { env } from '@/env';
 *     import { assertOsAccess, osAccessLookup, OsAccessDeniedError } from './os-access';
 *
 *     try {
 *         await assertOsAccess(osAccessLookup(ctx.db), ctx.user, env.EZIL_OS_ACCESS_MODE);
 *     } catch (err) {
 *         if (err instanceof OsAccessDeniedError) {
 *             throw new TRPCError({ code: 'FORBIDDEN', message: err.reason });
 *         }
 *         throw err;
 *     }
 *
 * 🔴 `FORBIDDEN`, never `UNAUTHORIZED`: the caller proved who they are and it
 * did not help. Collapsing the two would tell a signed-in, uninvited user to
 * go and sign in again, forever.
 *
 * 🔴 A THROWN LOOKUP ERROR IS NOT AN ALLOW. `assertOsAccess` does not catch
 * database failures — if the query throws, the throw propagates and the
 * request fails. A `try { ... } catch { /* let them in *\/ }` around this call
 * is the one edit that would silently disable the gate for everyone the
 * moment Postgres hiccups.
 */
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { eq, type ExtractTablesWithRelations } from 'drizzle-orm';

import * as schema from '@/server/db/schema';
import { osAccess } from '@/server/db/schema';

/** `@/env`'s `EZIL_OS_ACCESS_MODE`, restated so this module need not import it. */
export type OsAccessMode = 'invite' | 'open';

/**
 * The reason code A2 surfaces as a `FORBIDDEN` message. Exported as a
 * constant so the gate, its tests and A2's mapping all name the same string
 * and a rename cannot half-land.
 */
export const OS_ACCESS_NOT_INVITED = 'not_invited';

/** Every reason a request is turned away. `no_email` is a denial, not an error. */
export type OsAccessDenialReason = typeof OS_ACCESS_NOT_INVITED | 'revoked' | 'no_email';

/**
 * Discriminated on `allowed`, and the losing branch always carries WHY.
 * A boolean would have been enough for the gate itself and useless for the
 * two things that follow it: telling a revoked user apart from one who was
 * never invited, and logging which of the two just happened.
 */
export type OsAccessResult =
    | { allowed: true; reason: 'open' | 'invited' }
    | { allowed: false; reason: OsAccessDenialReason };

/** The only property of the caller this gate reads. `User` from Supabase satisfies it structurally. */
export interface OsAccessUser {
    email?: string | null;
}

/** The allow-list row, narrowed to what the decision actually needs. */
export interface OsAccessLookupRow {
    email: string;
    revokedAt: Date | null;
}

/**
 * The storage seam. Narrow on purpose — the whole decision is unit-testable
 * against a function literal, with no Postgres and no module mock, exactly as
 * `BearerVerifier` does for the bearer path.
 *
 * 🔴 `findByEmail` MUST return revoked rows. It looks a row up by email and
 * nothing else. Filtering `revoked_at is null` in the query would fold
 * "revoked" into "no row", and the difference between those two is the whole
 * reason `OsAccessDenialReason` has more than one member.
 */
export interface OsAccessLookup {
    findByEmail(email: string): Promise<OsAccessLookupRow | null>;
}

/**
 * Lower-case and trim. Both halves matter, and both are also enforced at the
 * write end (`tools/invite.ts`) and, for case, by
 * `ezil_os_access_email_lower_chk` in the database:
 *
 *   - CASE, because `Alice@Example.com` signing in must match the invite
 *     someone typed as `alice@example.com`. The domain half of an address is
 *     case-insensitive by RFC and every mainstream provider treats the local
 *     half that way too; a case-sensitive allow-list would deny people who
 *     are on it.
 *   - WHITESPACE, because a pasted address routinely carries a trailing
 *     space, and ` alice@example.com` is not a different person.
 */
export const normalizeAccessEmail = (email: string | null | undefined): string =>
    (email ?? '').trim().toLowerCase();

/**
 * The decision. Pure apart from the one lookup call.
 *
 * Allowed iff the mode is `open`, or the caller's normalised email has a row
 * with `revoked_at is null`. Everything else is a denial with a reason.
 */
export async function osAccessFor(
    lookup: OsAccessLookup,
    user: OsAccessUser | null | undefined,
    mode: OsAccessMode,
): Promise<OsAccessResult> {
    // Checked FIRST, and short-circuiting: in `open` mode the allow-list is
    // not consulted at all, so an operator who has opened the product does
    // not need a database round-trip (or a reachable database) to serve a
    // request. It also settles the one genuinely ambiguous case by the plain
    // reading of the rule — `open` means open, including to an identity that
    // carries no email address.
    if (mode === 'open') return { allowed: true, reason: 'open' };

    const email = normalizeAccessEmail(user?.email);
    // Some OAuth identities carry no email (a GitHub account with only a
    // private address, for instance). There is nothing to match against an
    // email-keyed allow-list, so this is a DENIAL — never a pass-through.
    // Returning `allowed: true` here would be an unauthenticated-by-omission
    // bypass: pick a provider that hides the address and the gate is gone.
    if (!email) return { allowed: false, reason: 'no_email' };

    const row = await lookup.findByEmail(email);
    if (!row) return { allowed: false, reason: OS_ACCESS_NOT_INVITED };
    if (row.revokedAt !== null) return { allowed: false, reason: 'revoked' };

    return { allowed: true, reason: 'invited' };
}

/**
 * Thrown by `assertOsAccess`. Carries the reason so A2's `catch` can map it
 * to a `TRPCError` without re-deriving anything, and so this module stays
 * free of `@trpc/server` (a page gate that redirects rather than throwing a
 * tRPC error is a caller too).
 */
export class OsAccessDeniedError extends Error {
    readonly reason: OsAccessDenialReason;

    constructor(reason: OsAccessDenialReason) {
        super(`EZiL OS access denied: ${reason}`);
        this.name = 'OsAccessDeniedError';
        this.reason = reason;
    }
}

/**
 * `osAccessFor`, as a guard clause. Returns the allowing result (so a caller
 * can log `open` vs `invited`) or throws `OsAccessDeniedError`.
 */
export async function assertOsAccess(
    lookup: OsAccessLookup,
    user: OsAccessUser | null | undefined,
    mode: OsAccessMode,
): Promise<Extract<OsAccessResult, { allowed: true }>> {
    const result = await osAccessFor(lookup, user, mode);
    if (!result.allowed) throw new OsAccessDeniedError(result.reason);
    return result;
}

/**
 * The narrowest `Pick<>` of Drizzle's generic `PgDatabase` this needs — the
 * same technique `@/server/telemetry/queries.ts` uses for `QueryDb`, and the
 * reason the adapter below can be exercised through `drizzle-orm/pg-proxy`
 * with no Postgres anywhere.
 */
export type OsAccessDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
    'select'
>;

/**
 * The real adapter: `ezil_os_access` behind the `OsAccessLookup` seam.
 *
 * A2 owns no database module of its own, so this ships here rather than
 * being reinvented at each of the four call sites — one query, one place to
 * get the column names right.
 *
 * `limit(1)` on a primary-key equality is redundant against the database and
 * kept as documentation that exactly one row is expected; `where` carries no
 * `revoked_at` predicate on purpose (see `OsAccessLookup`).
 */
export const osAccessLookup = (db: OsAccessDb): OsAccessLookup => ({
    async findByEmail(email: string): Promise<OsAccessLookupRow | null> {
        const rows = await db
            .select({ email: osAccess.email, revokedAt: osAccess.revokedAt })
            .from(osAccess)
            .where(eq(osAccess.email, email))
            .limit(1);
        return rows[0] ?? null;
    },
});
