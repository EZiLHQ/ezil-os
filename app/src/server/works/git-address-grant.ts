import 'server-only';

import { z } from 'zod';

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { computerLabel } from './project-repo';

/** The production Git address is never redeemed against staging Works. */
export const GIT_ADDRESS_GRANT_URL = 'https://api.ezil.work/v1/builder/selfserve-repositories/os-grant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,243}$/;
const answer = z.object({
    username: z.literal('ezil'), token: z.string().regex(/^egg_[0-9a-f]{64}$/), expiresAt: z.string().datetime(),
    cloneUrl: z.string(), repositoryId: z.string().regex(UUID), routeName: z.string(), handle: z.string(), name: z.string(),
    binding: z.object({ projectId: z.string().regex(UUID), repositoryId: z.string().regex(UUID),
        canonicalURL: z.string(), ref: z.string(), bindingVersion: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    identity: z.object({ issuer: z.literal('https://id.ezil.work/'), subject: z.string().min(1).max(255) }).strict(),
    scope: z.enum(['read', 'write']), defaultBranch: z.string().regex(BRANCH), class: z.literal('project'),
}).strict();

export type GitAddressGrant = {
    repositoryId: string; canonicalURL: string; ref: string;
    git: { token: string; expiresAt: string; scope: 'read' | 'write' };
    privateBinding: { projectId: string; bindingVersion: string; issuer: 'https://id.ezil.work/'; subject: string };
};
export type GitAddressGrantErrorCode = 'identity_refused' | 'not_found' | 'not_ready' | 'unavailable';
export class GitAddressGrantError extends Error {
    constructor(readonly code: GitAddressGrantErrorCode) { super(`git_address_grant_${code}`); }
}

const validBranch = (branch: string) => !branch.includes('..') && !branch.includes('//') && !branch.endsWith('/')
    && branch.split('/').every(part => !part.startsWith('.') && !part.startsWith('-') && !part.endsWith('.') && !part.endsWith('.lock'));

async function boundedAnswer(response: Response): Promise<unknown> {
    const reader = response.body?.getReader();
    if (!reader) throw new GitAddressGrantError('unavailable');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > 16_384) throw new GitAddressGrantError('unavailable');
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new GitAddressGrantError('unavailable'); }
}

/** Redeem one owned production EZiL Git route for this OS identity and computer. Never expose the raw answer. */
export async function grantForGitAddress(
    identity: RetainedIdentity, computerId: string, canonicalURL: string,
    deps: { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<GitAddressGrant> {
    if (!/^https:\/\/github\.ezil\.work\/[a-z0-9][a-z0-9-]{0,63}\/[a-z0-9][a-z0-9._-]{0,99}\.git$/.test(canonicalURL)
        || canonicalURL.includes('..') || canonicalURL.endsWith('.git.git')) throw new GitAddressGrantError('unavailable');
    const now = (deps.now ?? Date.now)();
    if (identity.issuer !== 'https://id.ezil.work/' || identity.expiresAt <= now) throw new GitAddressGrantError('identity_refused');
    let response: Response;
    try {
        response = await (deps.fetch ?? fetch)(GIT_ADDRESS_GRANT_URL, {
            method: 'POST', redirect: 'error', cache: 'no-store',
            signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
            headers: { authorization: `Bearer ${identity.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ computerLabel: computerLabel(computerId), class: 'project', url: canonicalURL }),
        });
    } catch { throw new GitAddressGrantError('unavailable'); }
    if (response.status === 401) throw new GitAddressGrantError('identity_refused');
    if (response.status === 404 || response.status === 403) throw new GitAddressGrantError('not_found');
    if (response.status === 409) throw new GitAddressGrantError('not_ready');
    if (response.status !== 201) throw new GitAddressGrantError('unavailable');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > 16_384) throw new GitAddressGrantError('unavailable');
    const parsed = await boundedAnswer(response);
    const checked = answer.safeParse(parsed);
    if (!checked.success) throw new GitAddressGrantError('unavailable');
    const grant = checked.data;
    const parts = new URL(canonicalURL).pathname.slice(1, -4).split('/');
    // The Works request can consume most of its ten-second bound. Check the
    // grant and retained identity at the time we would hand them to the Worker.
    const receivedAt = (deps.now ?? Date.now)();
    const expiry = Date.parse(grant.expiresAt);
    if (grant.cloneUrl !== canonicalURL || grant.handle !== parts[0] || grant.name !== parts[1]
        || grant.routeName !== `${parts[0]}/${parts[1]}` || !validBranch(grant.defaultBranch)
        || grant.binding.repositoryId !== grant.repositoryId || grant.binding.canonicalURL !== canonicalURL
        || grant.binding.ref !== `refs/heads/${grant.defaultBranch}`
        || grant.identity.issuer !== identity.issuer || grant.identity.subject !== identity.subject
        || !Number.isFinite(expiry) || expiry <= receivedAt + 5_000 || expiry > receivedAt + 330_000
        || identity.expiresAt <= receivedAt || expiry > identity.expiresAt + 30_000) {
        throw new GitAddressGrantError('unavailable');
    }
    return { repositoryId: grant.repositoryId, canonicalURL: grant.cloneUrl, ref: `refs/heads/${grant.defaultBranch}`,
        git: { token: grant.token, expiresAt: grant.expiresAt, scope: grant.scope },
        privateBinding: { projectId: grant.binding.projectId, bindingVersion: grant.binding.bindingVersion,
            issuer: grant.identity.issuer, subject: grant.identity.subject } };
}
