import { createTRPCContext } from '@/server/api/trpc';
import { osOrigin, universeOrigin } from '@/server/assignment-video/contract';
import { assignmentEnrollmentEnabled } from '@/server/git/assignment-enrollment';
import { workReturnAttempt } from '@/utils/assignment-work-auth';
import { getReturnUrlQueryParam } from '@/utils/constants';
import { ownedPublicOrigin } from '@/utils/forwarded';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
    const url = new URL(request.url);
    const attempt = workReturnAttempt(url.pathname + url.search);
    if (!assignmentEnrollmentEnabled() || !attempt || ownedPublicOrigin(request.headers, request.url) !== osOrigin
        || request.headers.get('sec-fetch-dest') !== 'document') return new Response(null, {status:404,headers});
    const contextHeaders = new Headers(request.headers);
    contextHeaders.set('x-trpc-source', 'assignment-work-return');
    const ctx = await createTRPCContext({headers:contextHeaders});
    if (ctx.delegation) return new Response(null, {status:404,headers});
    const next = ctx.user ? universeOrigin + '/assignment/work/' + attempt
        : osOrigin + '/login?' + getReturnUrlQueryParam(url.pathname + url.search);
    return new Response(null, {status:303,headers:{...headers,Location:next}});
}
