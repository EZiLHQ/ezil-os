import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ComputerMountWorkSchema, type ComputerMountWork } from './computer-mount-protocol';

export const MOUNT_AUTHORITY_PATH = '/api/internal/computers/mount-authority';
const validSecret = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const fresh = (timestamp: string) => Math.abs(Date.now() / 1000 - Number(timestamp)) <= 30;
const response = (status: number, code: string) => Response.json({ code }, { status, headers: { 'cache-control': 'no-store' } });
export function mountAuthoritySignature(body: Uint8Array, secret: string, timestamp: string): string {
    if (!validSecret(secret) || !/^[0-9]{10}$/.test(timestamp)) throw new Error('mount_authority_signing_invalid');
    return createHmac('sha256', Buffer.from(secret, 'hex')).update(['ezil-mount-authority-v1', 'POST', MOUNT_AUTHORITY_PATH,
        timestamp, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
}

async function bounded<T>(signal: AbortSignal, milliseconds: number, operation: () => Promise<T>, cancel = () => {}) {
    let timer: ReturnType<typeof setTimeout> | undefined, abort = () => {};
    try {
        if (signal.aborted) throw new Error('mount_authority_interrupted');
        const interrupted = new Promise<never>((_resolve, reject) => {
            abort = () => { reject(new Error('mount_authority_interrupted')); cancel(); };
            signal.addEventListener('abort', abort, { once: true }); timer = setTimeout(abort, milliseconds);
        });
        return await Promise.race([interrupted, operation()]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}
async function bodyOf(request: Request): Promise<Buffer> {
    const reader = request.body?.getReader(); if (!reader) throw new Error('invalid_body');
    try {
        return await bounded(request.signal, 5000, async () => {
            const chunks: Uint8Array[] = []; let size = 0;
            for (;;) {
                const item = await reader.read(); if (item.done) break;
                size += item.value.byteLength; if (size > 16384) throw new Error('invalid_body'); chunks.push(item.value);
            }
            return Buffer.concat(chunks);
        }, () => { void reader.cancel().catch(() => {}); });
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** A signed, point-in-time DB check; fresh replays recheck revocation. It never
 * issues a grant, starts compute, mounts a disk or substitutes for the workflow's
 * provider checks. Supabase cookies/bearers confer no authority on this path. */
export function createMountAuthorityHandler(o: {
    enabled: boolean; secret?: string | undefined; authorize(work: ComputerMountWork): Promise<boolean>;
}) {
    return async (request: Request): Promise<Response> => {
        if (!o.enabled) return response(404, 'not_found');
        if (!validSecret(o.secret)) return response(503, 'mount_authority_unavailable');
        const url = new URL(request.url);
        if (url.pathname !== MOUNT_AUTHORITY_PATH || url.search || url.hash) return response(404, 'not_found');
        if (request.method !== 'POST') return response(405, 'method_not_allowed');
        const timestamp = request.headers.get('x-ezil-workflow-timestamp') ?? '', signature = request.headers.get('x-ezil-workflow-signature') ?? '';
        if (!/^[0-9]{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || !fresh(timestamp)) return response(401, 'unauthorized');
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
            || request.headers.has('content-encoding')) return response(415, 'unsupported_media_type');
        const length = request.headers.get('content-length');
        if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > 16384)) return response(413, 'body_too_large');
        let body: Buffer;
        try { body = await bodyOf(request); } catch { return response(400, 'invalid_request'); }
        if (!fresh(timestamp)) return response(401, 'unauthorized');
        const expected = mountAuthoritySignature(body, o.secret, timestamp);
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return response(401, 'unauthorized');
        let input: unknown;
        try { input = JSON.parse(body.toString()); } catch { return response(400, 'invalid_request'); }
        const parsed = ComputerMountWorkSchema.safeParse(input);
        if (!parsed.success) return response(400, 'invalid_request');
        try {
            // The authority implementation is read-only. Timeout/abort cannot
            // convert a later answer into an HTTP success or a reusable grant.
            const authorized = await bounded(request.signal, 15000, () => o.authorize(structuredClone(parsed.data)));
            if (request.signal.aborted || !o.enabled) return response(403, 'mount_not_current');
            if (!fresh(timestamp)) return response(401, 'unauthorized');
            if (authorized !== true) return response(403, 'mount_not_current');
            return Response.json({ authorized: true, work: parsed.data }, { headers: { 'cache-control': 'no-store' } });
        } catch { return response(503, 'mount_authority_unavailable'); }
    };
}
