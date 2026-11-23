// gate-stop-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/gate-stop-test.mjs
//
// The assignment share gate after a stop or a failed share (prod incident 2026-11-23, attempt 96b3bb7d): the gate must
// never sit on "Checking saved assignment footage…", a stop must cancel its own computer wake (and only its own), a
// begun phase is checkpointed exactly once within a bound, the copy names the real cause, and every end of a share
// leaves gate evidence in telemetry's local mirror for a feedback report.
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

/** One OS tab on os-staging with the gate armed. `control[action]` answers the assignment-video route; preflight is eligible. */
function harness(t,{prepare,control={},video,settleMs=40}={}){
    const calls=[],elements=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        const body=JSON.parse(options.body);calls.push(body.action);
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
    const doc={body:new Element(),createElement(tag){const e=tag==='video'&&video?video():new Element();e.tag=tag;elements.push(e);return e;}};
    const win={location:new URL('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),crypto:globalThis.crypto,
        isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},MediaStreamTrack:Track,VideoFrame:class{},VideoEncoder:class{},
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream()}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    let opened=0;
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){opened++;},prepare,settleMs});
    const buttons=()=>elements.filter(e=>e.tag==='button'&&e.textContent===SHARE);
    return {gate,calls,tracks,opened:()=>opened,
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

test('a stop after begin checkpoints that phase exactly once within the bound, even while the seed frame hangs', async t=>{
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
        assert.equal(h.calls.filter(c=>c==='checkpoint').length,1);
        assert.equal(h.status(),'Sharing stopped. Share this OS tab again to open your assignment.'+CONSENT_TAIL,
            'no footage is claimed: no segment was confirmed');
        const finish=gateEvents(since).find(e=>e.site==='ezil-os:assignment#finish');
        assert.match(finish.detail,/stage:seed;reason:sharing_stopped;began:1;accepted:0;saved:1;late:1/);
        rejectPlay(new Error('aborted'));await tick(10);
        assert.equal(h.calls.filter(c=>c==='checkpoint').length,1);assert.equal(h.opened(),0);
    }finally{rejectPlay?.(new Error('aborted'));await h.gate.close();}
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
