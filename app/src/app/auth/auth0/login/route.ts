import { type NextRequest, NextResponse } from 'next/server';

import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, buildAuthorizeUrl } from '@/server/auth/auth0';
import { ownedPublicOrigin } from '@/utils/forwarded';

export async function GET(request: NextRequest) {
    try {
        // `prompt=none` exactly, or nothing: the silent re-auth that refreshes the retained ID token.
        const prompt = request.nextUrl.searchParams.get('prompt') === 'none' ? 'none' : undefined;
        const url = await buildAuthorizeUrl({ origin: ownedPublicOrigin(request.headers, request.url), returnUrl: request.nextUrl.searchParams.get('returnUrl'), prompt });
        const response = NextResponse.redirect(url);
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        const response = NextResponse.redirect(new URL(`/login?error=${code}`, request.url));
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
        response.headers.set('Cache-Control', 'no-store');
        response.headers.set('Referrer-Policy', 'no-referrer');
        return response;
    }
}
