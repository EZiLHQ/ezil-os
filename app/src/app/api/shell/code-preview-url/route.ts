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

        const { computerId = '', intent, project, repository, codeFolder } = (body ?? {}) as {
            computerId?: string;
            /**
             * Phase B r9 (REVERSE-MOVE-CONTRACT §5.9, opt-in trigger): `'open'` on the r9 shell's Code mint. Forwarded
             * VERBATIM, like the desktop route's `intent`: the procedure types it `z.unknown()` and reads only `=== 'open'`.
             */
            intent?: unknown;
            /** `/app/code?project=&repo=` as `shell/ezil/app-link.js` parsed it. Its `path` is not read (deferred). */
            project?: unknown;
            /** `/app/code?repo=<https URL>` (founder 547ed35a): `{url}`, navigation intent only; see `openRepositoryUrl`. */
            repository?: unknown;
            /**
             * Per-tab folder continuity, own files only: `{v:1, path}` the tab's editor last reported. Forwarded
             * VERBATIM to the procedure (which checks it, `z.unknown()`: never a 400); never with a project, whose
             * root the server fixes (r32).
             */
            codeFolder?: unknown;
        };

        const hasProject = project !== undefined && project !== null;
        const hasRepository = repository !== undefined && repository !== null;
        // One target per open: a project and a repository address together is a malformed link, never a guess.
        if (hasProject && hasRepository) return shellRefusal(400, 'repo_url_invalid', "This link names two repositories. Open one at a time.");
        if (hasProject) {
            return await openProject(ctx as ProjectCtx, caller, { computerId, intent, project, startedAt, signal: req.signal });
        }
        if (hasRepository) {
            return await openRepositoryUrl(ctx as ProjectCtx, caller, { computerId, intent, repository, startedAt, signal: req.signal });
        }

        const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent, ...(codeFolder !== undefined ? { codeFolder } : {}) });

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

    // 1.1.0: the label of the computer being opened (its owner was checked above by `computer.get`).
    const grant = await projectGrantOrRefusal(identity, ids, 'code-preview-url', deadline, computerId);
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
            git: { token: grant.git.token, expiresAt: grant.git.expiresAt, scope: grant.git.scope }, timeoutMs,
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

const repoUrlInvalid = () => shellRefusal(400, 'repo_url_invalid', "This isn't a repository address EZiL OS can open.");

/**
 * Open a repository from its address (`/app/code?repo=<URL-encoded https URL>`, founder 547ed35a), on the caller's
 * own selected computer, with its own provider and plan rules. In this order, each step only after the one before:
 *
 *  1. the address is one canonical public github.com repository (`parseRepositoryUrl`), else `repo_url_invalid`
 *     (400) or, for EZiL Git's own hosts, `repo_url_unsupported` (409), before anything is read;
 *  2. the computer is the caller's own (`computer.get`: NOT_FOUND otherwise);
 *  3. it is a Cloudflare computer (AWS: `repo_open_unsupported_provider`, 409; os-builder-project-open-v1 §8);
 *  4. the repository exists publicly and has a default branch: one anonymous read (`resolvePublicGitHub`); a missing
 *     or private one is "This repository doesn't exist." (404), before the computer is woken for it;
 *  5. Code is minted exactly as without a repository (the same wake loop, Free policy and billing gates);
 *  6. the Worker fetches it anonymously into `<root>/projects/<id>` (`repositoryIdFor`: the same folder on every
 *     reopen, which then fetches only and keeps uncommitted work) and only that folder goes into the URL.
 *
 * No credential is sent anywhere: EZiL ID grants nothing on GitHub, and a private repository is not opened this way.
 */
async function openRepositoryUrl(ctx: ProjectCtx, caller: ShellCaller, request: {
    computerId: string; intent: unknown; repository: unknown; startedAt: number; signal: AbortSignal;
}) {
    const { computerId, intent, startedAt } = request;
    const { parseRepositoryUrl, repositoryIdFor, resolvePublicGitHub } = await import('@/server/works/repo-url');
    const raw = typeof request.repository === 'object' && request.repository !== null && !Array.isArray(request.repository)
        && Object.keys(request.repository).length === 1 ? (request.repository as { url?: unknown }).url : undefined;
    const parsed = parseRepositoryUrl(raw);
    if (!parsed.ok) {
        return parsed.reason === 'unsupported_host'
            ? shellRefusal(409, 'repo_url_unsupported', 'Open this EZiL Git repository from its project in Universe for now.')
            : repoUrlInvalid();
    }
    // The Worker fetches a public github.com repository only on os-staging (`repoOpenRemotesFor`); any other
    // deployment would wake the computer for an open it then refuses. Refused first, with nothing read or woken.
    const { stagingGitQaAccepted } = await import('@/server/works/project-repo');
    if (!stagingGitQaAccepted()) {
        return shellRefusal(409, 'repo_url_not_enabled', "Opening a repository from its address isn't available here yet.");
    }
    const left = () => startedAt + PROJECT_OPEN_BUDGET_MS - Date.now();
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, left()))]);

    await caller.computer.get({ id: computerId });
    if (isAws(await target(ctx, computerId))) return unsupportedProvider();

    const resolved = await resolvePublicGitHub(parsed.canonicalURL, { signal: deadline });
    if (!resolved.ok) {
        console.warn('[shell] code-preview-url repository refused', { code: resolved.reason });
        if (resolved.reason === 'not_found') return shellRefusal(404, 'repo_not_found', "This repository doesn't exist.");
        if (resolved.reason === 'moved') return shellRefusal(409, 'repo_url_moved', 'This repository has moved. Open it from its new address.');
        if (resolved.reason === 'empty') return shellRefusal(409, 'repo_url_empty', 'This repository has no files yet.');
        return shellRefusal(503, 'repo_url_unavailable', "We couldn't reach this repository. Try again.");
    }

    const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent }) as { ok: boolean; codePreviewUrl?: unknown };
    if (!preview.ok || typeof preview.codePreviewUrl !== 'string') return shellJson(preview);
    // Re-read after the mint: a computer that moved to AWS meanwhile is refused, never signed for as Cloudflare.
    const controls = await target(ctx, computerId);
    if (isAws(controls)) return unsupportedProvider();
    const timeoutMs = Math.min(REPO_OPEN_MAX_TIMEOUT_MS, left() - REPO_OPEN_TRANSPORT_MARGIN_MS);
    if (timeoutMs < REPO_OPEN_MIN_TIMEOUT_MS) {
        console.warn('[shell] code-preview-url repository refused', { code: 'deadline' });
        return openTimedOut();
    }
    const repositoryId = repositoryIdFor(parsed.canonicalURL);
    const config = resolveCloudflareGuacamoleConfig();
    const opened = await requestRepoOpen(config.workerUrl, process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '', controls,
        { userId: ctx.user.id, computerId }, { repositoryId, canonicalURL: parsed.canonicalURL, ref: resolved.ref, git: null, timeoutMs },
        { correlationId: newCorrelationId(), signal: deadline });
    if (!opened.ok) {
        if (opened.errorCode === 'repo_open_unsupported_provider') return unsupportedProvider();
        return shellRefusal(502, 'repo_open_failed', "This repository's files could not be opened. Try again.");
    }
    const url = withRepositoryFolder(preview.codePreviewUrl, opened.folder);
    return shellJson({ ...preview, codePreviewUrl: url, url, repository: { name: parsed.displayName, id: repositoryId } });
}

