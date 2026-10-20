import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `GET /api/shell/system?computerId=…` — what Settings → System may say about
 * the machine behind a computer (provider, configured size, lifecycle state).
 *
 * FEATURE-DETECTED like `../screen/route.ts`: the `system` key in
 * `SHELL_API_ROUTES` and this file ship together, and the tab renders its
 * "Machine" section as unknown when the key is absent.
 *
 * A TRANSPORT only. Authorization and validation happen once, inside
 * `computer.systemInfo` (ownership of the live row and of any placement; a
 * uuid `computerId`). It reads; it never writes a placement.
 *
 *   -> 200 { ok: true, info }
 *   -> 4xx/5xx via `shellErrorResponse` (NOT_FOUND for a computer that is not the caller's)
 */
export async function GET(req: Request) {
    try {
        const headers = new Headers(req.headers);
        headers.set('x-trpc-source', 'shell-http');
        const ctx = await createTRPCContext({ headers });
        if (!ctx.user) return shellUnauthenticated();

        const computerId = new URL(req.url).searchParams.get('computerId') ?? '';
        const info = await appRouter.createCaller(ctx).computer.systemInfo({ computerId });
        return shellJson({ ok: true, info });
    } catch (err) {
        return shellErrorResponse(err, 'GET /api/shell/system');
    }
}
