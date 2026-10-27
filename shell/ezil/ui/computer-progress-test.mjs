import assert from 'node:assert/strict';
import { progressView, observeComputerProgress } from './computer-progress.js';
import { AppSpinner } from './app-spinner.js';
const base={version:2,computerId:'qa-computer',stage:'provisioning',recordedStage:'exported',operation:'migration',active:true,durable:true,resumePolicy:'saved_workspace_only',updatedAt:'2026-10-26T10:00:00Z',bytes:{transferred:null,total:null},percent:null,etaSeconds:null,transferStartedAt:null,transferUpdatedAt:null,typicalSeconds:null,selectedNextOpenHardware:{size:'xlarge',vcpu:4,memoryGiB:16,effective:'next_open'}};
let view=progressView(base,'qa-computer');
assert.equal(view.title,'Getting your AWS computer');
assert.equal(view.steps.filter(s=>s.state==='current').length,1);
assert.equal(view.guidance,'Moving your files to AWS. This can take a few minutes. You can close this window — your files keep moving, and your computer will be ready when you come back.');
assert.equal(view.next,'');assert.equal(view.updated,null);
for(const devDetails of [undefined,false,'true',1,true]) {
 const value=progressView(base,'qa-computer',{features:{devDetails}});
 assert.equal(!!value.next,devDetails===true);assert.equal(!!value.updated,devDetails===true);
 if(devDetails===true)assert.match(value.next,/4 vCPU · 16 GiB/);
}
assert.equal(view.transfer,null);
assert.doesNotMatch(JSON.stringify(view),/\d+%|2–3|2-3|\d+ minutes/);
const moving={...base,bytes:{transferred:312_000_000,total:1_200_000_000},percent:26,etaSeconds:121,typicalSeconds:390};
const labels=['Saving your files','Getting your AWS computer','Moving your files','Starting your desktop'];
for(const [stage,transferred,current] of [
 ['requested',null,0],['fenced',null,0],['exported',0,1],['exported',312_000_000,1],
 ['provisioning',null,1],['provisioning',0,1],['provisioning',1,2],['restored',312_000_000,2],
 ['committed',312_000_000,3],['mounting',312_000_000,3],['starting',312_000_000,3],['running',312_000_000,3],
]) {
 const value=progressView({...moving,stage,bytes:{...moving.bytes,transferred}},'qa-computer');
 assert.equal(value.title,labels[current],stage);
 assert.deepEqual(value.steps,labels.map((label,i)=>({label,state:i<current?'complete':i===current?'current':'pending'})),stage);
 assert.equal(value.transfer!==null,current===2,stage);
 assert.match(value.guidance,/This usually takes about 7 minutes/);
}
for(const [transferred,total,text] of [
 [312_000_000,1_200_000_000,'312 MB of 1.2 GB'],[12_400_000,999_000_000,'12 MB of 999 MB'],
 [1_000_000_000,1_250_000_000,'1.0 GB of 1.3 GB'],[0,0,'0 MB of 0 MB'],
]) {
 assert.equal(progressView({...moving,stage:'restored',bytes:{transferred,total}},'qa-computer').transfer.bytes,text);
}
assert.equal(progressView(moving,'qa-computer').transfer.percent,26);
for(const [etaSeconds,text] of [[0,'Less than a minute left'],[59,'Less than a minute left'],[60,'About 1 min left'],[61,'About 2 min left'],[121,'About 3 min left'],[null,'']]) {
 assert.equal(progressView({...moving,etaSeconds},'qa-computer').transfer.eta,text);
}
for(const bytes of [{transferred:312_000_000,total:null},{transferred:null,total:1_200_000_000},{transferred:null,total:null}]) {
 assert.deepEqual(progressView({...moving,stage:'restored',bytes},'qa-computer').transfer,{bytes:'Not measured',percent:null,eta:''});
}
assert.equal(progressView({...moving,percent:null},'qa-computer').transfer.percent,null);
for(const [typicalSeconds,text] of [[90,'This usually takes about 2 minutes'],[120,'This usually takes about 2 minutes'],[121,'This usually takes about 3 minutes'],[null,'This can take a few minutes']]) {
 assert.equal(progressView({...base,stage:'requested',typicalSeconds},'qa-computer').guidance,`Moving your files to AWS. ${text}. You can close this window — your files keep moving, and your computer will be ready when you come back.`);
}
for(const [stage,title] of [['operations_paused','Computer startup is temporarily paused'],['needs_operator','Computer needs attention'],['queued','Waiting to start'],['failed_reopened','Migration did not finish'],['failed_needs_operator','Computer needs attention']]) {
 const value=progressView({...moving,stage,active:true},'qa-computer');
 assert.equal(value.title,title);
 assert.equal(value.active,false);
 assert.equal(value.activeAws,false);
 assert.equal(value.steps.length,0,'underlying recordedStage never drives the paused display');
 assert.equal(value.transfer,null);
 // A paused, operator-held or waiting move never claims the files keep moving.
 assert.equal(value.guidance,stage!=='failed_reopened'&&moving.durable===true&&moving.resumePolicy==='saved_workspace_only'?'You can reopen this view to check the saved migration. Unsaved changes inside apps are not guaranteed. Progress resumes only when operations allow it.':'');
 assert.doesNotMatch(value.guidance,/keep moving/);
}
for(const override of [{operationsPaused:true,needsOperator:true},{paused:true,needsOperator:true},{stage:'operations_paused',needsOperator:true}]) {
 const value=progressView({...moving,...override},'qa-computer');
 assert.equal(value.stage,'operations_paused');assert.equal(value.active,false);
 assert.equal(value.steps.length,0);assert.equal(value.transfer,null);assert.doesNotMatch(value.guidance,/keep moving/);
}
assert.equal(progressView({...base,needsOperator:true},'qa-computer').stage,'needs_operator');
assert.equal(progressView(base,'someone-else'),null);
assert.equal(progressView({...base,version:1},'qa-computer').title,'Getting your AWS computer');
assert.equal(progressView({...base,version:3},'qa-computer'),null);
assert.equal(progressView({...base,stage:'<script>'},'qa-computer'),null);
const opening={...base,operation:'opening',stage:'mounting',durable:false};
const openingLabels=['Getting your AWS computer','Attaching your files','Starting your desktop'];
for(const [stage,current] of [['provisioning',0],['leased',0],['claimed',0],['mounting',1],['starting',2],['running',3],['ready',3]]) {
 const value=progressView({...opening,stage},'qa-computer');
 assert.deepEqual(value.steps,openingLabels.map((label,i)=>({label,state:i<current?'complete':i===current?'current':'pending'})),stage);
 assert.equal(value.transfer,null);assert.equal(value.guidance,'');
 assert.equal(value.meter.percent,current===3?100:0);
 if(current===3)assert.equal(value.countdown,'');
 assert.equal(value.reassurance,"Your files stay on your own disk; we're just starting the computer around them.");
}
assert.equal(view.reassurance,'Your files are safe: every piece is checked as it moves, and your old computer stays untouched until the move is complete.');
for(const [elapsed,countdown,percent] of [[0,'About 4 min left',0],[120,'About 2 min left',50],[180,'About 1 min left',75],[181,'Less than a minute left',75],[239,'Less than a minute left',95],[240,'Almost there — finishing up',95],[600,'Almost there — finishing up',95]]) {
 const value=progressView(opening,'qa-computer',{now:elapsed*1000,firstObservedAt:0});
 assert.equal(value.countdown,countdown);assert.deepEqual(value.meter,{percent,estimated:true});
}
view=progressView({...opening,typicalSeconds:300,startedAt:'2026-10-27T00:00:00Z'},'qa-computer',{now:Date.parse('2026-10-27T00:02:00Z')});
assert.equal(view.countdown,'About 3 min left');assert.equal(view.meter.percent,40);
view=progressView({...opening,startedAt:'invalid',typicalSeconds:0},'qa-computer',{now:120000,firstObservedAt:0});
assert.equal(view.countdown,'About 2 min left');assert.equal(view.meter.percent,50);
view=progressView({...opening,startedAt:'2026-10-27T00:01:00Z'},'qa-computer',{now:Date.parse('2026-10-27T00:00:00Z')});
assert.equal(view.meter.percent,0);assert.equal(view.countdown,'About 4 min left');
view=progressView(moving,'qa-computer',{now:600000,firstObservedAt:0});
assert.equal(view.countdown,'About 3 min left');assert.deepEqual(view.meter,{percent:26,estimated:false});
assert.equal(progressView({...moving,etaSeconds:null},'qa-computer',{now:600000,firstObservedAt:0}).countdown,'Almost there — finishing up');
assert.equal(progressView({...moving,percent:100},'qa-computer').meter.percent,99);
assert.equal(progressView({...base,operation:'none',stage:'running',active:false},'qa-computer').steps.every(s=>s.state==='complete'),true);
view=progressView({...moving,stage:'recovering'},'qa-computer');
assert.equal(view.title,'Recovering computer');assert.equal(view.steps.length,0);assert.equal(view.transfer,null);
assert.equal(progressView({...base,operation:'none',durable:true,stage:'failed_reopened'},'qa-computer').guidance,'');

if(process.argv.includes('--view-only')) {
 console.log('PASS progress view: stages, diagnostics, countdown, estimates, reassurance and failure precedence');
 process.exit(0);
}
const { JSDOM } = await import('jsdom');
const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual:true});
globalThis.document = dom.window.document;
const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout,originalNow=Date.now;
const timers=new Map();let id=0;globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
try{
 let now=0;Date.now=()=>now;
 const element=document.createElement('div');
 let resolve;const calls=[],received=[];
 const observer=observeComputerProgress({computerId:'qa-computer',element,onChange:x=>received.push(x),query:(...args)=>{calls.push(args);return new Promise(r=>resolve=r);}});
 observer.start();assert.equal(calls.length,0,'disconnected start does not latch watching or query');
 document.body.appendChild(element);observer.start();observer.start();assert.equal(calls.length,1,'connected retry starts once without duplicate polling');
 assert.deepEqual(calls[0],['computer.progress',{computerId:'qa-computer'}]);
 observer.stop();resolve({ok:true,data:base});await tick();assert.equal(received.length,0,'closed observer ignores pending response');
 observer.start();resolve({ok:true,data:{...base,operationsPaused:true}});await tick();assert.equal(received.at(-1).active,false);
 let hidden=true;Object.defineProperty(document,'hidden',{get:()=>hidden,configurable:true});document.dispatchEvent(new dom.window.Event('visibilitychange'));assert.equal(received.at(-1),null);
 const count=calls.length;await tick();assert.equal(calls.length,count);hidden=false;document.dispatchEvent(new dom.window.Event('visibilitychange'));assert.equal(calls.length,count+1);
 resolve({ok:true,data:{...base,computerId:'foreign'}});await tick();assert.equal(received.at(-1),null);observer.stop();
 const timed=observeComputerProgress({computerId:'qa-computer',element,onChange:x=>received.push(x),query:async()=>({ok:true,data:opening})});
 timed.start();await tick();assert.equal(received.at(-1).meter.percent,0);
 now=120000;
 let pending=[...timers].find(([,timer])=>timer.ms===5000);timers.delete(pending[0]);pending[1].fn();await tick();
 assert.equal(received.at(-1).countdown,'About 2 min left');assert.equal(received.at(-1).meter.percent,50,'polling retains the first observation time');
 hidden=true;document.dispatchEvent(new dom.window.Event('visibilitychange'));now=240000;
 hidden=false;document.dispatchEvent(new dom.window.Event('visibilitychange'));await tick();
 assert.equal(received.at(-1).countdown,'Almost there — finishing up','background time counts toward the operation');
 timed.stop();now=0;
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({result:{data:{json:{...base,operationsPaused:true}}}})});
 const spinner=AppSpinner({computerId:'qa-computer',isMigrating:()=>true});document.body.appendChild(spinner.el);spinner.render({kind:'progress'});await tick();
 assert.equal(spinner.el.querySelector('.ezil-app-spinner-label').textContent,'Computer startup is temporarily paused');
 assert.equal(spinner.el.querySelector('.ezil-app-spinner-ring').hidden,true);
 assert.equal(spinner.el.querySelector('ol'),null);
 assert.doesNotMatch(spinner.el.textContent,/Next session|Last recorded update/);
 assert.doesNotMatch(spinner.el.textContent,/Moving your computer|files come with you/);
 spinner.dispose();assert.equal(timers.size,0);
 for(const result of [
    {ok:true,status:200,json:async()=>({result:{data:{json:{...base,stage:'unavailable',active:false,durable:false,operation:'none'}}}})},
    {ok:false,status:503,json:async()=>({})},
 ]) {
    globalThis.fetch=async()=>result;
    const ordinary=AppSpinner({computerId:'qa-computer',label:'Opening Code…',isMigrating:()=>true});
    document.body.appendChild(ordinary.el);ordinary.render({kind:'progress'});await tick();
    assert.equal(ordinary.el.querySelector('.ezil-app-spinner-label').textContent,'Opening Code…');
    assert.equal(ordinary.el.querySelector('.ezil-app-spinner-ring').hidden,false);
    assert.equal(ordinary.hasComputerProgress(),false);
    assert.match(ordinary.el.querySelector('.ezil-app-spinner-sub').textContent,/progress is unavailable/);
    assert.doesNotMatch(ordinary.el.textContent,/Moving your computer/);
    ordinary.render({kind:'ready'});assert.equal(timers.size,0);ordinary.dispose();
 }
 // A SELECT-only observation cannot restart a terminal physical mint. Retain its original Retry callback.
 for (const [stage, recordedStage, retryVisible] of [
    ['needs_operator', 'unconfirmed', true],
    ['needs_operator', 'failed_needs_operator', false],
    ['operations_paused', 'unconfirmed', false],
    ['failed_reopened', 'failed_reopened', true],
 ]) {
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({result:{data:{json:{...base,stage,recordedStage,active:false}}}})});
    let retried=0;
    const failed=AppSpinner({computerId:'qa-computer',onRetry:()=>{retried++;}});
    document.body.appendChild(failed.el);failed.render({kind:'progress'});await tick();
    assert.equal(failed.el.querySelector('.ezil-boot-actions').hidden,stage!=='failed_reopened');
    // Same observation, changed physical state: fingerprint must include that state.
    failed.render({kind:'failed',reason:'mint_failed'});
    if(stage==='failed_reopened')assert.equal(failed.el.querySelector('.ezil-app-spinner-label').textContent,'Migration did not finish');
    assert.equal(failed.el.querySelector('.ezil-boot-actions').hidden,!retryVisible);
    if(retryVisible)failed.el.querySelector('.ezil-boot-retry').click();
    assert.equal(retried,retryVisible?1:0,'original onRetry invoked exactly once only for the offered retry');
    failed.dispose();assert.equal(timers.size,0);
 }
 assert.equal(progressView({...base,stage:'unavailable'},'qa-computer'),null);

}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;Date.now=originalNow;delete globalThis.fetch;dom.window.close();}
console.log('PASS authoritative progress precedence, no invented metrics, scope, read-only polling, hidden/disposed lifecycle and paused spinner');
