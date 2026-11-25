import { createTRPCContext } from '@/server/api/trpc';
import { retainedIdentity } from '@/server/auth/retained-identity';
import { recordingAction } from '@/server/assignment-video/broker';
import { boundedJson, BrokerError, creatorUnlinked, osOrigin, requestSchema, universeOrigin } from '@/server/assignment-video/contract';
import { shellJson, shellUnauthenticated } from '@/server/shell/http';
import { expectedRepositoryURL } from '@/server/git/assignment-enrollment';
import { assignmentRepositoryAttempt } from '@/utils/assignment-work-auth';
import { isCrossOriginWrite } from '@/utils/request-origin';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 45;
const fail = (code: string, status: number) => shellJson({error: {code}}, status);

export async function POST(req: Request) {
    try {
        // Staging's renderer pins this marker; production's renderer rejects it. Media begin additionally requires a sealed, enrolled repository-open receipt.
        const configuredUniverse = process.env.UNIVERSE_PROJECT_REPO_ORIGIN;
        if (!['https://ai-staging.ezil.work', 'https://ai-staging.ezil.work/'].includes(process.env.BILLING_FUNDING_URL ?? '')
            || (configuredUniverse && configuredUniverse !== universeOrigin)) return fail('not_found', 404);
        if (req.headers.get('origin') !== osOrigin || isCrossOriginWrite(req)
            || (req.headers.has('sec-fetch-site') && req.headers.get('sec-fetch-site') !== 'same-origin')
            || req.headers.get('x-ezil-assignment-video') !== '1') return fail('forbidden', 403);
        if (req.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json')
            return fail('invalid_request', 400);
        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({headers});
        if (!ctx.user) return shellUnauthenticated();
        if (ctx.delegation) return fail('not_found', 404);
        const parsed = requestSchema.safeParse(await boundedJson(req.body, 2048, 400));
        if (!parsed.success) return fail('invalid_request', 400);
        const identity = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!identity) return fail('identity_refresh_required', 401);
        const input = parsed.data;
        const repositoryUrl = req.headers.get('x-ezil-assignment-repository');
        if (input.action === 'preflight' && repositoryUrl !== null) {
            if (assignmentRepositoryAttempt(repositoryUrl) !== input.attemptId) return fail('invalid_request', 400);
            // Compare the link with the verified local identity without looking up the attempt or its owner.
            if (repositoryUrl !== expectedRepositoryURL(identity.subject, 'a-' + input.attemptId))
                return fail('assignment_identity_mismatch', 409);
        }
        const result = await recordingAction(identity, input, {signal: req.signal}).catch((error: unknown) => {
            if (parsed.data.action === 'preflight' && error instanceof BrokerError
                && error.code === creatorUnlinked && error.status === 409) return null;
            throw error;
        });
        const current = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!current || current.sessionId !== identity.sessionId || current.subject !== identity.subject)
            return fail('identity_refresh_required', 401);
        return result === null ? fail(creatorUnlinked, 409) : shellJson(result);
    } catch (error) {
        // Control errors must never put private upstream bodies, auth headers or presigned URLs into a browser or log.
        return error instanceof BrokerError
            ? fail(error.code === creatorUnlinked ? 'recording_refused' : error.code, error.status)
            : fail('media_unavailable', 503);
    }
}
