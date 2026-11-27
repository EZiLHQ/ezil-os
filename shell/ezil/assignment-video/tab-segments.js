import {createVP8Muxer} from './vp8-webm.js';

/**
 * `play()` on a capture track can stay pending (an ended or stopped share). Bounded like the frame wait after it, so a
 * share can never hang on it: it rejects `no_current_frame`, the same as a tab that presents no frame.
 */
export function playWithin(video, ms, timers = globalThis, signal) {
    let timer, cancelled;
    return Promise.race([Promise.resolve().then(() => {
        if (signal?.aborted) throw new Error('cancelled');
        return video.play();
    }), new Promise((_, reject) => {
        cancelled = () => reject(new Error('cancelled'));
        signal?.addEventListener('abort', cancelled, {once:true});
        timer = timers.setTimeout(() => reject(new Error('no_current_frame')), ms);
    })]).finally(() => {
        timers.clearTimeout(timer);
        signal?.removeEventListener('abort', cancelled);
    });
}

/**
 * Wait for a new compositor frame and an unmuted track. Startup accepts the frame that triggered Chrome's unmute.
 * Recovery needs a frame presented after unmute. Never take the pre-armed track's cached image.
 */
export function freshFrame(video, track, ms, onWaiting, timers = globalThis, signal, afterUnmute=false) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(new Error('cancelled')); return; }
        let presented = false, request, frameRequest = 0;
        const ready = () => { if (presented && !track.muted) { done(); resolve(); } };
        const cancelled = () => { done(); reject(new Error('cancelled')); };
        const timeout = timers.setTimeout(() => { done(); reject(new Error('no_current_frame')); }, ms);
        function clearFrame() {
            frameRequest++;
            if (request !== undefined) video.cancelVideoFrameCallback?.(request);
            request = undefined;
        }
        function done() {
            timers.clearTimeout(timeout);
            track.removeEventListener('unmute', unmuted);
            signal?.removeEventListener('abort', cancelled);
            clearFrame();
        }
        function requestFrame() {
            clearFrame();
            const generation = frameRequest;
            request = video.requestVideoFrameCallback(() => {
                if (generation !== frameRequest) return;
                request = undefined;
                if (afterUnmute && track.muted) return;
                presented = true;
                ready();
            });
        }
        function unmuted() {
            if (afterUnmute) requestFrame();
            else ready();
        }
        track.addEventListener('unmute', unmuted);
        signal?.addEventListener('abort', cancelled, {once:true});
        if (!afterUnmute || !track.muted) requestFrame();
        onWaiting?.();
    });
}

/** Arm the frame callback before playback can consume the first picture. A progress paint on the captured tab can
 * be what makes Chromium deliver that picture and settle play(). Both share one deadline and cancel together. */
async function startFrame(video, track, ms, onWaiting, timers, signal) {
    const waiting = new AbortController();
    const cancel = () => waiting.abort();
    if (signal?.aborted) cancel();
    signal?.addEventListener('abort', cancel, {once:true});
    try {
        await Promise.all([
            playWithin(video, ms, timers, waiting.signal),
            freshFrame(video, track, ms, onWaiting, timers, waiting.signal),
        ]);
    } finally {
        waiting.abort();
        signal?.removeEventListener('abort', cancel);
    }
}

export async function encodeTabSegments({win, stream, matches, windowStart, deadline, upload, cutoff,
    onFault, onFrame, onAwaitFrame, onPause, onResume, signal, recoveryMs=4500, firstSequence=0, clockOffset=0}) {
    const track = stream.getVideoTracks()[0];
    const video = win.document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let active = true, timer, segment, pendingUpload, sequence = firstSequence, last = null, stopped, recovery;
    const queuedSegments = new Set();
    // `held`: a server-gated hold (`hold`/`release`) stops recording. The timeline stays the real wall clock since the
    // window started: a hold leaves an honest gap between two clips, never a compressed one.
    let held = false;
    const wall = Date.now()+clockOffset, mono = win.performance.now();
    const time = () => Math.floor(wall + win.performance.now() - mono - windowStart);
    // The server's deadline in wall time; a later report (time the server gave back) moves it with `setDeadline`.
    let deadlineAt = deadline;
    const limit = () => deadlineAt - windowStart;
    const canvas = win.document.createElement('canvas');
    const ctx = canvas.getContext('2d', {alpha:false});
    try {
        await startFrame(video, track, 4500, onAwaitFrame, win, signal);
        if (!matches() || !ctx || !video.videoWidth || !video.videoHeight) throw new Error('source_lost');
        const scale = Math.min(1, 1920/video.videoWidth, 1080/video.videoHeight);
        canvas.width = Math.max(2, 2*Math.floor(video.videoWidth*scale/2));
        canvas.height = Math.max(2, 2*Math.floor(video.videoHeight*scale/2));
        const config = {codec:'vp8', width:canvas.width, height:canvas.height, bitrate:1500000, framerate:1, latencyMode:'realtime'};
        if (!(await win.VideoEncoder.isConfigSupported(config)).supported) throw new Error('encoder_unavailable');
        function open(start) {
            const mux = createVP8Muxer(canvas.width, canvas.height);
            const encoder = new win.VideoEncoder({output: chunk => {
                try { mux.addVideoChunk(chunk); } catch { fault('mux_failed'); }
            }, error: () => fault('encoder_error')});
            encoder.configure(config);
            return {mux, encoder, start};
        }
        async function seal(current, end) {
            try {
                await current.encoder.flush();
                const stopAt = Date.parse(await cutoff());
                if (Number.isFinite(stopAt)) end = Math.min(end,stopAt-windowStart);
                end = Math.min(end,current.pauseCutoff ?? Infinity);
                if (end <= current.start) return;
                const bytes = current.mux.finalize(end-current.start);
                await upload({sequence:sequence++, startMs:current.start, endMs:end, mimeType:'video/webm', bytes});
            } finally { if (current.encoder.state !== 'closed') current.encoder.close(); }
        }
        function rotate(end, interrupted=false) {
            // The interrupted clip can wait behind one in-flight upload. Keep both ordered and bounded.
            if (queuedSegments.size && (!interrupted || queuedSegments.size >= 2)) throw new Error('upload_backpressure');
            const old = segment, previous = pendingUpload;
            segment = undefined;
            queuedSegments.add(old);
            const task = (async () => {
                try {
                    if (previous) await previous;
                    await seal(old, end);
                } catch (err) {
                    if (old.encoder.state !== 'closed') old.encoder.close();
                    fault('upload_failed');
                    throw err;
                }
            })().finally(() => {
                queuedSegments.delete(old);
                if (pendingUpload === task) pendingUpload = undefined;
            });
            pendingUpload = task;
            // Promise is also explicitly joined at Stop.
            task.catch(() => {});
        }
        const faultCode = err => /^[a-z_]{1,40}$/.test(err?.message ?? '') ? err.message : 'sample_failed';
        function fault(cause) {
            if (!active) return;
            active = false;
            win.clearTimeout(timer);
            recovery?.abort();
            onFault(cause);
        }
        function usableTime() {
            const t = time();
            if (!matches() || t < 0) throw new Error('source_lost');
            if (t >= limit()) throw new Error('deadline');
            return t;
        }
        async function resume(wait, pausedAt) {
            const cancel = () => wait.abort();
            signal?.addEventListener('abort', cancel, {once:true});
            try {
                if (signal?.aborted) return;
                await freshFrame(video, track, recoveryMs, undefined, win, wait.signal, true);
                if (!active || wait.signal.aborted) return;
                const t = usableTime();
                if (t-pausedAt >= recoveryMs || track.muted || video.readyState < 2) throw new Error('no_current_frame');
                record(t);
                recovery = undefined;
                onResume?.();
                if (active && !recovery) timer = win.setTimeout(tick, 1001);
            } catch (err) {
                if (active && !signal?.aborted && !wait.signal.aborted) fault(faultCode(err));
            } finally {
                signal?.removeEventListener('abort', cancel);
            }
        }
        /** Stop sampling and keep only frames before the server's pause, including in a clip already flushing. */
        function hold(effectiveAt = null) {
            if (!active || held || signal?.aborted) return;
            try {
                const t = time();
                const acceptedThrough = Number.isFinite(effectiveAt) ? Math.min(t, effectiveAt-windowStart) : t;
                held = true;
                for (const queued of queuedSegments)
                    queued.pauseCutoff = Math.min(queued.pauseCutoff ?? Infinity, acceptedThrough);
                win.clearTimeout(timer);
                recovery?.abort();
                recovery = undefined;
                if (segment) rotate(Math.min(acceptedThrough, (last ?? t)+1000), true);
            } catch (err) { fault(faultCode(err)); }
        }
        /** End a hold: wait for a fresh frame of the shared tab, then record again; the held time stays a gap on the real timeline. */
        function release() {
            if (!active || !held || signal?.aborted) return;
            held = false;
            const wait = new AbortController();
            recovery = wait;
            const cancel = () => wait.abort();
            signal?.addEventListener('abort', cancel, {once:true});
            void (async () => {
                try {
                    await freshFrame(video, track, recoveryMs, undefined, win, wait.signal, true);
                    if (!active || wait.signal.aborted || held) return;
                    const t = usableTime();
                    if (track.muted || video.readyState < 2) throw new Error('no_current_frame');
                    record(t);
                    recovery = undefined;
                    onResume?.();
                    if (active && !recovery && !held) timer = win.setTimeout(tick, 1001);
                } catch (err) {
                    if (active && !signal?.aborted && !held && !wait.signal.aborted) fault(faultCode(err));
                } finally { signal?.removeEventListener('abort', cancel); }
            })();
        }
        function pause(cause='track_muted') {
            if (!active || recovery || held || signal?.aborted) return;
            try {
                const t = usableTime();
                const wait = new AbortController();
                recovery = wait;
                win.clearTimeout(timer);
                onPause?.(cause);
                // Do not extend the previous clip over media the browser never supplied.
                if (segment) rotate(Math.min(t, last+1000), true);
                if (active) void resume(wait, t);
            } catch (err) { fault(faultCode(err)); }
        }
        function sample() {
            const t = usableTime();
            if (track.muted || video.readyState < 2) { pause('no_current_frame'); return; }
            if (last !== null && t-last > 2700) { pause('sample_delayed'); return; }
            if (last !== null && t-last < 1000) return;
            if (segment && t-segment.start >= (sequence === firstSequence ? 3500 : 11000)) rotate(t);
            record(t);
        }
        function record(t) {
            if (!segment) segment = open(t);
            if (segment.encoder.encodeQueueSize > 2) throw new Error('encoder_backpressure');
            // Drawing the browser-issued tab track preserves the composited Code, Settings and Browser pixels.
            const scale = Math.min(canvas.width/video.videoWidth, canvas.height/video.videoHeight);
            const width = Math.round(video.videoWidth*scale), height = Math.round(video.videoHeight*scale);
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(video, (canvas.width-width)/2, (canvas.height-height)/2, width,height);
            const frame = new win.VideoFrame(canvas, {timestamp:(t-segment.start)*1000});
            try { segment.encoder.encode(frame, {keyFrame:t===segment.start}); } finally { frame.close(); }
            if (last === null) onFrame?.();
            last = t;
        }
        function tick() {
            if (!active || signal?.aborted) return;
            try { sample(); }
            catch (err) { fault(faultCode(err)); return; }
            if (active && !recovery) timer = win.setTimeout(tick, 1001);
        }
        sample();
        if (active && !recovery) timer = win.setTimeout(tick, 1001);
        return {pause, hold, release, held:() => held, setDeadline(at) { if (Number.isFinite(at)) deadlineAt = at; },
        stop(effectiveAt) {
            if (stopped) return stopped;
            active = false; win.clearTimeout(timer);
            recovery?.abort();
            const cutoffAt = Date.parse(effectiveAt);
            const end = Math.min(limit(),time(), (last ?? 0)+1000,
                Number.isFinite(cutoffAt) ? cutoffAt-windowStart : limit());
            video.pause(); video.srcObject = null;
            const finalSegment = segment;
            segment = undefined;
            stopped = (async () => {
                try {
                    await pendingUpload;
                    if (finalSegment && end > finalSegment.start) await seal(finalSegment,end);
                    else if (finalSegment?.encoder.state !== 'closed') finalSegment?.encoder.close();
                    return {expectedSegments:sequence};
                } finally {
                    if (finalSegment?.encoder.state !== 'closed') finalSegment?.encoder.close();
                }
            })();
            return stopped;
        }};
    } catch (err) {
        active = false; win.clearTimeout(timer); recovery?.abort(); video.pause(); video.srcObject = null;
        if (segment?.encoder.state !== 'closed') segment?.encoder.close();
        throw err;
    }
}

export async function seedFrame(stream,valid,onWaiting,ms=8000,signal) {
    const video=document.createElement('video');
    video.srcObject=stream; video.muted=true; video.playsInline=true;
    let encoder;
    try {
        await startFrame(video,stream.getVideoTracks()[0],ms,onWaiting,globalThis,signal);
        if (!valid() || !video.videoWidth || !video.videoHeight) throw new Error('source_lost');
        const scale=Math.min(1,640/video.videoWidth,480/video.videoHeight);
        const canvas=document.createElement('canvas');
        canvas.width=Math.max(2,2*Math.floor(video.videoWidth*scale/2)); canvas.height=Math.max(2,2*Math.floor(video.videoHeight*scale/2));
        const ctx=canvas.getContext('2d',{alpha:false}); ctx.drawImage(video,0,0,canvas.width,canvas.height);
        const mux=createVP8Muxer(canvas.width,canvas.height);
        let failed=false;
        encoder=new VideoEncoder({output(chunk){try{mux.addVideoChunk(chunk);}catch{failed=true;}},error(){failed=true;}});
        encoder.configure({codec:'vp8',width:canvas.width,height:canvas.height,bitrate:450000,framerate:1,latencyMode:'realtime'});
        const frame=new VideoFrame(canvas,{timestamp:0});
        try{encoder.encode(frame,{keyFrame:true});}finally{frame.close();}
        await encoder.flush();
        if(failed || !valid()) throw new Error('source_lost');
        const bytes=mux.finalize(1);
        if (!bytes.byteLength || bytes.byteLength>1024*1024) throw new Error('invalid_seed');
        return bytes;
    } finally { if(encoder && encoder.state!=='closed')encoder.close();video.pause();video.srcObject=null; }
}
