import type { PrivateGrant } from '@/server/project-repositories/contract';
import { createHash } from 'node:crypto';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ControlTarget } from './aws-control-auth';
import type { ComputerRef } from './provider';
export const canonicalRepository = /^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/(?![a-z0-9._-]*\.\.)(?![a-z0-9._-]*\.git\.git$)[a-z0-9][a-z0-9._-]{0,99}\.git$/;
export function repositoryFolder(value: unknown): value is string {
    return typeof value === 'string' && /^\/(?:[A-Za-z0-9._-]+\/)*\.ezil-repositories\/[a-f0-9]{64}\/[a-f0-9]{64}$/.test(value)
        && !value.split('/').some(p => p === '.' || p === '..');
}
export function withRepositoryFolder(url: string, folder: string): string {
    if (!repositoryFolder(folder)) throw new Error('repo_invalid_result');
    const parsed = new URL(url);
    parsed.searchParams.set('folder', folder);
    return parsed.toString();
}
export async function requestRepositoryOpen(workerUrl: string, secret: string, target: ControlTarget, computer: ComputerRef, repo: string, grant?: PrivateGrant) {
    const failure = (error = 'repo_open_failed') => ({ ok: false as const, error, errorCode: error,
        message: error === 'repo_recovery_required' ? 'Repository operation was forcibly stopped. Verified recovery is required before retrying.'
            : error === 'repo_timeout' ? 'Repository operation timed out and stopped. Retry the request.'
            : error === 'repo_auth_required' ? 'Sign in to EZiL Works with ezil auth login in this computer, then retry.' : 'Repository could not be opened.' });
    if (!canonicalRepository.test(repo) || !secret) return failure('repo_invalid_request');
    try {
        const endpoint = new URL(`/sandbox/${target.sandboxName}/repo-open`, workerUrl);
        const body = JSON.stringify({ repo, userId: computer.userId, ...(grant ? { grant } : {}) });
        const claims = target.auth.kind === 'v2' ? target.auth.claims : {
            sandboxId: target.sandboxName, computerId: computer.computerId, userId: computer.userId,
            provider: 'cloudflare' as const, store: '' as const, generation: 0, leaseEpoch: 0,
        };
        const token = mintPreviewTokenV2(secret, { ...claims, ts: Date.now() }, { method: 'POST', path: endpoint.pathname, body });
        const response = await fetch(endpoint, { method: 'POST', body, headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token }, redirect: 'error', signal: AbortSignal.timeout(200000) });
        const value = await response.json();
        const expectedSuffix = '/' + createHash('sha256').update(computer.userId).digest('hex') + '/' + createHash('sha256').update(repo).digest('hex');
        if (response.ok && value.ok === true && value.canonicalUrl === repo && repositoryFolder(value.folder) && value.folder.endsWith(expectedSuffix)) return { ok: true as const, folder: value.folder };
        const codes = ['repo_timeout', 'repo_recovery_required', 'repo_ref_mismatch', 'repo_auth_required', 'repo_not_authorized', 'repo_cli_unavailable', 'repo_unsafe_destination', 'repo_clone_failed'];
        return failure(codes.includes(value.error) ? value.error : undefined);
    } catch { return failure(); }
}
