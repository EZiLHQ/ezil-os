import { type NextRequest, NextResponse } from 'next/server';

import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, auth0Enabled, exchangeCode, readTransaction, verifyIdToken } from '@/server/auth/auth0';
import { bridgeAuth0Identity } from '@/server/auth/bridge';
import { safeReturnUrl } from '@/utils/constants';

export async function GET(request: NextRequest) {
    let destination: string;
    try {
        if (!auth0Enabled()) throw new Auth0Error('auth0_disabled');
        const params = request.nextUrl.searchParams;
        const transaction = readTransaction(request.cookies.get(AUTH0_COOKIE)?.value, params.get('state'));
        const code = params.get('code');
        if (params.has('error') || !code) throw new Auth0Error('auth0_failed');
        const token = await exchangeCode(code, { origin: request.nextUrl.origin, codeVerifier: transaction.codeVerifier });
        const identity = await verifyIdToken(token, { nonce: transaction.nonce });
        await bridgeAuth0Identity(identity);
        destination = safeReturnUrl(transaction.returnUrl);
    } catch (error) {
        destination = `/login?error=${error instanceof Auth0Error ? error.code : 'auth0_failed'}`;
    }
    const response = NextResponse.redirect(new URL(destination, request.url));
    response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
