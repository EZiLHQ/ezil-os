import assert from 'node:assert/strict';
import { progressView, observeComputerProgress, openingAt, openingFraction, formatElapsed, watchComputerTransition, OPENING_MILESTONES } from './computer-progress.js';
import { AppSpinner } from './app-spinner.js';
const base={version:2,computerId:'qa-computer',stage:'provisioning',recordedStage:'exported',operation:'migration',active:true,durable:true,resumePolicy:'saved_workspace_only',updatedAt:'2026-10-26T10:00:00Z',bytes:{transferred:null,total:null},percent:null,etaSeconds:null,transferStartedAt:null,transferUpdatedAt:null,typicalSeconds:null,selectedNextOpenHardware:{size:'xlarge',vcpu:4,memoryGiB:16,effective:'next_open'}};
// Round 3 (plan §6.5): one status line, one bar, no step list, countdown or percentage text.
const BANNED=/\d+%|min left|Almost there|Estimated|countdown|faster|instant|unlimited|priority|gpu|heavy use|gpt|claude|gemini|llama|memory is kept|memory survives|processes keep running|ai included|includes ai|compute hours|standard-hour|Mumbai/i;
let view=progressView(base,'qa-computer');
assert.equal(view.title,'Getting your AWS computer');
assert.equal(view.body,'','one status line while moving');
assert.equal('steps' in view||'countdown' in view||'meter' in view,false,'no step list, countdown or meter');
assert.equal(view.next,'');assert.equal(view.updated,null);
for(const devDetails of [undefined,false,'true',1,true]) {
 const value=progressView(base,'qa-computer',{features:{devDetails}});
 assert.equal(!!value.next,devDetails===true);assert.equal(!!value.updated,devDetails===true);
 if(devDetails===true)assert.match(value.next,/4 vCPU · 16 GiB/);
}
assert.equal(view.bytes,'');
assert.doesNotMatch(JSON.stringify({...view,updated:null}),BANNED);
// Migration: the same bar with its own status lines; bytes when measured.
const moving={...base,bytes:{transferred:312_000_000,total:1_200_000_000},percent:26,etaSeconds:121,typicalSeconds:390};
const labels=['Saving your files','Getting your AWS computer','Moving your files','Starting your desktop'];
for(const [stage,transferred,current] of [
 ['requested',null,0],['fenced',null,0],['exported',0,1],['exported',312_000_000,1],
 ['provisioning',null,1],['provisioning',0,1],['provisioning',1,2],['restored',312_000_000,2],
 ['committed',312_000_000,3],['mounting',312_000_000,3],['starting',312_000_000,3],['running',312_000_000,3],
]) {
 const value=progressView({...moving,stage,bytes:{...moving.bytes,transferred}},'qa-computer');
 assert.equal(value.title,labels[current],stage);assert.equal(value.reached,current,stage);
 assert.equal(value.bytes!=='',current===2&&transferred!==null,stage);
 assert.equal(value.path,'migrate');assert.notEqual(value.bar,null);
}
for(const [transferred,total,text] of [
 [312_000_000,1_200_000_000,'312 MB of 1.2 GB'],[12_400_000,999_000_000,'12 MB of 999 MB'],
 [1_000_000_000,1_250_000_000,'1.0 GB of 1.3 GB'],[0,0,'0 MB of 0 MB'],
]) assert.equal(progressView({...moving,stage:'restored',bytes:{transferred,total}},'qa-computer').bytes,text);
for(const bytes of [{transferred:312_000_000,total:null},{transferred:null,total:1_200_000_000}]) {
 assert.equal(progressView({...moving,stage:'restored',bytes},'qa-computer').bytes,'','unmeasured bytes are not invented');
}
// A measured transfer moves the bar inside its segment, and never to 100.
{const at=p=>openingAt(progressView({...moving,stage:'restored',percent:p},'qa-computer',{now:0,firstObservedAt:0}),0).percent;
 assert.ok(at(0)<at(50)&&at(50)<at(99)&&at(99)<100,`${at(0)} ${at(50)} ${at(99)}`);}
for(const [stage,title] of [['operations_paused','Computer startup is temporarily paused'],['needs_operator','Your computer needs attention'],['queued','Waiting to start'],['failed_reopened','Migration did not finish'],['failed_needs_operator','Your computer needs attention']]) {
 const value=progressView({...moving,stage,active:true},'qa-computer');
 assert.equal(value.title,title);
 assert.equal(value.active,false);
 assert.equal(value.activeAws,false);
 assert.equal(value.bar,null,'a held computer shows no bar');
 assert.equal(value.bytes,'');
 assert.notEqual(value.body,'','a held computer keeps its one explanatory sentence');
 assert.doesNotMatch(value.body,/keep moving/);
}
for(const override of [{operationsPaused:true,needsOperator:true},{paused:true,needsOperator:true},{stage:'operations_paused',needsOperator:true}]) {
 const value=progressView({...moving,...override},'qa-computer');
 assert.equal(value.stage,'operations_paused');assert.equal(value.active,false);
 assert.equal(value.bar,null);assert.equal(value.bytes,'');
}
assert.equal(progressView({...base,needsOperator:true},'qa-computer').stage,'needs_operator');
assert.equal(progressView(base,'someone-else'),null);
assert.equal(progressView({...base,version:1},'qa-computer').title,'Getting your AWS computer');
assert.equal(progressView({...base,version:3},'qa-computer'),null);
assert.equal(progressView({...base,stage:'<script>'},'qa-computer'),null);

// ── Opening: the real order is LEASED → STARTING → MOUNTING → RUNNING ────────
const opening={...base,operation:'opening',stage:'mounting',durable:false};
for(const [stage,reached,title] of [['provisioning',0,'Starting your computer'],['leased',1,'Starting your computer'],['claimed',1,'Starting your computer'],
 ['starting',1,'Starting your computer'],['mounting',2,'Attaching your files'],['running',4,'Starting Code'],['ready',4,'Starting Code']]) {
 const value=progressView({...opening,stage},'qa-computer',{appName:'Code'});
 assert.equal(value.reached,reached,stage);assert.equal(value.title,title,stage);
 assert.equal(value.body,'',stage);assert.equal(value.bytes,'',stage);
 assert.doesNotMatch(value.title,BANNED);
}
assert.ok(progressView({...opening,stage:'starting'},'qa-computer').reached<progressView({...opening,stage:'mounting'},'qa-computer').reached,'STARTING comes before MOUNTING');
assert.equal(progressView({...opening,stage:'running'},'qa-computer').title,'Starting your desktop','no app name: the desktop');
// Server milestones lift the stage; a stage never lowers a milestone (steps never regress).
const T='2026-10-28T10:00:00.000Z',at=s=>new Date(Date.parse(T)+s*1000).toISOString();
const ms=n=>OPENING_MILESTONES.slice(0,n).map((key,i)=>({key,at:at(i*10)}));
assert.equal(progressView({...opening,stage:'leased',milestones:ms(4)},'qa-computer',{appName:'Code'}).title,'Starting Code','desktop_starting from the server');
assert.equal(progressView({...opening,stage:'provisioning',milestones:ms(3)},'qa-computer').title,'Attaching your files');
assert.equal(progressView({...opening,stage:'leased',milestones:[{key:'url_received',at:T},{key:'bogus',at:T},{key:'host_claimed',at:'nope'}]},'qa-computer').reached,1,'client keys, unknown keys and bad times are ignored');
// New server stages (L2): all openings, never "stopped".
const tr=(kind,phase,target='cmp-4')=>({transitionId:'t-1',kind,current:'std-2',target,phase,reason:null,requestedAt:T,endedAt:null,revertAvailable:false});
for(const [stage,transition,title] of [
 ['waiting_capacity',null,'Waiting for a machine — this can take a few minutes'],
 ['switching',tr('switch','stopping'),'Saving and closing your session'],
 ['switching',tr('switch','waking','cmp-8'),'Getting an 8 vCPU machine'],
 ['restarting',tr('restart','stopping'),'Restarting your computer'],
 ['restarting',tr('restart','waking'),'Starting your computer'],
]) {
 const value=progressView({...opening,stage,transition,active:true},'qa-computer');
 assert.equal(value.title,title,stage);assert.equal(value.active,true);assert.equal(value.activeAws,true,stage);
 assert.notEqual(value.bar,null);assert.doesNotMatch(value.title,/stopped/i);
}
// A switch path names the target machine, then the shared files/desktop lines.
for(const [stage,title] of [['leased','Getting a 4 vCPU machine'],['mounting','Attaching your files'],['running','Starting your desktop']]) {
 assert.equal(progressView({...opening,stage,path:'switch',transition:tr('switch','waking')},'qa-computer',{appName:'Code'}).title,title,stage);
}
assert.equal(progressView({...opening,stage:'running',active:false},'qa-computer').activeAws,false,'ready is not opening');

// ── The bar: pure, monotonic, shared by every tab ──────────────────────────
assert.equal(openingFraction({ready:true}),1);
for(let e=0,prev=-1;e<=900;e+=7){const f=openingFraction({elapsed:e,expected:120});assert.ok(f>=prev&&f<=0.9,`${e}: ${f}`);prev=f;}
assert.equal(openingFraction({elapsed:120,expected:120}),0.9,'90% of the way at the expected time');
assert.equal(openingFraction({elapsed:5000,expected:120,floor:0.88,ceiling:1}),0.9,'never 100 before ready');
assert.equal(openingFraction({elapsed:30,expected:120,floor:0,ceiling:0.25}),0.25,'time never passes the next milestone');
assert.equal(openingFraction({elapsed:1,expected:120,floor:0.6}),0.6,'a reached milestone lifts the bar');
// Reduced motion: whole 10% steps above the floor.
for(let e=0;e<=200;e+=3){const f=openingFraction({elapsed:e,expected:120,reducedMotion:true});assert.equal(Math.round(f*100)%10,0,`${e}: ${f}`);}
assert.equal(formatElapsed(42),'0:42');assert.equal(formatElapsed(725),'12:05');assert.equal(formatElapsed(-3),'0:00');
// Monotonic across polls: milestones only grow and time only advances.
{const stagesInOrder=['provisioning','leased','starting','mounting','running'];let prev=-1;
 for(let poll=0;poll<40;poll++){
  const stage=stagesInOrder[Math.min(4,Math.floor(poll/8))];
  const data={...opening,stage,openingStartedAt:T,expectedSeconds:240,milestones:ms(Math.min(5,1+Math.floor(poll/8)))};
  const now=Date.parse(T)+poll*5000;
  const v=progressView(data,'qa-computer',{now,firstObservedAt:now});
  const p=openingAt(v,now).percent;assert.ok(p>=prev,`poll ${poll}: ${p} < ${prev}`);assert.ok(p<100);prev=p;
 }}
// Two tabs (and a reload) with the same server start agree, whatever their first observation.
{const data={...opening,stage:'starting',openingStartedAt:T,expectedSeconds:240,milestones:ms(2)};
 const now=Date.parse(T)+95_000;
 const tabA=progressView(data,'qa-computer',{now,firstObservedAt:Date.parse(T)+1000});
 const tabB=progressView(data,'qa-computer',{now,firstObservedAt:Date.parse(T)+90_000});
 assert.deepEqual(openingAt(tabA,now),openingAt(tabB,now));assert.equal(openingAt(tabA,now).elapsedText,'1:35');}
// Without a server start, each tab falls back to its first observation (older servers).
{const v=progressView({...opening,stage:'starting'},'qa-computer',{now:120000,firstObservedAt:0});assert.equal(Math.round(openingAt(v,120000).elapsed),120);}
// Long: past the server's expected time; client milestones complete it.
{const data={...opening,stage:'mounting',openingStartedAt:T,expectedSeconds:90};
 const v=progressView(data,'qa-computer');
 assert.equal(openingAt(v,Date.parse(T)+89_000).long,false);assert.equal(openingAt(v,Date.parse(T)+91_000).long,true);
 assert.ok(openingAt(v,Date.parse(T)+91_000,{client:5}).percent>=88,'url_received lifts the bar');
 assert.equal(openingAt(v,Date.parse(T)+91_000,{client:6}).percent,100,'first_frame is the only 100%');
 assert.equal(openingAt(v,Date.parse(T)+91_000,{client:6}).long,false);}
// The budget clock (600 s rule) is unchanged: it never counts from the server's opening start.
{const v=progressView({...opening,stage:'starting',openingStartedAt:T},'qa-computer',{now:Date.parse(T)+700_000,firstObservedAt:Date.parse(T)+300_000});
 assert.equal(Math.round(v.elapsed),400);assert.equal(Math.round(openingAt(v,Date.parse(T)+700_000).elapsed),700);}
view=progressView({...moving,stage:'recovering'},'qa-computer');
assert.equal(view.title,'Recovering computer');assert.equal(view.bar,null);assert.equal(view.bytes,'');
if(process.argv.includes('--view-only')) {
 console.log('PASS progress view: stage order, milestones, one status line, monotonic shared bar and failure precedence');
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
 timed.start();await tick();assert.equal(openingAt(received.at(-1),now).percent,45,'MOUNTING reached: the files floor, not a timer');
 now=120000;
 let pending=[...timers].find(([,timer])=>timer.ms===5000);timers.delete(pending[0]);pending[1].fn();await tick();
 assert.equal(Math.round(received.at(-1).elapsed),120,'polling retains the first observation time');assert.equal(openingAt(received.at(-1),now).elapsedText,'2:00');
 hidden=true;document.dispatchEvent(new dom.window.Event('visibilitychange'));now=240000;
 hidden=false;document.dispatchEvent(new dom.window.Event('visibilitychange'));await tick();
 assert.equal(Math.round(received.at(-1).elapsed),240,'background time counts toward the operation');assert.equal(openingAt(received.at(-1),now).long,false);assert.equal(openingAt(received.at(-1),now+1000).long,true,'past the expected time');
 timed.stop();now=0;
 // A switch/restart watch settles once, only for the transition asked for (or one it saw in flight).
 for(const id of ['t-1',null]){
  const seq=[{transitionId:'old',kind:'switch',phase:'done'},{transitionId:'t-1',kind:'switch',phase:'stopping'},{transitionId:'t-1',kind:'switch',phase:'waking'},{transitionId:'t-1',kind:'switch',phase:'done'}];
  let i=0;const settled=[];
  const watch=watchComputerTransition({computerId:'qa-computer',element,transitionId:id,onSettled:t=>settled.push(t),
   query:async()=>({ok:true,data:{...opening,stage:'switching',transition:seq[Math.min(i++,seq.length-1)]}})});
  await tick();
  for(let n=0;n<6;n++){const next=[...timers].find(([,timer])=>timer.ms===5000);if(!next)break;timers.delete(next[0]);next[1].fn();await tick();}
  assert.equal(settled.length,1,`settled once (${id})`);assert.equal(settled[0].transitionId,'t-1');assert.equal(settled[0].phase,'done');
  assert.equal(watch.active(),false);assert.equal([...timers].some(([,timer])=>timer.ms===5000),false,'the watch stops polling');
 }
 globalThis.fetch=async()=>({ok:true,status:200,json:async()=>({result:{data:{json:{...base,operationsPaused:true}}}})});
 const spinner=AppSpinner({computerId:'qa-computer',isMigrating:()=>true});document.body.appendChild(spinner.el);spinner.render({kind:'progress'});await tick();
 assert.equal(spinner.el.querySelector('.ezil-app-spinner-label').textContent,'Computer startup is temporarily paused');
 assert.equal(spinner.el.querySelector('.ezil-opening-bar').hidden,true,'a paused computer shows no bar');
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
    assert.equal(ordinary.el.querySelector('.ezil-opening-bar').dataset.indeterminate,'true');
    assert.equal(ordinary.hasComputerProgress(),false);
    assert.equal(ordinary.el.dataset.progress,'unavailable');assert.equal(ordinary.el.querySelector('.ezil-app-spinner-sub').hidden,true);
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
    assert.equal(failed.el.querySelector('.ezil-boot-retry').hidden,stage!=='failed_reopened');
    // Same observation, changed physical state: fingerprint must include that state.
    failed.render({kind:'failed',reason:'mint_failed'});
    if(stage==='failed_reopened')assert.equal(failed.el.querySelector('.ezil-app-spinner-label').textContent,'Migration did not finish');
    assert.equal(failed.el.querySelector('.ezil-boot-retry').hidden,!retryVisible);
    if(retryVisible)failed.el.querySelector('.ezil-boot-retry').click();
    assert.equal(retried,retryVisible?1:0,'original onRetry invoked exactly once only for the offered retry');
    failed.dispose();assert.equal(timers.size,0);
 }
 assert.equal(progressView({...base,stage:'unavailable'},'qa-computer'),null);

}finally{globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;Date.now=originalNow;delete globalThis.fetch;dom.window.close();}
console.log('PASS authoritative progress precedence, no invented metrics, scope, read-only polling, hidden/disposed lifecycle and paused spinner');
