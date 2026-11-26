import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {assignedProject,confirmAssignmentFolder,embeddedAssignmentWindow,openWithAssignmentConsent,refusalClass,stageDiagnostics} from './shell.js';
import {createAssignmentVideoTransport} from './transport.js';
import {assignmentWorkDesktop} from './work-protocol.js';
const id='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const repo='https://github.ezil.work/default/u-0123456789abcdef-a-'+id+'.git';
class Element{
    children=[];hidden=false;isConnected=true;
    setAttribute(name,value){this[name]=value;} append(...children){this.children.push(...children);} querySelector(){return null;}
    remove(){this.isConnected=false;}
}
function fixture(url,project,who='owner'){
    const top={},win={location:new URL(url),top,parent:top,addEventListener(){},removeEventListener(){}};
    Object.assign(globalThis,{window:win,document:{createElement:()=>new Element()}});
    const locks=[];let open=0,prepare=0;
    const gate=openWithAssignmentConsent({project,actor:()=>who,computerId:'fixture',body:new Element(),
        park:locked=>locks.push(locked),open:()=>open++,prepare:()=>prepare++});
    return {gate,locks,counts:()=>[open,prepare]};
}
test('mismatched, unresolved or signed-out assignment routes cannot mint Code, including duplicate launches',async()=>{
    const href='https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
    for(const [url,project,who] of [
        [href.replace('assignment='+id,'assignment=eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),{repoUrl:repo},'owner'],
        [href,{repoUrl:repo},null],
        [href,{repoUrl:'https://github.ezil.work/default/previous-checkout.git'},'owner'],
        [href,null,'owner'],
        ['https://os-staging.ezil.work/app/code?assignment='+id+'&repo='+encodeURIComponent('https://github.ezil.work/default/not-the-assignment.git'),{repoUrl:'https://github.ezil.work/default/not-the-assignment.git'},'owner'],
    ]){
        const f=fixture(url,project,who);await Promise.resolve();
        assert.equal(f.gate.locked(),true);assert.equal(f.gate.access(),null);assert.deepEqual(f.counts(),[0,0]);
        assert.ok(f.locks.every(Boolean));await f.gate.close();
    }
});
test('ordinary repository continues through the normal Code launch without media control',async()=>{
    const ordinary='https://github.ezil.work/default/ordinary.git';
    const f=fixture('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(ordinary),{repoUrl:ordinary});
    await Promise.resolve();assert.equal(f.gate,null);assert.deepEqual(f.counts(),[1,0]);assert.deepEqual(f.locks,[]);
});
test('embedded OS never activates even a valid canonical assignment',async(t)=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>{throw Error('unexpected network');});
    const f=fixture('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id,{repoUrl:repo});
    await new Promise(r=>setImmediate(r));
    assert.equal(f.gate.locked(),true);assert.equal(fetch.mock.callCount(),0);assert.deepEqual(f.counts(),[0,0]);
    await f.gate.close();
});
test('the native Stop during a delayed private checkout cannot later start media or release Code',async(t)=>{
    const requests=[],elements=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        const body=JSON.parse(options.body);requests.push(body.action);
        return Response.json({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString()});
    });
    let handle,resolveCheckout,releasePreparing,opened=0;
    const preparing=new Promise(r=>releasePreparing=r);
    const checkout=new Promise(r=>resolveCheckout=r);
    class Track{
        readyState='live';muted=false;listeners={};
        getCaptureHandle(){return {origin:'https://os-staging.ezil.work',handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){this.listeners[n]=f;} stop(){this.readyState='ended';}
    }
    const track=new Track(),stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
    const body=new Element(),doc={body,createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;}};
    const win={location:new URL('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id),crypto:globalThis.crypto,
        isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},MediaStreamTrack:Track,VideoFrame:class{},VideoEncoder:class{},
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){opened++;},prepare(){releasePreparing();return checkout;}});
    try{
        await new Promise(r=>setImmediate(r));
        const button=elements.find(e=>e.textContent==='Share this OS tab and open assignment');
        assert.ok(button);button.onclick({isTrusted:false});await Promise.resolve();assert.deepEqual(requests,['preflight']);
        button.onclick({isTrusted:true});await preparing;
        track.listeners.ended();assert.equal(gate.locked(),true);
        const workspaceFolder='/workspace',checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
        resolveCheckout({ok:true,repository:{id:'test',workspaceFolder,checkoutFolder},assignmentOpen:{attemptId:id,proof:'x'.repeat(60)}});
        await new Promise(r=>setImmediate(r));
        assert.equal(track.readyState,'ended');assert.deepEqual(requests,['preflight']);assert.equal(opened,0);assert.equal(gate.access(),null);
    }finally{await gate.close();}
});
function consentWindow(url){
    const elements=[],assigned=[],opened=[];let handle;
    class Track{
        readyState='live';muted=false;listeners={};
        getCaptureHandle(){return {origin:'https://os-staging.ezil.work',handle};}
        getSettings(){return {displaySurface:'browser'};}
        addEventListener(n,f){this.listeners[n]=f;} stop(){this.readyState='ended';}
    }
    const track=new Track(),stream={getTracks:()=>[track],getVideoTracks:()=>[track],getAudioTracks:()=>[]};
    const doc={body:new Element(),createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;}};
    const location=Object.assign(new URL(url),{assign:target=>assigned.push(target)});
    const win={location,open:(...args)=>opened.push(args),crypto:globalThis.crypto,isSecureContext:true,document:doc,addEventListener(){},removeEventListener(){},
        MediaStreamTrack:Track,VideoFrame:class{},VideoEncoder:class{},
        navigator:{mediaDevices:{setCaptureHandleConfig(config){handle=config.handle;},getDisplayMedia:async()=>stream}}};
    win.top=win;win.parent=win;Object.assign(globalThis,{window:win,document:doc});
    const button=label=>elements.find(e=>typeof e.onclick==='function'&&e.textContent===label);
    return {elements,assigned,opened,track,button};
}
const entry='https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo)+'&assignment='+id;
const eligibleBody=extra=>({status:'eligible',attemptId:id,repositoryUrl:repo,expiresAt:new Date(Date.now()+60000).toISOString(),
    windowStartedAt:null,deadlineAt:null,...extra});
test('a Creator-link refusal keeps the editor closed and offers a trusted route back to Universe',async t=>{
    const requests=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        requests.push(JSON.parse(options.body).action);
        return Response.json({error:{code:'assignment_video_creator_unlinked'}},{status:409});
    });
    const w=consentWindow(entry);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
    try{
        await new Promise(r=>setImmediate(r));
        assert.ok(w.elements.some(e=>e.textContent==='The Creator needs to connect EZiL ID'));
        assert.ok(w.elements.some(e=>e.textContent?.includes('verified EZiL ID')));
        assert.equal(w.button('Share this OS tab and open assignment'),undefined);
        assert.equal(w.button('Retry verification'),undefined);
        const back=w.button('Return to Universe jobs');
        assert.ok(back);
        back.onclick({isTrusted:false});assert.deepEqual(w.opened,[]);
        back.onclick({isTrusted:true});
        assert.deepEqual(w.opened,[['https://universe-staging.ezil.work/builder-jobs','_self','noreferrer']]);
        assert.deepEqual(requests,['preflight']);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
    }finally{await gate.close();}
});
test('an AWS computer needs Universe\'s explicit binding answer; every other provider keeps its own path',async t=>{
    const bound='b'.repeat(64),now=Date.now();
    const window=(from,until)=>({windowStartedAt:new Date(now-from).toISOString(),deadlineAt:new Date(now+until).toISOString()});
    for(const [provider,proof,opens] of [
        ['aws-ec2',{boundWorkspaceId:null},true],
        ['aws-ec2',{boundWorkspaceId:null,...window(1000,60000)},true],
        ['aws-ec2',{boundWorkspaceId:null,...window(1000,3600000)},false],
        ['aws-ec2',{boundWorkspaceId:null,windowStartedAt:new Date(now-1000).toISOString(),deadlineAt:null},false],
        ['aws-ec2',{boundWorkspaceId:bound,...window(1000,60000)},true],
        ['aws-ec2',{boundWorkspaceId:'b'.repeat(63)},false],
        ['aws-ec2',{},false],
        ['aws-ec2',{upgradedWorkspaceId:bound,upgradeOperationId:'11111111-1111-4111-8111-111111111111'},true],
        ['aws-ec2',{upgradedWorkspaceId:bound},false],
        ['cloudflare',{},true],
        [null,{},true],
    ]){
        t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody(proof)));
        const w=consentWindow(entry);
        const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
            computerProvider:async()=>provider,park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
        try{
            await new Promise(r=>setImmediate(r));
            assert.equal(Boolean(w.button('Share this OS tab and open assignment')),opens,JSON.stringify([provider,proof]));
            assert.equal(Boolean(w.button('Check this computer again')),!opens);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        }finally{await gate.close();t.mock.restoreAll();}
    }
});
test('an unreadable provider does not block a share the server will decide',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=consentWindow(entry);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        computerProvider:async()=>{throw new Error('offline');},park(){},open(){},prepare(){}});
    try{
        await new Promise(r=>setImmediate(r));
        assert.ok(w.button('Share this OS tab and open assignment'));
    }finally{await gate.close();}
});
test('an assignment sign-in refresh keeps the selected computer, repository and attempt',async t=>{
    const computerId='11111111-1111-4111-8111-111111111111';
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'identity_refresh_required'}},{status:409}));
    const w=consentWindow(entry+'&computer='+computerId);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId,body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
    try{
        await new Promise(r=>setImmediate(r));
        const signIn=w.button('Sign in to EZiL OS');
        assert.ok(signIn);
        signIn.onclick({isTrusted:false});
        assert.deepEqual(w.assigned,[]);
        signIn.onclick({isTrusted:true});
        const login=new URL(w.assigned[0],'https://os-staging.ezil.work');
        assert.equal(login.pathname,'/auth/auth0/login');
        const back=new URL(login.searchParams.get('returnUrl'),'https://os-staging.ezil.work');
        assert.equal(back.pathname,'/app/code');
        assert.deepEqual([...back.searchParams],[['repo',repo],['assignment',id],['computer',computerId]]);
    }finally{await gate.close();}
});
test('a mismatched assignment account offers explicit sign-in and preserves the exact link',async t=>{
    const origin='https://os-staging.ezil.work';
    const signedRepo=repo.replace('https:', 'https%3A');
    const actions=[];
    const assigned=[];
    const requests=[];
    const doc={createElement(){const element=new Element();actions.push(element);return element;}};
    t.mock.method(globalThis,'fetch',async(_path,options)=>{
        requests.push({ body:JSON.parse(options.body), repositoryUrl:options.headers['X-Ezil-Assignment-Repository'] });
        return Response.json({error:{code:'assignment_identity_mismatch'}},{status:409});
    });
    for (const path of ['/app/code?repo='+signedRepo,
        '/app/code?computer='+id+'&repo='+signedRepo+'&assignment='+id+'#workspace']) {
        const location=Object.assign(new URL(origin+path),{assign:target=>assigned.push(target)});
        const win={location,document:doc,addEventListener(){},removeEventListener(){}};
        win.top=win;
        Object.assign(globalThis,{window:win,document:doc});
        const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:id,body:new Element(),
            park(){},open(){assert.fail('editor must stay closed');},prepare(){assert.fail('checkout must stay closed');}});
        try {
            await new Promise(r=>setImmediate(r));
            assert.ok(actions.some(e=>e.textContent==='Use the same EZiL ID you used on Universe.'));
            const signIn=actions.findLast(e=>typeof e.onclick==='function'&&e.textContent==='Sign in to EZiL OS');
            assert.ok(signIn);
            assert.equal(gate.locked(),true);
            assert.equal(gate.access(),null);
            const before=assigned.length;
            signIn.onclick({isTrusted:false});
            assert.equal(assigned.length,before);
            signIn.onclick({isTrusted:true});
            const login=new URL(assigned.at(-1),origin);
            assert.equal(login.pathname,'/auth/auth0/login');
            assert.equal(login.searchParams.get('prompt'),'login');
            assert.equal(login.searchParams.get('returnUrl'),path);
        } finally {
            await gate.close();
        }
    }
    const preflight={body:{action:'preflight',attemptId:id},repositoryUrl:repo};
    assert.deepEqual(requests,[preflight,preflight]);
});
test('a stopped share never asks the checkout again and aborts only its own mint',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=consentWindow(entry);
    let prepares=0,signal,release;
    const first=new Promise(r=>release=r);
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),
        park(){},open(){assert.fail('editor must stay closed');},
        async prepare(_id,options){prepares++;signal=options?.signal;release();await new Promise(r=>setTimeout(r,20));
            throw Object.assign(new Error('prepare_failed'),{code:'sandbox_starting'});}});
    try{
        await new Promise(r=>setImmediate(r));
        w.button('Share this OS tab and open assignment').onclick({isTrusted:true});
        await first;
        assert.equal(signal.aborted,false);
        w.track.listeners.ended();
        assert.equal(signal.aborted,true);
        await new Promise(r=>setTimeout(r,800));
        assert.equal(prepares,1);
    }finally{await gate.close();}
});

// ── Embedded by the assignment's own Universe work page (`ezil.assignment.work/v2`) ─────────────────────────────────
// The parent half below replays the message sequence of Universe 994b90ac `assets/templates/basic/js/assignment-work-capture.js`
// (`createAssignmentWorkCapture`: discover → bind+port → begin → seed upload → unlock → pulses/segments → lock → end),
// with the one agreed delta that it binds on `preparing` instead of the old `available`. That file is not executed here.
const universe='https://universe-staging.ezil.work',protocol='ezil.assignment.work/v2';
const bucket='https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const challenge='0f0e5a9c-3c52-4d8e-9b55-0d7f3b6f8a11',session='5b9a2c1e-7d64-4f0a-8e3b-2c1d0e9f8a7b';
const recordingId='9c1d7a3e-2b4f-4e6a-8d1c-3f5a7b9e0c2d',proof='p'.repeat(60);
const workspaceFolder='/workspace',checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
const checkout={ok:true,repository:{id:'provider-repo',workspaceFolder,checkoutFolder},assignmentOpen:{attemptId:id,proof}};
const settle=(ms=5)=>new Promise(r=>setTimeout(r,ms));
function embeddedWindow(url=entry,{ancestors}={}){
    const listeners=new Map(),posted=[],assigned=[],opened=[],elements=[];
    const top={postMessage:(...args)=>posted.push(args)};
    const location=Object.assign(new URL(url),{assign:target=>assigned.push(target)},ancestors?{ancestorOrigins:ancestors}:{});
    const doc={body:new Element(),createElement(tag){const e=new Element();e.tag=tag;elements.push(e);return e;},addEventListener(){},removeEventListener(){}};
    const win={location,top,parent:top,document:doc,crypto:globalThis.crypto,open:(...args)=>opened.push(args),
        setTimeout,clearTimeout,isSecureContext:true,VideoFrame:class{},VideoEncoder:class{},MediaStreamTrack:class{},
        navigator:{mediaDevices:{getDisplayMedia(){throw Error('the tab picker must not run in the frame');},
            setCaptureHandleConfig(){throw Error('no capture handle in the frame');}}},
        addEventListener:(type,fn)=>{if(!listeners.has(type))listeners.set(type,new Set());listeners.get(type).add(fn);},
        removeEventListener:(type,fn)=>listeners.get(type)?.delete(fn)};
    Object.assign(globalThis,{window:win,document:doc,location});
    const dispatch=(data,source,origin,ports=[])=>{for(const fn of [...(listeners.get('message')??[])])fn({source,origin,data,ports});};
    const discover=(overrides={},source=top,origin=universe)=>dispatch({protocol,type:'discover',attemptId:id,challenge,...overrides},source,origin);
    const bind=(ports,overrides={},source=top,origin=universe)=>dispatch({protocol,type:'bind',attemptId:id,challenge,...overrides},source,origin,ports);
    const types=()=>posted.map(([data,origin])=>{assert.equal(origin,universe);assert.deepEqual(Object.keys(data).sort(),['attemptId','challenge','protocol','type']);
        assert.equal(data.attemptId,id);return data.type;});
    const shown=text=>elements.some(e=>e.textContent===text);
    // The gate's own panel: hidden while the Code window's loader is the surface.
    // The latest one: each Code window of the document gets its own.
    const panel=()=>elements.findLast(e=>e.className==='ezil-assignment-work-gate');
    const screen=()=>panel().hidden?'loader':panel().children[0].children[0].textContent;
    return {win,top,posted,assigned,opened,discover,bind,types,shown,listeners,screen};
}
// The parent's half of the port, as 994b90ac uses it: numbered requests, transferable segment bytes.
function parentPort(){
    const channel=new MessageChannel(),got=[],waiting=new Map();let next=0;
    channel.port1.onmessage=event=>{const d=event.data;got.push(d);
        if(d?.type==='reply'){const done=waiting.get(d.id);waiting.delete(d.id);done?.(d);}};
    const post=(type,fields={},transfer=[])=>channel.port1.postMessage({protocol,attemptId:id,type,...fields},transfer);
    const rpc=(method,fields={},transfer=[])=>new Promise(resolve=>{const n=++next;waiting.set(n,resolve);post('request',{id:n,method,...fields},transfer);});
    return {port:channel.port2,got,post,rpc,types:()=>got.filter(d=>d.type!=='reply').map(d=>d.type),
        close(){channel.port1.close();channel.port2.close();}};
}
// The OS's own assignment-video route and the media bucket, as the transport sees them.
function fakeServer({stopReason=null,readyBeforeSeed=false,holdSeed=null,failSeedOnce=false,flag,ack={}}={}){
    const log=[],asked=[],started=Date.now();let seeded=false,stopAt=null,serverNow=null,acknowledged=false;
    // Universe's work clock (the `editor-ready` answer) and the media cutoff the broker moved after it: never the same value.
    const work={startedAt:new Date(started+500).toISOString(),deadlineAt:new Date(started+3500500).toISOString(),serverNow:new Date(started+600).toISOString()};
    const moved={deadlineAt:new Date(started+1980000).toISOString(),serverNow:new Date(started+700).toISOString()};
    const startedAt=new Date(started-1000).toISOString(),deadlineAt=new Date(started+1800000).toISOString(),firstFrameAt=new Date(started).toISOString();
    async function handler(path,options){
        if(String(path).startsWith(bucket)){log.push('put');return new Response(null,{status:200});}
        const body=JSON.parse(options.body);log.push(body.action==='begin'?['begin',body.consentVersion,body.captureSessionId,body.repoOpenProof]:body.action);
        const same={recordingId,captureSessionId:body.captureSessionId};
        if(body.action==='preflight')return Response.json(eligibleBody(flag===undefined?{}:{editorReadySupported:flag}));
        if(body.action==='editor-ready'){
            asked.push(body);
            if(ack.hold)await ack.hold;
            if(ack.failures?.length)return Response.json({error:{code:ack.failures.shift()}},{status:409});
            acknowledged=true;return Response.json({ok:true,...work});
        }
        if(body.action==='begin')return Response.json({...same,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
            authorizationExpiresAt:new Date(Date.now()+600000).toISOString()});
        if(body.action==='prepare')return Response.json({expiresAt:new Date(Date.now()+60000).toISOString(),headers:{'content-type':'video/webm'},
            putUrl:`${bucket}/universe-staging/assignment-media/v1/o/${id}/${recordingId}/segments/${body.sequence}/${body.sha256}.webm`});
        if(body.action==='confirm'){
            if(!seeded && failSeedOnce){failSeedOnce=false;return Response.json({error:{code:'media_unavailable'}},{status:503});}
            if(!seeded && holdSeed)await holdSeed;
            const seed=!seeded;seeded=true;
            return Response.json(seed?{...same,sequence:body.sequence,confirmed:true,phaseReady:true,nextSequence:body.sequence+1,firstFrameAt,startedAt,deadlineAt,
                serverNow:serverNow=new Date(Date.now()+2345).toISOString()}:{recordingId,sequence:body.sequence,confirmed:true});
        }
        if(body.action==='status')return Response.json({...same,status:'recording',phaseReady:seeded||readyBeforeSeed,workspaceUnlocked:seeded||readyBeforeSeed,startedAt,deadlineAt,firstFrameAt,
            stopRequestedAt:stopAt,stopReason:stopAt?stopReason:null,revoked:false,...(acknowledged?moved:{})});
        return Response.json({...same,status:'paused',startedAt,deadlineAt,stopRequestedAt:null,revoked:false});
    }
    return {log,asked,work,moved,handler,startedAt,deadlineAt,serverNow:()=>serverNow,stop(at){stopAt=at;}};
}
function embeddedGate(w,{who='owner',prepare=()=>assert.fail('checkout must stay closed'),open=()=>assert.fail('editor must stay closed'),...rest}={}){
    return openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>who,computerId:'fixture',body:new Element(),park(){},prepare,open,...rest});
}
const seedPart=(fields={})=>({sequence:0,startMs:0,endMs:1,mimeType:'video/webm',bytes:new Uint8Array([26,69,223,163,1]).buffer,...fields});
// Discover, bind and wait for port `ready`, as the parent does before it offers Share.
async function bound(w,p){w.discover();w.bind([p.port]);await settle();assert.deepEqual(p.types(),['capture-ready','ready']);}
// The Code window's two reports, as `../apps/code.js` makes them: the folder echo of the editor document's address,
// then (`workbench`, asked only under the signed preparation) the editor's own mounted workbench. `state.report` sends
// either one again later, for the same frame and address.
function editorOpener(state,{root=checkoutFolder,folder=workspaceFolder,workbench=false,workbenchRoot=root}={}){
    const frame=state.frame={isConnected:true,contentWindow:{postMessage(){}}};
    const address='https://code.example/?folder='+encodeURIComponent(folder)+'&ezil_mint=m';
    state.report=(mounted,at=mounted?workbenchRoot:root)=>mounted
        ? confirmAssignmentFolder({repoUrl:repo},null,frame,address,at,true)
        : confirmAssignmentFolder({repoUrl:repo},null,frame,address,at);
    return ()=>{state.opened++;state.access=state.gate.access();
        queueMicrotask(()=>{state.report(false);if(workbench)queueMicrotask(()=>state.report(true));});};
}

test('the paired Universe parent records, unlocks and ends the embedded assignment through the bound port only',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0,access:null},prepares=[];
    const gate=state.gate=embeddedGate(w,{prepare:async(attempt,options)=>{prepares.push([attempt,options.signal.aborted]);return checkout;},open:editorOpener(state)});
    try{
        await settle();assert.deepEqual(server.log,[]);
        await bound(w,p);
        assert.deepEqual(w.types(),['preparing']);assert.deepEqual(server.log,['preflight']);assert.deepEqual(prepares,[]);
        const grant=await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        assert.deepEqual(grant,{protocol,attemptId:id,type:'reply',id:1,ok:true,value:{captureSessionId:session,status:'awaiting_frame',nextSequence:0}});
        assert.deepEqual(prepares,[[id,false]]);
        assert.deepEqual(server.log.slice(1),['preflight',['begin',4,session,proof]]);
        assert.equal(gate.access(),null,'no mint before the first frame is confirmed');
        const seed=seedPart();
        const ready=await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        // The broker's own (here deliberately skewed) clock reaches the parent unchanged, for its segment and deadline timing.
        assert.match(server.serverNow(),/^\d{4}-\d\d-\d\dT/);
        assert.deepEqual(ready.value,{confirmed:true,phaseReady:true,captureSessionId:session,nextSequence:1,startedAt:server.startedAt,deadlineAt:server.deadlineAt,
            serverNow:server.serverNow()});
        assert.deepEqual((await p.rpc('status',{captureSessionId:session})).value,{captureSessionId:session,status:'recording',stopRequestedAt:null,deadlineAt:server.deadlineAt});
        assert.equal(gate.access(),null);
        const unlocked=await p.rpc('unlock',{captureSessionId:session});
        assert.deepEqual(unlocked.value,{status:'ready',captureSessionId:session,startedAt:server.startedAt,deadlineAt:server.deadlineAt});
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
        assert.deepEqual(server.log.filter(x=>x==='put').length,2);
        const wire=JSON.stringify([...p.got,...w.posted]);
        assert.ok(!wire.includes(proof)&&!wire.includes(recordingId)&&!wire.includes(bucket),'the proof, recording and signed upload stay in the OS');
        assert.deepEqual([w.assigned,w.opened],[[],[]]);
    }finally{await gate.close();await settle();p.close();}
    assert.deepEqual(p.types(),['capture-ready','ready','editor-usable','reopen']);
});
test('a bind is accepted only from the actual Universe parent, for the answered challenge, with exactly one port, once',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=embeddedWindow(),wrong=[];
    const gate=embeddedGate(w);
    const probe=()=>{const p=parentPort();wrong.push(p);return p;};
    try{
        const early=probe();w.bind([early.port]);
        w.discover();await settle();
        const cases=[[{}, {}],[{}, w.top,'https://universe.ezil.work'],[{challenge:session}],[{attemptId:session}],[{protocol:'ezil.assignment.work/v1'}]];
        for(const [overrides,source=w.top,origin=universe] of cases){const p=probe();w.bind([p.port],overrides,source,origin);}
        const two=probe(),extra=new MessageChannel();w.bind([two.port,extra.port1]);extra.port1.close();extra.port2.close();
        w.bind([]);
        await settle();
        for(const p of wrong){void p.rpc('begin',{captureSessionId:session,consentVersion:4});}
        await settle();
        assert.ok(wrong.every(p=>p.got.length===0),'no unbound port is ever answered');
        const good=parentPort(),second=parentPort();
        w.bind([good.port]);w.bind([second.port]);await settle();
        assert.deepEqual(good.types(),['capture-ready','ready']);
        void second.rpc('status',{captureSessionId:session});await settle();
        assert.deepEqual(second.got,[]);
        good.close();second.close();
    }finally{await gate.close();wrong.forEach(p=>p.close());}
});
test('begin waits for eligibility, needs the parent consent version and a capture id, and starts only on request',async t=>{
    let release;const gateOpen=new Promise(r=>release=r);const log=[];
    t.mock.method(globalThis,'fetch',async(_path,options)=>{log.push(JSON.parse(options.body).action);await gateOpen;return Response.json(eligibleBody({}));});
    const w=embeddedWindow(),p=parentPort();let prepares=0;
    const gate=embeddedGate(w,{prepare:async()=>{prepares++;return new Promise(()=>{});}});
    try{
        w.discover();w.bind([p.port]);await settle();
        assert.deepEqual(p.types(),['capture-ready'],'no port ready before eligibility');
        assert.deepEqual((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_not_ready');
        release();await settle();
        assert.deepEqual(p.types(),['capture-ready','ready']);
        for(const fields of [{captureSessionId:session,consentVersion:3},{captureSessionId:session,consentVersion:'4'},{captureSessionId:session},
            {captureSessionId:'not-a-session',consentVersion:4},{consentVersion:4}])
            assert.equal((await p.rpc('begin',fields)).code,'assignment_not_ready',JSON.stringify(fields));
        assert.equal((await p.rpc('erase',{captureSessionId:session})).code,'invalid_request');
        assert.equal((await p.rpc('toString',{captureSessionId:session})).code,'invalid_request');
        assert.equal(prepares,0);assert.deepEqual(log,['preflight']);
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
        assert.equal(state.opened,0);assert.equal(gate.access(),null);
    }finally{await gate.close();p.close();}
});
test('an editor on any folder but the verified checkout fails unlock and stays locked',async t=>{
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
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a missing parent heartbeat locks the editor and saves the phase as interrupted',async t=>{
    t.mock.timers.enable({apis:['setInterval','Date'],now:Date.now()});
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        t.mock.timers.tick(11200);p.post('pulse',{captureSessionId:session});await settle();
        t.mock.timers.tick(11200);await settle();
        assert.deepEqual(p.types(),['capture-ready','ready'],'a pulse inside 14 s keeps the phase');
        t.mock.timers.tick(5600);await settle(20);
        assert.deepEqual(p.types(),['capture-ready','ready','pause']);
        assert.deepEqual(p.got.at(-1),{protocol,attemptId:id,type:'pause',reason:'connection_lost',effectiveAt:null});
        assert.equal(server.log.at(-1),'checkpoint');assert.equal(gate.access(),null);
    }finally{await gate.close();p.close();}
});
test('a server-side submission stop locks the editor and tells the parent the effective time',async t=>{
    const server=fakeServer({stopReason:'submitted'});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0};
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state)});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        await p.rpc('unlock',{captureSessionId:session});
        const at=new Date().toISOString();server.stop(at);
        await p.rpc('status',{captureSessionId:session});await settle();
        assert.deepEqual(p.got.filter(d=>d.type==='pause'),[{protocol,attemptId:id,type:'pause',reason:'submitted',effectiveAt:at}]);
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        await p.rpc('end',{captureSessionId:session,reason:'submitted',expectedSegments:1});
        assert.equal(server.log.at(-1),'finalize');
        assert.deepEqual(w.types(),['preparing','ready','preparing','unavailable']);
    }finally{await gate.close();p.close();}
});
test('closing the embedded Code window pauses the parent, lets it end the phase, then asks it to reopen',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    await bound(w,p);
    await p.rpc('begin',{captureSessionId:session,consentVersion:4});
    const closing=gate.close();
    await settle();
    assert.deepEqual(p.got.filter(d=>d.type==='pause').length,1);
    assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'connection_lost',expectedSegments:0})).ok,true,'the parent\'s end is answered');
    await closing;await settle();
    assert.deepEqual(p.types(),['capture-ready','ready','pause','reopen']);
    assert.equal(server.log.at(-1),'checkpoint');
    w.discover();assert.deepEqual(w.types(),['preparing'],'a closed gate answers nothing');
    p.close();
});
test('an identity refresh during the checkout is reported to Universe, refuses new phases and never navigates',async t=>{
    t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>{throw Object.assign(new Error('prepare_failed'),{code:'IDENTITY_REFRESH_REQUIRED'});}});
    try{
        await bound(w,p);
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'IDENTITY_REFRESH_REQUIRED');
        assert.deepEqual(w.types(),['preparing','authentication_required']);
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'identity_refresh_required');
        assert.ok(w.shown('Sign in to EZiL OS'));assert.deepEqual([w.assigned,w.opened],[[],[]]);
    }finally{await gate.close();p.close();}
});
test('an embedded eligibility sign-in requirement is reported to Universe and never navigates the frame',async t=>{
    for(const response of [()=>Response.json({error:{code:'identity_refresh_required'}},{status:409}),
        ()=>Response.json({error:{code:'UNAUTHORIZED',reason:'session_missing'}},{status:401}),
        ()=>Response.json({error:{code:'assignment_identity_mismatch'}},{status:409})]){
        t.mock.method(globalThis,'fetch',async()=>response());
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w);
        try{
            w.discover();w.bind([p.port]);await settle();
            assert.deepEqual(w.types(),['preparing','authentication_required']);assert.deepEqual(p.types(),['capture-ready']);
            assert.ok(w.shown('Sign in to EZiL OS'));
            assert.deepEqual([w.assigned,w.opened],[[],[]]);assert.equal(gate.access(),null);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a signed-out or replaced OS account is asked to sign in from Universe without any request',async t=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>assert.fail('no request without the same OS account'));
    for(const who of [null,'']){
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w,{who});
        try{
            w.discover();w.discover();w.bind([p.port]);await settle();
            assert.deepEqual(w.types(),['authentication_required','authentication_required']);assert.deepEqual(p.types(),[]);
            assert.equal(fetch.mock.callCount(),0);assert.deepEqual(w.assigned,[]);
        }finally{await gate.close();p.close();}
    }
    let who='owner';
    const w=embeddedWindow();
    const gate=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>who,computerId:'fixture',body:new Element(),park(){},
        prepare(){assert.fail('checkout must stay closed');},open(){assert.fail('editor must stay closed');}});
    try{who='someone-else';w.discover();await settle();assert.deepEqual(w.types(),['authentication_required']);assert.equal(fetch.mock.callCount(),0);}
    finally{await gate.close();}
});
test('an unlinked Creator or an unverified AWS computer is unavailable in the frame, with no Universe link and no port ready',async t=>{
    for(const [body,provider,title] of [[{error:{code:'assignment_video_creator_unlinked'}},null,'The Creator needs to connect EZiL ID'],
        [eligibleBody({}),'aws-ec2','Choose an assignment-ready computer']]){
        t.mock.method(globalThis,'fetch',async()=>Response.json(body,{status:body.error?409:200}));
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w,{computerProvider:async()=>provider});
        try{
            w.discover();w.bind([p.port]);await settle();
            assert.deepEqual(w.types(),['preparing','unavailable']);assert.ok(w.shown(title));assert.deepEqual(p.types(),['capture-ready']);
            assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'workspace_unavailable');
            assert.deepEqual([w.assigned,w.opened],[[],[]]);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a frame whose browser-reported ancestor is not Universe keeps the locked view and never answers or binds',async t=>{
    const fetch=t.mock.method(globalThis,'fetch',async()=>assert.fail('unexpected network'));
    for(const ancestors of [['https://evil.example'],[universe,universe]]){
        const w=embeddedWindow(entry,{ancestors}),p=parentPort();
        const gate=embeddedGate(w);
        try{
            w.discover();w.bind([p.port]);await settle();
            assert.deepEqual(w.posted,[]);assert.deepEqual(p.got,[]);assert.equal(fetch.mock.callCount(),0);
            assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.ok(w.shown('Open your assigned OS tab'));
        }finally{await gate.close();p.close();}
    }
});
test('a retransmitted first frame gets the same phase acknowledgement once, with no new upload, and only for identical bytes',async t=>{
    let release;const holdSeed=new Promise(r=>release=r);
    const server=fakeServer({holdSeed});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    const copy=()=>seedPart({bytes:new Uint8Array([26,69,223,163,1]).buffer});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        // The parent's reply timer fired while the first attempt was still being confirmed: both attempts share it.
        const first=p.rpc('upload',{captureSessionId:session,part:copy()}),again=p.rpc('upload',{captureSessionId:session,part:copy()});
        await settle(20);release();
        const [one,two]=await Promise.all([first,again]);
        const expected={confirmed:true,phaseReady:true,captureSessionId:session,nextSequence:1,startedAt:server.startedAt,deadlineAt:server.deadlineAt};
        assert.deepEqual(one.value,{...expected,serverNow:server.serverNow()});
        assert.deepEqual({...two.value,serverNow:undefined},{...expected,serverNow:undefined});
        assert.ok(Date.parse(two.value.serverNow)>=Date.parse(server.serverNow()));
        await settle(40);
        const late=await p.rpc('upload',{captureSessionId:session,part:copy()});
        assert.ok(Date.parse(late.value.serverNow)-Date.parse(server.serverNow())>=35,'a replay advances the broker clock by the elapsed time');
        assert.deepEqual({...late.value,serverNow:undefined},{...expected,serverNow:undefined},'a later retransmit is acknowledged the same way');
        assert.ok(Date.parse(late.value.serverNow)>=Date.parse(two.value.serverNow),'the replayed broker clock only moves forward');
        const uploads=()=>server.log.filter(x=>['prepare','put','confirm'].includes(x));
        assert.deepEqual(uploads(),['prepare','put','confirm'],'one upload for three deliveries');
        for(const part of [seedPart({bytes:new Uint8Array([26,69,223,163,2]).buffer}),seedPart({endMs:2}),seedPart({startMs:1,endMs:2})])
            assert.equal((await p.rpc('upload',{captureSessionId:session,part})).code,'invalid_segment');
        assert.deepEqual(uploads(),['prepare','put','confirm'],'no alternate payload reaches the media service');
    }finally{await gate.close();p.close();}
});
test('a first frame the broker refused is uploaded again for real, and no segment precedes a confirmed seed',async t=>{
    let release;const holdSeed=new Promise(r=>release=r);
    const server=fakeServer({failSeedOnce:true,holdSeed});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort();
    const gate=embeddedGate(w,{prepare:async()=>checkout});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seedPart()})).code,'media_unavailable');
        const pending=p.rpc('upload',{captureSessionId:session,part:seedPart()});
        await settle(20);
        assert.equal((await p.rpc('upload',{captureSessionId:session,part:seedPart({sequence:1,endMs:1000})})).code,'seed_not_confirmed');
        release();
        assert.equal((await pending).value.phaseReady,true);
        assert.deepEqual(server.log.filter(x=>x==='confirm').length,2);
    }finally{await gate.close();p.close();}
});

// ── One loader, the acknowledged release, the ordinary wake and the diagnostics ────────────────────────────────────
// The transport's own `editor-ready` (the broker lane's) when this tree has it, else its request as that lane sends it:
// the attempt, the capture and the open proof, and no time.
const withEditorReady=options=>{
    const real=createAssignmentVideoTransport(options);
    return {...real,editorReady:real.editorReady??(async()=>{
        const response=await fetch('/api/shell/assignment-video',{method:'POST',body:JSON.stringify({action:'editor-ready',attemptId:options.attemptId,
            captureSessionId:options.captureSessionId,repoOpenProof:options.repoOpenProof})});
        const data=await response.json();
        if(!response.ok)throw Object.assign(new Error(data.error.code),{code:data.error.code});
        return {startedAt:data.startedAt,deadlineAt:data.deadlineAt,serverNow:data.serverNow};
    })};
};
// The parent ends its phase before the frame goes away, so closing the gate has nothing left to wait for.
const endShare=(p,captureSessionId=session)=>p.rpc('end',{captureSessionId,reason:'connection_lost',expectedSegments:1});
const stageTag=createHash('sha256').update('ezil.assignment.stage.v1\0'+id).digest('hex').slice(0,16);
const diagnosticLines=t=>{
    const lines=[];t.mock.method(console,'info',line=>{if(String(line).startsWith('assignment.workspace.'))lines.push(String(line));});
    return lines;
};
test('while the workspace prepares the gate draws nothing over the Code window loader, and one editor opens',async t=>{
    const server=fakeServer();t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0},parks=[],screens=new Set();
    const gate=state.gate=embeddedGate(w,{park:(...call)=>parks.push(call),prepare:async()=>checkout,open:editorOpener(state)});
    const look=()=>{screens.add(w.screen());assert.equal(w.screen(),'loader');assert.equal(gate.locked(),true);};
    try{
        look();assert.deepEqual(parks,[[true,true]],'launch parks the editor under the window loader, with no screen of its own');
        // A retransmitted discover, and a new challenge after a parent reload, start nothing twice.
        w.discover({challenge:session});look();w.discover();w.discover();look();
        w.bind([p.port]);look();await settle();look();
        assert.deepEqual(server.log,['preflight']);assert.deepEqual(p.types(),['capture-ready','ready']);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});look();
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);look();
        assert.ok(parks.every(call=>call[0]===true&&call[1]===true),'every park before release keeps the loader: '+JSON.stringify(parks));
        assert.equal((await p.rpc('unlock',{captureSessionId:session})).ok,true);
        assert.deepEqual([...screens],['loader']);assert.equal(w.screen(),'loader','released: still no gate screen');
        assert.equal(gate.locked(),false);assert.deepEqual(parks.at(-1),[false,false]);
        assert.equal(parks.filter(call=>call[0]===false).length,1,'released once');assert.equal(state.opened,1,'one editor open');
        // A stopped share is a state the person acts on: the gate says so, and the next share is the loader again.
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});await settle();
        assert.equal(w.screen(),'Sharing paused');assert.deepEqual(parks.at(-1),[true,false]);assert.equal(gate.locked(),true);
        await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:1});
        const again='11111111-1111-4111-8111-111111111111';
        assert.equal((await p.rpc('begin',{captureSessionId:again,consentVersion:4})).ok,true);
        assert.equal(w.screen(),'loader');assert.deepEqual(parks.at(-1),[true,true]);
        assert.equal(state.opened,1,'a new share opens no editor before its own first frame');
        assert.deepEqual(server.log.filter(x=>x==='preflight').length,3,'one eligibility check for the frame, then one per share');
        await endShare(p,again);
    }finally{await gate.close();p.close();}
});
test('a parent that never answers is named only after twenty seconds, and its first valid discover returns to the loader',async t=>{
    t.mock.timers.enable({apis:['setTimeout']});
    const fetch=t.mock.method(globalThis,'fetch',async()=>Response.json(eligibleBody({})));
    const w=embeddedWindow();
    const gate=embeddedGate(w);
    try{
        assert.equal(w.screen(),'loader');
        // Nothing but the exact parent counts as an answer.
        w.discover({},w.top,'https://universe.ezil.work');w.discover({},{postMessage(){}});w.discover({challenge:'not-a-challenge'});w.discover({attemptId:session});
        t.mock.timers.tick(19999);assert.equal(w.screen(),'loader');
        t.mock.timers.tick(1);assert.equal(w.screen(),'Open this assignment from Universe');
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.equal(fetch.mock.callCount(),0);assert.deepEqual(w.posted,[]);
        w.discover();assert.equal(w.screen(),'loader');assert.deepEqual(w.types(),['preparing']);
    }finally{t.mock.timers.reset();await gate.close();}
    // An answered frame never shows it.
    t.mock.timers.enable({apis:['setTimeout']});
    const answered=embeddedWindow(),second=embeddedGate(answered);
    try{answered.discover();t.mock.timers.tick(60000);assert.equal(answered.screen(),'loader');}
    finally{t.mock.timers.reset();await second.close();}
});
test('capture-ready reaches only the accepted parent port, once, before the eligibility answer and never a refused frame',async t=>{
    let release;const held=new Promise(r=>release=r);
    t.mock.method(globalThis,'fetch',async()=>{await held;return Response.json(eligibleBody({}));});
    const w=embeddedWindow(),forged=[parentPort(),parentPort(),parentPort(),parentPort()],p=parentPort(),late=parentPort();
    const gate=embeddedGate(w);
    try{
        w.bind([forged[0].port]);
        w.discover();
        w.bind([forged[1].port],{},w.top,'https://universe.ezil.work');w.bind([forged[2].port],{challenge:session});w.bind([forged[3].port],{},{postMessage(){}});
        await settle();
        assert.ok(forged.every(port=>port.got.length===0),'a forged or early bind hears nothing');
        w.bind([p.port]);await settle();
        assert.deepEqual(p.got,[{protocol,attemptId:id,type:'capture-ready'}],'the picker may be offered while eligibility is still being verified');
        assert.equal((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_not_ready','capture-ready opens no RPC');
        w.discover();w.bind([late.port]);await settle();
        assert.deepEqual(late.got,[]);assert.deepEqual(p.types(),['capture-ready']);
        release();await settle();
        assert.deepEqual(p.types(),['capture-ready','ready']);assert.deepEqual(w.types(),['preparing','preparing']);
    }finally{await gate.close();[...forged,p,late].forEach(port=>port.close());}
    for(const who of [null,'']){
        const out=embeddedWindow(),port=parentPort(),closed=embeddedGate(out,{who});
        try{out.discover();out.bind([port.port]);await settle();assert.deepEqual(port.got,[],'a signed-out frame offers no picker');}
        finally{await closed.close();port.close();}
    }
});
test('when Universe signs editorReadySupported the verified editor stays parked until it acknowledges editor-ready',async t=>{
    let release;const hold=new Promise(r=>release=r);
    const server=fakeServer({flag:true,ack:{hold}});t.mock.method(globalThis,'fetch',server.handler);
    const lines=diagnosticLines(t);
    const w=embeddedWindow(),p=parentPort(),state={opened:0},parks=[];
    const gate=state.gate=embeddedGate(w,{park:(...call)=>parks.push(call),prepare:async()=>checkout,open:editorOpener(state,{workbench:true}),transport:withEditorReady});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await settle(30);
        // The editor's workbench is mounted on the verified folder, and nobody can use it yet.
        assert.equal(state.opened,1);assert.equal(gate.locked(),true);assert.equal(w.screen(),'loader');
        assert.ok(parks.every(call=>call[0]===true),'still parked');assert.deepEqual(w.types(),['preparing']);
        assert.deepEqual(p.types(),['capture-ready','ready']);
        assert.deepEqual(server.asked,[{action:'editor-ready',attemptId:id,captureSessionId:session,repoOpenProof:proof}],'no time is sent');
        release();
        const unlocked=await unlocking;
        // Released in order: the editor, the port event, the unlock reply, the window state.
        assert.equal(gate.locked(),false);assert.deepEqual(parks.at(-1),[false,false]);
        const usable=p.got.findIndex(d=>d.type==='editor-usable');
        assert.ok(usable>0&&usable<p.got.indexOf(unlocked),'editor-usable precedes the unlock reply');
        // The work clock travels only in editor-usable; unlock keeps the seed's start and the broker's latest media cutoff.
        assert.deepEqual(p.got[usable],{protocol,attemptId:id,type:'editor-usable',captureSessionId:session,deadlineAt:server.work.deadlineAt,serverNow:server.work.serverNow});
        assert.deepEqual(unlocked.value,{status:'ready',captureSessionId:session,startedAt:server.startedAt,deadlineAt:server.moved.deadlineAt,serverNow:server.moved.serverNow});
        assert.notEqual(server.work.deadlineAt,server.moved.deadlineAt);
        assert.deepEqual((await p.rpc('status',{captureSessionId:session})).value,
            {captureSessionId:session,status:'recording',stopRequestedAt:null,deadlineAt:server.moved.deadlineAt,serverNow:server.moved.serverNow});
        assert.deepEqual(w.types(),['preparing','ready']);
        await settle();
        assert.deepEqual(lines,['discover.accepted','bind.accepted','prepare.start','prepare.ready','editor_ready.reported','editor.usable']
            .map(event=>'assignment.workspace.'+event+' stage='+stageTag));
        const wire=JSON.stringify([...p.got,...w.posted,...lines]);
        assert.ok(!wire.includes(proof)&&!wire.includes(recordingId)&&!wire.includes(server.work.startedAt),'the proof, the recording and the work start stay in the OS');
        assert.ok(lines.every(line=>![id,session,challenge,repo,'owner'].some(value=>line.includes(value))),'a diagnostic names no identifier');
        await endShare(p);
    }finally{await gate.close();p.close();}
});
test('a refused editor-ready keeps the editor parked and fails unlock; a transient one is asked again',async t=>{
    for(const [failures,transport,code,released,klass] of [
        [['recording_closed'],withEditorReady,'recording_closed',false,'phase'],
        [['media_unavailable'],withEditorReady,null,true,null],
        [['media_unavailable','media_unavailable','media_unavailable'],withEditorReady,'media_unavailable',false,'media'],
        [['identity_refresh_required'],withEditorReady,'identity_refresh_required',false,'identity'],
        // The flag without a transport that can say it: closed, never released on the old rule.
        [[],options=>({...createAssignmentVideoTransport(options),editorReady:undefined}),'editor_ready_unsupported',false,'protocol'],
    ]){
        const server=fakeServer({flag:true,ack:{failures:[...failures]}});t.mock.method(globalThis,'fetch',server.handler);
        const lines=diagnosticLines(t);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state,{workbench:true}),transport});
        try{
            await bound(w,p);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            const unlocked=await p.rpc('unlock',{captureSessionId:session});await settle();
            const label=JSON.stringify(failures)+' '+code;
            assert.equal(unlocked.ok,released,label);assert.equal(gate.locked(),!released,label);
            assert.equal(p.types().includes('editor-usable'),released,label);
            assert.equal(w.types().includes('ready'),released,label);
            assert.equal(server.asked.length,transport===withEditorReady?Math.min(3,failures.length+(released?1:0)):0,label);
            if(released){assert.equal(lines.at(-1),'assignment.workspace.editor.usable stage='+stageTag);await endShare(p);continue;}
            assert.equal(unlocked.code,code,label);assert.equal(gate.access(),null,label);
            assert.ok(lines.includes('assignment.workspace.editor_ready.refused stage='+stageTag+' refusal='+klass),label+' '+lines.join('|'));
            assert.ok(!lines.some(line=>line.includes('editor.usable')||line.includes(code)),label);
            assert.equal(w.screen(),code==='identity_refresh_required'?'Sign in to EZiL OS':'Sharing paused',label);
            if(code==='identity_refresh_required')assert.equal(w.types().at(-1),'authentication_required');
            else await endShare(p);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('a stage that does not sign the flag releases the editor as before and never asks editor-ready',async t=>{
    for(const flag of [undefined,false,'true',1]){
        const server=fakeServer({flag});t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),state={opened:0};
        const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state),
            transport:options=>({...createAssignmentVideoTransport(options),editorReady(){assert.fail('editor-ready is not this stage\'s rule');}})});
        try{
            await bound(w,p);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            const unlocked=await p.rpc('unlock',{captureSessionId:session});
            assert.deepEqual(unlocked.value,{status:'ready',captureSessionId:session,startedAt:server.startedAt,deadlineAt:server.deadlineAt},String(flag));
            assert.deepEqual(p.got.find(d=>d.type==='editor-usable'),{protocol,attemptId:id,type:'editor-usable',captureSessionId:session},'no work clock without an acknowledgement');
            assert.deepEqual(w.types(),['preparing','ready']);assert.equal(gate.locked(),false);
            assert.deepEqual(server.asked,[]);assert.ok(!server.log.includes('editor-ready'));
            await endShare(p);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
// ── The signed preparation needs the editor's own mounted workbench, never the address echo alone ──────────────────
const flush=async(turns=40)=>{for(let i=0;i<turns;i++)await new Promise(resolve=>setImmediate(resolve));};
// Up to an `unlock` in flight whose editor document has answered with its folder echo only.
async function echoedOnly(t,{flag=true,opener={}}={}){
    const server=fakeServer({flag});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0},parks=[];
    const gate=state.gate=embeddedGate(w,{park:(...call)=>parks.push(call),prepare:async()=>checkout,open:editorOpener(state,opener),transport:withEditorReady});
    await bound(w,p);
    await p.rpc('begin',{captureSessionId:session,consentVersion:4});
    const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
    return {server,w,p,state,parks,gate};
}
const parked=({server,w,p,gate,parks},label)=>{
    assert.deepEqual(server.asked,[],label+': Universe is told nothing');
    assert.equal(gate.locked(),true,label);assert.ok(parks.every(call=>call[0]===true),label+': still parked');
    assert.ok(!p.types().includes('editor-usable'),label);assert.ok(!w.types().includes('ready'),label);
};
test('only the signed preparation asks for the mounted workbench',async t=>{
    for(const [flag,required] of [[true,true],[undefined,false],[false,false],['true',false],[1,false]]){
        const server=fakeServer({flag});t.mock.method(globalThis,'fetch',server.handler);
        const w=embeddedWindow(),p=parentPort(),gate=embeddedGate(w);
        try{
            assert.equal(gate.requiresWorkbench(),false,'nothing is asked before Universe answers');
            await bound(w,p);
            assert.equal(gate.requiresWorkbench(),required,String(flag));
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
    // The assignment in its own OS tab has no acknowledged release, and so no such question.
    t.mock.method(globalThis,'fetch',async()=>Response.json({error:{code:'assignment_video_creator_unlinked'}},{status:409}));
    consentWindow(entry);
    const own=openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>'owner',computerId:'fixture',body:new Element(),park(){},
        prepare:()=>assert.fail('checkout must stay closed'),open:()=>assert.fail('editor must stay closed')});
    assert.equal(own.requiresWorkbench,undefined);
    await settle();await own.close();
});
test('a verified folder echo whose workbench never mounts sends no editor-ready, stays parked and fails unlock on its own timer',async t=>{
    const lines=diagnosticLines(t);
    const run=await echoedOnly(t),{server,w,p,state,gate}=run;
    try{
        t.mock.timers.enable({apis:['setTimeout']});
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await flush();
        assert.equal(state.opened,1,'the editor document was opened');parked(run,'echo only');
        // The same echo again (a second hello of the same document) is still only an echo.
        state.report(false);state.report(false);await flush();parked(run,'echo repeated');
        t.mock.timers.tick(79999);await flush();parked(run,'just before the timer');
        t.mock.timers.tick(1);
        const unlocked=await unlocking;
        assert.equal(unlocked.ok,false);assert.equal(unlocked.code,'assigned_checkout_unverified');
        assert.equal(gate.access(),null,'no further editor may be minted for this unlock');assert.equal(w.screen(),'Sharing paused');
        // The workbench that mounts after the timer releases nothing and tells Universe nothing.
        state.report(true);state.report(false);await flush();
        parked(run,'late workbench');assert.ok(!server.log.includes('editor-ready'));
        assert.ok(!lines.some(line=>line.includes('editor_ready')||line.includes('editor.usable')),lines.join('|'));
        t.mock.timers.reset();
        await endShare(p);
    }finally{t.mock.timers.reset();await gate.close();p.close();}
});
test('a workbench that mounts late releases once: one editor-ready, one release, and a repeat changes nothing',async t=>{
    const run=await echoedOnly(t),{server,w,p,state,parks,gate}=run;
    try{
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await settle(40);parked(run,'before the workbench');
        // Twice at once, as two hellos of one mounted document would report it.
        state.report(true);state.report(true);
        const unlocked=await unlocking;
        state.report(true);state.report(false);await settle(20);
        assert.equal(unlocked.ok,true,JSON.stringify(unlocked));assert.equal(gate.locked(),false);
        assert.deepEqual(server.asked,[{action:'editor-ready',attemptId:id,captureSessionId:session,repoOpenProof:proof}],'asked once');
        assert.equal(parks.filter(call=>call[0]===false).length,1,'released once');
        assert.equal(p.types().filter(type=>type==='editor-usable').length,1);assert.deepEqual(w.types(),['preparing','ready']);
        await endShare(p);
    }finally{await gate.close();p.close();}
});
test('a workbench report counts only for the verified folder, this frame and the phase that is still open',async t=>{
    // Another folder, even after a good echo: refused like any unverified checkout.
    {
        const run=await echoedOnly(t,{opener:{workbench:true,workbenchRoot:'/root'}}),{p,gate}=run;
        try{
            const unlocked=await p.rpc('unlock',{captureSessionId:session});
            assert.equal(unlocked.code,'assigned_checkout_unverified');parked(run,'wrong folder');assert.equal(gate.access(),null);
            await endShare(p);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
    // A frame that has left the document.
    {
        const run=await echoedOnly(t),{p,state,gate}=run;
        try{
            const unlocking=p.rpc('unlock',{captureSessionId:session});
            await settle(40);
            state.frame.isConnected=false;state.report(true);await settle(20);parked(run,'detached frame');
            state.frame.isConnected=true;
            // The share stops: the phase is over, and the workbench that mounts afterwards releases nothing.
            p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
            assert.equal((await unlocking).code,'workspace_locked');
            state.report(true);await settle(20);parked(run,'after the share stopped');
            await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:1});
            // Nothing in flight at all.
            state.report(true);await settle(20);parked(run,'no phase');
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('without the signed flag the folder echo releases as before and a workbench report is never what releases',async t=>{
    const run=await echoedOnly(t,{flag:false}),{server,p,state,parks,gate}=run;
    try{
        const unlocked=await p.rpc('unlock',{captureSessionId:session});
        assert.equal(unlocked.ok,true);assert.equal(gate.locked(),false);
        state.report(true);state.report(false);await settle(20);
        assert.equal(parks.filter(call=>call[0]===false).length,1,'released once, by the echo');
        assert.equal(p.types().filter(type=>type==='editor-usable').length,1);assert.deepEqual(server.asked,[]);
        await endShare(p);
    }finally{await gate.close();p.close();t.mock.restoreAll();}
    // A workbench report that arrives with no echo before it does not release an unsigned stage.
    t.mock.method(globalThis,'fetch',fakeServer().handler);
    const w=embeddedWindow(),p2=parentPort(),state2={opened:0},parks2=[];
    const frame={isConnected:true,contentWindow:{postMessage(){}}},address='https://code.example/?folder='+encodeURIComponent(workspaceFolder)+'&ezil_mint=m';
    const gate2=state2.gate=embeddedGate(w,{park:(...call)=>parks2.push(call),prepare:async()=>checkout,
        open:()=>{state2.opened++;queueMicrotask(()=>confirmAssignmentFolder({repoUrl:repo},null,frame,address,checkoutFolder,true));}});
    try{
        await bound(w,p2);
        await p2.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p2.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        const unlocking=p2.rpc('unlock',{captureSessionId:session});
        await settle(40);
        assert.equal(state2.opened,1);assert.equal(gate2.locked(),true);assert.ok(parks2.every(call=>call[0]===true));
        confirmAssignmentFolder({repoUrl:repo},null,frame,address,checkoutFolder);
        assert.equal((await unlocking).ok,true);assert.equal(gate2.locked(),false);
        await endShare(p2);
    }finally{await gate2.close();p2.close();}
});
test('a media cutoff the broker moves is relayed only for the same start and inside the signed bound',async t=>{
    const now=Date.now(),iso=ms=>new Date(now+ms).toISOString(),startedAt=iso(-1000);
    for(const [flag,status,expected] of [
        [true,{deadlineAt:iso(3838000)},{deadlineAt:iso(3838000)}],
        [true,{deadlineAt:iso(3839001)},null],
        [true,{startedAt:iso(-999),deadlineAt:iso(1900000)},null],
        [true,{deadlineAt:startedAt},null],
        [true,{deadlineAt:'soon'},null],
        [undefined,{deadlineAt:iso(3838000)},null],
    ]){
        let seeded=false;
        t.mock.method(globalThis,'fetch',async(path,options)=>{
            if(String(path).startsWith(bucket))return new Response(null,{status:200});
            const body=JSON.parse(options.body),same={recordingId,captureSessionId:session};
            if(body.action==='preflight')return Response.json(eligibleBody(flag?{editorReadySupported:true}:{}));
            if(body.action==='begin')return Response.json({...same,status:'awaiting_frame',nextSequence:0,authorizationExpiresAt:iso(600000)});
            if(body.action==='prepare')return Response.json({headers:{},putUrl:`${bucket}/universe-staging/assignment-media/v1/o/${id}/${recordingId}/segments/0/${body.sha256}.webm`});
            if(body.action==='confirm'){seeded=true;return Response.json({...same,sequence:0,confirmed:true,phaseReady:true,nextSequence:1,firstFrameAt:iso(0),startedAt,deadlineAt:iso(1800000),serverNow:iso(0)});}
            return Response.json({...same,status:'recording',phaseReady:seeded,workspaceUnlocked:seeded,firstFrameAt:iso(0),startedAt,stopRequestedAt:null,...status});
        });
        const w=embeddedWindow(),p=parentPort();
        const gate=embeddedGate(w,{prepare:async()=>checkout});
        try{
            await bound(w,p);
            await p.rpc('begin',{captureSessionId:session,consentVersion:4});
            const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
            const answer=await p.rpc('status',{captureSessionId:session});
            const label=JSON.stringify([flag,status]);
            if (flag && !expected) {
                assert.equal(answer.ok,false,label);
                assert.equal(answer.code,'recording_changed',label);
            } else {
                assert.equal(answer.ok,true,label);
                assert.deepEqual(answer.value,{captureSessionId:session,status:'recording',stopRequestedAt:null,...(expected??{})},label);
            }
            await endShare(p);
        }finally{await gate.close();p.close();t.mock.restoreAll();}
    }
});
test('the ordinary wake is asked once, only after the signed eligibility answer, and never for a refused frame',async t=>{
    let release;const held=new Promise(r=>release=r);
    const server=fakeServer();
    t.mock.method(globalThis,'fetch',async(path,options)=>{if(JSON.parse(options.body??'{}').action==='preflight')await held;return server.handler(path,options);});
    const w=embeddedWindow(),p=parentPort(),state={opened:0};let wakes=0;
    const gate=state.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(state),wake(){wakes++;throw Error('a failed wake is the wake\'s own');}});
    try{
        w.discover();w.bind([p.port]);await settle();
        assert.equal(wakes,0,'no wake before Universe answered for this signed-in person');
        release();await settle();
        assert.equal(wakes,1);assert.deepEqual(p.types(),['capture-ready','ready'],'a wake that throws changes nothing');
        assert.ok(!server.log.includes('begin')&&state.opened===0,'the wake precedes any share, checkout or editor');
        // Retransmits, a whole share, a stop and a second share: the same one wake.
        w.discover();w.discover({challenge:session});w.discover();
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        await p.rpc('unlock',{captureSessionId:session});
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:1});
        await p.rpc('begin',{captureSessionId:'11111111-1111-4111-8111-111111111111',consentVersion:4});
        assert.equal(wakes,1);
        await endShare(p,'11111111-1111-4111-8111-111111111111');
    }finally{await gate.close();p.close();t.mock.restoreAll();}
    for(const [response,who,provider] of [
        [()=>Response.json({error:{code:'identity_refresh_required'}},{status:409}),'owner',null],
        [()=>Response.json({error:{code:'assignment_identity_mismatch'}},{status:409}),'owner',null],
        [()=>Response.json({error:{code:'assignment_video_creator_unlinked'}},{status:409}),'owner',null],
        [()=>Response.json(eligibleBody({})),'owner','aws-ec2'],
        [()=>Response.json(eligibleBody({})),null,null],
    ]){
        t.mock.method(globalThis,'fetch',async()=>response());
        const out=embeddedWindow(),port=parentPort();let asked=0;
        const closed=embeddedGate(out,{who,wake(){asked++;},computerProvider:async()=>provider});
        try{out.discover();out.bind([port.port]);await settle();assert.equal(asked,0,'no wake for a refused, unverified or signed-out frame');}
        finally{await closed.close();port.close();t.mock.restoreAll();}
    }
});
// ── The gate belongs to the OS document: its Code window may close (native X) and open again (dock) under one capture ──
// The document's next Code window for the same assignment, as `../apps/code.js` opens it from a projectless dock launch.
const dockLaunch=(hooks,{who='owner',computerId='fixture',project=assignedProject({computerId,actor:()=>who})}={})=>
    openWithAssignmentConsent({project,actor:()=>who,computerId,body:new Element(),park(){},
        prepare:()=>assert.fail('a reopened window prepares no checkout'),open:()=>assert.fail('no editor is due'),...hooks});
// A released, recording assignment under the signed preparation: one begin, one seed, one editor-ready, one editor-usable.
async function releasedAssignment(t,{flag=true}={}){
    const server=fakeServer({flag});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),state={opened:0},parks=[];
    const gate=state.gate=embeddedGate(w,{park:(...call)=>parks.push(call),prepare:async()=>checkout,open:editorOpener(state,{workbench:flag}),transport:withEditorReady});
    await bound(w,p);
    await p.rpc('begin',{captureSessionId:session,consentVersion:4});
    const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
    const unlocked=await p.rpc('unlock',{captureSessionId:session});
    assert.equal(unlocked.ok,true);assert.equal(gate.locked(),false);
    assert.deepEqual(p.types(),['capture-ready','ready','editor-usable']);assert.deepEqual(w.types(),['preparing','ready']);
    return {server,w,p,state,gate,parks,unlocked};
}
const count=(log,action)=>log.filter(entry=>(Array.isArray(entry)?entry[0]:entry)===action).length;
test('closing only the Code window keeps the port, the capture and both clocks; the dock opens the same checkout again, once',async t=>{
    const {server,w,p,state,gate}=await releasedAssignment(t);
    try{
        const before={port:p.got.length,window:w.posted.length,log:server.log.length};
        state.frame.isConnected=false;gate.detach();await settle(20);
        // Nothing is said and nothing ends: no pause, no reopen, no window state, no request.
        assert.deepEqual({port:p.got.length,window:w.posted.length,log:server.log.length},before,'native X is silent on the port, the window and the server');
        assert.equal(gate.locked(),true,'no editor without a window');
        assert.deepEqual(gate.access(),{attemptId:id,phase:'reopen',repoOpenProof:proof,captureSessionId:session},'the original receipt and capture are still this document\'s');
        // The capture goes on without a Code window: the parent's pulse and its next clip are taken as before.
        p.post('pulse',{captureSessionId:session});
        const clip=seedPart({sequence:1,startMs:0,endMs:11000});
        assert.deepEqual((await p.rpc('upload',{captureSessionId:session,part:clip},[clip.bytes])).value,{confirmed:true,sequence:1});
        assert.deepEqual((await p.rpc('status',{captureSessionId:session})).value,
            {captureSessionId:session,status:'recording',stopRequestedAt:null,deadlineAt:server.moved.deadlineAt,serverNow:server.moved.serverNow});
        // A projectless launch finds the assigned repository only for this person and this computer.
        assert.deepEqual(assignedProject({computerId:'fixture',actor:()=>'owner'}),{repoUrl:repo});
        assert.equal(assignedProject({computerId:'another',actor:()=>'owner'}),null);
        assert.equal(assignedProject({computerId:'fixture',actor:()=>'someone-else'}),null);
        assert.equal(assignedProject({computerId:'fixture',actor:()=>null}),null);
        assert.equal(assignedProject({computerId:'fixture',actor:()=>'owner',win:{...w.win}}),null,'another window is not this document');
        // The dock's window: the same gate, parked under its own loader until ITS editor mounts the verified workbench.
        const again={opened:0},parks=[];
        again.gate=dockLaunch({park:(...call)=>parks.push(call),open:editorOpener(again,{workbench:false})});
        assert.equal(again.gate,gate,'the document\'s gate, not a second one');
        assert.deepEqual(parks,[[true,true]]);assert.equal(w.screen(),'loader');
        await settle(20);
        assert.equal(again.opened,1,'one fresh editor');
        assert.deepEqual(again.access,{attemptId:id,phase:'reopen',repoOpenProof:proof,captureSessionId:session},'a reopen of the original receipt and capture');
        assert.equal(count(server.log,'preflight'),2,'no eligibility, checkout or begin is asked again');
        assert.equal(gate.locked(),true,'the folder echo alone does not release it');
        assert.ok(parks.every(call=>call[0]===true));
        state.report(true);await settle();
        assert.equal(gate.locked(),true,'the closed window\'s editor is not this window\'s');
        again.report(true);await settle();
        assert.equal(gate.locked(),false);assert.deepEqual(parks.at(-1),[false,false]);
        again.report(true);await settle();
        assert.deepEqual(parks.filter(call=>call[0]===false).length,1,'released once');
        // One begin, one clock, one editor-ready, one editor-usable; no pause, no reopen, no second window state.
        assert.equal(count(server.log,'begin'),1);assert.equal(server.asked.length,1,'editor-ready is never signed twice');
        assert.deepEqual(p.types(),['capture-ready','ready','editor-usable']);assert.deepEqual(w.types(),['preparing','ready']);
        assert.equal(count(server.log,'checkpoint'),0);
        // The explicit Stop still ends the phase at once.
        p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});await settle();
        assert.equal(gate.locked(),true);assert.equal(gate.access(),null);assert.equal(w.screen(),'Sharing paused');
        assert.deepEqual((await p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:2})).value,{});
        assert.equal(server.log.at(-1),'checkpoint');
        // A stopped share draws its own message in the next window too, and opens no editor.
        again.frame.isConnected=false;gate.detach();
        const third=dockLaunch({});assert.equal(third,gate);assert.equal(w.screen(),'Sharing paused');await settle();
    }finally{await gate.close();await settle();p.close();}
});
test('a reopened editor on any folder but the verified checkout ends the phase as a lost workspace does',async t=>{
    const {server,w,p,state,gate}=await releasedAssignment(t);
    try{
        state.frame.isConnected=false;gate.detach();
        const again={opened:0};
        again.gate=dockLaunch({open:editorOpener(again,{root:'/workspace/other',folder:'/workspace/other',workbench:true})});
        await settle(30);
        assert.equal(again.opened,1);assert.equal(gate.locked(),true);assert.equal(gate.access(),null);
        assert.deepEqual(p.types(),['capture-ready','ready','editor-usable','pause']);
        assert.deepEqual(p.got.findLast(d=>d.type==='pause'),{protocol,attemptId:id,type:'pause',reason:'connection_lost',effectiveAt:null});
        assert.equal(server.log.at(-1),'checkpoint');assert.equal(w.screen(),'Sharing paused');assert.equal(server.asked.length,1);
    }finally{await gate.close();await settle();p.close();}
});
test('without a Code window, Stop, the outer pagehide and any other Code launch still end the phase at once',async t=>{
    // Stop: the parent's lock and end are taken exactly as with a window.
    let f=await releasedAssignment(t);
    f.state.frame.isConnected=false;f.gate.detach();
    f.p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});await settle();
    assert.equal(f.gate.access(),null);
    assert.deepEqual((await f.p.rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:1})).value,{});
    assert.equal(f.server.log.at(-1),'checkpoint');assert.deepEqual(f.p.types(),['capture-ready','ready','editor-usable']);
    await f.gate.close();await settle();f.p.close();
    // The document going away: the keepalive checkpoint, then pause and reopen, as before.
    t.mock.restoreAll();f=await releasedAssignment(t);
    f.state.frame.isConnected=false;f.gate.detach();
    assert.equal(f.w.listeners.get('pagehide').size,1,'the document\'s own pagehide stays bound while the window is closed');
    for(const fn of [...f.w.listeners.get('pagehide')])fn();
    await settle(20);
    assert.equal(f.gate.access(),null);assert.equal(assignedProject({computerId:'fixture',actor:()=>'owner'}),null,'a closing gate is not taken back');
    assert.ok(count(f.server.log,'checkpoint')>=1);assert.equal(f.p.types().at(3),'pause');
    await endShare(f.p);await f.gate.close();await settle();
    assert.deepEqual(f.p.types(),['capture-ready','ready','editor-usable','pause','reopen']);f.p.close();
    // Another person, another computer or another project in this document's next Code window: the held phase ends.
    for(const other of [{who:'someone-else'},{computerId:'another'},{project:null},{project:{repoUrl:'https://github.ezil.work/default/ordinary.git'}}]){
        t.mock.restoreAll();f=await releasedAssignment(t);
        f.state.frame.isConnected=false;f.gate.detach();
        let opened=0;
        const next=dockLaunch({open:()=>{opened++;},prepare:async()=>checkout},other);
        assert.notEqual(next,f.gate,JSON.stringify(other));
        await settle(20);
        assert.equal(f.gate.access(),null);assert.equal(f.p.types().at(3),'pause',JSON.stringify(other));
        await endShare(f.p);await f.gate.close();await settle();
        assert.deepEqual(f.p.types(),['capture-ready','ready','editor-usable','pause','reopen'],JSON.stringify(other));
        assert.equal(f.server.asked.length,1);
        await next?.close();f.p.close();
    }
});
test('a Code window closed while its share prepares is not a refusal: the document is asked for the window, and the same phase goes on in it',async t=>{
    const server=fakeServer({flag:true});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),first={opened:0};let summoned=0,dropCheckout;
    const summon=()=>{summoned++;};
    const gate=first.gate=embeddedGate(w,{summon,transport:withEditorReady,open:editorOpener(first,{workbench:true}),
        prepare:()=>new Promise((_,reject)=>{dropCheckout=()=>reject(Object.assign(new Error('closed'),{code:'workspace_disconnected'}));})});
    try{
        await bound(w,p);
        const beginning=p.rpc('begin',{captureSessionId:session,consentVersion:4});
        await settle();
        // Native X while the checkout prepares: that window's mint is dropped, the phase is not.
        gate.detach();dropCheckout();await settle(20);
        assert.equal(summoned,1,'the document is asked for its Code window');
        assert.deepEqual(p.types(),['capture-ready','ready']);assert.equal(count(server.log,'begin'),0);
        const second={opened:0};
        second.gate=dockLaunch({summon,prepare:async()=>checkout,open:editorOpener(second,{workbench:true})});
        assert.equal(second.gate,gate);
        const grant=await beginning;
        assert.deepEqual(grant.value,{captureSessionId:session,status:'awaiting_frame',nextSequence:0});
        assert.equal(count(server.log,'begin'),1);
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        // Closed again before the editor is asked for: unlock asks for the window and opens the editor in it.
        gate.detach();
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await settle(30);
        assert.equal(summoned,2);assert.equal(second.opened,0);
        const third={opened:0};
        third.gate=dockLaunch({summon,open:editorOpener(third,{workbench:true})});
        const unlocked=await unlocking;
        assert.equal(unlocked.ok,true,JSON.stringify(unlocked));assert.equal(third.opened,1);assert.equal(gate.locked(),false);
        assert.equal(third.access.phase,'open','the first release of a capture is still an open');
        assert.deepEqual(p.types(),['capture-ready','ready','editor-usable']);assert.equal(server.asked.length,1);
        assert.equal(count(server.log,'begin'),1);assert.equal(count(server.log,'checkpoint'),0);
        await endShare(p);
    }finally{await gate.close();await settle();p.close();}
});
test('an editor-ready answered after its window closed is kept: the next window is released on it, and Universe is not asked again',async t=>{
    let answer;const hold=new Promise(r=>answer=r);
    const server=fakeServer({flag:true,ack:{hold}});t.mock.method(globalThis,'fetch',server.handler);
    const w=embeddedWindow(),p=parentPort(),first={opened:0};
    const gate=first.gate=embeddedGate(w,{prepare:async()=>checkout,open:editorOpener(first,{workbench:true}),transport:withEditorReady});
    try{
        await bound(w,p);
        await p.rpc('begin',{captureSessionId:session,consentVersion:4});
        const seed=seedPart();await p.rpc('upload',{captureSessionId:session,part:seed},[seed.bytes]);
        const unlocking=p.rpc('unlock',{captureSessionId:session});
        await settle(30);
        assert.equal(server.asked.length,1);
        first.frame.isConnected=false;gate.detach();
        answer();await settle(30);
        assert.equal(gate.locked(),true);assert.deepEqual(p.types(),['capture-ready','ready'],'a closed window releases nothing');
        const second={opened:0};
        second.gate=dockLaunch({open:editorOpener(second,{workbench:true})});
        const unlocked=await unlocking;
        assert.equal(unlocked.ok,true,JSON.stringify(unlocked));assert.equal(second.opened,1);assert.equal(gate.locked(),false);
        assert.equal(server.asked.length,1,'one signed editor-ready for the capture');
        assert.deepEqual(p.got.filter(d=>d.type==='editor-usable'),
            [{protocol,attemptId:id,type:'editor-usable',captureSessionId:session,deadlineAt:server.work.deadlineAt,serverNow:server.work.serverNow}]);
        await endShare(p);
    }finally{await gate.close();await settle();p.close();}
});
test('stage diagnostics carry only the attempt tag and a coarse refusal class, and do nothing without Web Crypto',async()=>{
    const lines=[],note=stageDiagnostics(id,{log:{info:line=>lines.push(line)}});
    note('discover.accepted');note('prepare.refused',Object.assign(new Error('x'),{code:'assigned_checkout_unverified'}));note('editor_ready.refused',new Error('Something private'));
    await settle();
    assert.deepEqual(lines,['assignment.workspace.discover.accepted stage='+stageTag,'assignment.workspace.prepare.refused stage='+stageTag+' refusal=checkout',
        'assignment.workspace.editor_ready.refused stage='+stageTag+' refusal=other']);
    assert.match(stageTag,/^[0-9a-f]{16}$/);assert.ok(!lines.join().includes(id));
    for(const subtle of [null,{},{digest(){throw Error('blocked');}},{digest:async()=>{throw Error('blocked');}}]){
        const quiet=[],silent=stageDiagnostics(id,{subtle,log:{info:line=>quiet.push(line)}});
        silent('bind.accepted');silent('prepare.refused',new Error('x'));await settle();
        assert.deepEqual(quiet,[]);
    }
    stageDiagnostics(id,{log:{info(){throw Error('no console');}}})('bind.accepted');await settle();
    for(const [code,klass] of [['identity_refresh_required','identity'],['IDENTITY_REFRESH_REQUIRED','identity'],['assignment_identity_mismatch','identity'],
        ['assigned_checkout_unverified','checkout'],['sandbox_starting','checkout'],['recording_phase_changed','phase'],['seed_not_confirmed','phase'],
        ['media_unavailable','media'],['upload_failed','media'],['workspace_timeout','timeout'],['invalid_request','protocol'],['editor_ready_unsupported','protocol'],
        ['anything else','other'],[undefined,'other']])
        assert.equal(refusalClass(code===undefined?undefined:Object.assign(new Error(code),{code})),klass,String(code));
    assert.equal(refusalClass(Object.assign(new Error('The operation timed out'),{name:'TimeoutError'})),'timeout');
});
test('only the assignment framed by Universe is the window that keeps its controls',()=>{
    const frame=(url,{ancestors,top={}}={})=>({location:Object.assign(new URL(url),ancestors?{ancestorOrigins:ancestors}:{}),top,parent:top});
    assert.equal(embeddedAssignmentWindow({repoUrl:repo},frame(entry,{ancestors:[universe]})),true);
    assert.equal(embeddedAssignmentWindow({repoUrl:repo},frame(entry)),true,'a browser that names no ancestors');
    const own=frame(entry);own.top=own.parent=own;
    const nested=frame(entry);nested.parent={};
    const ordinary='https://github.ezil.work/default/ordinary.git';
    for(const [project,win,why] of [
        [{repoUrl:repo},own,'the standalone OS tab'],
        [{repoUrl:repo},frame(entry,{ancestors:['https://evil.example']}),'another framing origin'],
        [{repoUrl:repo},frame(entry,{ancestors:[universe,universe]}),'a nested frame'],
        [{repoUrl:repo},nested,'not the direct child of the top page'],
        [{repoUrl:repo},frame(entry.replace('os-staging','os'),{ancestors:[universe]}),'production'],
        [{repoUrl:ordinary},frame('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(ordinary),{ancestors:[universe]}),'an ordinary repository'],
        [{repoUrl:repo},frame(entry.replace('assignment='+id,'assignment='+session),{ancestors:[universe]}),'another attempt in the link'],
        [null,frame(entry,{ancestors:[universe]}),'no project'],
        [{repoUrl:repo},null,'no window'],
    ])assert.equal(embeddedAssignmentWindow(project,win),false,why);
    // The dock is kept by the same frame, known from the frame and its address alone (the shell's globals precede any project).
    assert.equal(assignmentWorkDesktop(frame(entry,{ancestors:[universe]})),true);
    for(const [win,why] of [
        [own,'the standalone OS tab'],[frame(entry,{ancestors:['https://evil.example']}),'another framing origin'],[nested,'not the direct child of the top page'],
        [frame(entry.replace('os-staging','os'),{ancestors:[universe]}),'production'],
        [frame('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(ordinary),{ancestors:[universe]}),'an ordinary repository'],
        [frame('https://os-staging.ezil.work/app/code?repo='+encodeURIComponent(repo),{ancestors:[universe]}),'no attempt in the link'],
        [frame(entry.replace('assignment='+id,'assignment='+session),{ancestors:[universe]}),'another attempt in the link'],
        [frame(entry+'&assignment='+id,{ancestors:[universe]}),'two attempts'],
        [frame(entry.replace('/app/code','/app/files'),{ancestors:[universe]}),'another app'],
        [frame('https://os-staging.ezil.work/',{ancestors:[universe]}),'the desktop root'],[null,'no window'],
    ])assert.equal(assignmentWorkDesktop(win),false,why);
});

// ── A phase ended while its signed begin is still in flight ──────────────────────────────────────────────────────────
// The OS route holds the first capture's `begin` open until the test lets it answer, as a slow broker does. `answer`
// replaces that answer. `checkpoints` names the capture and reason of every checkpoint the route received.
function heldBegin(server,{answer,capture=session}={}){
    let release,seen;const sent=new Promise(r=>seen=r),held=new Promise(r=>release=r),checkpoints=[];
    async function handler(path,options){
        const body=String(path).startsWith(bucket)?null:JSON.parse(options.body);
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
        assert.equal(w.screen(),'Sharing paused');assert.equal(gate.access(),null);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        p.post('cancel',{captureSessionId:session});p.post('lock',{captureSessionId:session,reason:'sharing_stopped'});
        assert.equal((await endShare(p)).code,'recording_phase_changed');await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']],'once, whatever the parent repeats');
        assert.deepEqual(server.log,['preflight','preflight',['begin',4,session,proof],'checkpoint']);
        assert.deepEqual(p.types(),['capture-ready','ready'],'the late grant says nothing on the port');
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
            assert.deepEqual(w.types(),['preparing'],name);assert.equal(w.screen(),'loader',name);
            assert.deepEqual(p.types(),['capture-ready','ready'],name);
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
            assert.deepEqual(p.types(),['capture-ready','ready'],name);assert.deepEqual(w.types(),['preparing'],name);
            assert.equal(w.screen(),'Sharing paused',name);
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
        assert.deepEqual(w.types(),['preparing']);assert.equal(w.screen(),'Sharing paused');
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
        assert.deepEqual(p.types(),['capture-ready','ready','pause']);assert.deepEqual(hold.checkpoints,[]);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.deepEqual(p.types(),['capture-ready','ready','pause'],'said once, when the phase ended');
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
        assert.equal(p.types().at(2),'pause');
        p.post('cancel',{captureSessionId:session});
        assert.equal((await begun).code,'recording_phase_changed');
        await gate.close();await settle();
        assert.deepEqual(p.types(),['capture-ready','ready','pause','reopen']);assert.deepEqual(hold.checkpoints,[]);
        hold.release();await settle(20);
        assert.deepEqual(hold.checkpoints,[[session,'connection_lost']]);
        assert.deepEqual(p.types(),['capture-ready','ready','pause','reopen']);
    }finally{await gate.close();await settle();p.close();}
});
test('a share stopped during the transport\'s own preflight sends no begin, so there is nothing to checkpoint',async t=>{
    const server=fakeServer();let release,seen,preflights=0;const sent=new Promise(r=>seen=r),held=new Promise(r=>release=r),checkpoints=[];
    t.mock.method(globalThis,'fetch',async(path,options)=>{
        const body=String(path).startsWith(bucket)?null:JSON.parse(options.body);
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
