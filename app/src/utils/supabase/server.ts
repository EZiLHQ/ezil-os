import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { env } from '@/env';

/**
 * Server-side Supabase client for use in Server Components, Route Handlers,
 * and Server Actions. Reads/writes the auth cookie via `next/headers`.
 *
 * `setAll` is wrapped in a try/catch because Server Components cannot set
 * cookies — that's expected there (session refresh happens in middleware
 * instead) and must not crash the render.
 */
export async function createClient() {
    const cookieStore = await cookies();

    return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        cookies: {
            getAll() {
                return cookieStore.getAll();
            },
            setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
                try {
                    for (const { name, value, options } of cookiesToSet) {
                        cookieStore.set(name, value, options);
                    }
                } catch {
                    // Called from a Server Component — no-op; middleware
                    // (src/middleware.ts) refreshes the session cookie on
                    // every request instead.
                }
            },
        },
    });
}
