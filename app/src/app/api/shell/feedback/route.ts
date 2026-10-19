import { createTRPCContext } from '@/server/api/trpc';
import { handleFeedbackRequest } from '@/server/feedback/http-handler';
import type { ShellFeatureEnv } from '@/server/shell/features';

export const runtime = 'nodejs';
export const maxDuration = 10;

async function handle(req: Request): Promise<Response> {
    return handleFeedbackRequest(req, {
        env: process.env as ShellFeatureEnv,
        getContext: async (request) => {
            const headers = new Headers(request.headers);
            headers.set('x-trpc-source', 'shell-http');
            const ctx = await createTRPCContext({ headers });
            return { user: ctx.user, db: ctx.db };
        },
    });
}

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
// Explicit exports prevent Next's automatic OPTIONS/HEAD handling from
// bypassing the feature-off 404 (docs/FEEDBACK-CONTROLS-CONTRACT.md:13).
export const PUT = handle;
export const PATCH = handle;
export const OPTIONS = handle;
export const HEAD = handle;
