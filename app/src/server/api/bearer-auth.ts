/**
 * `Authorization: Bearer <supabase-jwt>` — the second way to authenticate.
 *
 * The browser and the desktop shell authenticate with the Supabase session
 * cookie. `sdk/` and the `mcp/` connector have no cookie jar, so they present a
 * Supabase access token as a bearer instead. Both funnel into the same
 * `ctx.user` in `createTRPCContext`, so adding a second way to AUTHENTICATE
 * does not add a second way to AUTHORIZE.
 *
 * Kept in its own module, free of `@/server/db` and `@/env`, so it is directly
 * testable — importing `./trpc` would eagerly validate the whole server
 * environment.
 */
import type { User } from '@supabase/supabase-js';

/**
 * The slice of a Supabase client this needs. Narrow on purpose: it makes the
 * unit under test stubbable without mocking a module.
 */
export interface BearerVerifier {
    auth: {
        getUser(jwt?: string): Promise<{
            data: { user: User | null };
            error: { message: string } | null;
        }>;
    };
}

/**
 * Resolve the caller from an `Authorization` header.
 *
 * - `undefined` — no bearer was offered. The caller should fall back to the
 *   session cookie.
 * - `null` — a bearer WAS offered and did not check out.
 * - a `User` — the bearer is good.
 *
 * 🔴 THE DISTINCTION BETWEEN `undefined` AND `null` IS THE SECURITY PROPERTY.
 * A present-but-invalid bearer must never collapse into "no credential
 * offered", because the caller's next move is to read the session cookie —
 * which would serve the browser's own user to a request carrying a stranger's
 * dead token. Alternatives, not a fallback chain.
 */
export const userFromBearer = async (
    supabase: BearerVerifier,
    headers: Headers,
): Promise<User | null | undefined> => {
    const header = headers.get('authorization');
    if (header === null) return undefined;

    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) return null;

    const token = match[1]!.trim();
    if (!token) return null;

    // Validated against the auth server, never decoded locally: an unverified
    // JWT payload is user input, not an identity.
    const { data, error } = await supabase.auth.getUser(token);
    if (error) return null;
    return data.user ?? null;
};
