import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { progressView, observeComputerProgress } from './computer-progress.js';
import { AppSpinner } from './app-spinner.js';
const dom = new JSDOM('<!doctype html><body></body>', {pretendToBeVisual:true});
globalThis.document = dom.window.document;
const base={version:1,computerId:'qa-computer',stage:'provisioning',recordedStage:'exported',operation:'migration',active:true,durable:true,resumePolicy:'saved_workspace_only',updatedAt:'2026-10-26T10:00:00Z',bytes:{transferred:null,total:null},percent:null,etaSeconds:null,selectedNextOpenHardware:{size:'xlarge',vcpu:4,memoryGiB:16,effective:'next_open'}};
let view=progressView(base,'qa-computer');
assert.equal(view.title,'Preparing computer');
assert.equal(view.steps.filter(s=>s.state==='current').length,1);
assert.match(view.guidance,/Unsaved changes inside apps are not guaranteed/);
assert.match(view.next,/4 vCPU · 16 GiB/);
assert.doesNotMatch(JSON.stringify(view),/\d+%|2–3|2-3|minutes/);
for(const stage of ['operations_paused','needs_operator','queued']) {
 const value=progressView({...base,stage,active:true},'qa-computer');
 assert.equal(value.active,false);
 if(stage!=='queued')assert.equal(value.steps.length,0,'underlying recordedStage never drives the paused display');
}
assert.equal(progressView({...base,operationsPaused:true,needsOperator:true},'qa-computer').stage,'operations_paused');
assert.equal(progressView({...base,needsOperator:true},'qa-computer').stage,'needs_operator');
assert.equal(progressView(base,'someone-else'),null);
assert.equal(progressView({...base,version:2},'qa-computer'),null);
assert.equal(progressView({...base,stage:'<script>'},'qa-computer'),null);
view=progressView({...base,operation:'opening',stage:'mounting',durable:false},'qa-computer');
assert.match(view.body,/reattaching/i);assert.equal(view.guidance,'');assert.equal(view.steps.length,0);
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
 assert.equal(progressView({...base,stage:'unavailable'},'qa-computer'),null);

}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;delete globalThis.fetch;dom.window.close();}
console.log('PASS authoritative progress precedence, no invented metrics, scope, read-only polling, hidden/disposed lifecycle and paused spinner');
