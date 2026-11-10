import 'server-only';

import { createHash } from 'node:crypto';

/**
 * A repository opened from its address: `/app/code?repo=<URL-encoded https repository URL>` (founder 547ed35a;
 * docs/APP-ROUTES.md §2). The URL in the link is navigation intent only. This module decides what it may name:
 *
 * - `parseRepositoryUrl`: one canonical form or a refusal. A public `github.com` repository opens anonymously;
 *   an exact `github.ezil.work` route requires an EZiL Works grant by address. Other EZiL Git hosts are refused.
 *   No credentials, port, query, fragment,
 *   percent-encoding, extra path or other host, ever.
 * - `repositoryIdFor`: a stable id from the canonical URL, so `<root>/projects/<id>` is the same folder on every
 *   reopen (the Worker then fetches only, keeping uncommitted work) and never another repository's.
 * - `resolvePublicGitHub`: one anonymous smart-HTTP read of the repository's ref advertisement, which proves it exists
 *   and is public and names its default branch (`symref=HEAD:`). No credential is ever sent; a private repository
 *   looks exactly like a missing one, so the answer reveals nothing about anyone's private repositories.
 */

export type ParsedRepositoryUrl =
    | { ok: true; host: 'github.com'; owner: string; name: string; canonicalURL: string; displayName: string }
    | { ok: true; host: 'github.ezil.work'; owner: string; name: string; canonicalURL: string; displayName: string }
    | { ok: false; reason: 'invalid' | 'unsupported_host' };

const MAX_URL_LENGTH = 512;
/** GitHub's owner rule: letters, digits and single inner hyphens, at most 39. */
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
/** A plain repository name: no leading dot, no `..`, at most 100. */
const NAME = /^(?!\.)(?![A-Za-z0-9._-]*\.\.)[A-Za-z0-9._-]{1,100}$/;
/** EZiL Git route grammar, kept aligned with the gateway and Works address grant. */
const EZIL_NAMESPACE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const EZIL_NAME = /^(?![a-z0-9._-]*\.\.)(?![a-z0-9._-]*\.git$)[a-z0-9][a-z0-9._-]{0,99}$/;
/**
 * Every host the EZiL Git gateway serves (EZiL CLI `apps/git-gateway`): production `github.ezil.work` and
 * `git.ezil.work`, `git-staging.ezil.work` (staging gateway code, production Works) and `git-qa.ezil.work`
 * (staging Works; os-builder-project-open-v1 §4). Only the exact production host is accepted by the address route.
 */
const EZIL_GIT_HOSTS = new Set(['github.ezil.work', 'git.ezil.work', 'git-staging.ezil.work', 'git-qa.ezil.work']);

/** One canonical public GitHub or authenticated EZiL Git address, or a refusal. Never throws. */
export function parseRepositoryUrl(raw: unknown): ParsedRepositoryUrl {
    const invalid = { ok: false as const, reason: 'invalid' as const };
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return invalid;
    // Refused before parsing: anything URL parsing would normalise away or that git could read differently.
    if (/[\s\\%?#@]/.test(raw) || /[\u0000-\u001f\u007f-￿]/.test(raw)) return invalid;
    let url: URL;
    try { url = new URL(raw); } catch { return invalid; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return invalid;
    if (!raw.startsWith(`https://${url.hostname}/`)) return invalid; // no case games or trailing dots in the host as typed
    if (url.hostname === 'github.ezil.work') {
        const parts = url.pathname.split('/');
        if (parts.length !== 3 || parts[0] !== '' || !EZIL_NAMESPACE.test(parts[1]!)) return invalid;
        const name = parts[2]!.endsWith('.git') ? parts[2]!.slice(0, -4) : parts[2]!;
        if (!EZIL_NAME.test(name) || name.endsWith('.')) return invalid;
        const owner = parts[1]!;
        return { ok: true, host: 'github.ezil.work', owner, name,
            canonicalURL: `https://github.ezil.work/${owner}/${name}.git`, displayName: `${owner}/${name}` };
    }
    if (EZIL_GIT_HOSTS.has(url.hostname)) return { ok: false, reason: 'unsupported_host' };
    if (url.hostname !== 'github.com') return invalid;
    const parts = url.pathname.replace(/\/$/, '').split('/');
    if (parts.length !== 3 || parts[0] !== '') return invalid;
    const owner = parts[1]!;
    const name = parts[2]!.endsWith('.git') ? parts[2]!.slice(0, -'.git'.length) : parts[2]!;
    if (!OWNER.test(owner) || !NAME.test(name) || name.toLowerCase().endsWith('.git')) return invalid;
    // GitHub names are case-insensitive: one canonical (lowercase) remote, so a reopen in any case is the same folder.
    const canonicalURL = `https://github.com/${owner.toLowerCase()}/${name.toLowerCase()}.git`;
    return { ok: true, host: 'github.com', owner, name, canonicalURL, displayName: `${owner}/${name}` };
}

/** `<root>/projects/<id>`'s id for a canonical URL: a stable lowercase UUID (RFC 9562 version 8, from sha256). */
export function repositoryIdFor(canonicalURL: string): string {
    const hex = createHash('sha256').update(`ezil-os/repo-url/v1|${canonicalURL}`).digest('hex').slice(0, 32).split('');
    hex[12] = '8';
    hex[16] = ['8', '9', 'a', 'b'][parseInt(hex[16]!, 16) & 3]!;
    const h = hex.join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export type PublicGitHubResolution =
    | { ok: true; ref: string }
    | { ok: false; reason: 'not_found' | 'moved' | 'empty' | 'unavailable' };

const ADVERTISEMENT_MAX_BYTES = 65_536;
const RESOLVE_TIMEOUT_MS = 10_000;
/** The same ref grammar the Worker and Universe apply (`branchOf`). */
const REF = /^refs\/heads\/[A-Za-z0-9._/-]{1,240}$/;
const validRef = (ref: string) => REF.test(ref) && !ref.includes('..') && !ref.includes('//') && !ref.endsWith('/')
    && ref.slice('refs/heads/'.length).split('/').every(p => !p.startsWith('.') && !p.startsWith('-') && !p.endsWith('.') && !p.endsWith('.lock'));

async function boundedBytes(response: Response, max: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        while (size < max) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
        }
    } finally { void reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks).subarray(0, max);
}

/** The default branch named by a git-upload-pack advertisement (`symref=HEAD:refs/heads/<b>`), or null. */
export function defaultRefOf(advertisement: Buffer): string | null {
    let at = 0, first = true;
    while (at + 4 <= advertisement.length) {
        const length = parseInt(advertisement.subarray(at, at + 4).toString('ascii'), 16);
        if (!Number.isInteger(length) || length < 0) return null;
        if (length === 0) { at += 4; continue; } // a flush between the service line and the refs
        if (length < 4 || at + length > advertisement.length) return null;
        const line = advertisement.subarray(at + 4, at + length).toString('utf8');
        at += length;
        if (first && line.startsWith('# service=')) { first = false; continue; }
        const nul = line.indexOf('\0');
        if (nul === -1) return null; // the first ref line carries the capabilities; none means no HEAD to read
        const symref = line.slice(nul + 1).split(' ').find(c => c.startsWith('symref=HEAD:'));
        const ref = symref?.slice('symref=HEAD:'.length).trim() ?? null;
        return ref && validRef(ref) ? ref : null;
    }
    return null;
}

/**
 * One anonymous ref advertisement read of a public github.com repository: whether it exists (publicly) and its
 * default branch. 401/403/404 are `not_found` (a private repository answers the same); anything else that is not a
 * clean answer is `unavailable` (retryable), never a guess.
 */
export async function resolvePublicGitHub(canonicalURL: string, deps: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<PublicGitHubResolution> {
    const timeout = AbortSignal.timeout(RESOLVE_TIMEOUT_MS);
    let response: Response;
    try {
        response = await (deps.fetch ?? fetch)(new URL(`${canonicalURL}/info/refs?service=git-upload-pack`), {
            method: 'GET', redirect: 'manual', cache: 'no-store', signal: deps.signal ? AbortSignal.any([deps.signal, timeout]) : timeout,
            headers: { 'user-agent': 'git/2.43.0 (ezil-os repo-url)', accept: 'application/x-git-upload-pack-advertisement' },
        });
    } catch {
        return { ok: false, reason: 'unavailable' };
    }
    if (response.status === 401 || response.status === 403 || response.status === 404) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, reason: 'not_found' };
    }
    // A renamed or transferred repository redirects; nothing follows it (the Worker's git refuses redirects too), the
    // person opens the new address instead.
    if ([301, 302, 303, 307, 308].includes(response.status)) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, reason: 'moved' };
    }
    if (response.status !== 200 || !(response.headers.get('content-type') ?? '').startsWith('application/x-git-upload-pack-advertisement')) {
        void response.body?.cancel().catch(() => {});
        return { ok: false, reason: 'unavailable' };
    }
    let body: Buffer;
    try { body = await boundedBytes(response, ADVERTISEMENT_MAX_BYTES); } catch { return { ok: false, reason: 'unavailable' }; }
    const ref = defaultRefOf(body);
    return ref ? { ok: true, ref } : { ok: false, reason: 'empty' };
}
