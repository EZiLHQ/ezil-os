import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

import { auth0Enabled, logoutUrl } from '@/server/auth/auth0';
import { clearProjectIdentity } from '@/server/auth/retained-identity';
import { computers } from '@/server/db/schema';
import { revokeAiCredentialsOnSignout } from '@/server/lib/ai-credential';
import { resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { Routes } from '@/utils/constants';
import { isLegacyAuthCookie, SECURE_AUTH_COOKIE_NAME } from '@/utils/supabase/cookie-options';
import { createClient } from '@/utils/supabase/server';
import { ownedPublicOrigin } from '@/utils/forwarded';

/**
 * The session's cookies: the `__Host-` name used on HTTPS and its chunks, or
 * the library default (`sb-<ref>-auth-token`, chunked) used on loopback HTTP.
 */
const isAuthCookie = (name: string) => name.startsWith(SECURE_AUTH_COOKIE_NAME) || isLegacyAuthCookie(name);

/**
 * `POST /auth/signout` — ends the session and lands on `/login`.
 *
 * The OS shell's Start menu and the `/login` not-invited panel both post a
 * plain HTML form here — there is exactly one way to sign out. It is a ROUTE
 * HANDLER rather than the `signOut` server action because the shell is not a
 * React tree: it cannot call a server action, and a form POST answered with a
 * 303 is a real document load the browser follows by itself (the same reason
 * `../callback/route.ts` is a route handler — see docs/PLATFORM-NOTES.md §17).
 *
 * POST only. A GET that signs people out can be triggered by any `<img>` tag;
 * the cross-origin half of that is refused by `proxy.ts` before this runs.
 *
 * `scope: 'local'` ends this browser's session and leaves the user's other
 * devices signed in, which is what "Sign out" means on a shared computer.
 * Sign-out failing (Supabase unreachable, say) still clears the cookies and
 * still lands on `/login`: the user asked to leave, and keeping them signed in
 * because a network call failed is the wrong outcome. auth-js returns such an
 * error WITHOUT removing the stored session, so the cookies are expired here
 * by hand on that path.
 */
export async function POST(request: NextRequest) {
    // The retained EZiL ID token goes first and unconditionally: nothing below may leave it usable.
    try { await clearProjectIdentity(); } catch { /* a cookie-less request has nothing retained */ }
    const supabase = await createClient();
    // Revoke before signOut removes the identity. The total budget is three seconds,
    // independent of whether Supabase subsequently succeeds or throws.
    try {
        await revokeAiCredentialsOnSignout({
            config: resolveCloudflareGuacamoleConfig(),
            hmacSecret: process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '',
            getUserId: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
            listComputerIds: async (userId) => {
                const { db } = await import('@/server/db');
                const rows = await db.query.computers.findMany({
                    where: eq(computers.userId, userId), columns: { id: true },
                });
                return rows.map((row) => row.id);
            },
        });
    } catch {
        // Configuration and client failures also leave signout available.
    }
    let error: unknown;
    try {
        ({ error } = await supabase.auth.signOut({ scope: 'local' }));
    } catch {
        error = true;
    }
    const origin = ownedPublicOrigin(request.headers, request.url);
    const destination = auth0Enabled() ? logoutUrl(origin) : new URL(Routes.LOGIN, origin);
    const response = NextResponse.redirect(destination, 303);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    if (error) {
        console.warn('[auth/signout] signOut failed, clearing cookies anyway');
        for (const { name } of request.cookies.getAll()) {
            if (!isAuthCookie(name)) continue;
            const secure = name.startsWith('__Host-');
            response.cookies.set(name, '', { path: '/', maxAge: 0, secure, sameSite: 'lax' });
        }
    }
    return response;
}
