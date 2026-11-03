import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

import {
    encodeLoginReturn, LOGIN_RETURN_COOKIE, LOGIN_RETURN_COOKIE_OPTIONS, LOGIN_RETURN_MAX_AGE,
} from '@/app/login/return-cookie';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, auth0Enabled, logoutUrl } from '@/server/auth/auth0';
import { clearProjectIdentity } from '@/server/auth/retained-identity';
import { computers } from '@/server/db/schema';
import { revokeAiCredentialsOnSignout } from '@/server/lib/ai-credential';
import { resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { RETURN_URL_PARAM, Routes, safeReturnUrl } from '@/utils/constants';
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
 * by hand on that path. So does a Supabase client that cannot even be built:
 * `/login`'s "Sign out and use another account" is how someone whose EZiL ID
 * was refused (an unverified email, say) leaves id.ezil.work's session, and
 * they have no OS session at all.
 *
 * An optional `returnUrl` form field (sent by `/login`, never by the shell) is
 * the page they were headed for. It is narrowed by `safeReturnUrl` and comes
 * back to `/login` past id.ezil.work's logout in `../../login/return-cookie`.
 */
export async function POST(request: NextRequest) {
    // The retained EZiL ID token goes first and unconditionally: nothing below may leave it usable.
    try { await clearProjectIdentity(); } catch { /* a cookie-less request has nothing retained */ }
    let returnUrl: string | undefined;
    try {
        const value = (await request.formData()).get(RETURN_URL_PARAM);
        if (typeof value === 'string' && value) returnUrl = safeReturnUrl(value);
    } catch { /* the shell's form has no body: sign out to plain `/login` */ }
    let error: unknown;
    try {
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
        ({ error } = await supabase.auth.signOut({ scope: 'local' }));
    } catch {
        error = true;
    }
    const origin = ownedPublicOrigin(request.headers, request.url);
    const useAuth0 = auth0Enabled();
    const destination = useAuth0 ? logoutUrl(origin) : new URL(Routes.LOGIN, origin);
    // Without Auth0 `/login` is the next stop, so the destination simply rides on it.
    if (returnUrl !== undefined && !useAuth0) destination.searchParams.set(RETURN_URL_PARAM, returnUrl);
    const response = NextResponse.redirect(destination, 303);
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    const kept = returnUrl !== undefined && useAuth0 ? encodeLoginReturn(returnUrl) : null;
    if (kept) response.cookies.set(LOGIN_RETURN_COOKIE, kept, { ...LOGIN_RETURN_COOKIE_OPTIONS, maxAge: LOGIN_RETURN_MAX_AGE });
    // A sign-in that was started and abandoned must not outlive the sign-out.
    if (request.cookies.has(AUTH0_COOKIE)) response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
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
