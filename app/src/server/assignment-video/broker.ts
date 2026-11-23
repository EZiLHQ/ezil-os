import { osActorHeaders } from './os-actor';
import { assignmentAuthority, productionAssignment } from './authority';
import { privateMediaPost } from './private-ingress';
import { eligibleForActor, readOpen, repoOpenSecret, signBegin } from './repo-open';
import { createHash } from 'node:crypto';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { boundedJson, checkedPut, drain, eligible, hour, issuer, refuse, started, summary, type Input } from './contract';

type Identity = Pick<RetainedIdentity, 'token' | 'issuer' | 'subject' | 'sessionId' | 'expiresAt' | 'userId'>;
type Capability = { recording: string; token: string; deadline: number; preparedEnds: Map<number, number>; phase?: string; seed?: number };
type Dependencies = { fetcher?: typeof fetch; clock?: () => number; leases?: Map<string, Capability>; signal?: AbortSignal };
const storage = globalThis as typeof globalThis & { ezilAssignmentMediaLeases?: Map<string, Capability> };
// The same process already holds the verified OS session identity. A process loss requires a new authenticated begin.
// No Works capability, retained ID token, signature, signed URL or storage key is persisted.
const defaults = storage.ezilAssignmentMediaLeases ??= new Map<string, Capability>();

export function recordingAction(identity: Identity, input: Extract<Input, {action: 'preflight'}>, deps?: Dependencies):
    Promise<ReturnType<typeof eligible.parse>>;
export function recordingAction(identity: Identity, input: Input, deps?: Dependencies): Promise<Record<string, unknown>>;
export async function recordingAction(identity: Identity, input: Input, deps: Dependencies = {}) {
    const authority = assignmentAuthority();
    if (!authority) return refuse('recording_unavailable', 404);
    const clock = deps.clock ?? Date.now;
    const fetcher = deps.fetcher ?? fetch;
    const leases = deps.leases ?? defaults;
    if (identity.issuer !== issuer || !identity.token || !identity.userId || !identity.sessionId || !identity.subject
        || identity.expiresAt <= clock()) return refuse('identity_refresh_required', 401);
    const key = createHash('sha256').update(JSON.stringify([authority.os, identity.userId, identity.subject, identity.sessionId, input.attemptId])).digest('hex');
    for (const [id, entry] of leases) if (entry.deadline + drain < clock()) leases.delete(id);

    async function post(url: string, body: object, capability?: string, beginSecret?: string): Promise<unknown> {
        const serialized = JSON.stringify(body);
        const timeout = AbortSignal.timeout(12000);
        let response: Response;
        try {
            const signal = deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout;
            const pem = process.env.UNIVERSE_ASSIGNMENT_API_CA_PEM;
            if (capability && authority === productionAssignment && pem) {
                response = await privateMediaPost(url, serialized, capability, pem, signal);
            } else {
                response = await fetcher(url, {method:'POST', redirect:'error', cache:'no-store',
                    headers:{'content-type':'application/json', accept:'application/json',
                        ...(capability ? {authorization:'Bearer ' + capability} : {}),
                        ...(!capability && authority === productionAssignment ? osActorHeaders(identity,url,input.attemptId,serialized,clock()) : {}),
                        ...(beginSecret ? signBegin(beginSecret, serialized, clock()) : {})}, body:serialized, signal});
            }
        } catch { return refuse('media_unavailable', 503); }
        if (!response.ok) {
            void response.body?.cancel().catch(() => {});
            if (response.status === 401 || response.status === 403 || response.status === 404) return refuse('recording_unavailable', 404);
            if (response.status === 409 || response.status === 429) return refuse('recording_refused', response.status);
            return refuse('media_unavailable', 503);
        }
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) return refuse('media_unavailable', 503);
        return boundedJson(response.body, 262144, 503);
    }
    const control = (action: 'preflight'|'begin'|'status'|'finalize'|'checkpoint', fields: object = {}, beginSecret?: string) =>
        post(authority.universe + '/internal/assignment-video/' + action, {
            userIdToken: identity.token, attemptId: input.attemptId, osSessionId: identity.sessionId, ...fields,
        }, undefined, beginSecret);

    if (input.action === 'preflight') {
        const result = eligible.safeParse(await control('preflight'));
        if (!result.success || !eligibleForActor(result.data, identity, input.attemptId, clock()))
            return refuse('recording_unavailable', 404);
        return result.data;
    }
    if (input.action === 'begin') {
        if (authority === productionAssignment && (!input.captureSessionId || input.consentVersion !== 4))
            return refuse('video_consent_required', 409);
        const secret = repoOpenSecret();
        if (!secret) return refuse('assignment_open_unavailable', 503);
        const repoOpen = readOpen(input.repoOpenProof, identity, input.attemptId, clock(), secret);
        const requestedPhase = input.captureSessionId;
        const result = started.safeParse(await control('begin', {consentAccepted: true, consentVersion: input.consentVersion, repoOpen,
            ...(requestedPhase ? {captureSessionId:requestedPhase} : {})}, secret));
        if (!result.success) return refuse('media_unavailable', 503);
        const {uploadToken, ...receipt} = result.data;
        const provisional = requestedPhase !== undefined && receipt.phaseReady !== true;
        const t0 = receipt.startedAt ? Date.parse(receipt.startedAt) : NaN;
        const authorityEnd = receipt.deadlineAt ? Date.parse(receipt.deadlineAt) : NaN;
        const deadline = provisional && receipt.authorizationExpiresAt ? Date.parse(receipt.authorizationExpiresAt) : authorityEnd;
        const validWindow = Number.isFinite(t0) && Number.isFinite(authorityEnd) && t0 <= clock()+1500
            && authorityEnd > clock() && authorityEnd-t0 <= hour && authorityEnd > t0;
        if (!uploadToken || receipt.revoked || receipt.stopRequestedAt !== null || !Number.isFinite(deadline) || deadline <= clock()
            || (requestedPhase && (receipt.captureSessionId !== requestedPhase || receipt.nextSequence === undefined))
            || (provisional ? !['awaiting_frame','recording'].includes(receipt.status) || !receipt.authorizationExpiresAt
                || !(validWindow || (receipt.startedAt === null && receipt.deadlineAt === null))
                : receipt.status !== 'recording' || !validWindow)) return refuse('recording_closed', 409);
        if (!leases.has(key) && leases.size >= 2048) return refuse('media_unavailable', 503);
        const previous = leases.get(key);
        const same = previous?.recording === receipt.recordingId && previous.phase === requestedPhase;
        leases.set(key, {recording:receipt.recordingId, token:uploadToken, deadline, phase:requestedPhase,
            seed:provisional ? receipt.nextSequence : undefined, preparedEnds:same ? previous.preparedEnds : new Map()});
        return receipt;
    }

    const phase = input.captureSessionId ? {captureSessionId:input.captureSessionId} : {};
    const held = leases.get(key);
    if (held?.phase && held.phase !== input.captureSessionId) return refuse('recording_phase_changed',409);
    if (input.action === 'checkpoint') {
        const result = summary.safeParse(await control('checkpoint', {...phase,reason:input.reason}));
        if (!result.success || result.data.captureSessionId !== input.captureSessionId) return refuse('media_unavailable',503);
        if (leases.get(key)?.phase === input.captureSessionId) leases.delete(key);
        return result.data;
    }
    if (input.action === 'finalize') {
        // Universe accepts a submitted stop only after the normal assignment submission succeeds.
        const result = summary.safeParse(await control('finalize', {...phase,reason: input.reason, expectedSegments: input.expectedSegments}));
        if (!result.success) return refuse('media_unavailable', 503);
        if (result.data.status !== 'recording') leases.delete(key);
        return result.data;
    }

    const parsed = summary.safeParse(await control('status',phase));
    if (!parsed.success) return refuse('media_unavailable', 503);
    const state = parsed.data;
    if (input.captureSessionId && state.captureSessionId !== input.captureSessionId) return refuse('recording_phase_changed',409);
    if (input.action === 'status') return state;
    const entry = leases.get(key);
    if (!entry || entry.recording !== state.recordingId)
        return refuse('recording_session_refresh_required', 409);
    const seed = entry.phase !== undefined && entry.seed === input.sequence;
    if ((entry.phase && !seed && (state.phaseReady !== true || state.workspaceUnlocked !== true))
        || state.revoked || (state.status !== 'recording' && !(seed && state.status === 'awaiting_frame')))
        return refuse('recording_closed',409);
    if (state.deadlineAt && !seed) entry.deadline = Date.parse(state.deadlineAt);
    const segmentPath = authority.works + '/universe/assignment-media/segments';
    if (input.action === 'confirm') {
        const cutoff = Math.min(entry.deadline, state.stopRequestedAt ? Date.parse(state.stopRequestedAt) : entry.deadline);
        if (clock() > cutoff + drain) return refuse('recording_closed', 409);
        const preparedEnd = entry.preparedEnds.get(input.sequence);
        if (preparedEnd === undefined || preparedEnd > cutoff) return refuse('segment_outside_recording', 409);
        const value = await post(segmentPath + '/confirm', {recordingId: state.recordingId, sequence: input.sequence}, entry.token);
        if (!value || typeof value !== 'object' || !('recordingId' in value) || value.recordingId !== state.recordingId
            || !('sequence' in value) || value.sequence !== input.sequence || !('confirmed' in value) || value.confirmed !== true)
            return refuse('media_unavailable', 503);
        if (seed) {
            const ready = value as Record<string,unknown>;
            const now = clock();
            const first = typeof ready.firstFrameAt === 'string' ? Date.parse(ready.firstFrameAt) : NaN;
            const start = typeof ready.startedAt === 'string' ? Date.parse(ready.startedAt) : NaN;
            const end = typeof ready.deadlineAt === 'string' ? Date.parse(ready.deadlineAt) : NaN;
            if (ready.phaseReady !== true || ready.captureSessionId !== entry.phase
                || ready.nextSequence !== input.sequence+1 || typeof ready.startedAt !== 'string' || typeof ready.deadlineAt !== 'string'
                || !Number.isFinite(first) || !Number.isFinite(start) || !Number.isFinite(end) || first < start
                || first > now + 1500 || end <= now || end <= first || end - start > hour)
                return refuse('seed_not_confirmed',503);
            entry.deadline = end;
            return {recordingId:state.recordingId,sequence:input.sequence,confirmed:true,phaseReady:true,
                captureSessionId:entry.phase,nextSequence:ready.nextSequence,firstFrameAt:ready.firstFrameAt,
                startedAt:ready.startedAt,deadlineAt:ready.deadlineAt,serverNow:new Date(now).toISOString()};
        }
        return {recordingId: state.recordingId, sequence: input.sequence, confirmed: true};
    }
    const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
    const cutoff = Math.min(entry.deadline, state.stopRequestedAt ? Date.parse(state.stopRequestedAt) : entry.deadline);
    if (clock() > cutoff + drain || input.endMs <= input.startMs || input.endMs - input.startMs > 60000
        || (seed ? input.startMs !== 0 || input.endMs !== 1 || input.byteLength > 1024*1024 || clock() >= cutoff
            : !Number.isFinite(start) || start + input.endMs > Math.min(clock(), cutoff))) return refuse('segment_outside_recording', 409);
    const {sequence, sha256, byteLength, mimeType, startMs, endMs} = input;
    const signed = await post(segmentPath, {recordingId: state.recordingId, sequence, sha256, byteLength,
        mimeType, startMs, endMs}, entry.token);
    const put = checkedPut(signed, identity.subject, state.recordingId, input, clock(), authority);
    entry.preparedEnds.set(input.sequence, seed ? clock() : start + input.endMs);
    return put;
}
