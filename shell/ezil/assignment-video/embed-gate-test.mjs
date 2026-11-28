// The assignment embedded by its own Universe workspace page (`ezil.assignment.work/v2`), on the production pair
// os.ezil.work inside universe.ezil.work (and the staging pair, which shares the code).
//
// Run:  node shell/ezil/assignment-video/embed-gate-test.mjs
//
// The parent half below replays the message sequence of Universe's `assignment-work-capture.js`
// (discover → bind+port → begin → seed upload → unlock → pulses/segments → lock → end). That file is not executed here.
// The fake server is the OS's own `/api/shell/assignment-video` route as the transport sees it, with the two clocks kept
// apart as production keeps them: the recording's MEDIA window and the assignment's CLOCK (`clock`, `editor-ready`).
import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmAssignmentFolder,openWithAssignmentConsent} from './shell.js';

const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
const PROD={os:'https://os.ezil.work',universe:'https://universe.ezil.work',
    bucket:'https://ezil-universe-production-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',prefix:'/universe-production/assignment-media/v1/'};
const STAGE={os:'https://os-staging.ezil.work',universe:'https://universe-staging.ezil.work',
    bucket:'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',prefix:'/universe-staging/assignment-media/v1/'};
const protocol='ezil.assignment.work/v2';
const challenge='0f0e5a9c-3c52-4d8e-9b55-0d7f3b6f8a11',session='5b9a2c1e-7d64-4f0a-8e3b-2c1d0e9f8a7b',session2='6c0b3d2f-8e75-4a1b-9f4c-3d2e1f0a9b8c';
const recordingId='9c1d7a3e-2b4f-4e6a-8d1c-3f5a7b9e0c2d',proof='p'.repeat(60);
const workspaceFolder='/workspace',checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
const checkout={ok:true,repository:{id:'provider-repo',workspaceFolder,checkoutFolder},assignmentOpen:{attemptId:id,proof}};
const HOUR=3600000;
const iso=ms=>ms===null||ms===undefined?null:new Date(ms).toISOString();
const settle=(ms=5)=>new Promise(r=>setTimeout(r,ms));
async function until(check,what,ms=4000){
    for(const end=Date.now()+ms;Date.now()<end;){if(check())return;await settle(10);}
    assert.fail('timed out waiting for '+what);
}
class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(name,value){this[name]=value;} append(...children){this.children.push(...children);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}
function embeddedWindow({site=PROD,ancestors,url}={}){
    const entry=url??site.os+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
    const listeners=new Map(),posted=[],assigned=[],opened=[],elements=[];
    const top={postMessage:(...args)=>posted.push(args)};
    const location=Object.assign(new URL(entry),{assign:target=>assigned.push(target)},ancestors?{ancestorOrigins:ancestors}:{});
    const doc={body:new Element(),createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;},addEventListener(){},removeEventListener(){}};
    const win={location,top,parent:top,document:doc,crypto:globalThis.crypto,open:(...args)=>opened.push(args),
        setTimeout,clearTimeout,isSecureContext:true,VideoFrame:class{},VideoEncoder:class{},MediaStreamTrack:class{},
        navigator:{mediaDevices:{getDisplayMedia(){throw Error('the tab picker must not run in the frame');},
            setCaptureHandleConfig(){throw Error('no capture handle in the frame');}}},
        addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
        removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn)};
    Object.assign(globalThis,{window:win,document:doc,location});
    const dispatch=(data,source,origin,ports=[])=>{for(const fn of [...(listeners.get('message')??[])])fn({source,origin,data,ports});};
    const discover=(overrides={},source=top,origin=site.universe)=>dispatch({protocol,type:'discover',attemptId:id,challenge,...overrides},source,origin);
    const bind=(ports,overrides={},source=top,origin=site.universe)=>dispatch({protocol,type:'bind',attemptId:id,challenge,...overrides},source,origin,ports);
    const types=()=>posted.map(([data,origin])=>{assert.equal(origin,site.universe);assert.deepEqual(Object.keys(data).sort(),['attemptId','challenge','protocol','type']);
        assert.equal(data.attemptId,id);return data.type;});
    const shown=text=>elements.some(e=>e.isConnected&&e.textContent===text);
    const button=text=>elements.findLast(e=>e.tag==='button'&&e.isConnected&&e.textContent===text);
    return {win,top,site,posted,assigned,opened,discover,bind,types,shown,button,listeners,elements};
}
// The parent's half of the port: numbered requests, transferable segment bytes.
function parentPort(){
    const channel=new MessageChannel(),got=[],waiting=new Map();let next=0;
    channel.port1.onmessage=event=>{const d=event.data;got.push(d);
        if(d?.type==='reply'){const done=waiting.get(d.id);waiting.delete(d.id);done?.(d);}};
    const post=(type,fields={},transfer=[])=>channel.port1.postMessage({protocol,attemptId:id,type,...fields},transfer);
    const rpc=(method,fields={},transfer=[])=>new Promise(resolve=>{const n=++next;waiting.set(n,resolve);post('request',{id:n,method,...fields},transfer);});
    // `types`: the vocabulary an older parent reads. `all` adds the two additive events it ignores (`capture-ready`,
    // `editor-usable`), in the order they arrived.
    const additive=['capture-ready','editor-usable'];
    return {port:channel.port2,got,post,rpc,types:()=>got.filter(d=>d.type!=='reply'&&!additive.includes(d.type)).map(d=>d.type),
        all:()=>got.filter(d=>d.type!=='reply').map(d=>d.type),events:type=>got.filter(d=>d.type===type),
        close(){channel.port1.close();channel.port2.close();}};
}
const eligibleBody=extra=>({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:iso(Date.now()+60000),windowStartedAt:null,deadlineAt:null,...extra});
/**
 * `media`: the recording's own window (seed confirm, status). `canon`: the assignment's clock (`clock`, `editor-ready`),
 * not started until the first `editor-ready` unless a test presets it (an attempt Universe's workspace page started).
 */
function fakeServer({site=PROD,stopReason=null,readyBeforeSeed=false,holdSeed=null,failSeedOnce=false,preflight={},clockStart=null}={}){
    const log=[],began=Date.now(),seeds=new Set(),readyProofs=[];
    const media={start:began-1000,deadline:began+1800000};
    const canon={start:clockStart,deadline:clockStart===null?null:clockStart+HOUR,pausedAt:null,revision:clockStart===null?0:1};
    let next=0,stopAt=null,serverNow=null;
    const clock=()=>({serverNow:iso(Date.now()),startedAt:iso(canon.start),deadlineAt:iso(canon.deadline),pausedAt:iso(canon.pausedAt),
        pauseReason:canon.pausedAt===null?null:'system_upgrade',
        remainingMs:canon.start===null?null:Math.max(0,Math.min(HOUR,canon.deadline-(canon.pausedAt??Date.now()))),revision:canon.revision});
    const api={log,media,canon,clock,readyProofs,onEditorReady:null,serverNow:()=>serverNow,stop(at){stopAt=at;},
        pause(){canon.pausedAt=Date.now();canon.revision++;return canon.pausedAt;},
        resume(){canon.deadline+=Date.now()-canon.pausedAt;canon.pausedAt=null;canon.revision++;},
        count:action=>log.filter(x=>x===action).length};
    api.handler=async(path,options)=>{
        if(String(path).startsWith(site.bucket)){log.push('put');return new Response(null,{status:200});}
        assert.equal(path,'/api/shell/assignment-video');
        const body=JSON.parse(options.body),cs=body.captureSessionId;
        if(body.action!=='clock')log.push(body.action==='begin'?['begin',body.consentVersion,cs,body.repoOpenProof]:body.action);
        const same={recordingId,captureSessionId:cs};
        if(body.action==='preflight')return Response.json(eligibleBody(typeof preflight==='function'?preflight():preflight));
        if(body.action==='clock')return Response.json(clock());
        if(body.action==='editor-ready'){
            readyProofs.push([cs,body.repoOpenProof]);
            const override=api.onEditorReady?.(readyProofs.length);
            if(override)return override;
            // The first verified editor starts the assignment's time; afterwards the same clock is only reported.
            if(canon.start===null){canon.start=Date.now();canon.deadline=canon.start+HOUR;canon.revision++;}
            return Response.json(clock());
        }
        if(body.action==='begin'){
            if(canon.pausedAt!==null)return Response.json({error:{code:'recording_closed'}},{status:409});
            return Response.json({...same,status:'awaiting_frame',nextSequence:next,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
                authorizationExpiresAt:iso(Date.now()+600000)});
        }
        if(body.action==='prepare')return Response.json({expiresAt:iso(Date.now()+60000),headers:{'content-type':'video/webm'},
            putUrl:`${site.bucket}${site.prefix}o/${id}/${recordingId}/segments/${body.sequence}/${body.sha256}.webm`});
        if(body.action==='confirm'){
            const seed=!seeds.has(cs);
            if(seed && failSeedOnce){failSeedOnce=false;return Response.json({error:{code:'media_unavailable'}},{status:503});}
            if(seed && holdSeed)await holdSeed;
            seeds.add(cs);next=Math.max(next,body.sequence+1);
            return Response.json(seed?{...same,sequence:body.sequence,confirmed:true,phaseReady:true,nextSequence:body.sequence+1,firstFrameAt:iso(began),
                startedAt:iso(media.start),deadlineAt:iso(media.deadline),serverNow:serverNow=iso(Date.now()+2345),revision:canon.revision}
                :{recordingId,sequence:body.sequence,confirmed:true});
        }
        const ok=seeds.has(cs)||readyBeforeSeed;
        if(body.action==='status')return Response.json({...same,status:'recording',phaseReady:ok,workspaceUnlocked:ok,startedAt:iso(media.start),
            deadlineAt:iso(media.deadline),firstFrameAt:iso(began),stopRequestedAt:stopAt,stopReason:stopAt?stopReason:null,revoked:false});
        return Response.json({...same,status:'paused',startedAt:iso(media.start),deadlineAt:iso(media.deadline),stopRequestedAt:null,revoked:false});
    };
    return api;
}
function embeddedGate(w,{who='owner',prepare=()=>assert.fail('checkout must stay closed'),open=()=>assert.fail('editor must stay closed'),
    computerInfo=async()=>({provider:'cloudflare'}),...rest}={}){
    return openWithAssignmentConsent({project:{repoUrl:repo},actor:typeof who==='function'?who:()=>who,computerId:'fixture',body:new Element(),park(){},
        prepare,open,computerInfo,clockLiveMs:25,clockIdleMs:25,...rest});
}
const seedPart=(fields={})=>({sequence:0,startMs:0,endMs:1,mimeType:'video/webm',bytes:new Uint8Array([26,69,223,163,1]).buffer,...fields});
// Discover, bind and wait for port `ready`, as the parent does before it offers Share.
async function bound(w,p){w.discover();w.bind([p.port]);await until(()=>p.types().includes('ready'),'port ready');assert.deepEqual(p.types(),['ready']);}
function editorOpener(state,{root=checkoutFolder,folder=workspaceFolder}={}){
    const frame={isConnected:true,contentWindow:{postMessage(){}}};
    return ()=>{state.opened++;state.access=state.gate.access();
        queueMicrotask(()=>confirmAssignmentFolder({repoUrl:repo},null,frame,'https://code.example/?folder='+encodeURIComponent(folder)+'&ezil_mint=m',root));};
}
/** One whole share, to an open editor: begin, the first frame, unlock. Returns the unlock reply's value. */
async function shareToEditor(p,capture=session,sequence=0){
    const grant=await p.rpc('begin',{captureSessionId:capture,consentVersion:4});
    assert.equal(grant.ok,true,grant.code);assert.equal(grant.value.nextSequence,sequence);
    const seed=seedPart({sequence});
    const first=await p.rpc('upload',{captureSessionId:capture,part:seed},[seed.bytes]);
    assert.equal(first.ok,true,first.code);
    const unlocked=await p.rpc('unlock',{captureSessionId:capture});
    assert.equal(unlocked.ok,true,unlocked.code);
    return {seed:first.value,unlock:unlocked.value};
}

for(const site of [PROD,STAGE]){
    test(`${site.os}: the paired Universe parent records, unlocks and ends the embedded assignment through the bound port only`,async t=>{
        const server=fakeServer({site});t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow({site}),p=parentPort(),state={opened:0,access:null},prepares=[];
        const gate=state.gate=embeddedGate(w,{prepare:async(attempt,options)=>{prepares.push([attempt,options.signal.aborted]);return checkout;},open:editorOpener(state)});
        let lockedAtReady;
        server.onEditorReady=()=>{lockedAtReady=[gate.locked(),state.opened];};
        try{
            await settle();assert.deepEqual(server.log,[],'nothing is fetched before a valid discover');
            await bound(w,p);
            assert.deepEqual(w.types(),['preparing']);assert.deepEqual(server.log,['preflight']);assert.deepEqual(prepares,[]);
            const grant=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            assert.deepEqual(grant,{protocol,attemptId:id,type:'reply',id:1,ok:true,value:{captureSessionId:session,status:'awaiting_frame',nextSequence:0}});
            assert.deepEqual(prepares,[[id,false]]);
            assert.deepEqual(server.log.slice(1),['preflight',['begin',4,session,proof]]);
            assert.equal(gate.access(),null,'no mint before the first frame is confirmed');
            const seed=seedPart();
            const ready=await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            // The MEDIA window and the broker's own (here deliberately skewed) clock reach the parent's encoder unchanged.
            assert.deepEqual(ready.value,{confirmed:true,phaseReady:true,captureSessionId:session,nextSequence:1,startedAt:iso(server.media.start),
                deadlineAt:iso(server.media.deadline),serverNow:server.serverNow(),revision:0});
            assert.equal(server.canon.start,null,'a recorded first frame alone never starts the assignment clock');
            // `status` relays the media cutoff as the broker last stated it (this capture, the seed's own start).
            assert.deepEqual((await p.rpc('status',{captureSessionId:session})).value,{captureSessionId:session,status:'recording',stopRequestedAt:null,
                deadlineAt:iso(server.media.deadline)});
            assert.equal(gate.access(),null);assert.equal(server.count('editor-ready'),0);
            const unlocked=await p.rpc('unlock',{captureSessionId:session});
            // The real Code folder was validated first, then `editor-ready` (this phase, its sealed proof) answered, and only then the editor showed.
            assert.deepEqual(lockedAtReady,[true,1]);
            assert.deepEqual(server.readyProofs,[[session,proof]]);
            assert.notEqual(server.canon.start,server.media.start);
            assert.deepEqual(unlocked.value,{status:'ready',captureSessionId:session,startedAt:iso(server.media.start),deadlineAt:iso(server.media.deadline),
                clock:{startedAt:iso(server.canon.start),deadlineAt:iso(server.canon.deadline),serverNow:unlocked.value.clock.serverNow,pausedAt:null,
                    remainingMs:unlocked.value.clock.remainingMs,revision:1}});
            assert.ok(unlocked.value.clock.remainingMs>HOUR-5000 && unlocked.value.clock.remainingMs<=HOUR);
            assert.equal(state.opened,1);
            assert.deepEqual(state.access,{attemptId:id,phase:'open',repoOpenProof:proof,captureSessionId:session});
            assert.equal(gate.locked(),false);assert.deepEqual(w.types(),['preparing','ready']);
            p.post('pulse',{captureSessionId:session});
            const clip=seedPart({sequence:1,startMs:0,endMs:11000});
            assert.deepEqual((await p.rpc('upload',{captureSessionId:session,part:clip},[clip.bytes])).value,{confirmed:true,sequence:1});
            p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});await settle();
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.deepEqual(w.types(),['preparing','ready','preparing']);
            const ended=await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:2});
            assert.deepEqual(ended.value,{});
            assert.equal(server.log.at(-1),'checkpoint');
            assert.equal(server.count('put'),2);assert.equal(server.count('editor-ready'),1);
            const wire=JSON.stringify([...p.got,...w.posted]);
            assert.ok(!wire.includes(proof)&&!wire.includes(recordingId)&&!wire.includes(site.bucket),'the proof, recording and signed upload stay in the OS');
            assert.deepEqual([w.assigned,w.opened],[[],[]]);
        }finally{await gate.close();await settle();p.close();}
        assert.deepEqual(p.types(),['ready','reopen']);
        // The two additive events: the bind was accepted before eligibility answered, and the editor became usable
        // after `editor-ready`, carrying only this capture and the assignment's own clock.
        assert.deepEqual(p.all(),['capture-ready','ready','editor-usable','reopen']);
        assert.deepEqual(p.events('editor-usable'),[{protocol,attemptId:id,type:'editor-usable',captureSessionId:session,
            deadlineAt:iso(server.canon.deadline),serverNow:p.events('editor-usable')[0].serverNow}]);
        assert.ok(Number.isFinite(Date.parse(p.events('editor-usable')[0].serverNow)));
    });
}
test('a bind is accepted only from the actual paired Universe parent, for the answered challenge, with exactly one port, once',async t=>{
    t.mock.method(globalThis,'fetch',fakeServer().handler);
    const w=embeddedWindow(),wrong=[];
    const gate=embeddedGate(w);
    const probe=()=>{const p=parentPort();wrong.push(p);return p;};
    try{
        const early=probe();w.bind([early.port]);
        // The other deployment's Universe is no parent of production: it is neither answered nor allowed to bind.
        w.discover({},w.top,STAGE.universe);w.discover({},{},PROD.universe);w.discover({},w.top,'https://universe.ezil.work.evil.example');
        await settle();assert.deepEqual(w.posted,[]);
        w.discover();await settle();
        const cases=[[{}, {}],[{}, w.top,STAGE.universe],[{}, w.top,'https://os.ezil.work'],[{challenge:session}],[{attemptId:session}],[{protocol:'ezil.assignment.work/v1'}]];
        for(const [overrides,source=w.top,origin=PROD.universe] of cases){const p=probe();w.bind([p.port],overrides,source,origin);}
        const two=probe(),extra=new MessageChannel();w.bind([two.port,extra.port1]);extra.port1.close();extra.port2.close();
        w.bind([]);
        await settle();
        for(const p of wrong){void p.rpc('begin',{captureSessionId:session,consentVersion:4});}
        await settle();
        assert.ok(wrong.every(p=>p.got.length===0),'no unbound port is ever answered');
        const good=parentPort(),second=parentPort();
        w.bind([good.port]);w.bind([second.port]);await until(()=>good.types().length,'ready');
        assert.deepEqual(good.types(),['ready']);
        void second.rpc('status',{captureSessionId:session});await settle();
        assert.deepEqual(second.got,[]);
        good.close();second.close();
    }finally{await gate.close();wrong.forEach(p=>p.close());}
});
test('a frame that is not the direct child of its own paired Universe keeps the top-level locked view and never answers or binds',async t=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected network');});
    for(const options of [{ancestors:['https://evil.example']},{ancestors:[STAGE.universe]},{ancestors:[PROD.universe,PROD.universe]},{ancestors:[]},
        {site:STAGE,ancestors:[PROD.universe]}]){
        const w=embeddedWindow(options),p=parentPort();
        const gate=embeddedGate(w);
        try{
            w.discover({},w.top,PROD.universe);w.discover({},w.top,STAGE.universe);
            w.bind([p.port],{},w.top,PROD.universe);w.bind([p.port],{},w.top,STAGE.universe);await settle();
            void p.rpc('begin',{captureSessionId:session,consentVersion:4});await settle();
            assert.deepEqual([w.posted,p.got],[[],[]],JSON.stringify(options));
            assert.ok(w.shown('Open your assigned OS tab'));assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        }finally{await gate.close();p.close();}
    }
    assert.equal(fetch.mock.callCount(),0);
});
test('begin waits for eligibility, needs the parent consent version and a capture id, and starts only on request',async t=>{
    let release;const gateOpen=new Promise(r=>release=r);const server=fakeServer();
    t.mock.method(globalThis,'fetch',async(path,options)=>{if(JSON.parse(options.body).action==='preflight')await gateOpen;return server.handler(path,options);});
    const w=embeddedWindow(),p=parentPort();let prepares=0;
    const gate=embeddedGate(w,{prepare:async()=>{prepares++;return new Promise(()=>{});}});
    try{
        w.discover();w.bind([p.port]);await settle();
        assert.deepEqual(p.types(),[],'no port ready before eligibility');
        assert.deepEqual((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_not_ready');
        release();await until(()=>p.types().length,'ready');
        assert.deepEqual(p.types(),['ready']);
        for(const fields of [{captureSessionId:session,consentVersion:3},{captureSessionId:session,consentVersion:'4'},{captureSessionId:session},
            {captureSessionId:'not-a-session',consentVersion:4},{consentVersion:4}])
            assert.equal((await p.rpc('begin',fields)).code,'assignment_not_ready',JSON.stringify(fields));
        assert.equal((await p.rpc('erase',{captureSessionId:session})).code,'invalid_request');
        assert.equal((await p.rpc('toString',{captureSessionId:session})).code,'invalid_request');
        assert.equal(prepares,0);assert.deepEqual(server.log,['preflight']);
    }finally{await gate.close();p.close();}
});
test('the seed must be the granted first frame, and unlock needs a confirmed seed for the same capture',async t=>{
    // Even a status that already claims an unlocked phase cannot replace this document's own confirmed seed.
    const server=fakeServer({readyBeforeSeed:true});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:()=>state.opened++});
    try{
        await bound(w,p);
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seedPart()})).code,'recording_phase_changed','no upload before begin');
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const other='11111111-1111-4111-8111-111111111111';
        for(const method of ['upload','status','unlock','end'])
            assert.equal((await p.rpc(method,{captureSessionId:other,reason:'sharing_stopped',part:seedPart()})).code,'recording_phase_changed',method);
        assert.equal((await p.rpc('unlock',{captureSessionId:session})).code,'seed_not_confirmed');
        for(const part of [seedPart({sequence:1}),seedPart({endMs:1000}),seedPart({startMs:1,endMs:2}),seedPart({bytes:new Uint8Array(1024*1024+1).buffer}),
            seedPart({bytes:[1,2,3]}),seedPart({bytes:new ArrayBuffer(0)}),seedPart({mimeType:'video/mp4'}),{...seedPart(),sequence:600}])
            assert.equal((await p.rpc('upload',{captureSessionId:session,part})).code,'invalid_segment',JSON.stringify({...part,bytes:part.bytes?.byteLength}));
        assert.ok(!server.log.includes('prepare')&&!server.log.includes('put'),'no invalid part reaches the media service');
        assert.equal(state.opened,0);assert.equal(gate.access(),null);assert.equal(server.count('editor-ready'),0);
    }finally{await gate.close();p.close();}
});
test('an editor on any folder but the verified checkout fails unlock, never tells Universe it is ready, and stays locked',async t=>{
    for(const [root,folder] of [['/root',workspaceFolder],[checkoutFolder,'/elsewhere']]){
        const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state,{root,folder})});
        try{
            await bound(w,p);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            assert.equal((await p.rpc('unlock',{captureSessionId:session})).code,'assigned_checkout_unverified');
            assert.equal(state.opened,1);assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.deepEqual(w.types(),['preparing']);
            assert.equal(server.count('editor-ready'),0);assert.equal(server.canon.start,null,'no clock starts for an unverified folder');
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('editor-ready is retried while Universe is unreachable, and its refusal or a failed open mint keeps the editor closed',async t=>{
    const transient=()=>Response.json({error:{code:'media_unavailable'}},{status:503});
    // Transient: asked again with the editor still covered, then opened once.
    {
        const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
        const covered=[];
        server.onEditorReady=n=>{covered.push(gate.locked());return n<3?transient():null;};
        try{
            await bound(w,p);
            const {unlock}=await shareToEditor(p);
            assert.deepEqual(covered,[true,true,true]);assert.equal(state.opened,1);assert.equal(gate.locked(),false);
            assert.equal(unlock.clock.startedAt,iso(server.canon.start));
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
    // Refused by Universe, or the open-phase mint itself failed (Code tells the gate): the real code reaches the parent.
    for(const [how,code] of [['refused','recording_refused'],['mint','assignment_recording_required']]){
        const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const open=how==='mint'?()=>{state.opened++;queueMicrotask(()=>state.gate.fail({errorCode:code,reason:'r',correlationId:'c'}));}:editorOpener(state);
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open});
        server.onEditorReady=()=>Response.json({error:{code}},{status:409});
        try{
            await bound(w,p);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            assert.equal((await p.rpc('unlock',{captureSessionId:session})).code,code,how);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.deepEqual(w.types(),['preparing']);
            assert.equal(server.canon.start,null);assert.equal(server.count('editor-ready'),how==='mint'?0:1);
            // The phase is still the parent's to end; nothing was lost.
            assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'connection_lost',expectedSegments:1})).value,{});
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('the original assignment clock is kept: an editor-ready that names another start never opens the editor',async t=>{
    const T0=Date.now()-120000;
    for(const [what,preflight,clockStart] of [
        // Universe's workspace page started this attempt's window before any computer opened it.
        ['the preflight window',{windowStartedAt:iso(T0),deadlineAt:iso(T0+HOUR),boundWorkspaceId:null,startMode:'workspace'},null],
        // The clock was already running when this document loaded (a refresh, a second share).
        ['an earlier clock report',{},T0],
    ]){
        const server=fakeServer({preflight,clockStart});t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
        // A restarted hour: the clock Universe must never hand out for an attempt that already has one.
        server.onEditorReady=()=>Response.json({serverNow:iso(Date.now()),startedAt:iso(Date.now()),deadlineAt:iso(Date.now()+HOUR),pausedAt:null,
            pauseReason:null,remainingMs:HOUR,revision:9});
        try{
            await bound(w,p);await settle(40);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            assert.equal((await p.rpc('unlock',{captureSessionId:session})).code,'assignment_clock_changed',what);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.deepEqual(w.types(),['preparing']);
            await p.rpc('end',{captureSessionId:session,reason:'connection_lost',expectedSegments:1});
            // The same start, serialized at another precision, is the same clock: the next share opens on it.
            server.canon.start=T0;server.canon.deadline=T0+HOUR;server.canon.revision=10;
            server.onEditorReady=()=>Response.json({...server.clock(),startedAt:new Date(T0).toISOString().replace('.000Z','+00:00')});
            const {unlock}=await shareToEditor(p,session2,1);
            assert.equal(Date.parse(unlock.clock.startedAt),T0,what);assert.equal(unlock.clock.deadlineAt,iso(T0+HOUR));
            assert.equal(gate.locked(),false);assert.deepEqual(w.types(),['preparing','ready']);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a server pause covers the editor and ends the capture at its own time; the same frame re-shares on the original clock once time runs again',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0},prepares=[];
    const gate=state.gate=embeddedGate(w,{prepare:async()=>{prepares.push(1);return checkout;},open:editorOpener(state)});
    try{
        await bound(w,p);
        const first=await shareToEditor(p);
        assert.equal(gate.locked(),false);
        const pausedAt=server.pause();
        await until(()=>p.types().includes('pause'),'the pause to reach the parent');
        assert.deepEqual(p.got.filter(d=>d.type==='pause'),[{protocol,attemptId:id,type:'pause',reason:'paused',effectiveAt:iso(pausedAt)}]);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.ok(w.shown('Assignment time paused'));
        assert.deepEqual(w.types(),['preparing','ready','preparing']);
        // The parent cuts its last clip at the pause, then ends the phase as an interruption: a checkpoint, never a finalize.
        assert.equal((await p.rpc('status',{captureSessionId:session})).value.stopRequestedAt,iso(pausedAt));
        assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'connection_lost',expectedSegments:1})).value,{});
        assert.equal(server.log.at(-1),'checkpoint');assert.equal(server.count('finalize'),0);
        assert.ok(w.shown('Assignment time paused')&&!w.shown('Sharing paused'),'the ended share still says why it cannot resume yet');
        // While the time is stopped nothing new starts: no checkout is sealed and no phase is asked for.
        const begins=()=>server.log.filter(Array.isArray).length;
        assert.equal((await p.rpc('begin',{captureSessionId:session2,consentVersion:4})).code,'assignment_paused');
        assert.equal(prepares.length,1);assert.equal(begins(),1);assert.equal(gate.locked(),true);
        assert.deepEqual(p.types(),['ready','pause']);
        // Universe gives the stopped time back and the clock runs again: the same port says so, and the same frame re-shares.
        server.resume();
        await until(()=>p.types().length===3,'ready after the pause');
        assert.deepEqual(p.types(),['ready','pause','ready']);assert.equal(gate.locked(),true);
        const second=await shareToEditor(p,session2,1);
        assert.equal(prepares.length,2,'the checkout is sealed again for the new share');
        assert.equal(second.unlock.clock.startedAt,first.unlock.clock.startedAt,'the original start');
        assert.ok(Date.parse(second.unlock.clock.deadlineAt)>Date.parse(first.unlock.clock.deadlineAt),'the stopped time was given back');
        assert.equal(second.unlock.clock.revision,3);
        assert.equal(state.opened,2);assert.equal(gate.locked(),false);
        assert.deepEqual(state.access,{attemptId:id,phase:'open',repoOpenProof:proof,captureSessionId:session2});
        assert.deepEqual(w.types(),['preparing','ready','preparing','ready']);
        assert.deepEqual(server.readyProofs.map(([capture])=>capture),[session,session2]);
        assert.deepEqual([w.assigned,w.opened],[[],[]]);
    }finally{await gate.close();await settle();p.close();}
});
test('a pause that is already there when the frame loads offers no share until time runs again, and a paused editor-ready opens nothing',async t=>{
    const T0=Date.now()-60000;
    const server=fakeServer({clockStart:T0});server.pause();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        w.discover();w.bind([p.port]);await settle(120);
        assert.deepEqual(p.types(),[],'a paused assignment is not ready to share');assert.ok(w.shown('Assignment time paused'));
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_paused');
        server.resume();await until(()=>p.types().length===1,'ready');
        // The pause returns between the first frame and the editor: `editor-ready` answers a stopped clock.
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        let pausedAt;
        server.onEditorReady=()=>{pausedAt=server.pause();return null;};
        const refused=await p.rpc('unlock',{captureSessionId:session});
        assert.ok(['workspace_locked','assignment_paused'].includes(refused.code),refused.code);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.deepEqual(w.types(),['preparing']);
        assert.deepEqual(p.got.filter(d=>d.type==='pause'),[{protocol,attemptId:id,type:'pause',reason:'paused',effectiveAt:iso(pausedAt)}]);
        assert.equal(server.canon.start,T0);
    }finally{await gate.close();p.close();}
});
test('share restart: after a stopped share ends, a new capture on the same port reopens the editor on the same clock',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0,access:null},prepares=[];
    const gate=state.gate=embeddedGate(w,{prepare:async()=>{prepares.push(1);return checkout;},open:editorOpener(state)});
    try{
        await bound(w,p);
        const first=await shareToEditor(p);
        const clip=seedPart({sequence:1,startMs:0,endMs:11000});
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:clip},[clip.bytes])).ok,true);
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});await settle();
        assert.equal(gate.locked(),true);
        // Before the first phase has ended, a different capture cannot start.
        assert.equal((await p.rpc('begin',{captureSessionId:session2,consentVersion:4})).code,'recording_in_use');
        assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:2})).value,{});
        assert.deepEqual(w.types(),['preparing','ready','preparing']);
        const grant=await p.rpc('begin',{captureSessionId:session2,consentVersion:4});
        assert.deepEqual(grant.value,{captureSessionId:session2,status:'awaiting_frame',nextSequence:2});
        assert.equal(prepares.length,2);assert.equal(gate.access(),null,'no mint before the restarted share has its own first frame');
        const stale=seedPart({sequence:0});
        assert.equal((await p.rpc('upload',{captureSessionId:session2,part:stale},[stale.bytes])).code,'invalid_segment','the old sequence is not a seed');
        const seed=seedPart({sequence:2});
        const ready=await p.rpc('upload',{captureSessionId:session2,part:seed},[seed.bytes]);
        assert.equal(ready.value.nextSequence,3);assert.equal(ready.value.startedAt,iso(server.media.start));
        const unlocked=await p.rpc('unlock',{captureSessionId:session2});
        assert.equal(unlocked.ok,true,unlocked.code);
        // The second verified editor reports the clock the first one started: same start, same deadline, no new hour.
        assert.equal(unlocked.value.clock.startedAt,first.unlock.clock.startedAt);assert.equal(unlocked.value.clock.deadlineAt,first.unlock.clock.deadlineAt);
        assert.equal(state.opened,2);assert.equal(gate.locked(),false);
        assert.deepEqual(state.access,{attemptId:id,phase:'open',repoOpenProof:proof,captureSessionId:session2});
        assert.deepEqual(w.types(),['preparing','ready','preparing','ready']);
        assert.equal((await p.rpc('status',{captureSessionId:session})).code,'recording_phase_changed','the first share drives nothing any more');
        assert.deepEqual((await p.rpc('end',{captureSessionId:session2,reason:'sharing_stopped',expectedSegments:3})).value,{});
        assert.deepEqual(server.log.filter(Array.isArray).map(entry=>entry[2]),[session,session2]);
        assert.deepEqual([w.assigned,w.opened],[[],[]]);
    }finally{await gate.close();await settle();p.close();}
});
test('a missing parent heartbeat locks the editor and saves the phase as interrupted',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state),embedWatchMs:20,embedSilentMs:160});
    try{
        await bound(w,p);
        await shareToEditor(p);
        for(let n=0;n<8;n++){p.post('pulse',{captureSessionId:session});await settle(50);}
        assert.deepEqual(p.types(),['ready'],'pulses inside the silence limit keep the phase');assert.equal(gate.locked(),false);
        await until(()=>p.types().includes('pause')&&server.log.at(-1)==='checkpoint','the silent share to be saved');
        assert.deepEqual(p.got.filter(d=>d.type==='pause'),[{protocol,attemptId:id,type:'pause',reason:'connection_lost',effectiveAt:null}]);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        // The frame, its port and the clock are still there: the next share needs no new document.
        const again=await shareToEditor(p,session2,1);
        assert.equal(again.unlock.status,'ready');
    }finally{await gate.close();p.close();}
});
test('a server-side submission stop locks the editor, tells the parent the effective time and closes the assignment for good',async t=>{
    const server=fakeServer({stopReason:'submitted'});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        await shareToEditor(p);
        const at=new Date().toISOString();server.stop(at);
        await p.rpc('status',{captureSessionId:session});await settle();
        assert.deepEqual(p.got.filter(d=>d.type==='pause'),[{protocol,attemptId:id,type:'pause',reason:'submitted',effectiveAt:at}]);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'submitted',expectedSegments:1})).value,{});
        assert.equal(server.log.at(-1),'finalize');
        assert.deepEqual(w.types(),['preparing','ready','preparing','unavailable']);assert.ok(w.shown('Assignment closed'));
        assert.equal((await p.rpc('begin',{captureSessionId:session2,consentVersion:4})).code,'workspace_unavailable');
    }finally{await gate.close();p.close();}
});
test('closing the embedded Code window pauses the parent, lets it end the phase, then asks it to reopen',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    await bound(w,p);
    await shareToEditor(p);
    const closing=gate.close();
    await until(()=>p.types().includes('pause'),'pause');
    assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
    const ended=await p.rpc('end',{captureSessionId:session,reason:'connection_lost',expectedSegments:1});
    assert.deepEqual(ended.value,{});
    await closing;await settle();
    assert.deepEqual(p.types(),['ready','pause','reopen']);assert.equal(server.log.at(-1),'checkpoint');
    assert.equal(w.listeners.get('message').size,0);
    p.close();
});
test('an identity refresh, at eligibility, during the checkout or at the open mint, is reported to Universe and never navigates the frame',async t=>{
    // At eligibility.
    {
        t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'UNAUTHORIZED',reason:'session_missing'}},{status:401}));
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w);
        try{
            w.discover();w.bind([p.port]);await until(()=>w.types().includes('authentication_required'),'authentication_required');
            assert.deepEqual(w.types(),['preparing','authentication_required']);assert.deepEqual(p.types(),[]);
            assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'identity_refresh_required');
            assert.deepEqual([w.assigned,w.opened],[[],[]]);assert.ok(w.shown('Sign in to EZiL OS'));assert.equal(w.button('Sign in to EZiL OS'),undefined);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
    // During the checkout, and at the open mint.
    for(const where of ['prepare','mint']){
        const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const identity=Object.assign(new Error('prepare_failed'),{code:'IDENTITY_REFRESH_REQUIRED'});
        const gate=state.gate=embeddedGate(w,{prepare:async()=>{if(where==='prepare')throw identity;return checkout;},
            open:()=>{state.opened++;queueMicrotask(()=>state.gate.fail({errorCode:'IDENTITY_REFRESH_REQUIRED'}));}});
        try{
            await bound(w,p);
            const begun=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            if(where==='prepare')assert.equal(begun.code,'IDENTITY_REFRESH_REQUIRED');
            else{
                const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
                assert.equal((await p.rpc('unlock',{captureSessionId:session})).code,'IDENTITY_REFRESH_REQUIRED');
            }
            await settle();
            assert.equal(w.types().at(-1),'authentication_required',where);assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
            assert.equal((await p.rpc('begin',{captureSessionId:session2,consentVersion:4})).code,'identity_refresh_required');
            assert.deepEqual([w.assigned,w.opened],[[],[]]);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a signed-out or replaced OS account is asked to sign in from Universe without any request',async t=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected network');});
    for(const who of [null,(()=>{let n=0;return ()=>n++?'someone-else':'owner';})()]){
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w,{who});
        try{
            w.discover();w.bind([p.port]);await settle();
            assert.deepEqual(w.types(),['authentication_required']);assert.deepEqual(p.got,[]);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        }finally{await gate.close();p.close();}
    }
    assert.equal(fetch.mock.callCount(),0);
});
test('production placement gates the port: an unverified or stopping computer is never ready, and only the workspace start mode opens a running unbound window',async t=>{
    const started={windowStartedAt:iso(Date.now()-30000),deadlineAt:iso(Date.now()+HOUR-30000)};
    const aws=extra=>({provider:'aws-ec2',lifecycleState:'RUNNING',...extra});
    for(const [info,preflight,ready,title] of [
        [{provider:'cloudflare'},{},true],
        [aws(),{boundWorkspaceId:null},true],
        [aws(),{boundWorkspaceId:'b'.repeat(64),...started},true],
        [aws(),{upgradedWorkspaceId:'a'.repeat(64),upgradeOperationId:session},true],
        // The window Universe's own workspace page started, still unbound: this frame alone accepts it.
        [aws(),{boundWorkspaceId:null,...started,startMode:'workspace'},true],
        // ...and nothing near it: no mode, another mode, no window, an older Universe without the field.
        [aws(),{boundWorkspaceId:null,...started},false,'Choose an assignment-ready computer'],
        [aws(),{boundWorkspaceId:null,...started,startMode:'tab'},false,'Choose an assignment-ready computer'],
        [aws(),{boundWorkspaceId:null,windowStartedAt:started.windowStartedAt,startMode:'workspace'},false,'Choose an assignment-ready computer'],
        [aws(),{...started,startMode:'workspace'},false,'Choose an assignment-ready computer'],
        [aws(),{},false,'Choose an assignment-ready computer'],
        [null,{},false,'Choose an assignment-ready computer'],
        [aws({lifecycleState:'STOPPING'}),{boundWorkspaceId:null},false,'Stopping your computer'],
        [aws({assignmentSession:'stop_then_reopen'}),{boundWorkspaceId:null},false,'Update this computer for your assignment'],
    ]){
        const server=fakeServer({preflight});t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort();let current=info,prepares=0;
        const gate=embeddedGate(w,{computerInfo:async()=>current,prepare:async()=>{prepares++;return new Promise(()=>{});}});
        try{
            w.discover();w.bind([p.port]);await settle(40);
            const label=JSON.stringify([info,preflight]);
            assert.deepEqual(p.types(),ready?['ready']:[],label);assert.deepEqual(w.types(),['preparing'],label);
            if(!ready){
                assert.ok(w.shown(title),label);
                assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_not_ready',label);
                assert.equal(prepares,0);
                // The same check runs again from the frame: a computer that became ready needs no new document.
                current={provider:'cloudflare'};
                w.button('Check this computer again').onclick({isTrusted:false});await settle(20);
                assert.deepEqual(p.types(),[],'only a trusted click rechecks');
                w.button('Check this computer again').onclick({isTrusted:true});
                await until(()=>p.types().length===1,'ready after the recheck');
                assert.deepEqual(w.types(),['preparing']);
            }
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
    // The top-level assignment tab keeps refusing the running unbound window, whatever the mode says.
    const server=fakeServer({preflight:{boundWorkspaceId:null,...started,startMode:'workspace'}});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow();w.win.top=w.win;w.win.parent=w.win;
    const gate=embeddedGate(w,{computerInfo:async()=>aws()});
    try{
        await settle(40);
        assert.ok(w.shown('Choose an assignment-ready computer'));assert.equal(w.button('Share this OS tab and open assignment'),undefined);
    }finally{await gate.close();}
});
test('a retransmitted first frame gets the same phase acknowledgement once, with no new upload, and only for identical bytes',async t=>{
    let release;const holdSeed=new Promise(r=>release=r);
    const server=fakeServer({holdSeed});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const copy=()=>seedPart();
        const first=p.rpc('upload',{captureSessionId:session,part:copy()}),again=p.rpc('upload',{captureSessionId:session,part:copy()});
        await settle(30);release();
        const [one,two]=await Promise.all([first,again]);
        assert.equal(one.ok,true);assert.equal(two.ok,true);
        assert.equal(server.count('confirm'),1);assert.equal(server.count('put'),1);
        const {serverNow:a,...rest}=one.value,{serverNow:b,...same}=two.value;
        assert.deepEqual(rest,same);assert.ok(Date.parse(b)>=Date.parse(a));
        await settle(40);
        const later=await p.rpc('upload',{captureSessionId:session,part:copy()});
        assert.equal(later.ok,true);assert.ok(Date.parse(later.value.serverNow)>Date.parse(a),'a replay advances the broker time by the time elapsed here');
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seedPart({bytes:new Uint8Array([26,69,223,163,2]).buffer})})).code,'invalid_segment');
        assert.equal(server.count('confirm'),1);assert.equal(server.count('put'),1);
    }finally{await gate.close();p.close();}
});
test('a first frame the broker refused is uploaded again for real, and no segment precedes a confirmed seed',async t=>{
    const server=fakeServer({failSeedOnce:true});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seedPart()})).code,'media_unavailable');
        const early=seedPart({sequence:1,startMs:0,endMs:11000});
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:early})).code,'invalid_segment');
        const retried=await p.rpc('upload',{captureSessionId:session,part:seedPart()});
        assert.equal(retried.ok,true,retried.code);assert.equal(retried.value.phaseReady,true);
        assert.equal(server.count('confirm'),2);assert.equal(server.count('put'),2);
    }finally{await gate.close();p.close();}
});

// ---- A preparation window Universe manages (`editorReadySupported` in its signed preflight) -------------------------
const MEDIA_WINDOW=3840000;
function workbenchOpener(state,{folder=workspaceFolder,root=checkoutFolder}={}){
    const frame={isConnected:true,contentWindow:{postMessage(){}}},url='https://code.example/?folder='+encodeURIComponent(folder)+'&ezil_mint=m';
    state.echo=()=>confirmAssignmentFolder({repoUrl:repo},null,frame,url,root);
    state.workbench=()=>confirmAssignmentFolder({repoUrl:repo},null,frame,url,root,true);
    return ()=>{state.opened++;state.access=state.gate.access();};
}
for(const site of [PROD,STAGE]){
    test(`${site.os}: a managed preparation opens the editor only on its mounted workbench, and the work hour is Universe's editor-ready answer`,async t=>{
        const server=fakeServer({site,preflight:{editorReadySupported:true}});t.mock.method(globalThis,'fetch',server.handler);
        server.media.deadline=server.media.start+MEDIA_WINDOW;
        const w=embeddedWindow({site}),p=parentPort(),state={opened:0,access:null},parks=[],wakes=[];
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:workbenchOpener(state),park:(...args)=>parks.push(args),wake:()=>wakes.push(1)});
        try{
            assert.equal(gate.requiresWorkbench(),false,'nothing is asked of the editor before Universe says so');
            await bound(w,p);
            assert.equal(gate.requiresWorkbench(),true);
            assert.deepEqual(wakes,[1],'the ordinary wake is asked once, after the signed eligibility answer');
            // Preparing draws nothing: the Code window's own loader is the surface.
            assert.ok(parks.length&&parks.every(args=>args[0]===true&&args[1]===true),JSON.stringify(parks));
            for(const text of ['Share this assignment tab from Universe','Preparing assignment','Open this assignment from Universe'])assert.equal(w.shown(text),false,text);
            const grant=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            assert.equal(grant.ok,true,grant.code);
            const seed=seedPart();
            const first=await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            // Sixty-four minutes of media is this attempt's bound, and only because Universe said it manages it.
            assert.equal(first.ok,true,first.code);
            assert.equal(Date.parse(first.value.deadlineAt)-Date.parse(first.value.startedAt),MEDIA_WINDOW);
            const unlocking=p.rpc('unlock',{captureSessionId:session});
            await until(()=>state.opened===1,'the open mint');
            // The folder echo names the document but proves no editor: Universe hears nothing, the editor stays parked.
            state.echo();await settle(60);
            assert.equal(server.count('editor-ready'),0);assert.equal(gate.locked(),true);assert.deepEqual(p.events('editor-usable'),[]);
            // The work hour starts at this call. Universe then sets the media cutoff to the end of that hour.
            server.onEditorReady=()=>{server.canon.start=Date.now();server.canon.deadline=server.canon.start+HOUR;server.canon.revision++;
                server.media.deadline=server.canon.deadline;return null;};
            state.workbench();
            const unlocked=await unlocking;
            assert.equal(unlocked.ok,true,unlocked.code);
            assert.deepEqual(server.readyProofs,[[session,proof]]);
            assert.equal(gate.locked(),false);assert.deepEqual(parks.at(-1),[false,false]);
            // `unlock`: the media window from the seed's own start to the cutoff the broker now states; `clock`: the work hour.
            assert.equal(unlocked.value.startedAt,iso(server.media.start));
            assert.equal(unlocked.value.deadlineAt,iso(server.canon.deadline));
            assert.equal(unlocked.value.clock.startedAt,iso(server.canon.start));
            assert.equal(unlocked.value.clock.deadlineAt,iso(server.canon.deadline));
            assert.deepEqual(p.all(),['capture-ready','ready','editor-usable']);
            assert.equal(p.events('editor-usable')[0].deadlineAt,iso(server.canon.deadline));
            // A later status relays the cutoff again; one that names another start, or leaves the bound, relays none.
            assert.equal((await p.rpc('status',{captureSessionId:session})).value.deadlineAt,iso(server.canon.deadline));
            // A second workbench report for the same document asks Universe nothing more.
            state.workbench();await settle(40);
            assert.equal(server.count('editor-ready'),1);
        }finally{await gate.close();await settle();p.close();}
    });
}

test('a managed preparation whose workbench never mounts keeps the editor parked and fails unlock without telling Universe',async t=>{
    const server=fakeServer({preflight:{editorReadySupported:true}});t.mock.method(globalThis,'fetch',server.handler);
    server.media.deadline=server.media.start+MEDIA_WINDOW;
    const w=embeddedWindow(),p=parentPort(),state={opened:0,access:null};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:workbenchOpener(state,{root:'/workspace/elsewhere'})});
    try{
        await bound(w,p);
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).ok,true);
        const seed=seedPart();
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes])).ok,true);
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await until(()=>state.opened===1,'the open mint');
        // Even a workbench report cannot open another folder: the checkout rule is checked first.
        state.workbench();
        const refused=await unlocking;
        assert.deepEqual([refused.ok,refused.code],[false,'assigned_checkout_unverified']);
        assert.equal(server.count('editor-ready'),0);assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        assert.deepEqual(p.events('editor-usable'),[]);
    }finally{await gate.close();await settle();p.close();}
});

test('the media bound is the hour without the signed flag and 64 minutes with it; a refused work clock never opens the editor',async t=>{
    for(const [managed,span,ok] of [[false,HOUR+1000,false],[false,HOUR,true],[true,MEDIA_WINDOW+1000,false],[true,MEDIA_WINDOW,true]]){
        const server=fakeServer({preflight:managed?{editorReadySupported:true}:{}});t.mock.method(globalThis,'fetch',server.handler);
        server.media.deadline=server.media.start+span;
        const w=embeddedWindow(),p=parentPort(),state={opened:0,access:null};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:workbenchOpener(state)});
        try{
            await bound(w,p);
            assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).ok,true);
            const seed=seedPart();
            const first=await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            assert.equal(first.ok,ok,`managed=${managed} span=${span}: ${first.code}`);
            if(!ok)assert.equal(first.code,'recording_closed');
            if(!ok||!managed)continue;
            // Universe refuses the signed call (or answers no clock): parked, `unlock` fails, nothing is announced.
            server.onEditorReady=()=>Response.json({error:{code:'recording_phase_changed'}},{status:409});
            const unlocking=p.rpc('unlock',{captureSessionId:session});
            await until(()=>state.opened===1,'the open mint');
            state.workbench();
            const refused=await unlocking;
            assert.deepEqual([refused.ok,refused.code],[false,'recording_phase_changed']);
            assert.equal(gate.locked(),true);assert.deepEqual(p.events('editor-usable'),[]);
        }finally{await gate.close();await settle();p.close();t.mock.restoreAll();}
    }
});

test('without the signed flag a workbench report is not what opens the editor: the verified folder and editor-ready do, as before',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0,access:null};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:workbenchOpener(state)});
    try{
        await bound(w,p);
        assert.equal(gate.requiresWorkbench(),false);
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).ok,true);
        const seed=seedPart();
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes])).ok,true);
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await until(()=>state.opened===1,'the open mint');
        state.workbench();await settle(60);
        assert.equal(server.count('editor-ready'),0);assert.equal(gate.locked(),true);
        state.echo();
        assert.equal((await unlocking).ok,true);
        assert.equal(server.count('editor-ready'),1);assert.equal(gate.locked(),false);
    }finally{await gate.close();await settle();p.close();}
});

// ── A phase ended while its signed begin is still in flight ──────────────────────────────────────────────────────────
// The OS route holds the first capture's `begin` open until the test lets it answer, as a slow broker does. `answer`
// Production keeps the embedded fixtures in this file: the same cases as Stage's, on the production pair. `screen` is
// the gate's panel as the person sees it; `p.all()` is every port event, the two additive ones included.
const screen=w=>{const panel=w.elements.findLast(e=>e.tag==='section'&&e.isConnected);return panel.hidden?'loader':panel.children[0].children[0].textContent;};
const endShare=(p,captureSessionId=session)=>p.rpc('end',{captureSessionId,reason:'connection_lost',expectedSegments:1});
// replaces that answer. `checkpoints` names the capture and reason of every checkpoint the route received.
function heldBegin(server,{answer,capture=session}={}){
    let release,seen;const sent=new Promise(r=>seen=r),held=new Promise(r=>release=r),checkpoints=[];
    async function handler(path,options){
        const body=String(path).startsWith(PROD.bucket)?null:JSON.parse(options.body);
        if(body?.action==='checkpoint')checkpoints.push([body.captureSessionId,body.reason]);
        if(body?.action!=='begin' || body.captureSessionId!==capture)return server.handler(path,options);
        const granted=await server.handler(path,options);
        seen();await held;
        return answer?answer(body):granted;
    }
    return {handler,sent,release,checkpoints};
}
const successor='11111111-1111-4111-8111-111111111111';
test('a share stopped while its signed begin is in flight is released at once, and the grant that still arrives is checkpointed once',async t=>{
    const server=fakeServer(),hold=heldBegin(server);t.mock.method(globalThis,'fetch',hold.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        // The parent's Stop, in its own order: lock, then (it holds no grant) cancel.
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        assert.equal((await begun).code,'recording_phase_changed','the stopped phase answers before its broker does');
        p.post('cancel',{captureSessionId:session});await settle();
        assert.deepEqual(hold.checkpoints,[],'nothing is checkpointed before a grant exists');
        assert.equal(screen(w),'Sharing paused');assert.equal(gate.access(),null);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        p.post('cancel',{captureSessionId:session});p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        assert.equal((await endShare(p)).code,'recording_phase_changed');await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']],'once, whatever the parent repeats');
        assert.deepEqual(server.log,['preflight','preflight',['begin',4,session,proof],'checkpoint']);
        assert.deepEqual(p.all(),['capture-ready','ready'],'the late grant says nothing on the port');
        assert.deepEqual(w.types(),['preparing']);
    }finally{await gate.close();await settle();p.close();}
});
test('a late grant of an ended phase never reaches the phase that followed it',async t=>{
    // The successor's own begin is answered; the old one answers afterwards, in each of the ways a broker can.
    const answers={
        granted:null,
        refused:()=>Response.json({error:{code:'recording_refused'}},{status:409}),
        identity:()=>Response.json({error:{code:'identity_refresh_required'}},{status:401}),
    };
    for(const [name,answer] of Object.entries(answers)){
        const server=fakeServer(),hold=heldBegin(server,{answer});t.mock.method(globalThis,'fetch',hold.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
        try{
            await bound(w,p);
            const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
            await hold.sent;
            p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
            assert.equal((await begun).code,'recording_phase_changed',name);
            const next=await p.rpc('begin',{captureSessionId:successor,consentVersion:4});
            assert.deepEqual(next.value,{captureSessionId:successor,status:'awaiting_frame',nextSequence:0},name+': the released pane takes the next share');
            hold.release();await settle(20);
            assert.deepEqual(hold.checkpoints,name==='granted'?[[session,'connection_lost']]:[],name);
            // The successor goes on exactly as if the old answer had never come.
            assert.deepEqual(w.types(),['preparing'],name);assert.equal(screen(w),'loader',name);
            assert.deepEqual(p.all(),['capture-ready','ready'],name);
            const seed=seedPart();
            assert.equal((await p.rpc('upload',{captureSessionId:successor,part:seed},[seed.bytes])).value.captureSessionId,successor,name);
            assert.equal((await p.rpc('unlock',{captureSessionId:successor})).value.captureSessionId,successor,name);
            assert.deepEqual(state.access,{attemptId:id,phase:'open',repoOpenProof:proof,captureSessionId:successor},name);
            assert.deepEqual((await endShare(p,successor)).value,{},name);
            assert.deepEqual(hold.checkpoints.at(-1),[successor,'connection_lost'],name);
            assert.equal(hold.checkpoints.length,name==='granted'?2:1,name);
        }finally{await gate.close();await settle();p.close();t.mock.restoreAll();}
    }
});
test('only the ended phase\'s own verified grant is checkpointed: another capture, another status, a refusal or silence send nothing',async t=>{
    const grant=(body,fields)=>Response.json({recordingId,captureSessionId:body.captureSessionId,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,
        stopRequestedAt:null,revoked:false,authorizationExpiresAt:new Date(Date.now()+600000).toISOString(),...fields});
    const answers={
        'another capture':body=>grant(body,{captureSessionId:successor}),
        'already recording':body=>grant(body,{status:'recording',startedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+600000).toISOString()}),
        'no sequence':body=>grant(body,{nextSequence:null}),
        'an expired authorization':body=>grant(body,{authorizationExpiresAt:new Date(Date.now()-1000).toISOString()}),
        'a refusal':()=>Response.json({error:{code:'recording_refused'}},{status:409}),
        'an outage':()=>Response.json({error:{code:'media_unavailable'}},{status:503}),
        'not JSON':()=>new Response('upstream',{status:200}),
        silence:()=>new Promise(()=>{}),
    };
    for(const [name,answer] of Object.entries(answers)){
        const server=fakeServer(),hold=heldBegin(server,{answer});t.mock.method(globalThis,'fetch',hold.handler);
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w,{prepare:async()=>checkout});
        try{
            await bound(w,p);
            const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
            await hold.sent;
            p.post('cancel',{captureSessionId:session});
            assert.equal((await begun).code,'recording_phase_changed',name);
            hold.release();await settle(30);
            assert.deepEqual(hold.checkpoints,[],name);
            assert.deepEqual(server.log,['preflight','preflight',['begin',4,session,proof]],name+': one begin, never asked again');
            assert.deepEqual(p.all(),['capture-ready','ready'],name);assert.deepEqual(w.types(),['preparing'],name);
            assert.equal(screen(w),'Sharing paused',name);
        }finally{await gate.close();await settle();p.close();t.mock.restoreAll();}
    }
});
test('a stale identity refusal leaves the idle pane ready to take the next share',async t=>{
    const server=fakeServer(),hold=heldBegin(server,{answer:()=>Response.json({error:{code:'identity_refresh_required'}},{status:401})});
    t.mock.method(globalThis,'fetch',hold.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        p.post('cancel',{captureSessionId:session});
        assert.equal((await begun).code,'recording_phase_changed');
        assert.deepEqual(w.types(),['preparing']);
        hold.release();await settle(20);
        assert.deepEqual(w.types(),['preparing']);assert.equal(screen(w),'Sharing paused');
        assert.deepEqual(hold.checkpoints,[]);
        const next=await p.rpc('begin',{captureSessionId:successor,consentVersion:4});
        assert.equal(next.value.captureSessionId,successor);
        assert.deepEqual((await endShare(p,successor)).value,{});
        assert.deepEqual(hold.checkpoints,[[successor,'connection_lost']]);
    }finally{await gate.close();await settle();p.close();}
});
test('a parent that goes silent, and the page going away, end a phase under its begin and still checkpoint its late grant once',async t=>{
    // The parent's heartbeat stops while the broker has not answered.
    t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
    let server=fakeServer(),hold=heldBegin(server);t.mock.method(globalThis,'fetch',hold.handler);
    let w=embeddedWindow(),p=parentPort();
    let gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        t.mock.timers.tick(16800);
        assert.equal((await begun).code,'recording_phase_changed');
        assert.deepEqual(p.all(),['capture-ready','ready','pause']);assert.deepEqual(hold.checkpoints,[]);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.deepEqual(p.all(),['capture-ready','ready','pause'],'said once, when the phase ended');
    }finally{await gate.close();await settle();p.close();t.mock.restoreAll();t.mock.timers.reset();}
    // The outer page goes away: the gate closes, and the grant that arrives after it is still this capture's to close.
    server=fakeServer();hold=heldBegin(server);t.mock.method(globalThis,'fetch',hold.handler);
    w=embeddedWindow();p=parentPort();
    gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        for(const fn of [...w.listeners.get('pagehide')])fn();
        await settle();
        assert.equal(p.all().at(2),'pause');
        p.post('cancel',{captureSessionId:session});
        assert.equal((await begun).code,'recording_phase_changed');
        await gate.close();await settle();
        assert.deepEqual(p.all(),['capture-ready','ready','pause','reopen']);assert.deepEqual(hold.checkpoints,[]);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.deepEqual(p.all(),['capture-ready','ready','pause','reopen']);
    }finally{await gate.close();await settle();p.close();}
});
test('the page going away with no Code window open sends the live capture\'s checkpoint from pagehide itself, as keepalive',async t=>{
    const server=fakeServer(),sent=[];
    t.mock.method(globalThis,'fetch',(path,options)=>{
        if(!String(path).startsWith(PROD.bucket))sent.push({path,options,body:JSON.parse(options.body)});
        return server.handler(path,options);
    });
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        await shareToEditor(p);
        gate.detach();
        assert.equal(gate.windowless(),true,'the Code window is closed and the capture is still live');
        await settle(20);
        assert.equal(server.count('checkpoint'),0);
        const before=sent.length;
        for(const fn of [...w.listeners.get('pagehide')])fn();
        // Counted before any await: a closing document gets no later turn, so the request must leave inside the handler.
        const exits=sent.slice(before).filter(r=>r.body.action==='checkpoint');
        assert.equal(exits.length,1);
        assert.equal(exits[0].path,'/api/shell/assignment-video');
        assert.deepEqual(exits[0].body,{action:'checkpoint',attemptId:id,captureSessionId:session,reason:'connection_lost'});
        assert.deepEqual([exits[0].options.method,exits[0].options.keepalive,exits[0].options.credentials],['POST',true,'same-origin']);
        await settle(20);
        assert.ok(p.all().includes('pause'));
    }finally{await gate.close();await settle();p.close();}
});
test('a share stopped during the transport\'s own preflight sends no begin, so there is nothing to checkpoint',async t=>{
    const server=fakeServer();let release,seen,preflights=0;const sent=new Promise(r=>seen=r),held=new Promise(r=>release=r),checkpoints=[];
    t.mock.method(globalThis,'fetch',async(path,options)=>{
        const body=String(path).startsWith(PROD.bucket)?null:JSON.parse(options.body);
        if(body?.action==='checkpoint')checkpoints.push(body.captureSessionId);
        const answer=await server.handler(path,options);
        // The second preflight is the transport's own, inside its begin.
        if(body?.action==='preflight' && ++preflights===2){seen();await held;}
        return answer;
    });
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const begun=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await sent;
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        assert.equal((await begun).code,'recording_phase_changed');
        release();await settle(20);
        assert.deepEqual(server.log,['preflight','preflight']);assert.deepEqual(checkpoints,[]);
        // The pane is free: the next share begins and is granted as any first one.
        assert.equal((await p.rpc('begin',{captureSessionId:successor,consentVersion:4})).value.captureSessionId,successor);
        assert.deepEqual((await endShare(p,successor)).value,{});assert.deepEqual(checkpoints,[successor]);
    }finally{await gate.close();await settle();p.close();}
});

test('a parent dropping the already granted but unobserved Begin reply can re-share without waiting for the watchdog',async t=>{
    t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
    const server=fakeServer(),checkpoints=[];
    t.mock.method(globalThis,'fetch',async (path,options)=>{
        const body=String(path).startsWith(PROD.bucket)?null:JSON.parse(options.body);
        if(body?.action==='checkpoint')checkpoints.push(body.captureSessionId);
        return server.handler(path,options);
    });
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        const unobserved=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        assert.equal(unobserved.value.status,'awaiting_frame');
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        p.post('cancel',{captureSessionId:session});
        const next=await p.rpc('begin',{captureSessionId:successor,consentVersion:4});
        assert.equal(server.log.filter(event=>['prepare','put','confirm'].includes(event)).length,0,'no media bytes were requested');
        if(next.code==='recording_in_use'){
            const checkpointsImmediately=checkpoints.length;
            t.mock.timers.tick(16800);
            await settle(20);
            const later=await p.rpc('begin',{captureSessionId:successor,consentVersion:4});
            assert.equal(later.value.captureSessionId,successor);
            await endShare(p,successor);
            assert.fail(JSON.stringify({immediateReshare:next.code,checkpointsImmediately,watchdogWindowMs:16800,
                laterReshare:true,olderPhaseCheckpointed:checkpoints[0]===session,successorSurvived:true,bytes:0}));
        }
        assert.equal(next.value.captureSessionId,successor);
        assert.deepEqual(checkpoints,[session]);
        p.post('cancel',{captureSessionId:session});
        await settle(20);
        assert.deepEqual(checkpoints,[session]);
        await endShare(p,successor);
        assert.deepEqual(checkpoints,[session,successor]);
    }finally{await gate.close();await settle();p.close();}
});

test('a bare cancel does not retire a phase whose first frame already committed',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        const begun=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        assert.equal(begun.value.status,'awaiting_frame');
        const seed=seedPart();
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes])).value.phaseReady,true);
        p.post('cancel',{captureSessionId:session});
        assert.equal((await p.rpc('unlock',{captureSessionId:session})).value.captureSessionId,session);
        assert.equal(server.log.filter(event=>event==='checkpoint').length,0);
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        assert.deepEqual((await endShare(p)).value,{});
        assert.equal(server.log.filter(event=>event==='checkpoint').length,1);
    }finally{await gate.close();await settle();p.close();}
});

test('a verified grant returned during gate close releases only the interrupted capture',async t=>{
    const server=fakeServer(),hold=heldBegin(server);t.mock.method(globalThis,'fetch',hold.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        void p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        const closing=gate.close();
        await settle(50);
        hold.release();
        await closing;await settle(50);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.equal(server.log.filter(event=>['prepare','confirm','put'].includes(event)).length,0,'no recording bytes travelled');
        const nextWindow=embeddedWindow(),nextParent=parentPort();
        const nextGate=embeddedGate(nextWindow,{prepare:async()=>checkout});
        try{
            await bound(nextWindow,nextParent);
            const reply=await nextParent.rpc('begin',{captureSessionId:successor,consentVersion:4});
            assert.equal(reply.value.captureSessionId,successor);
            assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
            assert.deepEqual((await endShare(nextParent,successor)).value,{});
            assert.deepEqual(hold.checkpoints,[[session,'connection_lost'],[successor,'connection_lost']]);
        }finally{await nextGate.close();await settle();nextParent.close();}
    }finally{await gate.close();await settle();p.close();}
});
test('a verified grant returned during an approved pause is checkpointed without a frame',async t=>{
    const server=fakeServer({clockStart:Date.now()-60000}),hold=heldBegin(server);t.mock.method(globalThis,'fetch',hold.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        void p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await hold.sent;
        server.pause();
        await until(()=>p.events('pause').length>0,'the pause on the port');
        hold.release();await settle(80);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.equal(server.log.filter(event=>['prepare','confirm','put'].includes(event)).length,0,'no recording bytes travelled');
    }finally{await gate.close();await settle();p.close();}
});
