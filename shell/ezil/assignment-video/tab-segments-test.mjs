// tab-segments-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/tab-segments-test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {encodeTabSegments, playWithin, seedFrame} from './tab-segments.js';

const stalled=()=>({muted:false,playsInline:false,srcObject:null,paused:false,videoWidth:640,videoHeight:480,frames:0,
    play:()=>new Promise(()=>{}),pause(){this.paused=true;},
    requestVideoFrameCallback(callback){this.callback=callback;return ++this.frames;},
    cancelVideoFrameCallback(id){assert.equal(id,this.frames);this.callback=null;}});
const stream=()=>({getVideoTracks:()=>[Object.assign(new EventTarget(),{muted:false})]});

function installVideo(t,video){
    const previous=globalThis.document;
    globalThis.document={createElement:()=>video};
    t.after(()=>{globalThis.document=previous;});
}

test('playWithin rejects no_current_frame once its bound passes, and resolves with a play() that settles', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const outcome=playWithin(stalled(),4500).then(()=>'played',error=>error.message);
    t.mock.timers.tick(4499);await Promise.resolve();
    t.mock.timers.tick(1);
    assert.equal(await outcome,'no_current_frame');
    assert.equal(await playWithin({play:async()=>'ok'},4500),'ok');
});

test('seedFrame paints progress and arms a fresh frame even if play never settles', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const video=stalled();
    installVideo(t,video);
    let waiting=0;
    const outcome=assert.rejects(seedFrame(stream(),()=>assert.fail('no genuine frame'),()=>{waiting++;}),/no_current_frame/);
    assert.equal(waiting,1);
    assert.equal(video.frames,1);
    t.mock.timers.tick(8000);
    await outcome;
    assert.equal(video.paused,true);
    assert.equal(video.srcObject,null);
    assert.equal(video.callback,null,'no frame callback survives timeout');
});

test('a frame presented while play is settling is kept, but neither event alone starts the seed', async t=>{
    const video=stalled();
    installVideo(t,video);
    let resumePlayback,waiting=false,entered=false;
    video.play=()=>new Promise(resolve=>{resumePlayback=resolve;});
    const outcome=assert.rejects(seedFrame(stream(),()=>{
        entered=true;
        return false; // Stop after readiness, before hardware encoding.
    },()=>{waiting=true;}),/source_lost/);
    await Promise.resolve();
    assert.equal(waiting,true);
    assert.equal(typeof resumePlayback,'function');
    video.callback();
    await Promise.resolve();
    assert.equal(entered,false,'a compositor frame is necessary but playback has to be ready too');
    resumePlayback();
    await outcome;
    assert.equal(entered,true,'the only frame arrived before playback resolved');
});

test('playback without a fresh frame cannot produce a seed', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const video=stalled();
    video.play=async()=>{};
    installVideo(t,video);
    const outcome=assert.rejects(seedFrame(stream(),()=>assert.fail('playback cannot prove a frame')),/no_current_frame/);
    t.mock.timers.tick(8000);
    await outcome;
    assert.equal(video.callback,null);
});

test('an aborted seed cleans its frame wait and ignores a late playback/frame', async t=>{
    const video=stalled();
    const stop=new AbortController();
    let resumePlayback;
    video.play=()=>new Promise(resolve=>{resumePlayback=resolve;});
    installVideo(t,video);
    const outcome=assert.rejects(seedFrame(stream(),()=>assert.fail('stopped seed'),undefined,8000,stop.signal),/cancelled/);
    await Promise.resolve();
    const lateFrame=video.callback;
    stop.abort();
    await outcome;
    assert.equal(video.callback,null);
    assert.equal(video.paused,true);
    assert.equal(video.srcObject,null);
    lateFrame();
    resumePlayback();
});

test('encodeTabSegments gives up on a play() that never settles within its 4.5 s frame budget', async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const video=stalled();
    const win={document:{createElement:tag=>tag==='video'?video:{getContext:()=>({})}},performance:{now:()=>0},
        setTimeout:(...args)=>setTimeout(...args),clearTimeout:id=>clearTimeout(id)};
    let faults=0,waiting=0;
    const outcome=assert.rejects(encodeTabSegments({win,stream:stream(),matches:()=>true,windowStart:Date.now(),
        deadline:Date.now()+3600000,upload:async()=>{},cutoff:async()=>null,onFault:()=>faults++,onFrame(){},
        onAwaitFrame:()=>{waiting++;}}),/no_current_frame/);
    assert.equal(waiting,1);
    t.mock.timers.tick(4500);
    await outcome;
    assert.equal(video.paused,true);
    assert.equal(video.srcObject,null);
    assert.equal(video.callback,null);
    assert.equal(faults,0,'a start failure is thrown, not a fault');
});
