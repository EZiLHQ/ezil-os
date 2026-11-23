// tab-segments-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/tab-segments-test.mjs
//
// `video.play()` on a stopped or ended capture track may never settle. Both the seed frame and the segment encoder
// bound it like the frame wait that follows, rejecting `no_current_frame`, so a share can never hang on it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeTabSegments, playWithin, seedFrame} from './tab-segments.js';

const stalled=()=>({muted:false,playsInline:false,srcObject:'stream',paused:false,frames:0,
    play:()=>new Promise(()=>{}),pause(){this.paused=true;},requestVideoFrameCallback(){this.frames++;}});

test('playWithin rejects no_current_frame once its bound passes, and resolves with a play() that settles', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const outcome=playWithin(stalled(),4500).then(()=>'played',error=>error.message);
    t.mock.timers.tick(4499);await Promise.resolve();
    t.mock.timers.tick(1);
    assert.equal(await outcome,'no_current_frame');
    assert.equal(await playWithin({play:async()=>'ok'},4500),'ok');
});

test('seedFrame gives up on a play() that never settles within its 8 s frame budget', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const video=stalled();
    const previous=globalThis.document;
    globalThis.document={createElement:()=>video};
    try{
        const outcome=seedFrame({},()=>true,()=>assert.fail('never waits for a frame it cannot play')).then(()=>'seeded',error=>error.message);
        t.mock.timers.tick(8000);
        assert.equal(await outcome,'no_current_frame');
        assert.equal(video.paused,true);assert.equal(video.srcObject,null);assert.equal(video.frames,0);
    }finally{globalThis.document=previous;}
});

test('encodeTabSegments gives up on a play() that never settles within its 4.5 s frame budget', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const video=stalled();
    const win={document:{createElement:tag=>tag==='video'?video:{getContext:()=>({})}},performance:{now:()=>0},
        setTimeout:(...args)=>setTimeout(...args),clearTimeout:id=>clearTimeout(id)};
    let faults=0;
    const outcome=encodeTabSegments({win,stream:{getVideoTracks:()=>[{muted:false}]},matches:()=>true,windowStart:Date.now(),
        deadline:Date.now()+3600000,upload:async()=>{},cutoff:async()=>null,onFault:()=>faults++,onFrame(){},onAwaitFrame(){}})
        .then(()=>'recording',error=>error.message);
    t.mock.timers.tick(4500);
    assert.equal(await outcome,'no_current_frame');
    assert.equal(video.paused,true);assert.equal(video.srcObject,null);assert.equal(faults,0,'a start failure is thrown, not a fault');
});
