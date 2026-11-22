import { createTRPCContext } from '@/server/api/trpc';
import { clearProjectIdentity, retainedIdentity } from '@/server/auth/retained-identity';
import { assignmentEnrollmentEnabled, enrollAssignmentRepository, EnrollmentError } from '@/server/git/assignment-enrollment';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
import { isCrossOriginWrite } from '@/utils/request-origin';

export const dynamic = 'force-dynamic';
export const maxDuration = 70;

/** The page's fetch sends it; a form post or a cross-origin page cannot without a CORS preflight this route never answers. */
const ENROLLMENT_HEADER ='x-ezil-assignment-enrollment';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const refuse = (code: string, message: string, status: number) => shellJson({ error: { code, message } }, status);
const notFound = () => refuse('NOT_FOUND', 'Not found.', 404);
const refreshIdentity = () => refuse('IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to create your assignment repository.', 409);

/**
 * `POST /api/shell/assignment-enrollment` `{attemptId}`: the participant's explicit consent from
 * `/app/assignment-enrollment`. os-staging and allowlisted QA subjects only (`assignmentEnrollmentEnabled`); the actor is
 * the signed-in session's own retained EZiL ID, never anything in the body.
 */
export async function POST(req: Request) {
    try {
        if (!assignmentEnrollmentEnabled()) return notFound();
        // A browser same-origin fetch only: unlike the shell-wide rule, a request carrying neither header is refused too.
        const fetchSite = req.headers.get('sec-fetch-site');
        if (isCrossOriginWrite(req) || (fetchSite !== 'same-origin' && req.headers.get('origin') === null)
            || req.headers.get(ENROLLMENT_HEADER) !== '1') return refuse('FORBIDDEN', 'Open this from EZiL OS.', 403);
        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers });
        if (!ctx.user) return shellUnauthenticated();
        if (ctx.delegation) return notFound();
        let body: unknown;
        try { body = await req.json(); } catch { return refuse('BAD_REQUEST', 'Expected a JSON body.', 400); }
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'attemptId'
            || typeof (body as { attemptId: unknown }).attemptId !== 'string' || !UUID.test((body as { attemptId: string }).attemptId))
            return refuse('BAD_REQUEST', 'Expected an assignment attempt.', 400);
        const attemptId = (body as { attemptId: string }).attemptId;
        const identity = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!identity) return refreshIdentity();
        let result;
        try { result = await enrollAssignmentRepository({ identity, attemptId }, { signal: req.signal }); }
        catch (error) {
            if (!(error instanceof EnrollmentError)) throw error;
            if (error.code === 'identity_refused') { await clearProjectIdentity().catch(() => {}); return refreshIdentity(); }
            if (error.code === 'not_authorized' || error.code === 'not_owner')
                return refuse('assignment_not_authorized', 'This assignment is not available to your account.', 403);
            if (error.code === 'attempt_closed') return refuse('assignment_closed', 'This assignment attempt is closed or already has a repository.', 409);
            if (error.code === 'rate_limited') return refuse('assignment_rate_limited', 'Too many attempts. Try again shortly.', 429);
            return refuse('assignment_unavailable', 'Your assignment repository could not be set up. Try again.', 503);
        }
        // The same person and session must still be signed in to receive the result.
        const current = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!current || current.sessionId !== identity.sessionId || current.subject !== identity.subject) return refreshIdentity();
        if (result.status === 'pending')
            return shellJson({ status: 'pending', attemptId, reason: result.reason }, 202);
        const codeUrl = `/app/code?${new URLSearchParams({ repo: result.repositoryUrl, assignment: attemptId })}`;
        return shellJson({ status: 'bound', attemptId, ref: result.ref, baseSha: result.baseSha, codeUrl });
    } catch (error) { return shellErrorResponse(error, 'POST /api/shell/assignment-enrollment'); }
}
