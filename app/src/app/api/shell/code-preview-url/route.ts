import { launchGrant } from '@/server/project-repositories/session';
import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/code-preview-url` — mint a fresh code-server window URL for one
 * of the caller's computers.
 *
 * MODIFIED BY EZIL 2026-08-01 (T7): this is `../preview-url/route.ts`,
 * applied to the code-server bridge instead of the app-preview one — same
 * transport, same reasoning, same extended `maxDuration` for the same
 * cold-boot budget. See that file's doc comment for the full account; only
 * what differs is called out below.
 *
 * 🔴 `maxDuration` is NOT inherited from any platform default
 * (docs/PLATFORM-NOTES.md §13). `cloudflareGuacamole.codePreviewUrl` calls the
 * exact SAME `/sandbox/preview` Worker route `previewUrl`/`appPreviewUrl` do,
 * which can cold-boot the container (~22-24s measured,
 * `SANDBOX_COLD_START_TIMEOUT_MS` = 210s client budget). 300s matches every
 * other route on this cold-boot path for the same reason.
 *
 * Like `../preview-url/route.ts` this is a TRANSPORT only. Ownership is
 * checked exactly once, inside `cloudflareGuacamole.codePreviewUrl`, which
 * derives the sandbox id from the AUTHENTICATED user id plus an
 * ownership-verified computer id. The Worker URL and HMAC secret never leave
 * the server; the browser receives only the opaque, short-lived code-preview
 * URL.
 *
 *   POST { computerId } — mint a fresh code-server preview URL + bootstrap token.
 *
 * Called PER WINDOW-OPEN — never cached, never folded into
 * `/api/shell/session`'s boot payload, for the identical 5-minute-token
 * reason `../preview-url/route.ts` documents.
 *
 * Input is deliberately NOT re-validated here: forwarded as given, the
 * procedure's own zod schema rejects anything malformed as a 400.
 */
export const maxDuration = 300;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx, { signal: req.signal }) };
}

/**
 * Mint a fresh code-server window URL for the given computer. This is the
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

        const { computerId = '', repo, projectLaunch } = (body ?? {}) as { computerId?: string; repo?: string; projectLaunch?: boolean };

        // Ownership is verified before redemption; never redeem for an arbitrary computer.
        await caller.computer.get({ id: computerId });
        if (projectLaunch !== undefined && projectLaunch !== true) return shellJson({ error: { code: 'BAD_REQUEST', message: 'Invalid repository launch.' } }, 400);
        const projectGrant = projectLaunch ? await launchGrant(ctx.user.id, computerId) : undefined;
        if (projectLaunch && !projectGrant) return shellJson({ error: { code: 'project_repo_not_authorized', message: 'Repository launch expired. Open the project again.' } }, 403);
        if (projectGrant && repo !== undefined && projectGrant.binding.canonicalURL !== repo) {
            return shellJson({ error: { code: 'project_repo_not_authorized' } }, 403);
        }
        const authorized = appRouter.createCaller({ ...ctx, projectGrant }, { signal: req.signal });
        const preview = await authorized.cloudflareGuacamole.codePreviewUrl({ computerId, repo: projectGrant?.binding.canonicalURL ?? repo });

        return shellJson(preview);
    } catch (err) {
        if (err instanceof Error && /^project_repo_/.test(err.message)) return shellJson({ error: { code: err.message, message: 'Repository launch could not be authorized. Open the project again.' } }, ['project_repo_configuration_required', 'project_repo_identity_unavailable'].includes(err.message) ? 503 : 403);
        return shellErrorResponse(err, 'POST /api/shell/code-preview-url');
    }
}
