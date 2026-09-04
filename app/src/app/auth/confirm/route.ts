import { type NextRequest, NextResponse } from 'next/server';

import { Routes, safeReturnUrl } from '@/utils/constants';
import { createClient } from '@/utils/supabase/server';

import { destinationFor, isVerifiableType } from './confirm-link';

/**
 * `GET /auth/confirm?token_hash=…&type=…` — the SERVER-SIDE half of every
 * emailed link (invite, magic link, password recovery, email confirmation).
 *
 * ── Why this exists next to `/auth/callback` ────────────────────────────────
 * `/auth/callback` handles `?code=` — the PKCE exchange, which is what OAuth
 * and any flow started in the SAME browser produces. Invites are not that.
 * Quoting `@supabase/auth-js`'s own `GoTrueAdminApi.inviteUserByEmail` (the
 * installed copy, `dist/module/GoTrueAdminApi.js:95`):
 *
 *   "Note that PKCE is not supported when using `inviteUserByEmail`. This is
 *    because the browser initiating the invite is often different from the
 *    browser accepting the invite which makes it difficult to provide the
 *    security guarantees required of the PKCE flow."
 *
 * With no PKCE, Supabase's DEFAULT invite email points at
 * `<project>/auth/v1/verify?token={{ .TokenHash }}&type=invite&redirect_to=…`
 * and the session comes back to the browser in the URL FRAGMENT — which a
 * server never receives. `../invited/page.tsx` is the client-side answer to
 * that one.
 *
 * This route is the other, better answer: the email template is changed to
 * link at `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=invite`
 * (supabase.com/docs/guides/auth/auth-email-templates, "Server-Side
 * Authentication Pattern": "This allows your backend to call `verifyOtp()` and
 * access the authenticated session server-side before redirecting the user").
 * Then the session is established HERE, written to cookies here, and the
 * browser is redirected with a real HTTP 3xx. Nothing depends on a fragment.
 * That template change is a Supabase dashboard edit, not code — it is named in
 * this row's report as a founder step.
 *
 * 🔴 A ROUTE HANDLER, like `../callback/route.ts`, and for the same reason:
 * its redirect is a real HTTP response the BROWSER follows, so the destination
 * arrives as a document load. `/os` is a separate application delivered as
 * `<script src>` tags and only boots on one (docs/PLATFORM-NOTES.md §17).
 * Supabase's own Next.js example calls `redirect()` from `next/navigation`
 * here; inside a route handler that is equivalent, but this repo uses
 * `NextResponse.redirect` everywhere so the mechanism is visible in the source
 * and cannot be "modernised" into a server action by accident. MEASURED:
 * `NextResponse.redirect(url)` returns **307**, not 302 — browser-followed
 * either way, so tests assert on the `location` header, never on the number.
 *
 * 🔴 Exports are limited to `GET`. Next fails the BUILD on any other export
 * from a `route.ts` (measured: `"isVerifiableType" is not a valid Route export
 * field`), which is why the type allow-list and the destination rule live in
 * `./confirm-link.ts`.
 */
export async function GET(request: NextRequest) {
    const { searchParams, origin } = new URL(request.url);
    const tokenHash = searchParams.get('token_hash');
    const type = searchParams.get('type');
    // `next` is the name Supabase's own template example uses; `returnUrl` is
    // this app's. Both are narrowed to a same-origin path.
    const next = safeReturnUrl(searchParams.get('next') ?? searchParams.get('returnUrl'));

    if (tokenHash && isVerifiableType(type)) {
        const supabase = await createClient();
        // The session cookies are written by `createClient`'s `setAll` during
        // this call — a Route Handler CAN set cookies, which is exactly why
        // this is a handler and not a Server Component. Same mechanism as
        // `../callback/route.ts`'s `exchangeCodeForSession`.
        const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
        if (!error) {
            return NextResponse.redirect(`${origin}${destinationFor(type, next)}`);
        }
    }

    // One failure surface for every way this can go wrong — a missing or
    // unknown `type`, no `token_hash`, an expired or already-used link. The
    // user cannot act on the difference, and the code is the one
    // `/auth/callback` already uses.
    return NextResponse.redirect(`${origin}${Routes.LOGIN}?error=auth_callback_failed`);
}
