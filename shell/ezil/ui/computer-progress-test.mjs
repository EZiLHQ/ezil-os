import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { progressView, observeComputerProgress } from './computer-progress.js';
import { AppSpinner } from './app-spinner.js';
const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual:true});
globalThis.document = dom.window.document;
const base={version:2,computerId:'qa-computer',stage:'provisioning',recordedStage:'exported',operation:'migration',active:true,durable:true,resumePolicy:'saved_workspace_only',updatedAt:'2026-10-26T10:00:00Z',bytes:{transferred:null,total:null},percent:null,etaSeconds:null,transferStartedAt:null,transferUpdatedAt:null,typicalSeconds:null,selectedNextOpenHardware:{size:'xlarge',vcpu:4,memoryGiB:16,effective:'next_open'}};
let view=progressView(base,'qa-computer');
assert.equal(view.title,'Getting your AWS computer');
assert.equal(view.steps.filter(s=>s.state==='current').length,1);
assert.equal(view.guidance,'Moving your files to AWS. This can take a few minutes. You can close this window — your files keep moving, and your computer will be ready when you come back.');
assert.match(view.next,/4 vCPU · 16 GiB/);
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
 assert.equal(value.steps.length,0,'underlying recordedStage never drives the paused display');
 assert.equal(value.transfer,null);
 if(stage!=='queued')assert.equal(value.guidance,'');
 else assert.match(value.guidance,/You can close this window/);
}
for(const override of [{operationsPaused:true,needsOperator:true},{paused:true,needsOperator:true},{stage:'operations_paused',needsOperator:true}]) {
 const value=progressView({...moving,...override},'qa-computer');
 assert.equal(value.stage,'operations_paused');assert.equal(value.active,false);
 assert.equal(value.steps.length,0);assert.equal(value.transfer,null);assert.equal(value.guidance,'');
}
assert.equal(progressView({...base,needsOperator:true},'qa-computer').stage,'needs_operator');
assert.equal(progressView(base,'someone-else'),null);
assert.equal(progressView({...base,version:1},'qa-computer').title,'Getting your AWS computer');
assert.equal(progressView({...base,version:3},'qa-computer'),null);
assert.equal(progressView({...base,stage:'<script>'},'qa-computer'),null);
view=progressView({...moving,operation:'opening',stage:'mounting',durable:false},'qa-computer');
assert.match(view.body,/reattaching/i);assert.equal(view.guidance,'');assert.equal(view.steps.length,0);assert.equal(view.transfer,null);
view=progressView({...moving,stage:'recovering'},'qa-computer');
assert.equal(view.title,'Recovering computer');assert.equal(view.steps.length,0);assert.equal(view.transfer,null);
assert.equal(progressView({...base,operation:'none',durable:true,stage:'failed_reopened'},'qa-computer').guidance,'');

const originalSet=globalThis.setTimeout,originalClear=globalThis.clearTimeout;
const timers=new Map();let id=0;globalThis.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms});return id;};globalThis.clearTimeout=id=>timers.delete(id);
const tick=async()=>{for(let i=0;i<15;i++)await Promise.resolve();};
try{
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
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({result:{data:{json:{...base,operationsPaused:true}}}})});
 const spinner=AppSpinner({computerId:'qa-computer',isMigrating:()=>true});document.body.appendChild(spinner.el);spinner.render({kind:'progress'});await tick();
 assert.equal(spinner.el.querySelector('.ezil-app-spinner-label').textContent,'Computer startup is temporarily paused');
 assert.equal(spinner.el.querySelector('.ezil-app-spinner-ring').hidden,true);
 assert.equal(spinner.el.querySelector('ol'),null);
 assert.match(spinner.el.textContent,/Applies after you stop this session and start again/);
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
 ]) {
    globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({result:{data:{json:{...base,stage,recordedStage,active:false}}}})});
    let retried=0;
    const failed=AppSpinner({computerId:'qa-computer',onRetry:()=>{retried++;}});
    document.body.appendChild(failed.el);failed.render({kind:'progress'});await tick();
    assert.equal(failed.el.querySelector('.ezil-boot-actions').hidden,true);
    // Same observation, changed physical state: fingerprint must include that state.
    failed.render({kind:'failed',reason:'mint_failed'});
    assert.equal(failed.el.querySelector('.ezil-boot-actions').hidden,!retryVisible);
    if(retryVisible)failed.el.querySelector('.ezil-boot-retry').click();
    assert.equal(retried,retryVisible?1:0,'original onRetry invoked exactly once only for the offered retry');
    failed.dispose();assert.equal(timers.size,0);
 }
 assert.equal(progressView({...base,stage:'unavailable'},'qa-computer'),null);

}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;delete globalThis.fetch;dom.window.close();}
console.log('PASS authoritative progress precedence, no invented metrics, scope, read-only polling, hidden/disposed lifecycle and paused spinner');
