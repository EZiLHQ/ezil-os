import { createHash } from 'node:crypto';
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

function category(code: string): 'identity' | 'checkout' | 'phase' | 'media' | 'request' | 'other' {
    if (code === 'identity_refresh_required' || code === 'assignment_identity_mismatch') return 'identity';
    if (code === 'assignment_open_required' || code === 'assignment_open_unavailable' || code === creatorUnlinked) return 'checkout';
    if (code === 'recording_phase_changed' || code === 'recording_closed' || code === 'seed_not_confirmed') return 'phase';
    if (code === 'media_unavailable' || code === 'recording_unavailable' || code === 'recording_refused') return 'media';
    if (code === 'invalid_request') return 'request';
    return 'other';
}

export async function POST(req: Request) {
    let diagnostic: {event:string;attemptTag:string} | undefined;
    const finish = (response: Response, code?: string) => {
        if (diagnostic) console.info(JSON.stringify({...diagnostic,status:response.status,
            outcome:response.ok ? 'accepted' : 'refused', ...(code ? {category:category(code)} : {})}));
        return response;
    };
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
        const input = parsed.data;
        if (input.action === 'preflight' || input.action === 'begin' || input.action === 'editor-ready') {
            diagnostic = {event:'assignment.workspace.broker.'+input.action,
                attemptTag:createHash('sha256').update('ezil.assignment.stage.v1\0').update(input.attemptId).digest('hex').slice(0,16)};
        }
        const identity = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!identity) return finish(fail('identity_refresh_required',401),'identity_refresh_required');
        const repositoryUrl = req.headers.get('x-ezil-assignment-repository');
        if (input.action === 'preflight' && repositoryUrl !== null) {
            if (assignmentRepositoryAttempt(repositoryUrl) !== input.attemptId) return finish(fail('invalid_request',400),'invalid_request');
            // Compare the link with the verified local identity without looking up the attempt or its owner.
            if (repositoryUrl !== expectedRepositoryURL(identity.subject, 'a-' + input.attemptId))
                return finish(fail('assignment_identity_mismatch',409),'assignment_identity_mismatch');
        }
        const result = await recordingAction(identity, input, {signal: req.signal}).catch((error: unknown) => {
            if (parsed.data.action === 'preflight' && error instanceof BrokerError
                && error.code === creatorUnlinked && error.status === 409) return null;
            throw error;
        });
        const current = await retainedIdentity(ctx.user.id).catch(() => null);
        if (!current || current.sessionId !== identity.sessionId || current.subject !== identity.subject)
            return finish(fail('identity_refresh_required',401),'identity_refresh_required');
        return result === null ? finish(fail(creatorUnlinked,409),creatorUnlinked) : finish(shellJson(result));
    } catch (error) {
        // Control errors must never put private upstream bodies, auth headers or presigned URLs into a browser or log.
        return error instanceof BrokerError
            ? finish(fail(error.code === creatorUnlinked ? 'recording_refused' : error.code,error.status),error.code)
            : finish(fail('media_unavailable',503),'media_unavailable');
    }
}
