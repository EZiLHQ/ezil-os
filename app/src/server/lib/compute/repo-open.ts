/**
 * OS server → Worker: put one project repository into the user's own Cloudflare computer (os-map-design §2).
 *
 *   signed v2 (body digest) POST /sandbox/<name>/repo-open
 *     {repositoryId, canonicalURL, ref, git:{token, expiresAt}}  →  {folder:"<root>/projects/<repositoryId>", head}
 *
 * The Worker clones or fetches with the token handed to git through a one-shot credential helper, never argv, a URL
 * or `.git/config`. This side:
 * - signs v2 over the EXACT body string it sends, with no query string (the Worker refuses an unsigned one);
 * - never sends an AWS computer here: its controls are v2 `aws-ec2` and repo-open is Cloudflare only today, so it
 *   answers `repo_open_unsupported_provider` without a request;
 * - accepts a folder only when it is an absolute, dot-free path ending in `/projects/<repositoryId>`. Anything else
 *   is a failure, never a Code window at the computer's root;
 * - logs status and a fixed-shape code only, never the body it sent (the grant) or the body it got.
 */

import { CORRELATION_HEADER } from '../cloudflare-guacamole-provider';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from './preview-token-v2';
import type { ControlTarget } from './aws-control-auth';
import type { ComputerRef } from './provider';

export interface RepoOpenRequest {
    repositoryId: string;
    canonicalURL: string;
    ref: string;
    git: { token: string; expiresAt: string };
}

export type RepoOpenResult =
    | { ok: true; folder: string; head?: string }
    | { ok: false; errorCode: 'repo_open_unsupported_provider' | 'repo_open_failed' };

const LOG_CODE = /^[a-z0-9_]{1,64}$/;
const RESPONSE_MAX_BYTES = 16_384;
/** A first clone of a fresh repository runs inside this; the route's own `maxDuration` is 300 s. */
const REPO_OPEN_TIMEOUT_MS = 120_000;

/** `<absolute root>/projects/<repositoryId>`, every segment plain: no `.`/`..`, no empty segment, no odd bytes. */
export function isRepositoryFolder(folder: unknown, repositoryId: string): folder is string {
    if (typeof folder !== 'string' || folder.length > 1024 || !folder.startsWith('/')) return false;
    const segments = folder.slice(1).split('/');
    return segments.length >= 2 && segments.every(s => /^[A-Za-z0-9._-]+$/.test(s) && s !== '.' && s !== '..')
        && segments[segments.length - 2] === 'projects' && segments[segments.length - 1] === repositoryId;
}

/** The code-server URL with `folder=` set to the repository's folder (replacing the computer's root folder). */
export function withRepositoryFolder(url: string, folder: string): string {
    const parsed = new URL(url);
    parsed.searchParams.set('folder', folder);
    return parsed.toString();
}

export async function requestRepoOpen(
    workerUrl: string,
    hmacSecret: string,
    target: ControlTarget,
    computer: ComputerRef,
    request: RepoOpenRequest,
    deps: { fetch?: typeof fetch; now?: () => number; correlationId?: string } = {},
): Promise<RepoOpenResult> {
    if (target.auth.kind === 'v2' && target.auth.claims.provider === 'aws-ec2') return { ok: false, errorCode: 'repo_open_unsupported_provider' };
    const failed = (status: number | null, code: unknown) => {
        console.warn('[repo-open] worker refused', {
            correlationId: deps.correlationId ?? null, status, error: typeof code === 'string' && LOG_CODE.test(code) ? code : 'other',
        });
        return { ok: false as const, errorCode: 'repo_open_failed' as const };
    };
    if (!hmacSecret.trim()) return failed(null, 'hmac_secret_not_configured');
    try {
        const endpoint = new URL(`/sandbox/${encodeURIComponent(target.sandboxName)}/repo-open`, workerUrl);
        // Fixed key order: the Worker re-reads exactly these fields from exactly this string.
        const body = JSON.stringify({
            repositoryId: request.repositoryId, canonicalURL: request.canonicalURL, ref: request.ref,
            git: { token: request.git.token, expiresAt: request.git.expiresAt },
        });
        // A Cloudflare computer's v2 claims, as `compute/cloudflare.ts` `authOf` mints them: no generation or lease,
        // and no store claim.
        const claims = target.auth.kind === 'v2' ? target.auth.claims : {
            sandboxId: target.sandboxName, computerId: computer.computerId, userId: computer.userId,
            provider: 'cloudflare' as const, store: '' as const, generation: 0, leaseEpoch: 0,
        };
        const token = mintPreviewTokenV2(hmacSecret, { ...claims, ts: (deps.now ?? Date.now)() }, { method: 'POST', path: endpoint.pathname, body });
        const response = await (deps.fetch ?? fetch)(endpoint, {
            method: 'POST', body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(REPO_OPEN_TIMEOUT_MS),
            headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: token,
                ...(deps.correlationId ? { [CORRELATION_HEADER]: deps.correlationId } : {}) },
        });
        const text = await response.text();
        let value: { ok?: unknown; folder?: unknown; head?: unknown; error?: unknown; errorCode?: unknown } = {};
        try { if (text.length <= RESPONSE_MAX_BYTES) value = JSON.parse(text) ?? {}; } catch { /* not JSON: refused below */ }
        const code = value.errorCode ?? value.error;
        if (code === 'repo_open_unsupported_provider') return { ok: false, errorCode: 'repo_open_unsupported_provider' };
        if (!response.ok || value.ok === false) return failed(response.status, code);
        if (!isRepositoryFolder(value.folder, request.repositoryId)) return failed(response.status, 'invalid_folder');
        const head = typeof value.head === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.head) ? value.head : undefined;
        return { ok: true, folder: value.folder, ...(head ? { head } : {}) };
    } catch (err) {
        return failed(null, err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'transport');
    }
}
