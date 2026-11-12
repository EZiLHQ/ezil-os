import { type NextRequest, NextResponse } from 'next/server';

import { LOGIN_RETURN_COOKIE, LOGIN_RETURN_COOKIE_OPTIONS } from '@/app/login/return-cookie';
import {
    AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, auth0Enabled, exchangeCode, readTransaction, SILENT_LOGIN_FALLBACK_ERRORS, verifyIdToken,
} from '@/server/auth/auth0';
import { bridgeAuth0Identity, refuseSilentAccountSwitch } from '@/server/auth/bridge';
import { sponsorFromTransaction } from '@/server/auth/sponsor';
import { SPONSOR_ENTRY_COOKIE, SPONSOR_ENTRY_COOKIE_OPTIONS } from '@/server/auth/sponsor-entry-context';
import { retainProjectIdentity } from '@/server/auth/retained-identity';
import { Routes, safeReturnUrl } from '@/utils/constants';
import { ownedPublicOrigin } from '@/utils/forwarded';
import { createClient } from '@/utils/supabase/server';

/** A session Supabase Auth itself vouches for (`getUser`, not the cookie alone). Any failure counts as none. */
async function hasOsSession(): Promise<boolean> {
    try {
        const { data, error } = await (await createClient()).auth.getUser();
        return !error && Boolean(data.user);
    } catch {
        return false;
    }
}

export async function GET(request: NextRequest) {
    let destination: string;
    // Set only once the signed transaction has been read: a failure after that (cancelled, unverified email, conflict)
    // goes back to the sign-in page still headed for the same page; a failure before it keeps nothing, because then
    // nothing vouches for any destination. Never read from the callback's own query.
    let returnUrl: string | undefined;
    let signedIn = false;
    try {
        if (!auth0Enabled()) throw new Auth0Error('auth0_disabled');
        const params = request.nextUrl.searchParams;
        const transaction = readTransaction(request.cookies.get(AUTH0_COOKIE)?.value, params.get('state'), ownedPublicOrigin(request.headers, request.url));
        returnUrl = safeReturnUrl(transaction.returnUrl);
        const code = params.get('code');
        const providerError = params.get('error');
        if (transaction.silent && providerError !== null && SILENT_LOGIN_FALLBACK_ERRORS.has(providerError)) {
            // `prompt=none` found no id.ezil.work session to ride on. One interactive sign-in instead, never another
            // silent one, so this cannot loop.
            destination = `/auth/auth0/login?${new URLSearchParams({ returnUrl })}`;
        } else {
            if (params.has('error') || !code) throw new Auth0Error('auth0_failed');
            const token = await exchangeCode(code, { origin: ownedPublicOrigin(request.headers, request.url), codeVerifier: transaction.codeVerifier });
            const identity = await verifyIdToken(token, { nonce: transaction.nonce });
            // A silent sign-in refreshes the signed-in person's EZiL ID; it never switches the OS account. Before the
            // bridge, which replaces the session.
            if (transaction.silent) await refuseSilentAccountSwitch(identity);
            const sponsor = transaction.sponsor ? sponsorFromTransaction(transaction.sponsor, ownedPublicOrigin(request.headers, request.url), transaction.state, transaction.nonce) : null;
            if (transaction.sponsor && !sponsor) throw new Auth0Error('invalid_transaction');
            if (sponsor) await bridgeAuth0Identity(identity, sponsor);
            else await bridgeAuth0Identity(identity);
            // After the bridge, so the token is bound to the session it just minted. Additive: a failure here never
            // fails the OS sign-in; opening a project then asks for a refresh (IDENTITY_REFRESH_REQUIRED).
            try { await retainProjectIdentity(token); } catch { console.warn('[auth0] identity not retained'); }
            destination = returnUrl;
            signedIn = true;
        }
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        console.warn('[auth0] callback failed', { code });
        destination = `/login?${new URLSearchParams({ error: code, ...(returnUrl === undefined ? {} : { returnUrl }) })}`;
        // Back after a successful sign-in replays id.ezil.work's authorize entry with a state this browser has already
        // spent. Someone still signed in to the OS goes back in instead of reading a refusal; the replayed code is
        // never used, and nobody without a session gets anything new.
        if ((code === 'invalid_transaction' || code === 'state_mismatch') && await hasOsSession()) destination = Routes.OS;
    }
    const response = NextResponse.redirect(new URL(destination, ownedPublicOrigin(request.headers, request.url)));
    response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    if (signedIn) response.cookies.set(SPONSOR_ENTRY_COOKIE, '', { ...SPONSOR_ENTRY_COOKIE_OPTIONS, maxAge: 0 });
    // Signed in: the page a sign-out kept has been reached. A failed attempt keeps it for the retry (Back and refresh
    // included); it expires by itself after ten minutes.
    if (signedIn && request.cookies.has(LOGIN_RETURN_COOKIE)) {
        response.cookies.set(LOGIN_RETURN_COOKIE, '', { ...LOGIN_RETURN_COOKIE_OPTIONS, maxAge: 0 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
