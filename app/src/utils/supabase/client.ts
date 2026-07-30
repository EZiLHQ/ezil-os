import { createBrowserClient } from '@supabase/ssr';

import { env } from '@/env';

/**
 * Browser-side Supabase client. Safe to call anywhere in client components —
 * only ever uses the public URL + anon key, both already inlined into the
 * browser bundle at build time.
 */
export function createClient() {
    return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
