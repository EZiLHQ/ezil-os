import assert from 'node:assert/strict';
import {test} from 'node:test';
import {encodeTabSegments} from './tab-segments.js';

// No browser, display, real content or real video is used in these deterministic timing tests.
function harness(beforeDeadline) {
    let now=0, handle=0, frames=0, faults=0;
    const timers=new Map(), uploads=[];
    const start=Date.now()-3600000+beforeDeadline;
    const deadline=start+3600000;
    const video={videoWidth:480,videoHeight:360,readyState:3,play:async()=>{},pause(){},
        requestVideoFrameCallback(fn){queueMicrotask(fn);}};
    class Encoder {
        constructor({output}){this.output=output;this.state='configured';this.encodeQueueSize=0;}
        static async isConfigSupported(){return {supported:true};}
        configure(){} close(){this.state='closed';} async flush(){}
        encode(frame,{keyFrame}){frames++;this.output({timestamp:frame.timestamp,type:keyFrame?'key':'delta',byteLength:1,copyTo(){}});}
    }
    const win={performance:{now:()=>now},setTimeout(fn,ms){timers.set(++handle,{fn,when:now+ms});return handle;},
        clearTimeout(id){timers.delete(id);},document:{createElement(name){return name==='video'?video:
            {getContext:()=>({fillRect(){},drawImage(){}})};}},VideoEncoder:Encoder,
        VideoFrame:class{constructor(_,init){this.timestamp=init.timestamp;}close(){}}};
    return {start,deadline,uploads,get frames(){return frames;},get faults(){return faults;},
        async create(cutoff=null){return encodeTabSegments({win,stream:{getVideoTracks:()=>[{muted:false}]},matches:()=>true,
            windowStart:start,deadline,upload:async packet=>uploads.push(packet),
            cutoff:async()=>cutoff,onFrame(){},onFault(){faults++;}});},
        async advance(ms){now+=ms;for(const [id,task] of [...timers])if(task.when<=now){timers.delete(id);task.fn();}await Promise.resolve();}};
}
test('original one-hour boundary ends capture without resetting the assignment clock',async()=>{
    const h=harness(2500), recorder=await h.create();
    await h.advance(1001); await h.advance(1001); await h.advance(1001); await h.advance(1001);
    assert.equal(h.frames,3); assert.equal(h.faults,1);
    await recorder.stop(new Date(h.deadline).toISOString());
    assert.equal(h.uploads.length,1); assert.equal(h.uploads[0].endMs,3600000);
    assert.ok(h.uploads[0].startMs>=3597500);
});
test('a late trusted submission trims already-buffered visual data before upload',async()=>{
    const h=harness(9000), cutoff=h.start+3592750;
    const recorder=await h.create(new Date(cutoff).toISOString());
    await h.advance(1001); await h.advance(1001); await h.advance(1001); await recorder.stop();
    assert.equal(h.uploads.length,1); assert.equal(h.uploads[0].endMs,3592750);
    assert.ok(h.frames>=3);
});
test('a suspended clock seals only the observed portion of an idle interval',async()=>{
    const h=harness(9000),recorder=await h.create();
    await h.advance(5000); await recorder.stop();
    assert.equal(h.faults,1); assert.equal(h.frames,1);
    assert.equal(h.uploads[0].endMs-h.uploads[0].startMs,1000);
});
