import { createTRPCContext } from '@/server/api/trpc';
import { db } from '@/server/db';
import { consentAccept, consentStatus, type HandlerResult } from '@/server/interview/service';
import { shellErrorResponse, shellJson } from '@/server/shell/http';
import { stagingGitQaAccepted } from '@/server/works/project-repo';
import { retainedIdentityOrRefusal } from '@/server/works/shell-project';

/**
 * `/api/shell/interview-consent` (docs/contracts/interview-evidence-v1.md §7.3).
 *
 * A TRANSPORT ONLY, like every `/api/shell/*` handler: `createTRPCContext` is the one authentication implementation,
 * and the candidate-recognition/state logic lives in `@/server/interview/service`. `{action:'status'}` returns the
 * notice for the candidate; `{action:'accept'}` binds the candidate and moves the interview to `consented`. The
 * staging gate is checked first inside the handlers, so a closed gate is 404 for everyone (A6).
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request): Promise<Response> {
    try {
        const gateOn = stagingGitQaAccepted();
        let body: Record<string, unknown> | null = null;
        try { body = (await req.json()) as Record<string, unknown>; } catch { body = null; }

        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers });
        const osUserId = ctx.user?.id ?? null;
        // The retained EZiL ID subject, resolved only when a pre-consent candidate check needs it.
        const subject = async (): Promise<string | null> => {
            if (!osUserId) return null;
            const identity = await retainedIdentityOrRefusal(osUserId);
            return identity instanceof Response ? null : identity.subject;
        };

        const action = typeof body?.action === 'string' ? body.action : null;
        const now = () => new Date().toISOString();
        let result: HandlerResult;
        if (action === 'status') {
            const repository = body?.repository as { url?: unknown } | undefined;
            result = await consentStatus(db, { gateOn, osUserId, subject, url: repository?.url });
        } else if (action === 'accept') {
            result = await consentAccept(db, {
                gateOn, osUserId, subject,
                interviewId: body?.interviewId, noticeVersion: body?.noticeVersion, noticeSha256: body?.noticeSha256, now,
            });
        } else if (!gateOn) {
            result = { status: 404, body: { error: { code: 'not_found', message: 'Not found.' } } };
        } else if (osUserId === null) {
            result = { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.', reason: 'session_missing' } } };
        } else {
            result = { status: 400, body: { error: { code: 'invalid_request', message: 'Unknown action.' } } };
        }
        return shellJson(result.body, result.status);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/interview-consent');
    }
}
