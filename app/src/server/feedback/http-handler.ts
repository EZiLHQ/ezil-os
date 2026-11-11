import { z } from 'zod';
import { shellFeaturesFor, type ShellFeatureEnv } from '@/server/shell/features';
import { shellJson, shellUnauthenticated } from '@/server/shell/http';
import { deleteFeedback, ingestFeedback, listFeedback, stageFeedbackImage, type FeedbackDb } from './ingest';
import { FeedbackImageError, inspectImage } from './image';
import { FEEDBACK_IMAGE_TYPES, FEEDBACK_LIMITS, feedbackSubmitSchema, submittedImages } from './types';

export interface FeedbackHandlerDeps {
    getContext: (req: Request) => Promise<{ user: { id: string; email?: string | null } | null; db: FeedbackDb }>;
    env: ShellFeatureEnv;
    now?: () => Date;
    /** The deployed commit stamped on each new report (`deploy-sha.ts`); null when unknown. */
    deploySha?: string | null;
}

const invalidRequest = () => shellJson({ error: 'invalid_request' }, 400);

/**
 * Upload-first spans several requests, and the session cookie can change between them (another tab signs in as
 * someone else). The shell names the account it froze the report for in this header; it is compared with the
 * signed-in user only, never trusted as an identity. Required for staging and `screenshotRefs`, checked when present
 * on any other POST. 'absent' = no header; null = this account; otherwise the refusal (which never names the other account).
 */
export const FEEDBACK_ACCOUNT_HEADER = 'x-ezil-feedback-account';
function accountRefusal(req: Request, userId: string): Response | null | 'absent' {
    const value = req.headers.get(FEEDBACK_ACCOUNT_HEADER);
    if (value === null) return 'absent';
    if (!z.string().uuid().safeParse(value.trim()).success) return shellJson({ error: 'invalid_account_header' }, 400);
    return value.trim().toLowerCase() === userId.toLowerCase() ? null : shellJson({ error: 'account_changed' }, 409);
}

/** Round-3 F10: a cross-site form can only send simple content types, so a
 * JSON-only POST cannot be forged by a page that rides the lax session cookie. */
function isJson(req: Request): boolean {
    const type = req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    return type === 'application/json';
}

/** Byte-counted, like telemetry/http-handler.ts:80: Content-Length is untrusted,
 * and a too-large stream is cancelled before retaining any further chunks. */
async function readBoundedBody(req: Request, maxBytes: number): Promise<string | null> {
    const bytes = await readBoundedBytes(req, maxBytes);
    return bytes === null ? null : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

async function readBoundedBytes(req: Request, maxBytes: number): Promise<Uint8Array | null> {
    if (!req.body) return new Uint8Array(0);
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
    return bytes;
}

/** Upload-first `PUT ?crid=`: the raw image as its own content type (never a simple form type, so never cross-site). */
async function stageImage(req: Request, deps: FeedbackHandlerDeps, userId: string, db: FeedbackDb): Promise<Response> {
    const crid = z.string().uuid().safeParse(new URL(req.url).searchParams.get('crid'));
    if (!crid.success) return invalidRequest();
    const type = z.enum(FEEDBACK_IMAGE_TYPES).safeParse(req.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase());
    if (!type.success) return shellJson({ error: 'unsupported_media_type' }, 415);
    const bytes = await readBoundedBytes(req, FEEDBACK_LIMITS.imageBytesMax);
    if (bytes === null) return shellJson({ error: 'payload_too_large' }, 413);
    const image = inspectImage(type.data, Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    const result = await stageFeedbackImage(db, userId, crid.data.toLowerCase(), image, deps.now?.() ?? new Date());
    return 'staged' in result ? shellJson(result.staged, result.status) : shellJson({ error: result.error }, result.status);
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
            // Before the body is read: a report frozen for another account is never stored under this one.
            const account = accountRefusal(req, user.id);
            if (account instanceof Response) return account;
            let raw: unknown;
            try {
                const body = await readBoundedBody(req, features.feedbackScreenshots
                    ? FEEDBACK_LIMITS.bodyBytesWithScreenshot : FEEDBACK_LIMITS.bodyBytesNoScreenshot);
                if (body === null) return shellJson({ error: 'payload_too_large' }, 413);
                raw = JSON.parse(body);
            } catch { return invalidRequest(); }
            const parsed = feedbackSubmitSchema.safeParse(raw);
            if (!parsed.success || (!features.feedbackScreenshots
                && (submittedImages(parsed.data).length > 0 || parsed.data.screenshotRefs))) return invalidRequest();
            if (parsed.data.screenshotRefs && account === 'absent') return shellJson({ error: 'account_header_required' }, 400);
            // The references are metadata: they count toward the small-body limit like the text.
            const metadata = { ...parsed.data, screenshot: null, screenshots: undefined };
            if (new TextEncoder().encode(JSON.stringify(metadata)).length > FEEDBACK_LIMITS.bodyBytesNoScreenshot) {
                return shellJson({ error: 'payload_too_large' }, 413);
            }
            const result = await ingestFeedback(db, user.id, parsed.data, deps.now?.() ?? new Date(), deps.deploySha ?? null);
            if (result.status === 429) return shellJson({ error: 'rate_limited' }, 429);
            if (result.status === 409) return shellJson({ error: result.error }, 409);
            return shellJson(result.created, result.status);
        }
        if (req.method === 'PUT') {
            if (!features.feedbackScreenshots) return shellJson({ error: 'not_found' }, 404);
            const account = accountRefusal(req, user.id);
            if (account === 'absent') return shellJson({ error: 'account_header_required' }, 400);
            if (account) return account;
            return await stageImage(req, deps, user.id, db);
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
