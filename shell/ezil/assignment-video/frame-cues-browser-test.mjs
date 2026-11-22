// Real first-party visual cue scripts, isolated Chromium and inert documents. No recording or external request.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
const {chromium}=createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR||'/opt/ezil-testkit','p.cjs'))('playwright');
const parent='https://os-staging.ezil.work', editor='https://editor.invalid', viewer='https://viewer.invalid';
const withViewer=process.env.EZIL_TEST_NEKO_CUES==='1';
const mint='A'.repeat(22), viewerAttempt='3edab991-4ad7-4fd0-a286-e521b836593f';
const workbench='<html><head><meta charset="utf-8"><script nonce="abc012349xyz">0</script></head><body class="monaco-workbench"><button>Editor control</button><input type="password"></body></html>';
const workerRoot=process.env.EZIL_FRAME_CUE_WORKER_ROOT || new URL('../../../worker/',import.meta.url).pathname;
const workerModule=path.join(workerRoot,'src/code-folder-bridge.ts');
const code=execFileSync('bun',['-e','import {injectCodeFolderBridge as inject} from '+JSON.stringify(workerModule)+';process.stdout.write(inject('+JSON.stringify(workbench)+','+JSON.stringify([parent])+'));'],{encoding:'utf8'});
const visual=fs.readFileSync(path.join(workerRoot,'scripts/assignment-click-cues.txt'),'utf8');
const shellAdapter=fs.readFileSync(new URL('./frame-cues.js',import.meta.url),'utf8');
const browser=await chromium.launch({headless:process.env.EZIL_CHROME_HEADED!=='1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',args:['--host-resolver-rules=MAP * ~NOTFOUND']});
try {
    const ctx=await browser.newContext();
    await ctx.route('**/*',route=>{
        const u=new URL(route.request().url());
        const html=body=>route.fulfill({contentType:'text/html',body});
        const js=body=>route.fulfill({contentType:'text/javascript',body});
        if(u.origin===editor)return html(code);
        if(u.origin===viewer && u.pathname==='/cues.js')return js(visual);
        if(u.origin===viewer)return html('<html><head><script src="/cues.js" defer data-ezil-viewer-cues></script></head><body><textarea class="overlay"></textarea><button>Viewer chrome</button></body></html>');
        if(u.origin!==parent)return route.abort();
        if(u.pathname==='/binding.js')return js(shellAdapter);
        return html('<iframe id="editor" src="'+editor+'/?folder=/workspace&amp;ezil_mint='+mint+'"></iframe><iframe id="viewer" src="'+viewer+'/?ezilAttempt='+viewerAttempt+'"></iframe>');
    });
    const page=await ctx.newPage();await page.goto(parent+'/app/code');
    await page.evaluate(async ({editor,viewer,mint,viewerAttempt})=>{
        const {bindFrameClickCues,setFrameClickCues}=await import('/binding.js');
        bindFrameClickCues(document.querySelector('#editor'),editor,mint,'computer-a');
        bindFrameClickCues(document.querySelector('#viewer'),viewer,viewerAttempt,'computer-a');
        window.setCueScope=setFrameClickCues;
    },{editor,viewer,mint,viewerAttempt});
    const codeFrame=page.frameLocator('#editor'),browserFrame=page.frameLocator('#viewer');
    const mark='[data-ezil-assignment-click]';
    const button=codeFrame.getByRole('button',{name:'Editor control'});
    await button.click();assert.equal(await codeFrame.locator(mark).count(),0);
    await page.evaluate(()=>window.setCueScope('computer-b'));
    await button.click();assert.equal(await codeFrame.locator(mark).count(),0);
    await page.evaluate(()=>window.setCueScope('computer-a'));
    const surfaces=[[codeFrame,button]];
    if(withViewer) surfaces.push([browserFrame,browserFrame.locator('textarea.overlay')]);
    for(const [frame,target] of surfaces) {
        for(const [button,label] of [['left','L'],['right','R']]){
            await target.click({button});
            await frame.locator(mark).filter({hasText:new RegExp('^'+label+'$')}).waitFor({timeout:2000});
            await page.keyboard.press('Escape');
        }
        await frame.locator(mark).waitFor({state:'detached'});
    }
    await codeFrame.locator('input[type=password]').click();
    assert.equal(await codeFrame.locator(mark).count(),0);
    await browserFrame.getByRole('button',{name:'Viewer chrome'}).click();
    assert.equal(await browserFrame.locator(mark).count(),0);
    await page.evaluate(()=>window.setCueScope(null));
    await button.click();assert.equal(await codeFrame.locator(mark).count(),0);
    await browserFrame.locator('textarea.overlay').click();assert.equal(await browserFrame.locator(mark).count(),0);
    console.log(JSON.stringify({managedCode:['L','R'],managedBrowserInput:withViewer?['L','R']:'not included in this run',wrongComputerCues:0,
        protectedInputCues:0,otherViewerControlCues:0,postStopCues:0,
        fixture:'real workbench bridge, Neko viewer asset, shell lease sender and trusted Chromium pointer input; isolated inert HTML'}));
} finally {await browser.close();}
