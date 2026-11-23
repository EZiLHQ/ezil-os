import { recordingAction } from '@/server/assignment-video/broker';
import { osOrigin, universeOrigin, uuid } from '@/server/assignment-video/contract';
import { enrolledAttempt, makeChallenge, matchesEnrollment, readOpen, repoOpenSecret, sealOpen, workspaceIdentity } from '@/server/assignment-video/repo-open';
import { z } from 'zod';
import { expectedRepositoryURL } from '@/server/git/assignment-enrollment';
import { isCrossOriginWrite } from '@/utils/request-origin';
import { TRPCError } from '@trpc/server';
import { repoOpenFailureResponse } from '@/server/feedback/repo-open-failure';

import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { newCorrelationId, resolveCloudflareGuacamoleConfig } from '@/server/lib/cloudflare-guacamole-provider';
import type { AutomaticImageUpdateWait } from '@/server/lib/compute/aws-auto-update-progress';
import { controlTargetFor, type ControlTarget } from '@/server/lib/compute/aws-control-auth';
import { ImageJobConflictError, PlacementOwnerError, type PlacementDb, type PlacementExecutor } from '@/server/lib/compute/placement';
import {
    matchesAck, REPO_OPEN_MAX_TIMEOUT_MS, REPO_OPEN_MIN_TIMEOUT_MS, REPO_OPEN_TRANSPORT_MARGIN_MS, requestRepoOpen, withRepositoryFolder,
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
 * The Code mint checks ownership inside `cloudflareGuacamole.codePreviewUrl`, which
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
const assignmentPhase = z.discriminatedUnion('phase', [
    z.object({phase:z.literal('prepare'),attemptId:uuid}).strict(),
    z.object({phase:z.literal('open'),attemptId:uuid,captureSessionId:uuid,repoOpenProof:z.string().regex(/^[A-Za-z0-9_-]{48,1700}$/)}).strict(),
]);
const assignmentLocked = () => shellRefusal(409,'assignment_recording_required','Share the assignment tab and wait for the first recorded frame to open Code.');


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

        const { computerId = '', intent, project, repository, codeFolder, assignment } = (body ?? {}) as {
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
            assignment?: unknown;
        };

        const hasProject = project !== undefined && project !== null;
        const hasRepository = repository !== undefined && repository !== null;
        // One target per open: a project and a repository address together is a malformed link, never a guess.
        if (hasProject && hasRepository) return shellRefusal(400, 'repo_url_invalid', "This link names two repositories. Open one at a time.");
        if (assignment !== undefined && !hasRepository) return assignmentLocked();
        let response: Response;
        try {
            if (hasProject) {
                response = await openProject(ctx as ProjectCtx, caller, { computerId, intent, project, startedAt, signal: req.signal });
            } else if (hasRepository) {
                response = await openRepositoryUrl(ctx as ProjectCtx, caller, { computerId, intent, repository, startedAt, signal: req.signal, assignment,
                    allowAssignmentPreload: !ctx.delegation && intent === 'open' && req.headers.get('origin') === osOrigin
                        && req.headers.get('sec-fetch-site') === 'same-origin' && !isCrossOriginWrite(req) });
            } else {
                const preview = await caller.cloudflareGuacamole.codePreviewUrl({
                    computerId, intent, ...(codeFolder !== undefined ? { codeFolder } : {}),
                });
                response = shellJson(preview);
            }
        } catch (error) {
            // tRPC wraps placement errors from its procedures. Control lookups can throw the original.
            const cause = error instanceof TRPCError ? error.cause : error;
            if (intent === 'open' && cause instanceof ImageJobConflictError) {
                const update = await advanceUpdate(ctx as ProjectCtx, computerId, false);
                if (update) return updatePending(update);
            }
            throw error;
        }
        if (intent === 'open' && process.env.EZIL_AWS_AUTO_REBASE === '1') {
            const result = await response.clone().json().catch(() => null);
            if (result?.ok === false && result.errorCode === 'computer_rebase_required') {
                const update = await advanceUpdate(ctx as ProjectCtx, computerId, true);
                if (update) return updatePending(update);
            }
        }
        return response;
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/code-preview-url');
    }
}

type ProjectCtx = Awaited<ReturnType<typeof createTRPCContext>> & { user: { id: string } };
type ShellCaller = Awaited<ReturnType<typeof shellCaller>>['caller'];

function updatePending({ milestone }: AutomaticImageUpdateWait) {
    return shellJson({ ok: false, error: 'computer_updating', errorCode: 'sandbox_starting',
        retryable: true, provider: 'cloudflare-guacamole', computeProvider: 'aws-ec2', computeUpdating: true, computeLaunching: true,
        ...(milestone ? { computeUpdatePercent: milestone.percent, computeUpdateStage: milestone.stage } : {}) });
}

async function advanceUpdate(ctx: ProjectCtx, computerId: string, allowStart: boolean): Promise<AutomaticImageUpdateWait | null> {
    if (process.env.EZIL_AWS_AUTO_REBASE !== '1') return null;
    try {
        const { advanceStagingImageUpdate } = await import('@/server/lib/compute/aws-auto-update');
        return await advanceStagingImageUpdate(ctx.db as unknown as PlacementDb, computerId, ctx.user.id, allowStart);
    } catch {
        // Preserve the existing refusal when a request cannot safely advance an update.
        return null;
    }
}

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
        return repoOpenFailureResponse(ctx.db, ctx.user.id, computerId, opened, "This project's files could not be opened. Try again.");
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
 *  1. the address is one canonical public github.com or standalone github.ezil.work repository;
 *  2. the computer is the caller's own (`computer.get`: NOT_FOUND otherwise);
 *  3. it is a Cloudflare computer (AWS: `repo_open_unsupported_provider`, 409; os-builder-project-open-v1 §8);
 *  4. public GitHub is resolved anonymously; standalone EZiL Git is granted under this session's retained OAuth
 *     identity before Code wakes, and the gateway's v2 packet binds its actual provider repository ID and ref;
 *  5. Code is minted exactly as without a repository (the same wake loop, Free policy and billing gates);
 *  6. the Worker fetches it anonymously into `<root>/projects/<id>` (`repositoryIdFor`: the same folder on every
 *     reopen, which then fetches only and keeps uncommitted work) and only that folder goes into the URL.
 *
 * A standalone credential is sent only in the signed Worker body, then to the bundled CLI on private fd 3.
 */
async function openRepositoryUrl(ctx: ProjectCtx, caller: ShellCaller, request: {
    computerId: string; intent: unknown; repository: unknown; startedAt: number; signal: AbortSignal; allowAssignmentPreload: boolean; assignment?:unknown;
}) {
    const { computerId, intent, startedAt } = request;
    const { parseRepositoryUrl, repositoryIdFor, resolvePublicGitHub } = await import('@/server/git/repo-url');
    const raw = typeof request.repository === 'object' && request.repository !== null && !Array.isArray(request.repository)
        && Object.keys(request.repository).length === 1 ? (request.repository as { url?: unknown }).url : undefined;
    const parsed = parseRepositoryUrl(raw);
    if (!parsed.ok) {
        return parsed.reason === 'unsupported_host'
            ? shellRefusal(409, 'repo_url_unsupported', 'This Git host is not available for direct URL opens.')
            : repoUrlInvalid();
    }
    // The Worker fetches a public github.com repository only on os-staging (`repoOpenRemotesFor`); any other
    // deployment would wake the computer for an open it then refuses. Refused first, with nothing read or woken.
    const { standaloneGitUrlEnabled, awsStandaloneGitEnabled } = await import('@/server/git/staging');
    if (!standaloneGitUrlEnabled()) {
        return shellRefusal(409, 'repo_url_not_enabled', "Opening a repository from its address isn't available here yet.");
    }
    const left = () => startedAt + PROJECT_OPEN_BUDGET_MS - Date.now();
    const deadline = AbortSignal.any([request.signal, AbortSignal.timeout(Math.max(1, left()))]);

    await caller.computer.get({ id: computerId });
    if (isAws(await target(ctx, computerId)) && (parsed.host !== 'github.ezil.work' || !awsStandaloneGitEnabled())) return unsupportedProvider();

    // Only the parsed parts reach the resolver; it rebuilds the address on its literal github.com origin.
    const resolved = parsed.host === 'github.com' ? await resolvePublicGitHub({ host: parsed.host, owner: parsed.owner, name: parsed.name }, { signal: deadline }) : null;
    if (resolved && !resolved.ok) {
        console.warn('[shell] code-preview-url repository refused', { code: resolved.reason });
        if (resolved.reason === 'not_found') return shellRefusal(404, 'repo_not_found', "This repository doesn't exist.");
        if (resolved.reason === 'moved') return shellRefusal(409, 'repo_url_moved', 'This repository has moved. Open it from its new address.');
        if (resolved.reason === 'empty') return shellRefusal(409, 'repo_url_empty', 'This repository has no files yet.');
        return shellRefusal(503, 'repo_url_unavailable', "We couldn't reach this repository. Try again.");
    }

    const loadIdentity = async () => {
        const { retainedIdentity } = await import('@/server/auth/retained-identity');
        try { return await retainedIdentity(ctx.user.id); } catch { return null; }
    };
    const identity = parsed.host === 'github.ezil.work' ? await loadIdentity() : null;
    if (parsed.host === 'github.ezil.work' && !identity) {
        return shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this repository.');
    }
    const sameSession = async () => {
        if (!identity) return true;
        const current = await loadIdentity();
        return Boolean(current && current.sessionId === identity.sessionId
            && current.issuer === identity.issuer && current.subject === identity.subject);
    };
    const loadGrant = async () => {
        const { grantForStandaloneGit, GitAccessError } = await import('@/server/git/access');
        try { return await grantForStandaloneGit(identity!, parsed.canonicalURL, { signal: deadline }); }
        catch (error) {
            const code = error instanceof GitAccessError ? error.code : 'unavailable';
            console.warn('[shell] code-preview-url standalone Git refused', { code });
            if (code === 'identity_refused') {
                const { clearProjectIdentity } = await import('@/server/auth/retained-identity');
                try { await clearProjectIdentity(); } catch { /* the next request asks for a fresh identity */ }
                return shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this repository.');
            }
            if (code === 'not_found') return shellRefusal(404, 'repo_not_found', "This repository doesn't exist or you cannot access it.");
            return shellRefusal(503, 'repo_url_unavailable', "We couldn't reach this repository. Try again.");
        }
    };
    let privatePacket = parsed.host === 'github.ezil.work' ? await loadGrant() : null;
    if (privatePacket instanceof Response) return privatePacket;
    if (!(await sameSession())) return shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this repository.');

    const canonicalHint = parsed.canonicalURL.match(/-a-([0-9a-f-]{36})\.git$/)?.[1];
    const staging = ['https://ai-staging.ezil.work','https://ai-staging.ezil.work/'].includes(process.env.BILLING_FUNDING_URL ?? '');
    const reserved = staging && identity && canonicalHint && uuid.safeParse(canonicalHint).success
        && parsed.canonicalURL === expectedRepositoryURL(identity.subject,'a-' + canonicalHint);
    const phase = assignmentPhase.safeParse(request.assignment);
    if ((request.assignment !== undefined && !reserved) || (reserved && (!request.allowAssignmentPreload || !phase.success || phase.data.attemptId !== canonicalHint
        || !privatePacket || privatePacket.git.scope !== 'write' || !repoOpenSecret()))) return assignmentLocked();
    const preview = await caller.cloudflareGuacamole.codePreviewUrl({ computerId, intent }) as { ok: boolean; codePreviewUrl?: unknown; computeProvider?: unknown; sandboxId?: unknown; generation?: unknown; leaseEpoch?: unknown };
    if (!preview.ok || typeof preview.codePreviewUrl !== 'string') return reserved ? assignmentLocked() : shellJson(preview);
    if (left() < REPO_OPEN_MIN_TIMEOUT_MS + REPO_OPEN_TRANSPORT_MARGIN_MS) return openTimedOut();
    if (!(await sameSession())) return shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this repository.');
    // A cold Code mint can consume a short credential. Refresh before the Worker call, never after an expired send.
    if (privatePacket && Date.parse(privatePacket.git.expiresAt) - Date.now()
        < Math.min(REPO_OPEN_MAX_TIMEOUT_MS, left() - REPO_OPEN_TRANSPORT_MARGIN_MS) + 30_000) {
        const refreshed = await loadGrant();
        if (refreshed instanceof Response) return refreshed;
        if (refreshed.repository.id !== privatePacket.repository.id || refreshed.repository.ref !== privatePacket.repository.ref)
            return shellRefusal(409, 'repo_url_changed', 'This repository changed while opening. Try again.');
        privatePacket = refreshed;
        if (!(await sameSession())) return shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this repository.');
    }
    // Re-read after the mint: a computer that moved to AWS meanwhile is refused, never signed for as Cloudflare.
    const controls = await target(ctx, computerId);
    if (isAws(controls) && (parsed.host !== 'github.ezil.work' || !awsStandaloneGitEnabled())) return unsupportedProvider();
    if (isAws(controls)) {
        const c = controls.auth.kind === 'v2' ? controls.auth.claims : null;
        if (!c || preview.computeProvider !== 'aws-ec2' || preview.sandboxId !== c.sandboxId
            || preview.generation !== c.generation || preview.leaseEpoch !== c.leaseEpoch)
            return shellRefusal(409, 'repo_open_computer_changed', 'This computer changed while opening. Try again.');
    } else if (preview.computeProvider === 'aws-ec2') {
        return shellRefusal(409, 'repo_open_computer_changed', 'This computer changed while opening. Try again.');
    }
    // Only a signed worker acknowledgement for this enrolled repository may authorize the assignment workspace.
    const signer = request.allowAssignmentPreload && !isAws(controls) && process.env.UNIVERSE_PROJECT_REPO_ORIGIN === universeOrigin
        && ['https://ai-staging.ezil.work','https://ai-staging.ezil.work/'].includes(process.env.BILLING_FUNDING_URL ?? '')
        ? repoOpenSecret() : undefined;
    const attemptId = signer && identity && privatePacket ? enrolledAttempt(identity, privatePacket, Date.now()) : undefined;
    const enrolled = attemptId && identity && privatePacket
        ? await recordingAction(identity,{action:'preflight',attemptId},{signal:deadline}).catch(() => null) : null;
    const challenge = enrolled && privatePacket && attemptId && matchesEnrollment(enrolled, privatePacket, attemptId, Date.now())
        ? makeChallenge(attemptId, privatePacket.repository.canonicalURL) : undefined;
    const timeoutMs = Math.min(REPO_OPEN_MAX_TIMEOUT_MS, left() - REPO_OPEN_TRANSPORT_MARGIN_MS,
        privatePacket ? Date.parse(privatePacket.git.expiresAt) - Date.now() - 15_000 : REPO_OPEN_MAX_TIMEOUT_MS);
    if (timeoutMs < REPO_OPEN_MIN_TIMEOUT_MS) {
        console.warn('[shell] code-preview-url repository refused', { code: 'deadline' });
        return openTimedOut();
    }
    const repositoryId = repositoryIdFor(parsed.canonicalURL);
    const config = resolveCloudflareGuacamoleConfig();
    const opened = await requestRepoOpen(config.workerUrl, process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '', controls,
        { userId: ctx.user.id, computerId }, { repositoryId, canonicalURL: parsed.canonicalURL,
            ref: privatePacket?.repository.ref ?? resolved!.ref,
            ...(challenge ? {assignmentPreload:challenge} : {}),
            git: privatePacket ? { token: privatePacket.git.token, expiresAt: privatePacket.git.expiresAt, scope: privatePacket.git.scope } : null,
            ...(privatePacket ? { privatePacket, ...(identity?.gitAuthor ? { gitAuthor: identity.gitAuthor } : {}) } : {}), timeoutMs },
        { correlationId: newCorrelationId(), signal: deadline, awsStandaloneEnabled: awsStandaloneGitEnabled(),
            revalidateTarget: () => target(ctx, computerId) });
    if (!opened.ok) {
        if (opened.errorCode === 'repo_open_unsupported_provider') return unsupportedProvider();
        return repoOpenFailureResponse(ctx.db, ctx.user.id, computerId, opened, "This repository's files could not be opened. Try again.");
    }
    const url = withRepositoryFolder(preview.codePreviewUrl, opened.folder);
    const now = Date.now();
    if (!reserved) return shellJson({ ...preview, codePreviewUrl:url, url, repository:{name:parsed.displayName,id:repositoryId} });
    if (!phase.success || !signer || !enrolled || !identity || !privatePacket || !attemptId || !challenge || !opened.checkoutFolder
        || !matchesAck(challenge, opened.assignmentPreload) || !matchesEnrollment(enrolled, privatePacket, attemptId, now) || !(await sameSession()))
        return shellRefusal(409,'assignment_checkout_unverified','The protected assignment checkout could not be verified. Retry opening the assignment.');
    const repository = {name:parsed.displayName,id:repositoryId,checkoutFolder:opened.checkoutFolder,workspaceFolder:opened.folder};
    const operation = phase.data;
    if (operation.phase === 'prepare') {
        const assignmentOpen = sealOpen(identity,enrolled,computerId,controls.sandboxName,challenge.eventId,now,signer);
        return shellJson({ok:true,repository,assignmentOpen});
    }
    const proof = (() => { try { return readOpen(operation.repoOpenProof,identity,attemptId,now,signer); } catch { return null; } })();
    if (!proof || proof.workspaceId !== workspaceIdentity(identity.userId,computerId,controls.sandboxName) || proof.repositoryUrl !== parsed.canonicalURL
        || proof.providerId !== privatePacket.repository.id || proof.manifestSha256 !== enrolled.manifestSha256) return assignmentLocked();
    const state = await recordingAction(identity,{action:'status',attemptId,captureSessionId:operation.captureSessionId},{signal:deadline}).catch(()=>null);
    if (!state || state.captureSessionId !== operation.captureSessionId || state.repositoryOpenReceiptId !== proof.eventId || state.phaseReady !== true || state.workspaceUnlocked !== true
        || state.status !== 'recording' || state.revoked !== false || state.stopRequestedAt !== null || typeof state.firstFrameAt !== 'string'
        || typeof state.startedAt !== 'string' || typeof state.deadlineAt !== 'string' || Date.parse(state.deadlineAt) <= Date.now() || !(await sameSession())) return assignmentLocked();
    return shellJson({...preview,codePreviewUrl:url,url,repository});

}

