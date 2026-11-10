import 'server-only';

import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';

import { ARTIFACTS_REPOSITORY, EZIL_GIT_REPOSITORY, GIT_TOKEN } from './project-repo';

/**
 * A minimal, read-only git client for ONE thing: the files of one branch tip, fetched at depth 1 into memory over
 * git's smart HTTP protocol (v0, stateless RPC), from a project repository's remote only. It exists because the app
 * has no git client dependency (`app/node_modules` has no isomorphic-git) and the snapshot fallback
 * (`./repo-snapshot.ts`) must run on the OS server, where the Git token already is, without a computer.
 *
 * - The token travels only in the Authorization header, the way the server behind the URL takes it: `Bearer <token>`
 *   to a Cloudflare Artifacts remote (exactly what EZiL Git's own gateway sends upstream, EZiL CLI
 *   `apps/git-gateway`), HTTP Basic `<username>:<token>` to EZiL Git (`https://github.ezil.work`). Any other URL is
 *   refused before a request, redirects are refused, and the token is never put in a URL, an error message or a log
 *   line.
 * - Every size is capped: the advertisement, the pack, each object, the object count, the tree entries.
 * - SHA-1 repositories only; a thin pack, protocol v2-only server or `object-format=sha256` is `unsupported`.
 *
 * The protocol pieces are exactly what `git fetch --depth 1` does over HTTP: GET `info/refs?service=git-upload-pack`,
 * then one POST of `want <oid> <caps>`, `deepen 1`, flush, `done` to `git-upload-pack`, whose answer is the shallow
 * section, a NAK and the pack (in side-band-64k when offered). The tests run it against `git upload-pack` itself.
 */

export interface GitFetchRequest {
    canonicalURL: string;
    ref: string;
    username: string;
    token: string;
    signal?: AbortSignal;
}

export interface GitTreeEntry {
    path: string;
    kind: 'file' | 'dir' | 'symlink' | 'submodule';
    mode: string;
    /** Files only. */
    size?: number;
    content?: Uint8Array;
}

export interface GitTree { head: string; entries: GitTreeEntry[] }

/** The pluggable part: `./repo-snapshot.ts` takes any function of this shape. */
export type RepoFetcher = (request: GitFetchRequest, fetchImpl?: typeof fetch) => Promise<GitTree>;

export type GitFetchErrorCode = 'unauthorized' | 'not_found' | 'ref_not_found' | 'empty_repository' | 'unsupported' | 'too_large' | 'protocol' | 'transport';

export class GitFetchError extends Error {
    constructor(readonly code: GitFetchErrorCode) { super(`git_fetch_${code}`); }
}

const MAX_ADVERTISEMENT_BYTES = 1 << 20;
const MAX_PACK_BYTES = 64 << 20;
const MAX_OBJECT_BYTES = 32 << 20;
const MAX_INFLATED_BYTES = 256 << 20;
const MAX_OBJECTS = 100_000;
const MAX_TREE_ENTRIES = 20_000;
const MAX_TREE_DEPTH = 64;
const TIMEOUT_MS = 60_000;
const OID = /^[0-9a-f]{40}$/;
const TYPE_NAMES = ['', 'commit', 'tree', 'blob', 'tag'] as const;

const fail = (code: GitFetchErrorCode): never => { throw new GitFetchError(code); };

/** pkt-line framing. `next()` is a payload, `null` for a flush (or v2 delimiter), `undefined` at the end. */
class PktReader {
    pos = 0;
    constructor(readonly buf: Buffer) {}
    next(): Buffer | null | undefined {
        if (this.pos === this.buf.length) return undefined;
        if (this.pos + 4 > this.buf.length) fail('protocol');
        const hex = this.buf.toString('latin1', this.pos, this.pos + 4);
        if (!/^[0-9a-f]{4}$/.test(hex)) fail('protocol');
        const length = parseInt(hex, 16);
        if (length <= 2) { this.pos += 4; return null; }
        if (length < 4 || this.pos + length > this.buf.length) fail('protocol');
        const data = this.buf.subarray(this.pos + 4, this.pos + length);
        this.pos += length;
        return data;
    }
}

const pkt = (line: string) => {
    const data = Buffer.from(line, 'utf8');
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'latin1'), data]);
};
const text = (line: Buffer) => line.toString('utf8').replace(/\n$/, '');

async function readCapped(response: Response, max: number): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > max) fail('too_large');
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
}

interface Advertisement { refs: Map<string, string>; caps: Set<string> }

export function parseAdvertisement(body: Buffer): Advertisement {
    const reader = new PktReader(body);
    let line = reader.next();
    if (line && text(line).startsWith('# service=')) {
        if (reader.next() !== null) fail('protocol');
        line = reader.next();
    }
    const refs = new Map<string, string>();
    const caps = new Set<string>();
    for (let first = true; line; line = reader.next(), first = false) {
        let value = text(line);
        if (value.startsWith('ERR ')) fail('protocol');
        if (value === 'version 2') fail('unsupported');
        const nul = value.indexOf('\0');
        if (nul >= 0) {
            if (!first) fail('protocol');
            for (const cap of value.slice(nul + 1).split(' ')) if (cap) caps.add(cap);
            value = value.slice(0, nul);
        }
        const match = /^([0-9a-f]{40}) (\S+)$/.exec(value);
        if (!match) fail('protocol');
        if (match![2] !== 'capabilities^{}') refs.set(match![2], match![1]);
    }
    if ([...caps].some(c => c.startsWith('object-format=') && c !== 'object-format=sha1')) fail('unsupported');
    return { refs, caps };
}

/** Undo the side band (channel 1 = pack, 2 = progress, 3 = fatal) or take the rest raw. */
export function parseUploadPackResult(body: Buffer, { shallow, sideband }: { shallow: boolean; sideband: boolean }): Buffer {
    const reader = new PktReader(body);
    if (shallow) {
        for (;;) {
            const line = reader.next();
            if (line === null) break;
            if (line === undefined) fail('protocol');
            const value = text(line!);
            if (value.startsWith('ERR ')) fail('protocol');
            if (!/^(?:shallow|unshallow) [0-9a-f]{40}$/.test(value)) fail('protocol');
        }
    }
    const ack = reader.next();
    if (!ack || !/^(?:NAK|ACK [0-9a-f]{40})/.test(text(ack))) fail('protocol');
    if (!sideband) return body.subarray(reader.pos);
    const parts: Buffer[] = [];
    for (;;) {
        const line = reader.next();
        if (line === null || line === undefined) break;
        if (line[0] === 1) parts.push(line.subarray(1));
        else if (line[0] === 3) fail('protocol');
        else if (line[0] !== 2) fail('protocol');
    }
    return Buffer.concat(parts);
}

const inflate = inflateSync as unknown as (buf: Buffer, options: { info: true; maxOutputLength: number }) => { buffer: Buffer; engine: { bytesWritten: number } };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
    let p = 0;
    const varint = () => {
        let value = 0, shift = 0, c: number;
        do {
            if (p >= delta.length || shift > 49) fail('protocol');
            c = delta[p++]; value += (c & 0x7f) * 2 ** shift; shift += 7;
        } while (c & 0x80);
        return value;
    };
    if (varint() !== base.length) fail('protocol');
    const size = varint();
    if (size > MAX_OBJECT_BYTES) fail('too_large');
    const out = Buffer.alloc(size);
    let o = 0;
    const byte = () => (p < delta.length ? delta[p++] : fail('protocol'));
    while (p < delta.length) {
        const c = delta[p++];
        if (c & 0x80) {
            let offset = 0, length = 0;
            if (c & 0x01) offset += byte();
            if (c & 0x02) offset += byte() * 0x100;
            if (c & 0x04) offset += byte() * 0x10000;
            if (c & 0x08) offset += byte() * 0x1000000;
            if (c & 0x10) length += byte();
            if (c & 0x20) length += byte() * 0x100;
            if (c & 0x40) length += byte() * 0x10000;
            if (length === 0) length = 0x10000;
            if (offset + length > base.length || o + length > size) fail('protocol');
            base.copy(out, o, offset, offset + length); o += length;
        } else if (c) {
            if (p + c > delta.length || o + c > size) fail('protocol');
            delta.copy(out, o, p, p + c); p += c; o += c;
        } else fail('protocol');
    }
    if (o !== size) fail('protocol');
    return out;
}

/** Every object in a version 2/3 pack, deltas resolved, by object id. A thin pack (a missing base) is refused. */
export function readPack(pack: Buffer): Map<string, { type: number; data: Buffer }> {
    if (pack.length < 32 || pack.toString('latin1', 0, 4) !== 'PACK') fail('protocol');
    const version = pack.readUInt32BE(4);
    const count = pack.readUInt32BE(8);
    if ((version !== 2 && version !== 3) || count > MAX_OBJECTS) fail(count > MAX_OBJECTS ? 'too_large' : 'unsupported');
    const end = pack.length - 20;
    if (!createHash('sha1').update(pack.subarray(0, end)).digest().equals(pack.subarray(end))) fail('protocol');
    const raw: { type: number; data: Buffer; base?: number; baseOid?: string }[] = [];
    const byOffset = new Map<number, number>();
    let pos = 12, inflated = 0;
    const at = () => (pos < end ? pack[pos++] : fail('protocol'));
    for (let i = 0; i < count; i++) {
        const start = pos;
        let c = at();
        const type = (c >> 4) & 7;
        let size = c & 15, shift = 4;
        while (c & 0x80) { c = at(); size += (c & 0x7f) * 2 ** shift; shift += 7; if (shift > 53) fail('protocol'); }
        if (size > MAX_OBJECT_BYTES) fail('too_large');
        let base: number | undefined, baseOid: string | undefined;
        if (type === 6) {
            c = at();
            let offset = c & 0x7f;
            while (c & 0x80) { c = at(); offset = (offset + 1) * 128 + (c & 0x7f); }
            base = byOffset.get(start - offset);
            if (base === undefined) fail('protocol');
        } else if (type === 7) {
            if (pos + 20 > end) fail('protocol');
            baseOid = pack.toString('hex', pos, pos + 20); pos += 20;
        } else if (type < 1 || type > 4) fail('protocol');
        let result: { buffer: Buffer; engine: { bytesWritten: number } };
        try { result = inflate(pack.subarray(pos, end), { info: true, maxOutputLength: Math.max(size, 1) }); }
        catch { return fail('protocol'); }
        if (result.buffer.length !== size) fail('protocol');
        inflated += size;
        if (inflated > MAX_INFLATED_BYTES) fail('too_large');
        pos += result.engine.bytesWritten;
        byOffset.set(start, i);
        raw.push({ type, data: result.buffer, base, baseOid });
    }
    if (pos !== end) fail('protocol');

    const objects = new Map<string, { type: number; data: Buffer }>();
    const resolved: ({ type: number; data: Buffer } | undefined)[] = new Array(raw.length);
    const finish = (i: number, type: number, data: Buffer) => {
        resolved[i] = { type, data };
        const oid = createHash('sha1').update(`${TYPE_NAMES[type]} ${data.length}\0`).update(data).digest('hex');
        objects.set(oid, resolved[i]!);
        oidIndex.set(oid, i);
    };
    const oidIndex = new Map<string, number>();
    let pending = raw.map((_, i) => i);
    while (pending.length) {
        const next: number[] = [];
        for (const i of pending) {
            const o = raw[i];
            if (o.type <= 4) { finish(i, o.type, o.data); continue; }
            const b = o.type === 6 ? o.base! : oidIndex.get(o.baseOid!);
            const base = b === undefined ? undefined : resolved[b];
            if (!base) { next.push(i); continue; }
            finish(i, base.type, applyDelta(base.data, o.data));
        }
        if (next.length === pending.length) fail('unsupported');
        pending = next;
    }
    return objects;
}

/** The branch tip's tree, flattened in git's order (each directory before its contents). */
export function walkTree(objects: Map<string, { type: number; data: Buffer }>, head: string): GitTreeEntry[] {
    const commit = objects.get(head);
    if (!commit || commit.type !== 1) return fail('protocol');
    const tree = /^tree ([0-9a-f]{40})\n/.exec(commit.data.toString('latin1'));
    if (!tree) fail('protocol');
    const entries: GitTreeEntry[] = [];
    const walk = (oid: string, prefix: string, depth: number) => {
        const object = objects.get(oid);
        if (!object || object.type !== 2 || depth > MAX_TREE_DEPTH) fail('protocol');
        const data = object!.data;
        for (let p = 0; p < data.length;) {
            const space = data.indexOf(0x20, p);
            const nul = data.indexOf(0, space + 1);
            if (space < 0 || nul < 0 || nul + 21 > data.length) fail('protocol');
            const mode = data.toString('latin1', p, space);
            const name = data.toString('utf8', space + 1, nul);
            const child = data.toString('hex', nul + 1, nul + 21);
            p = nul + 21;
            if (!name || name === '.' || name === '..' || name.includes('/') || name.length > 255) fail('protocol');
            const path = prefix ? `${prefix}/${name}` : name;
            if (entries.length >= MAX_TREE_ENTRIES) fail('too_large');
            if (mode === '40000') { entries.push({ path, kind: 'dir', mode }); walk(child, path, depth + 1); }
            else if (mode === '100644' || mode === '100755') {
                const blob = objects.get(child);
                if (!blob || blob.type !== 3) fail('protocol');
                entries.push({ path, kind: 'file', mode, size: blob!.data.length, content: blob!.data });
            } else if (mode === '120000') entries.push({ path, kind: 'symlink', mode });
            else if (mode === '160000') entries.push({ path, kind: 'submodule', mode });
            else fail('unsupported');
        }
    };
    walk(tree![1], '', 0);
    return entries;
}

/** The Authorization header for `request`'s remote, or null for a URL that is neither remote. */
export function gitAuthorization(request: Pick<GitFetchRequest, 'canonicalURL' | 'username' | 'token'>): string | null {
    if (!GIT_TOKEN.test(request.token)) return null;
    if (ARTIFACTS_REPOSITORY.test(request.canonicalURL)) return `Bearer ${request.token}`;
    if (EZIL_GIT_REPOSITORY.test(request.canonicalURL)) return `Basic ${Buffer.from(`${request.username}:${request.token}`, 'utf8').toString('base64')}`;
    return null;
}

/** The default `RepoFetcher`: one branch tip from the project's remote, depth 1, in memory. */
export const fetchRepositoryTree: RepoFetcher = async (request, fetchImpl = fetch) => {
    const authorization = gitAuthorization(request);
    if (authorization === null) return fail('unsupported');
    const base = new URL(request.canonicalURL);
    if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(request.ref)) fail('unsupported');
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const headers = { authorization, 'user-agent': 'git/ezil-os-snapshot' };
    const call = async (url: string, init: RequestInit, contentType: string, max: number) => {
        let response: Response;
        try { response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal }); }
        catch { return fail('transport'); }
        if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); fail('unauthorized'); }
        if (response.status === 404) { void response.body?.cancel().catch(() => {}); fail('not_found'); }
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); fail('transport'); }
        if (response.headers.get('content-type')?.split(';')[0].trim() !== contentType) { void response.body?.cancel().catch(() => {}); fail('protocol'); }
        try { return await readCapped(response, max); } catch (err) { if (err instanceof GitFetchError) throw err; return fail('transport'); }
    };
    const repo = base.toString();
    const advertised = parseAdvertisement(await call(`${repo}/info/refs?service=git-upload-pack`, { method: 'GET', headers },
        'application/x-git-upload-pack-advertisement', MAX_ADVERTISEMENT_BYTES));
    if (!advertised.refs.size) fail('empty_repository');
    const head = advertised.refs.get(request.ref);
    if (!head || !OID.test(head)) return fail('ref_not_found');
    const sideband = advertised.caps.has('side-band-64k') ? 'side-band-64k' : advertised.caps.has('side-band') ? 'side-band' : null;
    const shallow = advertised.caps.has('shallow');
    const caps = [sideband, advertised.caps.has('ofs-delta') ? 'ofs-delta' : null, shallow ? 'shallow' : null,
        advertised.caps.has('no-progress') ? 'no-progress' : null, 'agent=ezil-os-snapshot'].filter(Boolean).join(' ');
    const body = Buffer.concat([pkt(`want ${head} ${caps}\n`), ...(shallow ? [pkt('deepen 1\n')] : []), Buffer.from('0000', 'latin1'), pkt('done\n')]);
    const result = await call(`${repo}/git-upload-pack`, {
        method: 'POST', body: new Uint8Array(body),
        headers: { ...headers, 'content-type': 'application/x-git-upload-pack-request', accept: 'application/x-git-upload-pack-result' },
    }, 'application/x-git-upload-pack-result', MAX_PACK_BYTES);
    const objects = readPack(parseUploadPackResult(result, { shallow, sideband: sideband !== null }));
    return { head, entries: walkTree(objects, head) };
};
