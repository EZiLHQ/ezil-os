import { timingSafeEqual } from 'node:crypto';
import { CANCELLATION_AUTHORITY_PATH, CancellationAuthorityRequestSchema, CancellationAuthoritySecretSchema,
    CancellationAuthorityScopeSchema, cancellationAuthoritySignature, type CancellationAuthorityRequest,
    type CancellationAuthorityScope } from './cancellation-authority-protocol';

const MAX_BODY = 4096;
const response = (status: number, code: string) => Response.json({ code }, { status, headers: { 'cache-control': 'no-store' } });
const fresh = (timestamp: string) => Math.abs(Date.now() / 1000 - Number(timestamp)) <= 30;
async function boundedBody(request: Request): Promise<Buffer> {
    const reader = request.body?.getReader();
    if (!reader) throw new Error('invalid_body');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => {};
    try {
        if (request.signal.aborted) throw new Error('invalid_body');
        const interrupted = new Promise<never>((_resolve, reject) => {
            cancel = () => { reject(new Error('invalid_body')); void reader.cancel().catch(() => {}); };
            timer = setTimeout(cancel, 5000); request.signal.addEventListener('abort', cancel, { once: true });
        });
        return await Promise.race([interrupted, (async () => {
            const chunks: Uint8Array[] = []; let length = 0;
            for (;;) {
                const item = await reader.read(); if (item.done) break;
                length += item.value.byteLength; if (length > MAX_BODY) throw new Error('invalid_body');
                chunks.push(item.value);
            }
            return Buffer.concat(chunks);
        })()]);
    } finally {
        clearTimeout(timer); request.signal.removeEventListener('abort', cancel);
        void reader.cancel().catch(() => {}); reader.releaseLock();
    }
}

/** A fresh signed request rechecks immutable cancellation and pending source
 * state. No cookie/bearer fallback and no provider side effects. */
export function createCancellationAuthorityHandler(options: {
    enabled: boolean; secret?: string;
    authorize(input: CancellationAuthorityRequest): Promise<CancellationAuthorityScope | null>;
}) {
    return async (request: Request): Promise<Response> => {
        if (!options.enabled) return response(404, 'not_found');
        if (!CancellationAuthoritySecretSchema.safeParse(options.secret).success) return response(503, 'cancellation_authority_unavailable');
        const url = new URL(request.url);
        if (url.pathname !== CANCELLATION_AUTHORITY_PATH || url.search || url.hash) return response(404, 'not_found');
        if (request.method !== 'POST') return response(405, 'method_not_allowed');
        const timestamp = request.headers.get('x-ezil-workflow-timestamp') ?? '', signature = request.headers.get('x-ezil-workflow-signature') ?? '';
        if (!/^[0-9]{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature) || !fresh(timestamp)) return response(401, 'unauthorized');
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '') || request.headers.has('content-encoding')) {
            return response(415, 'unsupported_media_type');
        }
        const length = request.headers.get('content-length');
        if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY)) return response(413, 'body_too_large');
        let body: Buffer;
        try { body = await boundedBody(request); } catch { return response(400, 'invalid_request'); }
        if (!fresh(timestamp)) return response(401, 'unauthorized');
        const expected = cancellationAuthoritySignature(body, options.secret!, timestamp);
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return response(401, 'unauthorized');
        let input: unknown;
        try { input = JSON.parse(body.toString()); } catch { return response(400, 'invalid_request'); }
        const parsed = CancellationAuthorityRequestSchema.safeParse(input);
        if (!parsed.success) return response(400, 'invalid_request');
        try {
            if (request.signal.aborted) return response(400, 'invalid_request');
            const scope = CancellationAuthorityScopeSchema.safeParse(await options.authorize(parsed.data));
            if (request.signal.aborted) return response(400, 'invalid_request');
            if (!fresh(timestamp)) return response(401, 'unauthorized');
            if (!scope.success) return response(403, 'cancellation_not_current');
            return Response.json({ authorized: true, ...parsed.data, ...scope.data }, { headers: { 'cache-control': 'no-store' } });
        } catch { return response(503, 'cancellation_authority_unavailable'); }
    };
}
