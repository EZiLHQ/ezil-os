import 'server-only';

import { createClient } from '@supabase/supabase-js';

import { Auth0Error } from './auth0';

/** Never persisted or exposed to a browser; only used after OIDC verification. */
export function createAdminClient({ timeoutMs }: { timeoutMs?: number } = {}) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) throw new Auth0Error('session_failed');
    return createClient(url, key, {
        auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
        ...(timeoutMs === undefined ? {} : {
            // Retain runtime fetch extensions while adding the bounded request signal.
            global: { fetch: new Proxy(fetch, {
                apply(target, receiver, [input, init]: Parameters<typeof fetch>) {
                    const timeout = AbortSignal.timeout(timeoutMs);
                    return Reflect.apply(target, receiver, [input, {
                        ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
                    }]);
                },
            }) },
        }),
    });
}
