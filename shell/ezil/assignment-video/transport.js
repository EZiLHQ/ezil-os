// Same-origin control for the participant-selected top-level OS tab. The opened checkout receives no control capability.
const path = '/api/shell/assignment-video';
const bucket = 'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const failure = (code) => Object.assign(new Error(code), {code});

async function callControl(attemptId, action, fields, fetcher) {
    const response = await fetcher(path, {method: 'POST', credentials: 'same-origin', cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(18000),
        headers: {'Content-Type':'application/json', 'X-Ezil-Assignment-Video':'1'},
        body: JSON.stringify({action,attemptId,...fields})});
    let data;
    try { data = await response.json(); } catch { throw failure('recording_unavailable'); }
    if (!response.ok) {
        const code = data?.error?.code;
        throw failure(typeof code === 'string' && /^[a-z_]{1,55}$/.test(code) ? code : 'recording_unavailable');
    }
    return data;
}

export async function checkAssignmentVideoEligibility(attemptId, {fetcher = globalThis.fetch, clock = Date.now} = {}) {
    if (!uuid.test(attemptId)) throw failure('invalid_assignment');
    const result = await callControl(attemptId, 'preflight', {}, fetcher);
    if (result.status !== 'eligible' || result.attemptId !== attemptId || !Number.isFinite(Date.parse(result.expiresAt))
        || Date.parse(result.expiresAt) <= clock()) throw failure('recording_unavailable');
    return result;
}

export function createAssignmentVideoTransport({attemptId, repoOpenProof, consentVersion, onStop, fetcher = globalThis.fetch,
    clock = Date.now, pollMs = 3000}) {
    if (!uuid.test(attemptId) || typeof repoOpenProof !== 'string' || !/^[A-Za-z0-9_-]{48,1700}$/.test(repoOpenProof) || !Number.isSafeInteger(consentVersion) || consentVersion < 1)
        throw failure('invalid_assignment');
    let recording, poll, expiry, disposed = false, stopped = false, misses = 0;
    function clearTimers() { clearTimeout(poll); clearTimeout(expiry); }
    function stop(reason) {
        if (stopped || disposed) return;
        stopped = true;
        clearTimers();
        if (typeof onStop === 'function') onStop(reason);
    }
    async function control(action, fields = {}) {
        if (disposed) throw failure('transport_disposed');
        return callControl(attemptId, action, fields, fetcher);
    }
    async function status() {
        const data = await control('status');
        if (!recording || data.recordingId !== recording.recordingId) throw failure('recording_changed');
        if (data.revoked || data.stopRequestedAt || data.status !== 'recording')
            stop(['submitted','timeout','stopped'].includes(data.stopReason) ? data.stopReason : 'stopped');
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
        const deadline = Date.parse(data.deadlineAt);
        if (!uuid.test(data.recordingId) || data.status !== 'recording' || !Number.isFinite(deadline) || deadline <= clock()
            || (recording && recording.recordingId !== data.recordingId)) throw failure('recording_changed');
        recording = data;
        clearTimers();
        expiry = setTimeout(() => stop('timeout'), Math.min(3600000, deadline-clock()));
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
        const put = await fetcher(address.href, {method:'PUT', credentials:'omit', redirect:'error', referrerPolicy:'no-referrer',
            cache:'no-store', signal:AbortSignal.timeout(30000), headers:signed.headers, body:blob});
        // A retried conditional PUT may report precondition failure after the first succeeded. Confirm authenticates its bytes.
        if (!put.ok && put.status !== 412) throw failure('upload_failed');
        const result = await control('confirm', {sequence});
        if (!result.confirmed || result.recordingId !== recording.recordingId || result.sequence !== sequence)
            throw failure('upload_unconfirmed');
        return result;
    }
    async function finalize({reason,expectedSegments}) {
        if (!recording || disposed) throw failure('recording_unavailable');
        stopped = true; clearTimers();
        return control('finalize',{reason,expectedSegments});
    }
    function dispose() { disposed = true; clearTimers(); recording = null; }
    return {preflight, begin, status, upload, finalize, dispose};
}
