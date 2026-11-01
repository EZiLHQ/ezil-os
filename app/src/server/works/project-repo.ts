import 'server-only';

import { z } from 'zod';

/**
 * EZiL OS → Universe 2.0: "may this person open this project's repository, and with what?"
 *
 * `POST {UNIVERSE_PROJECT_REPO_ORIGIN}/internal/project-repositories/open` with `{userIdToken, projectId,
 * repositoryId}` (universe-2.0 `OpenRepositoryController`, `ProjectRepositories::open()`). Universe authorizes the
 * person from their own EZiL ID token (the project's assigned builder gets write, its client read, nobody else
 * anything) and answers with the repository's binding and a Cloudflare Artifacts Git token of at most five minutes.
 *
 * - The token travels only in the JSON body: no query string, no Authorization header, no redirect followed.
 * - Every refusal is one of a few fixed codes (`ProjectRepoError`); no Universe response text, token or grant is
 *   ever put in an error message, because `shellErrorResponse` logs the message of anything it does not know.
 * - The Git token (`git.token`) and the remote (`binding.canonicalURL`, which names the Cloudflare account) are for
 *   the OS server and the user's own computer only. Callers must never return either to the browser or log them;
 *   `repositoryDisplayName` is what the browser may see.
 */
export const PROJECT_REPO_ORIGIN_ENV = 'UNIVERSE_PROJECT_REPO_ORIGIN';

/** Lowercase canonical UUIDs only: the same rule as `shell/ezil/app-link.js` (`UUID`). */
export const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * `<namespace>/<name>.git`: EZiL Git's route rules (`ROUTE_NAMESPACE_PATTERN`, `ROUTE_NAME_PATTERN`), which cover
 * Universe's `p-<uuid>` names, with no `..` in the name. The same text is in `worker/src/repo-open.ts` and
 * `./git-smart-http.ts`.
 */
const REPOSITORY_PATH = String.raw`([a-z0-9][a-z0-9-]{0,63})\/((?![a-z0-9._-]*\.\.)[a-z0-9][a-z0-9._-]{0,99})\.git`;
/** Cloudflare Artifacts' Git remote, exactly as Universe builds it (`ArtifactsClient::remoteFor`). Bearer auth. */
export const ARTIFACTS_REPOSITORY = new RegExp(String.raw`^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/${REPOSITORY_PATH}$`);
/** EZiL Git's gateway. Basic auth. Still accepted; Universe does not hand these out. */
export const EZIL_GIT_REPOSITORY = new RegExp(String.raw`^https:\/\/github\.ezil\.work\/${REPOSITORY_PATH}$`);
/** Either remote. */
export const CANONICAL_REPOSITORY = { test: (url: string) => ARTIFACTS_REPOSITORY.test(url) || EZIL_GIT_REPOSITORY.test(url) };

/** An opaque Git token: visible ASCII only, so it can break neither a header nor a credential line. */
export const GIT_TOKEN = /^[\x21-\x7e]{1,4096}$/;

/** The grant may not outlive five minutes (Universe's own cap) plus this much clock difference between the two hosts. */
const GRANT_MAX_MS = 300_000;
const CLOCK_SKEW_MS = 30_000;
const RESPONSE_MAX_BYTES = 16_384;
const TIMEOUT_MS = 10_000;

const binding = z.object({
    projectId: z.string().regex(PROJECT_UUID),
    repositoryId: z.string().regex(PROJECT_UUID),
    canonicalURL: z.string().refine(url => CANONICAL_REPOSITORY.test(url)),
    ref: z.string().max(255).regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/).refine(ref => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/')
        && ref.split('/').every(p => !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'))),
    bindingVersion: z.string().min(1).max(64),
}).strict();

/** Unknown top-level fields are ignored; the binding and the grant are held to their exact shape. */
const openResponse = z.object({
    binding,
    access: z.object({ role: z.enum(['builder', 'client']) }).strict(),
    git: z.object({
        username: z.literal('ezil'),
        token: z.string().regex(GIT_TOKEN),
        expiresAt: z.string().datetime(),
        scope: z.enum(['read', 'write']),
    }).strict(),
});

export type ProjectRepoBinding = z.infer<typeof binding>;
export interface ProjectRepoGrant {
    binding: ProjectRepoBinding;
    role: 'builder' | 'client';
    git: { username: 'ezil'; token: string; expiresAt: string; scope: 'read' | 'write' };
}

export type ProjectRepoErrorCode =
    /** Universe 401 (`project_repo_invalid_identity`): the ID token was refused. The retained one must be refreshed. */
    | 'identity_refused'
    /** Universe 403 (`project_repo_not_authorized`), or a grant for another project or repository. */
    | 'not_authorized'
    /** Universe 429 (`project_repo_rate_limited`): this account opened too often. */
    | 'rate_limited'
    /** Universe 404: its project repositories flag is off. */
    | 'disabled'
    /** Universe unreachable, 400, 5xx (configuration, identity provider, Artifacts), or an answer that is not the contract. */
    | 'unavailable'
    /** `UNIVERSE_PROJECT_REPO_ORIGIN` missing or not a bare https origin. */
    | 'not_configured';

export class ProjectRepoError extends Error {
    constructor(readonly code: ProjectRepoErrorCode) { super(`project_repo_${code}`); }
}

/** The configured Universe origin: `https://host[:port]` exactly, no path, query, fragment or credentials. */
export function projectRepoOrigin(env: Record<string, string | undefined> = process.env): string {
    const raw = env[PROJECT_REPO_ORIGIN_ENV]?.trim();
    if (!raw) throw new ProjectRepoError('not_configured');
    let url: URL;
    try { url = new URL(raw); } catch { throw new ProjectRepoError('not_configured'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== raw) throw new ProjectRepoError('not_configured');
    return url.origin;
}

/**
 * What the browser may call the repository (the Code window's title): `<namespace>/<name>` of either remote. Never
 * the URL itself, which for Artifacts names the Cloudflare account.
 */
export function repositoryDisplayName(canonicalURL: string): string | null {
    const match = ARTIFACTS_REPOSITORY.exec(canonicalURL) ?? EZIL_GIT_REPOSITORY.exec(canonicalURL);
    return match ? `${match[1]}/${match[2]}` : null;
}

export interface OpenProjectRepositoryInput {
    userIdToken: string;
    projectId: string;
    repositoryId: string;
    /** The ID token's own expiry: a grant that claims to outlive it is not believed. */
    identityExpiresAt: number;
}

export interface ProjectRepoDeps {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    now?: () => number;
    /** The caller's own deadline; the request also gives up after 10 s on its own. */
    signal?: AbortSignal;
}

async function boundedText(response: Response): Promise<string | undefined> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > RESPONSE_MAX_BYTES) return undefined;
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).toString('utf8');
}

/** Universe's error statuses (`OpenRepositoryController`) to this client's codes. Anything else is `unavailable`. */
const REFUSALS: Readonly<Record<number, ProjectRepoErrorCode>> = { 401: 'identity_refused', 403: 'not_authorized', 404: 'disabled', 429: 'rate_limited' };

/** Ask Universe to open (projectId, repositoryId) for the holder of `userIdToken`. Throws only `ProjectRepoError`. */
export async function openProjectRepository(input: OpenProjectRepositoryInput, deps: ProjectRepoDeps = {}): Promise<ProjectRepoGrant> {
    const { projectId, repositoryId, userIdToken } = input;
    if (!PROJECT_UUID.test(projectId) || !PROJECT_UUID.test(repositoryId)) throw new ProjectRepoError('not_authorized');
    const origin = projectRepoOrigin(deps.env);
    const now = deps.now ?? Date.now;
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    let response: Response;
    try {
        response = await (deps.fetch ?? fetch)(new URL('/internal/project-repositories/open', origin), {
            method: 'POST', redirect: 'error', cache: 'no-store', signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userIdToken, projectId, repositoryId }),
        });
    } catch { throw new ProjectRepoError('unavailable'); }
    let text: string | undefined;
    try { text = await boundedText(response); } catch { throw new ProjectRepoError('unavailable'); }
    const refused = REFUSALS[response.status];
    if (refused) throw new ProjectRepoError(refused);
    if (response.status !== 200 || text === undefined) throw new ProjectRepoError('unavailable');
    let parsed: z.infer<typeof openResponse>;
    try { parsed = openResponse.parse(JSON.parse(text)); } catch { throw new ProjectRepoError('unavailable'); }
    // A grant for anything but what was asked is not this person's grant.
    if (parsed.binding.projectId !== projectId || parsed.binding.repositoryId !== repositoryId) throw new ProjectRepoError('not_authorized');
    const expiry = Date.parse(parsed.git.expiresAt);
    const instant = now();
    if (!(expiry > instant) || expiry > instant + GRANT_MAX_MS + CLOCK_SKEW_MS || expiry > input.identityExpiresAt + CLOCK_SKEW_MS) {
        throw new ProjectRepoError('unavailable');
    }
    return {
        binding: parsed.binding,
        role: parsed.access.role,
        git: { username: parsed.git.username, token: parsed.git.token, expiresAt: parsed.git.expiresAt, scope: parsed.git.scope },
    };
}
