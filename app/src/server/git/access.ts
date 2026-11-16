import 'server-only';

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { privatePacketFor, type PrivateGitPacket } from './private-packet';
import { parseRepositoryUrl } from './repo-url';

/** Standalone Git gateway contract, owned by public EZiLHQ/ezil-cli. */
export const STANDALONE_GIT_GRANT_URL = 'https://github.ezil.work/v2/git/grant';
export type GitAccessErrorCode = 'identity_refused' | 'not_found' | 'unavailable' | 'invalid_response';
export class GitAccessError extends Error {
    constructor(readonly code: GitAccessErrorCode) { super(`standalone_git_${code}`); }
}

async function boundedJson(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new GitAccessError('invalid_response');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16_384) throw new GitAccessError('invalid_response');
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GitAccessError('invalid_response'); }
}

/** Redeem a canonical URL under the session's verified EZiL ID token, without revealing it to the browser. */
export async function grantForStandaloneGit(
    identity: RetainedIdentity, canonicalURL: string,
    deps: { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<PrivateGitPacket> {
    const now = (deps.now ?? Date.now)();
    const parsed = parseRepositoryUrl(canonicalURL);
    if (!parsed.ok || parsed.host !== 'github.ezil.work' || parsed.canonicalURL !== canonicalURL)
        throw new GitAccessError('invalid_response');
    if (identity.issuer !== 'https://id.ezil.work/' || !identity.subject || identity.expiresAt <= now)
        throw new GitAccessError('identity_refused');
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const ask = async (scope: 'read' | 'write') => {
        try {
            return await (deps.fetch ?? fetch)(STANDALONE_GIT_GRANT_URL, {
                method: 'POST', redirect: 'error', cache: 'no-store', signal,
                headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ repoURL: canonicalURL, scope }),
            });
        } catch { throw new GitAccessError('unavailable'); }
    };
    let scope: 'read' | 'write' = 'write';
    let response = await ask(scope);
    // A repository may permit read but not write. Only a permission refusal licenses this fallback.
    if (response.status === 403) { scope = 'read'; response = await ask(scope); }
    if (response.status === 401) throw new GitAccessError('identity_refused');
    if (response.status === 403 || response.status === 404) throw new GitAccessError('not_found');
    if (!response.ok) throw new GitAccessError('unavailable');
    const packet = privatePacketFor(await boundedJson(response), canonicalURL, identity, (deps.now ?? Date.now)());
    if (!packet || packet.git.scope !== scope) throw new GitAccessError('invalid_response');
    return packet;
}
