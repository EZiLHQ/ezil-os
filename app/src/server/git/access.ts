import 'server-only';

import { z } from 'zod';

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { computerLabel, GIT_TOKEN } from '@/server/works/project-repo';
import { privatePacketFor, type PrivateGitPacket } from './private-packet';
import { parseRepositoryUrl } from './repo-url';

/** Standalone Git gateway contract, owned by public EZiLHQ/ezil-cli. */
export const STANDALONE_GIT_GRANT_URL = 'https://github.ezil.work/v2/git/grant';
/**
 * Staging Works' per-address owner grant for an interview git-qa repository (contract §6). A constant that is only
 * ever reached once `stagingGitQaAccepted()` holds; production has no git-qa path and never calls this.
 */
export const WORKS_GIT_ADDRESS_GRANT_URL = 'https://api-staging.ezil.work/v1/builder/selfserve-repositories/os-grant';
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

/**
 * What the Worker's binding (non-packet) open needs from a Works git-qa grant: the canonical remote, its default
 * branch as a `refs/heads/*` ref, and the short Basic credential. No privatePacket, so this opens through the same
 * Worker request shape a Universe project does — never the v2 CLI path, which is github.ezil.work only.
 */
export interface WorksGitAddressGrant {
    canonicalURL: string;
    ref: string;
    git: { token: string; expiresAt: string; scope: 'read' | 'write' };
}

/** `main` → `refs/heads/main`, held to the Worker's own branch rules (`branchOf`); null for anything git could read as an option. */
function refForDefaultBranch(branch: string): string | null {
    const ref = `refs/heads/${branch}`;
    if (ref.length > 255 || !/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes('..') || ref.includes('//') || ref.endsWith('/')) return null;
    return ref.split('/').every(p => !p.startsWith('.') && !p.startsWith('-') && !p.endsWith('.') && !p.endsWith('.lock')) ? ref : null;
}

/** Works' `os-grant` answer, held to its exact shape (contract §6): unknown keys are rejected. */
const worksGitGrant = z.object({
    username: z.literal('ezil'),
    token: z.string().regex(GIT_TOKEN),
    expiresAt: z.string().datetime(),
    cloneUrl: z.string(),
    repositoryId: z.string().min(1),
    routeName: z.string().min(1),
    handle: z.string().min(1),
    name: z.string().min(1),
    scope: z.enum(['read', 'write']),
    defaultBranch: z.string().min(1).max(200),
    class: z.literal('project'),
}).strict();

/**
 * Redeem a git-qa interview repository address for the signed-in candidate, under their retained EZiL ID token, from
 * staging Works (contract §6). The token travels only in the Authorization header; the body carries exactly the three
 * keys Works accepts (it refuses unknown keys and a body over 1024 bytes). Neither the token nor the answer is ever
 * returned to the browser or logged. Status mapping: 401 → identity_refused, 403/404 → not_found, any other status →
 * unavailable, a malformed or wrong-repository answer → invalid_response.
 */
export async function grantForWorksGitAddress(
    identity: RetainedIdentity, canonicalURL: string, computerId: string,
    deps: { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<WorksGitAddressGrant> {
    const now = (deps.now ?? Date.now)();
    const parsed = parseRepositoryUrl(canonicalURL, { stagingGitQa: true });
    if (!parsed.ok || parsed.host !== 'git-qa.ezil.work' || parsed.canonicalURL !== canonicalURL)
        throw new GitAccessError('invalid_response');
    if (identity.issuer !== 'https://id.ezil.work/' || !identity.subject || identity.expiresAt <= now)
        throw new GitAccessError('identity_refused');
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    let response: Response;
    try {
        response = await (deps.fetch ?? fetch)(WORKS_GIT_ADDRESS_GRANT_URL, {
            method: 'POST', redirect: 'error', cache: 'no-store', signal,
            headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ computerLabel: computerLabel(computerId), class: 'project', url: canonicalURL }),
        });
    } catch { throw new GitAccessError('unavailable'); }
    if (response.status === 401) throw new GitAccessError('identity_refused');
    if (response.status === 403 || response.status === 404) throw new GitAccessError('not_found');
    if (!response.ok) throw new GitAccessError('unavailable');
    const answer = worksGitGrant.safeParse(await boundedJson(response));
    if (!answer.success) throw new GitAccessError('invalid_response');
    const ref = refForDefaultBranch(answer.data.defaultBranch);
    // The grant must be for the repository that was asked about, and name a branch git could open.
    if (!ref || answer.data.cloneUrl !== canonicalURL) throw new GitAccessError('invalid_response');
    return { canonicalURL, ref, git: { token: answer.data.token, expiresAt: answer.data.expiresAt, scope: answer.data.scope } };
}
