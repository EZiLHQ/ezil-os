import { z } from 'zod';
import { shellFeaturesFor, type ShellFeatureEnv } from '@/server/shell/features';
import { shellJson, shellUnauthenticated } from '@/server/shell/http';
import { deleteFeedback, ingestFeedback, listFeedback, type FeedbackDb } from './ingest';
import { FeedbackImageError } from './image';
import { FEEDBACK_LIMITS, feedbackSubmitSchema } from './types';

export interface FeedbackHandlerDeps {
    getContext: (req: Request) => Promise<{ user: { id: string; email?: string | null } | null; db: FeedbackDb }>;
    env: ShellFeatureEnv;
    now?: () => Date;
    /** The deployed commit stamped on each new report (`deploy-sha.ts`); null when unknown. */
    deploySha?: string | null;
}

const invalidRequest = () => shellJson({ error: 'invalid_request' }, 400);

/** Round-3 F10: a cross-site form can only send simple content types, so a
 * JSON-only POST cannot be forged by a page that rides the lax session cookie. */
function isJson(req: Request): boolean {
    const type = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    return type === 'application/json';
}

/** Byte-counted, like telemetry/http-handler.ts:80: Content-Length is untrusted,
 * and a too-large stream is cancelled before retaining any further chunks. */
async function readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
    if (!req.body) return '';
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel().catch(() => {});
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export async function handleFeedbackRequest(req: Request, deps: FeedbackHandlerDeps): Promise<Response> {
    try {
        // Global-off must be 404 even without a session or with a broken auth
        // provider; feature parsing stays in shell/features.ts:46.
        if (!shellFeaturesFor(undefined, { ...deps.env, FEEDBACK_PILOT_EMAILS: undefined }).feedback) {
            return shellJson({ error: 'not_found' }, 404);
        }
        const { user, db } = await deps.getContext(req);
        if (!user) return shellUnauthenticated();
        const features = shellFeaturesFor(user.email, deps.env);
        if (!features.feedback) return shellJson({ error: 'not_found' }, 404);
        if (req.method === 'POST') {
            if (!isJson(req)) return shellJson({ error: 'unsupported_media_type' }, 415);
            let raw: unknown;
            try {
                const body = await readBoundedBody(req, features.feedbackScreenshots
                    ? FEEDBACK_LIMITS.bodyBytesWithScreenshot : FEEDBACK_LIMITS.bodyBytesNoScreenshot);
                if (body === null) return shellJson({ error: 'payload_too_large' }, 413);
                raw = JSON.parse(body);
            } catch { return invalidRequest(); }
            const parsed = feedbackSubmitSchema.safeParse(raw);
            if (!parsed.success || (!features.feedbackScreenshots && parsed.data.screenshot != null)) return invalidRequest();
            const result = await ingestFeedback(db, user.id, parsed.data, deps.now?.() ?? new Date(), deps.deploySha ?? null);
            return result.status === 429 ? shellJson({ error: 'rate_limited' }, 429) : shellJson(result.created, result.status);
        }
        if (req.method === 'GET') return shellJson({ reports: await listFeedback(db, user.id) });
        if (req.method === 'DELETE') {
            const id = z.string().uuid().safeParse(new URL(req.url).searchParams.get('id'));
            if (!id.success) return invalidRequest();
            if (!await deleteFeedback(db, user.id, id.data)) return shellJson({ error: 'not_found' }, 404);
            return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
        }
        return shellJson({ error: 'method_not_allowed' }, 405);
    } catch (error) {
        if (error instanceof FeedbackImageError) return shellJson({ error: error.message }, error.status);
        // DB/auth failures can include secrets or submitted text; return only a
        // fixed error, as shell/http.ts:49 requires of server failures.
        return shellJson({ error: 'internal_error' }, 500);
    }
}
