// Same-origin OS control for the participant-selected Universe work tab. The opened checkout receives no control capability.
const path = '/api/shell/assignment-video';
const bucket = 'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
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

export function createAssignmentVideoTransport({attemptId, repoOpenProof, consentVersion, captureSessionId, onStop, fetcher = globalThis.fetch,
    clock = Date.now, pollMs = 3000}) {
    if (!uuid.test(attemptId) || (captureSessionId && !uuid.test(captureSessionId)) || typeof repoOpenProof !== 'string' || !/^[A-Za-z0-9_-]{48,1700}$/.test(repoOpenProof) || !Number.isSafeInteger(consentVersion) || consentVersion < 1)
        throw failure('invalid_assignment');
    let recording, poll, expiry, disposed = false, stopped = false, misses = 0;
    function clearTimers() { clearTimeout(poll); clearTimeout(expiry); }
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
        if (data.revoked || data.stopRequestedAt || (data.status !== 'recording' && !(captureSessionId && data.status === 'awaiting_frame'))) {
            const why = ['submitted','timeout','stopped'].includes(data.stopReason) ? data.stopReason : 'stopped';
            const cutoff = data.stopRequestedAt ?? (why === 'timeout' ? recording.deadlineAt : null);
            stop(why, typeof cutoff === 'string' && Number.isFinite(Date.parse(cutoff)) ? cutoff : null);
        }
        return data;
    }
    async function watch() {
        if (disposed || stopped) return;
        try { await status(); misses = 0; }
        catch { if (++misses >= 2) stop('unavailable'); }
        if (!disposed && !stopped) poll = setTimeout(watch, pollMs);
    }
    async function preflight() {
        if (disposed) throw failure('transport_disposed');
        return checkAssignmentVideoEligibility(attemptId, {fetcher, clock});
    }
    async function begin() {
        if (stopped || disposed) throw failure('recording_closed');
        await preflight();
        const data = await control('begin', {consentAccepted:true,consentVersion,repoOpenProof});
        const provisional = captureSessionId && data.status === 'awaiting_frame';
        const deadline = Date.parse(provisional ? data.authorizationExpiresAt : data.deadlineAt);
        if (!uuid.test(data.recordingId) || (!provisional && data.status !== 'recording') || (captureSessionId && (data.captureSessionId !== captureSessionId || !Number.isSafeInteger(data.nextSequence))) || !Number.isFinite(deadline) || deadline <= clock()
            || (recording && recording.recordingId !== data.recordingId)) throw failure('recording_changed');
        recording = data;
        clearTimers();
        expiry = setTimeout(() => stop(provisional?'unavailable':'timeout', data.deadlineAt), Math.min(3600000, deadline-clock()));
        poll = setTimeout(watch, pollMs);
        return data;
    }
    async function upload({sequence, startMs, endMs, mimeType, bytes}) {
        if (!recording || disposed) throw failure('recording_unavailable');
        const blob = bytes instanceof Blob ? bytes : new Blob([bytes], {type:'video/webm'});
        if (mimeType !== 'video/webm' || !Number.isSafeInteger(sequence) || sequence < 0 || sequence >= 600
            || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs
            || startMs < 0 || endMs > 3600000 || endMs-startMs > 60000 || !blob.size || blob.size > 8*1024*1024)
            throw failure('invalid_segment');
        const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
        const sha256 = Array.from(new Uint8Array(digest), n => n.toString(16).padStart(2,'0')).join('');
        const signed = await control('prepare', {sequence,startMs,endMs,mimeType,byteLength:blob.size,sha256});
        const address = new URL(signed.putUrl);
        if (address.origin !== bucket || address.username || address.password || address.hash
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
            if (!Number.isFinite(end) || remaining<=0 || remaining>3600000+1500) throw failure('recording_changed');
            recording={...recording,startedAt:result.startedAt,deadlineAt:result.deadlineAt};
            clearTimeout(expiry); expiry=setTimeout(()=>stop('timeout',recording.deadlineAt),remaining);
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
    return {preflight, begin, status, upload, checkpoint, checkpointOnExit, finalize, dispose};
}
