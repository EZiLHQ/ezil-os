import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';
import { projectGrantOrRefusal, projectIds, projectInvalid, retainedIdentityOrRefusal, shellRefusal } from '@/server/works/shell-project';

/**
 * `/api/shell/code-repo-snapshot` — a read-only view of a Universe project repository for when the user's
 * computer cannot start (os-map-design §5 fallback).
 *
 *   POST { project: { projectId, repoId } }
 *     → { ok: true, snapshot: { projectId, repositoryId, ref, head, role, entries: [{ path, kind, size?, text?, omitted? }], truncated } }
 *
 * The same authorization as opening the project in Code, minus the computer: the caller's retained EZiL ID token
 * asks Universe `open` for this (project, repository), and only Universe decides who may read it. The OS server then
 * fetches the branch tip at depth 1 into memory (`@/server/works/git-smart-http`) with that grant and answers
 * the file tree plus the text of every text file up to 256 KB. The grant and the ID token never leave the server.
 *
 * Errors: `project_invalid` 400, `IDENTITY_REFRESH_REQUIRED` 409, `project_not_authorized` 403,
 * `project_repo_unavailable` 503 (Universe), `repo_snapshot_failed` 502 (the git fetch).
 */
export const maxDuration = 120;

export async function POST(req: Request) {
    try {
        const ctx = await createTRPCContext({ headers: new Headers(req.headers) });
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }
        const ids = projectIds((body as { project?: unknown } | null)?.project);
        if (!ids) return projectInvalid();

        const identity = await retainedIdentityOrRefusal(ctx.user.id);
        if (identity instanceof Response) return identity;
        const grant = await projectGrantOrRefusal(identity, ids, 'code-repo-snapshot');
        if (grant instanceof Response) return grant;

        const [{ snapshotProjectRepository }, { fetchRepositoryTree, GitFetchError }] = await Promise.all([
            import('@/server/works/repo-snapshot'), import('@/server/works/git-smart-http'),
        ]);
        try {
            return shellJson({ ok: true, snapshot: await snapshotProjectRepository(grant, fetchRepositoryTree, req.signal) });
        } catch (err) {
            console.warn('[shell] code-repo-snapshot fetch failed', { code: err instanceof GitFetchError ? err.code : 'other' });
            return shellRefusal(502, 'repo_snapshot_failed', "This project's files could not be read. Try again.");
        }
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/code-repo-snapshot');
    }
}
