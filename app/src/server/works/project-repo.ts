import 'server-only';

import { z } from 'zod';

/**
 * EZiL OS → EZiL Works: "may this person read this project's repository, and with what?"
 *
 * `POST {EZIL_WORKS_PROJECT_REPO_ORIGIN}/internal/project-repositories/open` with `{userIdToken, projectId,
 * repositoryId}` (os-map-design §2, Works' "os" policy lane). Works authorizes the person from their own EZiL ID token
 * (a staffed builder, or a reader row such as the project's client) and answers with the repository's binding and a
 * read-only git grant of at most five minutes.
 *
 * - The token travels only in the JSON body: no query string, no Authorization header, no redirect followed.
 * - Every refusal is one of a few fixed codes (`WorksProjectRepoError`); no Works response text, token or grant
 *   is ever put in an error message, because `shellErrorResponse` logs the message of anything it does not know.
 * - The grant (`git.token`, `egg_…`) is for the OS server and the user's own computer only. Callers must never
 *   return it to the browser or log it.
 */
export const WORKS_PROJECT_REPO_ORIGIN_ENV = 'EZIL_WORKS_PROJECT_REPO_ORIGIN';

/** Lowercase canonical UUIDs only: the same rule as `shell/ezil/app-link.js` (`UUID`). */
export const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** EZiL Git's clone URL shape (Works' `ProjectRepoBinding.canonicalURL`), with no `..` or leading dot or hyphen. */
export const CANONICAL_REPOSITORY = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/(?![a-z0-9._-]*\.\.)[a-z0-9][a-z0-9._-]{0,99}\.git$/;

/** The grant may not outlive five minutes (Works' own cap) plus this much clock difference between the two hosts. */
const GRANT_MAX_MS = 300_000;
const CLOCK_SKEW_MS = 30_000;
const RESPONSE_MAX_BYTES = 16_384;
const TIMEOUT_MS = 10_000;

const binding = z.object({
    projectId: z.string().regex(PROJECT_UUID),
    repositoryId: z.string().regex(PROJECT_UUID),
    canonicalURL: z.string().regex(CANONICAL_REPOSITORY),
    ref: z.string().max(255).regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/).refine(ref => !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/')
        && ref.split('/').every(p => !p.startsWith('.') && !p.endsWith('.') && !p.endsWith('.lock'))),
    bindingVersion: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

/** Unknown top-level fields are ignored; the binding and the grant are held to their exact shape. */
const openResponse = z.object({
    binding,
    access: z.object({ role: z.enum(['builder', 'client']) }).strict(),
    git: z.object({
        username: z.literal('ezil'),
        token: z.string().max(8192).regex(/^egg_[A-Za-z0-9._~-]+$/),
        expiresAt: z.string().datetime(),
        scope: z.literal('read'),
    }).strict(),
});

export type ProjectRepoBinding = z.infer<typeof binding>;
export interface ProjectRepoGrant {
    binding: ProjectRepoBinding;
    role: 'builder' | 'client';
    git: { username: 'ezil'; token: string; expiresAt: string };
}

export type WorksProjectRepoErrorCode =
    /** Works 401: the ID token was refused. The retained one must be refreshed (IDENTITY_REFRESH_REQUIRED). */
    | 'identity_refused'
    /** Works 403, or a grant for another project or repository: this person may not read it. */
    | 'not_authorized'
    /** Works unreachable, 5xx, or an answer that is not the contract. */
    | 'unavailable'
    /** `EZIL_WORKS_PROJECT_REPO_ORIGIN` missing or not a bare https origin. */
    | 'not_configured';

export class WorksProjectRepoError extends Error {
    constructor(readonly code: WorksProjectRepoErrorCode) { super(`works_project_repo_${code}`); }
}

/** The configured Works origin: `https://host[:port]` exactly, no path, query, fragment or credentials. */
export function worksProjectRepoOrigin(env: Record<string, string | undefined> = process.env): string {
    const raw = env[WORKS_PROJECT_REPO_ORIGIN_ENV]?.trim();
    if (!raw) throw new WorksProjectRepoError('not_configured');
    let url: URL;
    try { url = new URL(raw); } catch { throw new WorksProjectRepoError('not_configured'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.origin !== raw) throw new WorksProjectRepoError('not_configured');
    return url.origin;
}

export interface OpenProjectRepositoryInput {
    userIdToken: string;
    projectId: string;
    repositoryId: string;
    /** The ID token's own expiry: a grant that claims to outlive it is not believed. */
    identityExpiresAt: number;
}

export interface WorksDeps {
    fetch?: typeof fetch;
    env?: Record<string, string | undefined>;
    now?: () => number;
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

/** Ask Works to open (projectId, repositoryId) for the holder of `userIdToken`. Throws only `WorksProjectRepoError`. */
export async function openProjectRepository(input: OpenProjectRepositoryInput, deps: WorksDeps = {}): Promise<ProjectRepoGrant> {
    const { projectId, repositoryId, userIdToken } = input;
    if (!PROJECT_UUID.test(projectId) || !PROJECT_UUID.test(repositoryId)) throw new WorksProjectRepoError('not_authorized');
    const origin = worksProjectRepoOrigin(deps.env);
    const now = deps.now ?? Date.now;
    let response: Response;
    try {
        response = await (deps.fetch ?? fetch)(new URL('/internal/project-repositories/open', origin), {
            method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(TIMEOUT_MS),
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ userIdToken, projectId, repositoryId }),
        });
    } catch { throw new WorksProjectRepoError('unavailable'); }
    let text: string | undefined;
    try { text = await boundedText(response); } catch { throw new WorksProjectRepoError('unavailable'); }
    if (response.status === 401) throw new WorksProjectRepoError('identity_refused');
    if (response.status === 403) throw new WorksProjectRepoError('not_authorized');
    if (response.status !== 200 || text === undefined) throw new WorksProjectRepoError('unavailable');
    let parsed: z.infer<typeof openResponse>;
    try { parsed = openResponse.parse(JSON.parse(text)); } catch { throw new WorksProjectRepoError('unavailable'); }
    // A grant for anything but what was asked is not this person's grant.
    if (parsed.binding.projectId !== projectId || parsed.binding.repositoryId !== repositoryId) throw new WorksProjectRepoError('not_authorized');
    const expiry = Date.parse(parsed.git.expiresAt);
    const instant = now();
    if (!(expiry > instant) || expiry > instant + GRANT_MAX_MS + CLOCK_SKEW_MS || expiry > input.identityExpiresAt + CLOCK_SKEW_MS) {
        throw new WorksProjectRepoError('unavailable');
    }
    return {
        binding: parsed.binding,
        role: parsed.access.role,
        git: { username: parsed.git.username, token: parsed.git.token, expiresAt: parsed.git.expiresAt },
    };
}
