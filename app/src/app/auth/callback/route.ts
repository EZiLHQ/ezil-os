import { type NextRequest, NextResponse } from 'next/server';

import { Routes, safeReturnUrl } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * OAuth (Google) + email-confirmation callback. Supabase redirects the
 * browser here with a `code` query param after the user completes sign-in
 * on the provider's side (or clicks a confirmation-email link); we exchange
 * it for a session, then send the browser on to `returnUrl` (defaulting to
 * `/os`, the product's entry point — see `safeReturnUrl`).
 *
 * 🔴 This is a ROUTE HANDLER, so its 302 is a real HTTP redirect that the
 * browser follows as a document load. That matters for `/os`, whose shell is
 * a separate application delivered as `<script src>` tags and therefore only
 * boots on a document load — see `login/actions.ts` and
 * docs/PLATFORM-NOTES.md §17. Do not "modernise" this into a server action
 * with `redirect()`; that would turn it into a client-side navigation and
 * break the OAuth route into `/os`.
 */
export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const returnUrl = safeReturnUrl(searchParams.get('returnUrl'));

    if (code) {
        const supabase = await createClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            return NextResponse.redirect(`${origin}${returnUrl}`);
        }
    }

    return NextResponse.redirect(`${origin}${Routes.LOGIN}?error=auth_callback_failed`);
}
