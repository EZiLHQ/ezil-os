import { type NextRequest, NextResponse } from 'next/server';

import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, Auth0Error, buildAuthorizeUrl } from '@/server/auth/auth0';
import { embeddedWorkReturn, isAssignmentCodeReturn } from '@/utils/assignment-work-auth';
import { safeReturnUrl } from '@/utils/constants';
import { ownedPublicOrigin } from '@/utils/forwarded';

export async function GET(request: NextRequest) {
    const returnUrl = request.nextUrl.searchParams.get('returnUrl');
    const requestedPrompt = request.nextUrl.searchParams.get('prompt');
    const assignmentSignIn = requestedPrompt === 'login' && returnUrl !== null
        && returnUrl === safeReturnUrl(returnUrl) && (isAssignmentCodeReturn(returnUrl) || embeddedWorkReturn(returnUrl) !== null);
    const prompt = requestedPrompt === 'none' ? 'none' : assignmentSignIn ? 'login' : undefined;
    let response: NextResponse;
    try {
        const url = await buildAuthorizeUrl({ origin: ownedPublicOrigin(request.headers, request.url), returnUrl, prompt });
        response = NextResponse.redirect(url);
    } catch (error) {
        const code = error instanceof Auth0Error ? error.code : 'auth0_failed';
        // The sign-in page again, still headed for the same (narrowed) page.
        const query = new URLSearchParams({ error: code, ...(returnUrl === null ? {} : { returnUrl: safeReturnUrl(returnUrl) }) });
        response = NextResponse.redirect(new URL(`/login?${query}`, request.url));
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
