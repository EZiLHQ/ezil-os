import { TRPCError } from '@trpc/server';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { controlTargetFor, type ControlTarget } from '@/server/lib/compute/aws-control-auth';
import { PlacementOwnerError, type PlacementExecutor } from '@/server/lib/compute/placement';
import {
    REPO_OPEN_MAX_TIMEOUT_MS, REPO_OPEN_MIN_TIMEOUT_MS, REPO_OPEN_TRANSPORT_MARGIN_MS, requestRepoOpen, withRepositoryFolder,
} from '@/server/lib/compute/repo-open';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
import {
    projectGrantOrRefusal, projectIds, projectInvalid, projectRepoConfiguredOrRefusal, retainedIdentityOrRefusal, shellRefusal,
} from '@/server/works/shell-project';

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
 *                         `intent: 'open'` (the r9 shell's Code mint, Phase B
 *                         REVERSE-MOVE-CONTRACT §5.9) is forwarded to the
 *                         procedure: the only Code ask that may start the move.
 *
 *   POST { computerId, intent, project: { projectId, repoId } } — the same, then
 *                         open that Universe project repository inside the
 *                         computer and point Code at it (os-map-design §2). See
 *                         `openProject` below. No `project` (or `null`) is the
 *                         path above, byte for byte.
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
    const startedAt = Date.now();
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

        const { computerId = '', intent, project } = (body ?? {}) as {
            computerId?: string;
            /**
             * Phase B r9 (REVERSE-MOVE-CONTRACT §5.9, opt-in trigger): `'open'` on the r9 shell's Code mint. Forwarded
             * VERBATIM, like the desktop route's `intent`: the procedure types it `z.unknown()` and reads only `=== 'open'`.
             */
            intent?: unknown;
            /** `/app/code?project=&repo=` as `shell/ezil/app-link.js` parsed it. Its `path` is not read (deferred). */
            project?: unknown;
        };

        if (project !== undefined && project !== null) {
            return await openProject(ctx as ProjectCtx, caller, { computerId, intent, project, startedAt, signal: req.signal });
        }

        const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent });

        return shellJson(preview);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/code-preview-url');
    }
}

type ProjectCtx = Awaited<ReturnType<typeof createTRPCContext>> & { user: { id: string } };
type ShellCaller = Awaited<ReturnType<typeof shellCaller>>['caller'];

/**
 * One deadline for a whole project open, from the moment the request arrived: under the shell's 215 s for one Code
 * mint (`shell/ezil/session.js` DESKTOP_BOOT_TIMEOUT_MS), with room for the answer to get back. Universe and the
 * Worker are both given what is left of it, and the Worker bounds the clone inside the computer by it too.
 */
const PROJECT_OPEN_BUDGET_MS = 200_000;
/**
 * Less than this left after the Code mint (a cold start can take most of the budget): Universe is not asked for a
 * grant there is no time to use. `repo_open_timeout` is a failed open to the shell, whose one silent retry then
 * finds the computer awake.
 */
const PROJECT_OPEN_MIN_LEFT_MS = 40_000;

const unsupportedProvider = () => shellRefusal(409, 'repo_open_unsupported_provider', 'Projects open on this computer type soon. Your files are safe.');
const openTimedOut = () => shellRefusal(504, 'repo_open_timeout', "This project's files took too long to open. Try again.");

/** The computer's control target, NOT_FOUND for another owner's placement (as `routeComputer`). */
async function target(ctx: ProjectCtx, computerId: string): Promise<ControlTarget> {
    try {
        return await controlTargetFor(ctx.db as unknown as PlacementExecutor, { userId: ctx.user.id, computerId });
    } catch (err) {
        if (err instanceof PlacementOwnerError) throw new TRPCError({ code: 'NOT_FOUND', message: 'Computer not found' });
        throw err;
    }
}
const isAws = (t: ControlTarget) => t.auth.kind === 'v2' && t.auth.claims.provider === 'aws-ec2';

/**
 * Open a Universe project repository in Code. In this order, and each step only after the one before it held:
 *
 *  1. the ids are lowercase canonical UUIDs (`project_invalid`, 400, before anything is read);
 *  2. the computer is the caller's own: `computer.get` answers NOT_FOUND for anyone else's, BEFORE Universe hears of
 *     this request at all;
 *  3. the computer is a Cloudflare one (repo-open is not on AWS yet: `repo_open_unsupported_provider`, 409), before
 *     anyone is sent through a sign-in for a computer that could not open the project anyway;
 *  4. the caller's retained EZiL ID token for THIS session is present and current, else IDENTITY_REFRESH_REQUIRED
 *     (409) and the shell does one `prompt=none` round trip. Local: nothing is started for a person who must refresh;
 *  5. Universe's origin is configured (`project_repo_unavailable`, 503), so an unconfigured deployment never wakes
 *     the computer for an open that cannot happen;
 *  6. Code is minted exactly as without a project. A not-ready answer (`sandbox_starting`, a billing refusal, a move)
 *     goes back unchanged and Universe is NOT called, so the shell's wake loop never mints one grant per retry. Too
 *     little of the deadline left is `repo_open_timeout` (504), also before Universe;
 *  7. Universe `open`: 401 → IDENTITY_REFRESH_REQUIRED (and the retained token is dropped), 403 → `project_not_authorized`;
 *  8. the Worker clones or fetches into `<root>/projects/<repoId>` with the Git token, within what is left of the
 *     deadline, and only a folder that ends exactly there makes it into the URL. Any failure is an error, never Code
 *     at the computer's root.
 *
 * The Git token and the remote go from Universe to the Worker in a request body and nowhere else: not in the answer,
 * not in a log. The answer names the repository only as `repository.name` (`<namespace>/<name>`), for the window
 * title; the remote itself names the Cloudflare account and stays on the server.
 */
async function openProject(ctx: ProjectCtx, caller: ShellCaller, request: {
    computerId: string; intent: unknown; project: unknown; startedAt: number; signal: AbortSignal;
}) {
    const { computerId, intent, startedAt } = request;
    const ids = projectIds(request.project);
    if (!ids) return projectInvalid();
    const left = () => startedAt + PROJECT_OPEN_BUDGET_MS - Date.now();
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, left()))]);

    await caller.computer.get({ id: computerId });

    if (isAws(await target(ctx, computerId))) return unsupportedProvider();

    const identity = await retainedIdentityOrRefusal(ctx.user.id);
    if (identity instanceof Response) return identity;

    const unconfigured = await projectRepoConfiguredOrRefusal('code-preview-url');
    if (unconfigured) return unconfigured;

    const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent }) as { ok: boolean; codePreviewUrl?: unknown };
    if (!preview.ok || typeof preview.codePreviewUrl !== 'string') return shellJson(preview);
    if (left() < PROJECT_OPEN_MIN_LEFT_MS) {
        console.warn('[shell] code-preview-url project refused', { code: 'deadline' });
        return openTimedOut();
    }

    const grant = await projectGrantOrRefusal(identity, ids, 'code-preview-url', deadline);
    if (grant instanceof Response) return grant;

    // Re-read after the mint: a computer that moved to AWS meanwhile is refused, never signed for as Cloudflare.
    const controls = await target(ctx, computerId);
    if (isAws(controls)) return unsupportedProvider();
    const timeoutMs = Math.min(REPO_OPEN_MAX_TIMEOUT_MS, left() - REPO_OPEN_TRANSPORT_MARGIN_MS);
    if (timeoutMs < REPO_OPEN_MIN_TIMEOUT_MS) {
        console.warn('[shell] code-preview-url project refused', { code: 'deadline' });
        return openTimedOut();
    }
    const config = resolveCloudflareGuacamoleConfig();
    const opened = await requestRepoOpen(config.workerUrl, process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '', controls,
        { userId: ctx.user.id, computerId }, {
            repositoryId: grant.binding.repositoryId, canonicalURL: grant.binding.canonicalURL, ref: grant.binding.ref,
            git: { token: grant.git.token, expiresAt: grant.git.expiresAt }, timeoutMs,
        }, { correlationId: newCorrelationId(), signal: deadline });
    if (!opened.ok) {
        if (opened.errorCode === 'repo_open_unsupported_provider') return unsupportedProvider();
        return shellRefusal(502, 'repo_open_failed', "This project's files could not be opened. Try again.");
    }

    const url = withRepositoryFolder(preview.codePreviewUrl, opened.folder);
    const { repositoryDisplayName } = await import('@/server/works/project-repo');
    const name = repositoryDisplayName(grant.binding.canonicalURL) ?? grant.binding.repositoryId;
    // `url` is §2's field; `codePreviewUrl` is what every shell already reads. Same value.
    return shellJson({ ...preview, codePreviewUrl: url, url, repository: { name } });
}
