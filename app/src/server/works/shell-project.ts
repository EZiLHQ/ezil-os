/**
 * The shell routes' shared steps for a Universe project (`/api/shell/code-preview-url` with `project`, and
 * `/api/shell/code-repo-snapshot`): the id rule, the retained identity, Universe's `open` grant, and the one fixed
 * error body for each refusal. A step that refuses returns the `Response` to send; otherwise its value.
 *
 * The identity and Universe modules are loaded on use, like `cloudflare-guacamole.ts`'s Supabase client: they read
 * the Supabase server env and are `server-only`, none of which a Code open without a project should pay for.
 */
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { shellJson } from '@/server/shell/http';

import type { ProjectRepoGrant } from './project-repo';

/** Lowercase canonical UUIDs only: the same rule as `shell/ezil/app-link.js` (`UUID`, `parseProject`). */
const PROJECT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const shellRefusal = (status: number, code: string, message: string) => shellJson({ error: { code, message } }, status);

export const projectInvalid = () => shellRefusal(400, 'project_invalid', 'That project link is not valid.');
export const identityRefreshRequired = () => shellRefusal(409, 'IDENTITY_REFRESH_REQUIRED', 'Confirm your EZiL ID to open this project.');
export const projectNotAuthorized = () => shellRefusal(403, 'project_not_authorized', "You don't have access to this project's repository.");
export const projectRepoUnavailable = () => shellRefusal(503, 'project_repo_unavailable', "This project's repository could not be reached. Try again in a moment.");

/** `{projectId, repoId}`, both lowercase canonical UUIDs, or null. Any other key (the deferred `path`) is not read. */
export function projectIds(value: unknown): { projectId: string; repoId: string } | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const { projectId, repoId } = value as { projectId?: unknown; repoId?: unknown };
    if (typeof projectId !== 'string' || typeof repoId !== 'string' || !PROJECT_UUID.test(projectId) || !PROJECT_UUID.test(repoId)) return null;
    return { projectId, repoId };
}

/** This session's retained EZiL ID token, or the IDENTITY_REFRESH_REQUIRED (409) answer. Local: no network. */
export async function retainedIdentityOrRefusal(userId: string): Promise<RetainedIdentity | Response> {
    const { retainedIdentity } = await import('@/server/auth/retained-identity');
    try { return await retainedIdentity(userId); } catch { return identityRefreshRequired(); }
}

/** `project_repo_unavailable` (503) unless `UNIVERSE_PROJECT_REPO_ORIGIN` is a usable origin. Local: no network. */
export async function projectRepoConfiguredOrRefusal(route: string): Promise<Response | null> {
    const { projectRepoOrigin } = await import('./project-repo');
    try { projectRepoOrigin(); return null; } catch {
        console.warn(`[shell] ${route} project refused`, { code: 'not_configured' });
        return projectRepoUnavailable();
    }
}

/**
 * Universe `open` for (projectId, repoId) as the holder of `identity`, or the refusal: a 401 drops the retained token
 * and asks for a refresh (409), a 403 is `project_not_authorized`, anything else (its flag off, a rate limit, a
 * provider down, an off-contract answer) `project_repo_unavailable` (503). Logged by fixed code only.
 */
export async function projectGrantOrRefusal(
    identity: RetainedIdentity, ids: { projectId: string; repoId: string }, route: string, signal?: AbortSignal,
): Promise<ProjectRepoGrant | Response> {
    const { openProjectRepository, ProjectRepoError } = await import('./project-repo');
    try {
        return await openProjectRepository({ userIdToken: identity.token, projectId: ids.projectId, repositoryId: ids.repoId, identityExpiresAt: identity.expiresAt },
            signal ? { signal } : {});
    } catch (err) {
        const code = err instanceof ProjectRepoError ? err.code : 'unavailable';
        console.warn(`[shell] ${route} project refused`, { code });
        if (code === 'identity_refused') {
            const { clearProjectIdentity } = await import('@/server/auth/retained-identity');
            try { await clearProjectIdentity(); } catch { /* the 409 already asks for a fresh one */ }
            return identityRefreshRequired();
        }
        return code === 'not_authorized' ? projectNotAuthorized() : projectRepoUnavailable();
    }
}
