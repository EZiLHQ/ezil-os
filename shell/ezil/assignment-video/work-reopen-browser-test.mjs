// The shipped shell bundle framed by a Universe work page, in isolated Chromium: the assignment's Code window is really
// closed (its native X, the window leaves the document) and opened again from the dock, inside ONE capture.
// Real: the OS shell bundle, its Code window, its dock, the exact-origin `ezil.assignment.work/v2` window and port
// exchange, the folder bridge. Fixtures: the Universe parent (protocol only, no capture), the checkout, the editor
// document, the assignment-video route and the media bucket. Every request is intercepted.
//
// What it proves, per run:
//   - native X says nothing on the port or the window (no pause, no reopen, no state), asks the server nothing, and
//     neither the Universe page nor the OS frame is loaded again; the capture keeps taking pulses and clips meanwhile;
//   - the dock's projectless launch opens the SAME assigned checkout: one `reopen` mint naming the original receipt
//     and capture, parked under the window's own loader until that editor reports the verified folder (and its mounted
//     workbench under the signed preparation);
//   - one prepare, one begin, one first frame, one editor-ready, one editor-usable across the close and the reopen;
//   - the explicit Stop still ends the phase at once, and so does the outer page going away with no Code window open;
//   - a new share begun while no Code window is open brings that window back by itself (the document's own launch) and
//     is an ordinary new capture: its own prepare, begin, first frame and open.
//
// Run:  node shell/ezil/assignment-video/work-reopen-browser-test.mjs   (after shell/build-shell.sh)
//       Exit 2 = skipped (no playwright or bundle).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
let chromium;
try{({chromium}=createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR||process.env.EZIL_PLAYWRIGHT_DIR||'/opt/ezil-testkit','p.cjs'))('playwright'));}
catch{console.error('SKIP: playwright is not resolvable');process.exit(2);}
const assets=process.env.EZIL_SHELL_OUT_DIR||new URL('../../../app/public/os/',import.meta.url).pathname;
for(const file of ['icons.js','bundle.min.js','bundle.min.css'])
    if(!fs.existsSync(path.join(assets,file))){console.error('SKIP: missing '+file+', run shell/build-shell.sh');process.exit(2);}

const universe='https://universe-staging.ezil.work', origin='https://os-staging.ezil.work', editor='https://isolated-editor.invalid';
const storage='https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
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
    desktopState:{provider:'cloudflare-guacamole',configured:true,hasHmacSecret:true,status:'idle',ui:{floatingControls:false,feedbackScreenshots:false}}};
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
    drive.stop=()=>{port.postMessage({protocol,attemptId,type:'lock',captureSessionId:session,reason:'sharing_stopped'});
        return rpc('end',{captureSessionId:session,reason:'sharing_stopped',expectedSegments:sequence});};
    setInterval(()=>{if(port)port.postMessage({protocol,attemptId,type:'pulse',captureSessionId:session});},2000);
}).toString()+')('+[protocol,attemptId,origin,session].map(v=>JSON.stringify(v)).join(',')+')';
const parentPage='<!doctype html><html><head><title>Universe assignment</title></head><body style="margin:0;background:#f4f1ea">'
    +'<p id="status" style="font:14px sans-serif;margin:8px">Universe work page</p>'
    +'<iframe id="os" src="'+entry.replace(/&/g,'&amp;')+'" style="width:100%;height:700px;border:0;display:block"></iframe><script>'+parentDriver+'</script></body></html>';

const browser=await chromium.launch({headless:process.env.EZIL_CHROME_HEADED!=='1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',args:['--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND']});

/** `signed`: Universe signs `editorReadySupported` (today's stage). `ending`: how the phase is ended after the reopen. */
async function run({signed,ending}){
    const events=[],mints=[],errors=[],consoleLines=[];let seeded=false,released=false,editorClock,os,page,minted=0,release=()=>{};
    let reopenHeld=new Promise(r=>release=r);
    const context=await browser.newContext({viewport:{width:1200,height:780}});
    await context.addInitScript(()=>{
        window.assignmentCueLeases=0;
        window.assignmentNativeEvents={click:0,contextmenu:0};
        addEventListener('message',event=>{if(event.data?.type==='ezil.assignment.click-cues')window.assignmentCueLeases++;});
        for(const type of ['click','contextmenu'])addEventListener(type,event=>{
            if(event.isTrusted)window.assignmentNativeEvents[type]++;
        },true);
    });
    const fixed={startedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+1800000).toISOString(),
        acceptedMediaCutoff:new Date(Date.now()+3800000).toISOString()};
    try{
        await context.route('**/*',async route=>{
            const req=route.request(),u=new URL(req.url()),post=()=>req.postDataJSON()||{};
            const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
            const html=body=>route.fulfill({contentType:'text/html',body});
            if(u.origin===universe)return u.pathname==='/left'?html('<!doctype html><title>Elsewhere</title><p>Left the assignment</p>'):html(parentPage);
            if(u.origin===editor)return html(editorPage);
            if(u.origin===storage&&req.method()==='PUT')return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':origin},body:''});
            if(u.origin===storage)return route.fulfill({status:204,headers:{'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Methods':'PUT','Access-Control-Allow-Headers':'*'},body:''});
            if(u.origin!==origin)return route.abort();
            if(u.pathname.startsWith('/app/'))return html(shellPage);
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
                const d=post();events.push(d.action);
                const now=Date.now(),same={recordingId,captureSessionId:d.captureSessionId??session};
                if(d.action==='preflight')return json({status:'eligible',attemptId,repositoryUrl:repo,expiresAt:fixed.deadlineAt,windowStartedAt:null,deadlineAt:null,...(signed?{editorReadySupported:true}:{})});
                // A new capture: its own first frame and its own first open.
                if(d.action==='begin'){seeded=false;released=false;}
                if(d.action==='begin')return json({...same,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
                    authorizationExpiresAt:new Date(now+600000).toISOString()});
                if(d.action==='prepare')return json({expiresAt:fixed.deadlineAt,headers:{'content-type':'video/webm'},
                    putUrl:storage+'/universe-staging/assignment-media/v1/o/'+attemptId+'/'+recordingId+'/segments/'+d.sequence+'/'+d.sha256+'.webm'});
                if(d.action==='confirm'){
                    const seed=!seeded;seeded=true;
                    return json(seed?{...same,sequence:d.sequence,confirmed:true,phaseReady:true,nextSequence:d.sequence+1,
                        firstFrameAt:fixed.startedAt,startedAt:fixed.startedAt,deadlineAt:fixed.deadlineAt,serverNow:new Date(now).toISOString()}
                        :{recordingId,sequence:d.sequence,confirmed:true});
                }
                if(d.action==='editor-ready'){
                    editorClock={startedAt:new Date(now).toISOString(),serverNow:new Date(now).toISOString(),deadlineAt:new Date(now+3600000).toISOString()};
                    return json(editorClock);
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
            if(u.pathname.startsWith('/api/'))return json({ok:true,reports:[]});
            return route.fulfill({status:404,body:''});
        });
        page=await context.newPage();page.setDefaultTimeout(25000);
        page.on('pageerror',e=>errors.push(e.message.slice(0,160)));
        page.on('console',m=>{if(m.text().startsWith('assignment.workspace.'))consoleLines.push(m.text());});
        await page.goto(universe+'/assignment/work');
        os=page.frames().find(f=>f.url().startsWith(origin))??await page.waitForEvent('framenavigated',f=>f.url().startsWith(origin));
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
        assert.deepEqual(quiet,{checkpoint:0,finalize:0,begin:1,preflight:2,editorReady:signed?1:0});

        // ── Native X: the window really leaves the document ──
        await codeWindow.locator('> .window-head .window-close-btn').click();
        await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
        const requestsAtClose=events.filter(e=>e!=='status').length;
        // Long enough for a pulse, a status poll and anything a close would have said.
        await wait(2600);
        assert.equal(await os.locator('.window[data-app="code"]').count(),0,'closed, not minimised');
        assert.deepEqual(await wire(),before,'native X: no pause, no reopen, no window state, no second bind, no frame load');
        assert.equal(await os.evaluate(()=>window.__loaded),loadedOs,'the OS document is the same one');
        assert.deepEqual(events.filter(e=>e!=='status').length,requestsAtClose,'closing asks the server nothing');
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
        assert.deepEqual((await drive(()=>window.drive.status())).value.deadlineAt,clockBefore.deadlineAt,'the same clock');
        assert.deepEqual((await drive(()=>window.drive.clip())).value,{confirmed:true,sequence:2});

        if(ending==='stop'){
            // ── Universe's Stop: the editor locks at once and the phase is saved, with the reopened window on screen ──
            const ended=await drive(()=>window.drive.stop());assert.equal(ended.ok,true,JSON.stringify(ended));
            assert.equal(count('checkpoint'),1);
            assert.equal(await state(),'held');assert.equal((await shownEditor()).parked,true);
            assert.equal(await codeWindow.locator('.ezil-assignment-work-gate h2').textContent(),'Sharing paused');
            assert.deepEqual((await wire()).port,before.port,'the parent\'s own stop needs no pause');
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
            assert.deepEqual([count('begin'),count('editor-ready')],[2,signed?2:0]);
        }else{
            // ── The outer page goes away while NO Code window is open: the document's own pagehide still saves the phase ──
            await codeWindow.locator('> .window-head .window-close-btn').click();
            await os.waitForFunction(()=>document.querySelectorAll('.window[data-app="code"]').length===0);
            await wait(400);
            assert.equal(count('checkpoint'),0);assert.deepEqual(await wire(),before);
            await page.goto(universe+'/left');
            for(let i=0;i<100&&count('checkpoint')===0;i++)await wait(50);
            assert.ok(count('checkpoint')>=1,'pagehide checkpoints the accepted footage');
        }
        for(const line of consoleLines)assert.ok(![attemptId,session,repo,proof,boot.user.id,recordingId].some(secret=>line.includes(secret)),'a diagnostic names no identifier: '+line);
        assert.deepEqual(errors,[]);
        return {signed,ending,mints:events.filter(e=>e.startsWith('mint:')),port:before.port,states:before.states,begin:count('begin'),editorReady:count('editor-ready'),checkpoint:count('checkpoint')};
    }catch(error){
        console.error(JSON.stringify({failure:String(error?.message).slice(0,700),signed,ending,events,errors,consoleLines,
            drive:await page?.evaluate(()=>({states:window.drive?.states,port:window.drive?.port})).catch(()=>null)}));
        throw error;
    }finally{release();await context.close();}
}
try{
    const results=[];
    for(const scenario of [{signed:true,ending:'stop'},{signed:true,ending:'pagehide'},{signed:true,ending:'reshare'},{signed:false,ending:'stop'}])results.push(await run(scenario));
    console.log(JSON.stringify({result:'pass',runs:results}));
}finally{await browser.close();}
