import { createTRPCContext } from '@/server/api/trpc';
import { assignmentAuthority, productionAssignment } from '@/server/assignment-video/authority';
import { assignmentEnrollmentEnabled } from '@/server/git/assignment-enrollment';
import { embeddedWorkReturnSuffix, workReturnAttempt } from '@/utils/assignment-work-auth';
import { getReturnUrlQueryParam } from '@/utils/constants';
import { publicOrigin } from '@/utils/forwarded';

export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
    const url = new URL(request.url);
    const returnPath = url.pathname + url.search;
    const attempt = workReturnAttempt(returnPath);
    const embedded = returnPath.endsWith(embeddedWorkReturnSuffix);
    // OS and Universe are one selected deployment: the return is served only on that deployment's own OS origin and
    // leads only to its paired Universe. Production serves the embedded workspace return alone; its top-level
    // assignment tab never used this route.
    const authority = assignmentAuthority();
    if (!authority || !assignmentEnrollmentEnabled() || !attempt || (authority === productionAssignment && !embedded)
        || publicOrigin(request.headers, request.url) !== authority.os
        || request.headers.get('sec-fetch-dest') !== 'document') return new Response(null, {status:404,headers});
    const contextHeaders = new Headers(request.headers);
    contextHeaders.set('x-trpc-source', 'assignment-work-return');
    const ctx = await createTRPCContext({headers:contextHeaders});
    if (ctx.delegation) return new Response(null, {status:404,headers});
    const next = ctx.user ? authority.universe + (embedded ? '/assignment/workspace/' : '/assignment/work/') + attempt
        : authority.os + '/login?' + getReturnUrlQueryParam(returnPath);
    return new Response(null, {status:303,headers:{...headers,Location:next}});
}
