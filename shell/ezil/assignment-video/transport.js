// Same-origin control for the participant-selected EZiL OS assignment tab.
const path = '/api/shell/assignment-video';
const buckets = new Map([
    ['https://os-staging.ezil.work', ['https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com', '/universe-staging/assignment-media/v1/']],
    ['https://os.ezil.work', ['https://ezil-universe-production-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com', '/universe-production/assignment-media/v1/']],
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (code) => Object.assign(new Error(code), {code});

async function callControl(attemptId, action, fields, fetcher, repositoryUrl) {
    let response;
    try { response = await fetcher(path, {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(18000),
        headers: {'Content-Type':'application/json', 'X-Ezil-Assignment-Video':'1',
            ...(repositoryUrl ? {'X-Ezil-Assignment-Repository':repositoryUrl} : {})},
        body: JSON.stringify({action,attemptId,...fields})}); }
    catch {throw failure('media_unavailable');}
    let data;
    try { data = await response.json(); } catch { throw failure('recording_unavailable'); }
    if (!response.ok) {
        const code = data?.error?.code;
        if(response.status===401 && code==='UNAUTHORIZED' && data.error.reason==='session_missing')throw failure('identity_refresh_required');
        throw failure(typeof code === 'string' && /^[a-z_]{1,55}$/.test(code) ? code : 'recording_unavailable');
    }
    return data;
}

export async function checkAssignmentVideoEligibility(attemptId, {repositoryUrl, fetcher = globalThis.fetch, clock = Date.now} = {}) {
    if (!uuid.test(attemptId)) throw failure('invalid_assignment');
    const result = await callControl(attemptId, 'preflight', {}, fetcher, repositoryUrl);
    if (result.status !== 'eligible' || result.attemptId !== attemptId || !Number.isFinite(Date.parse(result.expiresAt))
        || Date.parse(result.expiresAt) <= clock()) throw failure('recording_unavailable');
    return result;
}

/** A report of the recording's own media window: the answers that carry `deadlineAt` (begin, the seed's confirm, status). It is not the countdown. */
const hasClock = data => data && typeof data === 'object' && typeof data.deadlineAt === 'string';

/**
 * The assignment's server clock (`{serverNow, startedAt, deadlineAt, pausedAt, pauseReason, remainingMs, revision}`,
 * nullable before the clock starts). Needs no capture lease, so it answers after a refresh and after a share stops.
 */
export async function checkAssignmentClock(attemptId, {fetcher = globalThis.fetch} = {}) {
    if (!uuid.test(attemptId)) throw failure('invalid_assignment');
    const result = await callControl(attemptId, 'clock', {}, fetcher);
    if (!result || typeof result !== 'object' || !Number.isSafeInteger(result.revision)) throw failure('recording_unavailable');
    return result;
}

/** The longest a segment's end may be: an hour, or the span the server's clock now allows once it has given paused time back. */
const HOUR = 3600000;
/**
 * The media window's bound once Universe's signed preflight says it manages this attempt's preparation window
 * (`editorReadySupported`): recording starts in that window, and the work hour starts at `editor-ready` or at its end.
 */
const PREP_MEDIA_MS = HOUR + 240000;

export function createAssignmentVideoTransport({attemptId, repoOpenProof, consentVersion, captureSessionId, onStop, onClock, maxEndMs = () => HOUR, paused = () => false, fetcher = globalThis.fetch,
    clock = Date.now, pollMs = 3000}) {
    if (!uuid.test(attemptId) || (captureSessionId && !uuid.test(captureSessionId)) || typeof repoOpenProof !== 'string' || !/^[A-Za-z0-9_-]{48,1700}$/.test(repoOpenProof) || !Number.isSafeInteger(consentVersion) || consentVersion < 1)
        throw failure('invalid_assignment');
    let recording, poll, expiry, disposed = false, stopped = false, misses = 0;
    let mediaLimit = HOUR;
    function clearTimers() { clearTimeout(poll); clearTimeout(expiry); }
    // While the server's clock is paused its deadline is not running down: the local copy waits instead of ending the share.
    function expire(reason, at) {
        if (disposed || stopped) return;
        if (paused()) { expiry = setTimeout(() => expire(reason, at), pollMs); return; }
        stop(reason, at);
    }
    function stop(reason, effectiveAt = null) {
        if (stopped || disposed) return;
        stopped = true;
        clearTimers();
        if (typeof onStop === 'function') onStop(reason, effectiveAt);
    }
    async function control(action, fields = {}) {
        if (disposed) throw failure('transport_disposed');
        return callControl(attemptId, action, {...(captureSessionId ? {captureSessionId} : {}),...fields}, fetcher);
    }
    async function status() {
        const data = await control('status');
        if (!recording || data.recordingId !== recording.recordingId) throw failure('recording_changed');
        if (captureSessionId && data.captureSessionId !== captureSessionId) throw failure('recording_phase_changed');
        // A server-declared system pause (it names its cause) is a running share with a stopped clock, not an end.
        const systemPause = data.status === 'paused' && (typeof data.pauseReason === 'string' || typeof data.pausedAt === 'string');
        if (hasClock(data) && typeof onClock === 'function') onClock(data);
        // A later deadline (the server gave back time it stopped for a system interruption) moves the local expiry with it.
        const later = Date.parse(data.deadlineAt);
        if (!stopped && !disposed && Number.isFinite(later) && later > Date.parse(recording.deadlineAt) && later - clock() <= mediaLimit + 1500) {
            recording = {...recording, deadlineAt: data.deadlineAt};
            clearTimeout(expiry);
            expiry = setTimeout(() => expire('timeout', recording.deadlineAt), later - clock());
        }
        if (data.revoked || data.stopRequestedAt || (data.status !== 'recording' && !systemPause && !(captureSessionId && data.status === 'awaiting_frame'))) {
            const why = ['submitted','timeout','stopped'].includes(data.stopReason) ? data.stopReason : 'stopped';
            const cutoff = data.stopRequestedAt ?? (why === 'timeout' ? recording.deadlineAt : null);
            stop(why, typeof cutoff === 'string' && Number.isFinite(Date.parse(cutoff)) ? cutoff : null);
        }
        // A managed preparation sets its media cutoff again when the work clock starts. Before any pause it may move
        // either way, from the same start and inside the bound; a revised (paused) window keeps the rule above.
        if (!stopped && !disposed && mediaLimit === PREP_MEDIA_MS && recording.phaseReady && data.phaseReady && !(data.revision > 0))
            applyPreparedDeadline(data);
        return data;
    }
    function applyPreparedDeadline(data) {
        const start = Date.parse(data.startedAt);
        const end = Date.parse(data.deadlineAt);
        const reportedNow = Date.parse(data.serverNow);
        const remaining = end - (Number.isFinite(reportedNow) ? reportedNow : clock());
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > mediaLimit
            || recording.startedAt !== data.startedAt || remaining > mediaLimit + 1500) throw failure('recording_changed');
        if (remaining <= 0) { stop('timeout', data.deadlineAt); return; }
        if (recording.deadlineAt === data.deadlineAt) return;
        recording = {...recording, deadlineAt: data.deadlineAt};
        clearTimeout(expiry);
        expiry = setTimeout(() => expire('timeout', recording.deadlineAt), remaining);
    }
    async function watch() {
        if (disposed || stopped) return;
        try { await status(); misses = 0; }
        catch { if (++misses >= 2) stop('unavailable'); }
        if (!disposed && !stopped) poll = setTimeout(watch, pollMs);
    }
    /**
     * The validated interactive assigned editor is open: Universe starts (or resumes) the canonical countdown from it and
     * answers with its clock. The browser sends no time, only the attempt, this capture phase and its open proof.
     *
     * For a managed preparation this call starts the work hour, so it is sent only for a live capture whose first frame
     * is confirmed, and its answer must be a clock: a start not after the server's own time and at most the hour.
     */
    async function editorReady() {
        if (!recording || disposed) throw failure('recording_unavailable');
        const managed = mediaLimit === PREP_MEDIA_MS;
        if (managed && (!recording.phaseReady || !captureSessionId || stopped)) throw failure('recording_unavailable');
        const data = await control('editor-ready', {repoOpenProof});
        if (!data || typeof data !== 'object') throw failure('recording_unavailable');
        if (!managed) {
            if (!Number.isSafeInteger(data.revision)) throw failure('recording_unavailable');
            return data;
        }
        if (stopped || disposed) throw failure('recording_unavailable');
        const start = Date.parse(data.startedAt), end = Date.parse(data.deadlineAt), now = Date.parse(data.serverNow);
        // Longer than the hour only as a revised clock: one the server paused and gave time back to.
        const revised = Number.isSafeInteger(data.revision) && data.revision > 0;
        if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(now) || end <= start
            || (!revised && end - start > HOUR) || start > now + 1500) throw failure('media_unavailable');
        return data;
    }
    async function preflight() {
        if (disposed) throw failure('transport_disposed');
        return checkAssignmentVideoEligibility(attemptId, {fetcher, clock});
    }
    async function begin() {
        if (stopped || disposed) throw failure('recording_closed');
        // Only Universe's own signed preflight widens the media bound; without its flag the bound is the hour.
        const eligibility = await preflight();
        mediaLimit = eligibility.editorReadySupported === true ? PREP_MEDIA_MS : HOUR;
        const data = await control('begin', {consentAccepted:true,consentVersion,repoOpenProof});
        const provisional = captureSessionId && data.status === 'awaiting_frame';
        const deadline = Date.parse(provisional ? data.authorizationExpiresAt : data.deadlineAt);
        if (!uuid.test(data.recordingId) || (!provisional && data.status !== 'recording') || (captureSessionId && (data.captureSessionId !== captureSessionId || !Number.isSafeInteger(data.nextSequence))) || !Number.isFinite(deadline) || deadline <= clock()
            || (recording && recording.recordingId !== data.recordingId)) throw failure('recording_changed');
        recording = data;
        clearTimers();
        expiry = setTimeout(() => expire(provisional?'unavailable':'timeout', data.deadlineAt), Math.min(mediaLimit, deadline-clock()));
        poll = setTimeout(watch, pollMs);
        return data;
    }
    async function upload({sequence, startMs, endMs, mimeType, bytes}) {
        if (!recording || disposed) throw failure('recording_unavailable');
        const blob = bytes instanceof Blob ? bytes : new Blob([bytes], {type:'video/webm'});
        if (mimeType !== 'video/webm' || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 600
            || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs
            || startMs < 0 || endMs > Math.max(mediaLimit, maxEndMs()) || endMs-startMs > 60000 || !blob.size || blob.size > 8*1024*1024)
            throw failure('invalid_segment');
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
        const signed = await control('prepare', {sequence,startMs,endMs,mimeType,byteLength:blob.size,sha256});
        const address = new URL(signed.putUrl);
        const target = buckets.get(globalThis.location?.origin);
        if (!target || address.origin !== target[0] || !address.pathname.startsWith(target[1]) || address.username || address.password || address.hash
            || !address.pathname.endsWith('/'+attemptId+'/'+recording.recordingId+'/segments/'+sequence+'/'+sha256+'.webm'))
            throw failure('invalid_upload_target');
        let put;
        try{put = await fetcher(address.href, {method:'PUT', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
            cache:'no-store', signal:AbortSignal.timeout(30000), headers:signed.headers, body:blob});}catch{throw failure('upload_failed');}
        // A retried conditional PUT may report precondition failure after the first succeeded. Confirm authenticates its bytes.
        if (!put.ok && put.status !== 412) throw failure('upload_failed');
        const result = await control('confirm', {sequence});
        if (!result.confirmed || result.recordingId !== recording.recordingId || result.sequence !== sequence)
            throw failure('upload_unconfirmed');
        if (result.phaseReady && captureSessionId && result.captureSessionId === captureSessionId) {
            const end=Date.parse(result.deadlineAt),serverNow=Date.parse(result.serverNow);
            const remaining=end-(Number.isFinite(serverNow)?serverNow:clock());
            if (!Number.isFinite(end) || remaining<=0 || remaining>mediaLimit+1500) throw failure('recording_changed');
            recording={...recording,phaseReady:true,startedAt:result.startedAt,deadlineAt:result.deadlineAt};
            if (typeof onClock === 'function') onClock(result);
            clearTimeout(expiry); expiry=setTimeout(()=>expire('timeout',recording.deadlineAt),remaining);
        }
        return result;
    }
    async function checkpoint(reason) {
        if (!recording || disposed || !captureSessionId) throw failure('recording_unavailable');
        stopped=true; clearTimers();
        return control('checkpoint',{reason});
    }
    async function finalize({reason,expectedSegments}) {
        if (!recording || disposed) throw failure('recording_unavailable');
        stopped = true; clearTimers();
        return control('finalize',{reason,expectedSegments});
    }
    function checkpointOnExit(reason) {
        if (!recording || disposed || !captureSessionId) return;
        // Closing a document cannot promise to flush an unconfirmed tail. Preserve already accepted clips.
        void fetcher(path,{method:'POST',credentials:'same-origin',redirect:'error',cache:'no-store',keepalive:true,
            headers:{'Content-Type':'application/json','X-Ezil-Assignment-Video':'1'},
            body:JSON.stringify({action:'checkpoint',attemptId,captureSessionId,reason})}).catch(()=>{});
    }
    function dispose() { disposed = true; clearTimers(); recording = null; }
    return {preflight, begin, status, editorReady, upload, checkpoint, checkpointOnExit, finalize, dispose};
}
