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
 */
export async function updateSession(request: NextRequest) {
    let response = NextResponse.next({ request });

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
                    response = NextResponse.next({ request });
                    for (const { name, value, options } of cookiesToSet) {
                        response.cookies.set(name, value, options);
                    }
                },
            },
        },
    );

    // Must call getUser() (not getSession()) — this validates the token
    // against the Supabase Auth server rather than trusting a locally
    // decoded JWT, which is required for this to actually refresh/verify.
    await supabase.auth.getUser();

    return response;
}
