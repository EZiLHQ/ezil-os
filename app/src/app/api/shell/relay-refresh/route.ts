import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
export const maxDuration = 60;
async function caller(req: Request) {
    const headers = new Headers(req.headers); headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, api: appRouter.createCaller(ctx).cloudflareGuacamole };
}
export async function GET(req: Request) {
    try { const { ctx, api } = await caller(req); if (!ctx.user) return shellUnauthenticated();
        return shellJson(await api.relayState({ computerId: new URL(req.url).searchParams.get('computerId') ?? '' }));
    } catch (error) { return shellErrorResponse(error, 'GET /api/shell/relay-refresh'); }
}
export async function POST(req: Request) {
    try { const { ctx, api } = await caller(req); if (!ctx.user) return shellUnauthenticated();
        let body: { computerId?: string; runtimeId?: string }; try { body = await req.json(); } catch { return shellJson({ ok:false,error:'relay_bad_request' },400); }
        return shellJson(await api.refreshRelay({ computerId:body?.computerId ?? '',runtimeId:body?.runtimeId ?? '' }));
    } catch (error) { return shellErrorResponse(error, 'POST /api/shell/relay-refresh'); }
}
