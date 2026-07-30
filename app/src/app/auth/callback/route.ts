import { type NextRequest, NextResponse } from 'next/server';

import { Routes } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

/**
 * OAuth (Google) + email-confirmation callback. Supabase redirects the
 * browser here with a `code` query param after the user completes sign-in
 * on the provider's side (or clicks a confirmation-email link); we exchange
 * it for a session, then send the browser on to `returnUrl` (defaulting to
 * `/computers` — this app has no chat editor, so there is no alternate
 * landing destination to branch on).
 */
export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const code = searchParams.get('code');
    const returnUrl = searchParams.get('returnUrl') || Routes.COMPUTERS;

    if (code) {
        const supabase = await createClient();
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error) {
            return NextResponse.redirect(`${origin}${returnUrl}`);
        }
    }

    return NextResponse.redirect(`${origin}${Routes.LOGIN}?error=auth_callback_failed`);
}
