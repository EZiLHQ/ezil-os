// gate-stop-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/gate-stop-test.mjs
//
// The assignment share gate after a stop or a failed share (prod incident 2026-11-23, attempt 96b3bb7d): the gate must
// never sit on "Checking saved assignment footage…", a stop must cancel its own computer wake (and only its own), a
// begun phase is checkpointed exactly once and only after its last segment is confirmed (the screen is bounded, the
// footage is not), no new share begins over a phase still saving, the copy names the real cause, and every end of a
// share leaves gate evidence in telemetry's local mirror for a feedback report.
import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithAssignmentConsent} from './shell.js';
import {recentEvents} from '../telemetry.js';

const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const recordingId='01111111-2222-4333-8444-555555555555';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
const name=repo.split('/').at(-1).slice(0,-4);
const SHARE='Share this OS tab and open assignment';
const CONSENT_TAIL=' The job creator can review saved work even if you do not submit.';
const checkout={ok:true,repository:{id:'test',workspaceFolder:'/workspace',checkoutFolder:'/workspace/'+name},assignmentOpen:{attemptId:id,proof:'x'.repeat(60)}};
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,ms=3000){
    const end=Date.now()+ms;
    while(!predicate()){if(Date.now()>end)throw new Error('timed out waiting');await tick(5);}
}
const begun=body=>Response.json({recordingId,status:'awaiting_frame',captureSessionId:body.captureSessionId,nextSequence:0,
    authorizationExpiresAt:new Date(Date.now()+600000).toISOString(),startedAt:null,deadlineAt:null,revoked:false,stopRequestedAt:null});

class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(name,value){this[name]=value;} append(...children){this.children.push(...children);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}

const ORIGIN='https://os-staging.ezil.work';
const BUCKET='https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
/**
 * Broker answers for a whole recorded share through the real transport: begin, the seed and segment prepare/confirm,
 * status and checkpoint. `put(sequence)` may delay or withhold a segment's storage PUT.
 */
function recorded({put}={}){
    const startedAt=new Date().toISOString(),deadlineAt=new Date(Date.now()+3000000).toISOString();
    let phase;
    return {put,
        begin:body=>{phase=body.captureSessionId;return begun(body);},
        prepare:body=>Response.json({putUrl:BUCKET+'/universe-staging/assignment-media/v1/x/'+id+'/'+recordingId+'/segments/'+body.sequence+'/'+body.sha256+'.webm',headers:{}}),
        confirm:body=>Response.json(body.sequence===0?{confirmed:true,recordingId,sequence:0,phaseReady:true,captureSessionId:phase,nextSequence:1,
            firstFrameAt:startedAt,startedAt,deadlineAt,serverNow:new Date().toISOString()}:{confirmed:true,recordingId,sequence:body.sequence}),
        status:()=>Response.json({recordingId,captureSessionId:phase,status:'recording',phaseReady:true,workspaceUnlocked:true,
            startedAt,deadlineAt,firstFrameAt:startedAt,revoked:false,stopRequestedAt:null}),
        checkpoint:()=>Response.json({status:'paused'})};
}
/** Just enough WebCodecs and media elements for the real seed frame (globals) and segment recorder (`win`) to run. */
class FakeFrame{constructor(_source,{timestamp}){this.timestamp=timestamp;} close(){}}
class FakeEncoder{
    static async isConfigSupported(){return {supported:true};}
    state='unconfigured';encodeQueueSize=0;
    constructor({output}){this.output=output;}
    configure(){this.state='configured';}
    encode(frame,{keyFrame}={}){const {timestamp}=frame;
        queueMicrotask(()=>this.output({type:keyFrame?'key':'delta',timestamp,byteLength:4,copyTo:bytes=>bytes.set([1,2,3,4])}));}
    async flush(){}
    close(){this.state='closed';}
}
const mediaElement={
    video:()=>Object.assign(new Element(),{muted:false,playsInline:false,srcObject:null,videoWidth:1280,videoHeight:720,readyState:4,
        play:async()=>{},pause(){},requestVideoFrameCallback(callback){setTimeout(callback,5);}}),
    canvas:()=>Object.assign(new Element(),{width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}})}),
};
function installMedia(t){
    const saved=['location','VideoEncoder','VideoFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
    // The transport only signs uploads for this OS origin's own assignment bucket.
    Object.defineProperty(globalThis,'location',{value:new URL(ORIGIN+'/app/code'),configurable:true,writable:true});
    Object.assign(globalThis,{VideoEncoder:FakeEncoder,VideoFrame:FakeFrame});
    t.after(()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
}

/** One OS tab on os-staging with the gate armed. `control[action]` answers the assignment-video route; preflight is eligible. */
// `saveCeilingMs`: short, so a failing test's unfinished save (module state) cannot stall the next test for minutes.
function harness(t,{prepare,control={},video,media=false,settleMs=40,saveCeilingMs=3000}={}){
    const calls=[],elements=[];
    if(media)installMedia(t);
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        if(options.method==='PUT'){
            const sequence=Number(String(url).split('/segments/')[1].split('/')[0]);calls.push('put:'+sequence);
            return await control.put?.(sequence)??new Response(null,{status:200});
        }
        const body=JSON.parse(options.body);calls.push(body.action+(Number.isInteger(body.sequence)?':'+body.sequence:''));
        if(control[body.action])return control[body.action](body);
        if(body.action==='preflight')return Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString()});
        return Response.json({});
    });
    let handle;
    class Track{
        readyState='live';muted=false;listeners={};
        getCaptureHandle(){return {origin:'https://os-staging.ezil.work',handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){this.listeners[n]=f;} stop(){this.readyState='ended';}
    }
    const tracks=[];
    const stream=()=>{const track=new Track();tracks.push(track);return {getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};};
    const make=tag=>tag==='video'&&video?video():media&&mediaElement[tag]?mediaElement[tag]():new Element();
    const doc={body:new Element(),createElement(tag){const e=make(tag);e.tag=tag;elements.push(e);return e;}};
    const win={location:new URL(ORIGIN+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),crypto:globalThis.crypto,
        isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},MediaStreamTrack:Track,
        VideoFrame:media?FakeFrame:class{},VideoEncoder:media?FakeEncoder:class{},performance:globalThis.performance,
        setTimeout:(...args)=>setTimeout(...args),clearTimeout:timer=>clearTimeout(timer),
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream()}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    let opened=0;
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){opened++;},prepare,settleMs,saveCeilingMs});
    const buttons=()=>elements.filter(e=>e.tag==='button'&&e.textContent===SHARE);
    return {gate,calls,tracks,opened:()=>opened,panel:()=>elements.find(e=>e.tag==='section'),
        title:()=>elements.filter(e=>e.tag==='h2').at(-1)?.textContent,
        status:()=>elements.filter(e=>e.tag==='p').at(-1)?.textContent,
        buttons,
        async share(){const count=buttons().length;await waitFor(()=>buttons().length>0);buttons().at(-1).onclick({isTrusted:true});return count;},
        stop(){tracks.at(-1).listeners.ended();},
    };
}
const gateEvents=since=>recentEvents().slice(since).filter(e=>e.site.startsWith('ezil-os:assignment#'));

test('a stop during the computer wake releases the gate at once, aborts that prepare and opens nothing', async t=>{
    const signals=[];let release;
    const h=harness(t,{prepare:(_attempt,{signal}={})=>{signals.push(signal);return new Promise(resolve=>{release=resolve;});}});
    try{
        const since=recentEvents().length;
        await h.share();
        await waitFor(()=>signals.length===1);
        const offered=h.buttons().length;
        h.stop();
        assert.equal(signals[0]?.aborted,true,'the stopped share cancels its own Code mint (and so its wake loop)');
        assert.equal(h.title(),'Record this assignment tab','consent is back synchronously, never "Checking saved assignment footage…"');
        assert.equal(h.status(),'Sharing stopped. Share this OS tab again to open your assignment.'+CONSENT_TAIL);
        assert.equal(h.buttons().length,offered+1,'the share button is offered again');
        assert.equal(h.gate.access(),null);assert.equal(h.gate.locked(),true);
        release(checkout);await tick(10);
        assert.deepEqual(h.calls,['preflight'],'no begin for a share that ended before its checkout answered');
        assert.equal(h.opened(),0);assert.equal(h.tracks[0].readyState,'ended');
        const finish=gateEvents(since).filter(e=>e.site==='ezil-os:assignment#finish');
        assert.equal(finish.length,1);
        assert.equal(finish[0].code,'track_ended');assert.equal(finish[0].outcome,'skipped');
        assert.match(finish[0].detail,/stage:prepare;reason:sharing_stopped;began:0;accepted:0/);
    }finally{await h.gate.close();}
});

test('a stale retry of an ended share never prepares again and never aborts the next share', async t=>{
    const signals=[],rejects=[];
    const h=harness(t,{prepare:(_attempt,{signal}={})=>{signals.push(signal);return new Promise((_,reject)=>rejects.push(reject));}});
    try{
        await h.share();await waitFor(()=>signals.length===1);
        h.stop();
        await h.share();await waitFor(()=>signals.length===2);
        // The ended share's prepare now fails with a retryable code: its retry must not run.
        rejects[0](Object.assign(new Error('prepare_failed'),{code:'sandbox_starting'}));
        await tick(800);
        assert.equal(signals.length,2,'the ended share did not prepare again');
        assert.equal(signals[1].aborted,false,"the next share's mint is untouched");
        assert.equal(h.title(),'Preparing assignment');
    }finally{await h.gate.close();}
});

test('a stop while the seed frame hangs hands the gate back within the bound and checkpoints once the seed step settles', async t=>{
    let rejectPlay;
    const video=()=>Object.assign(new Element(),{muted:false,playsInline:false,srcObject:null,pause(){},requestVideoFrameCallback(){},
        play:()=>new Promise((_,reject)=>{rejectPlay=reject;})});
    const h=harness(t,{prepare:async()=>checkout,video,control:{begin:begun,checkpoint:()=>Response.json({status:'paused'})}});
    try{
        const since=recentEvents().length;
        await h.share();
        await waitFor(()=>h.calls.includes('begin'));await tick(20);
        const stoppedAt=Date.now();
        h.stop();
        assert.equal(h.title(),'Sharing stopped');
        await waitFor(()=>h.title()==='Record this assignment tab');
        assert.ok(Date.now()-stoppedAt<1000,'consent returns within the settle bound, not when the seed frame gives up');
        assert.equal(h.status(),'Sharing stopped. Share this OS tab again to open your assignment.'+CONSENT_TAIL,
            'no footage is claimed: no segment was confirmed');
        assert.equal(h.calls.includes('checkpoint'),false,'the phase waits for its seed step (bounded by its own 8 s frame budget)');
        rejectPlay(new Error('aborted'));
        await waitFor(()=>h.calls.includes('checkpoint'));await tick(10);
        assert.equal(h.calls.filter(c=>c==='checkpoint').length,1);assert.equal(h.opened(),0);
        const finish=gateEvents(since).filter(e=>e.site==='ezil-os:assignment#finish');
        assert.equal(finish.length,1,'one finish report, once the footage is settled');
        assert.match(finish[0].detail,/stage:seed;reason:sharing_stopped;began:1;accepted:0;saved:1;late:1/);
    }finally{rejectPlay?.(new Error('aborted'));await h.gate.close();}
});

/** Shares and records (real seed, recorder and transport) until Code opens. */
async function recording(h){
    await h.share();
    await waitFor(()=>h.opened()===1,3000);
}
const index=(calls,call)=>{const at=calls.indexOf(call);assert.notEqual(at,-1,call+' was sent');return at;};

test('a stop confirms the in-flight and the final segment before the checkpoint, even when they outlast the screen bound', async t=>{
    // Review repro: an 11 s segment still uploading and the final one still to seal, on an uplink slower than settleMs.
    const h=harness(t,{prepare:async()=>checkout,media:true,control:recorded({put:sequence=>sequence>0?tick(300):undefined})});
    try{
        const since=recentEvents().length;
        await recording(h);
        // The first recorded segment rotates after 3.5 s; stop while its upload is in flight and the next one is open.
        await waitFor(()=>h.calls.includes('put:1'),6000);await tick(20);
        h.stop();
        assert.equal(h.title(),'Sharing stopped');
        await waitFor(()=>h.title()==='Record this assignment tab',1000);
        assert.equal(h.calls.includes('checkpoint'),false,'the screen is handed back; the footage is still saving');
        assert.equal(h.status(),'Sharing stopped. Your last footage is still uploading. Share this OS tab again to resume.'+CONSENT_TAIL);
        await waitFor(()=>h.calls.includes('checkpoint'),5000);await tick(50);
        const {calls}=h;
        assert.ok(index(calls,'confirm:1')<index(calls,'put:2'),'the in-flight segment is confirmed before the last one is sealed');
        assert.ok(index(calls,'confirm:2')<index(calls,'checkpoint'),'the last segment is confirmed before the checkpoint');
        assert.equal(calls.at(-1),'checkpoint','the transport is released only after the checkpoint');
        assert.equal(calls.filter(c=>c==='checkpoint').length,1);
        assert.equal(h.status(),'Sharing stopped. Share this OS tab again to resume.'+CONSENT_TAIL,'the screen is refreshed once saved');
        const finish=gateEvents(since).filter(e=>e.site==='ezil-os:assignment#finish');
        assert.equal(finish.length,1);
        assert.equal(finish[0].code,'track_ended');
        assert.match(finish[0].detail,/stage:open;reason:sharing_stopped;began:1;accepted:1;saved:1;late:1/);
    }finally{await h.gate.close();}
});

test('a new share sends no begin until the stopped phase is checkpointed, and a stop while it waits releases at once', async t=>{
    // Only the first share's final segment is held in storage; later shares upload at once.
    let releasePut;
    const h=harness(t,{prepare:async()=>checkout,media:true,
        control:recorded({put:sequence=>sequence>0&&!releasePut?new Promise(resolve=>{releasePut=resolve;}):undefined})});
    try{
        await recording(h);
        await tick(60);
        h.stop();
        await waitFor(()=>h.title()==='Record this assignment tab'&&typeof releasePut==='function',1000);
        // Another share while the last segment is still uploading: its checkout is prepared, then it waits.
        await h.share();
        await waitFor(()=>h.status()==='Saving your earlier footage before recording resumes…',1000);
        assert.equal(h.title(),'Preparing assignment');
        assert.equal(h.calls.filter(c=>c==='begin').length,1,'no begin over a phase still saving');
        // Stopped while waiting, it never reached Universe: consent at once, and it never begins.
        h.stop();
        assert.equal(h.title(),'Record this assignment tab');
        assert.equal(h.status(),'Sharing stopped. Share this OS tab again to open your assignment.'+CONSENT_TAIL);
        // A third share waits too, then begins only after the first phase's confirm and checkpoint.
        await h.share();
        await waitFor(()=>h.status()==='Saving your earlier footage before recording resumes…',1000);
        releasePut(new Response(null,{status:200}));
        await waitFor(()=>h.calls.filter(c=>c==='begin').length===2,3000);
        const {calls}=h;
        assert.ok(index(calls,'confirm:1')<index(calls,'checkpoint'));
        assert.ok(index(calls,'checkpoint')<calls.lastIndexOf('begin'),'the next phase begins only after the old one is checkpointed');
        await waitFor(()=>h.opened()===2,3000);
    }finally{releasePut?.(new Response(null,{status:200}));await h.gate.close();}
});

test('closing during the save removes the gate at once and still confirms before it checkpoints', async t=>{
    const h=harness(t,{prepare:async()=>checkout,media:true,control:recorded({put:sequence=>sequence>0?tick(200):undefined})});
    await recording(h);
    await tick(60);
    let closed=false;
    const closing=h.gate.close().then(()=>{closed=true;});
    assert.equal(h.panel().isConnected,false,'the panel is gone at once, never stacked over the next gate');
    assert.equal(h.calls.includes('checkpoint'),false);
    await tick(50);assert.equal(closed,false,'close() resolves only once the footage is saved');
    await closing;
    assert.ok(index(h.calls,'confirm:1')<index(h.calls,'checkpoint'));
});

test('a save that outlasts its ceiling still checkpoints and reports the gap', async t=>{
    const h=harness(t,{prepare:async()=>checkout,media:true,saveCeilingMs:200,
        control:recorded({put:sequence=>sequence>0?new Promise(()=>{}):undefined})});
    try{
        const since=recentEvents().length;
        await recording(h);
        await tick(60);
        h.stop();
        await waitFor(()=>h.calls.includes('checkpoint'),2000);await tick(20);
        assert.equal(h.calls.includes('confirm:1'),false);
        assert.equal(h.status(),'Sharing was interrupted. Your recording may contain a gap.'+CONSENT_TAIL);
        const finish=gateEvents(since).find(e=>e.site==='ezil-os:assignment#finish');
        assert.match(finish.detail,/accepted:1;saved:0;late:1/);
    }finally{await h.gate.close();}
});

test('a stop while begin is still in flight releases the gate and checkpoints the phase once it lands', async t=>{
    let land;
    const h=harness(t,{prepare:async()=>checkout,control:{begin:body=>new Promise(resolve=>{land=()=>resolve(begun(body));}),
        checkpoint:()=>Response.json({status:'paused'})}});
    try{
        await h.share();
        await waitFor(()=>typeof land==='function');
        h.stop();
        await waitFor(()=>h.title()==='Record this assignment tab',1000);
        assert.equal(h.calls.includes('checkpoint'),false);
        land();
        await waitFor(()=>h.calls.includes('checkpoint'));
        await tick(20);
        assert.equal(h.calls.filter(c=>c==='checkpoint').length,1,'the late phase is checkpointed exactly once, never orphaned');
        assert.equal(h.calls.filter(c=>c==='begin').length,1,'and never begun again');
    }finally{await h.gate.close();}
});

test('a failed share names its real cause, claims no footage, and records where it failed', async t=>{
    for(const [code,expected] of [
        ['sandbox_starting','Your computer is still starting. Share this OS tab again to open your assignment.'],
        ['timeout','Your computer is still starting. Share this OS tab again to open your assignment.'],
        ['assignment_open_unavailable','EZiL OS could not reach Universe to verify your assignment. Share this OS tab again to open your assignment.'],
        ['assigned_checkout_unverified','The assigned checkout could not be verified. Share this tab to try again.'],
        ['assignment_recording_required','This assignment opens only in its own recorded EZiL OS tab. Open it again from Universe.'],
        ['billing_concurrent_limit','This computer could not start under your EZiL OS plan. Check Settings, then try again. Share this OS tab again to open your assignment.'],
        ['unknown','Sharing was interrupted before recording started. Share this OS tab again to open your assignment.'],
    ]){
        let prepares=0;
        const h=harness(t,{prepare:async()=>{prepares++;throw Object.assign(new Error('prepare_failed'),{code,reason:'sandbox_starting',correlationId:'srv_0123456789ab'});}});
        try{
            const since=recentEvents().length;
            await h.share();
            await waitFor(()=>h.title()==='Record this assignment tab',3000);
            assert.equal(h.status(),expected+CONSENT_TAIL,code);
            assert.doesNotMatch(h.status(),/Accepted footage/,code);
            assert.equal(prepares,['sandbox_starting','assignment_open_unavailable'].includes(code)?3:1,code+' retries only when retryable');
            assert.equal(h.tracks[0].readyState,'ended');
            const events=gateEvents(since);
            const failed=events.find(e=>e.site==='ezil-os:assignment#prepare');
            assert.equal(failed?.code,code);assert.equal(failed.outcome,'error');
            assert.equal(failed.reason,'sandbox_starting');assert.equal(failed.serverCorrelationId,'srv_0123456789ab');
            const finish=events.find(e=>e.site==='ezil-os:assignment#finish');
            assert.equal(finish?.code,code);assert.equal(finish.outcome,'error',code+' is a fault, not a deliberate stop');
            assert.ok(!JSON.stringify(events).includes(id),'no attempt id in gate telemetry');
        }finally{await h.gate.close();}
    }
});

test('an identity lapse during the share asks for sign-in, not another share', async t=>{
    const h=harness(t,{prepare:async()=>{throw Object.assign(new Error('prepare_failed'),{code:'identity_refresh_required'});}});
    try{
        await h.share();
        await waitFor(()=>h.title()==='Sign in to EZiL OS');
        assert.equal(h.status(),'Return to this assignment after signing in.');
    }finally{await h.gate.close();}
});
