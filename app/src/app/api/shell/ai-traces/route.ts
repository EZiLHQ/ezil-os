import { after } from 'next/server';
import { createTRPCContext } from '@/server/api/trpc';
import { handleAiTracesPost } from '@/server/ai-traces/http-handler';
export const maxDuration = 10;
export async function POST(req: Request): Promise<Response> {
    return handleAiTracesPost(req, {
        getContext: async request => {
            const headers = new Headers(request.headers);
            headers.set('x-trpc-source', 'shell-http');
            const ctx = await createTRPCContext({ headers });
            return { user: ctx.user, db: ctx.db };
        },
        schedule: after,
    });
}
