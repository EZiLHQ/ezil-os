import { NextResponse, type NextRequest } from 'next/server';

import { isCrossOriginWrite, isDocumentNavigation } from '@/utils/request-origin';
import { updateSession } from '@/utils/supabase/middleware';

/**
 * Next.js 16 renamed the `middleware` file convention to `proxy` (the
 * function name itself is unaffected — only the filename matters to
 * Next's build). Named `proxy.ts` here to avoid the "middleware file
 * convention is deprecated" build warning.
 */
export async function proxy(request: NextRequest) {
    // Before the session is touched: a refused request must not refresh it.
    if (isCrossOriginWrite(request)) {
        // A refused form submission is a page the user is looking at; give it
        // a sentence, not a JSON blob. API callers keep the machine-readable code.
        return isDocumentNavigation(request)
            ? new NextResponse('This request came from another site, so EZiL OS refused it.', {
                  status: 403,
                  headers: { 'content-type': 'text/plain; charset=utf-8' },
              })
            : NextResponse.json({ error: 'cross_origin_request_refused' }, { status: 403 });
    }
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
