// Isolated browser test only. Permitting a generic chooser in this harness lets automation select the
// deliberately wrong tab by title. The browser's real track and the production identity guard are unchanged.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const {chromium}=createRequire(path.join(process.env.PLAYWRIGHT_REQUIRE_DIR||'/opt/ezil-testkit','probe.cjs'))('playwright');
const source=fs.readFileSync(new URL('./current-tab.js',import.meta.url),'utf8');
const origin='https://os-staging.ezil.work', otherTitle='Deliberate second QA tab';
const browser=await chromium.launch({headless:process.env.EZIL_CHROME_HEADED!=='1',
    executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE||'/usr/bin/google-chrome',
    args:['--auto-select-tab-capture-source-by-title='+otherTitle,'--host-resolver-rules=MAP * ~NOTFOUND']});
try {
    const context=await browser.newContext();
    await context.route('**/*',route=>{
        const url=new URL(route.request().url());
        if(url.origin!==origin)return route.abort();
        if(url.pathname==='/guard.js')return route.fulfill({contentType:'text/javascript',body:source});
        return route.fulfill({contentType:'text/html',body:'<title>'+(url.pathname==='/other'?otherTitle:'Current assessment tab')+'</title><button>Choose tab</button>'});
    });
    const other=await context.newPage();
    await other.goto(origin+'/other');
    await other.evaluate(()=>navigator.mediaDevices.setCaptureHandleConfig({exposeOrigin:true,handle:'other-document',permittedOrigins:[location.origin]}));
    const current=await context.newPage(); await current.goto(origin+'/app/code'); await current.bringToFront();
    await current.evaluate(async()=>{
        const standard=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getDisplayMedia=async options=>{
            // Only picker presentation changes. The returned stream is a real browser-owned track for the second tab.
            const stream=await standard({...options,preferCurrentTab:false});
            window.selected=stream.getVideoTracks()[0];
            return stream;
        };
        const {currentTabPicker}=await import('/guard.js');
        const boundary=currentTabPicker(window);
        document.querySelector('button').onclick=async()=>{
            try {await boundary.choose();window.result='accepted';}
            catch(e){window.result=e.message;}
            finally {boundary.dispose();}
        };
    });
    await current.getByRole('button').click();
    await current.waitForFunction(()=>Boolean(window.result),{},{timeout:15000});
    const actual=await current.evaluate(()=>({result:window.result,type:window.selected?.getSettings().displaySurface,state:window.selected?.readyState}));
    assert.equal(actual.result,'wrong_tab');
    assert.equal(actual.state,'ended');
    console.log(JSON.stringify({result:'pass',otherTabRejected:true,wrongTrackEnded:true,openedRecording:false,
        testOnly:'generic browser chooser preference to select deliberate sibling tab; genuine browser track and unmodified production guard'}));
} finally {await browser.close();}
