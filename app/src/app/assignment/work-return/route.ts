import { createTRPCContext } from '@/server/api/trpc';
import { osOrigin, universeOrigin } from '@/server/assignment-video/contract';
import { retainedIdentity } from '@/server/auth/retained-identity';
import { assignmentEnrollmentEnabled, ownerRepositoryName } from '@/server/git/assignment-enrollment';
import { embeddedWorkReturn, workAccountNotice, workReturnAttempt } from '@/utils/assignment-work-auth';
import { getReturnUrlQueryParam } from '@/utils/constants';
import { ownedPublicOrigin } from '@/utils/forwarded';

export const dynamic = 'force-dynamic';

/**
 * One silent EZiL ID refresh per return, remembered for two minutes. A hint that only ever stops a redirect: the
 * refresh is asked for again when it is absent, and the lock screen is shown when it is present and nothing was kept.
 */
const REFRESH_COOKIE = '__Host-ezil-work-return';
/** A work window is one hour. An identity that would run out inside it is refreshed before the editor opens. */
const WINDOW_VALIDITY_MS = 75 * 60_000;

const refreshCookie = (value: string, maxAge: number) =>
    `${REFRESH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
const refreshed = (request: Request, attempt: string) =>
    (request.headers.get('cookie') ?? '').split(';').some(part => part.trim() === `${REFRESH_COOKIE}=${attempt}`);

/**
 * `/assignment/work-return` — where the Universe assignment page sends its own tab for an EZiL OS sign-in, and where
 * that sign-in comes back to. A top-level document only, on staging only; it answers with a redirect and nothing else.
 *
 * `?attempt=<id>` alone is the standalone return: unchanged (signed in → Universe's work redirect, else the lock screen).
 *
 * `&workspace=1` is the embedded workspace, whose framed editor needs more than an OS session: the retained EZiL ID
 * of that session (`@/server/auth/retained-identity`), for the same person Universe assigned. So, in order:
 *  1. no OS session → the ordinary EZiL ID sign-in, without the lock screen's extra click. There is no OS account to
 *     switch away from; a live id.ezil.work session answers without asking.
 *  2. an OS session whose EZiL ID is missing, or would expire inside a work window → ONE silent (`prompt=none`)
 *     refresh. The callback refuses a silent answer for any other account, so this never changes who is signed in.
 *     Still nothing kept after it → the lock screen, which never redirects.
 *  3. `&owner=<tag>` names the repository owner Universe assigned. When the tag derived from this session's verified
 *     EZiL ID differs, this is another account: the lock screen says so and its sign-in asks id.ezil.work for the
 *     account explicitly. The comparison is local and exact; nothing is inferred from Universe refusing a request.
 *  4. otherwise → the Universe workspace.
 * Every branch ends at Universe, at id.ezil.work's own top-level page, or at the lock screen, so none can loop.
 */
export async function GET(request: Request): Promise<Response> {
    const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "frame-ancestors 'none'", 'X-Frame-Options': 'DENY' };
    const url = new URL(request.url);
    const returnPath = url.pathname + url.search;
    const attempt = workReturnAttempt(returnPath);
    if (!assignmentEnrollmentEnabled() || !attempt || ownedPublicOrigin(request.headers, request.url) !== osOrigin
        || request.headers.get('sec-fetch-dest') !== 'document') return new Response(null, {status:404,headers});
    const contextHeaders = new Headers(request.headers);
    contextHeaders.set('x-trpc-source', 'assignment-work-return');
    const ctx = await createTRPCContext({headers:contextHeaders});
    if (ctx.delegation) return new Response(null, {status:404,headers});
    const to = (location: string, cookie?: string) =>
        new Response(null, {status:303,headers:{...headers,Location:location,...(cookie ? {'Set-Cookie':cookie} : {})}});
    const lockScreen = (query: Record<string, string> = {}) =>
        osOrigin + '/login?' + new URLSearchParams({...query, returnUrl: returnPath});

    const embedded = embeddedWorkReturn(returnPath);
    if (!embedded) return to(ctx.user ? universeOrigin + '/assignment/work/' + attempt : osOrigin + '/login?' + getReturnUrlQueryParam(returnPath));

    const signIn = osOrigin + '/auth/auth0/login?';
    if (!ctx.user) return to(signIn + getReturnUrlQueryParam(returnPath));
    const identity = await retainedIdentity(ctx.user.id).catch(() => null);
    const tried = refreshed(request, attempt);
    if (!tried && (!identity || identity.expiresAt - Date.now() < WINDOW_VALIDITY_MS))
        return to(signIn + new URLSearchParams({prompt: 'none', returnUrl: returnPath}), refreshCookie(attempt, 120));
    const settled = tried ? refreshCookie('', 0) : undefined;
    if (!identity) return to(lockScreen({error: 'auth_callback_failed'}), settled);
    if (embedded.owner !== null && ownerRepositoryName(identity.subject, 'a-' + attempt) !== `u-${embedded.owner}-a-${attempt}`)
        return to(lockScreen({error: workAccountNotice}), settled);
    return to(universeOrigin + '/assignment/workspace/' + attempt, settled);
}
