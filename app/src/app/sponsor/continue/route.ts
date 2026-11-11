import { type NextRequest, NextResponse } from 'next/server';
import { AUTH0_COOKIE, AUTH0_COOKIE_OPTIONS, buildAuthorizeUrl } from '@/server/auth/auth0';
import { sponsorEntryAvailable } from '@/server/auth/sponsor-entry';
import { ownedPublicOrigin } from '@/utils/forwarded';

export async function POST(request: NextRequest) {
    const origin = ownedPublicOrigin(request.headers, request.url);
    // Browser-only form handoff: unlike API/webhook routes, missing Origin is refused too.
    if (request.headers.get('origin') !== origin || Number(request.headers.get('content-length') ?? '0') > 2048) return new NextResponse(null, { status: 403 });
    let response: NextResponse;
    try {
        const form = await request.formData();
        const token = form.get('token');
        if (typeof token !== 'string' || !await sponsorEntryAvailable(token)) throw new Error('unavailable');
        // The raw token travels only in this same-origin form body. The provider sees ordinary state/nonce/PKCE.
        const url = await buildAuthorizeUrl({ origin, sponsorToken: token });
        response = NextResponse.redirect(url, 303);
    } catch {
        response = NextResponse.redirect(new URL('/login?error=sponsor_unavailable', origin), 303);
        response.cookies.set(AUTH0_COOKIE, '', { ...AUTH0_COOKIE_OPTIONS, maxAge: 0 });
    }
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('Referrer-Policy', 'no-referrer');
    return response;
}
