/** Narrow wire contract shared by both computer providers. No caller path is accepted. */
export const REPO_OPEN_PORT = 9224;
const canonical = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/(?![a-z0-9._-]*\.\.)(?![a-z0-9._-]*\.git\.git$)[a-z0-9][a-z0-9._-]{0,99}\.git$/;
export function validRepoIntent(value: unknown): value is { repo: string; userId: string } {
    if (!value || typeof value !== 'object') return false;
    const v = value as Record<string, unknown>;
    return Object.keys(v).every(k => k === 'repo' || k === 'userId') && typeof v.repo === 'string' && canonical.test(v.repo)
        && typeof v.userId === 'string' && /^[a-f0-9-]{36}$/.test(v.userId);
}
export function validRepoFolder(value: unknown): value is string {
    return typeof value === 'string' && /^\/(?:[A-Za-z0-9._-]+\/)*\.ezil-repositories\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(value)
        && !value.split('/').some(p => p === '.' || p === '..');
}
export function repoOpenResult(value: unknown, repo: string) {
    const v = value as Record<string, unknown> | null;
    if (v?.ok === true && v.canonicalUrl === repo && validRepoFolder(v.folder) && ['cloned', 'reused'].includes(String(v.status))) {
        return { ok: true as const, folder: v.folder, canonicalUrl: repo, status: v.status as 'cloned' | 'reused' };
    }
    const errors = ['repo_timeout', 'repo_recovery_required', 'repo_auth_required', 'repo_not_authorized', 'repo_cli_unavailable', 'repo_unsafe_destination', 'repo_clone_failed'];
    return { ok: false as const, error: errors.includes(String(v?.error)) ? String(v?.error) : 'repo_open_failed' };
}
