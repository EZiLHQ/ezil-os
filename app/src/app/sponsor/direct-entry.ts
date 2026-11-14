import { type NextRequest, NextResponse } from 'next/server';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, buildAuthorizeUrl } from '@/server/auth/auth0';
import { legacyCouponResolution, materializeSponsorAttribution, sponsorFromLink, sponsorSubjectSupported } from '@/server/auth/sponsor';
import { sponsorCouponEntryAvailable, sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { SPONSOR_BILLING_RETURN, type SponsorEntryInput } from '@/server/auth/sponsor-entry-input';
import { SPONSOR_ENTRY_COOKIE, SPONSOR_ENTRY_COOKIE_OPTIONS, sponsorEntryContext } from '@/server/auth/sponsor-entry-context';
import { mintSponsorBillingContext, SPONSOR_BILLING_COOKIE, SPONSOR_BILLING_COOKIE_OPTIONS } from '@/server/auth/sponsor-billing-context';
import type { SponsorCampaign } from '@/server/billing/v3/sponsor';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/utils/supabase/server';
import { ownedPublicOrigin } from '@/utils/forwarded';

const PRIVATE_HEADERS = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' };
type EntryProblem = 'unavailable' | 'identity_required';
const billing = (problem?: EntryProblem) => SPONSOR_BILLING_RETURN + (problem ? `&coupon_entry=${problem}` : '');
/** A Stripe Product promoter alias: an untrusted hint the fixed Billing page re-verifies with a fresh server quote (no attribution, no carrier). */
const promoterBilling = (alias: string) => `${SPONSOR_BILLING_RETURN}&coupon=${encodeURIComponent(alias)}`;
function finish(response: NextResponse) {
    for (const [key, value] of Object.entries(PRIVATE_HEADERS)) response.headers.set(key, value);
    return response;
}
function clearEntry(response: NextResponse) {
    response.cookies.set(SPONSOR_ENTRY_COOKIE, '', { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 0 });
    return response;
}
/** The carried Billing context this response leaves: a freshly minted one, or none (an earlier one never outlives a new entry). */
function carryBilling(response: NextResponse, carried: { value: string; maxAge: number } | null) {
    response.cookies.set(SPONSOR_BILLING_COOKIE, carried?.value ?? '', { ...SPONSOR_BILLING_COOKIE_OPTIONS, maxAge: carried?.maxAge ?? 0 });
    return response;
}

/** A link selects attribution only. Standard trial/payment eligibility is still determined in Billing and Checkout. */
export async function directSponsorEntry(request: NextRequest, selection: SponsorEntryInput | null): Promise<NextResponse> {
    if (request.method === 'GET') {
        const destination = request.headers.get('sec-fetch-dest');
        const mode = request.headers.get('sec-fetch-mode');
        const purpose = `${request.headers.get('purpose') ?? ''};${request.headers.get('sec-purpose') ?? ''}`;
        // Public links are document navigations. Untrusted same-site previews cannot attribute via an image, frame or fetch.
        // Prerenders also claim document/navigate; never bind attribution or begin OAuth speculatively.
        if (/\b(?:prefetch|prerender)\b/i.test(purpose)
            || (destination !== null ? destination !== 'document' : !(request.headers.get('accept') ?? '').includes('text/html'))
            || (mode !== null && mode !== 'navigate')) return new NextResponse(null, { status: 403, headers: PRIVATE_HEADERS });
    }
    const origin = ownedPublicOrigin(request.headers, request.url);
    let campaign: SponsorCampaign | null = null;
    let promoterAlias: string | null = null;
    if (selection?.kind === 'token') {
        if (await sponsorEntryAvailable(selection.value)) campaign = sponsorFromLink(selection.value);
    } else if (selection) {
        // A known legacy alias owns its resolution, deny included (disabled, expired, duplicated, runtime off or an unverifiable registry stop
        // here with the Stage `unavailable` hint). Only an alias no legacy entry names continues, as an untrusted Product promoter hint.
        const resolution = legacyCouponResolution(selection.value);
        if (resolution.kind === 'none') promoterAlias = selection.value;
        else if (resolution.kind === 'active' && await sponsorCouponEntryAvailable(selection.value)) campaign = resolution.campaign;
    }
    let user: User | null;
    try {
        const result = await (await createClient()).auth.getUser();
        // An unavailable identity service cannot silently turn an existing OS account into an interactive account switch.
        if (result.error && result.error.name !== 'AuthSessionMissingError') return finish(clearEntry(NextResponse.redirect(new URL(billing('unavailable'), origin), 303)));
        user = result.data.user;
    } catch { return finish(clearEntry(NextResponse.redirect(new URL(billing('unavailable'), origin), 303))); }

    if (user && promoterAlias !== null) return finish(carryBilling(clearEntry(NextResponse.redirect(new URL(promoterBilling(promoterAlias), origin), 303)), null));
    if (user) {
        let problem: EntryProblem | undefined = campaign ? undefined : 'unavailable';
        let carried: { value: string; maxAge: number } | null = null;
        if (campaign) {
            // Supabase itself vouches for this user and protected app_metadata. User-editable user_metadata is never identity proof.
            const subject = user.app_metadata?.auth0_sub;
            if (typeof subject !== 'string' || !sponsorSubjectSupported(subject)) problem = 'identity_required';
            else {
                try {
                    await materializeSponsorAttribution({ userId: user.id, verifiedSubject: subject, metadata: user.app_metadata, campaign });
                    // This fresh, verified, signed-in entry is the context's original issue time; no context means the selected campaign is
                    // reported unavailable rather than silently left to the public offer.
                    carried = mintSponsorBillingContext(process.env.SPONSOR_KEY, { campaign, origin, userId: user.id, issuedAt: new Date(), now: new Date(),
                        ...(selection?.kind === 'token' ? { provenance: 'opaque' as const } : { provenance: 'alias' as const, alias: campaign.partnerId }) });
                    if (!carried) problem = 'unavailable';
                } catch { problem = 'unavailable'; }
            }
        }
        return finish(carryBilling(clearEntry(NextResponse.redirect(new URL(billing(problem), origin), 303)), carried));
    }

    try {
        // The ordinary signed OAuth state/nonce/PKCE remains the identity authority. Raw invitations never reach the provider URL.
        const url = await buildAuthorizeUrl({ origin, returnUrl: promoterAlias !== null ? promoterBilling(promoterAlias) : billing(campaign ? undefined : 'unavailable'),
            ...(campaign && selection ? selection.kind === 'token' ? { sponsorToken: selection.value } : { sponsorCoupon: selection.value } : {}) });
        const response = NextResponse.redirect(url, 303);
        // The entry seals how it arrived (opaque invitation or public alias); the callback carries that into the Billing context.
        if (campaign) response.cookies.set(SPONSOR_ENTRY_COOKIE, sponsorEntryContext(campaign, origin, new Date(), selection?.kind === 'token' ? 'opaque' : 'alias'),
            { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 600 });
        else clearEntry(response);
        return finish(promoterAlias !== null ? carryBilling(response, null) : response);
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        const query = new URLSearchParams({ error: code, returnUrl: billing('unavailable') });
        const response = clearEntry(NextResponse.redirect(new URL(`/login?${query}`, origin), 303));
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
        return finish(response);
    }
}
