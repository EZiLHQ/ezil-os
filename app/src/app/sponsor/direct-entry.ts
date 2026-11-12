import { type NextRequest, NextResponse } from 'next/server';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, buildAuthorizeUrl } from '@/server/auth/auth0';
import { materializeSponsorAttribution, sponsorFromCoupon, sponsorFromLink, sponsorSubjectSupported } from '@/server/auth/sponsor';
import { sponsorCouponEntryAvailable, sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { SPONSOR_BILLING_RETURN, type SponsorEntryInput } from '@/server/auth/sponsor-entry-input';
import { SPONSOR_ENTRY_COOKIE, SPONSOR_ENTRY_COOKIE_OPTIONS, sponsorEntryContext } from '@/server/auth/sponsor-entry-context';
import type { SponsorCampaign } from '@/server/billing/v3/sponsor';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';
import { ownedPublicOrigin } from '@/utils/forwarded';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
type EntryProblem = 'unavailable' | 'identity_required';
const billing = (problem?: EntryProblem) => SPONSOR_BILLING_RETURN + (problem ? `&coupon_entry=${problem}` : '');
function finish(response: NextResponse) {
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
    return response;
}
function clearEntry(response: NextResponse) {
    response.cookies.set(SPONSOR_ENTRY_COOKIE, '', { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 0 });
    return response;
}

/** A link selects attribution only. Standard trial/payment eligibility is still determined in Billing and Checkout. */
export async function directSponsorEntry(request: NextRequest, selection: SponsorEntryInput | null): Promise<NextResponse> {
    if (request.method === 'GET') {
        const destination = request.headers.get('sec-fetch-dest');
        const mode = request.headers.get('sec-fetch-mode');
        // Public links are document navigations. Untrusted same-site previews cannot attribute via an image, frame or fetch.
        if ((destination !== null ? destination !== 'document' : !(request.headers.get('accept') ?? '').includes('text/html'))
            || (mode !== null && mode !== 'navigate')) return new NextResponse(null, { status: 403, headers: PRIVATE_HEADERS });
    }
    const origin = ownedPublicOrigin(request.headers, request.url);
    let campaign: SponsorCampaign | null = null;
    if (selection) {
        const available = selection.kind === 'token'
            ? await sponsorEntryAvailable(selection.value) : await sponsorCouponEntryAvailable(selection.value);
        if (available) campaign = selection.kind === 'token' ? sponsorFromLink(selection.value) : sponsorFromCoupon(selection.value);
    }
    let user: User | null;
    try {
        const result = await (await createClient()).auth.getUser();
        // An unavailable identity service cannot silently turn an existing OS account into an interactive account switch.
        if (result.error && result.error.name !== 'AuthSessionMissingError') return finish(clearEntry(NextResponse.redirect(new URL(billing('unavailable'), origin), 303)));
        user = result.data.user;
    } catch { return finish(clearEntry(NextResponse.redirect(new URL(billing('unavailable'), origin), 303))); }

    if (user) {
        let problem: EntryProblem | undefined = campaign ? undefined : 'unavailable';
        if (campaign) {
            // Supabase itself vouches for this user and protected app_metadata. User-editable user_metadata is never identity proof.
            const subject = user.app_metadata?.auth0_sub;
            if (typeof subject !== 'string' || !sponsorSubjectSupported(subject)) problem = 'identity_required';
            else {
                try { await materializeSponsorAttribution({ userId: user.id, verifiedSubject: subject, metadata: user.app_metadata, campaign }); }
                catch { problem = 'unavailable'; }
            }
        }
        return finish(clearEntry(NextResponse.redirect(new URL(billing(problem), origin), 303)));
    }

    try {
        // The ordinary signed OAuth state/nonce/PKCE remains the identity authority. Raw invitations never reach the provider URL.
        const url = await buildAuthorizeUrl({ origin, returnUrl: billing(campaign ? undefined : 'unavailable'),
            ...(campaign && selection ? selection.kind === 'token' ? { sponsorToken: selection.value } : { sponsorCoupon: selection.value } : {}) });
        const response = NextResponse.redirect(url, 303);
        if (campaign) response.cookies.set(SPONSOR_ENTRY_COOKIE, sponsorEntryContext(campaign, origin), { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 600 });
        else clearEntry(response);
        return finish(response);
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        const query = new URLSearchParams({ error: code, returnUrl: billing('unavailable') });
        const response = clearEntry(NextResponse.redirect(new URL(`/login?${query}`, origin), 303));
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
        return finish(response);
    }
}
