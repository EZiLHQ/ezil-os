import assert from 'node:assert/strict';
import test from 'node:test';
import {confirmAssignmentFolder,openWithAssignmentConsent} from './shell.js';
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
    return {win,top,posted,assigned,opened,discover,bind,types,shown,listeners};
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
function fakeServer({stopReason=null,readyBeforeSeed=false}={}){
    const log=[],started=Date.now();let seeded=false,stopAt=null;
    const startedAt=new Date(started-1000).toISOString(),deadlineAt=new Date(started+1800000).toISOString(),firstFrameAt=new Date(started).toISOString();
    async function handler(path,options){
        if(String(path).startsWith(bucket)){log.push('put');return new Response(null,{status:200});}
        const body=JSON.parse(options.body);log.push(body.action==='begin'?['begin',body.consentVersion,body.captureSessionId,body.repoOpenProof]:body.action);
        const same={recordingId,captureSessionId:body.captureSessionId};
        if(body.action==='preflight')return Response.json(eligibleBody({}));
        if(body.action==='begin')return Response.json({...same,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
            authorizationExpiresAt:new Date(Date.now()+600000).toISOString()});
        if(body.action==='prepare')return Response.json({expiresAt:new Date(Date.now()+60000).toISOString(),headers:{'content-type':'video/webm'},
            putUrl:`${bucket}/universe-staging/assignment-media/v1/o/${id}/${recordingId}/segments/${body.sequence}/${body.sha256}.webm`});
        if(body.action==='confirm'){
            const seed=!seeded;seeded=true;
            return Response.json(seed?{...same,sequence:body.sequence,confirmed:true,phaseReady:true,nextSequence:body.sequence+1,firstFrameAt,startedAt,deadlineAt,
                serverNow:new Date().toISOString()}:{recordingId,sequence:body.sequence,confirmed:true});
        }
        if(body.action==='status')return Response.json({...same,status:'recording',phaseReady:seeded||readyBeforeSeed,workspaceUnlocked:seeded||readyBeforeSeed,startedAt,deadlineAt,firstFrameAt,
            stopRequestedAt:stopAt,stopReason:stopAt?stopReason:null,revoked:false});
        return Response.json({...same,status:'paused',startedAt,deadlineAt,stopRequestedAt:null,revoked:false});
    }
    return {log,handler,startedAt,deadlineAt,stop(at){stopAt=at;}};
}
function embeddedGate(w,{who='owner',prepare=()=>assert.fail('checkout must stay closed'),open=()=>assert.fail('editor must stay closed'),...rest}={}){
    return openWithAssignmentConsent({project:{repoUrl:repo},actor:()=>who,computerId:'fixture',body:new Element(),park(){},prepare,open,...rest});
}
const seedPart=(fields={})=>({sequence:0,startMs:0,endMs:1,mimeType:'video/webm',bytes:new Uint8Array([26,69,223,163,1]).buffer,...fields});
// Discover, bind and wait for port `ready`, as the parent does before it offers Share.
async function bound(w,p){w.discover();w.bind([p.port]);await settle();assert.deepEqual(p.types(),['ready']);}
function editorOpener(state,{root=checkoutFolder,folder=workspaceFolder}={}){
    const frame={isConnected:true,contentWindow:{postMessage(){}}};
    return ()=>{state.opened++;state.access=state.gate.access();
        queueMicrotask(()=>confirmAssignmentFolder({repoUrl:repo},null,frame,'https://code.example/?folder='+encodeURIComponent(folder)+'&ezil_mint=m',root));};
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
        assert.deepEqual(ready.value,{confirmed:true,phaseReady:true,captureSessionId:session,nextSequence:1,startedAt:server.startedAt,deadlineAt:server.deadlineAt});
        assert.deepEqual((await p.rpc('status',{captureSessionId:session})).value,{captureSessionId:session,status:'recording',stopRequestedAt:null});
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
    assert.deepEqual(p.types(),['ready','reopen']);
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
        assert.deepEqual(good.types(),['ready']);
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
        assert.deepEqual(p.types(),[],'no port ready before eligibility');
        assert.deepEqual((await p.rpc('begin',{captureSessionId:session,consentVersion:4})).code,'assignment_not_ready');
        release();await settle();
        assert.deepEqual(p.types(),['ready']);
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
        assert.deepEqual(p.types(),['ready'],'a pulse inside 14 s keeps the phase');
        t.mock.timers.tick(5600);await settle(20);
        assert.deepEqual(p.types(),['ready','pause']);
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
    assert.deepEqual(p.types(),['ready','pause','reopen']);
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
            assert.deepEqual(w.types(),['preparing','authentication_required']);assert.deepEqual(p.types(),[]);
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
            assert.deepEqual(w.types(),['preparing','unavailable']);assert.ok(w.shown(title));assert.deepEqual(p.types(),[]);
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
