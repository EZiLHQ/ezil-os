import { eligibleForActor, readOpen, repoOpenSecret, signBegin } from './repo-open';
import { createHash } from 'node:crypto';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { boundedJson, checkedPut, drain, eligible, hour, issuer, refuse, started, summary, universeOrigin, worksOrigin, type Input } from './contract';

type Identity = Pick<RetainedIdentity, 'token' | 'issuer' | 'subject' | 'sessionId' | 'expiresAt' | 'userId'>;
type Capability = { recording: string; token: string; deadline: number };
type Dependencies = { fetcher?: typeof fetch; clock?: () => number; leases?: Map<string, Capability>; signal?: AbortSignal };
const storage = globalThis as typeof globalThis & { ezilAssignmentMediaLeases?: Map<string, Capability> };
// The same process already holds the verified OS session identity. A process loss requires a new authenticated begin.
// No Works capability, retained ID token, signature, signed URL or storage key is persisted.
const defaults = storage.ezilAssignmentMediaLeases ??= new Map<string, Capability>();

export function recordingAction(identity: Identity, input: Extract<Input, {action: 'preflight'}>, deps?: Dependencies):
    Promise<ReturnType<typeof eligible.parse>>;
export function recordingAction(identity: Identity, input: Input, deps?: Dependencies): Promise<Record<string, unknown>>;
export async function recordingAction(identity: Identity, input: Input, deps: Dependencies = {}) {
    const clock = deps.clock ?? Date.now;
    const fetcher = deps.fetcher ?? fetch;
    const leases = deps.leases ?? defaults;
    if (identity.issuer !== issuer || !identity.token || !identity.userId || !identity.sessionId || !identity.subject
        || identity.expiresAt <= clock()) return refuse('identity_refresh_required', 401);
    const key = createHash('sha256').update(JSON.stringify([identity.userId, identity.subject, identity.sessionId, input.attemptId])).digest('hex');
    for (const [id, entry] of leases) if (entry.deadline + drain < clock()) leases.delete(id);

    async function post(url: string, body: object, capability?: string, beginSecret?: string): Promise<unknown> {
        const serialized = JSON.stringify(body);
        const timeout = AbortSignal.timeout(12000);
        let response: Response;
        try {
            response = await fetcher(url, {method: 'POST', redirect: 'error', cache: 'no-store',
                headers: {'content-type':'application/json', accept:'application/json',
                    ...(capability ? {authorization: 'Bearer ' + capability} : {}),
                    ...(beginSecret ? signBegin(beginSecret, serialized, clock()) : {})}, body: serialized,
                signal: deps.signal ? AbortSignal.any([timeout, deps.signal]) : timeout});
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
    const control = (action: 'preflight'|'begin'|'status'|'finalize', fields: object = {}, beginSecret?: string) =>
        post(universeOrigin + '/internal/assignment-video/' + action, {
            userIdToken: identity.token, attemptId: input.attemptId, osSessionId: identity.sessionId, ...fields,
        }, undefined, beginSecret);

    if (input.action === 'preflight') {
        const result = eligible.safeParse(await control('preflight'));
        if (!result.success || !eligibleForActor(result.data, identity, input.attemptId, clock()))
            return refuse('recording_unavailable', 404);
        return result.data;
    }
    if (input.action === 'begin') {
        const secret = repoOpenSecret();
        if (!secret) return refuse('assignment_open_unavailable', 503);
        const repoOpen = readOpen(input.repoOpenProof, identity, input.attemptId, clock(), secret);
        const result = started.safeParse(await control('begin', {consentAccepted: true, consentVersion: input.consentVersion, repoOpen}, secret));
        if (!result.success) return refuse('media_unavailable', 503);
        const {uploadToken, ...receipt} = result.data;
        const t0 = Date.parse(receipt.startedAt), deadline = Date.parse(receipt.deadlineAt);
        if (!uploadToken || receipt.status !== 'recording' || receipt.revoked || receipt.stopRequestedAt !== null
            || t0 > clock() + 1500 || deadline <= clock() || deadline <= t0 || deadline - t0 > hour) {
            leases.delete(key);
            return refuse('recording_closed', 409);
        }
        if (!leases.has(key) && leases.size >= 2048) return refuse('media_unavailable', 503);
        leases.set(key, {recording: receipt.recordingId, token: uploadToken, deadline});
        return receipt;
    }

    if (input.action === 'finalize') {
        // Universe accepts a submitted stop only after the normal assignment submission succeeds.
        const result = summary.safeParse(await control('finalize', {reason: input.reason, expectedSegments: input.expectedSegments}));
        if (!result.success) return refuse('media_unavailable', 503);
        if (result.data.status !== 'recording') leases.delete(key);
        return result.data;
    }

    const parsed = summary.safeParse(await control('status'));
    if (!parsed.success) return refuse('media_unavailable', 503);
    const state = parsed.data;
    if (input.action === 'status') return state;
    const entry = leases.get(key);
    if (!entry || entry.recording !== state.recordingId || entry.deadline !== Date.parse(state.deadlineAt))
        return refuse('recording_session_refresh_required', 409);
    if (state.status !== 'recording' || state.revoked) return refuse('recording_closed', 409);
    const segmentPath = worksOrigin + '/universe/assignment-media/segments';
    if (input.action === 'confirm') {
        const cutoff = Math.min(entry.deadline, state.stopRequestedAt ? Date.parse(state.stopRequestedAt) : entry.deadline);
        if (clock() > cutoff + drain) return refuse('recording_closed', 409);
        const value = await post(segmentPath + '/confirm', {recordingId: state.recordingId, sequence: input.sequence}, entry.token);
        if (!value || typeof value !== 'object' || !('recordingId' in value) || value.recordingId !== state.recordingId
            || !('sequence' in value) || value.sequence !== input.sequence || !('confirmed' in value) || value.confirmed !== true)
            return refuse('media_unavailable', 503);
        return {recordingId: state.recordingId, sequence: input.sequence, confirmed: true};
    }
    const start = Date.parse(state.startedAt);
    const cutoff = Math.min(entry.deadline, state.stopRequestedAt ? Date.parse(state.stopRequestedAt) : entry.deadline);
    if (clock() > cutoff + drain || input.endMs <= input.startMs || input.endMs - input.startMs > 60000
        || start + input.endMs > Math.min(clock() + 1500, cutoff)) return refuse('segment_outside_recording', 409);
    const {sequence, sha256, byteLength, mimeType, startMs, endMs} = input;
    const signed = await post(segmentPath, {recordingId: state.recordingId, sequence, sha256, byteLength,
        mimeType, startMs, endMs}, entry.token);
    return checkedPut(signed, identity.subject, state.recordingId, input, clock());
}
