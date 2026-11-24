// clock-gate-test.mjs — EZiL-authored. Run: node --test shell/ezil/assignment-video/clock-gate-test.mjs
//
// The assignment gate against the server's clock (the shell route's `clock` action, answered with no capture lease). The
// server's pause gates capture, nothing local does; the time shown is the server's and outlives a share; capture resumes
// once the server allows and the editor is re-verified; the pause stays a gap on the real timeline; a stop, a close or a
// refresh never touches the timer. Synthetic fixtures only: fake tab, fake encoder, scripted broker answers.
import assert from 'node:assert/strict';
import test from 'node:test';
import {openWithAssignmentConsent} from './shell.js';

const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const recordingId='01111111-2222-4333-8444-555555555555';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
const name=repo.split('/').at(-1).slice(0,-4);
const SHARE='Share this OS tab and open assignment';
const checkout={ok:true,repository:{id:'test',workspaceFolder:'/workspace',checkoutFolder:'/workspace/'+name},assignmentOpen:{attemptId:id,proof:'x'.repeat(60)}};
const folderUrl='https://fixture.test/?'+new URLSearchParams({folder:checkout.repository.checkoutFolder});
const tick=(ms=0)=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,ms=4000){
    const end=Date.now()+ms;
    while(!predicate()){if(Date.now()>end)throw new Error('timed out waiting');await tick(5);}
}
class Element{
    children=[];attrs={};hidden=false;isConnected=true;textContent='';
    setAttribute(n,v){this.attrs[n]=String(v);} append(...c){this.children.push(...c);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}
const ORIGIN='https://os-staging.ezil.work';
const BUCKET='https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const MIN=60000;

/**
 * Scripted broker: the recording protocol (begin, seed, prepare/confirm, status, checkpoint, finalize) and the clock.
 * `clock` is the server's state; `setClock` bumps its revision the way the server does.
 */
function broker({started=false}={}){
    // The media window (begin / seed) bounds the recording; the canonical countdown is `clock`, started by `editor-ready`.
    const startedAt=new Date().toISOString(),mediaDeadlineAt=new Date(Date.now()+10*MIN).toISOString();
    const clock={startedAt:null,deadlineAt:null,pausedAt:null,pauseReason:null,remainingMs:null,revision:1};
    let phase;const prepared=[],clockCalls=[],readyCalls=[],readyScript=[];
    const state={resumeOnReady:false};
    const start=()=>Object.assign(clock,{startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+50*MIN).toISOString(),revision:clock.revision+1});
    if(started)start();
    const control={
        clock:()=>{clockCalls.push(1);return Response.json({serverNow:new Date().toISOString(),...clock});},
        'editor-ready':async body=>{
            readyCalls.push(body);
            const scripted=readyScript.shift();
            if(scripted)return await scripted(body);
            if(clock.startedAt===null)start();
            if(state.resumeOnReady&&clock.pauseReason){Object.assign(clock,{pausedAt:null,pauseReason:null,remainingMs:null,
                deadlineAt:new Date(Date.now()+40*MIN).toISOString(),revision:clock.revision+1});}
            return Response.json({serverNow:new Date().toISOString(),...clock});
        },
        begin:body=>{phase=body.captureSessionId;return Response.json({recordingId,status:'awaiting_frame',captureSessionId:phase,nextSequence:0,
            authorizationExpiresAt:new Date(Date.now()+600000).toISOString(),startedAt:null,deadlineAt:null,revoked:false,stopRequestedAt:null});},
        prepare:body=>{prepared.push({sequence:body.sequence,startMs:body.startMs,endMs:body.endMs});
            return Response.json({putUrl:BUCKET+'/universe-staging/assignment-media/v1/x/'+id+'/'+recordingId+'/segments/'+body.sequence+'/'+body.sha256+'.webm',headers:{}});},
        confirm:body=>Response.json(body.sequence===0?{confirmed:true,recordingId,sequence:0,phaseReady:true,captureSessionId:phase,nextSequence:1,
            firstFrameAt:startedAt,startedAt,deadlineAt:mediaDeadlineAt,serverNow:new Date().toISOString()}:{confirmed:true,recordingId,sequence:body.sequence}),
        status:()=>Response.json({recordingId,captureSessionId:phase,status:'recording',phaseReady:true,workspaceUnlocked:true,
            startedAt,deadlineAt:mediaDeadlineAt,firstFrameAt:startedAt,revoked:false,stopRequestedAt:null}),
        checkpoint:()=>Response.json({status:'paused'}),
        finalize:()=>Response.json({status:'complete'}),
    };
    return {control,clock,prepared,clockCalls,readyCalls,readyScript,state,start,
        set(fields){Object.assign(clock,fields,{revision:fields.revision??clock.revision+1});}};
}
const encoded={count:0};
class FakeFrame{constructor(_s,{timestamp}){this.timestamp=timestamp;} close(){}}
class FakeEncoder{
    static async isConfigSupported(){return {supported:true};}
    state='unconfigured';encodeQueueSize=0;
    constructor({output}){this.output=output;}
    configure(){this.state='configured';}
    encode(frame,{keyFrame}={}){const {timestamp}=frame;encoded.count++;queueMicrotask(()=>this.output({type:keyFrame?'key':'delta',timestamp,byteLength:4,copyTo:b=>b.set([1,2,3,4])}));}
    async flush(){}
    close(){this.state='closed';}
}
const mediaElement={
    video:()=>Object.assign(new Element(),{muted:false,playsInline:false,srcObject:null,videoWidth:1280,videoHeight:720,readyState:4,
        play:async()=>{},pause(){},requestVideoFrameCallback(cb){setTimeout(cb,5);}}),
    canvas:()=>Object.assign(new Element(),{width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}})}),
};

function harness(t,{server=broker(),clockLiveMs=60,clockIdleMs=80,reconnectMs=250,project={repoUrl:repo},href}={}){
    const calls=[],elements=[];
    const saved=['location','VideoEncoder','VideoFrame'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]);
    Object.defineProperty(globalThis,'location',{value:new URL(ORIGIN+'/app/code'),configurable:true,writable:true});
    Object.assign(globalThis,{VideoEncoder:FakeEncoder,VideoFrame:FakeFrame});
    t.after(()=>{for(const [key,descriptor] of saved)if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];});
    t.mock.method(globalThis,'fetch',async(url,options)=>{
        if(options.method==='PUT')return new Response(null,{status:200});
        const body=JSON.parse(options.body);
        if(body.action!=='clock')calls.push(body.action+(Number.isInteger(body.sequence)?':'+body.sequence:''));
        if(server.control[body.action])return server.control[body.action](body);
        if(body.action==='preflight')return Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString()});
        return Response.json({});
    });
    let handle;
    class Track{
        readyState='live';muted=false;handlers={};listeners={};
        getCaptureHandle(){return {origin:ORIGIN,handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){(this.handlers[n]??=new Set()).add(f);this.listeners[n]=()=>[...this.handlers[n]].forEach(h=>h());}
        removeEventListener(n,f){this.handlers[n]?.delete(f);}
        stop(){this.readyState='ended';}
    }
    const tracks=[];
    const stream=()=>{const track=new Track();tracks.push(track);return {getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};};
    const doc={body:new Element(),createElement(tag){const e=mediaElement[tag]?mediaElement[tag]():new Element();e.tag=tag;elements.push(e);return e;}};
    // No `clearTimeout` on this window: the control must use the page's own timers.
    const win={location:new URL(href??ORIGIN+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),crypto:globalThis.crypto,
        isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},MediaStreamTrack:Track,
        VideoFrame:FakeFrame,VideoEncoder:FakeEncoder,performance:globalThis.performance,
        setTimeout:(...a)=>setTimeout(...a),clearTimeout:x=>clearTimeout(x),
        navigator:{mediaDevices:{setCaptureHandleConfig(c){handle=c.handle;},getDisplayMedia:async()=>stream()}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    let opened=0;
    const gate=openWithAssignmentConsent({project,actor:()=>'owner',computerId:'fixture',body:new Element(),park(){},open(){opened++;},
        prepare:async()=>checkout,settleMs:40,saveCeilingMs:3000,clockLiveMs,clockIdleMs,reconnectMs});
    const by=cls=>elements.findLast(e=>e.className==='ezil-assignment-recording-'+cls);
    const buttons=()=>elements.filter(e=>e.tag==='button'&&e.textContent===SHARE);
    return {gate,calls,server,tracks,elements,doc,opened:()=>opened,by,
        root:()=>elements.findLast(e=>e.className==='ezil-assignment-recording-status'),
        title:()=>elements.filter(e=>e.tag==='h2').at(-1)?.textContent,
        label:()=>by('state')?.textContent,time:()=>by('time')?.textContent,
        reconnect:()=>elements.findLast(e=>e.tag==='button'&&e.textContent==='Reconnect editor'),
        async share(){await waitFor(()=>buttons().length>0);buttons().at(-1).onclick({isTrusted:true});},
        async recording(){await this.share();await waitFor(()=>opened>=1);
            this.gate.confirm(new Element(),folderUrl,checkout.repository.checkoutFolder);await waitFor(()=>!this.gate.locked());},
        stop(){tracks.at(-1).listeners.ended();},
        reveal(){const f=new Element();this.gate.confirm(f,folderUrl,checkout.repository.checkoutFolder);return f;}};
}
const pause=(over={})=>({pausedAt:new Date().toISOString(),pauseReason:'system_upgrade',remainingMs:40*MIN,...over});
const resume=(over={})=>({pausedAt:null,pauseReason:null,remainingMs:null,deadlineAt:new Date(Date.now()+40*MIN).toISOString(),...over});

test('a refresh shows the server time before any share and Stop is not offered', async t=>{
    const h=harness(t,{server:broker({started:true})});
    try{
        await waitFor(()=>h.root());
        assert.equal(h.root().attrs['data-state'],'idle');
        assert.equal(h.label(),'Not recording');
        assert.equal(h.by('stop').hidden,true);
        assert.match(h.time(),/^(49|50):\d\d$/,'the server deadline, not a fresh hour');
        assert.equal(h.by('time').attrs.role,'timer');
        assert.equal(h.calls.includes('begin'),false,'rehydrating the clock begins nothing');
    }finally{await h.gate.close();}
});

test('before the server starts the clock the control does not exist and nothing is invented', async t=>{
    const server=broker();Object.assign(server.clock,{startedAt:null,deadlineAt:null});
    const h=harness(t,{server});
    try{
        await waitFor(()=>server.clockCalls.length>=2);
        assert.equal(h.root(),undefined,'no clock, no control');
        server.set({startedAt:new Date().toISOString(),deadlineAt:new Date(Date.now()+60*MIN).toISOString()});
        await waitFor(()=>h.root());
        assert.equal(h.label(),'Not recording');
    }finally{await h.gate.close();}
});

test('the server pause gates capture: recording stops, the editor is covered, the share and its phase stay', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        const {captureSessionId}=h.gate.access();
        await tick(1300);
        assert.equal(h.label(),'Recording');
        h.server.set(pause());
        await waitFor(()=>h.label()==='Paused for system upgrade');
        assert.equal(h.gate.locked(),true);
        assert.equal(h.title(),'Assignment time paused');
        assert.equal(h.root().attrs['data-state'],'paused');
        assert.equal(h.time(),'40:00','the paused remaining time the server reported');
        assert.equal(h.by('stop').hidden,false,'the participant can still stop');
        assert.equal(h.gate.access().captureSessionId,captureSessionId,'the same capture phase can still re-open the editor');
        // The clip up to the pause is sealed and kept (seed + that clip); after that no frame is sampled at all.
        await waitFor(()=>h.server.prepared.length===2);
        await tick(300);
        const frames=encoded.count;
        await tick(2300);
        assert.equal(encoded.count,frames,'no frame is recorded while the server clock is paused');
        assert.equal(h.server.prepared.length,2);
        for(const call of ['checkpoint','finalize'])assert.equal(h.calls.includes(call),false,call+' never runs for a pause');
        assert.equal(h.calls.filter(c=>c==='begin').length,1);
        assert.equal(h.tracks[0].readyState,'live');
    }finally{await h.gate.close();}
});

test('capture resumes once the server allows and the editor is re-verified, on the same phase, with the pause as a real gap', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        const {captureSessionId}=h.gate.access();
        await tick(1300);
        h.server.set(pause());
        await waitFor(()=>h.gate.locked());
        await tick(1800);
        // The re-opened editor is verified while the server is still paused: it stays covered.
        h.reveal();
        await tick(200);
        assert.equal(h.gate.locked(),true,'a verified editor alone does not resume capture');
        assert.equal(h.label(),'Paused for system upgrade');
        h.server.set(resume());
        await waitFor(()=>!h.gate.locked());
        assert.equal(h.label(),'Recording');
        assert.equal(h.gate.access().captureSessionId,captureSessionId);
        assert.match(h.time(),/^(39|40):\d\d$/,'the clock runs again from what the server gave back');
        await tick(2300);
        h.stop();
        await waitFor(()=>h.calls.includes('checkpoint'));
        const {prepared}=h.server;
        assert.deepEqual(prepared.map(p=>p.sequence),prepared.map((_,i)=>i),'one recording, continuous sequences');
        const before=prepared.at(-2),after=prepared.at(-1);
        assert.ok(after.startMs-before.endMs>=1500,'the pause is a gap on the real timeline, not compressed: '+(after.startMs-before.endMs)+' ms');
        assert.equal(h.calls.filter(c=>c==='begin').length,1,'same attempt, same recording, no new begin');
        assert.equal(h.calls.includes('finalize'),false);
    }finally{await h.gate.close();}
});

test('a server that resumes before the editor is verified waits, then offers to reconnect and resumes on its re-verification', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        await tick(1300);
        h.server.set(pause());
        await waitFor(()=>h.gate.locked()&&h.label()==='Paused for system upgrade');
        h.server.set(resume());
        await waitFor(()=>h.title()==='Waiting for your editor');
        assert.equal(h.gate.locked(),true);
        const opened=h.opened();
        await waitFor(()=>h.reconnect(),2000);
        h.reconnect().onclick({isTrusted:true});
        assert.equal(h.opened(),opened+1,'reconnecting asks the editor to open again, nothing else');
        h.reveal();
        await waitFor(()=>!h.gate.locked());
        assert.equal(h.label(),'Recording');
    }finally{await h.gate.close();}
});

test('a stale pause report cannot gate capture after the server resumed it', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        h.server.set({revision:10});
        await tick(200);
        h.server.set({...pause(),revision:5});
        await tick(400);
        assert.equal(h.gate.locked(),false);
        assert.equal(h.label(),'Recording');
    }finally{await h.gate.close();}
});

test('nothing local pauses anything: the gate exposes no pause of its own and a running clock keeps recording', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        assert.equal('systemPause' in h.gate,false,'only the server clock can gate capture');
        await tick(1400);
        assert.equal(h.gate.locked(),false);
        assert.equal(h.label(),'Recording');
        assert.equal(h.calls.includes('checkpoint'),false);
    }finally{await h.gate.close();}
});

test('a stop ends the share, not the time: the control stays, Stop goes, and the clock keeps counting from the server', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        const clocks=h.server.clockCalls.length;
        h.stop();
        await waitFor(()=>h.calls.includes('checkpoint'));
        assert.equal(h.root().isConnected,true);
        assert.equal(h.root().attrs['data-state'],'stopped');
        assert.equal(h.label(),'Sharing stopped');
        assert.equal(h.by('stop').hidden,true);
        const first=h.time();
        await waitFor(()=>h.time()!==first,2500);
        assert.match(h.time(),/^(49|48|47|50):\d\d$/,'still the server time, running');
        await waitFor(()=>h.server.clockCalls.length>clocks+1);
        assert.equal(h.calls.includes('finalize'),false,'a stop never finalizes the assignment');
    }finally{await h.gate.close();}
});

test('a share started again after a stop reuses the same clock, never a new hour', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        h.stop();
        await waitFor(()=>h.calls.includes('checkpoint'));
        const before=h.time();
        await h.share();
        await waitFor(()=>h.opened()>=2,6000);
        assert.match(h.time(),/^(49|48|47|50):\d\d$/);
        assert.notEqual(h.time(),'60:00');
        assert.ok(before);
    }finally{await h.gate.close();}
});

test('closing the window or leaving the page only checkpoints, never finalizes, and removes the control', async t=>{
    const h=harness(t);
    await h.recording();
    const root=h.root();
    await h.gate.close();
    await waitFor(()=>h.calls.includes('checkpoint'));
    assert.equal(h.calls.includes('finalize'),false);
    assert.equal(root.isConnected,false);
});

test('a pause that lasts through a stop leaves the frozen time up and a re-share does not resume it by itself', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        await tick(1300);
        h.server.set(pause({remainingMs:33*MIN}));
        await waitFor(()=>h.gate.locked());
        h.stop();
        await waitFor(()=>h.calls.includes('checkpoint'));
        assert.equal(h.label(),'Sharing stopped');
        assert.equal(h.time(),'33:00');
        await tick(300);
        assert.equal(h.time(),'33:00','frozen by the server');
    }finally{await h.gate.close();}
});

test('an ordinary Code window gets no gate, no control and no clock traffic', async t=>{
    const server=broker();
    const h=harness(t,{server,project:{repoUrl:'https://github.com/example/ordinary.git'},href:ORIGIN+'/app/code'});
    assert.equal(h.gate,null);
    await tick(200);
    assert.equal(h.root(),undefined);
    assert.equal(server.clockCalls.length,0);
    assert.equal(h.elements.filter(e=>e.className?.startsWith('ezil-assignment')).length,0);
});

const confirmedBody=body=>{assert.deepEqual(Object.keys(body).sort(),['action','attemptId','captureSessionId','repoOpenProof']);return body;};
const failing=(status,code)=>async()=>Response.json({error:{code}},{status});

test('the seed window bounds the recording only: the countdown starts at the verified editor, from Universe, with no browser time', async t=>{
    const h=harness(t);
    try{
        await h.share();await waitFor(()=>h.opened()>=1);
        await waitFor(()=>h.root());
        assert.equal(h.time(),'--:--','the media seed (a ten-minute window here) never starts the countdown');
        assert.equal(h.label(),'Recording');
        assert.equal(h.server.readyCalls.length,0,'no editor-ready before an editor was validated');
        let release;const held=new Promise(r=>{release=r;});
        h.server.readyScript.push(async()=>{await held;return Response.json({serverNow:new Date().toISOString(),...h.server.start()&&h.server.clock});});
        const {captureSessionId}=h.gate.access();
        h.reveal();
        await waitFor(()=>h.server.readyCalls.length===1);
        const body=confirmedBody(h.server.readyCalls[0]);
        assert.equal(body.attemptId,id);assert.equal(body.captureSessionId,captureSessionId);assert.equal(body.repoOpenProof,checkout.assignmentOpen.proof);
        await tick(150);
        assert.equal(h.gate.locked(),true,'the editor stays covered until Universe has answered');
        assert.equal(h.time(),'--:--');
        release();
        await waitFor(()=>!h.gate.locked());
        assert.match(h.time(),/^(49|50):\d\d$/,'the canonical 50 minutes, not the 10-minute media window');
        assert.equal(h.server.readyCalls.length,1);
    }finally{await h.gate.close();}
});

test('a transient editor-ready failure is retried with the editor still covered and never released unverified', async t=>{
    const h=harness(t);
    try{
        h.server.readyScript.push(failing(503,'media_unavailable'),failing(503,'media_unavailable'));
        await h.share();await waitFor(()=>h.opened()>=1);
        h.reveal();
        await waitFor(()=>h.server.readyCalls.length>=2);
        assert.equal(h.gate.locked(),true);
        await waitFor(()=>!h.gate.locked(),6000);
        assert.equal(h.server.readyCalls.length,3);
        assert.equal(h.calls.includes('checkpoint'),false,'the share survived the retries');
    }finally{await h.gate.close();}
});

test('when retries run out the editor stays covered and "Check again" asks once more', async t=>{
    const h=harness(t);
    try{
        h.server.readyScript.push(...Array.from({length:4},()=>failing(503,'media_unavailable')));
        await h.share();await waitFor(()=>h.opened()>=1);
        h.reveal();
        await waitFor(()=>h.elements.some(e=>e.tag==='button'&&e.textContent==='Check again'),8000);
        assert.equal(h.gate.locked(),true);
        assert.equal(h.server.readyCalls.length,4);
        h.elements.findLast(e=>e.tag==='button'&&e.textContent==='Check again').onclick({isTrusted:true});
        await waitFor(()=>!h.gate.locked());
        assert.equal(h.server.readyCalls.length,5);
    }finally{await h.gate.close();}
});

test('a refusal of editor-ready ends the share without ever showing the editor', async t=>{
    const h=harness(t);
    try{
        h.server.readyScript.push(failing(409,'recording_refused'));
        await h.share();await waitFor(()=>h.opened()>=1);
        h.reveal();
        await waitFor(()=>h.calls.includes('checkpoint'));
        assert.equal(h.gate.locked(),true);
        assert.equal(h.server.readyCalls.length,1,'not retried');
        assert.equal(h.server.clock.startedAt,null,'nothing started the countdown');
        assert.equal(h.calls.includes('finalize'),false);
    }finally{await h.gate.close();}
});

test('the server can resume the pause when the re-verified editor reports ready: capture resumes with no further poll needed', async t=>{
    const h=harness(t);
    try{
        await h.recording();
        await tick(1300);
        h.server.set(pause());
        h.server.state.resumeOnReady=true;
        await waitFor(()=>h.gate.locked()&&h.label()==='Paused for system upgrade');
        const readyBefore=h.server.readyCalls.length;
        h.reveal();
        await waitFor(()=>h.server.readyCalls.length===readyBefore+1);
        confirmedBody(h.server.readyCalls.at(-1));
        await waitFor(()=>!h.gate.locked());
        assert.equal(h.label(),'Recording');
        assert.match(h.time(),/^(39|40):\d\d$/);
        assert.equal(h.calls.filter(c=>c==='begin').length,1);
    }finally{await h.gate.close();}
});
