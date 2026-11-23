import { createHash } from 'node:crypto';
import { z } from 'zod';

export const osOrigin = 'https://os-staging.ezil.work';
export const universeOrigin = 'https://universe-staging.ezil.work';
export const worksOrigin = 'https://api-staging.ezil.work';
export const objectOrigin = 'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
export const issuer = 'https://id.ezil.work/';
export const hour = 3_600_000;
export const drain = 90_000;
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const sequence = integer(0, 599);
const base = { attemptId: uuid };
const phase = {captureSessionId: uuid.optional()};
export const reason = z.enum(['stopped', 'submitted', 'timeout']);
const segment = {
    sequence, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: integer(1, 8 * 1024 * 1024),
    mimeType: z.literal('video/webm'), startMs: integer(0, hour), endMs: integer(1, hour),
};
export const requestSchema = z.discriminatedUnion('action', [
    z.object({ ...base, ...phase, action: z.literal('begin'), repoOpenProof: z.string().regex(/^[A-Za-z0-9_-]{48,1700}$/), consentAccepted: z.literal(true), consentVersion: integer(1, 2147483647) }).strict(),
    z.object({ ...base, action: z.literal('preflight') }).strict(),
    z.object({ ...base, ...phase, action: z.literal('status') }).strict(),
    z.object({ ...base, ...phase, action: z.literal('prepare'), ...segment }).strict(),
    z.object({ ...base, ...phase, action: z.literal('confirm'), sequence }).strict(),
    z.object({ ...base, action: z.literal('checkpoint'), captureSessionId: uuid, reason: z.enum(['sharing_stopped','connection_lost']) }).strict(),
    z.object({ ...base, ...phase, action: z.literal('finalize'), reason, expectedSegments: integer(0, 600) }).strict(),
]);
export type Input = z.infer<typeof requestSchema>;
export type Prepare = Extract<Input, { action: 'prepare' }>;
const moment = z.string().datetime({offset: true});
export const eligible = z.object({status: z.literal('eligible'), attemptId: uuid,
    jobId: z.string().regex(/^[1-9][0-9]{0,18}$/), expiresAt: moment, windowStartedAt: moment.nullable(), deadlineAt: moment.nullable(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), repositoryUrl: z.string().max(260), providerId: z.string().regex(/^[a-z0-9]{1,64}$/), ref: z.literal('refs/heads/main')});
const control = {
    recordingId: uuid, status: z.enum(['awaiting_frame','paused','recording', 'empty', 'partial', 'complete']),
    startedAt: moment.nullable(), deadlineAt: moment.nullable(),
    captureSessionId: uuid.optional(), repositoryOpenReceiptId: uuid.optional(), nextSequence: integer(0,600).optional(),
    authorizationExpiresAt: moment.nullable().optional(), phaseReady: z.boolean().optional(), workspaceUnlocked: z.boolean().optional(),
    stopRequestedAt: moment.nullable(), revoked: z.boolean(),
    stopReason: reason.nullable().optional(),
};
export const summary = z.object({
    ...control, confirmedSegments: integer(0, 600).optional(),
    firstFrameAt: moment.nullable().optional(), lastFrameAt: moment.nullable().optional(),
});
export const started = z.object({ ...control, firstFrameAt: moment.nullable().optional(), uploadToken: z.string().min(16).max(2048).regex(/^[A-Za-z0-9._~-]+$/).optional() });
export class BrokerError extends Error {
    constructor(readonly code: string, readonly status: number) { super(code); }
}
export function refuse(code: string, status: number): never { throw new BrokerError(code, status); }

export async function boundedJson(stream: ReadableStream<Uint8Array> | null, limit: number, status: number): Promise<unknown> {
    if (!stream) return refuse('invalid_payload', status);
    const reader = stream.getReader();
    const parts = [];
    let size = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if ((size += value.byteLength) > limit) return refuse('invalid_payload', status);
            parts.push(Buffer.from(value));
        }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch { return refuse('invalid_payload', status); }
    finally { void reader.cancel().catch(() => {}); }
}

export function checkedPut(value: unknown, subject: string, recordingId: string, part: Prepare, now: number) {
    const schema = z.object({ putUrl: z.string().max(16384), expiresAt: moment, headers: z.object({
        'content-type': z.literal('video/webm'), 'if-none-match': z.literal('*'),
        'x-amz-server-side-encryption': z.literal('AES256'), 'x-amz-checksum-sha256': z.string(),
    }).strict() });
    const result = schema.safeParse(value);
    if (!result.success) return refuse('media_unavailable', 503);
    const out = result.data;
    let url;
    try { url = new URL(out.putUrl); } catch { return refuse('media_unavailable', 503); }
    const owner = createHash('sha256').update(issuer).update('\0').update(subject).digest('hex');
    const path = '/universe-staging/assignment-media/v1/' + [owner, part.attemptId, recordingId, 'segments', part.sequence, part.sha256 + '.webm'].join('/');
    const exp = Date.parse(out.expiresAt);
    const signedHeaders = ['content-length', 'content-type', 'host', 'if-none-match',
        'x-amz-checksum-sha256', 'x-amz-server-side-encryption'].join(';');
    const ttl = url.searchParams.get('X-Amz-Expires') ?? '';
    if (url.origin !== objectOrigin || url.pathname !== path || url.username || url.password || url.hash
        || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
        || !/^[a-f0-9]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '')
        || !/^[1-9][0-9]{0,2}$/.test(ttl) || Number(ttl) > 300
        || url.searchParams.get('X-Amz-SignedHeaders') !== signedHeaders
        || exp <= now || exp > now + 305000
        || out.headers['x-amz-checksum-sha256'] !== Buffer.from(part.sha256, 'hex').toString('base64'))
        return refuse('media_unavailable', 503);
    return out;
}
