// The shipped shell bundle framed by its PRODUCTION Universe work page (universe.ezil.work framing os.ezil.work), in
// isolated Chromium: the assignment's Code window is really closed (its native X, the window leaves the document) and
// opened again from the dock, inside ONE capture.
// Real: the OS shell bundle, its Code window, its dock, the exact-origin `ezil.assignment.work/v2` window and port
// exchange, the folder bridge. Fixtures: the Universe parent (protocol only, no capture), the checkout, the editor
// document, the assignment-video route (with production's `clock` report and its `editor-ready` answer), the computer's
// own provider answer and the media bucket. Every request is intercepted, except in the pagehide run: there the Universe
// page and the OS document come from a real HTTPS receiver on loopback (`loopback-receiver-test-support.mjs`), and the
// checkpoint the OS document sends as it unloads must be received on that socket.
//
// What it proves, per run:
//   - native X says nothing on the port or the window (no pause, no reopen, no state), asks the server nothing, and
//     neither the Universe page nor the OS frame is loaded again; the capture keeps taking pulses and clips meanwhile;
//   - the dock's projectless launch opens the SAME assigned checkout: one `reopen` mint naming the original receipt
//     and capture, parked under the window's own loader until that editor reports the verified folder (and its mounted
//     workbench under the signed preparation);
//   - one prepare, one begin, one first frame, one editor-ready, one editor-usable across the close and the reopen, and
//     the assignment's own clock (`clock`, `unlock`'s `clock`, `editor-usable`) exactly as it was first answered;
//   - a server pause with no Code window open still ends the phase at the pause's own time (`pause {reason:'paused'}`);
//   - the explicit Stop still ends the phase at once, and so does the outer page going away with no Code window open:
//     its one exact checkpoint actually leaves the browser, after a same-path canary has already reached the socket;
//   - a new share begun while no Code window is open brings that window back by itself (the document's own launch) and
//     is an ordinary new capture: its own prepare, begin, first frame and open.
//
// Run:  node shell/ezil/assignment-video/work-reopen-browser-test.mjs   (after shell/build-shell.sh)
//       Exit 2 = skipped (no playwright or bundle).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startLoopbackReceiver} from './loopback-receiver-test-support.mjs';
let chromium;
try{({chromium}=createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR||process.env.EZIL_PLAYWRIGHT_DIR||'/opt/ezil-testkit','p.cjs'))('playwright'));}
catch{console.error('SKIP: playwright is not resolvable');process.exit(2);}
const assets=process.env.EZIL_SHELL_OUT_DIR||new URL('../../../app/public/os/',import.meta.url).pathname;
for(const file of ['icons.js','bundle.min.js','bundle.min.css'])
    if(!fs.existsSync(path.join(assets,file))){console.error('SKIP: missing '+file+', run shell/build-shell.sh');process.exit(2);}

const universe='https://universe.ezil.work', origin='https://os.ezil.work', editor='https://isolated-editor.invalid';
const storage='https://ezil-universe-production-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const protocol='ezil.assignment.work/v2';
const attemptId='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a', recordingId='01111111-2222-4333-8444-555555555555';
const repoId='12222222-3333-4444-8555-666666666666', session='7c1a2f0e-58d4-4d0b-9b54-6f1e6f3f9a10';
const repo='https://github.ezil.work/default/u-0482ba160482ba16-a-'+attemptId+'.git';
const workspaceFolder='/workspace/projects/'+repoId, checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
const proof='q'.repeat(70);
const entry=origin+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+attemptId;
const boot={user:{id:'33333333-3333-4333-8333-333333333333',email:'qa@example.test'},
    computer:{id:'11111111-1111-4111-8111-111111111111',name:'QA computer',slot:1,isNew:false},
    apps:[{id:'desktop',name:'Browser',icon:'desktop',kind:'desktop'}],
    desktopState:{provider:'cloudflare-guacamole',configured:true,hasHmacSecret:true,status:'idle',endpoints:{system:'/api/shell/system'},
        ui:{floatingControls:false,feedbackScreenshots:false}}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

const shellPage='<!doctype html><html><head><title>EZiL OS</title><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div>'
    +'<script>window.__EZIL_BOOT__='+JSON.stringify(boot)+'</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script>'
    +'<script>window.__loaded=crypto.randomUUID();window.ezil.boot();</script></body></html>';
// The editor document names its own folder and mint, and reports its mounted workbench only when asked, 250 ms later.
const editorPage='<html><body style="margin:0;background:#4e223b;color:white;font:24px monospace"><h1>Assigned editor</h1><p id="folder"></p><script>'
    +'document.querySelector("#folder").textContent=new URL(location.href).searchParams.get("folder");addEventListener("message",e=>{'
    +'if(e.origin!=="'+origin+'"||e.data.type!=="ezil.code.hello")return;const u=new URL(location.href);'
    +'const identity={v:1,nonce:e.data.nonce,mint:u.searchParams.get("ezil_mint"),kind:"folder",path:u.searchParams.get("folder")};'
    +'parent.postMessage({type:"ezil.code.folder",...identity},e.origin);'
    +'if(e.data.workbenchReady===true)setTimeout(()=>parent.postMessage({type:"ezil.code.workbench",...identity},e.origin),250);});</script></body></html>';
// The Universe parent's half of the protocol, as `assignment-work-capture.js` speaks it. No capture: fixture bytes.
const parentDriver='('+((protocol,attemptId,osOrigin,session)=>{
    const frame=document.querySelector('#os'),drive=window.drive={states:[],port:[],binds:0,loads:0,loaded:crypto.randomUUID()};
    let challenge=null,port=null,next=0,sequence=0;const waiting=new Map();
    const discover=()=>{if(challenge)frame.contentWindow?.postMessage({protocol,attemptId,type:'discover',challenge},osOrigin);};
    frame.addEventListener('load',()=>{drive.loads++;challenge=crypto.randomUUID();discover();});
    setInterval(discover,300);
    addEventListener('message',event=>{
        const d=event.data;
        if(event.origin!==osOrigin||event.source!==frame.contentWindow||d?.protocol!==protocol||d.attemptId!==attemptId||d.challenge!==challenge)return;
        if(drive.states.at(-1)!==d.type)drive.states.push(d.type);
        if(d.type!=='preparing'||port)return;
        const channel=new MessageChannel();port=channel.port1;
        port.onmessage=e=>{const m=e.data;
            if(m?.type==='reply'){waiting.get(m.id)?.(m);waiting.delete(m.id);return;}
            drive.port.push(m);};
        event.source.postMessage({protocol,attemptId,type:'bind',challenge},osOrigin,[channel.port2]);drive.binds++;
    });
    const rpc=(method,fields={})=>new Promise(resolve=>{const id=++next;waiting.set(id,resolve);port.postMessage({protocol,attemptId,type:'request',id,method,...fields});});
    drive.again=()=>{sequence=0;};
    const part=(startMs,endMs)=>({sequence:sequence++,startMs,endMs,mimeType:'video/webm',bytes:new Uint8Array([26,69,223,163,1,sequence]).buffer});
    drive.begin=()=>rpc('begin',{captureSessionId:session,consentVersion:4});
    drive.seed=()=>rpc('upload',{captureSessionId:session,part:part(0,1)});
    drive.clip=()=>rpc('upload',{captureSessionId:session,part:part(1000*sequence,1000*sequence+900)});
    drive.unlock=()=>rpc('unlock',{captureSessionId:session});
    drive.status=()=>rpc('status',{captureSessionId:session});
    // Universe's own Stop: the lock at once, then the end of the phase.
    drive.end=reason=>rpc('end',{captureSessionId:session,reason,expectedSegments:sequence});
    drive.stop=()=>{port.postMessage({protocol,attemptId,type:'lock',captureSessionId:session,reason:'sharing_stopped'});
        return rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:sequence});};
    setInterval(()=>{if(port)port.postMessage({protocol,attemptId,type:'pulse',captureSessionId:session});},2000);
}).toString()+')('+[protocol,attemptId,origin,session].map(v=>JSON.stringify(v)).join(',')+')';
const parentPage='<!doctype html><html><head><title>Universe assignment</title></head><body style="margin:0;background:#f4f1ea">'
    +'<p id="status" style="font:14px sans-serif;margin:8px">Universe work page</p>'
    +'<iframe id="os" src="'+entry.replace(/&/g,'&amp;')+'" style="width:100%;height:700px;border:0;display:block"></iframe><script>'+parentDriver+'</script></body></html>';

// Only these two exact hosts resolve, to this run's loopback receiver; every other host stays unresolvable. Chromium
// accepts the receiver's certificate through its SPKI pin alone. Both documents of the pagehide run are loaded from it,
// so the OS document and its parent are loopback documents and their requests to it stay within one address space.
const canary='delivery-canary';
const receiver=await startLoopbackReceiver({hosts:[new URL(origin).host,new URL(universe).host],respond:({method,host,path:at,json})=>{
    const u=new URL(at,'https://'+host);
    if(method==='GET'&&u.origin===universe&&u.pathname==='/assignment/work')return {status:200,type:'text/html',body:parentPage};
    if(method==='GET'&&u.origin===origin&&u.pathname.startsWith('/app/'))return {status:200,type:'text/html',body:shellPage};
    // Nothing reads this answer to the checkpoint: the document that sent it is gone.
    if(method==='POST'&&u.origin===origin&&u.pathname==='/api/shell/assignment-video'&&[canary,'checkpoint'].includes(json?.action))
        return {status:200,type:'application/json',body:JSON.stringify({received:json.action})};
    return null;
}});
const browser=await (async()=>{try{
    await receiver.check(new URL(origin).host);
    return await chromium.launch({headless:process.env.EZIL_CHROME_HEADED!=='1',executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',
        args:['--disable-dev-shm-usage','--host-resolver-rules='+[...receiver.hostRules,'MAP * ~NOTFOUND'].join(','),'--ignore-certificate-errors-spki-list='+receiver.spki]});
}catch(error){await receiver.close();throw error;}})();

/**
 * `signed`: Universe signs `editorReadySupported` (a managed preparation; the editor then waits for its mounted
 * workbench). Production asks `editor-ready` once per capture either way. `ending`: how the phase ends after the reopen.
 */
async function run({signed,ending}){
    const events=[],mints=[],errors=[],consoleLines=[];let seeded=false,released=false,editorClock,pausedAt=null,revision=0,os,page,minted=0,release=()=>{};
    let reopenHeld=new Promise(r=>release=r);
    let armed=null,armedReadBack=null;
    // The pagehide run loads both documents from the loopback receiver. Once its outer page is leaving, a checkpoint the
    // route still sees is passed on to that socket too: the route's count is reported, the socket's is asserted.
    const real=ending==='pagehide',socketFrom=receiver.received.length,faultFrom=receiver.faults.length,routed=[];
    let leaving=false,delivery=null;
    const pass=(route,action)=>route.continue().then(()=>routed.push(action),error=>routed.push(action+' not continued: '+String(error?.message).slice(0,120)));
    const context=await browser.newContext({viewport:{width:1200,height:780}});
    // What the browser itself reports for the assignment-video route, beside what the route fixture answered: a keepalive
    // request sent while the OS frame unloads may leave without reaching the fixture. Diagnostics only; nothing asserts it.
    const reported=[];
    // A request whose body the browser does not report is kept too (action null).
    const note=(kind,request)=>{try{
        const u=new URL(request.url());
        if(u.origin!==origin||u.pathname!=='/api/shell/assignment-video')return;
        let action=null;try{action=request.postDataJSON()?.action??null;}catch{/* body not reported */}
        if(action===null||['checkpoint','finalize',canary].includes(action))
            reported.push({kind,action,method:request.method(),failure:request.failure()?.errorText??null});
    }catch{/* not this route */}};
    for(const kind of ['request','requestfailed','requestfinished'])context.on(kind,request=>note(kind,request));
    // The OS document's own record, in its origin's storage so it outlives the document: whether its pagehide fired and
    // whether it asked fetch for a checkpoint (and with keepalive). Passes every call through unchanged; read on failure only.
    await context.addInitScript(os=>{
        if(location.origin!==os)return;
        const record=entry=>{try{const all=JSON.parse(localStorage.getItem('ezil-probe')||'[]');
            all.push({...entry,at:Date.now()});localStorage.setItem('ezil-probe',JSON.stringify(all));}catch{/* storage unavailable */}};
        addEventListener('pagehide',event=>record({type:'pagehide',persisted:event.persisted,path:location.pathname}),true);
        const original=window.fetch;
        window.fetch=function(input,init){
            try{if(typeof init?.body==='string'&&init.body.includes('"action":"checkpoint"'))record({type:'fetch-checkpoint',keepalive:init.keepalive===true});}
            catch{/* never affects the call */}
            return original.call(window,input,init);
        };
    },origin);
    await context.addInitScript(()=>{
        window.assignmentCueLeases=0;
        window.assignmentNativeEvents={click:0,contextmenu:0};
        addEventListener('message',event=>{if(event.data?.type==='ezil.assignment.click-cues')window.assignmentCueLeases++;});
        for(const type of ['click','contextmenu'])addEventListener(type,event=>{
            if(event.isTrusted)window.assignmentNativeEvents[type]++;
        },true);
    });
    // The OS document's record, read under the same structure as the run (a Universe page framing an OS document); the read
    // counts only if it also sees this run's sentinel.
    const readProbe=async()=>{const reader=await context.newPage();
        try{await reader.goto(universe+'/probe-host');
            const frame=reader.frames().find(f=>{try{return new URL(f.url()).origin===origin;}catch{return false;}});
            const entries=frame?JSON.parse(await frame.evaluate(()=>localStorage.getItem('ezil-probe'))||'null'):'no OS frame';
            return {entries,readerSeesArmed:armed!==null&&Array.isArray(entries)&&entries.some(e=>e.type==='armed'&&e.sentinel===armed)};}
        finally{await reader.close();}};
    const fixed={startedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+1800000).toISOString(),
        acceptedMediaCutoff:new Date(Date.now()+3800000).toISOString()};
    try{
        await context.route('**/*',async route=>{
            const req=route.request(),u=new URL(req.url()),post=()=>req.postDataJSON()||{};
            const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
            const html=body=>route.fulfill({contentType:'text/html',body});
            if(u.origin===universe&&u.pathname==='/probe-host')return html('<!doctype html><title>probe host</title><iframe src="'+origin+'/probe"></iframe>');
            if(real&&u.origin===universe&&u.pathname==='/assignment/work')return pass(route,'universe document');
            if(u.origin===universe)return u.pathname==='/left'?html('<!doctype html><title>Elsewhere</title><p>Left the assignment</p>'):html(parentPage);
            if(u.origin===editor)return html(editorPage);
            if(u.origin===storage&&req.method()==='PUT')return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':origin},body:''});
            if(u.origin===storage)return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'PUT','Access-Control-Allow-Headers':'*'},body:''});
            if(u.origin!==origin)return route.abort();
            // A blank OS-origin page, opened only to read the diagnostics record after a failure.
            if(u.pathname==='/probe')return html('<!doctype html><title>probe</title>');
            if(u.pathname.startsWith('/app/'))return real?pass(route,'os document'):html(shellPage);
            if(u.pathname.startsWith('/os/')){
                const file=path.join(assets,path.basename(u.pathname));
                return fs.existsSync(file)?route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)}):route.abort();
            }
            if(u.pathname==='/api/shell/code-preview-url'){
                const d=post(),phase=d.assignment?.phase;events.push('mint:'+(phase??'none'));mints.push(d);
                // Anything but this assignment's own repository and attempt is the person's own files: never expected here.
                if(d.repository?.url!==repo||d.assignment?.attemptId!==attemptId)return json({ok:false});
                const repository={id:repoId,name:'default/qa',workspaceFolder,checkoutFolder};
                if(phase==='prepare')return json({ok:true,repository,assignmentOpen:{attemptId,proof}});
                // The server's rule, as the fixture: the original receipt and capture, a confirmed first frame, and
                // `reopen` only once this capture's editor was released.
                if(!['open','reopen'].includes(phase)||d.assignment.repoOpenProof!==proof||d.assignment.captureSessionId!==session||!seeded
                    ||(phase==='reopen')!==released)return json({ok:false});
                if(phase==='reopen')await reopenHeld;
                released=true;
                return json({ok:true,repository,codePreviewUrl:editor+'/?folder='+encodeURIComponent(workspaceFolder)+'&ezil_mint='+String(++minted).repeat(22),assignmentOpen:{attemptId,proof}});
            }
            if(u.pathname==='/api/shell/assignment-video'){
                const d=post();
                // The receiver's own canary is never the fixture's to answer.
                if(real&&d.action===canary)return pass(route,canary);
                events.push(d.action);
                if(real&&leaving&&d.action==='checkpoint')return pass(route,'checkpoint');
                const now=Date.now(),same={recordingId,captureSessionId:d.captureSessionId??session};
                if(d.action==='preflight')return json({status:'eligible',attemptId,repositoryUrl:repo,expiresAt:fixed.deadlineAt,windowStartedAt:null,deadlineAt:null,...(signed?{editorReadySupported:true}:{})});
                // A new capture: its own first frame and its own first open.
                if(d.action==='begin'){seeded=false;released=false;}
                if(d.action==='begin'&&pausedAt)return json({error:{code:'assignment_paused'}},409);
                if(d.action==='begin')return json({...same,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
                    authorizationExpiresAt:new Date(now+600000).toISOString()});
                if(d.action==='prepare')return json({expiresAt:fixed.deadlineAt,headers:{'content-type':'video/webm'},
                    putUrl:storage+'/universe-production/assignment-media/v1/o/'+attemptId+'/'+recordingId+'/segments/'+d.sequence+'/'+d.sha256+'.webm'});
                if(d.action==='confirm'){
                    const seed=!seeded;seeded=true;
                    return json(seed?{...same,sequence:d.sequence,confirmed:true,phaseReady:true,nextSequence:d.sequence+1,
                        firstFrameAt:fixed.startedAt,startedAt:fixed.startedAt,deadlineAt:fixed.deadlineAt,serverNow:new Date(now).toISOString()}
                        :{recordingId,sequence:d.sequence,confirmed:true});
                }
                // Production's assignment clock: nothing until `editor-ready` starts the work hour, then that same start
                // and deadline on every report. A pause freezes it at the server's own time under a later revision.
                const report=()=>!editorClock?{startedAt:null,deadlineAt:null,pausedAt:null,pauseReason:null,remainingMs:null,revision:0}
                    :pausedAt?{startedAt:editorClock.startedAt,deadlineAt:null,pausedAt,pauseReason:'system',remainingMs:Date.parse(editorClock.deadlineAt)-Date.parse(pausedAt),revision}
                    :{startedAt:editorClock.startedAt,deadlineAt:editorClock.deadlineAt,pausedAt:null,pauseReason:null,remainingMs:Date.parse(editorClock.deadlineAt)-now,revision};
                if(d.action==='clock')return json({...report(),serverNow:new Date(now).toISOString()});
                if(d.action==='editor-ready'){
                    // Signed with this phase's own receipt and capture, and asked once per capture.
                    if(d.repoOpenProof!==proof||d.captureSessionId!==session||!seeded)return json({error:{code:'assignment_open_required'}},409);
                    // The work hour starts once. A later capture's `editor-ready` is answered with that same clock: the gate
                    // refuses any answer that names another start (`assignment_clock_changed`).
                    editorClock??={startedAt:new Date(now).toISOString(),deadlineAt:new Date(now+3600000).toISOString()};revision=Math.max(revision,1);
                    return json({...report(),serverNow:new Date(now).toISOString()});
                }
                if(d.action==='status')return json({...same,status:'recording',phaseReady:seeded,workspaceUnlocked:seeded,startedAt:fixed.startedAt,
                    deadlineAt:editorClock?fixed.acceptedMediaCutoff:fixed.deadlineAt,serverNow:new Date(now).toISOString(),
                    firstFrameAt:fixed.startedAt,stopRequestedAt:null,stopReason:null,revoked:false});
                return json({...same,status:'paused',startedAt:fixed.startedAt,deadlineAt:fixed.deadlineAt,stopRequestedAt:null,revoked:false});
            }
            if(u.searchParams.get('confirm')==='frame')return json({ok:true,confirmed:true,status:200});
            if(u.searchParams.get('confirm')==='display')return json({ok:true,display:'live'});
            if(u.pathname==='/api/shell/desktop'&&req.method()==='POST'){events.push('desktop:'+post().intent);
                return json({ok:true,guacamoleUrl:'https://isolated-preview.invalid/?desktop=1',frame:{confirmed:true}});}
            if(u.pathname==='/api/shell/desktop')return json({ok:true,guacamoleRunning:true});
            // This person's own Cloudflare computer: production checks the provider before the port may say `ready`.
            if(u.pathname==='/api/shell/system'){events.push('system');return json({ok:true,info:{provider:'cloudflare'}});}
            if(u.pathname.startsWith('/api/'))return json({ok:true,reports:[]});
            return route.fulfill({status:404,body:''});
        });
        page=await context.newPage();page.setDefaultTimeout(25000);
        page.on('pageerror',e=>errors.push(e.message.slice(0,160)));
        page.on('console',m=>{if(m.text().startsWith('assignment.workspace.'))consoleLines.push(m.text());});
        await page.goto(universe+'/assignment/work');
        const atOs=f=>{try{return new URL(f.url()).origin===origin;}catch{return false;}};
        os=page.frames().find(atOs)??await page.waitForEvent('framenavigated',atOs);
        const codeWindow=os.locator('.window[data-app="code"]');
        const editorFrame=os.frameLocator('.window[data-app="code"] .window-app-iframe');
        const drive=(fn,arg)=>page.evaluate(fn,arg);
        const wire=()=>drive(()=>({port:window.drive.port.map(m=>m.type),states:window.drive.states.slice(),binds:window.drive.binds,loads:window.drive.loads,loaded:window.drive.loaded}));
        const count=action=>events.filter(e=>e===action).length;
        const state=()=>codeWindow.locator('.window-body').getAttribute('data-ezil-assignment-work');
        const shownEditor=()=>codeWindow.locator('.window-app-iframe').evaluate(el=>({src:el.src,parked:el.inert||getComputedStyle(el).visibility==='hidden'}));

        // ── One ordinary share: bind, begin, first frame, unlock, the assigned editor ──
        await codeWindow.waitFor();
        await page.waitForFunction(()=>window.drive.port.some(m=>m.type==='ready'));
        assert.equal((await drive(()=>window.drive.begin())).ok,true);
        assert.equal((await drive(()=>window.drive.seed())).value?.phaseReady,true);
        const unlocked=await drive(()=>window.drive.unlock());assert.equal(unlocked.ok,true,JSON.stringify(unlocked));
        await editorFrame.getByText('Assigned editor').waitFor();
        await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-body').dataset.ezilAssignmentWork==='open');
        const first=await shownEditor(),loadedOs=await os.evaluate(()=>window.__loaded),before=await wire();
        assert.equal(new URL(first.src).searchParams.get('folder'),workspaceFolder);assert.equal(first.parked,false);
        assert.deepEqual(before.port,['capture-ready','ready','editor-usable']);assert.deepEqual(before.states,['preparing','ready']);
        const clockBefore=(await drive(()=>window.drive.status())).value;
        const usable=await drive(()=>window.drive.port.find(m=>m.type==='editor-usable'));
        const quiet={checkpoint:count('checkpoint'),finalize:count('finalize'),begin:count('begin'),preflight:count('preflight'),editorReady:count('editor-ready')};
        assert.deepEqual(quiet,{checkpoint:0,finalize:0,begin:1,preflight:2,editorReady:1});
        // The assignment's own clock, as `editor-ready` first answered it: in `unlock`'s `clock` and in `editor-usable`.
        const work={...editorClock};
        assert.equal(unlocked.value.clock?.startedAt,work.startedAt);assert.equal(unlocked.value.clock?.deadlineAt,work.deadlineAt);
        assert.equal(usable.deadlineAt,work.deadlineAt);

        // ── Native X: the window really leaves the document ──
        await codeWindow.locator('> .window-head .window-close-btn').click();
        await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
        // `status` and `clock` are the document's own polls, running with or without a Code window.
        const asked=()=>events.filter(e=>e!=='status'&&e!=='clock').length;
        const requestsAtClose=asked(),clocksAtClose=count('clock');
        // Long enough for a pulse, a status poll and anything a close would have said.
        await wait(2600);
        assert.equal(await os.locator('.window[data-app="code"]').count(),0,'closed, not minimised');
        assert.deepEqual(await wire(),before,'native X: no pause, no reopen, no window state, no second bind, no frame load');
        assert.equal(await os.evaluate(()=>window.__loaded),loadedOs,'the OS document is the same one');
        assert.deepEqual(asked(),requestsAtClose,'closing asks the server nothing');
        // The live clock poll (every 3 s) goes on with no Code window open.
        for(let i=0;i<80&&count('clock')===clocksAtClose;i++)await wait(50);
        assert.ok(count('clock')>clocksAtClose,'the assignment clock is still read with no Code window open');
        // The capture is the tab's: its next clip is taken, and its clock is unchanged, with no Code window open.
        const clip=await drive(()=>window.drive.clip());assert.deepEqual(clip.value,{confirmed:true,sequence:1},JSON.stringify(clip));
        assert.deepEqual((await drive(()=>window.drive.status())).value.deadlineAt,clockBefore.deadlineAt);

        // ── The dock: the same assigned checkout, behind the same receipt and its own workbench ──
        assert.equal(await os.locator('.taskbar-item[data-app="code"]').count(),1,'the dock keeps Code');
        await os.locator('.taskbar-item[data-app="code"]').click();
        await codeWindow.waitFor();
        await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-body')?.dataset.ezilAssignmentWork==='preparing');
        while(count('mint:reopen')===0)await wait(50);
        await wait(500);
        // The reopen mint is in flight: this window's own loader, an inert editor frame, the gate drawing nothing.
        assert.equal(await state(),'preparing');assert.equal((await shownEditor()).parked,true,'the fresh editor is parked until it is verified');
        assert.equal(await codeWindow.locator('.ezil-assignment-work-gate').evaluate(el=>el.hidden),true);
        assert.equal(await codeWindow.locator('> .window-head').isVisible(),true,'an ordinary window again');
        release();
        if(signed){
            // The editor document is loaded on the verified folder; only its mounted workbench (250 ms later) releases it.
            await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-app-iframe')?.src.includes('ezil_mint='));
            assert.equal(await state(),'preparing','the folder echo alone releases nothing under the signed preparation');
        }
        await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-body').dataset.ezilAssignmentWork==='open');
        await editorFrame.getByText('Assigned editor').waitFor();
        assert.equal(await editorFrame.locator('#folder').textContent(),workspaceFolder,'the assigned checkout, not the person\'s own files');
        // Observe every lease from the reopened editor's first script, through the old 1.5-second renewal.
        // Real pointer events still reach the editor and the OS window head, and neither surface draws marks.
        await editorFrame.getByText('Assigned editor').click();
        await editorFrame.getByText('Assigned editor').click({button:'right'});
        const pointer=await editorFrame.locator('body').evaluate(()=>window.assignmentNativeEvents);
        assert.ok(pointer.click>=1 && pointer.contextmenu>=1);
        await page.keyboard.press('Escape');
        for(const button of ['left','right']){
            await codeWindow.locator('> .window-head').click({button});
            assert.equal(await os.locator('.ezil-assignment-click').count(),0);
        }
        await page.keyboard.press('Escape');
        await wait(1700);
        assert.equal(await editorFrame.locator('body').evaluate(()=>window.assignmentCueLeases),0);
        assert.equal(await editorFrame.locator('[data-ezil-assignment-click]').count(),0);
        const second=await shownEditor();
        assert.equal(second.parked,false);assert.notEqual(second.src,first.src,'a fresh mint');
        assert.equal(new URL(second.src).searchParams.get('folder'),workspaceFolder);
        await wait(700);
        // The wire and the server across close and reopen: nothing twice, nothing ended.
        assert.deepEqual(await wire(),before,'the reopened window says nothing new: one editor-usable, no pause, no reopen');
        assert.deepEqual(await drive(()=>window.drive.port.filter(m=>m.type==='editor-usable')),[usable]);
        assert.deepEqual(events.filter(e=>e.startsWith('mint:')),['mint:prepare','mint:open','mint:reopen'],'one checkout, one open, one reopen');
        assert.deepEqual(mints.at(-1),{computerId:boot.computer.id,intent:'open',repository:{url:repo},
            assignment:{attemptId,phase:'reopen',repoOpenProof:proof,captureSessionId:session}},'the original receipt and capture, never a new one');
        assert.deepEqual({checkpoint:count('checkpoint'),finalize:count('finalize'),begin:count('begin'),preflight:count('preflight'),editorReady:count('editor-ready')},quiet);
        assert.equal(await os.evaluate(()=>window.__loaded),loadedOs);
        assert.deepEqual((await drive(()=>window.drive.status())).value.deadlineAt,clockBefore.deadlineAt,'the same media window');
        assert.deepEqual(editorClock,work,'the work clock was started once and never again');
        assert.deepEqual((await drive(()=>window.drive.clip())).value,{confirmed:true,sequence:2});

        if(ending==='stop'){
            // ── Universe's Stop: the editor locks at once and the phase is saved, with the reopened window on screen ──
            const ended=await drive(()=>window.drive.stop());assert.equal(ended.ok,true,JSON.stringify(ended));
            assert.equal(count('checkpoint'),1);
            assert.equal(await state(),'held');assert.equal((await shownEditor()).parked,true);
            assert.equal(await codeWindow.locator('.ezil-assignment-work-gate h2').textContent(),'Sharing paused');
            assert.deepEqual((await wire()).port,before.port,'the parent\'s own stop needs no pause');
        }else if(ending==='paused'){
            // ── The server pauses the assignment's time while NO Code window is open: the phase ends at that time ──
            await codeWindow.locator('> .window-head .window-close-btn').click();
            await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
            pausedAt=new Date().toISOString();revision=2;
            await page.waitForFunction(()=>window.drive.port.some(m=>m.type==='pause'),null,{timeout:9000});
            assert.deepEqual(await drive(()=>window.drive.port.find(m=>m.type==='pause')),{protocol,attemptId,type:'pause',reason:'paused',effectiveAt:pausedAt});
            assert.equal((await drive(()=>window.drive.end('connection_lost'))).ok,true);assert.equal(count('checkpoint'),1);
            assert.equal((await drive(()=>window.drive.begin())).code,'assignment_paused','no share starts into a pause');
            // The dock's window says why, opens no editor and mints nothing.
            await os.locator('.taskbar-item[data-app="code"]').click();
            await codeWindow.waitFor();
            await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-body')?.dataset.ezilAssignmentWork==='held');
            assert.equal(await codeWindow.locator('.ezil-assignment-work-gate h2').textContent(),'Assignment time paused');
            await wait(600);
            assert.deepEqual(events.filter(e=>e.startsWith('mint:')),['mint:prepare','mint:open','mint:reopen']);
            assert.deepEqual((await wire()).port,[...before.port,'pause'],'no reopen: the same port and document go on');
        }else if(ending==='reshare'){
            // ── Stopped with no Code window open, then shared again: the window comes back by itself for the new capture ──
            await codeWindow.locator('> .window-head .window-close-btn').click();
            await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
            assert.equal((await drive(()=>window.drive.stop())).ok,true);assert.equal(count('checkpoint'),1);
            await wait(400);
            assert.equal(await os.locator('.window[data-app="code"]').count(),0,'a stop opens nothing');
            await drive(()=>window.drive.again());
            const begun=await drive(()=>window.drive.begin());assert.equal(begun.ok,true,JSON.stringify(begun));
            assert.equal(await os.locator('.window[data-app="code"]').count(),1,'the share asked the document for its Code window');
            assert.equal(await state(),'preparing');
            assert.equal((await drive(()=>window.drive.seed())).value?.phaseReady,true);
            const again=await drive(()=>window.drive.unlock());assert.equal(again.ok,true,JSON.stringify(again));
            await os.waitForFunction(()=>document.querySelector('.window[data-app="code"] .window-body').dataset.ezilAssignmentWork==='open');
            assert.equal(await editorFrame.locator('#folder').textContent(),workspaceFolder);
            assert.deepEqual(events.filter(e=>e.startsWith('mint:')),['mint:prepare','mint:open','mint:reopen','mint:prepare','mint:open']);
            assert.deepEqual((await wire()).port,['capture-ready','ready','editor-usable','editor-usable'],'the new capture has its own editor-usable; nothing paused or reopened');
            assert.deepEqual([count('begin'),count('editor-ready')],[2,2]);
        }else{
            // ── The outer page goes away while NO Code window is open: the document's own pagehide still saves the phase ──
            await codeWindow.locator('> .window-head .window-close-btn').click();
            await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
            await wait(400);
            assert.equal(count('checkpoint'),0);assert.deepEqual(await wire(),before);
            // Diagnostics: a unique sentinel written and read back by this embedded OS document itself, so a record that
            // later lacks pagehide is falsifiable (the same storage was writable and is read). Not asserted.
            armed=crypto.randomUUID();
            armedReadBack=await os.evaluate(sentinel=>{try{const all=JSON.parse(localStorage.getItem('ezil-probe')||'[]');
                all.push({type:'armed',sentinel,at:Date.now()});localStorage.setItem('ezil-probe',JSON.stringify(all));
                return JSON.parse(localStorage.getItem('ezil-probe')).some(e=>e.type==='armed'&&e.sentinel===sentinel);}catch{return false;}},armed)
                .catch(e=>'unavailable: '+String(e?.message).slice(0,120));
            // ── The same path through the real socket, before the outer page leaves: a fetch from this OS document, made as its
            //    exit checkpoint is, is received there (host mapping, certificate pin, address space and the route's hand-off) ──
            const nonce=crypto.randomUUID();
            const sent=await os.evaluate(([action,nonce])=>fetch('/api/shell/assignment-video',{method:'POST',credentials:'same-origin',redirect:'error',
                cache:'no-store',keepalive:true,headers:{'Content-Type':'application/json','X-Ezil-Assignment-Video':'1'},body:JSON.stringify({action,nonce})})
                .then(r=>r.status,e=>'failed: '+String(e?.message).slice(0,120)),[canary,nonce]);
            const atSocket=()=>receiver.received.slice(socketFrom);
            const received=action=>atSocket().filter(e=>e.method==='POST'&&e.host===new URL(origin).host&&e.path==='/api/shell/assignment-video'&&e.json?.action===action);
            const shape=e=>({json:e.json,contentType:e.headers['content-type'],marker:e.headers['x-ezil-assignment-video']});
            assert.equal(sent,200,'the same-path canary is answered by the loopback receiver');
            assert.deepEqual(received(canary).map(shape),[{json:{action:canary,nonce},contentType:'application/json',marker:'1'}]);
            const documents=atSocket().filter(e=>e.method==='GET').map(e=>e.host+String(e.path).split('?')[0]);
            assert.deepEqual(['universe.ezil.work/assignment/work','os.ezil.work/app/code'].map(d=>documents.filter(x=>x===d).length),[1,1],
                'both documents came from the socket');
            assert.deepEqual(received('checkpoint'),[],'no checkpoint reached the socket before the outer page left');
            leaving=true;const leftAt=Date.now();
            await page.goto(universe+'/left');
            for(let i=0;i<100&&received('checkpoint').length===0;i++)await wait(50);
            // Long enough for a second checkpoint to arrive.
            await wait(500);
            // Only the socket counts: the route may never see a request sent while its document unloads.
            const delivered=received('checkpoint');
            assert.equal(delivered.length,1,'pagehide checkpoints the accepted footage');
            assert.deepEqual(shape(delivered[0]),{json:{action:'checkpoint',attemptId,captureSessionId:session,reason:'connection_lost'},contentType:'application/json',marker:'1'});
            assert.ok(received(canary)[0].at<=leftAt&&delivered[0].at>=leftAt,'the canary before the outer page left, the checkpoint after');
            const calls=await readProbe().then(p=>Array.isArray(p.entries)?p.entries.filter(e=>e.type==='fetch-checkpoint'):p.entries,
                e=>'probe unavailable: '+String(e?.message).slice(0,120));
            delivery={call:calls,router:count('checkpoint'),socket:delivered.length,routed,servername:delivered[0].servername,
                origin:delivered[0].headers.origin,site:delivered[0].headers['sec-fetch-site']};
        }
        for(const line of consoleLines)assert.ok(![attemptId,session,repo,proof,boot.user.id,recordingId].some(secret=>line.includes(secret)),'a diagnostic names no identifier: '+line);
        assert.deepEqual(errors,[]);
        return {signed,ending,mints:events.filter(e=>e.startsWith('mint:')),port:before.port,states:before.states,begin:count('begin'),editorReady:count('editor-ready'),checkpoint:count('checkpoint'),
            ...(delivery?{delivery}:{})};
    }catch(error){
        const probe=await readProbe().catch(e=>'probe unavailable: '+String(e?.message).slice(0,160));
        // What the loopback receiver saw during this run (query strings dropped), beside the route's and the document's own record.
        const socket=receiver.received.slice(socketFrom).map(e=>({at:e.at,method:e.method,host:e.host,servername:e.servername,
            path:String(e.path).split('?')[0],action:e.json?.action??null,headers:e.headers}));
        console.error(JSON.stringify({failure:String(error?.message).slice(0,700),signed,ending,events,errors,consoleLines,reported,armedReadBack,probe,
            socket,socketFaults:receiver.faults.slice(faultFrom),routed,browser:browser.version(),
            drive:await page?.evaluate(()=>({states:window.drive?.states,port:window.drive?.port})).catch(()=>null)}));
        throw error;
    }finally{release();await context.close();}
}
try{
    const results=[];
    for(const scenario of [{signed:true,ending:'stop'},{signed:true,ending:'pagehide'},{signed:true,ending:'paused'},{signed:true,ending:'reshare'},{signed:false,ending:'stop'}])results.push(await run(scenario));
    console.log(JSON.stringify({result:'pass',runs:results}));
}finally{try{await browser.close();}finally{await receiver.close();}}
