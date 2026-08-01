import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/preview-url` — mint a fresh app-preview window URL for one of
 * the caller's computers.
 *
 * 🔴 `maxDuration` is NOT inherited from any platform default
 * (docs/PLATFORM-NOTES.md §13) — the same trap `../desktop/route.ts`
 * documents. `cloudflareGuacamole.appPreviewUrl` calls the exact SAME
 * `/sandbox/preview` Worker route `previewUrl` does, which can cold-boot the
 * container (~22-24s measured, `SANDBOX_COLD_START_TIMEOUT_MS` = 210s client
 * budget). Left on the platform default (10-15s) this route would be killed
 * before a cold-booting desktop ever answers — on exactly the first
 * app-preview window a fresh session opens. 300s matches
 * `../desktop/route.ts` and `src/app/api/trpc/[trpc]/route.ts` for the same
 * reason.
 *
 * Like `../desktop/route.ts` and `../session/route.ts` this is a TRANSPORT
 * only. Ownership is checked exactly once, inside
 * `cloudflareGuacamole.appPreviewUrl`, which derives the sandbox id from the
 * AUTHENTICATED user id plus an ownership-verified computer id. The Worker
 * URL and HMAC secret never leave the server; the browser receives only the
 * opaque, short-lived app-preview URL.
 *
 *   POST { computerId } — mint a fresh preview URL + bootstrap token.
 *
 * Called PER WINDOW-OPEN, and refetched roughly every 50s by the client
 * while a window stays open — safely inside the minted token's 5-minute TTL
 * (`APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS`). Never folded into
 * `/api/shell/session`'s boot payload: that payload is built once, well
 * before the moment a window is actually opened, and a 5-minute token minted
 * that early would already be stale by the time it is used — see
 * `cloudflareGuacamole.appPreviewUrl`'s doc comment.
 *
 * Input is deliberately NOT re-validated here: it is forwarded as given and
 * the procedure's own zod schema rejects anything malformed, surfacing as a
 * 400. One validation implementation, same as one authorization
 * implementation.
 */
export const maxDuration = 300;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

/**
 * Mint a fresh app-preview window URL for the given computer. This is the
 * long one when the desktop is cold — see `maxDuration` above.
 */
export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body — an unauthenticated caller
        // should learn exactly one thing (not signed in), not whether their
        // JSON happened to be well-formed.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '' } = (body ?? {}) as { computerId?: string };

        const preview = await caller.cloudflareGuacamole.appPreviewUrl({ computerId });

        return shellJson(preview);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/preview-url');
    }
}
