import { createBrowserClient } from '@supabase/ssr';

import { env } from '@/env';

import { authCookieOptions } from './cookie-options';

/**
 * Browser-side Supabase client. Safe to call anywhere in client components —
 * only ever uses the public URL + anon key, both already inlined into the
 * browser bundle at build time.
 *
 * Uses the same cookie name as the server (see `./cookie-options.ts`): on
 * HTTPS the session lives in a `__Host-` cookie, and a browser client that
 * looked for the library's default name would find no session at all.
 */
export function createClient() {
    return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
        // Client components also render on the server, where there is no
        // `window`; nothing there reads cookies through this client.
        cookieOptions: authCookieOptions(
            typeof window !== 'undefined' && window.location.protocol === 'https:',
        ),
    });
}
