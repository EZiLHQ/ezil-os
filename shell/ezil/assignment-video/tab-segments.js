import {createVP8Muxer} from './vp8-webm.js';

/**
 * `play()` on a capture track can stay pending (an ended or stopped share). Bounded like the frame wait after it, so a
 * share can never hang on it: it rejects `no_current_frame`, the same as a tab that presents no frame.
 */
export function playWithin(video, ms, timers = globalThis) {
    let timer;
    return Promise.race([Promise.resolve().then(() => video.play()),
        new Promise((_, reject) => { timer = timers.setTimeout(() => reject(new Error('no_current_frame')), ms); })])
        .finally(() => timers.clearTimeout(timer));
}

export async function encodeTabSegments({win, stream, matches, windowStart, deadline, upload, cutoff, onFault, onFrame, onAwaitFrame, firstSequence=0, clockOffset=0}) {
    const video = win.document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    let active = true, timer, segment, pendingUpload, sequence = firstSequence, last = null, stopped;
    const wall = Date.now()+clockOffset, mono = win.performance.now();
    const time = () => Math.floor(wall + win.performance.now() - mono - windowStart);
    const limit = deadline - windowStart;
    const canvas = win.document.createElement('canvas');
    const ctx = canvas.getContext('2d', {alpha:false});
    try {
        await playWithin(video, 4500, win);
        // Wait for a compositor frame presented after authorization. Never encode the pre-armed track's cached image.
        await new Promise((resolve, reject) => {
            const timeout = win.setTimeout(() => reject(new Error('no_current_frame')), 4500);
            video.requestVideoFrameCallback(() => { win.clearTimeout(timeout); resolve(); });
            onAwaitFrame?.();
        });
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
                if (end <= current.start) return;
                const bytes = current.mux.finalize(end-current.start);
                await upload({sequence:sequence++, startMs:current.start, endMs:end, mimeType:'video/webm', bytes});
            } finally { if (current.encoder.state !== 'closed') current.encoder.close(); }
        }
        function rotate(end) {
            if (pendingUpload) throw new Error('upload_backpressure');
            const old = segment;
            segment = undefined;
            pendingUpload = seal(old, end).catch(err => { fault('upload_failed'); throw err; })
                .finally(() => { pendingUpload = undefined; });
            // Promise is also explicitly joined at Stop.
            pendingUpload.catch(() => {});
        }
        // `cause`: why the recorder stopped itself, for the gate's diagnostics (a code, never a message).
        function fault(cause) {
            if (!active) return;
            active = false;
            win.clearTimeout(timer);
            onFault(cause);
        }
        function sample() {
            if (!active) return;
            const t = time();
            if (!matches() || stream.getVideoTracks()[0].muted || video.readyState < 2
                || t < 0 || t >= limit || (last !== null && t-last > 2700))
                throw new Error('source_lost');
            if (last !== null && t-last < 1000) return;
            if (segment && t-segment.start >= (sequence === firstSequence ? 3500 : 11000)) rotate(t);
            if (!segment) segment = open(t);
            if (segment.encoder.encodeQueueSize > 2) throw new Error('encoder_backpressure');
            // Drawing the browser-issued tab track preserves the composited Code, Settings and Browser pixels.
            const scale = Math.min(canvas.width/video.videoWidth, canvas.height/video.videoHeight);
            const width = Math.round(video.videoWidth*scale), height = Math.round(video.videoHeight*scale);
            ctx.fillStyle = '#000'; ctx.fillRect(0,0,canvas.width,canvas.height);
            ctx.drawImage(video, (canvas.width-width)/2, (canvas.height-height)/2, width,height);
            const frame = new win.VideoFrame(canvas, {timestamp:(t-segment.start)*1000});
            try { segment.encoder.encode(frame, {keyFrame:t===segment.start}); } finally { frame.close(); }
            if (last === null) onFrame();
            last = t;
        }
        function tick() {
            try { sample(); }
            catch (err) { fault(/^[a-z_]{1,40}$/.test(err?.message ?? '') ? err.message : 'sample_failed'); return; }
            if (active) timer = win.setTimeout(tick, 1001);
        }
        sample();
        timer = win.setTimeout(tick, 1001);
        return {stop(effectiveAt) {
            if (stopped) return stopped;
            active = false; win.clearTimeout(timer);
            const cutoffAt = Date.parse(effectiveAt);
            const end = Math.min(limit,time(), (last ?? 0)+1000,
                Number.isFinite(cutoffAt) ? cutoffAt-windowStart : limit);
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
        active = false; win.clearTimeout(timer); video.pause(); video.srcObject = null;
        if (segment?.encoder.state !== 'closed') segment?.encoder.close();
        throw err;
    }
}

export async function seedFrame(stream,valid,onWaiting) {
    const video=document.createElement('video');
    video.srcObject=stream; video.muted=true; video.playsInline=true;
    let encoder;
    try {
        await playWithin(video,8000);
        await new Promise((resolve,reject)=>{
            const timeout=setTimeout(()=>reject(new Error('no_current_frame')),8000);
            video.requestVideoFrameCallback(()=>{clearTimeout(timeout);resolve();});
            onWaiting();
        });
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
