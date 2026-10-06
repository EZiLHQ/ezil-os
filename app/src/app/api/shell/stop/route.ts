import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
export const maxDuration = 300;
/** Final checkpoint + teardown, preserving the computer row and durable workspace. */
export async function POST(req: Request) {
    try {
        const headers = new Headers(req.headers); headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers }); if (!ctx.user) return shellUnauthenticated();
        let body: { computerId?: string }; try { body = await req.json(); } catch { return shellJson({ ok:false,error:'invalid_json_body' },400); }
        return shellJson(await appRouter.createCaller(ctx).cloudflareGuacamole.terminate({ computerId:body?.computerId ?? '' }));
    } catch (error) { return shellErrorResponse(error, 'POST /api/shell/stop'); }
}
