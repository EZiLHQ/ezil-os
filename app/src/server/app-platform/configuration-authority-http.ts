import { timingSafeEqual } from 'node:crypto';
import { CONFIGURATION_AUTHORITY_PATH, ConfigurationAuthorityRequestSchema, ConfigurationAuthoritySecretSchema,
    configurationAuthoritySignature, type ConfigurationAuthorityRequest } from './configuration-authority-protocol';

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
            timer = setTimeout(cancel, 5000);
            request.signal.addEventListener('abort', cancel, { once: true });
        });
        return await Promise.race([interrupted, (async () => {
            const chunks: Uint8Array[] = []; let length = 0;
            for (;;) {
                const item = await reader.read(); if (item.done) break;
                length += item.value.byteLength;
                if (length > MAX_BODY) throw new Error('invalid_body');
                chunks.push(item.value);
            }
            return Buffer.concat(chunks);
        })()]);
    } finally {
        clearTimeout(timer); request.signal.removeEventListener('abort', cancel);
        void reader.cancel().catch(() => {}); reader.releaseLock();
    }
}

/** No user-session or bearer fallback. Replaying a fresh signed check repeats
 * current database validation, including revocation; responses are not reusable
 * credentials. This endpoint only refreshes desired metadata, never sends a
 * provider command or marks an installation/loaded receipt successful. */
export function createConfigurationAuthorityHandler(options: {
    enabled: boolean; secret?: string | undefined;
    authorize(input: ConfigurationAuthorityRequest): Promise<boolean>;
}) {
    return async (request: Request): Promise<Response> => {
        if (!options.enabled) return response(404, 'not_found');
        if (!ConfigurationAuthoritySecretSchema.safeParse(options.secret).success) return response(503, 'configuration_authority_unavailable');
        const url = new URL(request.url);
        if (url.pathname !== CONFIGURATION_AUTHORITY_PATH || url.search || url.hash) return response(404, 'not_found');
        if (request.method !== 'POST') return response(405, 'method_not_allowed');
        const timestamp = request.headers.get('x-ezil-workflow-timestamp') ?? '';
        const signature = request.headers.get('x-ezil-workflow-signature') ?? '';
        if (!/^[0-9]{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)
            || !fresh(timestamp)) return response(401, 'unauthorized');
        if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') ?? '')
            || request.headers.has('content-encoding')) return response(415, 'unsupported_media_type');
        const length = request.headers.get('content-length');
        if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY)) return response(413, 'body_too_large');
        let body: Buffer;
        try { body = await boundedBody(request); } catch { return response(400, 'invalid_request'); }
        if (!fresh(timestamp)) return response(401, 'unauthorized');
        const expected = configurationAuthoritySignature(body, options.secret!, timestamp);
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'))) return response(401, 'unauthorized');
        let input: unknown;
        try { input = JSON.parse(body.toString()); } catch { return response(400, 'invalid_request'); }
        const parsed = ConfigurationAuthorityRequestSchema.safeParse(input);
        if (!parsed.success) return response(400, 'invalid_request');
        try {
            if (request.signal.aborted) return response(400, 'invalid_request');
            const authorized = await options.authorize(parsed.data);
            if (request.signal.aborted) return response(400, 'invalid_request');
            if (!fresh(timestamp)) return response(401, 'unauthorized');
            if (authorized !== true) return response(403, 'configuration_not_current');
            return Response.json({ authorized: true, ...parsed.data }, { headers: { 'cache-control': 'no-store' } });
        } catch { return response(503, 'configuration_authority_unavailable'); }
    };
}
