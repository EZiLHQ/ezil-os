import { osActorHeaders } from './os-actor';
import { assignmentAuthority, productionAssignment } from './authority';
import { privateMediaPost } from './private-ingress';
import { eligibleForActor, readOpen, repoOpenSecret, signRepoOpen } from './repo-open';
import { createHash } from 'node:crypto';
import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { boundedJson, checkedPut, clockState, mediaClockDetails, drain, editorReadyClock, eligible, hour, issuer, prepMediaWindow, refuse, started, summary, validAssignmentWindow, type Input } from './contract';

type Identity = Pick<RetainedIdentity, 'token' | 'issuer' | 'subject' | 'sessionId' | 'expiresAt' | 'userId'>;
type ClockWindow = {startedAt: string | null; deadlineAt: string | null; pausedAt?: string | null; revision?: number};
type Capability = {
    recording: string;
    token: string;
    deadline: number;
    startedAt?: number;
    pausedAt?: number;
    revision: number;
    identityExpiresAt: number;
    preparedEnds: Map<number, number>;
    phase?: string;
    seed?: number;
    seedDeadline?: number;
    /** The media window's bound: the hour, or `prepMediaWindow` once Universe's begin said it manages a preparation window. */
    mediaLimit: number;
    /** This process saw this phase's first frame confirmed (or Universe's begin already called the phase ready). */
    seedConfirmed: boolean;
};
type Dependencies = { fetcher?: typeof fetch; clock?: () => number; leases?: Map<string, Capability>; signal?: AbortSignal };
const storage = globalThis as typeof globalThis & { ezilAssignmentMediaLeases?: Map<string, Capability> };
// The same process already holds the verified OS session identity. A process loss requires a new authenticated begin.
// No Works capability, retained ID token, signature, signed URL or storage key is persisted.
const defaults = storage.ezilAssignmentMediaLeases ??= new Map<string, Capability>();
// Order successful capabilities only within the exact lease key. An older HTTP response
// can arrive after its successor already obtained a capability from Universe.
const leaseOrders = new WeakMap<Capability, number>();
let beginOrder = 0;

function syncLeaseClock(entry: Capability, report: ClockWindow) {
    if (report.startedAt === null || report.deadlineAt === null) {
        if (entry.startedAt !== undefined) return refuse('recording_state_changed', 409);
        return;
    }
    const start = Date.parse(report.startedAt), deadline = Date.parse(report.deadlineAt);
    const revision = report.revision ?? 0;
    const pausedAt = report.pausedAt ? Date.parse(report.pausedAt) : undefined;
    if (revision < entry.revision || !validAssignmentWindow(start, deadline, revision, entry.mediaLimit)
        || (entry.startedAt !== undefined && entry.startedAt !== start)
        || (pausedAt !== undefined && !(revision > 0 && start <= pausedAt && pausedAt < deadline))) {
        return refuse('recording_state_changed', 409);
    }
    // A Universe that manages the preparation window sets the media cutoff again once the work clock starts (the
    // signed `editor-ready`, or the end of that window): before any pause it may move either way, always from the
    // same start and inside `prepMediaWindow`. Every other window only moves later, and only with a newer revision.
    const movable = entry.mediaLimit === prepMediaWindow && revision === 0 && entry.revision === 0;
    if (entry.startedAt !== undefined && !movable && (deadline < entry.deadline
        || (revision === entry.revision && (deadline !== entry.deadline || pausedAt !== entry.pausedAt)))) {
        return refuse('recording_state_changed', 409);
    }
    Object.assign(entry, {deadline, startedAt:start, pausedAt, revision});
}

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
    const currentLease = leases.get(key);
    if (currentLease) currentLease.identityExpiresAt = identity.expiresAt;
    // The assignment can be paused beyond the last observed deadline. Expire its lease with the bound OS identity.
    for (const [id, entry] of leases) if (entry.identityExpiresAt <= clock()) leases.delete(id);

    type ProofHeaders = (serialized: string, now: number) => Record<string,string>;
    async function post(url: string, body: object, capability?: string, proofHeaders?: ProofHeaders): Promise<unknown> {
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
                        ...(proofHeaders ? proofHeaders(serialized, clock()) : {})}, body:serialized, signal});
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
    const control = (action: 'preflight'|'begin'|'clock'|'editor-ready'|'status'|'finalize'|'checkpoint',
        fields: object = {}, proofHeaders?: ProofHeaders) =>
        post(authority.universe + '/internal/assignment-video/' + action, {
            userIdToken: identity.token, attemptId: input.attemptId, osSessionId: identity.sessionId, ...fields,
        }, undefined, proofHeaders);
    function openControl(action: 'begin'|'editor-ready', proof: string, fields: object) {
        const secret = repoOpenSecret();
        if (!secret) return refuse('assignment_open_unavailable', 503);
        const repoOpen = readOpen(proof, identity, input.attemptId, clock(), secret);
        return control(action, {...fields, repoOpen}, (serialized, now) => signRepoOpen(secret, action, serialized, now));
    }

    if (input.action === 'preflight') {
        const result = eligible.safeParse(await control('preflight'));
        if (!result.success || !eligibleForActor(result.data, identity, input.attemptId, clock()))
            return refuse('recording_unavailable', 404);
        return result.data;
    }
    if (input.action === 'clock') {
        const result = clockState.safeParse(await control('clock'));
        if (!result.success) return refuse('media_unavailable', 503);
        return result.data;
    }
    if (input.action === 'editor-ready') {
        const lease = leases.get(key);
        if (lease?.mediaLimit === prepMediaWindow) {
            // This call starts the work clock of an attempt whose preparation window Universe manages. It is sent only
            // for the capture this process holds, after its first frame was confirmed, inside its media window.
            if (lease.phase !== input.captureSessionId || !lease.seedConfirmed || lease.deadline <= clock())
                return refuse('recording_phase_changed', 409);
            const answer = await openControl('editor-ready', input.repoOpenProof, {
                captureSessionId:input.captureSessionId,
            });
            // Repeated after a reload, Universe answers the same clock again. One it paused and extended (a revised
            // window, longer than the hour) is production's complete clock and is returned as it is; the bare work
            // clock is bounded by the hour. Either way the window is Universe's own answer, never this caller's.
            const full = clockState.safeParse(answer);
            if (full.success && full.data.startedAt !== null) return full.data;
            const result = editorReadyClock.safeParse(answer);
            if (!result.success) return refuse('media_unavailable', 503);
            return result.data;
        }
        const result = clockState.safeParse(await openControl('editor-ready', input.repoOpenProof, {
            captureSessionId:input.captureSessionId,
        }));
        if (!result.success || result.data.startedAt === null) return refuse('media_unavailable', 503);
        return result.data;
    }
    if (input.action === 'begin') {
        if (authority === productionAssignment && (!input.captureSessionId || input.consentVersion !== 4))
            return refuse('video_consent_required', 409);
        const order = ++beginOrder;
        const requestedPhase = input.captureSessionId;
        const result = started.safeParse(await openControl('begin', input.repoOpenProof, {
            consentAccepted:true, consentVersion:input.consentVersion,
            ...(requestedPhase ? {captureSessionId:requestedPhase} : {}),
        }));
        if (!result.success) return refuse('media_unavailable', 503);
        const {uploadToken, ...receipt} = result.data;
        const provisional = requestedPhase !== undefined && receipt.phaseReady !== true;
        const t0 = receipt.startedAt ? Date.parse(receipt.startedAt) : NaN;
        const authorityEnd = receipt.deadlineAt ? Date.parse(receipt.deadlineAt) : NaN;
        const deadline = provisional && receipt.authorizationExpiresAt ? Date.parse(receipt.authorizationExpiresAt) : authorityEnd;
        const mediaLimit = receipt.editorReadySupported === true ? prepMediaWindow : hour;
        const validWindow = Number.isFinite(t0) && Number.isFinite(authorityEnd) && t0 <= clock()+1500
            && authorityEnd > clock() && validAssignmentWindow(t0, authorityEnd, receipt.revision, mediaLimit);
        if (!uploadToken || receipt.revoked || receipt.pausedAt || receipt.stopRequestedAt !== null || !Number.isFinite(deadline) || deadline <= clock()
            || (requestedPhase && (receipt.captureSessionId !== requestedPhase || receipt.nextSequence === undefined))
            || (provisional ? !['awaiting_frame','recording'].includes(receipt.status) || !receipt.authorizationExpiresAt
                || !(validWindow || (receipt.startedAt === null && receipt.deadlineAt === null))
                : receipt.status !== 'recording' || !validWindow)) return refuse('recording_closed', 409);
        if (!leases.has(key) && leases.size >= 2048) return refuse('media_unavailable', 503);
        const previous = leases.get(key);
        const same = previous?.recording === receipt.recordingId && previous.phase === requestedPhase;
        const entry: Capability = {recording:receipt.recordingId, token:uploadToken, deadline, phase:requestedPhase,
            revision:0, identityExpiresAt:identity.expiresAt, seed:provisional ? receipt.nextSequence : undefined,
            seedDeadline:provisional ? deadline : undefined, mediaLimit,
            seedConfirmed:receipt.phaseReady === true || (same && previous.seedConfirmed),
            preparedEnds:same ? previous.preparedEnds : new Map()};
        if (validWindow) syncLeaseClock(entry, receipt);
        if (same && previous.startedAt !== undefined) syncLeaseClock({...previous}, receipt);
        if (previous && (leaseOrders.get(previous) ?? 0) > order) {
            // A repeat of that same phase may return its receipt without replacing the current capability.
            if (same) return receipt;
            return refuse('recording_phase_changed', 409);
        }
        leaseOrders.set(entry, order);
        leases.set(key, entry);
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
    const entry = leases.get(key);
    if (input.action === 'status') {
        if (entry?.recording === state.recordingId && (state.revision ?? 0) >= entry.revision)
            syncLeaseClock(entry, state);
        // The broker's own clock when Universe names none, so the shell can place the media cutoff it relays.
        return {...state, serverNow:state.serverNow ?? new Date(clock()).toISOString()};
    }
    if (!entry || entry.recording !== state.recordingId)
        return refuse('recording_session_refresh_required', 409);
    syncLeaseClock(entry, state);
    const seed = entry.phase !== undefined && entry.seed === input.sequence;
    const paused = entry.pausedAt !== undefined;
    const draining = paused && input.action === 'confirm' && !seed;
    if ((entry.phase && !seed && !draining && (state.phaseReady !== true || state.workspaceUnlocked !== true))
        || state.revoked || (paused && !draining)
        || (state.status !== 'recording' && !(seed && state.status === 'awaiting_frame')
            && !(draining && state.status === 'paused')))
        return refuse('recording_closed',409);
    const cutoff = Math.min(seed ? entry.seedDeadline ?? entry.deadline : entry.deadline,
        entry.pausedAt ?? Infinity, state.stopRequestedAt ? Date.parse(state.stopRequestedAt) : Infinity);
    const segmentPath = authority.works + '/universe/assignment-media/segments';
    if (input.action === 'confirm') {
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
            const details = mediaClockDetails.safeParse(ready);
            const revision = details.data?.revision ?? (ready.startedAt === state.startedAt && ready.deadlineAt === state.deadlineAt
                ? state.revision : undefined);
            if (ready.phaseReady !== true || ready.captureSessionId !== entry.phase
                || ready.nextSequence !== input.sequence+1 || typeof ready.startedAt !== 'string' || typeof ready.deadlineAt !== 'string'
                || !Number.isFinite(first) || !Number.isFinite(start) || !Number.isFinite(end) || first < start
                || !details.success || details.data.pausedAt || first > now + 1500 || end <= now || end <= first
                || !validAssignmentWindow(start, end, revision, entry.mediaLimit))
                return refuse('seed_not_confirmed',503);
            syncLeaseClock(entry, {startedAt:ready.startedAt,deadlineAt:ready.deadlineAt,revision});
            entry.seedConfirmed = true;
            return {recordingId:state.recordingId,sequence:input.sequence,confirmed:true,phaseReady:true,
                captureSessionId:entry.phase,nextSequence:ready.nextSequence,firstFrameAt:ready.firstFrameAt,
                startedAt:ready.startedAt,deadlineAt:ready.deadlineAt,serverNow:new Date(now).toISOString(),
                ...details.data, ...(revision === undefined ? {} : {revision})};
        }
        return {recordingId: state.recordingId, sequence: input.sequence, confirmed: true};
    }
    const start = state.startedAt ? Date.parse(state.startedAt) : NaN;
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
