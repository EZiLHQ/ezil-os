// The shipped shell bundle framed by a Universe work page, in isolated Chromium. Every request is intercepted.
// Real: the OS shell bundle and its Code window, the exact-origin `ezil.assignment.work/v2` window and port exchange,
// the folder bridge hello. Fixtures: the Universe parent (protocol only, no capture), the checkout, the editor
// document, the assignment-video route and the media bucket.
//
// What it proves: one loader from launch to editor (no second screen over it, no blank gap), the editor parked until
// the gate releases it, the ordinary Code window controls and dock while embedded, the additive port events, and the
// computer's ordinary wake in flight before any share, once.
//
// Run:  node shell/ezil/assignment-video/work-embed-browser-test.mjs   (after shell/build-shell.sh)
//       EZIL_EMBED_TIMELINE=1 prints what the frame showed, in order. Exit 2 = skipped (no playwright or bundle).
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

// The production pair by default; EZIL_EMBED_SITE=staging runs the same assertions on the staging pair. Nothing is ever
// sent to either: every request is intercepted and the resolver maps every name to nothing.
const site=process.env.EZIL_EMBED_SITE==='staging'
    ? {universe:'https://universe-staging.ezil.work',origin:'https://os-staging.ezil.work',
        storage:'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',prefix:'/universe-staging/assignment-media/v1/'}
    : {universe:'https://universe.ezil.work',origin:'https://os.ezil.work',
        storage:'https://ezil-universe-production-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com',prefix:'/universe-production/assignment-media/v1/'};
const {universe,origin,storage}=site, editor='https://isolated-editor.invalid';
const protocol='ezil.assignment.work/v2';
const prepClock=process.env.EZIL_EMBED_PREP_CLOCK==='1';
const attemptId='2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a', recordingId='01111111-2222-4333-8444-555555555555';
const repoId='12222222-3333-4444-8555-666666666666', session='7c1a2f0e-58d4-4d0b-9b54-6f1e6f3f9a10';
const repo='https://github.ezil.work/default/u-0482ba160482ba16-a-'+attemptId+'.git';
const workspaceFolder='/workspace/projects/'+repoId, checkoutFolder=workspaceFolder+'/'+repo.split('/').at(-1).slice(0,-4);
const proof='q'.repeat(70), mint='A'.repeat(22);
const entry=origin+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+attemptId;
const boot={user:{id:'33333333-3333-4333-8333-333333333333',email:'qa@example.test'},
    computer:{id:'11111111-1111-4111-8111-111111111111',name:'QA computer',slot:1,isNew:false},
    apps:[{id:'desktop',name:'Browser',icon:'desktop',kind:'desktop'}],
    desktopState:{provider:'cloudflare-guacamole',configured:true,hasHmacSecret:true,status:'idle',endpoints:{system:'/api/shell/system'},ui:{floatingControls:false,feedbackScreenshots:false}}};
const wait=ms=>new Promise(r=>setTimeout(r,ms));

// What the framed OS shows at the centre of its Code window, sampled in the frame itself and kept as changes only.
const sampler='('+(()=>{
    const seen=window.__seen=[];let last='';
    setInterval(()=>{
        const win=document.querySelector('.window[data-app="code"]');
        if(!win)return;
        const body=win.querySelector('.window-body'),frame=win.querySelector('.window-app-iframe');
        const gate=win.querySelector('.ezil-assignment-work-gate'),loader=win.querySelector('.ezil-app-spinner');
        const box=body.getBoundingClientRect();
        const top=box.width&&box.height?document.elementFromPoint(box.left+box.width/2,box.top+box.height/2):null;
        const shown=el=>Boolean(el)&&!el.hidden&&getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().height>0;
        const at={
            gate:shown(gate)?gate.querySelector('h2')?.textContent??'':null,
            loader:shown(loader)?loader.dataset.state+':'+(loader.querySelector('.ezil-opening-title')?.textContent??''):null,
            editor:Boolean(frame)&&getComputedStyle(frame).visibility==='visible'&&!frame.inert&&frame.src!=='about:blank',
            top:!top?'none':gate?.contains(top)?'gate':loader?.contains(top)?'loader':top===frame?'editor':top.className||top.tagName,
        };
        const key=JSON.stringify(at);
        if(key!==last){last=key;seen.push({t:Math.round(performance.now()),...at});}
    },25);
}).toString()+')()';
const shellPage='<!doctype html><html><head><title>EZiL OS</title><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div>'
    +'<script>window.__EZIL_BOOT__='+JSON.stringify(boot)+'</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script>'
    +'<script>'+sampler+';window.ezil.boot();</script></body></html>';
const editorPage='<html><body style="margin:0;background:#4e223b;color:white;font:24px monospace"><h1>Assigned editor</h1><script>addEventListener("message",e=>{'
    +'if(e.origin!=="'+origin+'"||e.data.type!=="ezil.code.hello")return;const u=new URL(location.href);'
    +'const identity={v:1,nonce:e.data.nonce,mint:u.searchParams.get("ezil_mint"),kind:"folder",path:u.searchParams.get("folder")};'
    +'parent.postMessage({type:"ezil.code.folder",...identity},e.origin);'
    +'if(e.data.workbenchReady===true)setTimeout(()=>parent.postMessage({type:"ezil.code.workbench",...identity},e.origin),200);});</script></body></html>';
// The Universe parent's half of the protocol, as `assignment-work-capture.js` speaks it. No capture: fixture bytes.
const parentDriver='('+((protocol,attemptId,osOrigin,session)=>{
    const frame=document.querySelector('#os'),drive=window.drive={states:[],port:[],bound:false};
    let challenge=null,port=null,next=0;const waiting=new Map();
    const discover=()=>{if(challenge)frame.contentWindow?.postMessage({protocol,attemptId,type:'discover',challenge},osOrigin);};
    frame.addEventListener('load',()=>{challenge=crypto.randomUUID();discover();});
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
        event.source.postMessage({protocol,attemptId,type:'bind',challenge},osOrigin,[channel.port2]);drive.bound=true;
    });
    const rpc=(method,fields={})=>new Promise(resolve=>{const id=++next;waiting.set(id,resolve);port.postMessage({protocol,attemptId,type:'request',id,method,...fields});});
    drive.begin=()=>rpc('begin',{captureSessionId:session,consentVersion:4});
    drive.seed=()=>rpc('upload',{captureSessionId:session,part:{sequence:0,startMs:0,endMs:1,mimeType:'video/webm',bytes:new Uint8Array([26,69,223,163,1]).buffer}});
    drive.unlock=()=>rpc('unlock',{captureSessionId:session});
    drive.pulse=()=>port.postMessage({protocol,attemptId,type:'pulse',captureSessionId:session});
    setInterval(()=>{if(port)drive.pulse();},2000);
}).toString()+')('+[protocol,attemptId,origin,session].map(v=>JSON.stringify(v)).join(',')+')';
const parentPage='<!doctype html><html><head><title>Universe assignment</title></head><body style="margin:0;background:#f4f1ea">'
    +'<p id="status" style="font:14px sans-serif;margin:8px">Universe work page</p>'
    +'<iframe id="os" src="'+entry.replace(/&/g,'&amp;')+'" style="width:100%;height:700px;border:0;display:block"></iframe><script>'+parentDriver+'</script></body></html>';

const browser=await chromium.launch({headless:process.env.EZIL_CHROME_HEADED!=='1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',args:['--disable-dev-shm-usage','--host-resolver-rules=MAP * ~NOTFOUND']});
const events=[],errors=[],consoleLines=[],controls={};let seeded=false,editorClock,os,page,released=()=>{};
const held=new Promise(r=>released=r);
try{
    const context=await browser.newContext({viewport:{width:1200,height:780}});
    await context.route('**/*',async route=>{
        const req=route.request(),u=new URL(req.url()),post=()=>req.postDataJSON()||{};
        const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
        const html=body=>route.fulfill({contentType:'text/html',body});
        if(u.origin===universe)return html(parentPage);
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
            const d=post(),phase=d.assignment?.phase;events.push('mint:'+phase);
            if(d.repository?.url!==repo||d.assignment?.attemptId!==attemptId)return json({ok:false});
            const repository={id:repoId,name:'default/qa',workspaceFolder,checkoutFolder};
            await wait(500);
            if(phase==='prepare')return json({ok:true,repository,assignmentOpen:{attemptId,proof}});
            if(phase!=='open'||d.assignment.repoOpenProof!==proof||d.assignment.captureSessionId!==session||!seeded)return json({ok:false});
            await held;
            return json({ok:true,repository,codePreviewUrl:editor+'/?folder='+encodeURIComponent(workspaceFolder)+'&ezil_mint='+mint,assignmentOpen:{attemptId,proof}});
        }
        if(u.pathname==='/api/shell/assignment-video'){
            const d=post();events.push(d.action);
            const now=Date.now(),same={recordingId,captureSessionId:d.captureSessionId??session};
            const startedAt=new Date(now-1000).toISOString(),deadlineAt=new Date(now+1800000).toISOString();
            if(d.action==='preflight'){await wait(400);return json({status:'eligible',attemptId,repositoryUrl:repo,expiresAt:deadlineAt,windowStartedAt:null,deadlineAt:null,...(prepClock?{editorReadySupported:true}:{})});}
            if(d.action==='begin')return json({...same,status:'awaiting_frame',nextSequence:0,startedAt:null,deadlineAt:null,stopRequestedAt:null,revoked:false,
                authorizationExpiresAt:new Date(now+600000).toISOString()});
            if(d.action==='prepare')return json({expiresAt:deadlineAt,headers:{'content-type':'video/webm'},
                putUrl:storage+site.prefix+'o/'+attemptId+'/'+recordingId+'/segments/'+d.sequence+'/'+d.sha256+'.webm'});
            if(d.action==='confirm'){seeded=true;return json({...same,sequence:d.sequence,confirmed:true,phaseReady:true,nextSequence:d.sequence+1,
                firstFrameAt:startedAt,startedAt:fixed.startedAt,deadlineAt:fixed.deadlineAt,serverNow:new Date(now).toISOString()});}
            // The assignment's own clock: not started until `editor-ready`, then the same clock on every report.
            const canon=()=>({serverNow:new Date(now).toISOString(),startedAt:editorClock?.startedAt??null,deadlineAt:editorClock?.deadlineAt??null,
                pausedAt:null,pauseReason:null,remainingMs:editorClock?Math.max(0,Date.parse(editorClock.deadlineAt)-now):null,revision:editorClock?1:0});
            if(d.action==='clock')return json(canon());
            if (d.action==='editor-ready') {
                assert.ok(seeded);
                assert.equal(d.repoOpenProof,proof);
                assert.equal(d.captureSessionId,session);
                editorClock??={startedAt:new Date(now).toISOString(),deadlineAt:new Date(now+3600000).toISOString()};
                return json(canon());
            }
            if(d.action==='status')return json({...same,status:'recording',phaseReady:seeded,workspaceUnlocked:seeded,startedAt:fixed.startedAt,
                deadlineAt:editorClock&&prepClock?fixed.acceptedMediaCutoff:fixed.deadlineAt,serverNow:new Date(now).toISOString(),
                firstFrameAt:fixed.startedAt,stopRequestedAt:null,stopReason:null,revoked:false});
            return json({...same,status:'paused',startedAt:fixed.startedAt,deadlineAt:fixed.deadlineAt,stopRequestedAt:null,revoked:false});
        }
        if(u.searchParams.get('confirm')==='frame'){await wait(300);return json({ok:true,confirmed:true,status:200});}
        if(u.searchParams.get('confirm')==='display')return json({ok:true,display:'live'});
        if(u.pathname==='/api/shell/desktop'&&req.method()==='POST'){
            // The ordinary warm: a cold start that stays in flight for the whole preparation.
            events.push('desktop:'+post().intent);await held;
            return json({ok:true,guacamoleUrl:'https://isolated-preview.invalid/?desktop=1',frame:{confirmed:true}});
        }
        if(u.pathname==='/api/shell/desktop')return json({ok:true,guacamoleRunning:true});
        // Production checks this computer before the port may say `ready` (the gate's `computerRefusal`).
        if(u.pathname==='/api/shell/system'){events.push('system');return json({ok:true,info:{provider:'cloudflare'}});}
        if(u.pathname.startsWith('/api/'))return json({ok:true,reports:[]});
        return route.fulfill({status:404,body:''});
    });
    const fixed={startedAt:new Date(Date.now()-1000).toISOString(),deadlineAt:new Date(Date.now()+1800000).toISOString(),
        acceptedMediaCutoff:new Date(Date.now()+3800000).toISOString()};
    page=await context.newPage();page.setDefaultTimeout(25000);
    page.on('pageerror',e=>errors.push(e.message.slice(0,160)));
    page.on('console',m=>{if(m.text().startsWith('assignment.workspace.'))consoleLines.push(m.text());});
    await page.goto(universe+'/assignment/work');
    os=page.frames().find(f=>f.url().startsWith(origin))??await page.waitForEvent('framenavigated',f=>f.url().startsWith(origin));
    await os.waitForSelector('.window[data-app="code"]');
    const drive=fn=>page.evaluate(fn);
    const seen=()=>os.evaluate(()=>window.__seen.slice());
    const codeWindow=os.locator('.window[data-app="code"]');

    // The parent is bound and told the workspace is eligible before any share.
    await page.waitForFunction(()=>window.drive.port.some(m=>m.type==='ready'));
    await wait(600);
    // The computer's ordinary wake is already in flight: before any share, checkout or editor, and exactly one.
    assert.deepEqual(events.filter(e=>e!=='status'&&e!=='clock'&&e!=='system'),['preflight','desktop:warm'],'a cold start overlaps the brief and the picker');
    const begun=await drive(()=>window.drive.begin());assert.equal(begun.ok,true,JSON.stringify(begun));
    const seedReply=await drive(()=>window.drive.seed());assert.equal(seedReply.value?.phaseReady,true,JSON.stringify(seedReply));
    const unlocking=drive(()=>window.drive.unlock());unlocking.catch(()=>{});
    await wait(900);
    // The open mint is held: the editor is still closed, and the window's own controls work under the loader.
    assert.equal(await codeWindow.locator('.window-app-iframe').evaluate(el=>el.inert&&getComputedStyle(el).visibility==='hidden'),true,'the editor stays parked before release');
    const full=()=>codeWindow.evaluate(el=>el.classList.contains('ezil-fullbleed'));
    const minimized=()=>codeWindow.evaluate(el=>['1','true'].includes(el.getAttribute('data-is_minimized')));
    // Launched as an ordinary window: head, minimise, expand, and the dock under it.
    controls.windowedAtLaunch=!(await full());
    controls.head=await codeWindow.locator('> .window-head').isVisible();
    controls.minimize=await codeWindow.locator('> .window-head > .window-minimize-btn').count();
    controls.state=await codeWindow.locator('.window-body').getAttribute('data-ezil-assignment-work');
    controls.geometry=await os.evaluate(()=>{
        const w=document.querySelector('.window[data-app="code"]').getBoundingClientRect(),bar=document.querySelector('.taskbar')?.getBoundingClientRect();
        return {inside:w.top>=0&&w.left>=0&&w.right<=innerWidth&&w.bottom<=innerHeight,dock:Boolean(bar)&&bar.height>0&&bar.bottom<=innerHeight+1,clear:!bar||w.bottom<=bar.top+1};
    });
    await codeWindow.locator('> .window-head > .window-minimize-btn').click();
    await os.waitForFunction(()=>['1','true'].includes(document.querySelector('.window[data-app="code"]').getAttribute('data-is_minimized')));
    controls.dockItem=await os.locator('.taskbar-item[data-app="code"]').count();
    await os.locator('.taskbar-item[data-app="code"]').click();
    await os.waitForFunction(()=>!['1','true'].includes(document.querySelector('.window[data-app="code"]').getAttribute('data-is_minimized')));
    await wait(350);
    await codeWindow.locator('> .window-head > .window-scale-btn').click();
    await os.waitForFunction(()=>document.querySelector('.window[data-app="code"]').classList.contains('ezil-fullbleed'));
    controls.expands=await full();
    await codeWindow.locator('> .ezil-app-drawer .dashboard-app-drawer-toggle').focus();
    await codeWindow.locator('> .ezil-app-drawer .dashboard-app-drawer-restore').click();
    await os.waitForFunction(()=>!document.querySelector('.window[data-app="code"]').classList.contains('ezil-fullbleed'));
    controls.restores=!(await full())&&!(await minimized());
    await wait(400);
    assert.deepEqual(await drive(()=>window.drive.port.map(m=>m.type).filter(t=>t==='pause'||t==='reopen')),[],'window controls never end the phase');
    released();
    const unlocked=await unlocking;assert.equal(unlocked.ok,true,JSON.stringify(unlocked));
    await os.frameLocator('.window[data-app="code"] .window-app-iframe').getByText('Assigned editor').waitFor();
    await wait(700);

    const timeline=await seen(),port=await drive(()=>window.drive.port),states=await drive(()=>window.drive.states);
    if(process.env.EZIL_EMBED_TIMELINE==='1')console.log(JSON.stringify({timeline,port,states,events,controls,consoleLines},null,1));
    // One surface until the editor: the window's own loader, never a second screen over it and never a blank body.
    const before=timeline.filter(s=>!s.editor);
    assert.deepEqual([...new Set(before.map(s=>s.gate).filter(g=>g!==null))],[],'no gate screen over the loader while the workspace prepares');
    assert.ok(before.length>0&&before.every(s=>s.loader!==null),'the loader is on screen from launch until the editor: '+JSON.stringify(before.filter(s=>s.loader===null)));
    assert.deepEqual([...new Set(before.map(s=>s.loader.split(':')[1]))],['Opening Code…'],'one loader title');
    assert.ok(before.every(s=>!s.loader.startsWith('done:')),'the loader does not conclude before the editor is released');
    const after=timeline.filter(s=>s.editor);
    assert.ok(after.length>0&&after.at(-1).gate===null&&after.at(-1).top==='editor','the released editor is what the window shows: '+JSON.stringify(timeline.at(-1)));
    assert.equal(timeline.findIndex(s=>s.editor),timeline.findLastIndex(s=>!s.editor)+1,'the editor is released once');
    // The wire: window states unchanged, the old port `ready`, and the two additive port events around it.
    assert.deepEqual(states,['preparing','ready']);
    assert.deepEqual(port.map(m=>m.type),['capture-ready','ready','editor-usable']);
    // `editor-usable` carries the assignment's own clock exactly as `editor-ready` answered it, and nothing else.
    assert.deepEqual(port.at(-1),{protocol,attemptId,type:'editor-usable',captureSessionId:session,deadlineAt:editorClock.deadlineAt,serverNow:port.at(-1).serverNow});
    assert.ok(Number.isFinite(Date.parse(port.at(-1).serverNow)));
    // Told once, by the shell, and only after the editor document (under a managed preparation: its workbench) was there.
    assert.equal(events.filter(e=>e==='editor-ready').length,1);
    assert.ok(events.indexOf('editor-ready')>events.indexOf('mint:open'));
    assert.equal(unlocked.value.startedAt,fixed.startedAt);
    // The media window: the seed's own, or the cutoff the broker restated once a managed preparation's work hour began.
    assert.equal(unlocked.value.deadlineAt,prepClock?fixed.acceptedMediaCutoff:fixed.deadlineAt);
    assert.equal(unlocked.value.clock.startedAt,editorClock.startedAt);
    assert.equal(unlocked.value.clock.deadlineAt,editorClock.deadlineAt);
    assert.deepEqual(events.filter(e=>e.startsWith('mint:')),['mint:prepare','mint:open'],'one checkout and one editor open');
    assert.deepEqual(events.filter(e=>e.startsWith('desktop:')),['desktop:warm'],'one wake across share, minimise, restore, expand and the editor open');
    assert.deepEqual(controls,{windowedAtLaunch:true,head:true,minimize:1,state:'preparing',geometry:{inside:true,dock:true,clear:true},dockItem:1,expands:true,restores:true});
    assert.equal(await codeWindow.locator('.window-body').getAttribute('data-ezil-assignment-work'),'open');
    for(const line of consoleLines)assert.ok(![attemptId,session,repo,proof,boot.user.id,recordingId].some(secret=>line.includes(secret)),'a diagnostic names no identifier: '+line);
    // The computer check is production's own, asked before `ready`; staging's pair asks nothing.
    assert.equal(events.includes('system'),origin==='https://os.ezil.work');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({result:'pass',origin,universe,prepClock,surfaces:timeline.length,port:port.map(m=>m.type),states,controls,diagnostics:consoleLines.length}));
}catch(error){
    console.error(JSON.stringify({failure:String(error?.message).slice(0,600),controls,events,errors,consoleLines,timeline:await os?.evaluate(()=>window.__seen).catch(()=>null),
        drive:await page?.evaluate(()=>({states:window.drive?.states,port:window.drive?.port})).catch(()=>null)}));
    throw error;
}finally{released();await browser.close();}
