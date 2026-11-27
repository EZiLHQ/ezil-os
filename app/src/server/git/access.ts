import 'server-only';

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { privatePacketFor, type PrivateGitPacket } from './private-packet';
import { parseRepositoryUrl } from './repo-url';

/** Standalone Git gateway contract, owned by public EZiLHQ/ezil-cli. */
export const STANDALONE_GIT_GRANT_URL = 'https://github.ezil.work/v2/git/grant';
export type GitAccessErrorCode = 'identity_refused' | 'not_found' | 'unavailable' | 'invalid_response';
export class GitAccessError extends Error {
    /**
     * `retryable`: the gateway provably minted no credential for this ask (its own 503, or a connect-phase failure
     * where the request was never sent), so asking again repeats nothing. Every other failure stays final.
     */
    constructor(readonly code: GitAccessErrorCode, readonly retryable = false) { super(`standalone_git_${code}`); }
}

/** One recovery ask at most, inside the single 10 s bound below: a transient gateway answer must not end an editor open. */
export const GRANT_RETRY_DELAY_MS = 300;
/** Connect-phase failures: the request never reached the gateway, so no grant can have been minted. */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);
const neverSent = (error: unknown): boolean => {
    const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
    return typeof cause?.code === 'string' && NEVER_SENT.has(cause.code);
};

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
    deps: { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number; sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
        /** Opt-in: only a caller that can wait for it (the Code editor open) asks again; every other caller is unchanged. */
        recover?: boolean; onRetry?: (why: 'gateway_503' | 'never_sent') => void } = {},
): Promise<PrivateGitPacket> {
    const now = (deps.now ?? Date.now)();
    const parsed = parseRepositoryUrl(canonicalURL);
    if (!parsed.ok || parsed.host !== 'github.ezil.work' || parsed.canonicalURL !== canonicalURL)
        throw new GitAccessError('invalid_response');
    if (identity.issuer !== 'https://id.ezil.work/' || !identity.subject || identity.expiresAt <= now)
        throw new GitAccessError('identity_refused');
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    const send = async (scope: 'read' | 'write') => {
        if (signal.aborted) throw new GitAccessError('unavailable');
        try {
            return await (deps.fetch ?? fetch)(STANDALONE_GIT_GRANT_URL, {
                method: 'POST', redirect: 'error', cache: 'no-store', signal,
                headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ repoURL: canonicalURL, scope }),
            });
        } catch (error) { throw new GitAccessError('unavailable', neverSent(error)); }
    };
    const sleep = deps.sleep ?? ((ms: number, until: AbortSignal) => new Promise<void>((resolve, reject) => {
        if (until.aborted) { reject(until.reason); return; }
        const aborted = () => { clearTimeout(timer); reject(until.reason); };
        const timer = setTimeout(() => { until.removeEventListener('abort', aborted); resolve(); }, ms);
        until.addEventListener('abort', aborted, { once: true });
    }));
    // Permission fallback shares the grant's one recovery budget; it cannot restart it.
    let recovered = false;
    // The same ask again, once, only after an answer that proves no credential was minted. Identity, address and scope
    // are exactly the first ask's; an aborted bound, a 4xx, a slow or reset connection and a bad body are never repeated.
    const ask = async (scope: 'read' | 'write') => {
        if (deps.recover !== true) return send(scope);
        let response: Response | null = null, why: 'gateway_503' | 'never_sent' | null = null;
        try { response = await send(scope); } catch (error) {
            if (!(error instanceof GitAccessError) || !error.retryable || signal.aborted) throw error;
            why = 'never_sent';
        }
        if (response !== null && response.status === 503) { void response.body?.cancel().catch(() => {}); why = 'gateway_503'; }
        if (why === null) return response!;
        if (signal.aborted || recovered) throw new GitAccessError('unavailable');
        recovered = true;
        deps.onRetry?.(why);
        try { await sleep(GRANT_RETRY_DELAY_MS, signal); } catch { throw new GitAccessError('unavailable'); }
        try { return await send(scope); } catch { throw new GitAccessError('unavailable'); } // the one repeat is final
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
