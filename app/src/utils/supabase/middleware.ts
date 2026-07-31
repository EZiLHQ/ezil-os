import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { env } from '@/env';

/**
 * Refreshes the Supabase auth session cookie on every request. This is the
 * standard Supabase SSR recipe for Next.js middleware: Server Components
 * can't write cookies, so if we didn't refresh here, a session nearing
 * expiry could go stale mid-render. Route-level auth *gating* (redirecting
 * an unauthenticated visitor to /login) happens separately in each
 * protected layout (see app/computers/layout.tsx, app/computer/layout.tsx)
 * — this function's only job is keeping the session cookie current.
 *
 * Also stamps an `x-pathname` request header with the current path, so a
 * protected layout can build an accurate `returnUrl` back to wherever the
 * unauthenticated visitor was trying to go (see `utils/constants.ts`'s
 * `getReturnUrlQueryParam`).
 */
export async function updateSession(request: NextRequest) {
    // Clone (never mutate) the incoming headers — `request.headers` may be
    // an immutable Headers instance depending on runtime.
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set('x-pathname', request.nextUrl.pathname);

    let response = NextResponse.next({ request: { headers: requestHeaders } });

    const supabase = createServerClient(
        env.NEXT_PUBLIC_SUPABASE_URL,
        env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
        {
            cookies: {
                getAll() {
                    return request.cookies.getAll();
                },
                setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
                    for (const { name, value } of cookiesToSet) {
                        request.cookies.set(name, value);
                    }
                    response = NextResponse.next({ request: { headers: requestHeaders } });
                    for (const { name, value, options } of cookiesToSet) {
                        response.cookies.set(name, value, options);
                    }
                },
            },
        },
    );

    // 🔴 `getSession()`, deliberately, NOT `getUser()`.
    //
    // This function performs no authorization: every protected surface calls
    // `getUser()` itself (`app/computers/layout.tsx`, `app/computer/layout.tsx`,
    // `createTRPCContext` for `/os` and every tRPC call), and that call is the
    // one that validates the token against the Auth server. What ran here was
    // a SECOND, identical validation of the same token, on the same request,
    // strictly BEFORE the first — middleware completes before a Server
    // Component renders, so the two could never overlap.
    //
    // MEASURED against this project's Supabase instance: `GET /auth/v1/user`
    // is 159ms (median of 7, from the app server). Two in series put ~318ms of
    // pure duplicate network into the TTFB of every authenticated page —
    // roughly half of `/os`'s 571ms.
    //
    // `getSession()` reads the session out of the request cookies and issues a
    // network call ONLY when the access token has expired, which is exactly
    // and only when this function has something to do: Server Components
    // cannot write cookies, so refreshing them here is this middleware's whole
    // purpose. The refreshed cookies are still written through `setAll` above.
    //
    // Its return value is deliberately discarded. Supabase's warning about
    // `getSession()` on the server is about TRUSTING the user object it
    // returns; nothing here reads it, and no access decision is made from it.
    await supabase.auth.getSession();

    return response;
}
