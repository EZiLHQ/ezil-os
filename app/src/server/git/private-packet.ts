import 'server-only';

import { parseRepositoryUrl } from './repo-url';

/** Exact v2 packet returned by the standalone Git gateway and consumed by the public CLI. */
export interface PrivateGitPacket {
    version: 2;
    repository: { id: string; canonicalURL: string; ref: string };
    identity: { issuer: 'https://id.ezil.work/'; subject: string };
    git: { username: 'ezil'; token: string; expiresAt: string; scope: 'read' | 'write' };
}

const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string[]) => Object.keys(value).sort().join(',') === [...expected].sort().join(',');
const REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/;
/** Opaque HTTP-safe Basic password; native Artifacts grants include `?expires=...`. */
const TOKEN = /^[A-Za-z0-9._~+\/=\-?]{16,8192}$/;
const MAX_GRANT_LIFETIME_MS = 300_000;
const OPAQUE_ID = /^[^\s\x00-\x1f\x7f]{1,255}$/u;
const validRef = (ref: string) => REF.test(ref) && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/')
    && ref.slice('refs/heads/'.length).split('/').every(part => !part.startsWith('.') && !part.startsWith('-') && !part.endsWith('.') && !part.endsWith('.lock'));

/** Reject cross-repository, cross-identity, malformed and stale producer answers before Code wakes. */
export function privatePacketFor(raw: unknown, canonicalURL: string, identity: { issuer: string; subject: string }, now = Date.now()): PrivateGitPacket | null {
    const parsed = parseRepositoryUrl(canonicalURL);
    if (!parsed.ok || parsed.host !== 'github.ezil.work' || parsed.canonicalURL !== canonicalURL
        || identity.issuer !== 'https://id.ezil.work/' || !OPAQUE_ID.test(identity.subject)) return null;
    if (!object(raw) || !keys(raw, ['version', 'repository', 'identity', 'git']) || raw.version !== 2) return null;
    const repo = raw.repository, person = raw.identity, git = raw.git;
    if (!object(repo) || !keys(repo, ['id', 'canonicalURL', 'ref'])
        || typeof repo.id !== 'string' || !/^[a-z0-9]{1,64}$/.test(repo.id)
        || repo.canonicalURL !== canonicalURL || typeof repo.ref !== 'string' || !validRef(repo.ref)) return null;
    if (!object(person) || !keys(person, ['issuer', 'subject']) || person.issuer !== identity.issuer || person.subject !== identity.subject) return null;
    if (!object(git) || !keys(git, ['username', 'token', 'expiresAt', 'scope']) || git.username !== 'ezil'
        || typeof git.token !== 'string' || !TOKEN.test(git.token)
        || typeof git.expiresAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(git.expiresAt)
        || !Number.isFinite(Date.parse(git.expiresAt)) || Date.parse(git.expiresAt) <= now
        || Date.parse(git.expiresAt) > now + MAX_GRANT_LIFETIME_MS
        || (git.scope !== 'read' && git.scope !== 'write')) return null;
    return raw as unknown as PrivateGitPacket;
}
