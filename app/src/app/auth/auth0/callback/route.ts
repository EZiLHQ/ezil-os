import { type NextRequest, NextResponse } from 'next/server';

import {
    AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, auth0Enabled, exchangeCode, readTransaction, SILENT_LOGIN_FALLBACK_ERRORS, verifyIdToken,
} from '@/server/auth/auth0';
import { bridgeAuth0Identity, refuseSilentAccountSwitch } from '@/server/auth/bridge';
import { retainProjectIdentity } from '@/server/auth/retained-identity';
import { safeReturnUrl } from '@/utils/constants';
import { ownedPublicOrigin } from '@/utils/forwarded';

export async function GET(request: NextRequest) {
    let destination: string;
    try {
        if (!auth0Enabled()) throw new Auth0Error('auth0_disabled');
        const params = request.nextUrl.searchParams;
        const transaction = readTransaction(request.cookies.get(AUTH0_COOKIE)?.value, params.get('state'));
        const code = params.get('code');
        const providerError = params.get('error');
        if (transaction.silent && providerError !== null && SILENT_LOGIN_FALLBACK_ERRORS.has(providerError)) {
            // `prompt=none` found no id.ezil.work session to ride on. One interactive sign-in instead, never another
            // silent one, so this cannot loop.
            destination = `/auth/auth0/login?${new URLSearchParams({ returnUrl: safeReturnUrl(transaction.returnUrl) })}`;
        } else {
            if (params.has('error') || !code) throw new Auth0Error('auth0_failed');
            const token = await exchangeCode(code, { origin: ownedPublicOrigin(request.headers, request.url), codeVerifier: transaction.codeVerifier });
            const identity = await verifyIdToken(token, { nonce: transaction.nonce });
            // A silent sign-in refreshes the signed-in person's EZiL ID; it never switches the OS account. Before the
            // bridge, which replaces the session.
            if (transaction.silent) await refuseSilentAccountSwitch(identity);
            await bridgeAuth0Identity(identity);
            // After the bridge, so the token is bound to the session it just minted. Additive: a failure here never
            // fails the OS sign-in; opening a project then asks for a refresh (IDENTITY_REFRESH_REQUIRED).
            try { await retainProjectIdentity(token); } catch { console.warn('[auth0] identity not retained'); }
            destination = safeReturnUrl(transaction.returnUrl);
        }
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        console.warn('[auth0] callback failed', { code });
        destination = `/login?error=${code}`;
    }
    const response = NextResponse.redirect(new URL(destination, ownedPublicOrigin(request.headers, request.url)));
    response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
