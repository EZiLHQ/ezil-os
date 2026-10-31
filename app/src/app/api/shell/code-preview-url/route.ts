import { TRPCError } from '@trpc/server';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import { controlTargetFor, type ControlTarget } from '@/server/lib/compute/aws-control-auth';
import { PlacementOwnerError, type PlacementExecutor } from '@/server/lib/compute/placement';
import { requestRepoOpen, withRepositoryFolder } from '@/server/lib/compute/repo-open';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
import type { ProjectRepoGrant } from '@/server/works/project-repo';

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
 *                         open that EZiL Works project repository inside the
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
            return await openProject(ctx as ProjectCtx, caller, computerId, intent, project);
        }

        const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent });

        return shellJson(preview);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/code-preview-url');
    }
}

type ProjectCtx = Awaited<ReturnType<typeof createTRPCContext>> & { user: { id: string } };
type ShellCaller = Awaited<ReturnType<typeof shellCaller>>['caller'];

const refused = (status: number, code: string, message: string) => shellJson({ error: { code, message } }, status);
const identityRefresh = () => refused(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this project.');
const unsupportedProvider = () => refused(409, 'repo_open_unsupported_provider', 'Projects open on this computer type soon. Your files are safe.');

/**
 * Loaded on use, like `cloudflare-guacamole.ts`'s Supabase client: the identity module reads the Supabase server env
 * and both are `server-only`, none of which a Code open without a project should pay for or depend on.
 */
const identityModule = () => import('@/server/auth/retained-identity');
const worksModule = () => import('@/server/works/project-repo');

/** Lowercase canonical UUIDs only: the same rule as `shell/ezil/app-link.js` (`UUID`, `parseProject`). */
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ids, or null. */
function projectIds(value: unknown): { projectId: string; repoId: string } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { projectId, repoId } = value as { projectId?: unknown; repoId?: unknown };
    if (typeof projectId !== 'string' || typeof repoId !== 'string' || !PROJECT_UUID.test(projectId) || !PROJECT_UUID.test(repoId)) return null;
    return { projectId, repoId };
}

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
 * Open an EZiL Works project repository in Code. In this order, and each step only after the one before it held:
 *
 *  1. the ids are lowercase canonical UUIDs (`project_invalid`, 400, before anything is read);
 *  2. the computer is the caller's own: `computer.get` answers NOT_FOUND for anyone else's, BEFORE Works hears of
 *     this request at all;
 *  3. the caller's retained EZiL ID token for THIS session is present and current, else IDENTITY_REFRESH_REQUIRED
 *     (409) and the shell does one `prompt=none` round trip. Local: nothing is started for a person who must refresh;
 *  4. the computer is a Cloudflare one (repo-open is not on AWS yet: `repo_open_unsupported_provider`, 409);
 *  5. Code is minted exactly as without a project. A not-ready answer (`sandbox_starting`, a billing refusal, a move)
 *     goes back unchanged and Works is NOT called, so the shell's wake loop never mints one grant per retry;
 *  6. Works `open`: 401 → IDENTITY_REFRESH_REQUIRED (and the retained token is dropped), 403 → `project_not_authorized`;
 *  7. the Worker clones or fetches into `<root>/projects/<repoId>` with the read grant, and only a folder that ends
 *     exactly there makes it into the URL. Any failure is an error, never Code at the computer's root.
 *
 * The git token goes from Works to the Worker in a request body and nowhere else: not in the answer, not in a log.
 */
async function openProject(ctx: ProjectCtx, caller: ShellCaller, computerId: string, intent: unknown, project: unknown) {
    const ids = projectIds(project);
    if (!ids) return refused(400, 'project_invalid', 'That project link is not valid.');

    await caller.computer.get({ id: computerId });

    const { clearProjectIdentity, retainedIdentity } = await identityModule();
    let identity: RetainedIdentity;
    try { identity = await retainedIdentity(ctx.user.id); } catch { return identityRefresh(); }

    if (isAws(await target(ctx, computerId))) return unsupportedProvider();

    const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent }) as { ok: boolean; codePreviewUrl?: unknown };
    if (!preview.ok || typeof preview.codePreviewUrl !== 'string') return shellJson(preview);

    const { openProjectRepository, WorksProjectRepoError } = await worksModule();
    let grant: ProjectRepoGrant;
    try {
        grant = await openProjectRepository({
            userIdToken: identity.token, projectId: ids.projectId, repositoryId: ids.repoId, identityExpiresAt: identity.expiresAt,
        });
    } catch (err) {
        const code = err instanceof WorksProjectRepoError ? err.code : 'unavailable';
        console.warn('[shell] code-preview-url project refused', { code });
        if (code === 'identity_refused') {
            try { await clearProjectIdentity(); } catch { /* the 409 already asks for a fresh one */ }
            return identityRefresh();
        }
        if (code === 'not_authorized') return refused(403, 'project_not_authorized', "You don't have access to this project's repository.");
        return refused(503, 'project_repo_unavailable', 'EZiL Works could not be reached. Try again in a moment.');
    }

    // Re-read after the mint: a computer that moved to AWS meanwhile is refused, never signed for as Cloudflare.
    const controls = await target(ctx, computerId);
    if (isAws(controls)) return unsupportedProvider();
    const config = resolveCloudflareGuacamoleConfig();
    const opened = await requestRepoOpen(config.workerUrl, process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '', controls,
        { userId: ctx.user.id, computerId }, {
            repositoryId: grant.binding.repositoryId, canonicalURL: grant.binding.canonicalURL, ref: grant.binding.ref,
            git: { token: grant.git.token, expiresAt: grant.git.expiresAt },
        }, { correlationId: newCorrelationId() });
    if (!opened.ok) {
        if (opened.errorCode === 'repo_open_unsupported_provider') return unsupportedProvider();
        return refused(502, 'repo_open_failed', "This project's files could not be opened. Try again.");
    }

    const url = withRepositoryFolder(preview.codePreviewUrl, opened.folder);
    // `url` is §2's field; `codePreviewUrl` is what every shell already reads. Same value.
    return shellJson({ ...preview, codePreviewUrl: url, url });
}
