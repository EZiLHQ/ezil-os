import { validateRepositorySubmission } from './repository-submission';

/** This resolves a public GitHub repository to immutable Git object IDs. It
 * never runs source, downloads an archive, or approves a build. The archive
 * intake worker must separately verify the fetched bytes and the commit/tree
 * before passing them to a sandbox. No caller-controlled host is fetched. */
export type PublicGitHubPinResult =
    | { ok: true; repositoryUrl: string; commitSha: string; treeSha: string }
    | { ok: false; reason: 'invalid-submission' | 'unsupported-host' | 'unsupported-path'
        | 'not-found' | 'rate-limited' | 'source-unavailable' | 'invalid-response' | 'response-too-large' };

const MAX_RESPONSE_BYTES = 512 * 1024;
const REQUEST_TIMEOUT_MS = 8_000;
const sha = /^[a-f0-9]{40}$/i;

export async function resolvePublicGitHubSourcePin(
    submissionInput: unknown,
    fetchImpl: typeof fetch = fetch,
): Promise<PublicGitHubPinResult> {
    const parsed = validateRepositorySubmission(submissionInput);
    if (!parsed.success) return { ok: false, reason: 'invalid-submission' };
    const submission = parsed.data;
    const url = new URL(submission.repositoryUrl);
    if (url.hostname !== 'github.com') return { ok: false, reason: 'unsupported-host' };
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length !== 2) return { ok: false, reason: 'unsupported-path' };
    const [owner, repoPart] = segments;
    const repo = repoPart!.endsWith('.git') ? repoPart!.slice(0, -4) : repoPart!;
    if (!owner || !repo || !/^[a-z0-9][a-z0-9._-]{0,99}$/i.test(repo)) {
        return { ok: false, reason: 'unsupported-path' };
    }
    const repositoryUrl = `https://github.com/${owner}/${repo}`;
    const endpoint = submission.requestedCommitSha
        ? `https://api.github.com/repos/${owner}/${repo}/git/commits/${submission.requestedCommitSha}`
        : `https://api.github.com/repos/${owner}/${repo}/commits?per_page=1`;

    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
        const response = await fetchImpl(endpoint, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
            headers: {
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'EZiL-OS-source-inspector',
            },
        });
        // Native fetch honors redirect: manual. Keep the origin invariant
        // explicit in case a custom transport or future wrapper changes that.
        if (response.url && new URL(response.url).origin !== 'https://api.github.com') {
            return { ok: false, reason: 'source-unavailable' };
        }
        if (response.status === 404) return { ok: false, reason: 'not-found' };
        if (response.status === 429 || (response.status === 403
            && response.headers.get('x-ratelimit-remaining') === '0')) {
            return { ok: false, reason: 'rate-limited' };
        }
        if (response.status !== 200) return { ok: false, reason: 'source-unavailable' };
        if (!response.headers.get('content-type')?.toLowerCase().includes('json')) {
            return { ok: false, reason: 'invalid-response' };
        }
        const declaredSize = Number(response.headers.get('content-length'));
        if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
            return { ok: false, reason: 'response-too-large' };
        }
        const body = await boundedResponse(response, MAX_RESPONSE_BYTES);
        if (body === null) return { ok: false, reason: 'response-too-large' };
        let data: unknown;
        try { data = JSON.parse(body); } catch { return { ok: false, reason: 'invalid-response' }; }
        const item = submission.requestedCommitSha ? data : Array.isArray(data) ? data[0] : null;
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            return { ok: false, reason: 'invalid-response' };
        }
        const commit = item as Record<string, unknown>;
        const commitSha = commit.sha;
        const nestedCommit = typeof commit.commit === 'object' && commit.commit !== null
            ? commit.commit as Record<string, unknown> : null;
        const tree = submission.requestedCommitSha
            ? commit.tree : nestedCommit?.tree;
        const treeSha = typeof tree === 'object' && tree !== null
            ? (tree as Record<string, unknown>).sha : null;
        if (typeof commitSha !== 'string' || !sha.test(commitSha)
            || typeof treeSha !== 'string' || !sha.test(treeSha)
            || (submission.requestedCommitSha
                && commitSha.toLowerCase() !== submission.requestedCommitSha)) {
            return { ok: false, reason: 'invalid-response' };
        }
        return {
            ok: true,
            repositoryUrl,
            commitSha: commitSha.toLowerCase(),
            treeSha: treeSha.toLowerCase(),
        };
    } catch {
        // Transport/timeout details may contain proxy credentials or internal
        // addresses. They stay out of the result and user-visible job record.
        return { ok: false, reason: 'source-unavailable' };
    } finally {
        clearTimeout(deadline);
    }
}

async function boundedResponse(response: Response, limit: number): Promise<string | null> {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let bytes = 0;
    let text = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > limit) {
                await reader.cancel().catch(() => {});
                return null;
            }
            text += decoder.decode(value, { stream: true });
        }
        return text + decoder.decode();
    } finally {
        reader.releaseLock();
    }
}
