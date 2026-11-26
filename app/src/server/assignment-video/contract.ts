import { createHash } from 'node:crypto';
import { z } from 'zod';

import { stageAssignment, productionAssignment } from './authority';

export const {os:osOrigin, universe:universeOrigin, works:worksOrigin, storage:objectOrigin} = stageAssignment;
export const issuer = 'https://id.ezil.work/';
export const hour = 3_600_000;
export const prepMediaWindow = hour + 240_000;
export const drain = 90_000;
// Recording offsets are backed by integers in the evidence ledger.
const maxElapsed = 2_147_483_647;
/** `limit`: the bound before any pause. The hour, or `prepMediaWindow` for the media window of a managed preparation. */
export function validAssignmentWindow(start: number, deadline: number, revision = 0, limit = hour): boolean {
    const duration = deadline - start;
    return duration > 0 && duration <= (revision > 0 ? maxElapsed : limit);
}
export const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const integer = (min: number, max: number) => z.number().int().min(min).max(max);
const sequence = integer(0, 599);
const base = { attemptId: uuid };
const phase = {captureSessionId: uuid.optional()};
const repoOpenProof = z.string().regex(/^[A-Za-z0-9_-]{48,1700}$/);
export const reason = z.enum(['stopped', 'submitted', 'timeout']);
const segment = {
    sequence, sha256: z.string().regex(/^[a-f0-9]{64}$/), byteLength: integer(1, 8 * 1024 * 1024),
    mimeType: z.literal('video/webm'), startMs: integer(0, maxElapsed - 1), endMs: integer(1, maxElapsed),
};
export const requestSchema = z.discriminatedUnion('action', [
    z.object({ ...base, ...phase, action: z.literal('begin'), repoOpenProof, consentAccepted: z.literal(true), consentVersion: integer(1, 2147483647) }).strict(),
    z.object({ ...base, action: z.literal('preflight') }).strict(),
    z.object({ ...base, action: z.literal('clock') }).strict(),
    z.object({ ...base, action: z.literal('editor-ready'), captureSessionId: uuid,
        repoOpenProof }).strict(),
    z.object({ ...base, ...phase, action: z.literal('status') }).strict(),
    z.object({ ...base, ...phase, action: z.literal('prepare'), ...segment }).strict(),
    z.object({ ...base, ...phase, action: z.literal('confirm'), sequence }).strict(),
    z.object({ ...base, action: z.literal('checkpoint'), captureSessionId: uuid, reason: z.enum(['sharing_stopped','connection_lost']) }).strict(),
    z.object({ ...base, ...phase, action: z.literal('finalize'), reason, expectedSegments: integer(0, 600) }).strict(),
]);
export type Input = z.infer<typeof requestSchema>;
export type Prepare = Extract<Input, { action: 'prepare' }>;
const moment = z.string().datetime({offset: true});
export const clockDetails = z.object({
    serverNow: moment,
    pausedAt: moment.nullable(),
    pauseReason: z.string().min(1).max(128).nullable(),
    remainingMs: integer(0, hour).nullable(),
    revision: integer(0, Number.MAX_SAFE_INTEGER),
});
export const mediaClockDetails = clockDetails.partial().extend({workStartedAt: moment.nullable().optional()});
const optionalClock = mediaClockDetails.shape;
export const clockState = clockDetails.extend({
    startedAt: moment.nullable(),
    deadlineAt: moment.nullable(),
}).refine(state => {
    if (state.startedAt === null || state.deadlineAt === null)
        return state.startedAt === null && state.deadlineAt === null && state.pausedAt === null
            && state.pauseReason === null && state.remainingMs === null;
    const start = Date.parse(state.startedAt), end = Date.parse(state.deadlineAt);
    if (!validAssignmentWindow(start, end, state.revision) || state.remainingMs === null) return false;
    if (state.pausedAt === null) return state.pauseReason === null;
    const pause = Date.parse(state.pausedAt);
    return state.revision > 0 && start <= pause && pause < end
        && pause <= Date.parse(state.serverNow) && state.pauseReason !== null;
});
/**
 * The bare work clock a Universe that manages a preparation window (`editorReadySupported`) may answer `editor-ready`
 * with: it starts at that signed call, or at the end of the preparation window, and is never longer than the hour.
 * A clock the server paused and extended is longer than that, and is accepted only as the complete `clockState`
 * above (its revision, pause and remaining time all stated), never from these three fields.
 */
export const editorReadyClock = z.object({
    startedAt: moment, deadlineAt: moment, serverNow: moment,
}).refine(clock => {
    const start = Date.parse(clock.startedAt);
    const end = Date.parse(clock.deadlineAt);
    return end > start && end - start <= hour && start <= Date.parse(clock.serverNow) + 1500;
});
export const eligible = z.object({...optionalClock, status: z.literal('eligible'), attemptId: uuid,
    jobId: z.string().regex(/^[1-9][0-9]{0,18}$/), expiresAt: moment, windowStartedAt: moment.nullable(), deadlineAt: moment.nullable(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/), repositoryUrl: z.string().max(260), providerId: z.string().regex(/^[a-z0-9]{1,64}$/), ref: z.literal('refs/heads/main'),
    upgradedWorkspaceId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    upgradeOperationId: uuid.optional(),
    /** Direct AWS: the workspace Universe bound for this attempt (64-hex), or null before its first opening. Absent from an older Universe. */
    boundWorkspaceId: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
    /**
     * Exactly `'workspace'`, from a Universe that started this attempt's window itself, in its own workspace page, before
     * any computer opened it: the one case in which a window that is already running has no bound workspace yet. Absent
     * otherwise (and from an older Universe); any other value is not a preflight this OS understands.
     */
    startMode: z.literal('workspace').optional(),
    /**
     * True only from a Universe that manages this attempt's preparation window: the media window may then run up to
     * `prepMediaWindow`, and the work clock starts at the signed `editor-ready` call. Absent from an older Universe,
     * whose editor is released as before.
     */
    editorReadySupported: z.boolean().optional(),
}).refine(state => (state.upgradedWorkspaceId !== undefined) === (state.upgradeOperationId !== undefined));
const control = {
    ...optionalClock,
    recordingId: uuid, status: z.enum(['awaiting_frame','paused','recording', 'empty', 'partial', 'complete']),
    startedAt: moment.nullable(), deadlineAt: moment.nullable(),
    captureSessionId: uuid.optional(), repositoryOpenReceiptId: uuid.optional(), nextSequence: integer(0,600).optional(),
    authorizationExpiresAt: moment.nullable().optional(), editorReadySupported: z.boolean().optional(),
    phaseReady: z.boolean().optional(), workspaceUnlocked: z.boolean().optional(),
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

export function checkedPut(value: unknown, subject: string, recordingId: string, part: Prepare, now: number, authority: typeof stageAssignment | typeof productionAssignment = stageAssignment) {
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
    const path = authority.prefix + [owner, part.attemptId, recordingId, 'segments', part.sequence, part.sha256 + '.webm'].join('/');
    const exp = Date.parse(out.expiresAt);
    const signedHeaders = ['content-length', 'content-type', 'host', 'if-none-match',
        'x-amz-checksum-sha256', 'x-amz-server-side-encryption'].join(';');
    const ttl = url.searchParams.get('X-Amz-Expires') ?? '';
    if (url.origin !== authority.storage || url.pathname !== path || url.username || url.password || url.hash
        || url.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256'
        || !/^[a-f0-9]{64}$/.test(url.searchParams.get('X-Amz-Signature') ?? '')
        || !/^[1-9][0-9]{0,2}$/.test(ttl) || Number(ttl) > 300
        || url.searchParams.get('X-Amz-SignedHeaders') !== signedHeaders
        || exp <= now || exp > now + 305000
        || out.headers['x-amz-checksum-sha256'] !== Buffer.from(part.sha256, 'hex').toString('base64'))
        return refuse('media_unavailable', 503);
    return out;
}
