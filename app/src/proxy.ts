import { NextResponse, type NextRequest } from 'next/server';

import { updateSession } from '@/utils/supabase/middleware';

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy` (the
 * function name itself is unaffected — only the filename matters to
 * Next's build). Named `proxy.ts` here to avoid the "middleware file
 * convention is deprecated" build warning.
 */
export async function proxy(request: NextRequest) {
    // This service endpoint authenticates its signed body itself. Unrelated
    // browser cookies must not trigger Supabase refresh or Set-Cookie here.
    if (request.nextUrl.pathname === '/api/internal/apps/configuration-authority'
        || request.nextUrl.pathname === '/api/internal/computers/lifecycle-authority'
        || request.nextUrl.pathname === '/api/internal/computers/cancellation-authority') return NextResponse.next();
    return updateSession(request);
}

export const config = {
    matcher: [
        /*
         * Run on every request except static assets and Next's own
         * internals — matches the standard Supabase SSR middleware matcher.
         */
        '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
    ],
};
