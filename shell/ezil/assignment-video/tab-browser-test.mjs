// Rehearses the shipped shell in isolated Chromium. Every network request is intercepted.
// The checkout, editor, Browser preview and Works are fixtures. Source selection and capture are real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {chromium} = createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR || '/opt/ezil-testkit','test.cjs'))('playwright');
const assets = process.env.EZIL_SHELL_OUT_DIR || new URL('../../../app/public/os/', import.meta.url).pathname;
const origin = 'https://os-staging.ezil.work';
const editor = 'https://isolated-editor.invalid';
const preview = 'https://isolated-preview.invalid';
const storage = 'https://ezil-universe-staging-assignment-media-452630323510-aps1.s3.ap-south-1.amazonaws.com';
const attemptId = '2d5fd5d2-ad3e-47ea-9a95-60eb51bce32a';
const recordingId = '01111111-2222-4333-8444-555555555555';
const repoId = '12222222-3333-4444-8555-666666666666';
const repo = 'https://github.ezil.work/default/u-0482ba160482ba16-a-'+attemptId+'.git';
const folder = '/workspace/projects/'+repoId;
const proof = 'q'.repeat(70);
const directory = fs.mkdtempSync(path.join(os.tmpdir(),'ezil-tab-fixture-'));
const scope = 'EZiL isolated capture rehearsal';
const stage = new Date(Date.now()-20000).toISOString();
const deadline = new Date(Date.parse(stage)+3600000).toISOString();
const boot = {user:{id:'33333333-3333-4333-8333-333333333333',email:'qa@example.test'},
    computer:{id:'11111111-1111-4111-8111-111111111111',name:'QA computer',slot:1,isNew:false},
    apps:[{id:'desktop',name:'Browser',icon:'desktop',kind:'desktop'}],
    desktopState:{provider:'cloudflare-guacamole',configured:true,hasHmacSecret:true,status:'idle',
        ui:{floatingControls:false,feedbackScreenshots:false}}};
const browser = await chromium.launch({headless:process.env.EZIL_CHROME_HEADED !== '1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || '/usr/bin/google-chrome',
    args:['--disable-dev-shm-usage','--auto-select-tab-capture-source-by-title='+scope,
        '--host-resolver-rules=MAP * ~NOTFOUND']});
const recordings=[], events=[], pages=[], references={};
let opened=false, received=false, finalized, errorDetails=[];
const content = (route,body) => route.fulfill({contentType:'text/html',body});
const shellPage = '<!doctype html><html><head><title>'+scope+'</title><link rel="stylesheet" href="/os/bundle.min.css"></head><body><div id="ezil-os-root"></div><script>window.__EZIL_BOOT__='+JSON.stringify(boot)+'</script><script src="/os/icons.js"></script><script src="/os/bundle.min.js"></script></body></html>';
const frame = '<html><body style="margin:0;background:#4e223b;color:white;font:24px monospace"><h1>Assigned editor</h1><pre>1  const receipt = await submit();</pre><script>addEventListener("message",e=>{if(e.origin!=="'+origin+'"||e.data.type!=="ezil.code.hello")return; const u=new URL(location.href); parent.postMessage({type:"ezil.code.folder",v:1,nonce:e.data.nonce,mint:u.searchParams.get("ezil_mint"),kind:"folder",path:u.searchParams.get("folder")},e.origin);});</script></body></html>';
const browserFrame = '<html><body style="background:#125158;color:white;font:25px sans-serif"><h1>Assigned browser preview</h1><script>let n=0;setInterval(()=>{n++;parent.postMessage({source:"ezil-mobile",type:"stream_vitals",attempt:new URL(location.href).searchParams.get("ezilAttempt"),vitals:{connectionState:"connected",framesDecoded:n,bytesReceived:n*100,width:1280,height:720}},"'+origin+'")},100);</script></body></html>';
try {
    const context = await browser.newContext({viewport:{width:1024,height:760}});
    await context.route('**/*', async route => {
        const req=route.request(), u=new URL(req.url()), post=()=>req.postDataJSON()||{};
        const json=body=>route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
        if (u.origin===editor) return content(route,frame);
        if (u.origin===preview) return content(route,browserFrame);
        if (u.origin===storage && req.method()==='PUT') {
            const bytes=req.postDataBuffer();
            recordings.push(bytes); return route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':origin},body:''});
        }
        if (u.origin!==origin) return route.abort();
        if (u.pathname.startsWith('/app/')) return content(route,shellPage);
        if (u.pathname.startsWith('/os/')) {
            const file=path.join(assets,path.basename(u.pathname));
            if (!fs.existsSync(file)) return route.abort();
            return route.fulfill({contentType:file.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(file)});
        }
        if (u.pathname==='/api/shell/code-preview-url') {
            events.push('open-request');
            if (post().repository?.url !== repo) return json({ok:false});
            while(!opened) await new Promise(r=>setTimeout(r,50));
            received=true;
            return json({ok:true,repository:{id:repoId,name:'default/qa'},codePreviewUrl:editor+'/?folder='+folder,
                assignmentOpen:{attemptId,proof,openedAt:new Date().toISOString(),windowStartedAt:stage,deadlineAt:deadline}});
        }
        if (u.pathname==='/api/shell/assignment-video') {
            const d=post();
            // Universe's canonical countdown: the lease-free `clock` and the verified editor's `editor-ready` (not recording events).
            if (d.action==='clock' || d.action==='editor-ready') return json({serverNow:new Date().toISOString(),startedAt:stage,deadlineAt:deadline,
                pausedAt:null,pauseReason:null,remainingMs:null,revision:1});
            events.push(d.action);
            if (d.action==='preflight') return json({status:'eligible',attemptId,jobId:'1',repositoryUrl:repo,expiresAt:deadline,windowStartedAt:stage,deadlineAt:deadline});
            if (d.action==='begin') { assert.equal(received,true); assert.equal(d.repoOpenProof,proof); return json({recordingId,status:'recording',startedAt:stage,deadlineAt:deadline}); }
            if (d.action==='status') return json({recordingId,status:'recording',revoked:false});
            if (d.action==='prepare') return json({putUrl:storage+'/universe-staging/assignment-media/v1/'+attemptId+'/'+recordingId+'/segments/'+d.sequence+'/'+d.sha256+'.webm',headers:{},expiresAt:deadline});
            if (d.action==='confirm') return json({recordingId,confirmed:true,sequence:d.sequence});
            if (d.action==='finalize') { finalized=d; return json({status:'stopped'}); }
        }
        if (u.searchParams.get('confirm')==='frame') return json({ok:true,confirmed:true,status:200});
        if (u.searchParams.get('confirm')==='display') return json({ok:true,display:'live'});
        if (u.pathname==='/api/shell/desktop') return json(req.method()==='POST'?{ok:true,guacamoleUrl:preview+'/?desktop=1',frame:{confirmed:true}}:{ok:true,guacamoleRunning:true});
        if (u.pathname.startsWith('/api/')) return json({ok:true,reports:[]});
        return route.fulfill({status:404,body:''});
    });
    const page=await context.newPage(); pages.push(page); page.setDefaultTimeout(18000);
    page.on('pageerror',e=>errorDetails.push(e.message.slice(0,90)));
    await page.goto(origin+'/app/code?repo='+encodeURIComponent(repo)+'&assignment='+attemptId);
    await page.evaluate(()=>window.ezil.boot());
    const share=page.getByRole('button',{name:'Share this EZiL OS tab and open assignment'});
    await share.waitFor(); await page.evaluate(title=>document.title=title,scope);
    assert.equal(events.includes('open-request'),false);
    await share.click();
    await page.getByText('Tab sharing is on.',{exact:false}).waitFor();
    await page.waitForTimeout(1200);
    assert.equal(events.includes('begin'),false); assert.equal(recordings.length,0);
    opened=true;
    await page.getByText('Recording this EZiL OS tab',{exact:false}).waitFor();
    const take=async name=>{
        await page.waitForTimeout(1900);
        const file=path.join(directory,name+'.png'); await page.screenshot({path:file});
        references[name]=decode(file); await page.waitForTimeout(2200);
    };
    await take('Code');
    const drawer=page.locator('.window[data-app="code"] > .ezil-app-drawer');
    await drawer.locator('.dashboard-app-drawer-toggle').focus();
    await drawer.locator('.dashboard-app-drawer-minimize').click();
    await page.waitForFunction(()=>['1','true'].includes(document.querySelector('.window[data-app="code"]').getAttribute('data-is_minimized')));
    await page.locator('.taskbar-item[data-app="desktop"]').click();
    await page.frameLocator('.window[data-app="desktop"] iframe').getByText('Assigned browser preview').waitFor();
    await take('Browser');
    await page.evaluate(async()=>{const p=window.__EZIL_BOOT__; await window.ezil.registry.launch('settings',{payload:p,computer:p.computer,desktopState:p.desktopState});});
    await page.locator('.window[data-app="settings"]').waitFor();
    await take('Settings');
    await page.getByRole('button',{name:'Stop sharing'}).click();
    await page.waitForFunction(()=>document.querySelector('.ezil-assignment-video-panel')?.textContent.includes('Assignment recording stopped.'));
    assert.equal(finalized.reason,'stopped'); assert.equal(finalized.expectedSegments,recordings.length);
    const frames=[];
    for(const [i,bytes] of recordings.entries()){
        const file=path.join(directory,'segment-'+i+'.webm'); fs.writeFileSync(file,bytes);
        const size=128*76*3, pixels=decode(file);
        for(let off=0;off+size<=pixels.length;off+=size) frames.push(pixels.subarray(off,off+size));
    }
    function decode(file){return execFileSync('ffmpeg',['-v','error','-i',file,'-vf','scale=128:76','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:30*1024*1024});}
    const diff=(a,b)=>a.reduce((sum,value,i)=>sum+Math.abs(value-b[i]),0)/a.length;
    const scores={};
    for(const [name,ref] of Object.entries(references)){
        const distances=frames.map(f=>diff(f,ref));
        const min=Math.min(...distances), best=distances.indexOf(min);
        assert.ok(min<15, name+' compositor does not match screenshot. Mean absolute error '+min);
        scores[name]={frame:best,meanAbsoluteError:Number(min.toFixed(2))};
    }
    assert.ok(scores.Code.frame<scores.Browser.frame && scores.Browser.frame<scores.Settings.frame);
    const ordinary = await context.newPage();
    const previousCalls=events.length;
    await ordinary.goto(origin+'/app/code?repo='+encodeURIComponent('https://github.ezil.work/default/ordinary.git'));
    await ordinary.evaluate(()=>window.ezil.boot());
    await ordinary.locator('.window[data-app="code"]').waitFor();
    await ordinary.waitForTimeout(700);
    assert.equal(await ordinary.locator('.ezil-assignment-video-panel').count(),0);
    assert.ok(events.slice(previousCalls).includes('open-request'));
    assert.ok(!events.slice(previousCalls).some(action=>['preflight','begin','prepare'].includes(action)));
    console.log(JSON.stringify({result:'pass',ordinaryRepoMediaCalls:0,preReceiptBytes:0,frames:frames.length,segments:recordings.length,scores,
        mocks:['browser test-only tab choice','checkout and iframe content','media backend and private storage intercepted in process'],
        real:['top-level OS shell bundle','Code minimize','Browser and Settings windows','browser tab capture and capture handle','silent VP8 encode and FFmpeg decode']}));
} catch (e) {
    console.error('stage events',events,'page errors',errorDetails);
    for(const p of pages) console.error('UI',await p.locator('.ezil-assignment-video-panel').allTextContents(), 'windows',await p.locator('.window').evaluateAll(ws=>ws.map(w=>w.dataset.app)));
    throw e;
} finally { await browser.close(); fs.rmSync(directory,{recursive:true,force:true}); }
