import { type NextRequest, NextResponse } from 'next/server';

import { safeReturnUrl } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * `GET /auth/refresh?returnUrl=…` — refresh the Supabase session once, then
 * send the browser back with a full document load.
 *
 * `/os` sends a user here right after EZiL Works gave their sign-in an EZiL
 * account (`@/server/lib/ezil-account`): the role lives in the access token's
 * `app_metadata`, and the token in the cookie was minted before it was
 * written. This must be a Route Handler: only here can the rotated cookies be
 * written back (a Server Component cannot set cookies, and refreshing there
 * would leave the browser holding a revoked refresh token).
 *
 * Only refreshes the caller's own session; `safeReturnUrl` keeps the return
 * path on this origin. A failed refresh still goes back: `/os` sees the
 * `ezil_account=refreshed` marker and does not try again.
 */
export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));
    const supabase = await createClient();
    const { error } = await supabase.auth.refreshSession();
    if (error) console.warn('[auth/refresh] session refresh failed', { status: error.status ?? null });
    return NextResponse.redirect(`${origin}${returnUrl}`);
}
