import { type NextRequest, NextResponse } from 'next/server';

import { Routes } from '@/utils/constants';
import { isLegacyAuthCookie, SECURE_AUTH_COOKIE_NAME } from '@/utils/supabase/cookie-options';
import { createClient } from '@/utils/supabase/server';

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
    const supabase = await createClient();
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    const response = NextResponse.redirect(new URL(Routes.LOGIN, request.url), 303);
    if (error) {
        console.warn(`[auth/signout] signOut failed, clearing cookies anyway: ${error.message}`);
        for (const { name } of request.cookies.getAll()) {
            if (!isAuthCookie(name)) continue;
            const secure = name.startsWith('__Host-');
            response.cookies.set(name, '', { path: '/', maxAge: 0, secure, sameSite: 'lax' });
        }
    }
    return response;
}
