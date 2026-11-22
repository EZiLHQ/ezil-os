import 'server-only';

import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

import { gitAuthorization, parseAdvertisement, type GitTreeEntry } from '@/server/works/git-smart-http';

/**
 * The first commit of a newly created assignment repository: exactly two literal files, pushed once over smart HTTP
 * with the participant's own short-lived gateway grant, and only onto an empty repository.
 *
 * - The push names the all-zero old value for `refs/heads/main`, so git itself refuses it if the branch appeared in
 *   the meantime: a retry or a concurrent tab can never overwrite anything.
 * - Nothing here decides the starting SHA. The caller reads the branch back (`fetchRepositoryTree`) and accepts it only
 *   when the tree is exactly `bootstrapFiles(repositoryUrl)`; `assignmentManifest` is computed from what was read.
 * - The grant travels only in the Authorization header (`gitAuthorization`), never in a URL, error or log line.
 */
export const BOOTSTRAP_REF = 'refs/heads/main';
export const MARKER_PATH = '.ezil/assignment.json';
export const README_PATH = 'README.md';
export const MARKER_NOTICE = 'Do not edit, modify, or delete this assignment marker. EZiL Code records disclosed assignment activity '
    + 'and shows recording status. Interruptions may affect submission.';

const ZERO = '0'.repeat(40);
const AUTHOR = 'EZiL OS <noreply@ezil.work>';
const TIMEOUT_MS = 20_000;
const MAX_RESULT_BYTES = 16_384;

export type BootstrapErrorCode = 'not_empty' | 'unauthorized' | 'rejected' | 'transport' | 'protocol';
export class BootstrapError extends Error {
    constructor(readonly code: BootstrapErrorCode) { super(`assignment_bootstrap_${code}`); }
}
const fail = (code: BootstrapErrorCode): never => { throw new BootstrapError(code); };

/**
 * C1 marker: compact UTF-8 JSON with exactly these keys in this order, then one LF. Universe verifies the same bytes.
 */
export function assignmentMarker(repositoryUrl: string): string {
    return `${JSON.stringify({ schema: 'ezil.assignment/v1', recorder: 'assignment-recorder-v1', repositoryUrl, consentVersion: 3, notice: MARKER_NOTICE })}\n`;
}

/** The only content a bootstrapped assignment repository may hold. */
export function bootstrapFiles(repositoryUrl: string): ReadonlyMap<string, string> {
    return new Map([
        [MARKER_PATH, assignmentMarker(repositoryUrl)],
        [README_PATH, '# EZiL assignment\n\nThis repository holds an EZiL assignment. Keep `.ezil/assignment.json` unchanged.\n'],
    ]);
}

/**
 * `assignmentManifestSha256`: sha256 of the marker file's raw bytes (LF included). Null unless the read-back tree is
 * exactly the bootstrap files: regular, non-executable, literal contents, no other entry.
 */
export function assignmentManifest(repositoryUrl: string, entries: readonly GitTreeEntry[]): string | null {
    const expected = bootstrapFiles(repositoryUrl);
    const files = entries.filter(entry => entry.kind !== 'dir');
    const dirs = entries.filter(entry => entry.kind === 'dir').map(entry => entry.path);
    if (files.length !== expected.size || dirs.some(dir => dir !== '.ezil')) return null;
    for (const file of files) {
        const literal = expected.get(file.path);
        if (file.kind !== 'file' || file.mode !== '100644' || literal === undefined || !file.content
            || Buffer.compare(Buffer.from(file.content), Buffer.from(literal, 'utf8')) !== 0) return null;
    }
    return createHash('sha256').update(expected.get(MARKER_PATH)!, 'utf8').digest('hex');
}

const TYPES = { commit: 1, tree: 2, blob: 3 } as const;
type GitObject = { type: keyof typeof TYPES; data: Buffer; id: string };
const object = (type: GitObject['type'], data: Buffer): GitObject =>
    ({ type, data, id: createHash('sha1').update(`${type} ${data.length}\0`).update(data).digest('hex') });
const tree = (entries: Array<[mode: string, name: string, id: string]>) =>
    object('tree', Buffer.concat(entries.map(([mode, name, id]) => Buffer.concat([Buffer.from(`${mode} ${name}\0`, 'utf8'), Buffer.from(id, 'hex')]))));

/** The bootstrap commit and every object it needs, in pack order. */
export function bootstrapObjects(repositoryUrl: string, attemptId: string, epochSeconds: number): { commit: string; objects: GitObject[] } {
    const files = bootstrapFiles(repositoryUrl);
    const marker = object('blob', Buffer.from(files.get(MARKER_PATH)!, 'utf8'));
    const readme = object('blob', Buffer.from(files.get(README_PATH)!, 'utf8'));
    const ezil = tree([['100644', 'assignment.json', marker.id]]);
    // Git orders a tree's entries by name, a subtree compared as `<name>/`: `.ezil/` sorts before `README.md`.
    const root = tree([['40000', '.ezil', ezil.id], ['100644', 'README.md', readme.id]]);
    const stamp = `${AUTHOR} ${Math.floor(epochSeconds)} +0000`;
    const commit = object('commit', Buffer.from(`tree ${root.id}\nauthor ${stamp}\ncommitter ${stamp}\n\nInitialize EZiL assignment ${attemptId}\n`, 'utf8'));
    return { commit: commit.id, objects: [commit, root, ezil, marker, readme] };
}

/** A version 2 pack of whole (undeltified) objects. */
export function packObjects(objects: readonly GitObject[]): Buffer {
    const header = Buffer.alloc(12);
    header.write('PACK', 0, 'latin1');
    header.writeUInt32BE(2, 4);
    header.writeUInt32BE(objects.length, 8);
    const parts: Buffer[] = [header];
    for (const { type, data } of objects) {
        let size = data.length;
        const bytes = [(TYPES[type] << 4) | (size & 0x0f)];
        size >>= 4;
        while (size > 0) { bytes[bytes.length - 1] |= 0x80; bytes.push(size & 0x7f); size >>= 7; }
        parts.push(Buffer.from(bytes), deflateSync(data));
    }
    const body = Buffer.concat(parts);
    return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

const pkt = (line: string) => {
    const data = Buffer.from(line, 'utf8');
    return Buffer.concat([Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'latin1'), data]);
};

async function capped(response: Response): Promise<Buffer> {
    const reader = response.body?.getReader();
    if (!reader) return Buffer.alloc(0);
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_RESULT_BYTES) fail('protocol');
            chunks.push(value);
        }
    } finally { void reader.cancel().catch(() => {}); }
    return Buffer.concat(chunks);
}

export interface BootstrapRequest {
    canonicalURL: string;
    attemptId: string;
    username: string;
    token: string;
    signal?: AbortSignal;
    now?: () => number;
}

/** Push the bootstrap commit onto an empty repository. Resolves with the commit id git was asked to create. */
export async function pushAssignmentBootstrap(request: BootstrapRequest, fetchImpl: typeof fetch = fetch): Promise<string> {
    const authorization = gitAuthorization(request);
    if (authorization === null || !authorization.startsWith('Basic ')) return fail('protocol');
    const signal = request.signal ? AbortSignal.any([request.signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);
    const headers = { authorization, 'user-agent': 'git/ezil-os-assignment' };
    const call = async (url: string, init: RequestInit, contentType: string) => {
        let response: Response;
        try { response = await fetchImpl(url, { ...init, redirect: 'error', cache: 'no-store', signal }); }
        catch { return fail('transport'); }
        if (response.status === 401 || response.status === 403) { void response.body?.cancel().catch(() => {}); fail('unauthorized'); }
        if (response.status !== 200) { void response.body?.cancel().catch(() => {}); fail('transport'); }
        if (response.headers.get('content-type')?.split(';')[0]!.trim() !== contentType) { void response.body?.cancel().catch(() => {}); fail('protocol'); }
        try { return await capped(response); } catch (error) { if (error instanceof BootstrapError) throw error; return fail('transport'); }
    };
    const repo = new URL(request.canonicalURL).toString();
    let advertised: ReturnType<typeof parseAdvertisement>;
    const ad = await call(`${repo}/info/refs?service=git-receive-pack`, { method: 'GET', headers }, 'application/x-git-receive-pack-advertisement');
    try { advertised = parseAdvertisement(ad); } catch { return fail('protocol'); }
    if (advertised.refs.size) return fail('not_empty');
    const { commit, objects } = bootstrapObjects(request.canonicalURL, request.attemptId, (request.now ?? Date.now)() / 1000);
    const status = advertised.caps.has('report-status');
    const caps = [status ? 'report-status' : null, 'agent=ezil-os-assignment'].filter(Boolean).join(' ');
    const body = Buffer.concat([pkt(`${ZERO} ${commit} ${BOOTSTRAP_REF}\0${caps}\n`), Buffer.from('0000', 'latin1'), packObjects(objects)]);
    const result = await call(`${repo}/git-receive-pack`, {
        method: 'POST', body: new Uint8Array(body),
        headers: { ...headers, 'content-type': 'application/x-git-receive-pack-request', accept: 'application/x-git-receive-pack-result' },
    }, 'application/x-git-receive-pack-result');
    if (status) {
        const lines = result.toString('utf8');
        if (!lines.includes('unpack ok\n') || !lines.includes(`ok ${BOOTSTRAP_REF}\n`)) fail('rejected');
    }
    return commit;
}
