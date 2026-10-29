import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/switch` — round 3 (contract v3 D5): switch the caller's one computer to another
 * configuration. A TRANSPORT only, exactly like `../restart/route.ts`: authenticated first,
 * then the body, then `computer.switchConfiguration`, which checks ownership, the plan, any
 * in-flight switch and capacity, and answers a VALUE (`SwitchConfigurationOutputV3`), never a
 * thrown refusal. A RUNNING computer answers `switching` at once; the server-side stop → wake
 * continues after the answer (`after()`), bounded by this route's budget, and its phases are read
 * from `computer.progress` (`transition`). docs/aws-computers/SWITCH-CONTRACT.md.
 *
 *   POST { computerId, size, requestId } -> SwitchConfigurationOutputV3
 */
export const maxDuration = 300;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body: an unauthenticated caller learns exactly one thing.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', size = '', requestId = '' } = (body ?? {}) as { computerId?: string; size?: string; requestId?: string };

        const result = await caller.computer.switchConfiguration({ computerId, size: size as 'std-2', requestId });

        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/switch');
    }
}
